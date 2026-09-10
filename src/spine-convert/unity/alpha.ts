import type { Image } from '../../unity/png.ts'

/**
 * 预乘 alpha(PMA)→ 直通 alpha。
 *
 * Spine 导给 spine-unity 的图集**默认是预乘 alpha**的(spine-unity 的 shader 按 PMA 采样),
 * 实测 MergeCooking2 全部图集和 MX2_cat 都是:半透明像素里没有一个 RGB 大于 alpha。
 * Unity 自带的 sprite 材质(Sprites/Default、URP Sprite-Unlit)按**直通 alpha** 混合:
 * `out = rgb × a + dst × (1 − a)`。拿 PMA 贴图喂它,rgb 等于被乘了两次 alpha ——
 * 半透明越多的部件越发黑。blackrichwoman 的 `face4`(生气时脸上的红晕,几乎全是半透明笔触)
 * 就这样变成了一块深色的「叠加物」;实心图只在边缘有一圈暗边,不容易察觉。
 *
 * 所以烘焙前把源图还原成直通 alpha:rgb = rgb × 255 / a。alpha 很小的像素精度会掉,
 * 这是预乘本身丢掉的信息,还原不回来;a = 0 的像素颜色无意义,置 0(`.meta` 里
 * `alphaIsTransparency: 1` 会让 Unity 导入时把边缘颜色向透明区扩散,双线性采样不会串黑)。
 *
 * 3.8 的 `.atlas` 没有 pma 字段,只能看像素判断;4.x 有 `pma: true` 就直接信。
 */

/** 半透明像素少于这个数就不下结论 —— 样本太少,判断不可靠 */
const MIN_SEMI_TRANSPARENT = 64

/**
 * 这张图是不是预乘 alpha:所有半透明像素的每个通道都 ≤ alpha(留 2 的余量)。
 * 半透明像素太少时返回 false(不动它)。
 */
export function detectPremultiplied(image: Image): boolean {
  let semi = 0
  let over = 0
  const d = image.data
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]!
    if (a === 0 || a === 255) continue
    semi++
    if (d[i]! > a + 2 || d[i + 1]! > a + 2 || d[i + 2]! > a + 2) over++
  }
  if (semi < MIN_SEMI_TRANSPARENT) return false
  // 无损 PNG 里预乘图不该有任何越界像素;留千分之二容错
  return over <= semi * 0.002
}

/** 返回一张新图,不改原图 */
export function unpremultiply(image: Image): Image {
  const src = image.data
  const out = new Uint8Array(src.length)
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3]!
    out[i + 3] = a
    if (a === 255) {
      out[i] = src[i]!
      out[i + 1] = src[i + 1]!
      out[i + 2] = src[i + 2]!
    } else if (a > 0) {
      out[i] = Math.min(255, Math.round((src[i]! * 255) / a))
      out[i + 1] = Math.min(255, Math.round((src[i + 1]! * 255) / a))
      out[i + 2] = Math.min(255, Math.round((src[i + 2]! * 255) / a))
    }
    // a === 0:留 0
  }
  return { width: image.width, height: image.height, data: out }
}
