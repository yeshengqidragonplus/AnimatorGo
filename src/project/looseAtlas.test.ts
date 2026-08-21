import { describe, expect, it } from 'vitest'
import { createLooseImageAtlas } from './looseAtlas.ts'

describe('编辑期原图图集', () => {
  it('每张导入图片都是完整、未裁剪、未旋转的独立区域,区域名用文件名', () => {
    const atlas = createLooseImageAtlas([{ id: 'image:body.png', path: 'body.png', width: 64, height: 128 }])
    expect(atlas.pages[0]).toMatchObject({ name: 'body.png', width: 64, height: 128 })
    expect(atlas.regions.get('body.png')).toMatchObject({
      page: 'body.png', width: 64, height: 128, originalWidth: 64, originalHeight: 128, rotate: 0,
    })
  })
})
