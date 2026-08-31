import { describe, expect, it } from 'vitest'
import { blankImage, decodePng, encodePng } from './png.ts'
import { encodeIndices } from './writeMeta.ts'
import { internalId, unityGuid, uniqueIds } from './ids.ts'

/** 造一张有梯度、有透明区、有硬边的图 —— 五种扫描线滤波都能踩到 */
function sample(width: number, height: number) {
  const image = blankImage(width, height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      image.data[i] = (x * 7) & 0xff
      image.data[i + 1] = (y * 13) & 0xff
      image.data[i + 2] = x > width / 2 ? 255 : 0
      image.data[i + 3] = y < 2 ? 0 : 255
    }
  }
  return image
}

describe('PNG 编解码', () => {
  it('往返逐像素相同', () => {
    const original = sample(37, 23)
    const back = decodePng(encodePng(original))
    expect(back.width).toBe(37)
    expect(back.height).toBe(23)
    expect([...back.data]).toEqual([...original.data])
  })

  it('压缩比全 None 滤波好 —— 说明逐行选滤波真的生效了', () => {
    const image = sample(256, 256)
    // 一张 256×256 的渐变图,选对滤波之后应该远小于原始字节数
    expect(encodePng(image).length).toBeLessThan(image.data.length / 4)
  })

  it('不是 PNG 就报错,不静默返回空图', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/不是 PNG/)
  })
})

describe('Unity 标识符', () => {
  it('同一个种子永远得到同一个 ID —— 重新导出不能断引用', () => {
    expect(unityGuid('MX2_cat/texture/0')).toBe(unityGuid('MX2_cat/texture/0'))
    expect(internalId('MX2_cat/sprite/head')).toBe(internalId('MX2_cat/sprite/head'))
  })

  it('GUID 是 32 位十六进制', () => {
    expect(unityGuid('x')).toMatch(/^[0-9a-f]{32}$/)
  })

  it('internalID 不为 0(Unity 用 0 表示空引用)', () => {
    for (let i = 0; i < 500; i++) expect(internalId(`sprite/${i}`)).not.toBe(0)
  })

  it('uniqueIds 撞了会自动错开', () => {
    // 强行让所有种子映射到同一个值,看它是否还能给出互不相同的结果
    let calls = 0
    const ids = uniqueIds(['a', 'b', 'c'], (seed) => (seed.includes('#') ? ++calls : 1))
    expect(new Set(ids.values()).size).toBe(3)
  })
})

describe('.meta 的三角形下标', () => {
  it('每个下标一个小端 uint32', () => {
    // 与真实样本对照:三角形 (0, 3, 1)
    expect(encodeIndices([0, 3, 1])).toBe('000000000300000001000000')
  })

  it('空网格给空串', () => {
    expect(encodeIndices([])).toBe('')
  })
})
