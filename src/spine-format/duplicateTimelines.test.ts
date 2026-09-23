import { describe, expect, it } from 'vitest'
import type { BoneRecord, SkeletonPart } from './binary/readSkeleton.ts'
import type { Timeline } from './binary/readAnimations.ts'
import { lastPerProperty } from './duplicateTimelines.ts'
import { toJson } from './json/toJson.ts'
import { jsonIssues } from '../spine-convert/skel/convert.ts'

/**
 * 同一属性的重复时间轴(3.8 全盘约 4800 处)。二进制往返原样保留;JSON 与 Unity 只留最后一条,
 * 内容不同时要报告。
 */

const bone = (name: string, parent: number): BoneRecord => ({
  name, parent, rotation: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0,
  length: 0, transformMode: 0, skinRequired: false,
})

const attachment = (owner: number, names: (string | null)[]): Timeline => ({
  kind: 'attachment', owner, bezierCount: -1,
  frames: names.map((name, i) => ({ time: i * 0.5, name })),
})

const deform = (owner: number, attachmentName: string, offset: number): Timeline => ({
  kind: 'deform', owner, bezierCount: -1,
  frames: [{ skin: 0, attachment: attachmentName, attachmentIndex: 1, frames: [{ time: 0, start: 0, vertices: [offset, 0], curve: 'linear' }] }],
})

const skeleton = (timelines: Timeline[]): SkeletonPart => ({
  header: {
    hash: null, version: '3.8.95', major: '3.8', x: 0, y: 0, width: 0, height: 0,
    nonessential: false, fps: null, imagesPath: null, audioPath: null,
  },
  strings: [],
  bones: [bone('root', -1)],
  slots: [
    { name: 'eye', bone: 0, color: -1, darkColor: -1, attachmentName: null, attachmentNameIndex: 0, blendMode: 0 },
    { name: 'mouth', bone: 0, color: -1, darkColor: -1, attachmentName: null, attachmentNameIndex: 0, blendMode: 0 },
  ],
  ik: [], transform: [], path: [],
  skins: [{ name: 'default', slots: [], bones: [], ik: [], transform: [], path: [] }] as unknown as SkeletonPart['skins'],
  events: [],
  animations: [{ name: 'blink', timelines, endOffset: 0, sectionOffsets: [] }],
  failure: null, endOffset: 0, totalBytes: 0,
})

describe('lastPerProperty', () => {
  it('同类同 owner 只留最后一条,并标出被丢的与留下的是否相同', () => {
    const first = attachment(0, ['open', 'closed'])
    const copy = attachment(0, ['open', 'closed'])
    const last = attachment(0, ['open'])
    const other = attachment(1, ['smile'])
    const { kept, dropped } = lastPerProperty([first, other, copy, last])
    expect(kept).toEqual([other, last])
    expect(dropped.map((d) => [d.timeline, d.identical])).toEqual([[first, false], [copy, false]])

    const same = lastPerProperty([copy, first])
    expect(same.dropped.map((d) => d.identical)).toEqual([true])
  })

  it('deform 按皮肤 + attachment 区分:同 slot 不同 attachment 不算重复', () => {
    const a = deform(0, 'eye_open', 1)
    const b = deform(0, 'eye_closed', 2)
    expect(lastPerProperty([a, b]).dropped).toEqual([])
    expect(lastPerProperty([a, deform(0, 'eye_open', 3)]).dropped).toHaveLength(1)
  })

  it('没有重复时原样返回', () => {
    const list = [attachment(0, ['open']), attachment(1, ['smile'])]
    expect(lastPerProperty(list)).toEqual({ kept: list, dropped: [] })
  })
})

describe('skel → json:JSON 一个键只能有一个值', () => {
  type Anim = { slots: Record<string, { attachment: unknown[] }>; deform: Record<string, Record<string, Record<string, unknown[]>>> }
  const blinkOf = (part: SkeletonPart) => (toJson(part) as { animations: { blink: Anim } }).animations.blink

  it('留下的是最后一条 —— Spine 播放时实际生效的那条', () => {
    const part = skeleton([attachment(0, ['open', 'closed']), deform(0, 'eye', 1), attachment(0, ['open']), deform(0, 'eye', 7)])
    const blink = blinkOf(part)
    expect(blink.slots['eye']!.attachment).toEqual([{ name: 'open' }])
    expect(blink.deform['default']!['eye']!['eye']).toEqual([{ vertices: [7, 0] }])
  })

  it('内容不同的才报 approximated,相同的不报(丢了也无损)', () => {
    const differ = skeleton([attachment(0, ['open', 'closed']), attachment(0, ['open'])])
    expect(jsonIssues(differ)).toEqual([
      expect.objectContaining({ level: 'approximated', path: 'blink.attachment[eye]' }),
    ])
    const same = skeleton([attachment(0, ['open']), deform(0, 'eye', 1), attachment(0, ['open']), deform(0, 'eye', 1)])
    expect(jsonIssues(same)).toEqual([])
  })
})
