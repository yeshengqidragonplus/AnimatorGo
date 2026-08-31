import { deflateSync, inflateSync } from 'node:zlib'

/**
 * 最小 PNG 编解码 —— 只为「把 Spine 图集烘焙成 Unity 能用的正立图集」服务。
 *
 * **没有引入第三方图片库**:PNG 除了 zlib 之外没有别的依赖,而 zlib 是 Node 自带的。
 * 与其为几十行的扫描线滤波再拖一个包进来,不如照着规范写。
 *
 * 支持范围(够用即可,超出的**明确抛错而不是猜**):
 * - 位深 **8**(16 位抛错 —— 图集不会用)
 * - 颜色类型 0 / 2 / 3 / 4 / 6,统一展开成 RGBA8
 * - 非隔行(interlace 0)
 *
 * 写出一律是 RGBA8 + 非隔行。
 */

export interface Image {
  readonly width: number
  readonly height: number
  /** RGBA8,行优先,**原点左上**(PNG 自身的约定) */
  readonly data: Uint8Array
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** 每种颜色类型的通道数 */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Paeth 预测器,规范 9.4 */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

// ─── 解码 ────────────────────────────────────────────────────────────────────

export function decodePng(bytes: Uint8Array): Image {
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error('不是 PNG 文件(签名不符)')
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8

  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let palette: Uint8Array | null = null
  let paletteAlpha: Uint8Array | null = null
  const idat: Uint8Array[] = []

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length

    if (type === 'IHDR') {
      const head = new DataView(data.buffer, data.byteOffset, data.byteLength)
      width = head.getUint32(0)
      height = head.getUint32(4)
      bitDepth = data[8]!
      colorType = data[9]!
      if (data[12] !== 0) throw new Error('不支持隔行 PNG(interlace != 0)')
    } else if (type === 'PLTE') {
      palette = data.slice()
    } else if (type === 'tRNS') {
      paletteAlpha = data.slice()
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
  }

  if (bitDepth !== 8) throw new Error(`只支持 8 位色深,该图是 ${bitDepth} 位`)
  const channels = CHANNELS[colorType]
  if (channels === undefined) throw new Error(`未知的 PNG 颜色类型 ${colorType}`)

  const raw = inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c))))
  const stride = width * channels
  const pixels = new Uint8Array(stride * height)

  // 反滤波:每行开头一个滤波类型字节,参考的是**上一行已经反滤波后**的数据
  let src = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[src++]!
    const row = y * stride
    const prev = row - stride
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i]!
      const a = i >= channels ? pixels[row + i - channels]! : 0
      const b = y > 0 ? pixels[prev + i]! : 0
      const c = y > 0 && i >= channels ? pixels[prev + i - channels]! : 0
      let value: number
      switch (filter) {
        case 0: value = x; break
        case 1: value = x + a; break
        case 2: value = x + b; break
        case 3: value = x + ((a + b) >> 1); break
        case 4: value = x + paeth(a, b, c); break
        default: throw new Error(`未知的扫描线滤波类型 ${filter}(第 ${y} 行)`)
      }
      pixels[row + i] = value & 0xff
    }
    src += stride
  }

  // 统一展开成 RGBA
  const out = new Uint8Array(width * height * 4)
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const s = i * channels
    switch (colorType) {
      case 0: {
        const g = pixels[s]!
        out[p] = g; out[p + 1] = g; out[p + 2] = g; out[p + 3] = 255
        break
      }
      case 2:
        out[p] = pixels[s]!; out[p + 1] = pixels[s + 1]!; out[p + 2] = pixels[s + 2]!; out[p + 3] = 255
        break
      case 3: {
        if (palette === null) throw new Error('调色板 PNG 缺少 PLTE 块')
        const idx = pixels[s]!
        out[p] = palette[idx * 3]!; out[p + 1] = palette[idx * 3 + 1]!; out[p + 2] = palette[idx * 3 + 2]!
        out[p + 3] = paletteAlpha?.[idx] ?? 255
        break
      }
      case 4: {
        const g = pixels[s]!
        out[p] = g; out[p + 1] = g; out[p + 2] = g; out[p + 3] = pixels[s + 1]!
        break
      }
      default:
        out[p] = pixels[s]!; out[p + 1] = pixels[s + 1]!; out[p + 2] = pixels[s + 2]!; out[p + 3] = pixels[s + 3]!
    }
  }

  return { width, height, data: out }
}

// ─── 编码 ────────────────────────────────────────────────────────────────────

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/**
 * 逐行挑滤波器:五种都算一遍,取「绝对值之和最小」的那个。
 *
 * 这是 PNG 规范推荐的启发式。图集里大片透明区域用 Sub/Up 能压到很小,
 * 全用 None 的话 1024×1024 的图会大出好几倍。
 */
function filterRow(row: Uint8Array, prev: Uint8Array | null, bpp: number): Uint8Array {
  const n = row.length
  let best: Uint8Array | null = null
  let bestScore = Infinity

  for (let type = 0; type < 5; type++) {
    const out = new Uint8Array(n + 1)
    out[0] = type
    let score = 0
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? row[i - bpp]! : 0
      const b = prev === null ? 0 : prev[i]!
      const c = prev === null || i < bpp ? 0 : prev[i - bpp]!
      let v: number
      switch (type) {
        case 0: v = row[i]!; break
        case 1: v = row[i]! - a; break
        case 2: v = row[i]! - b; break
        case 3: v = row[i]! - ((a + b) >> 1); break
        default: v = row[i]! - paeth(a, b, c)
      }
      v &= 0xff
      out[i + 1] = v
      score += v < 128 ? v : 256 - v
    }
    if (score < bestScore) {
      bestScore = score
      best = out
    }
  }
  return best!
}

export function encodePng(image: Image): Uint8Array {
  const { width, height, data } = image
  const stride = width * 4

  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width)
  ihdrView.setUint32(4, height)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 颜色类型 RGBA
  ihdr[10] = 0 // 压缩方法
  ihdr[11] = 0 // 滤波方法
  ihdr[12] = 0 // 非隔行

  const filtered = new Uint8Array((stride + 1) * height)
  let prev: Uint8Array | null = null
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, y * stride + stride)
    filtered.set(filterRow(row, prev, 4), y * (stride + 1))
    prev = row
  }

  const idat = deflateSync(Buffer.from(filtered), { level: 9 })

  const parts = [
    new Uint8Array(SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(idat)),
    chunk('IEND', new Uint8Array(0)),
  ]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** 全透明的空白画布 */
export function blankImage(width: number, height: number): Image {
  return { width, height, data: new Uint8Array(width * height * 4) }
}
