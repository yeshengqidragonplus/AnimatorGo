import { describe, expect, it } from 'vitest'
import type { BoneRecord, SkeletonPart } from './readSkeleton.ts'
import { readSkeletonPart } from './readSkeleton.ts'
import type { AnimationData, EventDef, Timeline } from './readAnimations.ts'
import { writeSkeleton } from './writeSkeleton.ts'
import { toJson } from '../json/toJson.ts'
import { fromJson } from '../json/fromJson.ts'

/**
 * 动画段里三处只有全盘扫描才撞得到的布局(见 docs/SPINE-BINARY.md 7.2 / 7.6 / 7.10)。
 * 仓库样本里一处都没有,所以用合成骨架钉住;真实文件的验证靠全盘往返扫描。
 */

const bone = (name: string, parent: number): BoneRecord => ({
  name, parent, rotation: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0,
  length: 0, transformMode: 0, skinRequired: false,
})

const EVENTS: EventDef[] = [
  { name: 'sfx', nameIndex: 1, int: 0, float: 0, string: null, audioPath: 'cut.mp3', volume: 0.5, balance: -0.25 },
  { name: 'plain', nameIndex: 2, int: 0, float: 0, string: null, audioPath: null, volume: 1, balance: 0 },
  { name: 'valued', nameIndex: 3, int: 5, float: 2.5, string: 'hit', audioPath: null, volume: 1, balance: 0 },
]

const anim = (timelines: Timeline[], extra: Partial<AnimationData> = {}): AnimationData => ({
  name: 'a', timelines, endOffset: 0, sectionOffsets: [], ...extra,
})

const skeleton = (animations: AnimationData[]): SkeletonPart => ({
  header: {
    hash: '0011223344556677', version: '4.1.23', major: '4.x', x: 0, y: 0, width: 0, height: 0,
    nonessential: false, fps: null, imagesPath: null, audioPath: null,
  },
  strings: ['sfx', 'plain', 'valued'],
  bones: [bone('root', -1), bone('a', 0), bone('b', 0)],
  slots: [], ik: [], transform: [], path: [], skins: [],
  events: EVENTS,
  animations,
  failure: null, endOffset: 0, totalBytes: 0,
})

const eventTimeline = (frames: Record<string, unknown>[]): Timeline => ({ kind: 'event', owner: -1, frames, bezierCount: -1 })
const key = (event: number, extra: Record<string, unknown> = {}) => ({ time: 0, event, int: 0, float: 0, string: null, ...extra })
const rotate = (owner: number): Timeline => ({ kind: 'rotate', owner, frames: [{ time: 0, value: 0 }], bezierCount: 0 })
const translate = (owner: number): Timeline => ({ kind: 'translate', owner, frames: [{ time: 0, x: 0, y: 0 }], bezierCount: 0 })

/** 写出 → 读回,并要求读到精确 EOF、再写一次逐字节不变 */
function roundTrip(part: SkeletonPart): { bytes: Uint8Array; back: SkeletonPart } {
  const bytes = writeSkeleton(part)
  const back = readSkeletonPart(bytes)
  expect(back.failure).toBeNull()
  expect(back.endOffset).toBe(bytes.length)
  expect([...writeSkeleton(back)]).toEqual([...bytes])
  return { bytes, back }
}

describe('事件关键帧的 volume / balance', () => {
  it('只有定义带音频的事件,每帧才多 volume + balance 两个 float(8 字节)', () => {
    const audio = roundTrip(skeleton([anim([eventTimeline([key(0, { volume: 0.75, balance: 0.5 })])])]))
    const plain = roundTrip(skeleton([anim([eventTimeline([key(1)])])]))
    expect(audio.bytes.length - plain.bytes.length).toBe(8)

    const [a] = audio.back.animations[0]!.timelines[0]!.frames
    expect(a).toMatchObject({ volume: 0.75, balance: 0.5 })
    const [p] = plain.back.animations[0]!.timelines[0]!.frames
    expect(p).not.toHaveProperty('volume')
    expect(p).not.toHaveProperty('balance')
  })

  it('帧里没给(JSON 缺省)就写事件定义的值 —— 与 Spine 读 JSON 的补法一致', () => {
    const { back } = roundTrip(skeleton([anim([eventTimeline([key(0)])])]))
    expect(back.animations[0]!.timelines[0]!.frames[0]).toMatchObject({ volume: 0.5, balance: -0.25 })
  })

  it('JSON:等于定义的值就省略,不等才写;读回来缺省取定义的值', () => {
    const part = skeleton([anim([eventTimeline([key(0, { volume: 0.5, balance: -0.25 }), key(0, { time: 1, volume: 0.9, balance: -0.25 })])])])
    const json = toJson(part) as { animations: { a: { events: Record<string, unknown>[] } } }
    const [same, differ] = json.animations.a.events
    expect(same).not.toHaveProperty('volume')
    expect(same).not.toHaveProperty('balance')
    expect(differ).toMatchObject({ name: 'sfx', volume: 0.9 })
    expect(differ).not.toHaveProperty('balance')

    const frames = fromJson(json).animations[0]!.timelines.find((t) => t.kind === 'event')!.frames
    expect(frames[0]).toMatchObject({ volume: 0.5, balance: -0.25 })
    expect(frames[1]).toMatchObject({ volume: 0.9, balance: -0.25 })
  })
})

/**
 * Spine JSON 规范对事件帧的 int / float / string 写的是 "Assume the setup pose value if omitted" ——
 * 缺省取**事件定义**的值,不是 0。全盘真实 JSON 里没有一帧引用了非 0 定义,所以只能拿规范钉住。
 */
describe('事件关键帧的 int / float 缺省取事件定义的值', () => {
  type Events = { animations: { a: { events: Record<string, unknown>[] } } }
  const eventsOf = (part: SkeletonPart) => (toJson(part) as Events).animations.a.events

  it('JSON 读:帧里省略的 int / float 取定义的值', () => {
    const json = toJson(skeleton([])) as Record<string, unknown>
    json['animations'] = { a: { events: [{ time: 0, name: 'valued' }, { time: 1, name: 'plain' }] } }
    const [valued, plain] = fromJson(json).animations[0]!.timelines[0]!.frames
    expect(valued).toMatchObject({ int: 5, float: 2.5, string: null })
    expect(plain).toMatchObject({ int: 0, float: 0 })
  })

  it('JSON 写:等于定义的值才省略 —— 定义非 0 时帧里的 0 必须照写,否则读回来变成定义的值', () => {
    const part = skeleton([anim([eventTimeline([
      key(2, { int: 5, float: 2.5 }),
      key(2, { time: 1, int: 0, float: 0 }),
    ])])])
    const [same, zero] = eventsOf(part)
    expect(same).toEqual({ name: 'valued' })
    expect(zero).toEqual({ time: 1, name: 'valued', int: 0, float: 0 })

    const back = fromJson(toJson(part)).animations[0]!.timelines[0]!.frames
    expect(back[0]).toMatchObject({ int: 5, float: 2.5 })
    expect(back[1]).toMatchObject({ int: 0, float: 0 })
  })

  it('.skel → JSON → .skel:事件帧的值不变', () => {
    const part = skeleton([anim([eventTimeline([key(2, { int: 5 }), key(2, { time: 1, float: 2.5 }), key(1, { time: 2, int: 3 })])])])
    const back = fromJson(toJson(part))
    expect(back.animations[0]!.timelines[0]!.frames.map((f) => [f['int'], f['float']])).toEqual([[5, 0], [0, 2.5], [3, 0]])
  })
})

describe('4.x 动画开头的时间轴总数', () => {
  it('读来的原值原样写回 —— Spine 自己写的可以比实际条数多', () => {
    const { bytes, back } = roundTrip(skeleton([anim([rotate(1)], { timelineCount: 3 })]))
    expect(back.animations[0]!.timelineCount).toBe(3)
    expect(back.animations[0]!.timelines).toHaveLength(1)
    // 'start' 标在读完总数之后,总数是它前面那个单字节 varint
    const start = back.animations[0]!.sectionOffsets[0]!
    expect(start.section).toBe('start')
    expect(bytes[start.offset - 1]).toBe(3)
  })

  it('没有原值(3.8 / JSON 来的)就写实际条数', () => {
    const { back } = roundTrip(skeleton([anim([rotate(1), translate(2)])]))
    expect(back.animations[0]!.timelineCount).toBe(2)
  })
})

describe('同一个 owner 可以出现在两个不相邻的组里', () => {
  it('写回时按连续段分组,不按 owner 合并', () => {
    const timelines = [rotate(1), translate(1), rotate(2), rotate(1)]
    const { back } = roundTrip(skeleton([anim(timelines)]))
    // 若按 owner 合并,会变成 rotate@1 translate@1 rotate@1 rotate@2 —— 骨骼段少一组
    expect(back.animations[0]!.timelines.map((t) => `${t.kind}@${t.owner}`)).toEqual([
      'rotate@1', 'translate@1', 'rotate@2', 'rotate@1',
    ])
  })
})
