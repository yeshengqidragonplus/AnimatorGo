import { create } from 'zustand'
import type { BoneData, SkeletonData } from '@core/types.ts'
import { SAMPLE_SKELETON } from '@core/sample.ts'

/**
 * 编辑器状态与撤销重做。
 *
 * ── 设计:不可变快照 + merge key 合并 ──
 *
 * 文档(EditorDoc)是不可变的。每次编辑产生一份新的,旧的压进 past。
 * 因为 SkeletonData 内部结构共享(只替换被改的那根骨骼,其余数组元素复用),
 * 一次快照的实际内存开销只有被改动的部分。
 *
 * **merge key 是这套设计里唯一不显然的部分,也是不能事后加的部分:**
 * 拖动一根骨骼会产生几百个 mousemove,每个都是一次 commit。没有合并的话
 * 撤销一次只退回一个像素,完全没法用。
 *
 * 规则:连续两次 commit 的 mergeKey 相同且非 null 时,后一次直接替换当前状态,
 * 不压栈。拖动手势开始时生成一个唯一 key(含手势 id),整个手势合并成一条记录;
 * 松开鼠标后 key 失效,下一次拖动是新记录。
 *
 * 见 CLAUDE.md「动手前必须知道的坑」。
 */

export interface EditorDoc {
  readonly skeleton: SkeletonData
}

/** 超过这个数就丢弃最老的记录,避免长时间编辑后内存无限增长 */
const MAX_HISTORY = 200

interface EditorState {
  doc: EditorDoc
  past: EditorDoc[]
  future: EditorDoc[]
  /** 上一次 commit 的 merge key;undo/redo 后重置为 null */
  lastMergeKey: string | null

  selectedBone: string | null

  commit: (next: EditorDoc, mergeKey?: string) => void
  undo: () => void
  redo: () => void
  selectBone: (name: string | null) => void

  /** 修改一根骨骼的绑定姿势。patch 中未给出的字段保持不变。 */
  setBonePose: (boneName: string, patch: Partial<BoneData>, mergeKey?: string) => void
}

export const useEditorStore = create<EditorState>()((set, get) => ({
  doc: { skeleton: SAMPLE_SKELETON },
  past: [],
  future: [],
  lastMergeKey: null,
  selectedBone: null,

  commit: (next, mergeKey) => {
    const { doc, past, lastMergeKey } = get()

    // 同一个手势内的连续修改 —— 替换而非压栈
    if (mergeKey !== undefined && mergeKey === lastMergeKey) {
      set({ doc: next, future: [] })
      return
    }

    const nextPast = [...past, doc]
    if (nextPast.length > MAX_HISTORY) nextPast.shift()

    set({
      doc: next,
      past: nextPast,
      future: [],
      lastMergeKey: mergeKey ?? null,
    })
  },

  undo: () => {
    const { past, future, doc } = get()
    const prev = past[past.length - 1]
    if (prev === undefined) return

    set({
      doc: prev,
      past: past.slice(0, -1),
      future: [doc, ...future],
      // 必须清掉:否则撤销后紧接着的编辑可能被误合并进已恢复的状态
      lastMergeKey: null,
    })
  },

  redo: () => {
    const { past, future, doc } = get()
    const next = future[0]
    if (next === undefined) return

    set({
      doc: next,
      past: [...past, doc],
      future: future.slice(1),
      lastMergeKey: null,
    })
  },

  selectBone: (name) => set({ selectedBone: name }),

  setBonePose: (boneName, patch, mergeKey) => {
    const { doc, commit } = get()
    const bones = doc.skeleton.bones
    const index = bones.findIndex((b) => b.name === boneName)
    if (index < 0) return

    const nextBones = bones.slice()
    nextBones[index] = { ...bones[index]!, ...patch }

    commit({ ...doc, skeleton: { ...doc.skeleton, bones: nextBones } }, mergeKey)
  },
}))

export const selectCanUndo = (s: EditorState): boolean => s.past.length > 0
export const selectCanRedo = (s: EditorState): boolean => s.future.length > 0
