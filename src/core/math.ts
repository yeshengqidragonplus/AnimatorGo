/**
 * 2D 仿射变换。
 *
 * 约定(见 docs/FORMAT.md,任何改动都要同步所有运行时):
 *   - Y 轴向上
 *   - 旋转逆时针为正,单位:度
 *   - 列主序、列向量(M * v)
 *   - 变换顺序 T * R * S
 *
 * 存储为 6 元组 [a, b, c, d, tx, ty],代表:
 *
 *     | a  c  tx |
 *     | b  d  ty |
 *     | 0  0  1  |
 *
 * 刻意不依赖 gl-matrix —— core/ 要能逐行翻译成 C# / GDScript,
 * 自己的 60 行比第三方库调用好移植。
 */

export type Mat2d = [a: number, b: number, c: number, d: number, tx: number, ty: number]

export const DEG_TO_RAD = Math.PI / 180
export const RAD_TO_DEG = 180 / Math.PI

export function cosDeg(deg: number): number {
  return Math.cos(deg * DEG_TO_RAD)
}

export function sinDeg(deg: number): number {
  return Math.sin(deg * DEG_TO_RAD)
}

export function identity(): Mat2d {
  return [1, 0, 0, 1, 0, 0]
}

/**
 * 由 TRS(+ 错切)构造局部变换矩阵。
 *
 * 错切的处理方式:把 shear 加进各自轴的角度。shearX = shearY = 0 时
 * 退化为标准的 T * R * S。
 */
export function fromTRS(
  out: Mat2d,
  x: number,
  y: number,
  rotation: number,
  scaleX: number,
  scaleY: number,
  shearX = 0,
  shearY = 0,
): Mat2d {
  out[0] = cosDeg(rotation + shearX) * scaleX
  out[1] = sinDeg(rotation + shearX) * scaleX
  out[2] = cosDeg(rotation + 90 + shearY) * scaleY
  out[3] = sinDeg(rotation + 90 + shearY) * scaleY
  out[4] = x
  out[5] = y
  return out
}

/** out = a * b。世界变换用法:world = parent.world * local */
export function multiply(out: Mat2d, a: Mat2d, b: Mat2d): Mat2d {
  const a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3], a4 = a[4], a5 = a[5]
  const b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3], b4 = b[4], b5 = b[5]
  out[0] = a0 * b0 + a2 * b1
  out[1] = a1 * b0 + a3 * b1
  out[2] = a0 * b2 + a2 * b3
  out[3] = a1 * b2 + a3 * b3
  out[4] = a0 * b4 + a2 * b5 + a4
  out[5] = a1 * b4 + a3 * b5 + a5
  return out
}

/** 变换一个点(含平移) */
export function transformPoint(m: Mat2d, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

/** 变换一个方向向量(忽略平移) */
export function transformVector(m: Mat2d, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y, m[1] * x + m[3] * y]
}

/** 求逆。矩阵不可逆(行列式为 0)时返回 false,out 不变。 */
export function invert(out: Mat2d, m: Mat2d): boolean {
  const [a, b, c, d, tx, ty] = m
  const det = a * d - c * b
  if (det === 0) return false
  const invDet = 1 / det
  out[0] = d * invDet
  out[1] = -b * invDet
  out[2] = -c * invDet
  out[3] = a * invDet
  out[4] = (c * ty - d * tx) * invDet
  out[5] = (b * tx - a * ty) * invDet
  return true
}

/** 从矩阵中取出世界旋转角(度)。用于把世界空间的操作换算回局部旋转。 */
export function getRotation(m: Mat2d): number {
  return Math.atan2(m[1], m[0]) * RAD_TO_DEG
}

/**
 * 把角度差规范化到 (-180, 180]。
 *
 * 动画融合时旋转必须走最短路径:350° → 10° 要走 +20°,不能走 -340°。
 * 见 docs/FORMAT.md 第 5 节。
 */
export function shortestAngleDelta(from: number, to: number): number {
  let d = (to - from) % 360
  if (d > 180) d -= 360
  else if (d <= -180) d += 360
  return d
}
