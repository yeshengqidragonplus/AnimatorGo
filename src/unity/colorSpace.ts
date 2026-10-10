/**
 * Unity 工程的色彩空间,以及顶点色要不要换算。
 *
 * ⚠️ **SpriteRenderer 的 `m_Color` 和 Mesh 的顶点色在线性工程里不是一个意思**(2026-10-10 实测,
 * `tools/unity/AnimatorGoProbeColor.cs`,Unity 6000.3 + URP):`m_Color` 当 sRGB,Unity 自己换成线性再交给着色器;
 * 顶点色原样交给着色器,等于被当成线性值。同一个 `808080`,SpriteRenderer 画出 `808080`,
 * SkinnedMeshRenderer 的顶点色画出 `bcbcbc`。alpha 两边都不换算。
 *
 * Spine 的颜色是 sRGB 的,所以走 SkinnedMeshRenderer 的网格把颜色烘进顶点色时,线性工程要先换成线性值。
 * Gamma 工程两边都不换算,原样写。
 */

export type ColorSpace = 'linear' | 'gamma'

/** `ProjectSettings/ProjectSettings.asset` 的 `m_ActiveColorSpace`:0 = Gamma,1 = Linear;读不到返回 null */
export function parseColorSpace(text: string): ColorSpace | null {
  const m = /^ {2}m_ActiveColorSpace: (\d+)/m.exec(text)
  if (m === null) return null
  return m[1] === '0' ? 'gamma' : m[1] === '1' ? 'linear' : null
}

/** sRGB 编码值 → 线性值(0..1,标准分段曲线,与 Unity 的 Mathf.GammaToLinearSpace 相同) */
export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

/** 线性值 → sRGB 编码值 */
export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

type Rgba = { r: number; g: number; b: number; a: number }

/** 要写进顶点色的值:线性工程 rgb 换成线性,alpha 不动 */
export function toVertexColor(c: Rgba, space: ColorSpace): Rgba {
  return space === 'linear' ? { r: srgbToLinear(c.r), g: srgbToLinear(c.g), b: srgbToLinear(c.b), a: c.a } : c
}

/** 读回来的顶点色 → 与 SpriteRenderer `m_Color` 同一个意思的 sRGB 颜色 */
export function fromVertexColor(c: Rgba, space: ColorSpace): Rgba {
  return space === 'linear' ? { r: linearToSrgb(c.r), g: linearToSrgb(c.g), b: linearToSrgb(c.b), a: c.a } : c
}
