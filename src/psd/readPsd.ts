import { inflateSync } from 'node:zlib'

/**
 * Photoshop `.psd` / `.psb`(大文档格式)的图层读取 —— 只为取图层像素,自行按 Adobe 公开的文件格式规范实现。
 *
 * 支持 8 位 RGB / 灰度;通道压缩支持原始、RLE(PackBits)、ZIP、带预测的 ZIP。PSB 与 PSD 的区别只在几处长度字段
 * 从 4 字节变 8 字节(图层与蒙版段、图层信息段、通道数据长度、RLE 行长度,以及一部分附加图层信息)。
 *
 * 图层按文件里的顺序给出:**从下到上**。图层组是两条记录夹着组里的图层 ——
 * 组头(`lsct` 类型 1 / 2)在上面、组尾(类型 3)在下面。
 */

export interface PsdMask {
  /** 文档坐标(左上原点) */
  readonly top: number
  readonly left: number
  readonly bottom: number
  readonly right: number
  /** 蒙版范围之外的取值 */
  readonly defaultColor: number
  /** 第 1 位:蒙版停用 */
  readonly flags: number
  /** 逐像素 0~255,行从上到下 */
  readonly data: Uint8Array
}

export interface PsdLayer {
  readonly name: string
  /** `lyid` 附加信息里的图层 id;没有就是 null */
  readonly id: number | null
  readonly top: number
  readonly left: number
  readonly bottom: number
  readonly right: number
  readonly hidden: boolean
  /** 普通图层 / 组头 / 组尾 */
  readonly kind: 'layer' | 'group' | 'groupEnd'
  readonly opacity: number
  readonly blendMode: string
  readonly clipping: boolean
  /** RGBA,(right − left) × (bottom − top),行从上到下;空图层为 null */
  readonly rgba: Uint8Array | null
  /** 用户蒙版(通道 −2) */
  readonly mask: PsdMask | null
}

export interface PsdDocument {
  /** 1 = PSD,2 = PSB */
  readonly version: number
  readonly width: number
  readonly height: number
  readonly depth: number
  readonly colorMode: number
  /** 从下到上 */
  readonly layers: readonly PsdLayer[]
}

const COLOR_MODE_GRAYSCALE = 1
const COLOR_MODE_RGB = 3
/** PSB 里这些附加图层信息的长度是 8 字节 */
const LONG_KEYS = new Set(['LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD'])

class Reader {
  pos = 0
  readonly view: DataView
  readonly bytes: Uint8Array
  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  u8(): number { return this.view.getUint8(this.pos++) }
  u16(): number { const v = this.view.getUint16(this.pos); this.pos += 2; return v }
  i16(): number { const v = this.view.getInt16(this.pos); this.pos += 2; return v }
  u32(): number { const v = this.view.getUint32(this.pos); this.pos += 4; return v }
  i32(): number { const v = this.view.getInt32(this.pos); this.pos += 4; return v }
  u64(): number {
    const hi = this.u32()
    const lo = this.u32()
    return hi * 2 ** 32 + lo
  }
  ascii(n: number): string {
    let s = ''
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8())
    return s
  }
  /** 跳过一个「4 字节长度 + 数据」的块。⚠️ 不能写成 `pos += u32()` —— 左边的 pos 先取值,读长度推进的 4 字节会丢 */
  skipBlock(): void {
    const n = this.u32()
    this.pos += n
  }
  take(n: number): Uint8Array {
    const out = this.bytes.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }
}

export function readPsd(bytes: Uint8Array): PsdDocument {
  const r = new Reader(bytes)
  if (r.ascii(4) !== '8BPS') throw new Error('不是 Photoshop 文件(文件头不是 8BPS)')
  const version = r.u16()
  if (version !== 1 && version !== 2) throw new Error(`不认识的 PSD 版本 ${version}`)
  const big = version === 2
  r.pos += 6
  r.u16() // 合成图的通道数
  const height = r.u32()
  const width = r.u32()
  const depth = r.u16()
  const colorMode = r.u16()
  if (depth !== 8) throw new Error(`只支持 8 位色深,这个文件是 ${depth} 位`)
  if (colorMode !== COLOR_MODE_RGB && colorMode !== COLOR_MODE_GRAYSCALE) throw new Error(`只支持 RGB / 灰度,这个文件的颜色模式是 ${colorMode}`)
  r.skipBlock() // 颜色模式数据
  r.skipBlock() // 图像资源
  const layerAndMaskLength = big ? r.u64() : r.u32()
  const layerAndMaskEnd = r.pos + layerAndMaskLength
  if (layerAndMaskLength === 0) return { version, width, height, depth, colorMode, layers: [] }
  const layerInfoLength = big ? r.u64() : r.u32()
  if (layerInfoLength === 0) return { version, width, height, depth, colorMode, layers: [] }
  const layerCount = Math.abs(r.i16())

  interface Record {
    name: string
    id: number | null
    top: number; left: number; bottom: number; right: number
    channels: { id: number; length: number }[]
    blendMode: string
    opacity: number
    clipping: boolean
    hidden: boolean
    kind: PsdLayer['kind']
    maskRect: { top: number; left: number; bottom: number; right: number; defaultColor: number; flags: number } | null
  }
  const records: Record[] = []
  for (let i = 0; i < layerCount; i++) {
    const top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32()
    const channelCount = r.u16()
    const channels: Record['channels'] = []
    for (let c = 0; c < channelCount; c++) channels.push({ id: r.i16(), length: big ? r.u64() : r.u32() })
    if (r.ascii(4) !== '8BIM') throw new Error(`第 ${i} 个图层记录的混合模式签名不对`)
    const blendMode = r.ascii(4)
    const opacity = r.u8()
    const clipping = r.u8() !== 0
    const flags = r.u8()
    r.u8()
    const extraLength = r.u32()
    const extraEnd = r.pos + extraLength
    // 图层蒙版
    const maskLength = r.u32()
    const maskEnd = r.pos + maskLength
    let maskRect: Record['maskRect'] = null
    if (maskLength >= 18) {
      const mt = r.i32(), ml = r.i32(), mb = r.i32(), mr = r.i32()
      const defaultColor = r.u8()
      const mflags = r.u8()
      maskRect = { top: mt, left: ml, bottom: mb, right: mr, defaultColor, flags: mflags }
    }
    r.pos = maskEnd
    r.skipBlock() // 混合范围
    const nameLength = r.u8()
    let name = r.ascii(nameLength)
    r.pos += (4 - ((nameLength + 1) % 4)) % 4
    let id: number | null = null
    let kind: PsdLayer['kind'] = 'layer'
    // 附加图层信息
    while (r.pos + 12 <= extraEnd) {
      const sig = r.ascii(4)
      if (sig !== '8BIM' && sig !== '8B64') break
      const key = r.ascii(4)
      const length = big && LONG_KEYS.has(key) ? r.u64() : r.u32()
      const start = r.pos
      if (key === 'luni') {
        const n = r.u32()
        let s = ''
        for (let k = 0; k < n; k++) s += String.fromCharCode(r.u16())
        name = s.replace(/\0+$/, '')
      } else if (key === 'lyid') {
        id = r.u32()
      } else if (key === 'lsct' || key === 'lsdk') {
        const type = r.u32()
        if (type === 1 || type === 2) kind = 'group'
        else if (type === 3) kind = 'groupEnd'
      }
      r.pos = start + length + (length % 2)
    }
    r.pos = extraEnd
    records.push({ name, id, top, left, bottom, right, channels, blendMode, opacity, clipping, hidden: (flags & 2) !== 0, kind, maskRect })
  }

  // 通道像素:按图层、按通道顺序紧挨着
  const layers: PsdLayer[] = []
  for (const rec of records) {
    const w = rec.right - rec.left
    const h = rec.bottom - rec.top
    const planes = new Map<number, Uint8Array>()
    let mask: PsdMask | null = null
    for (const ch of rec.channels) {
      const end = r.pos + ch.length
      const isMask = ch.id === -2 || ch.id === -3
      const mw = isMask && rec.maskRect !== null ? rec.maskRect.right - rec.maskRect.left : w
      const mh = isMask && rec.maskRect !== null ? rec.maskRect.bottom - rec.maskRect.top : h
      if (ch.length >= 2) {
        const compression = r.u16()
        const plane = decodeChannel(r, compression, mw, mh, end, big)
        if (ch.id === -2 && rec.maskRect !== null) mask = { ...rec.maskRect, data: plane }
        else if (!isMask) planes.set(ch.id, plane)
      }
      r.pos = end
    }
    let rgba: Uint8Array | null = null
    if (w > 0 && h > 0) {
      rgba = new Uint8Array(w * h * 4)
      const red = planes.get(0)
      const green = colorMode === COLOR_MODE_GRAYSCALE ? red : planes.get(1)
      const blue = colorMode === COLOR_MODE_GRAYSCALE ? red : planes.get(2)
      const alpha = planes.get(-1)
      for (let p = 0; p < w * h; p++) {
        rgba[p * 4] = red?.[p] ?? 0
        rgba[p * 4 + 1] = green?.[p] ?? 0
        rgba[p * 4 + 2] = blue?.[p] ?? 0
        rgba[p * 4 + 3] = alpha?.[p] ?? 255
      }
    }
    layers.push({
      name: rec.name, id: rec.id, top: rec.top, left: rec.left, bottom: rec.bottom, right: rec.right,
      hidden: rec.hidden, kind: rec.kind, opacity: rec.opacity, blendMode: rec.blendMode, clipping: rec.clipping, rgba, mask,
    })
  }
  void layerAndMaskEnd
  return { version, width, height, depth, colorMode, layers }
}

/** 一个通道的像素(行从上到下) */
function decodeChannel(r: Reader, compression: number, w: number, h: number, end: number, big: boolean): Uint8Array {
  const out = new Uint8Array(Math.max(0, w * h))
  if (w <= 0 || h <= 0) return out
  if (compression === 0) {
    out.set(r.bytes.subarray(r.pos, r.pos + w * h))
    return out
  }
  if (compression === 1) {
    const rowLengths: number[] = []
    for (let y = 0; y < h; y++) rowLengths.push(big ? r.u32() : r.u16())
    for (let y = 0; y < h; y++) {
      const rowEnd = r.pos + rowLengths[y]!
      let x = 0
      while (r.pos < rowEnd && x < w) {
        const n = r.view.getInt8(r.pos++)
        if (n >= 0) {
          for (let k = 0; k <= n && x < w; k++) out[y * w + x++] = r.bytes[r.pos++]!
        } else if (n !== -128) {
          const v = r.bytes[r.pos++]!
          for (let k = 0; k < 1 - n && x < w; k++) out[y * w + x++] = v
        }
      }
      r.pos = rowEnd
    }
    return out
  }
  if (compression === 2 || compression === 3) {
    const raw = inflateSync(r.bytes.subarray(r.pos, end))
    out.set(raw.subarray(0, w * h))
    if (compression === 3) {
      // 预测:每行逐字节累加
      for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) out[y * w + x] = (out[y * w + x]! + out[y * w + x - 1]!) & 0xff
    }
    return out
  }
  throw new Error(`不认识的通道压缩方式 ${compression}`)
}
