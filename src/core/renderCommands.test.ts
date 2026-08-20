import { describe, expect, it } from 'vitest'
import { parseAtlas } from './atlas.ts'
import { buildRenderCommands } from './renderCommands.ts'
import { Skeleton } from './Skeleton.ts'
import type { SkeletonData } from './types.ts'

const atlas = parseAtlas(`
sheet.png
size: 100, 100
body
  bounds: 0, 0, 20, 10
`.trim())

const data: SkeletonData = {
  name: 'character',
  bones: [{
    name: 'root', parent: -1, x: 10, y: 20, rotation: 0, scaleX: 1, scaleY: 1,
    shearX: 0, shearY: 0, length: 0, inheritRotation: true, inheritScale: true,
  }],
  slots: [{
    name: 'body', bone: 0, attachment: 'body', color: { r: 1, g: 0.5, b: 0.25, a: 1 }, blend: 'normal',
  }],
  skins: new Map([['default', new Map([[0, new Map([['body', {
    type: 'region', name: 'body', path: 'body', x: 5, y: 0, rotation: 0, scaleX: 1, scaleY: 1, width: 20, height: 10,
  }]])]])]]),
  defaultSkin: 'default',
}

describe('RenderCommand 求值', () => {
  it('按 slot 绘制顺序产出 attachment 的世界顶点、UV 和颜色', () => {
    const skeleton = new Skeleton(data)
    skeleton.updateWorldTransform()

    const [command] = buildRenderCommands(skeleton, atlas)
    expect(command?.slotName).toBe('body')
    expect(command?.vertices).toEqual(new Float32Array([5, 15, 25, 15, 25, 25, 5, 25]))
    expect(command?.uvs).toEqual(new Float32Array([0, 0.1, 0.2, 0.1, 0.2, 0, 0, 0]))
    expect(command?.color).toEqual({ r: 1, g: 0.5, b: 0.25, a: 1 })
  })

  it('遇到缺失图集区域立即报错，避免静默丢部件', () => {
    const skeleton = new Skeleton(data)
    skeleton.updateWorldTransform()
    const missing = parseAtlas('sheet.png\nsize: 100, 100')
    expect(() => buildRenderCommands(skeleton, missing)).toThrow('图集区域不存在')
  })

  it('图集裁剪透明边时仍保持 attachment 原始锚点', () => {
    const trimmedAtlas = parseAtlas(`
sheet.png
size: 100, 100
body
  bounds: 0, 0, 10, 5
  offsets: 2, 3, 20, 10
`.trim())
    const skeleton = new Skeleton(data)
    skeleton.updateWorldTransform()

    const [command] = buildRenderCommands(skeleton, trimmedAtlas)
    // attachment 中心在 (15,20)，裁剪后只保留原图 x=2..12、y=3..8 的区域。
    expect(command?.vertices).toEqual(new Float32Array([7, 18, 17, 18, 17, 23, 7, 23]))
  })
})
