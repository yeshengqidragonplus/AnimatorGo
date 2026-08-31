import { describe, expect, it } from 'vitest'
import { curveValuesOf, toAbsoluteBezier, toNormalizedBezier, valueFieldsOf } from './bezier.ts'

describe('贝塞尔控制点的两版坐标系', () => {
  it('归一化 → 绝对:百分比落在该段的时间与取值范围里', () => {
    // 1.0→2.0 秒,取值 100→300;控制点在 25% / 75%
    expect(toAbsoluteBezier([0.25, 0, 0.75, 1], 1, 100, 2, 300)).toEqual([1.25, 100, 1.75, 300])
  })

  it('绝对 → 归一化是它的逆', () => {
    const absolute = [1.25, 150, 1.75, 280]
    const back = toNormalizedBezier(absolute, 1, 100, 2, 300)
    const again = toAbsoluteBezier(back, 1, 100, 2, 300)
    again.forEach((v, i) => expect(v).toBeCloseTo(absolute[i]!, 9))
  })

  it('取值不变时归一化给 0 而不是 NaN —— 曲线怎么画结果都一样', () => {
    const back = toNormalizedBezier([1.25, 42, 1.75, 42], 1, 42, 2, 42)
    expect(back.every(Number.isFinite)).toBe(true)
    expect([back[1], back[3]]).toEqual([0, 0])
  })

  it('时间不变时也不会除出 NaN', () => {
    expect(toNormalizedBezier([1, 5, 1, 9], 1, 0, 1, 10).every(Number.isFinite)).toBe(true)
  })
})

describe('时间轴的分量取值', () => {
  it('transform 约束 3.8 是 4 个 mix,4.x 是 6 个', () => {
    expect(valueFieldsOf('transform', true)).toHaveLength(4)
    expect(valueFieldsOf('transform', false)).toHaveLength(6)
  })

  it('deform 不需要换算 —— 两版的取值空间都是 0..1', () => {
    expect(curveValuesOf('deform', {}, false)).toBeNull()
  })

  it('没有曲线的时间轴返回 null', () => {
    for (const kind of ['attachment', 'drawOrder', 'event']) {
      expect(curveValuesOf(kind, {}, false), kind).toBeNull()
    }
  })

  it('slot 颜色换算到 0..1 —— 4.x 的贝塞尔 cy 是除过 255 的', () => {
    expect(curveValuesOf('slotColor1', { color: [255, 128, 0, 255] }, false)).toEqual([
      1, 128 / 255, 0, 1,
    ])
  })

  it('3.8 的打包颜色也换算到 0..1', () => {
    // 0xFF8000FF → r=1, g=128/255, b=0, a=1
    expect(curveValuesOf('color', { colors: [0xff8000ff | 0] }, true)).toEqual([1, 128 / 255, 0, 1])
  })
})
