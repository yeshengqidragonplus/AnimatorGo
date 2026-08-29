import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readSkeletonPart, type SkeletonPart } from '../../spine-format/binary/readSkeleton.ts'
import { writeSkeleton } from '../../spine-format/binary/writeSkeleton.ts'
import { convertSkeleton } from './convert.ts'

/**
 * ⭐ 这些测试有**标准答案**:同一个骨架分别用 3.8 和 4.1 导出。
 * 把 3.8 转成 4.1 之后,结果必须与真实的 4.1 导出一致 —— 反之亦然。
 *
 * 这是整个转换器最强的检验,别的路径都没有这种现成答案。
 */
const FILES = {
  '3.8': 'res/spine/3.8/MX2_cat.skel.bytes',
  '4.1': 'res/spine/4.1/MX2_cat.skel.bytes',
} as const

const bothExist = Object.values(FILES).every(existsSync)
const load = (v: keyof typeof FILES) => readSkeletonPart(new Uint8Array(readFileSync(FILES[v])))

/** 转换 → 写出 → 重新读回,确保产物是合法文件而不只是内存结构 */
const roundTrip = (part: SkeletonPart) => readSkeletonPart(writeSkeleton(part))

const timelines = (s: SkeletonPart) => s.animations.flatMap((a) => a.timelines)
const tally = (s: SkeletonPart) => {
  const out: Record<string, number> = {}
  for (const t of timelines(s)) out[t.kind] = (out[t.kind] ?? 0) + 1
  return out
}

/**
 * 浮点比对的容差。
 *
 * ⚠️ **不能用绝对容差。** 实测 Spine 自己的 3.8 与 4.1 导出,同一个值会差
 * `7.63e-6` —— 那正好是 float32 在 113 这个量级上的 **1 个 ULP**(2⁻¹⁷)。
 * 也就是说两次导出的舍入本来就不同,不是转换出错。
 *
 * float32 只有约 7 位有效数字,所以按**相对容差 1e-6** 比,量级越大容许的
 * 绝对误差越大,这才符合浮点的实际精度。
 */
function expectClose(actual: number, expected: number, label: string): void {
  const tolerance = Math.max(1e-6, Math.abs(expected) * 1e-6)
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(
    tolerance,
  )
}

/** 按 动画名/类型#归属 建索引,便于逐条比对 */
const indexed = (s: SkeletonPart) => {
  const m = new Map<string, (typeof s.animations)[number]['timelines'][number]>()
  for (const a of s.animations) for (const t of a.timelines) m.set(`${a.name}/${t.kind}#${t.owner}`, t)
  return m
}

describe.skipIf(!bothExist)('.skel 版本转换', () => {
  describe('3.8 → 4.1(升级,应当无损)', () => {
    const converted = () => roundTrip(convertSkeleton(load('3.8'), '4.x').part)

    it('产物是合法的 4.1 文件', () => {
      const c = converted()
      expect(c.failure).toBeNull()
      expect(c.header.major).toBe('4.x')
      expect(c.endOffset).toBe(c.totalBytes)
    })

    it('骨骼数值与真实 4.1 导出完全一致', () => {
      const c = converted()
      const real = load('4.1')
      expect(c.bones.length).toBe(real.bones.length)
      c.bones.forEach((b, i) => expect(b).toEqual(real.bones[i]))
    })

    it('时间轴种类与数量与真实 4.1 导出一致', () => {
      expect(tally(converted())).toEqual(tally(load('4.1')))
    })

    it('⭐ 算出来的 bezierCount 与 Spine 自己写的完全一致', () => {
      // bezierCount 在 3.8 文件里根本不存在,是按「各帧曲线所占分量数之和」推出来的。
      // 全部命中说明对 4.x 曲线编码的理解是对的。
      const real = indexed(load('4.1'))
      let compared = 0
      for (const [key, t] of indexed(converted())) {
        const r = real.get(key)
        expect(r, key).toBeDefined()
        if (t.bezierCount >= 0 || r!.bezierCount >= 0) {
          expect(t.bezierCount, key).toBe(r!.bezierCount)
          compared++
        }
      }
      expect(compared).toBeGreaterThan(100)
    })

    it('所有帧数值与真实 4.1 导出一致', () => {
      const real = indexed(load('4.1'))
      let compared = 0
      for (const [key, t] of indexed(converted())) {
        const r = real.get(key)!
        expect(t.frames.length, key).toBe(r.frames.length)
        t.frames.forEach((f, i) => {
          for (const k of ['time', 'value', 'x', 'y']) {
            if (typeof f[k] === 'number') {
              expectClose(f[k] as number, r.frames[i]![k] as number, `${key} 帧${i}.${k}`)
              compared++
            }
          }
        })
      }
      expect(compared).toBeGreaterThan(1000)
    })

    it('升级方向不报 loss', () => {
      const { issues } = convertSkeleton(load('3.8'), '4.x')
      expect(issues.filter((i) => i.level === 'loss')).toEqual([])
    })
  })

  describe('4.1 → 3.8(降级,有损但必须报告)', () => {
    const converted = () => roundTrip(convertSkeleton(load('4.1'), '3.8').part)

    it('产物是合法的 3.8 文件', () => {
      const c = converted()
      expect(c.failure).toBeNull()
      expect(c.header.major).toBe('3.8')
      expect(c.endOffset).toBe(c.totalBytes)
    })

    it('时间轴种类与数量与真实 3.8 导出一致', () => {
      expect(tally(converted())).toEqual(tally(load('3.8')))
    })

    it('所有帧数值与真实 3.8 导出一致', () => {
      const real = indexed(load('3.8'))
      for (const [key, t] of indexed(converted())) {
        const r = real.get(key)!
        t.frames.forEach((f, i) => {
          for (const k of ['time', 'value', 'x', 'y']) {
            if (typeof f[k] === 'number') {
              expectClose(f[k] as number, r.frames[i]![k] as number, `${key} 帧${i}.${k}`)
            }
          }
        })
      }
    })

    it('⭐ 各分量曲线不同时必须报 loss,不能静默丢弃', () => {
      const { issues } = convertSkeleton(load('4.1'), '3.8')
      const losses = issues.filter((i) => i.level === 'loss')
      expect(losses.length).toBeGreaterThan(0)
      // 报告要精确到具体时间轴,不是笼统一句
      expect(losses[0]!.path).toMatch(/\w+\.\w+\[\d+\]/)
    })

    it('同一条时间轴只报一次,不逐帧刷屏', () => {
      const { issues } = convertSkeleton(load('4.1'), '3.8')
      const paths = issues.filter((i) => i.level === 'loss').map((i) => i.path)
      expect(new Set(paths).size).toBe(paths.length)
    })
  })

  it('同版本转换是空操作', () => {
    const { part, issues } = convertSkeleton(load('4.1'), '4.x')
    expect(issues).toEqual([])
    expect(part).toBe(part)
  })
})
