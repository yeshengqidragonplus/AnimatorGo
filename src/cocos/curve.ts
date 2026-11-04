import { r } from './json.ts'

/**
 * Spine 曲线 → Cocos `cc.RealCurve`。
 *
 * Cocos 的关键帧(`cc.RealKeyframeValue`)每帧一个 `interpolationMode`,管**这一帧到下一帧**那一段:
 * LINEAR 直线、CONSTANT 阶梯(保持前值)、CUBIC 三次。三次段的形状由本帧的 `rightTangent` /
 * `rightTangentWeight` 和下一帧的 `leftTangent` / `leftTangentWeight` 决定。
 *
 * **开了权重(`tangentWeightMode`)之后控制点就是绝对的**(引擎源码 `evalBetweenTwoKeyFrames`):
 * ```
 * 控制点 = (time + cos(atan(tangent)) · weight, value + sin(atan(tangent)) · weight)
 * ```
 * 也就是 tangent 定方向、weight 定离端点多远(时间 / 值平面里的欧氏距离)。Spine 的贝塞尔控制点
 * 是绝对的时间 / 值,正好能逐点还原:tangent = dy / dx,weight = √(dx² + dy²)。控制点贴在端点上时
 * dx = dy = 0,weight 写 0 就是了 —— 比 Unity 还省事(Unity 那里得退化成线性、报近似)。
 *
 * 求值时引擎在时间轴上解三次方程取 t,再算值 —— 和 Spine 的贝塞尔是同一条曲线。
 */

export const LINEAR = 0
export const CONSTANT = 1
export const CUBIC = 2

export const WEIGHT_NONE = 0
export const WEIGHT_LEFT = 1
export const WEIGHT_RIGHT = 2

/** ExtrapolationMode.CLAMP:两头保持端值(Spine 也是) */
const CLAMP = 1

/** dx 为 0 时方向竖直:atan(1e12) 已经是 π/2,cos 是 1e-12 量级 */
const VERTICAL = 1e12

export interface RealKey {
  readonly time: number
  readonly value: number
  readonly mode: number
  readonly leftTangent: number
  readonly leftWeight: number
  readonly rightTangent: number
  readonly rightWeight: number
  readonly weightMode: number
}

export type Segment = { readonly curve: 'linear' } | { readonly curve: 'stepped' } | { readonly curve: 'bezier'; readonly c: readonly [number, number, number, number] }

/**
 * 一个分量的关键帧 → Cocos 关键帧。`segments[i]` 是第 i 帧到第 i+1 帧的曲线,贝塞尔控制点是**绝对**的时间 / 值
 * (3.8 的归一化控制点先用 toAbsoluteBezier 换过来)。
 */
export function realKeys(times: readonly number[], values: readonly number[], segments: readonly (Segment | undefined)[]): RealKey[] {
  const keys: { time: number; value: number; mode: number; leftTangent: number; leftWeight: number; rightTangent: number; rightWeight: number; weightMode: number }[] = times.map((time, i) => ({
    time, value: values[i]!, mode: LINEAR, leftTangent: 0, leftWeight: 0, rightTangent: 0, rightWeight: 0, weightMode: WEIGHT_NONE,
  }))
  for (let i = 0; i + 1 < keys.length; i++) {
    const k0 = keys[i]!
    const k1 = keys[i + 1]!
    const segment = segments[i]
    if (segment === undefined || segment.curve === 'linear') continue
    if (segment.curve === 'stepped') {
      k0.mode = CONSTANT
      continue
    }
    const [cx1, cy1, cx2, cy2] = segment.c
    const dx1 = Math.max(0, cx1 - k0.time)
    const dy1 = cy1 - k0.value
    const dx2 = Math.max(0, k1.time - cx2)
    const dy2 = k1.value - cy2
    k0.mode = CUBIC
    k0.rightTangent = dx1 > 1e-9 ? dy1 / dx1 : Math.sign(dy1) * VERTICAL
    k0.rightWeight = Math.hypot(dx1, dy1)
    k0.weightMode |= WEIGHT_RIGHT
    k1.leftTangent = dx2 > 1e-9 ? dy2 / dx2 : Math.sign(dy2) * VERTICAL
    k1.leftWeight = Math.hypot(dx2, dy2)
    k1.weightMode |= WEIGHT_LEFT
  }
  return keys
}

/** 值轨道写成 JSON(`cc.RealCurve`)。空曲线也合法 —— VectorTrack 里没动的分量就是空的 */
export function realCurveJson(keys: readonly RealKey[]): Record<string, unknown> {
  return {
    __type__: 'cc.RealCurve',
    _times: keys.map((k) => r(k.time)),
    _values: keys.map((k) => ({
      __type__: 'cc.RealKeyframeValue',
      interpolationMode: k.mode,
      tangentWeightMode: k.weightMode,
      value: r(k.value),
      rightTangent: r(k.rightTangent),
      rightTangentWeight: r(k.rightWeight),
      leftTangent: r(k.leftTangent),
      leftTangentWeight: r(k.leftWeight),
      easingMethod: 0,
    })),
    preExtrapolation: CLAMP,
    postExtrapolation: CLAMP,
  }
}

/** 读回 JSON 里的 `cc.RealCurve`(端到端测试用) */
export function parseRealCurve(json: Record<string, unknown>): RealKey[] {
  const times = json['_times'] as number[]
  const values = json['_values'] as Record<string, number>[]
  return times.map((time, i) => {
    const v = values[i]!
    return {
      time,
      value: v['value'] ?? 0,
      mode: v['interpolationMode'] ?? LINEAR,
      leftTangent: v['leftTangent'] ?? 0,
      leftWeight: v['leftTangentWeight'] ?? 0,
      rightTangent: v['rightTangent'] ?? 0,
      rightWeight: v['rightTangentWeight'] ?? 0,
      weightMode: v['tangentWeightMode'] ?? WEIGHT_NONE,
    }
  })
}

// ─── 按引擎的规则求值(照 cocos/core/curves/curve.ts 移植,端到端测试用) ─────────────

/** 引擎的 binarySearchEpsilon:差 1e-6 以内算同一时刻 */
function searchKeyframe(times: readonly number[], time: number): number {
  let low = 0
  let high = times.length - 1
  let middle = high >>> 1
  for (; low <= high; middle = (low + high) >>> 1) {
    const test = times[middle]!
    if (test > time + 1e-6) high = middle - 1
    else if (test < time - 1e-6) low = middle + 1
    else return middle
  }
  return ~low
}

export function evaluateRealCurve(keys: readonly RealKey[], time: number): number {
  const n = keys.length
  if (n === 0) return 0
  if (time < keys[0]!.time) return keys[0]!.value
  if (time > keys[n - 1]!.time) return keys[n - 1]!.value
  const index = searchKeyframe(keys.map((k) => k.time), time)
  if (index >= 0) return keys[index]!.value
  const next = ~index
  const k0 = keys[next - 1]!
  const k1 = keys[next]!
  const dt = k1.time - k0.time
  const ratio = (time - k0.time) / dt
  switch (k0.mode) {
    case LINEAR:
      return k0.value + (k1.value - k0.value) * ratio
    case CUBIC: {
      const ONE_THIRD = 1 / 3
      const rightWeighted = (k0.weightMode & WEIGHT_RIGHT) !== 0
      const leftWeighted = (k1.weightMode & WEIGHT_LEFT) !== 0
      if (!rightWeighted && !leftWeighted) {
        const p1 = k0.value + ONE_THIRD * k0.rightTangent * dt
        const p2 = k1.value - ONE_THIRD * k1.leftTangent * dt
        return bezier(k0.value, p1, p2, k1.value, ratio)
      }
      const w0 = rightWeighted ? k0.rightWeight : Math.hypot(dt, dt * k0.rightTangent) * ONE_THIRD
      const angle0 = Math.atan(k0.rightTangent)
      const tx0 = Math.cos(angle0) * w0 + k0.time
      const ty0 = Math.sin(angle0) * w0 + k0.value
      const w1 = leftWeighted ? k1.leftWeight : Math.hypot(dt, dt * k1.leftTangent) * ONE_THIRD
      const angle1 = Math.atan(k1.leftTangent)
      const tx1 = -Math.cos(angle1) * w1 + k1.time
      const ty1 = -Math.sin(angle1) * w1 + k1.value
      const u0x = (tx0 - k0.time) / dt
      const u1x = (tx1 - k0.time) / dt
      const coeff1 = 3 * u0x
      const coeff2 = 3 * u1x - 6 * u0x
      const coeff3 = 3 * (u0x - u1x) + 1
      const solutions: [number, number, number] = [0, 0, 0]
      const count = solveCubic(-ratio, coeff1, coeff2, coeff3, solutions)
      const param = paramFromSolutions(solutions, count)
      return bezier(k0.value, ty0, ty1, k1.value, param)
    }
    default:
      return k0.value
  }
}

function bezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}

const EQN_EPS = 1e-9
const isZero = (x: number) => x > -EQN_EPS && x < EQN_EPS

/** 引擎的 solveCubic(Cardano),系数按 c0 + c1·t + c2·t² + c3·t³ */
function solveCubic(c0: number, c1: number, c2: number, c3: number, out: [number, number, number]): number {
  const a = c2 / c3
  const b = c1 / c3
  const c = c0 / c3
  const sqrA = a * a
  const p = (1 / 3) * ((-1 / 3) * sqrA + b)
  const q = (1 / 2) * ((2 / 27) * a * sqrA - (1 / 3) * a * b + c)
  const cubicP = p * p * p
  const d = q * q + cubicP
  let n = 0
  if (isZero(d)) {
    if (isZero(q)) {
      out[0] = 0
      return 1
    }
    const u = Math.cbrt(-q)
    out[0] = 2 * u
    out[1] = -u
    n = 2
  } else if (d < 0) {
    const phi = (1 / 3) * Math.acos(-q / Math.sqrt(-cubicP))
    const t = 2 * Math.sqrt(-p)
    out[0] = t * Math.cos(phi)
    out[1] = -t * Math.cos(phi + Math.PI / 3)
    out[2] = -t * Math.cos(phi - Math.PI / 3)
    n = 3
  } else {
    const sqrtD = Math.sqrt(d)
    out[0] = Math.cbrt(sqrtD - q) - Math.cbrt(sqrtD + q)
    n = 1
  }
  const sub = (1 / 3) * a
  for (let i = 0; i < n; i++) out[i] = out[i]! - sub
  return n
}

function paramFromSolutions(solutions: readonly [number, number, number], count: number): number {
  if (count === 1) return solutions[0]
  let param = -Infinity
  for (let i = 0; i < count; i++) {
    const s = solutions[i]!
    if (s >= 0 && s <= 1 && s > param) param = s
  }
  return param === -Infinity ? 0 : param
}
