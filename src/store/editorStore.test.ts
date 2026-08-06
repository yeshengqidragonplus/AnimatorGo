import { beforeEach, describe, expect, it } from 'vitest'
import { useEditorStore } from './editorStore.ts'
import { SAMPLE_SKELETON } from '@core/sample.ts'

const store = () => useEditorStore.getState()
const rotationOf = (name: string) =>
  store().doc.skeleton.bones.find((b) => b.name === name)!.rotation

beforeEach(() => {
  useEditorStore.setState({
    doc: { skeleton: SAMPLE_SKELETON },
    past: [],
    future: [],
    lastMergeKey: null,
    selectedBone: null,
  })
})

describe('撤销重做', () => {
  it('单次编辑产生一条历史记录', () => {
    store().setBonePose('torso', { rotation: 45 })
    expect(store().past).toHaveLength(1)
    expect(rotationOf('torso')).toBe(45)
  })

  it('相同 merge key 的连续编辑合并成一条 —— 一次拖动 = 一次撤销', () => {
    for (let i = 1; i <= 100; i++) {
      store().setBonePose('torso', { rotation: i }, 'rotate:torso:1')
    }

    expect(store().past).toHaveLength(1)
    expect(rotationOf('torso')).toBe(100)

    store().undo()
    expect(rotationOf('torso')).toBe(SAMPLE_SKELETON.bones[2]!.rotation)
  })

  it('不同 merge key 各自成一条 —— 两次拖动 = 两次撤销', () => {
    store().setBonePose('torso', { rotation: 10 }, 'rotate:torso:1')
    store().setBonePose('torso', { rotation: 20 }, 'rotate:torso:1')
    store().setBonePose('torso', { rotation: 30 }, 'rotate:torso:2')

    expect(store().past).toHaveLength(2)

    store().undo()
    expect(rotationOf('torso')).toBe(20)
    store().undo()
    expect(rotationOf('torso')).toBe(SAMPLE_SKELETON.bones[2]!.rotation)
  })

  it('不传 merge key 时不会互相合并', () => {
    store().setBonePose('torso', { rotation: 10 })
    store().setBonePose('torso', { rotation: 20 })
    expect(store().past).toHaveLength(2)
  })

  it('撤销后重做回到原值', () => {
    store().setBonePose('head', { rotation: 33 })
    store().undo()
    store().redo()
    expect(rotationOf('head')).toBe(33)
    expect(store().future).toHaveLength(0)
  })

  it('撤销后的新编辑清空重做栈', () => {
    store().setBonePose('head', { rotation: 10 })
    store().setBonePose('head', { rotation: 20 })
    store().undo()
    expect(store().future).toHaveLength(1)

    store().setBonePose('head', { rotation: 99 })
    expect(store().future).toHaveLength(0)
  })

  it('撤销后紧接的同 key 编辑不会被误合并进已恢复的状态', () => {
    store().setBonePose('head', { rotation: 10 }, 'k')
    store().undo()
    store().setBonePose('head', { rotation: 20 }, 'k')

    // 若 lastMergeKey 没在 undo 时清掉,这次会替换而不压栈,导致撤销不回去
    expect(store().past).toHaveLength(1)
    store().undo()
    expect(rotationOf('head')).toBe(SAMPLE_SKELETON.bones[3]!.rotation)
  })

  it('空栈时撤销重做是安全的空操作', () => {
    expect(() => {
      store().undo()
      store().redo()
    }).not.toThrow()
    expect(store().doc.skeleton).toBe(SAMPLE_SKELETON)
  })

  it('编辑不修改原文档 —— 快照之间结构共享', () => {
    const before = store().doc.skeleton
    store().setBonePose('torso', { rotation: 77 })

    expect(before.bones[2]!.rotation).not.toBe(77) // 原对象未被改动
    expect(store().doc.skeleton.bones[0]).toBe(before.bones[0]) // 未改动的骨骼是同一个引用
  })
})
