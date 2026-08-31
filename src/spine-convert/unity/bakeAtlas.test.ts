import { describe, expect, it } from 'vitest'
import { parseAtlas } from '../../core/atlas.ts'
import { blankImage, type Image } from '../../unity/png.ts'
import { bakeAtlas } from './bakeAtlas.ts'

/**
 * 旋转方向只有两种可能,选错了图就是倒着的 —— 用一张标记图钉死它。
 *
 * 造一个 4×2 的「摆正图」,四个角各涂一个不同的颜色,再手工把它按
 * **逆时针 90°** 摆进图集(这就是 Spine 的 `rotate: true`),
 * 看烘焙能不能把它转回来。
 */

const RED = [255, 0, 0, 255]
const GREEN = [0, 255, 0, 255]
const BLUE = [0, 0, 255, 255]
const WHITE = [255, 255, 255, 255]

function put(image: Image, x: number, y: number, rgba: readonly number[]): void {
  const i = (y * image.width + x) * 4
  image.data.set(rgba, i)
}

function get(image: Image, x: number, y: number): number[] {
  const i = (y * image.width + x) * 4
  return [...image.data.subarray(i, i + 4)]
}

describe('图集烘焙', () => {
  it('把躺着的区域摆正 —— 四个角要落回原位', () => {
    // 摆正后是 4 宽 2 高;逆时针转 90° 之后在图集里占 2 宽 4 高
    //
    //   摆正:  R . . G          图集(逆时针转 90°):  G W
    //          B . . W                                . .
    //                                                 . .
    //                                                 R B
    //
    // 逆时针转 90° 会把左上角送到左下角,所以图集里最下面一行是摆正图的最左一列
    const page = blankImage(8, 8)
    put(page, 0, 3, RED) // 摆正图 (0,0)
    put(page, 1, 3, BLUE) // 摆正图 (0,1)
    put(page, 0, 0, GREEN) // 摆正图 (3,0)
    put(page, 1, 0, WHITE) // 摆正图 (3,1)

    const atlas = parseAtlas(
      ['page.png', 'size: 8,8', 'filter: Linear,Linear', 'mark', '  rotate: true', '  xy: 0, 0', '  size: 4, 2', '  orig: 4, 2', '  offset: 0, 0', '  index: -1'].join('\n'),
    )

    const baked = bakeAtlas(atlas, new Map([['page.png', page]]), ['mark'])
    const rect = baked.rects.get('mark')!
    expect([rect.width, rect.height]).toEqual([4, 2])

    // 转成 PNG 的行序(原点左上)再取像素
    const out = baked.pages[rect.page]!
    const top = out.height - rect.y - rect.height
    expect(get(out, rect.x, top)).toEqual(RED)
    expect(get(out, rect.x + 3, top)).toEqual(GREEN)
    expect(get(out, rect.x, top + 1)).toEqual(BLUE)
    expect(get(out, rect.x + 3, top + 1)).toEqual(WHITE)
  })

  it('没旋转的区域原样搬过去', () => {
    const page = blankImage(8, 8)
    put(page, 2, 5, RED)
    put(page, 4, 5, GREEN)

    const atlas = parseAtlas(
      ['page.png', 'size: 8,8', 'filter: Linear,Linear', 'flat', '  rotate: false', '  xy: 2, 5', '  size: 3, 1', '  orig: 3, 1', '  offset: 0, 0', '  index: -1'].join('\n'),
    )

    const baked = bakeAtlas(atlas, new Map([['page.png', page]]), ['flat'])
    const rect = baked.rects.get('flat')!
    const out = baked.pages[rect.page]!
    const top = out.height - rect.y - rect.height
    expect(get(out, rect.x, top)).toEqual(RED)
    expect(get(out, rect.x + 2, top)).toEqual(GREEN)
  })

  it('图集里没有的区域进 missing,不是静默跳过', () => {
    const atlas = parseAtlas(['page.png', 'size: 4,4', 'filter: Linear,Linear'].join('\n'))
    const baked = bakeAtlas(atlas, new Map([['page.png', blankImage(4, 4)]]), ['nope'])
    expect(baked.missing).toEqual(['nope'])
  })
})
