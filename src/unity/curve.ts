/**
 * Spine 曲线 → Unity 曲线。
 *
 * 两者都是三次曲线,但参数化方式不同:
 *
 * ```
 * Spine:  贝塞尔控制点 [cx1, cy1, cx2, cy2],归一化到两帧之间的 [0,1]×[0,1]
 * Unity:  每帧一个切线斜率 inSlope / outSlope,外加可选的权重 inWeight / outWeight
 * ```
 *
 * **开了 weightedMode 之后可以精确互转** —— Spine 的 `cx1` 恰好就是 Unity 的
 * `outWeight`(占该段时长的比例),`1 - cx2` 就是 `inWeight`。
 * 不开权重则只能近似,必须报 `approximated`。
 *
 * 见 [docs/UNITY-2D.md](../../docs/UNITY-2D.md) 第 5 节。
 */

/** Unity 的 weightedMode 位标志 */
export const WEIGHTED_NONE = 0
export const WEIGHTED_IN = 1
export const WEIGHTED_OUT = 2
export const WEIGHTED_BOTH = 3

/** Unity 用无穷大的斜率表示「阶梯」(保持前值不插值) */
export const STEPPED_SLOPE = Number.POSITIVE_INFINITY

/** Unity 不加权时的默认权重,写在文件里但不生效 */
export const DEFAULT_WEIGHT = 1 / 3

export interface UnityKeyframe {
  time: number
  value: number
  inSlope: number
  outSlope: number
  inWeight: number
  outWeight: number
  weightedMode: number
}

/** 一段区间的曲线定义(来自 Spine 的帧) */
export interface SpineSegment {
  readonly curve: 'linear' | 'stepped' | 'bezier'
  /** 仅 bezier:[cx1, cy1, cx2, cy2] */
  readonly bezier?: readonly number[]
}

/**
 * 把一条 Spine 时间轴的某个分量转成 Unity 关键帧序列。
 *
 * `times` / `values` 长度相同;`segments[i]` 描述第 i 帧到第 i+1 帧之间的曲线
 * (最后一帧没有,传 undefined)。
 */
export function toUnityCurve(
  times: readonly number[],
  values: readonly number[],
  segments: readonly (SpineSegment | undefined)[],
): { keys: UnityKeyframe[]; approximated: boolean } {
  const keys: UnityKeyframe[] = times.map((time, i) => ({
    time,
    value: values[i]!,
    inSlope: 0,
    outSlope: 0,
    inWeight: DEFAULT_WEIGHT,
    outWeight: DEFAULT_WEIGHT,
    weightedMode: WEIGHTED_NONE,
  }))

  let approximated = false

  for (let i = 0; i + 1 < keys.length; i++) {
    const k0 = keys[i]!
    const k1 = keys[i + 1]!
    const dt = k1.time - k0.time
    const dv = k1.value - k0.value
    const segment = segments[i]

    // 时间没有前进就没法定义斜率,退化成阶梯
    if (dt <= 0) {
      k0.outSlope = STEPPED_SLOPE
      k1.inSlope = STEPPED_SLOPE
      continue
    }

    if (segment === undefined || segment.curve === 'linear') {
      const slope = dv / dt
      k0.outSlope = slope
      k1.inSlope = slope
      continue
    }

    if (segment.curve === 'stepped') {
      // Unity 用无穷斜率表示阶梯 —— 值一直保持到下一帧才跳变
      k0.outSlope = STEPPED_SLOPE
      k1.inSlope = STEPPED_SLOPE
      continue
    }

    const [cx1, cy1, cx2, cy2] = segment.bezier as [number, number, number, number]

    // 控制点贴在端点上时斜率无定义(0/0),按线性处理
    const safeOut = cx1 > 1e-6
    const safeIn = 1 - cx2 > 1e-6

    k0.outSlope = safeOut ? (dv * cy1) / (dt * cx1) : dv / dt
    k1.inSlope = safeIn ? (dv * (1 - cy2)) / (dt * (1 - cx2)) : dv / dt

    // 权重就是控制点在时间轴上的占比 —— 有它才能精确还原
    k0.outWeight = cx1
    k1.inWeight = 1 - cx2
    k0.weightedMode |= WEIGHTED_OUT
    k1.weightedMode |= WEIGHTED_IN

    if (!safeOut || !safeIn) approximated = true
  }

  return { keys, approximated }
}

/**
 * Spine 只绕 Z 轴旋转,所以四元数与角度可以直接互转。
 *
 * 用真实样本验证过:z=0.9366846, w=0.3501742 ↔ 139.004°,往返一致。
 */
export function degreesToQuaternionZ(degrees: number): { x: 0; y: 0; z: number; w: number } {
  const half = (degrees * Math.PI) / 360
  return { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) }
}

export function quaternionZToDegrees(z: number, w: number): number {
  return (2 * Math.atan2(z, w) * 180) / Math.PI
}
