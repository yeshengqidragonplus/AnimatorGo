import { describe, expect, it } from 'vitest'
import { parseAtlas, regionUVs, trimmedSize } from './atlas.ts'

/** 4.x 写法 */
const NEW_FORMAT = `
character.png
size: 256, 128
filter: Linear, Linear
pma: false
head
  bounds: 2, 2, 40, 30
  offsets: 4, 6, 50, 44
arm
  bounds: 44, 2, 30, 20
  offsets: 0, 0, 20, 30
  rotate: 90
plain
  bounds: 76, 2, 10, 10
`.trim()

/** 3.8 及更早写法 */
const OLD_FORMAT = `
character.png
size: 256,128
format: RGBA8888
filter: Linear,Linear
repeat: none
head
  rotate: false
  xy: 2, 2
  size: 40, 30
  orig: 50, 44
  offset: 4, 6
  index: -1
arm
  rotate: true
  xy: 44, 2
  size: 30, 20
  orig: 20, 30
  offset: 0, 0
  index: -1
`.trim()

describe('图集解析', () => {
  it('读出页信息', () => {
    const atlas = parseAtlas(NEW_FORMAT)
    expect(atlas.pages).toHaveLength(1)
    expect(atlas.pages[0]).toMatchObject({ name: 'character.png', width: 256, height: 128 })
  })

  it('bounds 的宽高是图集里的占位尺寸,不是原始尺寸', () => {
    const r = parseAtlas(NEW_FORMAT).regions.get('head')!
    expect(r.packedWidth).toBe(40)
    expect(r.packedHeight).toBe(30)
    expect(r.originalWidth).toBe(50) // 来自 offsets 的后两个值
    expect(r.originalHeight).toBe(44)
  })

  it('offsets 的前两个值是从左边和下边裁掉的像素', () => {
    const r = parseAtlas(NEW_FORMAT).regions.get('head')!
    expect(r.offsetX).toBe(4)
    expect(r.offsetY).toBe(6)
  })

  it('rotate 为 90 时,摆正后的宽高要交换', () => {
    const r = parseAtlas(NEW_FORMAT).regions.get('arm')!
    expect(r.rotate).toBe(90)
    expect([r.packedWidth, r.packedHeight]).toEqual([30, 20]) // 图集里横躺着
    expect(trimmedSize(r)).toEqual([20, 30]) // 摆正后是竖的
  })

  it('未旋转时摆正尺寸就是占位尺寸', () => {
    const r = parseAtlas(NEW_FORMAT).regions.get('head')!
    expect(trimmedSize(r)).toEqual([40, 30])
  })

  it('没有 offsets 时,原始尺寸退化为摆正尺寸', () => {
    const r = parseAtlas(NEW_FORMAT).regions.get('plain')!
    expect(r.originalWidth).toBe(10)
    expect(r.originalHeight).toBe(10)
    expect(r.offsetX).toBe(0)
  })

  it('旧格式解析出和新格式相同的结果', () => {
    const oldA = parseAtlas(OLD_FORMAT)
    const newA = parseAtlas(NEW_FORMAT)

    for (const name of ['head', 'arm']) {
      const o = oldA.regions.get(name)!
      const n = newA.regions.get(name)!
      expect({ ...o }).toEqual({ ...n })
    }
  })

  it('旧格式的 rotate: true 等价于 90 度', () => {
    expect(parseAtlas(OLD_FORMAT).regions.get('arm')!.rotate).toBe(90)
    expect(parseAtlas(OLD_FORMAT).regions.get('head')!.rotate).toBe(0)
  })

  it('多页图集', () => {
    const atlas = parseAtlas(`
p1.png
size: 64, 64
a
  bounds: 0, 0, 8, 8

p2.png
size: 32, 32
b
  bounds: 1, 1, 4, 4
`.trim())

    expect(atlas.pages.map((p) => p.name)).toEqual(['p1.png', 'p2.png'])
    expect(atlas.regions.get('a')!.page).toBe('p1.png')
    expect(atlas.regions.get('b')!.page).toBe('p2.png')
    expect(atlas.regions.get('b')!.packedWidth).toBe(4)
  })

  it('CRLF 换行也能解析', () => {
    const atlas = parseAtlas('p.png\r\nsize: 16, 16\r\nr\r\n  bounds: 1, 2, 3, 4\r\n')
    expect(atlas.regions.get('r')).toMatchObject({ x: 1, y: 2, packedWidth: 3, packedHeight: 4 })
  })
})

describe('UV 计算', () => {
  const atlas = parseAtlas(NEW_FORMAT)
  const page = atlas.pages[0]!

  /** UV 数组 → [[u,v], ...] 便于断言 */
  const corners = (uvs: Float32Array): [number, number][] => {
    const out: [number, number][] = []
    for (let i = 0; i < uvs.length; i += 2) out.push([uvs[i]!, uvs[i + 1]!])
    return out
  }

  it('未旋转:四角按 左下→右下→右上→左上', () => {
    const c = corners(regionUVs(atlas.regions.get('head')!, page))
    const u0 = 2 / 256, u1 = 42 / 256, v0 = 2 / 128, v1 = 32 / 128

    expect(c[0]).toEqual([u0, v1]) // 左下
    expect(c[1]).toEqual([u1, v1]) // 右下
    expect(c[2]).toEqual([u1, v0]) // 右上
    expect(c[3]).toEqual([u0, v0]) // 左上
  })

  it('旋转 90 时四角错开一位,UV 被转正', () => {
    const c = corners(regionUVs(atlas.regions.get('arm')!, page))
    const u0 = 44 / 256, u1 = 74 / 256, v0 = 2 / 128, v1 = 22 / 128

    // 相对未旋转的顺序整体转了一格 —— 这正是抵消图集里那 90° 的方式
    expect(c[0]).toEqual([u1, v0])
    expect(c[1]).toEqual([u1, v1])
    expect(c[2]).toEqual([u0, v1])
    expect(c[3]).toEqual([u0, v0])
  })

  it('四个角互不相同(挡住把 UV 算塌的低级错误)', () => {
    for (const name of ['head', 'arm']) {
      const c = corners(regionUVs(atlas.regions.get(name)!, page))
      expect(new Set(c.map((p) => p.join(','))).size).toBe(4)
    }
  })
})
