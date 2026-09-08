import type { BoneRecord, SkeletonPart } from '../spine-format/binary/readSkeleton.ts'
import type { AnimationData, Timeline } from '../spine-format/binary/readAnimations.ts'

/**
 * Spine 骨架的姿势求值:(骨架, 动画, 时间) → 每根骨骼的世界矩阵。
 *
 * 纯数学,不依赖任何渲染 API。Unity 出口用它把 deform 反解成 Blend Shape 增量,
 * 以后 VAT 出口也吃它。
 *
 * ## 范围
 *
 * - 骨骼时间轴:rotate / translate / scale / shear,以及 4.x 拆开的 X / Y 单分量版
 * - 曲线:线性、阶梯、贝塞尔。**3.8 的控制点是归一化的,4.x 是绝对的**,两套都认
 * - 继承模式:默认与 onlyTranslation。其余三种(noRotationOrReflection / noScale /
 *   noScaleOrReflection)按默认算 —— 导出器已经对这些骨骼报了 approximated
 * - **不做约束**:IK / transform / path 一律不应用。调用方要知道这一点
 *
 * ## 时间轴语义(见 docs/FORMAT.md)
 *
 * 关键帧值是**相对绑定姿势的偏移**:rotate / translate / shear 是加,scale 是乘。
 * 第一帧之前用绑定姿势的值,最后一帧之后保持最后一帧。
 */

/** 二维仿射:world = [a b; c d] · local + (x, y)。与 Spine 的骨骼世界矩阵同构 */
export interface Affine {
  readonly a: number
  readonly b: number
  readonly c: number
  readonly d: number
  readonly x: number
  readonly y: number
}

export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 }

export function applyPoint(m: Affine, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.b * y + m.x, y: m.c * x + m.d * y + m.y }
}

/** 只用线性部分 —— 变换的是位移向量,不带平移 */
export function applyVector(m: Affine, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.b * y, y: m.c * x + m.d * y }
}

/** p ∘ q:先 q 再 p */
export function multiply(p: Affine, q: Affine): Affine {
  return {
    a: p.a * q.a + p.b * q.c,
    b: p.a * q.b + p.b * q.d,
    c: p.c * q.a + p.d * q.c,
    d: p.c * q.b + p.d * q.d,
    x: p.a * q.x + p.b * q.y + p.x,
    y: p.c * q.x + p.d * q.y + p.y,
  }
}

export function determinant(m: Affine): number {
  return m.a * m.d - m.b * m.c
}

/** 逆变换;退化(行列式≈0)返回 null */
export function invert(m: Affine): Affine | null {
  const det = determinant(m)
  if (Math.abs(det) < 1e-12) return null
  const a = m.d / det
  const b = -m.b / det
  const c = -m.c / det
  const d = m.a / det
  return { a, b, c, d, x: -(a * m.x + b * m.y), y: -(c * m.x + d * m.y) }
}

/** 一根骨骼的局部值(绑定姿势 + 时间轴偏移之后) */
export interface BoneLocal {
  readonly x: number
  readonly y: number
  readonly rotation: number
  readonly scaleX: number
  readonly scaleY: number
  readonly shearX: number
  readonly shearY: number
}

const DEG = Math.PI / 180

/** Spine 的继承模式(BoneData.transformMode) */
const MODE_NORMAL = 0
const MODE_ONLY_TRANSLATION = 1

export interface PoseOptions {
  /**
   * 按 Unity 的 Transform 层级来算:忽略 shear、所有骨骼按默认继承。
   *
   * Unity 的节点只有 TRS,表达不了 shear 和非默认继承;导出的 prefab 就是这么摆的。
   * 要算「Unity 那边实际会得到的姿势」时开这个,算「Spine 真正的姿势」时关。
   */
  readonly unityCompatible?: boolean
}

/**
 * 由每根骨骼的局部值算世界矩阵。`bones` 必须父在子之前(Spine 的文件顺序保证这点)。
 */
export function worldTransforms(
  bones: readonly BoneRecord[],
  locals: readonly BoneLocal[],
  options: PoseOptions = {},
): Affine[] {
  const unity = options.unityCompatible === true
  const out: Affine[] = []
  bones.forEach((bone, i) => {
    const l = locals[i]!
    const shearX = unity ? 0 : l.shearX
    const shearY = unity ? 0 : l.shearY
    const rotationY = l.rotation + 90 + shearY
    const la = Math.cos(DEG * (l.rotation + shearX)) * l.scaleX
    const lb = Math.cos(DEG * rotationY) * l.scaleY
    const lc = Math.sin(DEG * (l.rotation + shearX)) * l.scaleX
    const ld = Math.sin(DEG * rotationY) * l.scaleY

    const parent = bone.parent < 0 ? null : out[bone.parent]
    if (parent === null || parent === undefined) {
      out.push({ a: la, b: lb, c: lc, d: ld, x: l.x, y: l.y })
      return
    }

    const mode = unity ? MODE_NORMAL : bone.transformMode
    const x = parent.a * l.x + parent.b * l.y + parent.x
    const y = parent.c * l.x + parent.d * l.y + parent.y
    if (mode === MODE_ONLY_TRANSLATION) {
      // 只继承位置,自己的旋转/缩放/斜切直接就是世界值
      out.push({ a: la, b: lb, c: lc, d: ld, x, y })
      return
    }
    out.push({
      a: parent.a * la + parent.b * lc,
      b: parent.a * lb + parent.b * ld,
      c: parent.c * la + parent.d * lc,
      d: parent.c * lb + parent.d * ld,
      x,
      y,
    })
  })
  return out
}

export function setupLocals(bones: readonly BoneRecord[]): BoneLocal[] {
  return bones.map((b) => ({
    x: b.x,
    y: b.y,
    rotation: b.rotation,
    scaleX: b.scaleX,
    scaleY: b.scaleY,
    shearX: b.shearX,
    shearY: b.shearY,
  }))
}

export function setupPose(part: SkeletonPart, options: PoseOptions = {}): Affine[] {
  return worldTransforms(part.bones, setupLocals(part.bones), options)
}

// ─── 曲线 ────────────────────────────────────────────────────────────────────

type Frame = Record<string, unknown>

/** 一维三次贝塞尔 */
function cubic(s: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - s
  return u * u * u * p0 + 3 * u * u * s * p1 + 3 * u * s * s * p2 + s * s * s * p3
}

/** 解 x(s) = target 的参数 s。x 单调,二分即可 */
function solveParam(target: number, x0: number, cx1: number, cx2: number, x3: number): number {
  let lo = 0
  let hi = 1
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2
    if (cubic(mid, x0, cx1, cx2, x3) < target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * 帧 i → i+1 之间,时间 t 处某个分量的值。
 *
 * `component` 是该值在时间轴里的分量下标(translate 的 y 是 1)。
 * 3.8 所有分量共用一条归一化曲线;4.x 每个分量一条绝对曲线。
 */
export function valueBetween(
  frames: readonly Frame[],
  i: number,
  name: string,
  t: number,
  is38: boolean,
  component = 0,
): number {
  const f0 = frames[i]!
  const f1 = frames[i + 1]!
  const t0 = Number(f0['time'])
  const t1 = Number(f1['time'])
  const v0 = Number(f0[name])
  const v1 = Number(f1[name])
  if (t1 <= t0) return v1

  const curve = f0['curve']
  if (curve === 'stepped') return v0
  if (curve !== 'bezier') return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0)

  const all = f0['beziers'] as number[][]
  const b = all[Math.min(component, all.length - 1)]!
  if (is38) {
    // 归一化:x、y 都在 0..1
    const p = (t - t0) / (t1 - t0)
    const s = solveParam(p, 0, b[0]!, b[2]!, 1)
    const y = cubic(s, 0, b[1]!, b[3]!, 1)
    return v0 + (v1 - v0) * y
  }
  // 绝对:控制点直接是 (时间, 取值)
  const s = solveParam(t, t0, b[0]!, b[2]!, t1)
  return cubic(s, v0, b[1]!, b[3]!, v1)
}

/**
 * 时间轴在 t 处的取值。第一帧之前返回 null(调用方用绑定姿势),最后一帧之后保持。
 */
export function timelineValue(
  frames: readonly Frame[],
  name: string,
  t: number,
  is38: boolean,
  component = 0,
): number | null {
  if (frames.length === 0) return null
  if (t < Number(frames[0]!['time'])) return null
  for (let i = 0; i < frames.length - 1; i++) {
    if (t < Number(frames[i + 1]!['time'])) return valueBetween(frames, i, name, t, is38, component)
  }
  return Number(frames[frames.length - 1]![name])
}

// ─── 姿势 ────────────────────────────────────────────────────────────────────

const BONE_TIMELINES = new Set([
  'rotate',
  'translate',
  'translateX',
  'translateY',
  'scale',
  'scaleX',
  'scaleY',
  'shear',
  'shearX',
  'shearY',
])

export function isBoneTimeline(t: Timeline): boolean {
  return BONE_TIMELINES.has(t.kind)
}

/** 动画在时间 t 时每根骨骼的局部值(绑定姿势叠上时间轴) */
export function localsAt(part: SkeletonPart, animation: AnimationData, time: number): BoneLocal[] {
  const is38 = part.header.major === '3.8'
  const locals = setupLocals(part.bones).map((l) => ({ ...l }))

  for (const t of animation.timelines) {
    if (!BONE_TIMELINES.has(t.kind)) continue
    const l = locals[t.owner]
    if (l === undefined) continue
    const v = (name: string, component = 0) => timelineValue(t.frames, name, time, is38, component)

    switch (t.kind) {
      case 'rotate': {
        const r = v('value')
        if (r !== null) l.rotation += r
        break
      }
      case 'translate': {
        const x = v('x', 0)
        const y = v('y', 1)
        if (x !== null) l.x += x
        if (y !== null) l.y += y
        break
      }
      case 'translateX': {
        const x = v('value')
        if (x !== null) l.x += x
        break
      }
      case 'translateY': {
        const y = v('value')
        if (y !== null) l.y += y
        break
      }
      case 'scale': {
        const x = v('x', 0)
        const y = v('y', 1)
        if (x !== null) l.scaleX *= x
        if (y !== null) l.scaleY *= y
        break
      }
      case 'scaleX': {
        const x = v('value')
        if (x !== null) l.scaleX *= x
        break
      }
      case 'scaleY': {
        const y = v('value')
        if (y !== null) l.scaleY *= y
        break
      }
      case 'shear': {
        const x = v('x', 0)
        const y = v('y', 1)
        if (x !== null) l.shearX += x
        if (y !== null) l.shearY += y
        break
      }
      case 'shearX': {
        const x = v('value')
        if (x !== null) l.shearX += x
        break
      }
      case 'shearY': {
        const y = v('value')
        if (y !== null) l.shearY += y
        break
      }
    }
  }
  return locals
}

/** 动画在时间 t 时每根骨骼的世界矩阵(骨架单位,像素) */
export function poseAt(
  part: SkeletonPart,
  animation: AnimationData,
  time: number,
  options: PoseOptions = {},
): Affine[] {
  return worldTransforms(part.bones, localsAt(part, animation, time), options)
}
