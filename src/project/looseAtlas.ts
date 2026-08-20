import type { Atlas, AtlasPage, AtlasRegion } from '@core/atlas.ts'
import type { ImageAsset } from './types.ts'

/**
 * 编辑阶段每张原图先作为独立图集页使用。这样图片导入后无需等待打包也能预览；
 * 正式导出时再由图集插件将它们合并成 MaxRects 图集。
 */
export function createLooseImageAtlas(images: readonly ImageAsset[]): Atlas {
  const pages: AtlasPage[] = []
  const regions = new Map<string, AtlasRegion>()
  for (const image of images) {
    pages.push({ name: image.id, width: image.width, height: image.height, pma: false })
    regions.set(image.id, {
      name: image.id,
      page: image.id,
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
      rotate: 0,
      offsetX: 0,
      offsetY: 0,
      originalWidth: image.width,
      originalHeight: image.height,
      index: -1,
    })
  }
  return { pages, regions }
}
