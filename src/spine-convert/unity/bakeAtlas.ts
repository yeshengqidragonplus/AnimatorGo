import { MaxRectsPacker } from 'maxrects-packer'
import type { Atlas, AtlasRegion } from '../../core/atlas.ts'
import { blankImage, type Image } from '../../unity/png.ts'

/**
 * 把 Spine 图集烘焙成 Unity 能直接切的图集。
 *
 * ## 为什么必须重新烘焙,不能直接在原图上划 sprite 矩形
 *
 * **Spine 图集里的区域可以是躺着的**(`rotate: 90`,为了省空间),
 * 而 **Unity 的 sprite 矩形不能带旋转**。实测 MX2_cat 的 16 个区域里有 8 个是旋转的。
 *
 * 也可以不烘焙,改成「矩形按躺着的样子划,再给节点补 ∓90° 转回来」——
 * 但那样旋转、pivot、网格顶点、蒙皮骨骼四套坐标约定要同时对上,
 * 错一个符号就是**某些图莫名其妙偏了或倒了**,而且只在旋转过的那几张上出现。
 *
 * 烘焙则只有一处方向约定,而且**打开产出的 PNG 一眼就能看出对不对**。
 *
 * ## 旋转的映射(推导见下)
 *
 * 设区域摆正后是 w×h,在图集里占 (X, Y) 起、h×w 大的位置。由 Spine 运行时的
 * UV 换算式反解可得:
 *
 * ```
 * 摆正图的 (tx, ty)  ←  图集里的 (X + ty, Y + w - 1 - tx)
 * ```
 *
 * 也就是图集里存的是**逆时针转了 90°** 的样子,与 docs/FORMAT.md 的记载一致。
 */

/** 烘焙后每张图的位置。**原点在左下**(Unity 的 sprite 矩形约定) */
export interface BakedRect {
  readonly page: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly region: AtlasRegion
}

export interface BakedAtlas {
  readonly pages: readonly Image[]
  /** 区域名 → 位置 */
  readonly rects: ReadonlyMap<string, BakedRect>
  /** 骨架用到但图集里没有的区域名 */
  readonly missing: readonly string[]
}

export interface BakeOptions {
  readonly maxSize: number
  /** 图与图之间留的空隙,防止采样串色 */
  readonly padding: number
}

export const DEFAULT_BAKE_OPTIONS: BakeOptions = { maxSize: 2048, padding: 4 }

/** 从源页取一个像素,越界返回全透明 */
function sample(src: Image, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= src.width || y >= src.height) return 0
  const i = (y * src.width + x) * 4
  return (src.data[i]! << 24) | (src.data[i + 1]! << 16) | (src.data[i + 2]! << 8) | src.data[i + 3]!
}

function put(dst: Image, x: number, y: number, rgba: number): void {
  if (x < 0 || y < 0 || x >= dst.width || y >= dst.height) return
  const i = (y * dst.width + x) * 4
  dst.data[i] = (rgba >>> 24) & 0xff
  dst.data[i + 1] = (rgba >>> 16) & 0xff
  dst.data[i + 2] = (rgba >>> 8) & 0xff
  dst.data[i + 3] = rgba & 0xff
}

/**
 * 把一个区域摆正着画到目标页上。
 *
 * `destX/destY` 是目标页里的**左上角**(和 PNG 的行序一致)。
 */
function blitUpright(src: Image, region: AtlasRegion, dst: Image, destX: number, destY: number): void {
  const { x: X, y: Y, width: w, height: h, rotate } = region
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const rgba = rotate === 90 ? sample(src, X + ty, Y + w - 1 - tx) : sample(src, X + tx, Y + ty)
      put(dst, destX + tx, destY + ty, rgba)
    }
  }
}

/**
 * 往矩形外扩一圈边缘像素。
 *
 * 双线性采样在贴图边界会把外面的透明黑混进来,表现为**图的边上一圈发暗**。
 * 复制一圈边缘像素出去就没有这个问题 —— sprite 矩形不含这一圈,只是给采样器垫底。
 */
function extrude(dst: Image, x: number, y: number, w: number, h: number): void {
  for (let i = 0; i < w; i++) {
    put(dst, x + i, y - 1, sample(dst, x + i, y))
    put(dst, x + i, y + h, sample(dst, x + i, y + h - 1))
  }
  for (let i = 0; i < h; i++) {
    put(dst, x - 1, y + i, sample(dst, x, y + i))
    put(dst, x + w, y + i, sample(dst, x + w - 1, y + i))
  }
  put(dst, x - 1, y - 1, sample(dst, x, y))
  put(dst, x + w, y - 1, sample(dst, x + w - 1, y))
  put(dst, x - 1, y + h, sample(dst, x, y + h - 1))
  put(dst, x + w, y + h, sample(dst, x + w - 1, y + h - 1))
}

export function bakeAtlas(
  atlas: Atlas,
  sources: ReadonlyMap<string, Image>,
  names: readonly string[],
  options: BakeOptions = DEFAULT_BAKE_OPTIONS,
): BakedAtlas {
  const missing: string[] = []
  const wanted: AtlasRegion[] = []

  for (const name of [...new Set(names)].sort()) {
    const region = atlas.regions.get(name)
    if (region === undefined) missing.push(name)
    else wanted.push(region)
  }

  for (const region of wanted) {
    if (region.width > options.maxSize || region.height > options.maxSize) {
      throw new Error(
        `区域 "${region.name}"(${region.width}×${region.height})放不进 ${options.maxSize}×${options.maxSize} 的页`,
      )
    }
  }

  // ⚠️ allowRotation 必须是 false —— 整个烘焙的意义就是把图摆正
  const packer = new MaxRectsPacker(options.maxSize, options.maxSize, options.padding, {
    smart: true,
    pot: true,
    square: false,
    allowRotation: false,
  })
  for (const region of wanted) packer.add(region.width, region.height, region)

  const pages: Image[] = []
  const rects = new Map<string, BakedRect>()

  packer.bins.forEach((bin, pageIndex) => {
    const page = blankImage(bin.width, bin.height)
    pages.push(page)

    for (const rect of bin.rects) {
      const region = rect.data as AtlasRegion
      const source = sources.get(region.page)
      if (source === undefined) throw new Error(`缺少图集页 "${region.page}" 的图片`)

      blitUpright(source, region, page, rect.x, rect.y)
      extrude(page, rect.x, rect.y, region.width, region.height)

      rects.set(region.name, {
        page: pageIndex,
        x: rect.x,
        // PNG 的行序原点在左上,Unity 的 sprite 矩形原点在左下 —— 这里翻过来
        y: bin.height - rect.y - region.height,
        width: region.width,
        height: region.height,
        region,
      })
    }
  })

  return { pages, rects, missing }
}
