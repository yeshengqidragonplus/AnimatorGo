/**
 * Unity 动画曲线 → Spine 4.x 的逐段贝塞尔。
 *
 * Unity 的关键帧是三次 Hermite:值 + 入 / 出切线斜率,可选带权(weightedMode)。一段 Hermite 就是一段三次贝塞尔,
 * 控制点(绝对时间 / 取值,正是 Spine 4.x 的写法,见 spine-format/bezier.ts)为:
 *
 * ```
 * cx1 = t0 + w_out0 · Δt     cy1 = v0 + outSlope0 · (cx1 − t0)
 * cx2 = t1 − w_in1  · Δt     cy2 = v1 − inSlope1  · (t1 − cx2)
 * ```
 *
 * 不带权时 w = 1/3。斜率为无穷大(Unity 的 Constant 切线)是阶梯。所以 Unity 曲线能**精确**变成 Spine 曲线。
 *
 * Spine 的一条时间轴里各分量共用关键帧时刻(rgba 四个通道一组),Unity 的颜色是四条独立曲线 ——
 * 对不齐时在对方的段内**精确细分**贝塞尔(de Casteljau),补出同一时刻的键。
 */

import type { YamlValue } from '../../unity/yaml.ts'
import { list, map, str } from '../../unity/yaml.ts'

export interface HermiteKey {
  readonly time: number
  readonly value: number
  readonly inSlope: number
  readonly outSlope: number
  /** 0 无 / 1 入 / 2 出 / 3 两边 */
  readonly weightedMode: number
  readonly inWeight: number
  readonly outWeight: number
}

/** Spine 的一段:从 key[i] 到 key[i+1] */
export type Segment =
  | { readonly kind: 'linear' }
  | { readonly kind: 'stepped' }
  /** 绝对控制点 [cx1, cy1, cx2, cy2] */
  | { readonly kind: 'bezier'; readonly c: readonly [number, number, number, number] }

export interface SpineKey {
  readonly time: number
  readonly value: number
  /** 到下一个键的那一段;最后一个键没有 */
  readonly segment?: Segment
}

/** Unity 的 YAML 里无穷大写作 `Infinity` / `-Infinity` */
function numInf(v: YamlValue | undefined, fallback = 0): number {
  const s = str(v)
  if (s === '') return fallback
  const n = Number(s)
  return Number.isNaN(n) ? fallback : n
}

/** 读一条 Unity 曲线(`m_Curve` 列表);`component` 用于 Vector3 曲线的 x / y / z */
export function readHermite(curve: YamlValue | undefined, component?: 'x' | 'y' | 'z' | 'w'): HermiteKey[] {
  return list(map(curve)['m_Curve']).map((k) => {
    const m = map(k)
    const pick = (v: YamlValue | undefined) => (component === undefined ? numInf(v) : numInf(map(v)[component]))
    return {
      time: numInf(m['time']),
      value: pick(m['value']),
      inSlope: pick(m['inSlope']),
      outSlope: pick(m['outSlope']),
      weightedMode: numInf(m['weightedMode']),
      inWeight: component === undefined ? numInf(m['inWeight'], 1 / 3) : numInf(map(m['inWeight'])[component], 1 / 3),
      outWeight: component === undefined ? numInf(m['outWeight'], 1 / 3) : numInf(map(m['outWeight'])[component], 1 / 3),
    }
  })
}

const LINEAR_EPS = 1e-6

/** Hermite 关键帧 → Spine 键(取值先过 transform:必须是仿射 slope·v + offset,控制点的 y 走同一个变换) */
export function toSpineKeys(keys: readonly HermiteKey[], transform: (v: number) => number = (v) => v): SpineKey[] {
  return keys.map((k, i) => {
    const next = keys[i + 1]
    const value = transform(k.value)
    if (next === undefined) return { time: k.time, value }
    const dt = next.time - k.time
    if (!Number.isFinite(k.outSlope) || !Number.isFinite(next.inSlope)) return { time: k.time, value, segment: { kind: 'stepped' } }
    const wOut = (k.weightedMode & 2) !== 0 ? k.outWeight : 1 / 3
    const wIn = (next.weightedMode & 1) !== 0 ? next.inWeight : 1 / 3
    const cx1 = k.time + wOut * dt
    const cx2 = next.time - wIn * dt
    const cy1 = k.value + k.outSlope * (cx1 - k.time)
    const cy2 = next.value - next.inSlope * (next.time - cx2)
    // 直线:控制点落在弦上且在三分点
    const chord = dt > 0 ? (next.value - k.value) / dt : 0
    const straight = Math.abs(wOut - 1 / 3) < LINEAR_EPS && Math.abs(wIn - 1 / 3) < LINEAR_EPS &&
      Math.abs(k.outSlope - chord) < LINEAR_EPS * (1 + Math.abs(chord)) && Math.abs(next.inSlope - chord) < LINEAR_EPS * (1 + Math.abs(chord))
    if (straight) return { time: k.time, value, segment: { kind: 'linear' } }
    return { time: k.time, value, segment: { kind: 'bezier', c: [cx1, transform(cy1), cx2, transform(cy2)] } }
  })
}

// ─── 求值与细分 ──────────────────────────────────────────────────────────────

function cubic(s: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - s
  return u * u * u * p0 + 3 * u * u * s * p1 + 3 * u * s * s * p2 + s * s * s * p3
}

function paramAt(t: number, x0: number, x1: number, x2: number, x3: number): number {
  let lo = 0
  let hi = 1
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (cubic(mid, x0, x1, x2, x3) < t) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** 键序列在 t 处的值(第一键之前取第一键,最后一键之后保持) */
export function valueAt(keys: readonly SpineKey[], t: number): number {
  if (keys.length === 0) return 0
  if (t <= keys[0]!.time) return keys[0]!.value
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i]!
    const b = keys[i + 1]!
    if (t >= b.time) continue
    const seg = a.segment ?? { kind: 'linear' }
    if (seg.kind === 'stepped') return a.value
    if (seg.kind === 'linear') return a.value + ((b.value - a.value) * (t - a.time)) / (b.time - a.time)
    const s = paramAt(t, a.time, seg.c[0], seg.c[2], b.time)
    return cubic(s, a.value, seg.c[1], seg.c[3], b.value)
  }
  return keys[keys.length - 1]!.value
}

/** 在 t 处精确切开(t 落在某段内部时补一个键,两半的贝塞尔用 de Casteljau 分出来) */
export function splitAt(keys: readonly SpineKey[], t: number): SpineKey[] {
  if (keys.some((k) => Math.abs(k.time - t) < 1e-9)) return [...keys]
  if (keys.length === 0) return []
  // 第一键之前 / 最后一键之后:Unity 保持端点的值 —— 补一个同值的键。段用直线(两端同值就是常数),
  // 与别的分量的贝塞尔混在一帧时仍然精确(阶梯混贝塞尔只能近似)
  if (t < keys[0]!.time) return [{ time: t, value: keys[0]!.value, segment: { kind: 'linear' } }, ...keys]
  const last = keys[keys.length - 1]!
  if (t > last.time) return [...keys.slice(0, -1), { ...last, segment: { kind: 'linear' } }, { time: t, value: last.value }]
  const out: SpineKey[] = []
  for (let i = 0; i < keys.length; i++) {
    const a = keys[i]!
    const b = keys[i + 1]
    if (b === undefined || t < a.time || t > b.time) {
      out.push(a)
      continue
    }
    const seg = a.segment ?? { kind: 'linear' }
    if (seg.kind !== 'bezier') {
      const v = valueAt([a, b], t)
      out.push({ time: a.time, value: a.value, segment: seg }, { time: t, value: v, segment: seg })
      continue
    }
    const s = paramAt(t, a.time, seg.c[0], seg.c[2], b.time)
    const lerp = (p: number, q: number) => p + (q - p) * s
    const x = [a.time, seg.c[0], seg.c[2], b.time]
    const y = [a.value, seg.c[1], seg.c[3], b.value]
    const split = (p: number[]) => {
      const p01 = lerp(p[0]!, p[1]!), p12 = lerp(p[1]!, p[2]!), p23 = lerp(p[2]!, p[3]!)
      const p012 = lerp(p01, p12), p123 = lerp(p12, p23)
      const mid = lerp(p012, p123)
      return { left: [p01, p012], mid, right: [p123, p23] }
    }
    const sx = split(x)
    const sy = split(y)
    out.push({ time: a.time, value: a.value, segment: { kind: 'bezier', c: [sx.left[0]!, sy.left[0]!, sx.left[1]!, sy.left[1]!] } })
    out.push({ time: t, value: sy.mid, segment: { kind: 'bezier', c: [sx.right[0]!, sy.right[0]!, sx.right[1]!, sy.right[1]!] } })
  }
  return out
}

/** 几条曲线补齐到同一组关键帧时刻 */
export function align(curves: readonly (readonly SpineKey[])[]): SpineKey[][] {
  const times = [...new Set(curves.flatMap((c) => c.map((k) => k.time)))].sort((a, b) => a - b)
  return curves.map((c) => {
    let out = [...c]
    for (const t of times) out = splitAt(out, t)
    return out.sort((a, b) => a.time - b.time)
  })
}

/**
 * Spine 4.x JSON 一帧的 `curve` 字段。⚠️ 4.x 的一帧**只有一个曲线类型**,各分量共用(贝塞尔时每分量各一组控制点):
 * 全是直线 → 省略;全是阶梯 → "stepped";否则贝塞尔,直线分量写成弦上三分点。
 * 阶梯和非阶梯混在同一帧表达不了,阶梯分量用「控制点都压到段尾」的贝塞尔近似,`approximated` 置真。
 */
export function frameCurve(parts: readonly { readonly a: SpineKey; readonly b: SpineKey }[]): { curve: unknown; approximated: boolean } {
  const kinds = parts.map((p) => p.a.segment?.kind ?? 'linear')
  if (kinds.every((k) => k === 'linear')) return { curve: undefined, approximated: false }
  if (kinds.every((k) => k === 'stepped')) return { curve: 'stepped', approximated: false }
  let approximated = false
  const out: number[] = []
  for (const { a, b } of parts) {
    const seg = a.segment ?? { kind: 'linear' }
    const dt = b.time - a.time
    if (seg.kind === 'bezier') out.push(...seg.c)
    else if (seg.kind === 'linear') out.push(a.time + dt / 3, a.value + (b.value - a.value) / 3, a.time + (2 * dt) / 3, a.value + (2 * (b.value - a.value)) / 3)
    else {
      approximated = true
      out.push(b.time, a.value, b.time, a.value)
    }
  }
  return { curve: out, approximated }
}
