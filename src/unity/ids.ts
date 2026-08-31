/**
 * Unity 资源标识符的确定性生成。
 *
 * ⚠️ **每次导出必须得到同样的 ID。** Unity 靠 GUID 认资源、靠 fileID 认资源里的对象;
 * 重新导出一遍就换一批 ID 的话,场景里、动画里、prefab 里所有引用会**全部断掉**,
 * 而且断得悄无声息(Missing 引用在 Inspector 里只是一行灰字)。
 *
 * 所以这里一律用「名字 → 哈希」,不用随机数、不用时间戳、不用计数器。
 */

/** 32 位 FNV-1a,带一个种子用来生成互不相关的多路哈希 */
function fnv1a(seed: string, salt: number): number {
  let h = (0x811c9dc5 ^ salt) >>> 0
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0
  }
  // 末尾再搅一轮,避免短字符串的低位分布太规整
  h ^= h >>> 15
  h = Math.imul(h, 0x2545f491) >>> 0
  h ^= h >>> 13
  return h >>> 0
}

const hex8 = (v: number) => v.toString(16).padStart(8, '0')

/**
 * 32 位十六进制的 Unity GUID。
 *
 * Unity 自己生成的是随机的;我们要的是可复现,所以拼四路哈希。
 * 只要**输入名字不同就够分散**,不需要密码学强度。
 */
export function unityGuid(seed: string): string {
  return hex8(fnv1a(seed, 0)) + hex8(fnv1a(seed, 0x9e3779b9)) + hex8(fnv1a(seed, 0x85ebca6b)) + hex8(fnv1a(seed, 0xc2b2ae35))
}

/**
 * sprite 在纹理里的 `internalID`,**有符号 32 位**,0 被 Unity 当作空引用。
 *
 * 真实样本里正负都有(`147326889` / `-262988454`),所以这里也允许负数。
 */
export function internalId(seed: string): number {
  const v = fnv1a(seed, 0x27d4eb2f) | 0
  return v === 0 ? 1 : v
}

/**
 * prefab / 动画文件里对象的 fileID。
 *
 * Unity 的 fileID 是 int64,但 JS 的安全整数只有 53 位 —— 超了在字符串化时会失真,
 * 写出去就是一个对不上的数字。所以这里只取 52 位。
 */
export function fileId(seed: string): number {
  const hi = fnv1a(seed, 0x1b873593)
  const lo = fnv1a(seed, 0xcc9e2d51)
  const value = hi * 0x100000 + (lo % 0x100000)
  return value === 0 ? 1 : value
}

/**
 * 在一组种子上生成互不冲突的 ID。
 *
 * 哈希会撞 —— 概率低但不是零,而撞了之后 Unity 只会加载到其中一个,
 * 表现为「某张图莫名其妙变成了另一张」。撞上就往种子后面加后缀重算。
 */
export function uniqueIds<T>(seeds: readonly string[], make: (seed: string) => T): Map<string, T> {
  const out = new Map<string, T>()
  const used = new Set<T>()
  for (const seed of seeds) {
    let candidate = make(seed)
    let salt = 0
    while (used.has(candidate)) candidate = make(`${seed}#${++salt}`)
    used.add(candidate)
    out.set(seed, candidate)
  }
  return out
}
