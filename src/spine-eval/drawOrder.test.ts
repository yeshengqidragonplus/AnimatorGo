import { describe, expect, it } from 'vitest'
import { drawOrderOf, layerOfSlot } from './drawOrder.ts'

describe('drawOrder 铺顺序', () => {
  it('空 offsets = setup 顺序', () => {
    expect(drawOrderOf(4, [])).toEqual([0, 1, 2, 3])
  })

  it('一个 slot 往上挪:后面的顺次补位', () => {
    // slot 1 挪到第 4 层,其余按原顺序填空位
    expect(drawOrderOf(5, [{ slot: 1, offset: 3 }])).toEqual([0, 2, 3, 4, 1])
  })

  it('一个 slot 往下挪(负 offset)', () => {
    expect(drawOrderOf(5, [{ slot: 3, offset: -2 }])).toEqual([0, 3, 1, 2, 4])
  })

  it('多个一起挪:blackrichwoman 的 angry —— 右手右前臂各 +28,左前臂左手各 +10', () => {
    // 36 个 slot:R-arm 0, R-hand 1, R-forearm 2, … L-forearm 17, L-hand 18 …
    const order = drawOrderOf(36, [
      { slot: 1, offset: 28 },
      { slot: 2, offset: 28 },
      { slot: 17, offset: 10 },
      { slot: 18, offset: 10 },
    ])
    const layer = layerOfSlot(order)
    expect(layer[1]).toBe(29)
    expect(layer[2]).toBe(30)
    expect(layer[17]).toBe(27)
    expect(layer[18]).toBe(28)
    // 头(21)现在在手(29)下面 —— 手摸脸时手在前
    expect(layer[21]!).toBeLessThan(layer[1]!)
    // 每一层恰好一个 slot
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: 36 }, (_, i) => i))
  })

  it('越界和冲突当场报错', () => {
    expect(() => drawOrderOf(3, [{ slot: 2, offset: 1 }])).toThrow(/越界/)
    expect(() => drawOrderOf(3, [{ slot: 0, offset: 2 }, { slot: 1, offset: 1 }])).toThrow(/冲突/)
  })
})
