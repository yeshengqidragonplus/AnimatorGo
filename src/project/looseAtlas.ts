import type { Atlas, AtlasPage, AtlasRegion } from '@core/atlas.ts'
import type { ImageAsset } from './types.ts'

/**
 * 编辑阶段每张原图先作为独立图集页使用。这样图片导入后无需等待打包也能预览；
 * 正式打包(atlasLayout.ts)在资源整理或导出阶段替换它。
 *
 * 区域名用 **image.path**(images/ 内的文件名):它在项目里唯一、不含冒号
 * (imageId 的 `image:` 前缀会撞上 .atlas 文本的 `key: value` 语法),
 * 且与正式打包的区域名一致 —— 重新打包时 attachment.path 不需要任何改动。
 */
export function createLooseImageAtlas(images: readonly ImageAsset[]): Atlas {
  const pages: AtlasPage[] = []
  const regions = new Map<string, AtlasRegion>()
  for (const image of images) {
    pages.push({ name: image.path, width: image.width, height: image.height, pma: false })
    regions.set(image.path, {
      name: image.path,
      page: image.path,
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
