import { create } from 'zustand'
import type { AnimationData, RotateKey } from '@core/animation.ts'
import { putKeyframe, removeKeyframe, TIME_EPSILON } from '@core/animation.ts'
import type { BoneData, SkeletonData } from '@core/types.ts'
import { SAMPLE_SKELETON, SAMPLE_WALK } from '@core/sample.ts'

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

export interface EditorDoc {
  readonly skeleton: SkeletonData
  readonly animations: ReadonlyMap<string, AnimationData>
}

const MAX_HISTORY = 200

interface EditorState {
  doc: EditorDoc
  past: EditorDoc[]
  future: EditorDoc[]
  lastMergeKey: string | null

  // 视图状态 —— 不进历史
  mode: EditorMode
  currentAnimation: string
  time: number
  playing: boolean
  selectedBone: string | null

  commit: (next: EditorDoc, mergeKey?: string) => void
  undo: () => void
  redo: () => void

  setMode: (mode: EditorMode) => void
  selectBone: (name: string | null) => void
  setTime: (time: number) => void
  setPlaying: (playing: boolean) => void

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
  doc: {
    skeleton: SAMPLE_SKELETON,
    animations: new Map([[SAMPLE_WALK.name, SAMPLE_WALK]]),
  },
  past: [],
  future: [],
  lastMergeKey: null,

  mode: 'animate',
  currentAnimation: SAMPLE_WALK.name,
  time: 0,
  playing: false,
  selectedBone: null,

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
