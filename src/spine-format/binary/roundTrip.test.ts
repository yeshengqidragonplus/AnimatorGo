import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readSkeletonPart } from './readSkeleton.ts'
import { writeSkeleton } from './writeSkeleton.ts'

/**
 * 往返测试:读进来再写回去,必须与原文件**逐字节相同**。
 *
 * 这是本项目最硬的一条检验 —— 它同时证明:
 *   1. 读取器理解了文件里的每一个字节
 *   2. 模型没有丢失任何信息(丢了就写不回去)
 *   3. 写入器的字节编码与读取器完全对称
 *
 * 转换器的正确性建立在这条之上:只有往返无损,才谈得上「只改该改的字段」。
 */
const FILES = {
  '3.8': 'res/spine/3.8/MX2_cat.skel.bytes',
  '4.1': 'res/spine/4.1/MX2_cat.skel.bytes',
} as const

const bothExist = Object.values(FILES).every(existsSync)

describe.skipIf(!bothExist)('.skel 往返', () => {
  for (const [version, path] of Object.entries(FILES)) {
    describe(version, () => {
      const original = () => new Uint8Array(readFileSync(path))

      it('写出的长度与原文件一致', () => {
        expect(writeSkeleton(readSkeletonPart(original())).length).toBe(original().length)
      })

      it('✅ 逐字节相同 —— 任何一位读错或丢失都会在这里暴露', () => {
        const orig = original()
        const out = writeSkeleton(readSkeletonPart(orig))

        let firstDiff = -1
        for (let i = 0; i < Math.min(orig.length, out.length); i++) {
          if (orig[i] !== out[i]) {
            firstDiff = i
            break
          }
        }
        expect(firstDiff, firstDiff < 0 ? '' : `首个差异在偏移 ${firstDiff}`).toBe(-1)
      })

      it('二次往返稳定(写出的文件能再读一遍并得到相同结果)', () => {
        const once = writeSkeleton(readSkeletonPart(original()))
        const twice = writeSkeleton(readSkeletonPart(once))
        expect([...twice]).toEqual([...once])
      })
    })
  }

  it('字符串表允许有重复项 —— 所以必须存原始索引而非按字符串反查', () => {
    const s = readSkeletonPart(new Uint8Array(readFileSync(FILES['3.8'])))
    const dups = s.strings.filter((x, i) => s.strings.indexOf(x) !== i)
    // 这个样本里 "bubble" 出现三次;若换了样本没有重复也不该让测试失败,
    // 但只要有重复,indexOf 反查就一定写错索引 —— 上面的逐字节测试会抓到
    expect(dups.length).toBeGreaterThan(0)
  })
})
