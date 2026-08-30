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
   * ⭐ **Spine 的控制点是绝对的「时间 / 值」**,不是归一化的。
   * 实测数据里出现过 cx1 = 1.1083(该段是 1.0→2.0 秒)、cy1 = 333.98(角度)。
   *
   * 按归一化处理不会崩,只会让所有缓动**悄悄变形** —— 所以这条测试用
   * 明显超出 [0,1] 的控制点,一旦有人改回归一化就会红。
   */
  it('控制点按绝对坐标解释,cx 可以大于 1', () => {
    const t0 = 1, t1 = 2, v0 = 100, v1 = 300
    // 控制点在 1.25 秒 / 值 150,和 1.75 秒 / 值 280
    const bezier = [1.25, 150, 1.75, 280]
    const { keys } = toUnityCurve([t0, t1], [v0, v1], [{ curve: 'bezier', bezier }, undefined])

    // 斜率 = 控制点到端点的连线斜率
    expect(keys[0]!.outSlope).toBeCloseTo((150 - 100) / (1.25 - 1), 6)
    expect(keys[1]!.inSlope).toBeCloseTo((300 - 280) / (2 - 1.75), 6)
  })

  it('权重是控制点占该段时长的比例', () => {
    const { keys, approximated } = toUnityCurve(
      [1, 2], [100, 300], [{ curve: 'bezier', bezier: [1.25, 150, 1.75, 280] }, undefined],
    )
    expect(keys[0]!.outWeight).toBeCloseTo(0.25, 9) // (1.25-1)/1
    expect(keys[1]!.inWeight).toBeCloseTo(0.25, 9) // (2-1.75)/1
    expect(keys[0]!.weightedMode & WEIGHTED_OUT).toBeTruthy()
    expect(keys[1]!.weightedMode & WEIGHTED_IN).toBeTruthy()
    expect(approximated).toBe(false)
  })

  it('等价于对归一化控制点做还原 —— 两种算法结果一致', () => {
    const t0 = 0, t1 = 2, v0 = 10, v1 = 30
    const [nx1, ny1, nx2, ny2] = [0.25, 0.1, 0.75, 0.9] // 归一化控制点
    // 换算成绝对坐标喂进去
    const abs = [t0 + nx1 * (t1 - t0), v0 + ny1 * (v1 - v0), t0 + nx2 * (t1 - t0), v0 + ny2 * (v1 - v0)]
    const { keys } = toUnityCurve([t0, t1], [v0, v1], [{ curve: 'bezier', bezier: abs }, undefined])

    // 归一化空间里的解析导数,换算回真实单位后应当一致
    const start = (bezierSlope(0, ny1, ny2) / bezierSlope(0, nx1, nx2)) * ((v1 - v0) / (t1 - t0))
    const end = (bezierSlope(1, ny1, ny2) / bezierSlope(1, nx1, nx2)) * ((v1 - v0) / (t1 - t0))
    expect(keys[0]!.outSlope).toBeCloseTo(start, 6)
    expect(keys[1]!.inSlope).toBeCloseTo(end, 6)
  })

  it('中间帧同时是前一段的终点和后一段的起点,weightedMode 要合并', () => {
    const { keys } = toUnityCurve([0, 1, 2], [0, 1, 2], [
      { curve: 'bezier', bezier: [0.3, 0.3, 0.7, 0.7] },
      { curve: 'bezier', bezier: [1.3, 1.3, 1.7, 1.7] },
      undefined,
    ])
    expect(keys[1]!.weightedMode).toBe(WEIGHTED_IN | WEIGHTED_OUT)
  })

  it('控制点贴在端点上时斜率无定义,退化为线性并报近似', () => {
    const { keys, approximated } = toUnityCurve(
      [0, 1], [0, 2], [{ curve: 'bezier', bezier: [0, 0, 1, 2] }, undefined],
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
