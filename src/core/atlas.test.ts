import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { packedSize, parseAtlas, regionUVs } from './atlas.ts'

/**
 * 语义提醒(见 atlas.ts 顶部):
 *   `size` / `bounds` 的宽高 = **摆正后**的裁剪尺寸
 *   rotate 为 90 时,图集里占的是 高×宽(packedSize)
 */

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
  offsets: 0, 0, 34, 26
  rotate: 90
plain
  bounds: 76, 2, 10, 10
`.trim()

/** 3.8 及更早写法,内容与 NEW_FORMAT 等价 */
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
  orig: 34, 26
  offset: 0, 0
  index: -1
`.trim()

describe('图集解析', () => {
  it('读出页信息', () => {
    const atlas = parseAtlas(NEW_FORMAT)
    expect(atlas.pages).toHaveLength(1)
    expect(atlas.pages[0]).toMatchObject({ name: 'character.png', width: 256, height: 128 })
  })

  it('bounds 的宽高是摆正后的裁剪尺寸,原始尺寸在 offsets 里', () => {
    const r = parseAtlas(NEW_FORMAT).regions.get('head')!
    expect([r.width, r.height]).toEqual([40, 30])
    expect([r.originalWidth, r.originalHeight]).toEqual([50, 44])
  })

  it('offsets 的前两个值是从左边和下边裁掉的像素', () => {
    const r = parseAtlas(NEW_FORMAT).regions.get('head')!
    expect([r.offsetX, r.offsetY]).toEqual([4, 6])
  })

  it('rotate 为 90 时,图集里的占位是宽高交换的', () => {
    const r = parseAtlas(NEW_FORMAT).regions.get('arm')!
    expect(r.rotate).toBe(90)
    expect([r.width, r.height]).toEqual([30, 20]) // 摆正后
    expect(packedSize(r)).toEqual([20, 30]) // 图集里横躺着
  })

  it('未旋转时占位尺寸就等于摆正尺寸', () => {
    expect(packedSize(parseAtlas(NEW_FORMAT).regions.get('head')!)).toEqual([40, 30])
  })

  it('没有 offsets 时,原始尺寸退化为摆正尺寸', () => {
    const r = parseAtlas(NEW_FORMAT).regions.get('plain')!
    expect([r.originalWidth, r.originalHeight]).toEqual([10, 10])
    expect(r.offsetX).toBe(0)
  })

  it('旧格式解析出和新格式逐字段相同的结果', () => {
    const oldA = parseAtlas(OLD_FORMAT)
    const newA = parseAtlas(NEW_FORMAT)
    for (const name of ['head', 'arm']) {
      expect({ ...oldA.regions.get(name)! }).toEqual({ ...newA.regions.get(name)! })
    }
  })

  it('旧格式的 rotate: true 等价于 90 度', () => {
    expect(parseAtlas(OLD_FORMAT).regions.get('arm')!.rotate).toBe(90)
    expect(parseAtlas(OLD_FORMAT).regions.get('head')!.rotate).toBe(0)
  })

  it('多页图集 —— 空行分隔,第一页不能丢', () => {
    const atlas = parseAtlas(
      `
p1.png
size: 64, 64
a
  bounds: 0, 0, 8, 8

p2.png
size: 32, 32
b
  bounds: 1, 1, 4, 4
`.trim(),
    )

    expect(atlas.pages.map((p) => p.name)).toEqual(['p1.png', 'p2.png'])
    expect(atlas.regions.get('a')!.page).toBe('p1.png')
    expect(atlas.regions.get('b')!.page).toBe('p2.png')
    expect(atlas.regions.get('b')!.width).toBe(4)
  })

  it('CRLF 换行也能解析', () => {
    const atlas = parseAtlas('p.png\r\nsize: 16, 16\r\nr\r\n  bounds: 1, 2, 3, 4\r\n')
    expect(atlas.regions.get('r')).toMatchObject({ x: 1, y: 2, width: 3, height: 4 })
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

    expect(c).toEqual([
      [u0, v1], // 左下
      [u1, v1], // 右下
      [u1, v0], // 右上
      [u0, v0], // 左上
    ])
  })

  it('旋转 90:UV 顺时针转回来,且占位用交换后的宽高', () => {
    const c = corners(regionUVs(atlas.regions.get('arm')!, page))
    // 占位是 20×30,不是 30×20
    const u0 = 44 / 256, u1 = 64 / 256, v0 = 2 / 128, v1 = 32 / 128

    // 摆正后的左下角 ← 图集里那块的右下角,依次错开
    expect(c).toEqual([
      [u1, v1], // 左下
      [u1, v0], // 右下
      [u0, v0], // 右上
      [u0, v1], // 左上
    ])
  })

  it('四个角互不相同(挡住把 UV 算塌的低级错误)', () => {
    for (const name of ['head', 'arm']) {
      const c = corners(regionUVs(atlas.regions.get(name)!, page))
      expect(new Set(c.map((p) => p.join(','))).size).toBe(4)
    }
  })
})

/**
 * 拿真实 Spine 图集验证 —— 语义弄反时这里会炸,合成 fixture 未必炸。
 * res/ 不进仓库(是用户的美术资源),所以文件不在时跳过。
 */
const REAL_ATLAS = 'res/BBQ/BBQ_grill.atlas.txt'

describe.skipIf(!existsSync(REAL_ATLAS))('真实图集不变量', () => {
  const atlas = parseAtlas(readFileSync(REAL_ATLAS, 'utf-8'))
  const page = atlas.pages[0]!

  it('解析出区域且含旋转项', () => {
    expect(atlas.regions.size).toBeGreaterThan(0)
    expect([...atlas.regions.values()].some((r) => r.rotate === 90)).toBe(true)
  })

  it('每个区域的占位矩形都在页内 —— 宽高弄反会越界', () => {
    for (const r of atlas.regions.values()) {
      const [pw, ph] = packedSize(r)
      expect(r.x + pw, `${r.name} 横向越界`).toBeLessThanOrEqual(page.width)
      expect(r.y + ph, `${r.name} 纵向越界`).toBeLessThanOrEqual(page.height)
    }
  })

  it('摆正尺寸加上裁剪偏移不超过原始尺寸 —— 宽高弄反会超', () => {
    for (const r of atlas.regions.values()) {
      expect(r.width + r.offsetX, `${r.name} 宽超出原图`).toBeLessThanOrEqual(r.originalWidth)
      expect(r.height + r.offsetY, `${r.name} 高超出原图`).toBeLessThanOrEqual(r.originalHeight)
    }
  })

  it('UV 全部落在 [0,1]', () => {
    for (const r of atlas.regions.values()) {
      for (const uv of regionUVs(r, page)) {
        expect(uv).toBeGreaterThanOrEqual(0)
        expect(uv).toBeLessThanOrEqual(1)
      }
    }
  })
})
