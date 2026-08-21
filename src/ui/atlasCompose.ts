import type { Atlas } from '@core/atlas.ts'
import {
  DEFAULT_PACK_OPTIONS,
  layoutToAtlas,
  packAtlasLayout,
  serializeAtlasText,
  type PackedLayout,
  type PackInput,
  type TrimInfo,
} from '@project/atlasLayout.ts'
import type { AtlasAsset, ImageAsset } from '@project/types.ts'
import { platform } from '@platform/index.ts'

/**
 * 图集打包的像素部分:裁透明边扫描、把切图画进页画布、写文件。
 * 需要 DOM Canvas,所以放在 ui/;矩形布局的纯逻辑在 @project/atlasLayout.ts。
 */

export interface PackedProjectAtlas {
  readonly asset: AtlasAsset
  readonly layout: PackedLayout
  readonly atlas: Atlas
  readonly atlasText: string
  /** 各页 PNG,给预览用 —— 不用再从磁盘读回来 */
  readonly pageBlobs: readonly Blob[]
}

/** 扫描非透明像素的包围盒。全透明的图不裁,保留原尺寸(0×0 的区域没法打包)。 */
export function trimOpaqueBounds(data: Uint8ClampedArray, width: number, height: number): TrimInfo {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! > 0) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return { offsetX: 0, offsetY: 0, width, height }
  return {
    offsetX: minX,
    // offsetY 是从**下边**裁掉的像素(Y 向上,见 core/atlas.ts),扫描坐标 Y 向下
    offsetY: height - (maxY + 1),
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  }
}

function bytesToBlob(bytes: Uint8Array): Blob {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return new Blob([buffer])
}

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b === null ? reject(new Error('画布导出 PNG 失败')) : resolve(b)), 'image/png')
  })
  return new Uint8Array(await blob.arrayBuffer())
}

function composePage(
  layout: PackedLayout,
  pageIndex: number,
  bitmaps: ReadonlyMap<string, ImageBitmap>,
): HTMLCanvasElement {
  const page = layout.pages[pageIndex]!
  const canvas = document.createElement('canvas')
  canvas.width = page.width
  canvas.height = page.height
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('无法创建 2D 画布')

  for (const region of layout.regions) {
    if (region.page !== pageIndex) continue
    const bitmap = bitmaps.get(region.name)
    if (bitmap === undefined) throw new Error(`缺少图片位图: ${region.name}`)

    const { trim } = region.input
    // 裁剪矩形在原图里的位置。trim.offsetY 是从下边裁掉的,画布坐标 Y 向下
    const sx = trim.offsetX
    const sy = bitmap.height - trim.offsetY - trim.height

    if (!region.rotated) {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.drawImage(bitmap, sx, sy, trim.width, trim.height, region.x, region.y, trim.width, trim.height)
    } else {
      // 逆时针 90°:摆正图的左下角落在图集矩形的右下角(与 regionUVs 的还原方向互逆)。
      // 源坐标 (u,v) → 页坐标 (x + v, y + w − u)
      ctx.setTransform(0, -1, 1, 0, region.x, region.y + trim.width)
      ctx.drawImage(bitmap, sx, sy, trim.width, trim.height, 0, 0, trim.width, trim.height)
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  return canvas
}

/** 第 1 页叫 name.png,后续 name2.png、name3.png —— 和 Spine 的多页命名一致 */
function pageFileNames(base: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => (i === 0 ? `${base}.png` : `${base}${i + 1}.png`))
}

/**
 * 完整打包流程:读原图 → 裁透明边 → MaxRects 布局 → 合成页 PNG →
 * 写 atlases/<名>.png + <名>.atlas → 返回资产记录和预览数据。
 *
 * 区域名 = image.path,和 attachment.path 一致,重新打包不影响任何绑定。
 */
export async function packProjectAtlas(
  projectDir: string,
  images: readonly ImageAsset[],
  atlasName: string,
): Promise<PackedProjectAtlas> {
  if (images.length === 0) throw new Error('没有可打包的图片')

  const bitmaps = new Map<string, ImageBitmap>()
  const inputs: PackInput[] = []
  try {
    for (const image of images) {
      const bytes = await platform().readImage(projectDir, image.path)
      const bitmap = await createImageBitmap(bytesToBlob(bytes))
      bitmaps.set(image.path, bitmap)

      const scan = document.createElement('canvas')
      scan.width = bitmap.width
      scan.height = bitmap.height
      const ctx = scan.getContext('2d', { willReadFrequently: true })
      if (ctx === null) throw new Error('无法创建 2D 画布')
      ctx.drawImage(bitmap, 0, 0)
      const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height)

      inputs.push({
        name: image.path,
        originalWidth: bitmap.width,
        originalHeight: bitmap.height,
        trim: trimOpaqueBounds(pixels.data, bitmap.width, bitmap.height),
      })
    }

    const layout = packAtlasLayout(inputs, DEFAULT_PACK_OPTIONS)
    const names = pageFileNames(atlasName, layout.pages.length)
    const atlasText = serializeAtlasText(layout, names)

    const pageBlobs: Blob[] = []
    for (let i = 0; i < layout.pages.length; i++) {
      const bytes = await canvasToPngBytes(composePage(layout, i, bitmaps))
      await platform().writeAtlasFile(projectDir, names[i]!, bytes)
      pageBlobs.push(new Blob([bytes.buffer as ArrayBuffer], { type: 'image/png' }))
    }
    await platform().writeAtlasFile(projectDir, `${atlasName}.atlas`, atlasText)

    const asset: AtlasAsset = {
      id: `atlas:${atlasName}`,
      path: `atlases/${atlasName}.atlas`,
      pages: names.map((name) => ({ name, path: `atlases/${name}` })),
    }
    return { asset, layout, atlas: layoutToAtlas(layout, names), atlasText, pageBlobs }
  } finally {
    for (const bitmap of bitmaps.values()) bitmap.close()
  }
}
