/**
 * 标准 CRC32(与 zlib 一致)。
 *
 * Unity 用它给 Blend Shape 的名字算 `nameHash`,也用它算 `.anim` 里
 * `m_ClipBindingConstant` 的 path / attribute 哈希 —— 实测 `shape0` → 2081338680、
 * `m_SortingOrder` → 3762991556,与 zlib 的 CRC32 逐个吻合。
 *
 * 自己实现而不用 `node:zlib`:Electron 里的 Node 版本不一定有 `zlib.crc32`(22.2 才加)。
 */

const TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  TABLE[n] = c >>> 0
}

export function crc32(text: string): number {
  const bytes = new TextEncoder().encode(text)
  let crc = 0xffffffff
  for (const byte of bytes) crc = TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
