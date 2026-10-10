import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fromVertexColor, linearToSrgb, parseColorSpace, srgbToLinear, toVertexColor } from './colorSpace.ts'

describe('工程色彩空间', () => {
  it('UnityAnimationGo 自己的 ProjectSettings.asset(Unity 6000.3 写的)是 Linear', () => {
    const text = readFileSync('UnityAnimationGo/ProjectSettings/ProjectSettings.asset', 'utf8')
    expect(parseColorSpace(text)).toBe('linear')
  })

  it('0 是 Gamma;CRLF 也能读;没有这个字段 / 不认识的值返回 null', () => {
    const settings = (value: string) => ['PlayerSettings:', '  m_StereoRenderingPath: 0', `  m_ActiveColorSpace: ${value}`, '  unsupportedMSAAFallback: 0'].join('\r\n')
    expect(parseColorSpace(settings('0'))).toBe('gamma')
    expect(parseColorSpace(settings('1'))).toBe('linear')
    expect(parseColorSpace(settings('2'))).toBeNull()
    expect(parseColorSpace('PlayerSettings:\n  companyName: x\n')).toBeNull()
  })

  it('sRGB 换算与 Unity 的 GammaToLinearSpace 一致,来回不变', () => {
    // Mathf.GammaToLinearSpace(0.5) = 0.21404114,(184/255) → 0.47932
    expect(srgbToLinear(0.5)).toBeCloseTo(0.21404114, 6)
    expect(srgbToLinear(184 / 255)).toBeCloseTo(0.47932, 5)
    expect(srgbToLinear(0)).toBe(0)
    expect(srgbToLinear(1)).toBeCloseTo(1, 12)
    for (let i = 0; i <= 255; i++) expect(linearToSrgb(srgbToLinear(i / 255))).toBeCloseTo(i / 255, 9)
  })

  it('顶点色:Linear 只换 rgb、alpha 不动,来回不变;Gamma 原样', () => {
    const c = { r: 0.5, g: 184 / 255, b: 0, a: 0.25 }
    const v = toVertexColor(c, 'linear')
    expect(v.r).toBeCloseTo(0.21404114, 6)
    expect(v.a).toBe(0.25)
    const back = fromVertexColor(v, 'linear')
    for (const k of ['r', 'g', 'b', 'a'] as const) expect(back[k]).toBeCloseTo(c[k], 9)
    expect(toVertexColor(c, 'gamma')).toEqual(c)
    expect(fromVertexColor(c, 'gamma')).toEqual(c)
  })
})
