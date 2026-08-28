import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SpineInput } from './input.ts'
import { readSkeletonPart } from './readSkeleton.ts'

describe('SpineInput 基础类型', () => {
  const of = (...bytes: number[]) => new SpineInput(new Uint8Array(bytes))

  it('float 是大端', () => {
    // 0x3F800000 = 1.0(大端);小端读会得到别的值
    expect(of(0x3f, 0x80, 0x00, 0x00).readFloat()).toBe(1)
  })

  it('int 是大端', () => {
    expect(of(0x00, 0x00, 0x01, 0x00).readInt()).toBe(256)
  })

  it('varint 单字节', () => {
    expect(of(0x12).readVarInt()).toBe(18)
  })

  it('varint 多字节 —— 每字节 7 位,高位表示还有下一字节', () => {
    // 0x80|0x01 表示低 7 位是 1 且continue,再来 0x01 → 1 | (1<<7) = 129
    expect(of(0x81, 0x01).readVarInt()).toBe(129)
  })

  it('varint 的 zigzag 形式能表示小负数', () => {
    expect(of(0x00).readVarInt(false)).toBe(0)
    expect(of(0x01).readVarInt(false)).toBe(-1)
    expect(of(0x02).readVarInt(false)).toBe(1)
  })

  it('字符串长度值是字节数 + 1', () => {
    expect(of(0x00).readString()).toBeNull() // 0 = null
    expect(of(0x01).readString()).toBe('') // 1 = 空串
    expect(of(0x03, 0x68, 0x69).readString()).toBe('hi') // 3 = 2 字节
  })

  it('UTF-8 多字节字符', () => {
    // "猫" = E7 8C AB,3 字节 → 长度 4
    expect(of(0x04, 0xe7, 0x8c, 0xab).readString()).toBe('猫')
  })

  it('stringRef 的 0 表示 null,其余是表里下标 + 1', () => {
    const input = of(0x00, 0x02)
    input.strings = ['a', 'b']
    expect(input.readStringRef()).toBeNull()
    expect(input.readStringRef()).toBe('b')
  })

  it('读过界时报错而不是返回垃圾', () => {
    expect(() => of(0x01).readFloat()).toThrow(/读到文件尾之后/)
  })
})

/**
 * 拿真实的 `.skel` 验证 —— 同一骨架的两个版本导出,各项数量必须一致。
 * 字节布局错一处,计数就会变成垃圾,合成用例发现不了。
 *
 * res/ 不进仓库(用户的授权资源),文件不在时跳过。
 */
const FILES = {
  '3.8': 'res/spine/3.8/MX2_cat.skel.bytes',
  '4.1': 'res/spine/4.1/MX2_cat.skel.bytes',
} as const

const bothExist = Object.values(FILES).every(existsSync)

describe.skipIf(!bothExist)('真实 .skel 文件', () => {
  const read = (path: string) => readSkeletonPart(new Uint8Array(readFileSync(path)))
  const v38 = () => read(FILES['3.8'])
  const v41 = () => read(FILES['4.1'])

  it('识别出版本与格式分支', () => {
    expect(v38().header).toMatchObject({ version: '3.8.95', major: '3.8' })
    expect(v41().header).toMatchObject({ version: '4.1.23', major: '4.x' })
  })

  it('两版的骨骼数量与名字完全一致', () => {
    const a = v38().bones
    const b = v41().bones
    expect(a.length).toBe(38)
    expect(b.map((x) => x.name)).toEqual(a.map((x) => x.name))
  })

  it('两版的 slot 数量与名字完全一致', () => {
    const a = v38().slots
    const b = v41().slots
    expect(a.length).toBe(13)
    expect(b.map((x) => x.name)).toEqual(a.map((x) => x.name))
  })

  it('两版的约束数量一致', () => {
    expect(v38().ik.length).toBe(v41().ik.length)
    expect(v38().transform.length).toBe(v41().transform.length)
  })

  it('3.8 的 transform mix 单值被复制到两个轴 —— 升级方向无损', () => {
    for (const t of v38().transform) {
      expect(t.mixX).toBe(t.mixY)
      expect(t.mixScaleX).toBe(t.mixScaleY)
    }
  })

  it('骨骼层级合法:父骨骼下标必须小于自身', () => {
    for (const s of [v38(), v41()]) {
      s.bones.forEach((bone, i) => {
        expect(bone.parent, `${bone.name}`).toBeLessThan(i)
      })
    }
  })

  it('slot 引用的骨骼下标在范围内', () => {
    for (const s of [v38(), v41()]) {
      for (const slot of s.slots) {
        expect(slot.bone).toBeGreaterThanOrEqual(0)
        expect(slot.bone).toBeLessThan(s.bones.length)
      }
    }
  })
})
