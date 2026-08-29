import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readSkeletonPart, type SkeletonPart } from '../binary/readSkeleton.ts'
import { toJson, toJsonText } from './toJson.ts'
import { fromJson, fromJsonText } from './fromJson.ts'

/**
 * JSON 与 `.skel` 是同一份数据的两种编码,所以 `skel → json → 模型` 必须
 * 与直接读 skel 得到的模型一致。
 *
 * ⚠️ **不能要求逐字节相同** —— JSON 里没有字符串表,读回来时是重建的,
 * 下标与原文件不同。所以比对的是**结构与数值**。
 * 逐字节相同只适用于 `skel → skel`(见 roundTrip.test.ts)。
 */
const FILES = {
  '3.8': 'res/spine/3.8/MX2_cat.skel.bytes',
  '4.1': 'res/spine/4.1/MX2_cat.skel.bytes',
} as const

const bothExist = Object.values(FILES).every(existsSync)

const timelineKey = (name: string, kind: string, owner: number) => `${name}/${kind}#${owner}`
const indexed = (s: SkeletonPart) => {
  const m = new Map<string, (typeof s.animations)[number]['timelines'][number]>()
  for (const a of s.animations) for (const t of a.timelines) m.set(timelineKey(a.name, t.kind, t.owner), t)
  return m
}

describe.skipIf(!bothExist)('Spine JSON 编解码', () => {
  for (const [version, path] of Object.entries(FILES)) {
    describe(version, () => {
      const original = () => readSkeletonPart(new Uint8Array(readFileSync(path)))
      const viaJson = () => fromJson(toJson(original()))

      it('产出的 JSON 结构符合 Spine 惯例', () => {
        const j = toJson(original())
        expect(Object.keys(j)).toContain('skeleton')
        expect(Object.keys(j)).toContain('bones')
        expect(Object.keys(j)).toContain('animations')
        // 父骨骼用名字引用,不是下标
        expect((j['bones'] as Record<string, unknown>[])[1]!['parent']).toBe('root')
        // 版本号写在 skeleton.spine
        expect((j['skeleton'] as Record<string, unknown>)['spine']).toContain(version)
      })

      it('3.8 用 deform 段,4.x 用 attachments 段', () => {
        const j = toJson(original())
        const anim = (j['animations'] as Record<string, Record<string, unknown>>)['idle']!
        expect(Object.keys(anim)).toContain(version === '3.8' ? 'deform' : 'attachments')
      })

      it('骨骼逐字段与直接读 skel 一致', () => {
        const a = original()
        const b = viaJson()
        expect(b.bones.length).toBe(a.bones.length)
        b.bones.forEach((bone, i) => expect(bone).toEqual(a.bones[i]))
      })

      it('slot / 约束 / 皮肤的数量一致', () => {
        const a = original()
        const b = viaJson()
        expect(b.slots.length).toBe(a.slots.length)
        expect(b.ik.length).toBe(a.ik.length)
        expect(b.transform.length).toBe(a.transform.length)
        expect(b.skins.length).toBe(a.skins.length)
        const att = (s: SkeletonPart) => s.skins.flatMap((k) => k.slots.flatMap((e) => e.attachments)).length
        expect(att(b)).toBe(att(a))
      })

      it('时间轴数量与种类一致', () => {
        const a = original()
        const b = viaJson()
        expect([...indexed(b).keys()].sort()).toEqual([...indexed(a).keys()].sort())
      })

      it('✅ 所有帧数值精确一致(JSON 是文本,不该有精度损失)', () => {
        const a = indexed(original())
        let compared = 0
        for (const [key, t] of indexed(viaJson())) {
          const r = a.get(key)!
          expect(t.frames.length, key).toBe(r.frames.length)
          t.frames.forEach((f, i) => {
            for (const k of ['time', 'value', 'x', 'y', 'mix']) {
              if (typeof f[k] === 'number') {
                expect(f[k], `${key} 帧${i}.${k}`).toBe(r.frames[i]![k])
                compared++
              }
            }
          })
        }
        expect(compared).toBeGreaterThan(1000)
      })

      it('JSON 文本可解析且二次往返稳定', () => {
        const text = toJsonText(original())
        const once = fromJsonText(text)
        const twice = fromJson(toJson(once))
        expect(twice.bones).toEqual(once.bones)
        expect(twice.slots).toEqual(once.slots)
      })
    })
  }
})
