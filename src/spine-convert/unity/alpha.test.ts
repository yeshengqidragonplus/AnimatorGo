import { describe, expect, it } from 'vitest'
import type { Image } from '../../unity/png.ts'
import { detectPremultiplied, unpremultiply } from './alpha.ts'

function image(pixels: readonly [number, number, number, number][]): Image {
  const data = new Uint8Array(pixels.length * 4)
  pixels.forEach((p, i) => data.set(p, i * 4))
  return { width: pixels.length, height: 1, data }
}

/** 一条直通 alpha 的红色渐变,以及它预乘后的样子 */
const straight: [number, number, number, number][] = []
const premultiplied: [number, number, number, number][] = []
for (let a = 1; a <= 254; a++) {
  straight.push([200, 40, 10, a])
  premultiplied.push([Math.round((200 * a) / 255), Math.round((40 * a) / 255), Math.round((10 * a) / 255), a])
}

describe('预乘 alpha', () => {
  it('预乘图:所有半透明像素的通道都不超过 alpha', () => {
    expect(detectPremultiplied(image(premultiplied))).toBe(true)
  })

  it('直通图:半透明的红色通道明显大于 alpha', () => {
    expect(detectPremultiplied(image(straight))).toBe(false)
  })

  it('半透明像素太少不下结论', () => {
    expect(detectPremultiplied(image(premultiplied.slice(0, 10)))).toBe(false)
  })

  it('还原:预乘 → 直通,与原直通图相差不超过量化误差', () => {
    const back = unpremultiply(image(premultiplied))
    for (let i = 0; i < premultiplied.length; i++) {
      const a = premultiplied[i]![3]
      // alpha 越小,预乘时丢的精度越多 —— 容差按 255/a 放
      const tol = Math.ceil(255 / a / 2) + 1
      expect(Math.abs(back.data[i * 4]! - 200)).toBeLessThanOrEqual(tol)
      expect(Math.abs(back.data[i * 4 + 1]! - 40)).toBeLessThanOrEqual(tol)
      expect(back.data[i * 4 + 3]).toBe(a)
    }
    // 还原后再检测就是直通了
    expect(detectPremultiplied(back)).toBe(false)
  })

  it('不透明与全透明像素原样/置零,不改原图', () => {
    const src = image([[10, 20, 30, 255], [99, 99, 99, 0]])
    const out = unpremultiply(src)
    expect([...out.data]).toEqual([10, 20, 30, 255, 0, 0, 0, 0])
    expect([...src.data]).toEqual([10, 20, 30, 255, 99, 99, 99, 0])
  })
})
