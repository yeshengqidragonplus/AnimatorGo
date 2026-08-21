import { describe, expect, it } from 'vitest'
import { parseAtlas, packedSize } from '@core/atlas.ts'
import {
  DEFAULT_PACK_OPTIONS,
  layoutToAtlas,
  packAtlasLayout,
  serializeAtlasText,
  type PackInput,
} from './atlasLayout.ts'

const input = (name: string, w: number, h: number, trim?: Partial<PackInput['trim']>): PackInput => ({
  name,
  originalWidth: w,
  originalHeight: h,
  trim: { offsetX: 0, offsetY: 0, width: w, height: h, ...trim },
})

const INPUTS: PackInput[] = [
  input('body.png', 64, 128),
  input('head.png', 48, 48),
  // 裁过透明边:原图 100×80,有效区 60×40,左裁 10、下裁 20
  input('arm.png', 100, 80, { offsetX: 10, offsetY: 20, width: 60, height: 40 }),
]

describe('图集布局', () => {
  it('所有输入都被放进页里,互不重叠', () => {
    const layout = packAtlasLayout(INPUTS)
    expect(layout.regions.map((r) => r.name).sort()).toEqual(['arm.png', 'body.png', 'head.png'])

    for (const a of layout.regions) {
      for (const b of layout.regions) {
        if (a === b || a.page !== b.page) continue
        const [aw, ah] = a.rotated ? [a.input.trim.height, a.input.trim.width] : [a.input.trim.width, a.input.trim.height]
        const [bw, bh] = b.rotated ? [b.input.trim.height, b.input.trim.width] : [b.input.trim.width, b.input.trim.height]
        const overlap = a.x < b.x + bw && b.x < a.x + aw && a.y < b.y + bh && b.y < a.y + ah
        expect(overlap).toBe(false)
      }
    }
  })

  it('页尺寸取 2 的幂', () => {
    const layout = packAtlasLayout(INPUTS)
    for (const page of layout.pages) {
      expect(Math.log2(page.width) % 1).toBe(0)
      expect(Math.log2(page.height) % 1).toBe(0)
    }
  })

  it('单张图超过页上限时报错而不是静默丢图', () => {
    expect(() =>
      packAtlasLayout([input('huge.png', 4096, 4096)], { ...DEFAULT_PACK_OPTIONS, maxWidth: 2048, maxHeight: 2048 }),
    ).toThrow('超过图集页上限')
  })

  it('区域名 = 图片文件名 —— 重新打包(顺序不同/新增图片)时引用保持稳定', () => {
    const before = new Set(packAtlasLayout(INPUTS).regions.map((r) => r.name))
    const after = new Set(
      packAtlasLayout([...INPUTS].reverse().concat(input('new.png', 32, 32))).regions.map((r) => r.name),
    )
    for (const name of before) expect(after.has(name)).toBe(true)
  })
})

describe('.atlas 文本序列化', () => {
  it('serializeAtlasText 的输出能被 parseAtlas 原样读回', () => {
    const layout = packAtlasLayout(INPUTS)
    const names = layout.pages.map((_, i) => (i === 0 ? 'hero.png' : `hero${i + 1}.png`))
    const parsed = parseAtlas(serializeAtlasText(layout, names))
    const direct = layoutToAtlas(layout, names)

    expect(parsed.pages).toEqual(direct.pages)
    expect(parsed.regions.size).toBe(direct.regions.size)
    for (const [name, region] of direct.regions) {
      expect(parsed.regions.get(name)).toEqual(region)
    }
  })

  it('裁剪与旋转语义符合 core/atlas.ts:width/height 摆正,packedSize 按 rotate 交换', () => {
    // 强制旋转:窄长条 + 小页,竖着放不下时打包器只能横着塞
    const tall = input('tall.png', 10, 100)
    const layout = packAtlasLayout([input('base.png', 100, 100), tall], {
      maxWidth: 128,
      maxHeight: 128,
      padding: 0,
      allowRotation: true,
      pot: true,
    })
    const atlas = layoutToAtlas(layout, ['p.png'])
    const region = atlas.regions.get('tall.png')!
    // 无论转没转,width/height 都是摆正尺寸
    expect([region.width, region.height]).toEqual([10, 100])
    if (region.rotate === 90) {
      expect(packedSize(region)).toEqual([100, 10])
    }
  })

  it('裁剪 offsets 原样进出', () => {
    const layout = packAtlasLayout(INPUTS)
    const atlas = parseAtlas(serializeAtlasText(layout, ['hero.png']))
    expect(atlas.regions.get('arm.png')).toMatchObject({
      offsetX: 10,
      offsetY: 20,
      width: 60,
      height: 40,
      originalWidth: 100,
      originalHeight: 80,
    })
  })
})
