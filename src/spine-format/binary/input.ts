/**
 * `.skel` 二进制读取的基础类型。按 docs/SPINE-BINARY.md 第 1 节实现。
 *
 * ⚠️ **大端**。多数二进制格式是小端,这个不是,读错了所有数值都是垃圾。
 */
export class SpineInput {
  private readonly view: DataView
  private pos = 0

  /** 文件头的字符串表,readStringRef 用 */
  strings: (string | null)[] = []

  private readonly bytes: Uint8Array

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  get offset(): number {
    return this.pos
  }

  get remaining(): number {
    return this.bytes.length - this.pos
  }

  get atEnd(): boolean {
    return this.pos >= this.bytes.length
  }

  private need(n: number): void {
    if (this.pos + n > this.bytes.length) {
      throw new Error(
        `读到文件尾之后:偏移 ${this.pos} 处要 ${n} 字节,只剩 ${this.remaining}。` +
          `通常意味着前面某个字段的布局理解错了。`,
      )
    }
  }

  readByte(): number {
    this.need(1)
    return this.view.getUint8(this.pos++)
  }

  readSByte(): number {
    this.need(1)
    return this.view.getInt8(this.pos++)
  }

  readBoolean(): boolean {
    return this.readByte() !== 0
  }

  readFloat(): number {
    this.need(4)
    const v = this.view.getFloat32(this.pos, false) // false = 大端
    this.pos += 4
    return v
  }

  readInt(): number {
    this.need(4)
    const v = this.view.getInt32(this.pos, false)
    this.pos += 4
    return v
  }

  /**
   * 变长整数。每字节低 7 位是数据,最高位表示"还有下一字节"。
   *
   * `optimizePositive = false` 时用 zigzag 编码,让小负数也只占一字节。
   * 计数和索引一律用 true。
   */
  readVarInt(optimizePositive = true): number {
    let b = this.readByte()
    let value = b & 0x7f

    if ((b & 0x80) !== 0) {
      b = this.readByte()
      value |= (b & 0x7f) << 7
      if ((b & 0x80) !== 0) {
        b = this.readByte()
        value |= (b & 0x7f) << 14
        if ((b & 0x80) !== 0) {
          b = this.readByte()
          value |= (b & 0x7f) << 21
          if ((b & 0x80) !== 0) {
            b = this.readByte()
            value |= (b & 0x7f) << 28
          }
        }
      }
    }

    // zigzag 还原:最低位是符号
    return optimizePositive ? value : (value >>> 1) ^ -(value & 1)
  }

  /**
   * 长度前缀的 UTF-8 字符串。
   *
   * **长度值 = 实际字节数 + 1** —— 0 表示 null,1 表示空串。
   */
  readString(): string | null {
    const length = this.readVarInt()
    if (length === 0) return null
    if (length === 1) return ''

    const byteCount = length - 1
    this.need(byteCount)
    const slice = this.bytes.subarray(this.pos, this.pos + byteCount)
    this.pos += byteCount
    return new TextDecoder('utf-8').decode(slice)
  }

  /**
   * 指向文件头字符串表的索引;0 表示 null。
   *
   * ⚠️ **字符串表允许有重复项**(实测 MX2_cat 里 "bubble" 出现 3 次),
   * 所以只保留解析后的字符串是不够的 —— 写回时无法还原是哪一个下标。
   * 用 readStringRefAt 拿到原始索引。
   */
  readStringRef(): string | null {
    return this.readStringRefAt().value
  }

  /** 同时给出原始索引与解析结果 */
  readStringRefAt(): { index: number; value: string | null } {
    const index = this.readVarInt()
    return { index, value: index === 0 ? null : (this.strings[index - 1] ?? null) }
  }

  /** 4.x 的 hash 是 8 字节。这里只跳过并返回十六进制,内容用不上。 */
  readLongHex(): string {
    this.need(8)
    let hex = ''
    for (let i = 0; i < 8; i++) hex += this.readByte().toString(16).padStart(2, '0')
    return hex
  }

  skip(n: number): void {
    this.need(n)
    this.pos += n
  }
}
