import { create } from 'zustand'
import type { AnimationData, BoneTimelines, RotateKey, Vec2Key } from '@core/animation.ts'
import { putKeyframe, removeKeyframe, samplePose } from '@core/animation.ts'
import type { Attachment, BlendMode, BoneData, Color, RegionAttachment, SkeletonData, Skin, SlotData } from '@core/types.ts'
import { SAMPLE_SKELETON, SAMPLE_WALK } from '@core/sample.ts'
import { PROJECT_FORMAT_VERSION, type AtlasAsset, type ProjectData } from '@project/types.ts'
import type { ImageAsset } from '@project/types.ts'

/**
 * 编辑器状态与撤销重做。
 *
 * ── 撤销重做:不可变快照 + merge key 合并 ──
 *
 * 文档(EditorDoc)不可变。每次编辑产生一份新的,旧的压进 past。
 * 结构共享 —— 只替换被改的那部分,其余复用,一次快照的实际开销很小。
 *
 * **merge key 是不能事后加的部分:** 拖动一根骨骼会产生几百个 mousemove,
 * 每个都是一次 commit。没有合并的话撤销一次只退回一个像素。
 * 规则:连续两次 commit 的 mergeKey 相同且非 null 时替换当前状态而不压栈。
 *
 * ── 什么进历史,什么不进 ──
 *
 * 只有 doc(骨架 + 动画)进历史。播放头位置、是否在播放、选中了哪根骨骼、
 * 处于哪个模式、当前工具 —— 这些是**视图状态**,撤销不应该把播放头拽回去。
 */

export type EditorMode = 'setup' | 'animate'

/** 视口拖动工具。shear 只提供数值编辑,不做拖拽手势。 */
export type EditorTool = 'rotate' | 'translate' | 'scale'

/** 骨骼动画的四条时间轴通道 */
export type BoneChannel = 'rotate' | 'translate' | 'scale' | 'shear'

const MAX_HISTORY = 200

const SAMPLE_PROJECT: ProjectData = {
  formatVersion: PROJECT_FORMAT_VERSION,
  name: 'sample',
  images: [],
  atlases: [],
  skeleton: SAMPLE_SKELETON,
  animations: new Map([[SAMPLE_WALK.name, SAMPLE_WALK]]),
}

interface EditorState {
  doc: ProjectData
  past: ProjectData[]
  future: ProjectData[]
  lastMergeKey: string | null

  // 视图状态 —— 不进历史
  mode: EditorMode
  tool: EditorTool
  currentAnimation: string
  time: number
  playing: boolean
  selectedBone: string | null
  projectDir: string | null

  commit: (next: ProjectData, mergeKey?: string) => void
  undo: () => void
  redo: () => void

  setMode: (mode: EditorMode) => void
  setTool: (tool: EditorTool) => void
  selectBone: (name: string | null) => void
  /** 切换当前动画。播放头归零并停止播放。 */
  selectAnimation: (name: string) => void
  /** 新建空动画(自动命名 anim_N,时长 1s)并切换过去,返回动画名 */
  addAnimation: () => string
  setTime: (time: number) => void
  setPlaying: (playing: boolean) => void
  setProjectDir: (dir: string | null) => void
  replaceProject: (project: ProjectData) => void
  addImages: (images: readonly ImageAsset[]) => void
  bindImageToBone: (imageId: string, boneName: string) => void
  addBone: (parentName: string | null) => string

  /**
   * 拖拽/数值编辑的落点。传入的都是**绝对局部值**,由模式决定写到哪:
   *   setup   → 改绑定姿势
   *   animate → 在当前时刻打关键帧,值 = 绝对值 − 绑定值(scale 是 ÷)
   */
  setBoneRotation: (boneName: string, localRotation: number, mergeKey?: string) => void
  setBoneTranslation: (boneName: string, x: number, y: number, mergeKey?: string) => void
  setBoneScale: (boneName: string, scaleX: number, scaleY: number, mergeKey?: string) => void
  setBoneShear: (boneName: string, shearX: number, shearY: number, mergeKey?: string) => void
  /** length 只是编辑器显示用,不可动画 —— 任何模式下都写绑定数据 */
  setBoneLength: (boneName: string, length: number, mergeKey?: string) => void

  /**
   * 在当前时刻为选中骨骼打关键帧:把已有时间轴通道在当前时刻的**插值结果**固化成帧。
   * 一条时间轴都没有时打一个 rotate 零帧,让这根骨骼出现在时间轴上。
   */
  keyBoneAtTime: (boneName: string) => void
  deleteKeyframe: (boneName: string, channel: BoneChannel, time: number) => void

  // ── slot 编辑 ──
  renameSlot: (name: string, newName: string) => void
  /** 解除绑定:删掉 slot 及其皮肤里的 attachment 记录 */
  removeSlot: (name: string) => void
  /** 在绘制顺序里移动一格。delta 为 +1 表示画得更晚(更上层)。 */
  moveSlot: (name: string, delta: 1 | -1) => void
  setSlotColor: (name: string, color: Color, mergeKey?: string) => void
  setSlotBlend: (name: string, blend: BlendMode) => void

  /** 记录正式打包产物。MVP 阶段一个项目只维护一个图集。 */
  setAtlas: (atlas: AtlasAsset) => void
}

function replaceBone(skeleton: SkeletonData, index: number, patch: Partial<BoneData>): SkeletonData {
  const bones = skeleton.bones.slice()
  bones[index] = { ...bones[index]!, ...patch }
  return { ...skeleton, bones }
}

function replaceSlot(skeleton: SkeletonData, index: number, patch: Partial<SlotData>): SkeletonData {
  const slots = skeleton.slots.slice()
  slots[index] = { ...slots[index]!, ...patch }
  return { ...skeleton, slots }
}

/**
 * 皮肤按 slot 下标索引,slot 数组一动(删除/换序)所有下标都要跟着重排。
 * mapIndex 返回 null 表示该 slot 的 attachment 一并丢弃。
 */
function remapSkins(
  skins: ReadonlyMap<string, Skin>,
  mapIndex: (index: number) => number | null,
): ReadonlyMap<string, Skin> {
  const next = new Map<string, Skin>()
  for (const [name, skin] of skins) {
    const entries = new Map<number, ReadonlyMap<string, Attachment>>()
    for (const [index, attachments] of skin) {
      const mapped = mapIndex(index)
      if (mapped !== null) entries.set(mapped, attachments)
    }
    next.set(name, entries)
  }
  return next
}

function withBoneKey(
  anim: AnimationData,
  boneName: string,
  channel: BoneChannel,
  key: RotateKey | Vec2Key,
): AnimationData {
  const timelines = anim.bones.get(boneName)
  const patch: Partial<BoneTimelines> =
    channel === 'rotate'
      ? { rotate: putKeyframe(timelines?.rotate ?? [], key as RotateKey) }
      : { [channel]: putKeyframe((timelines?.[channel] ?? []) as readonly Vec2Key[], key as Vec2Key) }
  const bones = new Map(anim.bones)
  bones.set(boneName, { ...timelines, ...patch })

  return { ...anim, bones, duration: Math.max(anim.duration, key.time) }
}

export const useEditorStore = create<EditorState>()((set, get) => ({
  doc: SAMPLE_PROJECT,
  past: [],
  future: [],
  lastMergeKey: null,

  mode: 'animate',
  tool: 'rotate',
  currentAnimation: SAMPLE_WALK.name,
  time: 0,
  playing: false,
  selectedBone: null,
  projectDir: null,

  commit: (next, mergeKey) => {
    const { doc, past, lastMergeKey } = get()

    if (mergeKey !== undefined && mergeKey === lastMergeKey) {
      set({ doc: next, future: [] })
      return
    }

    const nextPast = [...past, doc]
    if (nextPast.length > MAX_HISTORY) nextPast.shift()

    set({ doc: next, past: nextPast, future: [], lastMergeKey: mergeKey ?? null })
  },

  undo: () => {
    const { past, future, doc } = get()
    const prev = past[past.length - 1]
    if (prev === undefined) return
    // lastMergeKey 必须清掉:否则撤销后紧接着的同 key 编辑会被误合并进已恢复的状态
    set({ doc: prev, past: past.slice(0, -1), future: [doc, ...future], lastMergeKey: null })
  },

  redo: () => {
    const { past, future, doc } = get()
    const next = future[0]
    if (next === undefined) return
    set({ doc: next, past: [...past, doc], future: future.slice(1), lastMergeKey: null })
  },

  setMode: (mode) => set({ mode, playing: false }),
  setTool: (tool) => set({ tool }),
  selectBone: (name) => set({ selectedBone: name }),
  selectAnimation: (name) => set({ currentAnimation: name, time: 0, playing: false }),
  addAnimation: () => {
    const { doc, commit } = get()
    let serial = doc.animations.size + 1
    let name = `anim_${serial}`
    while (doc.animations.has(name)) {
      serial += 1
      name = `anim_${serial}`
    }
    const animations = new Map(doc.animations)
    animations.set(name, { name, duration: 1, bones: new Map() })
    commit({ ...doc, animations })
    set({ currentAnimation: name, time: 0, playing: false })
    return name
  },
  setTime: (time) => set({ time: Math.max(0, time) }),
  setPlaying: (playing) => set({ playing }),
  setProjectDir: (projectDir) => set({ projectDir }),
  replaceProject: (doc) =>
    set({
      doc,
      past: [],
      future: [],
      lastMergeKey: null,
      time: 0,
      playing: false,
      selectedBone: null,
      // 别让当前动画指向上一个项目的名字 —— 新项目没有同名动画时打帧会全部静默失败
      currentAnimation: doc.animations.keys().next().value ?? '',
    }),
  addImages: (images) => {
    if (images.length === 0) return
    const { doc, commit } = get()
    const ids = new Set(doc.images.map((image) => image.id))
    const duplicates = images.find((image) => ids.has(image.id))
    if (duplicates !== undefined) throw new Error(`图片资源 ID 重复: ${duplicates.id}`)
    commit({ ...doc, images: [...doc.images, ...images] })
  },
  bindImageToBone: (imageId, boneName) => {
    const { doc, commit } = get()
    const image = doc.images.find((candidate) => candidate.id === imageId)
    const bone = doc.skeleton.bones.findIndex((candidate) => candidate.name === boneName)
    if (image === undefined) throw new Error(`找不到图片资源: ${imageId}`)
    if (bone < 0) throw new Error(`找不到骨骼: ${boneName}`)

    const existingSlot = doc.skeleton.slots.findIndex((slot) => slot.attachment === imageId)
    const slotIndex = existingSlot < 0 ? doc.skeleton.slots.length : existingSlot
    const slot: SlotData = {
      name: existingSlot < 0 ? `slot_${imageId}` : doc.skeleton.slots[existingSlot]!.name,
      bone,
      attachment: imageId,
      color: existingSlot < 0 ? { r: 1, g: 1, b: 1, a: 1 } : doc.skeleton.slots[existingSlot]!.color,
      blend: existingSlot < 0 ? 'normal' : doc.skeleton.slots[existingSlot]!.blend,
    }
    const slots = doc.skeleton.slots.slice()
    if (existingSlot < 0) slots.push(slot)
    else slots[existingSlot] = slot

    // path 用图片文件名 —— 和 looseAtlas / 正式打包的区域名一致,见 looseAtlas.ts
    const attachment: RegionAttachment = {
      type: 'region', name: imageId, path: image.path, x: 0, y: 0, rotation: 0,
      scaleX: 1, scaleY: 1, width: image.width, height: image.height,
    }
    const skins = new Map(doc.skeleton.skins)
    const defaultSkin = new Map(skins.get(doc.skeleton.defaultSkin) ?? [])
    const attachments = new Map(defaultSkin.get(slotIndex) ?? [])
    attachments.set(imageId, attachment)
    defaultSkin.set(slotIndex, attachments)
    skins.set(doc.skeleton.defaultSkin, defaultSkin)

    commit({ ...doc, skeleton: { ...doc.skeleton, slots, skins } })
  },
  addBone: (parentName) => {
    const { doc, commit } = get()
    const parent = parentName === null ? -1 : doc.skeleton.bones.findIndex((bone) => bone.name === parentName)
    if (parentName !== null && parent < 0) throw new Error(`找不到父骨骼: ${parentName}`)

    let serial = doc.skeleton.bones.length + 1
    let name = `bone_${serial}`
    const names = new Set(doc.skeleton.bones.map((bone) => bone.name))
    while (names.has(name)) {
      serial += 1
      name = `bone_${serial}`
    }
    const parentBone = parent < 0 ? undefined : doc.skeleton.bones[parent]
    const bone: BoneData = {
      name,
      parent,
      x: parentBone?.length ?? 0,
      y: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      shearX: 0,
      shearY: 0,
      length: 80,
      inheritRotation: true,
      inheritScale: true,
    }
    commit({ ...doc, skeleton: { ...doc.skeleton, bones: [...doc.skeleton.bones, bone] } })
    return name
  },

  setBoneRotation: (boneName, localRotation, mergeKey) => {
    setBoneValue(get(), boneName, mergeKey, { rotation: localRotation }, (bind) => ({
      channel: 'rotate',
      // 关键帧值是相对绑定姿势的偏移 —— 见 docs/FORMAT.md
      key: { time: get().time, value: localRotation - bind.rotation },
    }))
  },

  setBoneTranslation: (boneName, x, y, mergeKey) => {
    setBoneValue(get(), boneName, mergeKey, { x, y }, (bind) => ({
      channel: 'translate',
      key: { time: get().time, x: x - bind.x, y: y - bind.y },
    }))
  },

  setBoneScale: (boneName, scaleX, scaleY, mergeKey) => {
    setBoneValue(get(), boneName, mergeKey, { scaleX, scaleY }, (bind) => ({
      channel: 'scale',
      // scale 偏移是比值。绑定值为 0 时任何比值都乘不出非零,存 1 保持绑定值
      key: {
        time: get().time,
        x: bind.scaleX === 0 ? 1 : scaleX / bind.scaleX,
        y: bind.scaleY === 0 ? 1 : scaleY / bind.scaleY,
      },
    }))
  },

  setBoneShear: (boneName, shearX, shearY, mergeKey) => {
    setBoneValue(get(), boneName, mergeKey, { shearX, shearY }, (bind) => ({
      channel: 'shear',
      key: { time: get().time, x: shearX - bind.shearX, y: shearY - bind.shearY },
    }))
  },

  setBoneLength: (boneName, length, mergeKey) => {
    const { doc, commit } = get()
    const index = doc.skeleton.bones.findIndex((b) => b.name === boneName)
    if (index < 0) return
    commit({ ...doc, skeleton: replaceBone(doc.skeleton, index, { length: Math.max(0, length) }) }, mergeKey)
  },

  keyBoneAtTime: (boneName) => {
    const { doc, currentAnimation, time, commit } = get()
    const anim = doc.animations.get(currentAnimation)
    if (anim === undefined) return

    const pose = samplePose(anim, boneName, time)
    const timelines = anim.bones.get(boneName)
    const has = (keys: readonly unknown[] | undefined) => keys !== undefined && keys.length > 0

    let next = anim
    let touched = false
    if (has(timelines?.rotate)) {
      next = withBoneKey(next, boneName, 'rotate', { time, value: pose.rotation })
      touched = true
    }
    if (has(timelines?.translate)) {
      next = withBoneKey(next, boneName, 'translate', { time, x: pose.x, y: pose.y })
      touched = true
    }
    if (has(timelines?.scale)) {
      next = withBoneKey(next, boneName, 'scale', { time, x: pose.scaleX, y: pose.scaleY })
      touched = true
    }
    if (has(timelines?.shear)) {
      next = withBoneKey(next, boneName, 'shear', { time, x: pose.shearX, y: pose.shearY })
      touched = true
    }
    if (!touched) next = withBoneKey(next, boneName, 'rotate', { time, value: 0 })

    const animations = new Map(doc.animations)
    animations.set(currentAnimation, next)
    commit({ ...doc, animations })
  },

  deleteKeyframe: (boneName, channel, time) => {
    const { doc, currentAnimation, commit } = get()
    const anim = doc.animations.get(currentAnimation)
    const timelines = anim?.bones.get(boneName)
    const keys = timelines?.[channel]
    if (anim === undefined || timelines === undefined || keys === undefined) return

    const bones = new Map(anim.bones)
    bones.set(boneName, { ...timelines, [channel]: removeKeyframe<RotateKey | Vec2Key>(keys, time) })

    const animations = new Map(doc.animations)
    animations.set(currentAnimation, { ...anim, bones })
    commit({ ...doc, animations })
  },

  renameSlot: (name, newName) => {
    const { doc, commit } = get()
    const trimmed = newName.trim()
    const index = doc.skeleton.slots.findIndex((slot) => slot.name === name)
    if (index < 0 || trimmed === '' || trimmed === name) return
    if (doc.skeleton.slots.some((slot) => slot.name === trimmed)) throw new Error(`slot 名称重复: ${trimmed}`)
    commit({ ...doc, skeleton: replaceSlot(doc.skeleton, index, { name: trimmed }) })
  },

  removeSlot: (name) => {
    const { doc, commit } = get()
    const index = doc.skeleton.slots.findIndex((slot) => slot.name === name)
    if (index < 0) return

    const slots = doc.skeleton.slots.filter((_, i) => i !== index)
    const skins = remapSkins(doc.skeleton.skins, (i) => (i === index ? null : i > index ? i - 1 : i))
    commit({ ...doc, skeleton: { ...doc.skeleton, slots, skins } })
  },

  moveSlot: (name, delta) => {
    const { doc, commit } = get()
    const from = doc.skeleton.slots.findIndex((slot) => slot.name === name)
    const to = from + delta
    if (from < 0 || to < 0 || to >= doc.skeleton.slots.length) return

    const slots = doc.skeleton.slots.slice()
    ;[slots[from], slots[to]] = [slots[to]!, slots[from]!]
    const skins = remapSkins(doc.skeleton.skins, (i) => (i === from ? to : i === to ? from : i))
    commit({ ...doc, skeleton: { ...doc.skeleton, slots, skins } })
  },

  setSlotColor: (name, color, mergeKey) => {
    const { doc, commit } = get()
    const index = doc.skeleton.slots.findIndex((slot) => slot.name === name)
    if (index < 0) return
    commit({ ...doc, skeleton: replaceSlot(doc.skeleton, index, { color }) }, mergeKey)
  },

  setSlotBlend: (name, blend) => {
    const { doc, commit } = get()
    const index = doc.skeleton.slots.findIndex((slot) => slot.name === name)
    if (index < 0) return
    commit({ ...doc, skeleton: replaceSlot(doc.skeleton, index, { blend }) })
  },

  setAtlas: (atlas) => {
    const { doc, commit } = get()
    commit({ ...doc, atlases: [atlas] })
  },
}))

/**
 * TRS 编辑的公共骨架:setup 模式写绑定姿势,animate 模式打关键帧。
 * toKey 拿到绑定姿势,负责算出「相对绑定姿势的偏移」。
 */
function setBoneValue(
  state: EditorState,
  boneName: string,
  mergeKey: string | undefined,
  setupPatch: Partial<BoneData>,
  toKey: (bind: BoneData) => { channel: BoneChannel; key: RotateKey | Vec2Key },
): void {
  const { doc, mode, currentAnimation, commit } = state
  const index = doc.skeleton.bones.findIndex((b) => b.name === boneName)
  if (index < 0) return

  if (mode === 'setup') {
    commit({ ...doc, skeleton: replaceBone(doc.skeleton, index, setupPatch) }, mergeKey)
    return
  }

  const anim = doc.animations.get(currentAnimation)
  if (anim === undefined) return

  const { channel, key } = toKey(doc.skeleton.bones[index]!)
  const animations = new Map(doc.animations)
  animations.set(currentAnimation, withBoneKey(anim, boneName, channel, key))
  commit({ ...doc, animations }, mergeKey)
}

export const selectCanUndo = (s: EditorState): boolean => s.past.length > 0
export const selectCanRedo = (s: EditorState): boolean => s.future.length > 0
