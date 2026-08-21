import { shortestAngleDelta } from './math.ts'
import type { Skeleton } from './Skeleton.ts'

/**
 * 动画求值。对应 docs/FORMAT.md 第 4 节。
 *
 * ⚠️ **关键帧值是相对绑定姿势的偏移,不是绝对值。**
 *   translate / rotate / shear:绑定姿势 + 关键帧值
 *   scale:                      绑定姿势 × 关键帧值
 *
 * apply() 每次都从 bone.data(绑定姿势)重新算起,所以是幂等的 ——
 * 不需要先调 setToSetupPose()。
 */

// ─── 曲线 ────────────────────────────────────────────────────────────────────

/** 'stepped' 保持前值;数组是三次贝塞尔的两个控制点 [cx1, cy1, cx2, cy2] */
export type Curve = 'linear' | 'stepped' | readonly [number, number, number, number]

const NEWTON_ITERATIONS = 8
const SUBDIVISION_EPSILON = 1e-7

function bezierAxis(t: number, c1: number, c2: number): number {
  const mt = 1 - t
  return 3 * mt * mt * t * c1 + 3 * mt * t * t * c2 + t * t * t
}

function bezierAxisDerivative(t: number, c1: number, c2: number): number {
  const mt = 1 - t
  return 3 * mt * mt * c1 + 6 * mt * t * (c2 - c1) + 3 * t * t * (1 - c2)
}

/**
 * 三次贝塞尔缓动。曲线固定过 (0,0) 和 (1,1),只有两个控制点可调。
 *
 * 需要按 x 反解 t,再取该 t 处的 y。用牛顿迭代,导数太小时退化为二分。
 */
function easeBezier(percent: number, curve: readonly [number, number, number, number]): number {
  const [cx1, cy1, cx2, cy2] = curve

  let t = percent
  for (let i = 0; i < NEWTON_ITERATIONS; i++) {
    const x = bezierAxis(t, cx1, cx2) - percent
    if (Math.abs(x) < SUBDIVISION_EPSILON) return bezierAxis(t, cy1, cy2)

    const d = bezierAxisDerivative(t, cx1, cx2)
    if (Math.abs(d) < SUBDIVISION_EPSILON) break
    t -= x / d
  }

  // 牛顿法没收敛(控制点让曲线过于水平),退回二分
  let lo = 0
  let hi = 1
  t = percent
  for (let i = 0; i < 20; i++) {
    const x = bezierAxis(t, cx1, cx2)
    if (Math.abs(x - percent) < SUBDIVISION_EPSILON) break
    if (x < percent) lo = t
    else hi = t
    t = (lo + hi) / 2
  }
  return bezierAxis(t, cy1, cy2)
}

function ease(percent: number, curve: Curve | undefined): number {
  if (curve === undefined || curve === 'linear') return percent
  if (curve === 'stepped') return 0
  return easeBezier(percent, curve)
}

// ─── 关键帧 ──────────────────────────────────────────────────────────────────

export interface Keyframe {
  readonly time: number
  readonly curve?: Curve
}

export interface RotateKey extends Keyframe {
  readonly value: number
}

export interface Vec2Key extends Keyframe {
  readonly x: number
  readonly y: number
}

export interface BoneTimelines {
  readonly rotate?: readonly RotateKey[]
  readonly translate?: readonly Vec2Key[]
  readonly scale?: readonly Vec2Key[]
  readonly shear?: readonly Vec2Key[]
}

export interface AnimationData {
  readonly name: string
  readonly duration: number
  /** 骨骼名 → 该骨骼的各条时间轴 */
  readonly bones: ReadonlyMap<string, BoneTimelines>
}

// ─── 求值 ────────────────────────────────────────────────────────────────────

/**
 * 找到最后一个 time <= t 的关键帧下标。全都在 t 之后返回 -1。
 * 二分查找 —— 关键帧多起来之后线性扫会成为热点。
 */
function searchKeyframe(keys: readonly Keyframe[], t: number): number {
  let lo = 0
  let hi = keys.length - 1
  let result = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (keys[mid]!.time <= t) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}

/** 返回 [前一帧下标, 到后一帧的缓动百分比]。百分比为 0 表示直接取前一帧的值。 */
function frameAndPercent(keys: readonly Keyframe[], t: number): [number, number] {
  const i = searchKeyframe(keys, t)
  if (i < 0) return [0, 0] // t 在第一帧之前 —— 保持第一帧
  if (i >= keys.length - 1) return [keys.length - 1, 0] // 最后一帧之后 —— 保持末值

  const k0 = keys[i]!
  const k1 = keys[i + 1]!
  const span = k1.time - k0.time
  const percent = span <= 0 ? 0 : (t - k0.time) / span
  return [i, ease(percent, k0.curve)]
}

function evalRotate(keys: readonly RotateKey[], t: number): number {
  const [i, percent] = frameAndPercent(keys, t)
  const k0 = keys[i]!
  if (percent === 0) return k0.value

  // 关键帧之间也走最短路径:350° → 10° 是 +20°,不是 -340°。
  // 需要整圈旋转时请打中间帧。见 docs/FORMAT.md 第 4 节。
  return k0.value + shortestAngleDelta(k0.value, keys[i + 1]!.value) * percent
}

function evalVec2(keys: readonly Vec2Key[], t: number): [number, number] {
  const [i, percent] = frameAndPercent(keys, t)
  const k0 = keys[i]!
  if (percent === 0) return [k0.x, k0.y]

  const k1 = keys[i + 1]!
  return [k0.x + (k1.x - k0.x) * percent, k0.y + (k1.y - k0.y) * percent]
}

/**
 * 把动画在时刻 t 的姿势写进骨架。**不会**自动更新世界变换 ——
 * 调用方接着调 skeleton.updateWorldTransform()。
 *
 * 没有时间轴的骨骼保持绑定姿势。注意这不等于「值为 0」——
 * 动画融合时这个区别是关键,见 docs/FORMAT.md 第 5 节。
 */
export function applyAnimation(skeleton: Skeleton, animation: AnimationData, time: number): void {
  for (const bone of skeleton.bones) {
    const timelines = animation.bones.get(bone.data.name)
    bone.setToSetupPose()
    if (timelines === undefined) continue

    if (timelines.rotate !== undefined && timelines.rotate.length > 0) {
      bone.rotation = bone.data.rotation + evalRotate(timelines.rotate, time)
    }
    if (timelines.translate !== undefined && timelines.translate.length > 0) {
      const [dx, dy] = evalVec2(timelines.translate, time)
      bone.x = bone.data.x + dx
      bone.y = bone.data.y + dy
    }
    if (timelines.scale !== undefined && timelines.scale.length > 0) {
      const [sx, sy] = evalVec2(timelines.scale, time)
      bone.scaleX = bone.data.scaleX * sx // scale 是乘不是加
      bone.scaleY = bone.data.scaleY * sy
    }
    if (timelines.shear !== undefined && timelines.shear.length > 0) {
      const [shx, shy] = evalVec2(timelines.shear, time)
      bone.shearX = bone.data.shearX + shx
      bone.shearY = bone.data.shearY + shy
    }
  }
}

/**
 * 取某根骨骼在时刻 t 的旋转**偏移量**(相对绑定姿势)。没有时间轴时返回 0。
 *
 * 给 UI 显示用 —— 不需要为了读一个数字就建一整个 Skeleton 实例。
 */
export function sampleRotation(
  animation: AnimationData,
  boneName: string,
  time: number,
): number {
  const keys = animation.bones.get(boneName)?.rotate
  return keys === undefined || keys.length === 0 ? 0 : evalRotate(keys, time)
}

/**
 * 某根骨骼在时刻 t 的完整姿势**偏移**(相对绑定姿势)。
 *
 * 没有时间轴的通道返回单位值:rotate / translate / shear 为 0,scale 为 1。
 * 「最终值 = 绑定 + 偏移(scale 是 ×)」由调用方套用,见 docs/FORMAT.md 第 1 节。
 */
export interface BonePoseOffset {
  readonly rotation: number
  readonly x: number
  readonly y: number
  readonly scaleX: number
  readonly scaleY: number
  readonly shearX: number
  readonly shearY: number
}

export function samplePose(animation: AnimationData, boneName: string, time: number): BonePoseOffset {
  const timelines = animation.bones.get(boneName)
  const sample = (keys: readonly Vec2Key[] | undefined, unit: number): [number, number] =>
    keys === undefined || keys.length === 0 ? [unit, unit] : evalVec2(keys, time)

  const [x, y] = sample(timelines?.translate, 0)
  const [scaleX, scaleY] = sample(timelines?.scale, 1)
  const [shearX, shearY] = sample(timelines?.shear, 0)
  return {
    rotation: timelines?.rotate === undefined || timelines.rotate.length === 0 ? 0 : evalRotate(timelines.rotate, time),
    x, y, scaleX, scaleY, shearX, shearY,
  }
}

// ─── 编辑关键帧 ──────────────────────────────────────────────────────────────

/** 判定两个关键帧时间是否算同一帧。浮点时间不能用 === 比。 */
export const TIME_EPSILON = 1e-4

/**
 * 插入或替换一个关键帧,返回新数组(不修改原数组)。
 *
 * 同一时刻已有关键帧就替换,否则按时间插入到正确位置 ——
 * 关键帧数组必须始终有序,二分查找依赖这一点。
 */
export function putKeyframe<K extends Keyframe>(keys: readonly K[], key: K): K[] {
  const next = keys.slice()
  const i = next.findIndex((k) => Math.abs(k.time - key.time) < TIME_EPSILON)
  if (i >= 0) {
    next[i] = key
    return next
  }
  const insertAt = next.findIndex((k) => k.time > key.time)
  if (insertAt < 0) next.push(key)
  else next.splice(insertAt, 0, key)
  return next
}

export function removeKeyframe<K extends Keyframe>(keys: readonly K[], time: number): K[] {
  return keys.filter((k) => Math.abs(k.time - time) >= TIME_EPSILON)
}
