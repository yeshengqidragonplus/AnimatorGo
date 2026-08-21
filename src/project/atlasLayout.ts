import { MaxRectsPacker } from 'maxrects-packer'
import type { Atlas, AtlasPage, AtlasRegion } from '@core/atlas.ts'

/**
 * 正式图集打包的**布局**部分:纯数据进出,不碰像素。
 * 像素合成(裁透明边扫描、往画布上画)在 ui/atlasCompose.ts —— 那边需要 DOM Canvas。
 *
 * 区域名 = 图片文件名(image.path),与 looseAtlas 一致。attachment.path 记的
 * 就是这个名字,所以**重新打包只换布局,attachment 与 slot 全都不用动**。
 */

/** 裁掉透明边后的有效矩形。offset 语义与 .atlas 一致:从左边和**下边**裁掉的像素(Y 向上)。 */
export interface TrimInfo {
  readonly offsetX: number
  readonly offsetY: number
  /** 裁剪后(摆正)的尺寸 */
  readonly width: number
  readonly height: number
}

export interface PackInput {
  /** 区域名,用 image.path */
  readonly name: string
  readonly originalWidth: number
  readonly originalHeight: number
  readonly trim: TrimInfo
}

export interface PackedRegion {
  readonly name: string
  /** 所在页下标 */
  readonly page: number
  /** 在页内的左上角位置 */
  readonly x: number
  readonly y: number
  /** true = 逆时针转 90° 放置,占位宽高互换 */
  readonly rotated: boolean
  readonly input: PackInput
}

export interface PackedPage {
  readonly width: number
  readonly height: number
}

export interface PackedLayout {
  readonly pages: readonly PackedPage[]
  readonly regions: readonly PackedRegion[]
}

export interface PackOptions {
  readonly maxWidth: number
  readonly maxHeight: number
  readonly padding: number
  readonly allowRotation: boolean
  /** 页尺寸取 2 的幂 */
  readonly pot: boolean
}

export const DEFAULT_PACK_OPTIONS: PackOptions = {
  maxWidth: 2048,
  maxHeight: 2048,
  padding: 2,
  allowRotation: true,
  pot: true,
}

/** 单张图(裁剪后)超过页上限时无法打包 —— 宁可报错也不要静默丢图。 */
export function packAtlasLayout(inputs: readonly PackInput[], options: PackOptions = DEFAULT_PACK_OPTIONS): PackedLayout {
  for (const input of inputs) {
    const w = input.trim.width
    const h = input.trim.height
    const fits = w <= options.maxWidth && h <= options.maxHeight
    const fitsRotated = options.allowRotation && h <= options.maxWidth && w <= options.maxHeight
    if (!fits && !fitsRotated) {
      throw new Error(`图片 "${input.name}"(${w}×${h})超过图集页上限 ${options.maxWidth}×${options.maxHeight}`)
    }
  }

  const packer = new MaxRectsPacker(options.maxWidth, options.maxHeight, options.padding, {
    smart: true,
    pot: options.pot,
    square: false,
    allowRotation: options.allowRotation,
  })
  for (const input of inputs) {
    packer.add(input.trim.width, input.trim.height, input)
  }

  const pages: PackedPage[] = []
  const regions: PackedRegion[] = []
  packer.bins.forEach((bin, pageIndex) => {
    pages.push({ width: bin.width, height: bin.height })
    for (const rect of bin.rects) {
      regions.push({
        name: (rect.data as PackInput).name,
        page: pageIndex,
        x: rect.x,
        y: rect.y,
        rotated: rect.rot === true,
        input: rect.data as PackInput,
      })
    }
  })
  return { pages, regions }
}

/**
 * 布局 → core 的 Atlas 结构,渲染命令和图集预览直接用。
 * pageNames 是各页 PNG 的文件名(不带目录),下标对应 layout.pages。
 */
export function layoutToAtlas(layout: PackedLayout, pageNames: readonly string[]): Atlas {
  const pages: AtlasPage[] = layout.pages.map((page, i) => ({
    name: pageNames[i] ?? `page${i}.png`,
    width: page.width,
    height: page.height,
    pma: false,
  }))
  const regions = new Map<string, AtlasRegion>()
  for (const region of layout.regions) {
    const { input } = region
    regions.set(region.name, {
      name: region.name,
      page: pages[region.page]!.name,
      x: region.x,
      y: region.y,
      // Atlas 语义:width/height 是摆正后的裁剪尺寸,不随 rotate 交换
      width: input.trim.width,
      height: input.trim.height,
      rotate: region.rotated ? 90 : 0,
      offsetX: input.trim.offsetX,
      offsetY: input.trim.offsetY,
      originalWidth: input.originalWidth,
      originalHeight: input.originalHeight,
      index: -1,
    })
  }
  return { pages, regions }
}

/**
 * 序列化成 Spine 4.x 风格的 .atlas 文本,parseAtlas 可原样读回。
 * 区域按名字排序 —— 输出稳定,项目文件 diff 才有意义。
 */
export function serializeAtlasText(layout: PackedLayout, pageNames: readonly string[]): string {
  const lines: string[] = []
  layout.pages.forEach((page, pageIndex) => {
    if (pageIndex > 0) lines.push('')
    lines.push(pageNames[pageIndex] ?? `page${pageIndex}.png`)
    lines.push(`size: ${page.width},${page.height}`)
    lines.push('filter: Linear,Linear')
    lines.push('pma: false')

    const regions = layout.regions
      .filter((region) => region.page === pageIndex)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const region of regions) {
      const { trim, originalWidth, originalHeight } = region.input
      lines.push(region.name)
      lines.push(`  bounds: ${region.x},${region.y},${trim.width},${trim.height}`)
      const trimmed =
        trim.offsetX !== 0 || trim.offsetY !== 0 || trim.width !== originalWidth || trim.height !== originalHeight
      if (trimmed) {
        lines.push(`  offsets: ${trim.offsetX},${trim.offsetY},${originalWidth},${originalHeight}`)
      }
      if (region.rotated) lines.push('  rotate: 90')
    }
  })
  return lines.join('\n') + '\n'
}
