/**
 * 图集解析。对应 docs/FORMAT.md 第 3 节。
 *
 * 这个格式和 Spine 的 `.atlas` 一致 —— 刻意的,这样导入 Spine 资源不需要第二套解析器。
 * 同时支持新旧两种写法(4.x 的 `bounds/offsets` 与 3.8 的 `xy/size/orig/offset`)。
 *
 * ⚠️ **两个语义必须记牢,弄反了所有切图锚点都会无规律偏移:**
 *
 *   `bounds: x, y, w, h`
 *       w/h 是**图集里的占位尺寸,已经算上旋转**。rotate 为 90 时,
 *       w 是原图的高、h 是原图的宽。
 *
 *   `offsets: dx, dy, origW, origH`
 *       dx/dy 是打包时从**左边和下边**裁掉的透明像素数(Y 向上!),
 *       origW/origH 是**未旋转、未裁剪**的原始尺寸。
 *
 *   `rotate` 表示在图集里被**逆时针**转了 90°。
 */

export interface AtlasPage {
  readonly name: string
  readonly width: number
  readonly height: number
  /** 预乘 alpha。本工具一律非预乘,读到 true 时由调用方决定怎么处理 */
  readonly pma: boolean
}

export interface AtlasRegion {
  readonly name: string
  readonly page: string

  /** 在图集中的左上角位置 */
  readonly x: number
  readonly y: number
  /** 在图集中的占位尺寸(已含旋转) */
  readonly packedWidth: number
  readonly packedHeight: number

  /** 0 或 90。90 表示在图集里被逆时针转了 90° */
  readonly rotate: number

  /** 从左边/下边裁掉的透明像素 */
  readonly offsetX: number
  readonly offsetY: number
  /** 未旋转、未裁剪的原始尺寸 */
  readonly originalWidth: number
  readonly originalHeight: number

  /** 序列帧编号,没有则为 -1 */
  readonly index: number
}

export interface Atlas {
  readonly pages: readonly AtlasPage[]
  readonly regions: ReadonlyMap<string, AtlasRegion>
}

/**
 * 去掉旋转影响后的尺寸 —— 即「裁剪过但摆正」的尺寸。
 *
 * 渲染时切图在画面上占的就是这个大小(再加上 offset 的位移)。
 */
export function trimmedSize(region: AtlasRegion): [number, number] {
  return region.rotate === 90
    ? [region.packedHeight, region.packedWidth]
    : [region.packedWidth, region.packedHeight]
}

// ─── 解析 ────────────────────────────────────────────────────────────────────

function parseNumbers(value: string): number[] {
  return value.split(',').map((s) => Number(s.trim()))
}

/** `key: value` → [key, value];不是这个形式返回 null */
function splitEntry(line: string): [string, string] | null {
  const colon = line.indexOf(':')
  if (colon < 0) return null
  return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()]
}

interface MutableRegion {
  name: string
  page: string
  x: number
  y: number
  packedWidth: number
  packedHeight: number
  rotate: number
  offsetX: number
  offsetY: number
  originalWidth: number
  originalHeight: number
  index: number
}

function finishRegion(r: MutableRegion): AtlasRegion {
  // 旧格式没有 orig 时,原始尺寸就等于摆正后的尺寸(说明没裁过)
  if (r.originalWidth === 0 && r.originalHeight === 0) {
    const [w, h] = trimmedSize(r as AtlasRegion)
    r.originalWidth = w
    r.originalHeight = h
  }
  return r as AtlasRegion
}

/** 页头里出现这些键说明还在读页属性,而不是已经进入区域列表 */
const PAGE_KEYS = new Set(['size', 'format', 'filter', 'repeat', 'pma'])

export function parseAtlas(text: string): Atlas {
  const pages: AtlasPage[] = []
  const regions = new Map<string, AtlasRegion>()

  const lines = text.split(/\r\n|\r|\n/)
  let i = 0

  let currentPage: string | null = null
  let pageWidth = 0
  let pageHeight = 0
  let pagePma = false
  let region: MutableRegion | null = null

  const flushRegion = () => {
    if (region !== null) {
      const done = finishRegion(region)
      regions.set(done.name, done)
      region = null
    }
  }

  // 推进数组后立刻置空,这样重复调用是安全的(空行和文件末尾都会调)
  const flushPage = () => {
    if (currentPage !== null) {
      pages.push({ name: currentPage, width: pageWidth, height: pageHeight, pma: pagePma })
      currentPage = null
    }
  }

  while (i < lines.length) {
    const raw = lines[i]!
    i += 1
    const line = raw.trim()

    // 空行分隔页;下一非空行是新页的文件名
    if (line.length === 0) {
      flushRegion()
      flushPage()
      continue
    }

    const entry = splitEntry(line)

    // 没有冒号 = 一个名字行。要么是页文件名,要么是区域名
    if (entry === null) {
      flushRegion()
      if (currentPage === null) {
        flushPage()
        currentPage = line
        pageWidth = 0
        pageHeight = 0
        pagePma = false
      } else {
        region = {
          name: line,
          page: currentPage,
          x: 0, y: 0, packedWidth: 0, packedHeight: 0,
          rotate: 0,
          offsetX: 0, offsetY: 0, originalWidth: 0, originalHeight: 0,
          index: -1,
        }
      }
      continue
    }

    const [key, value] = entry

    // 还在页头
    if (region === null && PAGE_KEYS.has(key)) {
      if (key === 'size') {
        const [w, h] = parseNumbers(value)
        pageWidth = w ?? 0
        pageHeight = h ?? 0
      } else if (key === 'pma') {
        pagePma = value === 'true'
      }
      continue
    }

    if (region === null) continue // 未知的页级键,忽略

    switch (key) {
      case 'bounds': {
        const [x, y, w, h] = parseNumbers(value)
        region.x = x ?? 0
        region.y = y ?? 0
        region.packedWidth = w ?? 0
        region.packedHeight = h ?? 0
        break
      }
      case 'offsets': {
        const [dx, dy, ow, oh] = parseNumbers(value)
        region.offsetX = dx ?? 0
        region.offsetY = dy ?? 0
        region.originalWidth = ow ?? 0
        region.originalHeight = oh ?? 0
        break
      }
      case 'rotate': {
        // 旧格式是 true/false(true 即 90°),新格式是角度
        region.rotate = value === 'true' ? 90 : value === 'false' ? 0 : (Number(value) || 0)
        break
      }
      // ── 3.8 及更早的写法 ──
      case 'xy': {
        const [x, y] = parseNumbers(value)
        region.x = x ?? 0
        region.y = y ?? 0
        break
      }
      case 'size': {
        const [w, h] = parseNumbers(value)
        region.packedWidth = w ?? 0
        region.packedHeight = h ?? 0
        break
      }
      case 'orig': {
        const [w, h] = parseNumbers(value)
        region.originalWidth = w ?? 0
        region.originalHeight = h ?? 0
        break
      }
      case 'offset': {
        const [dx, dy] = parseNumbers(value)
        region.offsetX = dx ?? 0
        region.offsetY = dy ?? 0
        break
      }
      case 'index': {
        region.index = Number(value) || -1
        break
      }
      default:
        break // split / pad 等九宫格属性用不到
    }
  }

  flushRegion()
  flushPage()

  return { pages, regions }
}

// ─── UV ──────────────────────────────────────────────────────────────────────

/**
 * 算出一个区域的四角 UV,顺序为 **左下 → 右下 → 右上 → 左上**
 * (和 RenderCommand.vertices 一致)。
 *
 * 旋转在这里处理掉 —— 上层拿到的 UV 已经是摆正的,不需要再关心 rotate。
 */
export function regionUVs(region: AtlasRegion, page: AtlasPage): Float32Array {
  const u0 = region.x / page.width
  const v0 = region.y / page.height
  const u1 = (region.x + region.packedWidth) / page.width
  const v1 = (region.y + region.packedHeight) / page.height

  // 图集坐标 Y 向下(左上原点),所以 v0 是上边
  if (region.rotate === 90) {
    // 逆时针转了 90°:把 UV 也转回去,四个角依次错开一位
    return new Float32Array([
      u1, v0,
      u1, v1,
      u0, v1,
      u0, v0,
    ])
  }

  return new Float32Array([
    u0, v1,
    u1, v1,
    u1, v0,
    u0, v0,
  ])
}
