import { create } from 'zustand'
import type { AnimationData, RotateKey } from '@core/animation.ts'
import { putKeyframe, removeKeyframe, TIME_EPSILON } from '@core/animation.ts'
import type { BoneData, RegionAttachment, SkeletonData, SlotData } from '@core/types.ts'
import { SAMPLE_SKELETON, SAMPLE_WALK } from '@core/sample.ts'
import { PROJECT_FORMAT_VERSION, type ProjectData } from '@project/types.ts'
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
 * 处于哪个模式 —— 这些是**视图状态**,撤销不应该把播放头拽回去。
 */

export type EditorMode = 'setup' | 'animate'

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
  currentAnimation: string
  time: number
  playing: boolean
  selectedBone: string | null
  projectDir: string | null

  commit: (next: ProjectData, mergeKey?: string) => void
  undo: () => void
  redo: () => void

  setMode: (mode: EditorMode) => void
  selectBone: (name: string | null) => void
  setTime: (time: number) => void
  setPlaying: (playing: boolean) => void
  setProjectDir: (dir: string | null) => void
  replaceProject: (project: ProjectData) => void
  addImages: (images: readonly ImageAsset[]) => void
  bindImageToBone: (imageId: string, boneName: string) => void
  addBone: (parentName: string | null) => string

  /**
   * 拖动骨骼的落点。传入的是**绝对局部旋转角**,由模式决定写到哪:
   *   setup   → 改绑定姿势
   *   animate → 在当前时刻打一个关键帧,值 = 绝对角 − 绑定姿势角
   */
  setBoneRotation: (boneName: string, localRotation: number, mergeKey?: string) => void

  /** 在当前时刻为选中骨骼打一个关键帧(值取当前姿势) */
  keyBoneAtTime: (boneName: string) => void
  deleteKeyframe: (boneName: string, time: number) => void
}

function replaceBone(skeleton: SkeletonData, index: number, patch: Partial<BoneData>): SkeletonData {
  const bones = skeleton.bones.slice()
  bones[index] = { ...bones[index]!, ...patch }
  return { ...skeleton, bones }
}

function withRotateKey(anim: AnimationData, boneName: string, key: RotateKey): AnimationData {
  const timelines = anim.bones.get(boneName)
  const rotate = putKeyframe(timelines?.rotate ?? [], key)
  const bones = new Map(anim.bones)
  bones.set(boneName, { ...timelines, rotate })

  const last = rotate[rotate.length - 1]
  return { ...anim, bones, duration: Math.max(anim.duration, last?.time ?? 0) }
}

export const useEditorStore = create<EditorState>()((set, get) => ({
  doc: SAMPLE_PROJECT,
  past: [],
  future: [],
  lastMergeKey: null,

  mode: 'animate',
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
  selectBone: (name) => set({ selectedBone: name }),
  setTime: (time) => set({ time: Math.max(0, time) }),
  setPlaying: (playing) => set({ playing }),
  setProjectDir: (projectDir) => set({ projectDir }),
  replaceProject: (doc) => set({ doc, past: [], future: [], lastMergeKey: null, time: 0, playing: false, selectedBone: null }),
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
      color: { r: 1, g: 1, b: 1, a: 1 },
      blend: 'normal',
    }
    const slots = doc.skeleton.slots.slice()
    if (existingSlot < 0) slots.push(slot)
    else slots[existingSlot] = slot

    const attachment: RegionAttachment = {
      type: 'region', name: imageId, path: imageId, x: 0, y: 0, rotation: 0,
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
    const { doc, mode, currentAnimation, time, commit } = get()
    const index = doc.skeleton.bones.findIndex((b) => b.name === boneName)
    if (index < 0) return

    if (mode === 'setup') {
      commit({ ...doc, skeleton: replaceBone(doc.skeleton, index, { rotation: localRotation }) }, mergeKey)
      return
    }

    const anim = doc.animations.get(currentAnimation)
    if (anim === undefined) return

    // 关键帧值是相对绑定姿势的偏移 —— 见 docs/FORMAT.md
    const offset = localRotation - doc.skeleton.bones[index]!.rotation
    const animations = new Map(doc.animations)
    animations.set(currentAnimation, withRotateKey(anim, boneName, { time, value: offset }))
    commit({ ...doc, animations }, mergeKey)
  },

  keyBoneAtTime: (boneName) => {
    const { doc, currentAnimation, time, commit } = get()
    const anim = doc.animations.get(currentAnimation)
    if (anim === undefined) return

    // 取该骨骼当前时刻已有的值,原地打一帧(把插值出来的姿势固化下来)
    const existing = anim.bones.get(boneName)?.rotate ?? []
    const atTime = existing.find((k) => Math.abs(k.time - time) < TIME_EPSILON)
    const value = atTime?.value ?? 0

    const animations = new Map(doc.animations)
    animations.set(currentAnimation, withRotateKey(anim, boneName, { time, value }))
    commit({ ...doc, animations })
  },

  deleteKeyframe: (boneName, time) => {
    const { doc, currentAnimation, commit } = get()
    const anim = doc.animations.get(currentAnimation)
    const timelines = anim?.bones.get(boneName)
    if (anim === undefined || timelines?.rotate === undefined) return

    const bones = new Map(anim.bones)
    bones.set(boneName, { ...timelines, rotate: removeKeyframe(timelines.rotate, time) })

    const animations = new Map(doc.animations)
    animations.set(currentAnimation, { ...anim, bones })
    commit({ ...doc, animations })
  },
}))

export const selectCanUndo = (s: EditorState): boolean => s.past.length > 0
export const selectCanRedo = (s: EditorState): boolean => s.future.length > 0
