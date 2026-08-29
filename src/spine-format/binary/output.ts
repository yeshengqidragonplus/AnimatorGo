/**
 * `.skel` 二进制写入。是 [input.ts](./input.ts) 的镜像 ——
 * 每个 read 方法都有一个对应的 write,字节编码必须完全一致。
 *
 * ⚠️ **大端**,和读取端一样。
 */
export class SpineOutput {
  private bytes: Uint8Array
  private view: DataView
  private pos = 0

  /** 字符串表。writeStringRef 靠它把字符串换回索引。 */
  strings: readonly (string | null)[] = []

  constructor(initialCapacity = 1 << 16) {
    this.bytes = new Uint8Array(initialCapacity)
    this.view = new DataView(this.bytes.buffer)
  }

  private ensure(n: number): void {
    if (this.pos + n <= this.bytes.length) return
    let size = this.bytes.length * 2
    while (size < this.pos + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.bytes)
    this.bytes = next
    this.view = new DataView(next.buffer)
  }

  get length(): number {
    return this.pos
  }

  toUint8Array(): Uint8Array {
    return this.bytes.slice(0, this.pos)
  }

  writeByte(value: number): void {
    this.ensure(1)
    this.view.setUint8(this.pos++, value & 0xff)
  }

  writeSByte(value: number): void {
    this.ensure(1)
    this.view.setInt8(this.pos++, value)
  }

  writeBoolean(value: boolean): void {
    this.writeByte(value ? 1 : 0)
  }

  writeFloat(value: number): void {
    this.ensure(4)
    this.view.setFloat32(this.pos, value, false) // false = 大端
    this.pos += 4
  }

  writeInt(value: number): void {
    this.ensure(4)
    this.view.setInt32(this.pos, value | 0, false)
    this.pos += 4
  }

  /**
   * 变长整数。`optimizePositive = false` 时先做 zigzag 编码。
   *
   * ⚠️ 必须和读取端的分段方式完全一致:每字节 7 位,最高位表示还有下一字节,
   * 且最多 5 字节。多写或少写一个字节,后面全错位。
   */
  writeVarInt(value: number, optimizePositive = true): void {
    let v = optimizePositive ? value >>> 0 : ((value << 1) ^ (value >> 31)) >>> 0

    for (;;) {
      const chunk = v & 0x7f
      v >>>= 7
      if (v === 0) {
        this.writeByte(chunk)
        return
      }
      this.writeByte(chunk | 0x80)
    }
  }

  /** 长度前缀 UTF-8。**长度值 = 字节数 + 1**;null 写 0,空串写 1。 */
  writeString(value: string | null): void {
    if (value === null) {
      this.writeVarInt(0)
      return
    }
    if (value === '') {
      this.writeVarInt(1)
      return
    }
    const encoded = new TextEncoder().encode(value)
    this.writeVarInt(encoded.length + 1)
    this.ensure(encoded.length)
    this.bytes.set(encoded, this.pos)
    this.pos += encoded.length
  }

  /**
   * 按**原始索引**写字符串表引用。0 表示 null。
   *
   * ⚠️ 不能用 `strings.indexOf(值)` 反查 —— 字符串表允许有重复项
   * (实测 "bubble" 出现 3 次),反查只会命中第一个,写出来的文件索引就错了。
   */
  writeStringRefIndex(index: number): void {
    this.writeVarInt(index)
  }

  /** 4.x 的 8 字节 hash,以十六进制字符串形式传入 */
  writeLongHex(hex: string): void {
    for (let i = 0; i < 8; i++) {
      this.writeByte(parseInt(hex.slice(i * 2, i * 2 + 2), 16))
    }
  }

  writeBytes(raw: Uint8Array): void {
    this.ensure(raw.length)
    this.bytes.set(raw, this.pos)
    this.pos += raw.length
  }
}
