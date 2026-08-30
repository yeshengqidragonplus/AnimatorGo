import { describe, expect, it } from 'vitest'
import {
  degreesToQuaternionZ, quaternionZToDegrees, toUnityCurve,
  STEPPED_SLOPE, WEIGHTED_IN, WEIGHTED_OUT,
} from './curve.ts'

/** 三次贝塞尔的一个分量,控制点为 0, c1, c2, 1 */
const bezierAxis = (t: number, c1: number, c2: number) => {
  const mt = 1 - t
  return 3 * mt * mt * t * c1 + 3 * mt * t * t * c2 + t * t * t
}
/** 该分量的导数,用来验证端点斜率 */
const bezierSlope = (t: number, c1: number, c2: number) => {
  const mt = 1 - t
  return 3 * mt * mt * c1 + 6 * mt * t * (c2 - c1) + 3 * t * t * (1 - c2)
}

describe('Spine 曲线 → Unity 切线', () => {
  it('线性段的斜率就是两点连线斜率', () => {
    const { keys } = toUnityCurve([0, 0.5], [0, 1.5], [{ curve: 'linear' }, undefined])
    expect(keys[0]!.outSlope).toBe(3) // 1.5 / 0.5
    expect(keys[1]!.inSlope).toBe(3)
  })

  it('阶梯段用无穷斜率表示 —— Unity 就是这么存的', () => {
    const { keys } = toUnityCurve([0, 1], [0, 5], [{ curve: 'stepped' }, undefined])
    expect(keys[0]!.outSlope).toBe(STEPPED_SLOPE)
    expect(keys[1]!.inSlope).toBe(STEPPED_SLOPE)
  })

  /**
   * ⭐ 关键:切线必须等于贝塞尔曲线在端点处的真实导数。
   * 算错的话动画的缓入缓出就会变形,而且**肉眼很难发现**。
   */
  it('贝塞尔端点斜率与曲线的解析导数一致', () => {
    const bezier = [0.25, 0.1, 0.75, 0.9] as const
    const [cx1, cy1, cx2, cy2] = bezier
    const t0 = 0, t1 = 2, v0 = 10, v1 = 30

    const { keys } = toUnityCurve([t0, t1], [v0, v1], [{ curve: 'bezier', bezier }, undefined])

    // 归一化空间里的 dy/dx,再换算回真实单位
    const startSlope = (bezierSlope(0, cy1, cy2) / bezierSlope(0, cx1, cx2)) * ((v1 - v0) / (t1 - t0))
    const endSlope = (bezierSlope(1, cy1, cy2) / bezierSlope(1, cx1, cx2)) * ((v1 - v0) / (t1 - t0))

    expect(keys[0]!.outSlope).toBeCloseTo(startSlope, 6)
    expect(keys[1]!.inSlope).toBeCloseTo(endSlope, 6)
  })

  it('权重直接取自控制点的时间占比 —— 这是精确还原的前提', () => {
    const { keys, approximated } = toUnityCurve(
      [0, 1], [0, 1], [{ curve: 'bezier', bezier: [0.25, 0.1, 0.75, 0.9] }, undefined],
    )
    expect(keys[0]!.outWeight).toBeCloseTo(0.25, 9)
    expect(keys[1]!.inWeight).toBeCloseTo(0.25, 9) // 1 - 0.75
    expect(keys[0]!.weightedMode & WEIGHTED_OUT).toBeTruthy()
    expect(keys[1]!.weightedMode & WEIGHTED_IN).toBeTruthy()
    expect(approximated).toBe(false)
  })

  it('中间帧同时是前一段的终点和后一段的起点,weightedMode 要合并', () => {
    const b = { curve: 'bezier' as const, bezier: [0.3, 0.1, 0.7, 0.9] }
    const { keys } = toUnityCurve([0, 1, 2], [0, 1, 2], [b, b, undefined])
    expect(keys[1]!.weightedMode).toBe(WEIGHTED_IN | WEIGHTED_OUT)
  })

  it('控制点贴在端点上时斜率无定义,退化为线性并报近似', () => {
    const { keys, approximated } = toUnityCurve(
      [0, 1], [0, 2], [{ curve: 'bezier', bezier: [0, 0, 1, 1] }, undefined],
    )
    expect(Number.isFinite(keys[0]!.outSlope)).toBe(true)
    expect(keys[0]!.outSlope).toBe(2)
    expect(approximated).toBe(true)
  })

  it('时间没有前进时退化为阶梯,不产生 NaN', () => {
    const { keys } = toUnityCurve([1, 1], [0, 5], [{ curve: 'linear' }, undefined])
    expect(keys[0]!.outSlope).toBe(STEPPED_SLOPE)
    expect(Number.isNaN(keys[1]!.inSlope)).toBe(false)
  })

  it('贝塞尔曲线本身仍过两端点(转换不改变端点值)', () => {
    const [cx1, cy1, cx2, cy2] = [0.25, 0.1, 0.75, 0.9]
    expect(bezierAxis(0, cy1, cy2)).toBeCloseTo(0, 9)
    expect(bezierAxis(1, cy1, cy2)).toBeCloseTo(1, 9)
    expect(bezierAxis(0, cx1, cx2)).toBeCloseTo(0, 9)
  })
})

describe('旋转:角度 ↔ 四元数', () => {
  it('与真实 .meta 样本一致', () => {
    // HP3D2/Assets/Res/test/test.png.meta 里 bone_1 的实际取值
    expect(quaternionZToDegrees(0.9366846, 0.3501742)).toBeCloseTo(139.004, 3)
  })

  it('往返无损', () => {
    for (const deg of [0, 30, -45, 90, 139.004, 179, -179]) {
      const q = degreesToQuaternionZ(deg)
      expect(quaternionZToDegrees(q.z, q.w)).toBeCloseTo(deg, 6)
    }
  })

  it('只绕 Z 轴 —— x/y 恒为 0', () => {
    const q = degreesToQuaternionZ(37)
    expect(q.x).toBe(0)
    expect(q.y).toBe(0)
  })
})
