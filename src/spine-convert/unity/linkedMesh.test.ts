import { describe, expect, it } from 'vitest'
import type { SkeletonPart } from '../../spine-format/binary/readSkeleton.ts'
import type { Attachment, Skin } from '../../spine-format/binary/readSkins.ts'
import { IssueCollector } from '../types.ts'
import { resolveLinkedMeshes } from './linkedMesh.ts'

const attachment = (key: string, type: Attachment['type'], data: Record<string, unknown>): Attachment => ({
  key,
  name: key,
  nameRef: null,
  nameIndex: -1,
  keyIndex: -1,
  type,
  sequence: null,
  data,
})

const mesh = (key: string, path: string) =>
  attachment(key, 'mesh', {
    path,
    color: -1,
    vertexCount: 3,
    uvs: [0, 0, 1, 0, 0, 1],
    triangles: [0, 1, 2],
    vertices: { weighted: false, positions: [0, 0, 10, 0, 0, 10], weights: [] },
    hullLength: 3,
    width: 10,
    height: 10,
  })

const linked = (key: string, path: string, parent: string, skinName: string | null, inheritTimelines = true) =>
  attachment(key, 'linkedmesh', { path, color: -1, skinName, parent, inheritTimelines })

const skin = (name: string, slot: number, attachments: Attachment[]): Skin => ({
  name,
  nameIndex: -1,
  bones: [],
  ik: [],
  transform: [],
  path: [],
  slots: [{ slot, attachments }],
})

const partOf = (skins: Skin[]) => ({ skins }) as unknown as SkeletonPart
const find = (part: SkeletonPart, skinName: string, key: string) =>
  part.skins.find((s) => s.name === skinName)!.slots[0]!.attachments.find((a) => a.key === key)!

describe('linkedmesh 展开', () => {
  it('没有 linkedmesh 时原样返回,不复制', () => {
    const part = partOf([skin('default', 0, [mesh('body', 'body')])])
    expect(resolveLinkedMeshes(part, new IssueCollector()).part).toBe(part)
  })

  it('几何取父网格,图(path)用自己的 —— 父网格可以在另一套皮肤里', () => {
    // MC2 chopping_board 就是这样:皮肤 "5" 的件挂在皮肤 "4" 的网格上
    const part = partOf([skin('default', 0, []), skin('4', 0, [mesh('bashou', 'bashou_a')]), skin('5', 0, [linked('bashou', 'bashou_b', 'bashou', '4')])])
    const { part: out, timelineParents } = resolveLinkedMeshes(part, new IssueCollector())

    const parent = find(out, '4', 'bashou')
    const child = find(out, '5', 'bashou')
    expect(child.type).toBe('mesh')
    expect(child.data['path']).toBe('bashou_b')
    for (const field of ['vertexCount', 'uvs', 'triangles', 'vertices', 'hullLength']) {
      expect(child.data[field]).toEqual(parent.data[field])
    }
    expect(timelineParents.get(child)).toEqual({ skin: '4', key: 'bashou' })
  })

  it('skinName 为 null 时到默认皮肤里找父网格', () => {
    const part = partOf([skin('default', 2, [mesh('head', 'head'), linked('head_alt', 'head_alt', 'head', null)])])
    const { part: out, timelineParents } = resolveLinkedMeshes(part, new IssueCollector())
    expect(find(out, 'default', 'head_alt').type).toBe('mesh')
    expect(timelineParents.get(find(out, 'default', 'head_alt'))).toEqual({ skin: 'default', key: 'head' })
  })

  it('inheritTimelines 为假时不继承父网格的 deform', () => {
    const part = partOf([skin('default', 0, [mesh('a', 'a'), linked('b', 'b', 'a', null, false)])])
    const { part: out, timelineParents } = resolveLinkedMeshes(part, new IssueCollector())
    expect(find(out, 'default', 'b').type).toBe('mesh')
    expect(timelineParents.size).toBe(0)
  })

  it('找不到父网格时报 loss,不静默', () => {
    const issues = new IssueCollector()
    const part = partOf([skin('default', 0, [linked('b', 'b', 'nope', null)])])
    const { part: out } = resolveLinkedMeshes(part, issues)
    expect(find(out, 'default', 'b').type).toBe('linkedmesh')
    expect(issues.all.some((i) => i.level === 'loss' && i.message.includes('nope'))).toBe(true)
  })

  it('父链上的 linkedmesh 一路追到真正的网格;时间轴只继承直接父网格', () => {
    const part = partOf([skin('default', 0, [mesh('a', 'a'), linked('b', 'b', 'a', null), linked('c', 'c', 'b', null)])])
    const { part: out, timelineParents } = resolveLinkedMeshes(part, new IssueCollector())
    const c = find(out, 'default', 'c')
    expect(c.data['uvs']).toEqual(find(out, 'default', 'a').data['uvs'])
    expect(timelineParents.get(c)).toEqual({ skin: 'default', key: 'b' })
  })

  it('互相引用成环时报 loss 而不是死循环', () => {
    const issues = new IssueCollector()
    const part = partOf([skin('default', 0, [linked('a', 'a', 'b', null), linked('b', 'b', 'a', null)])])
    resolveLinkedMeshes(part, issues)
    expect(issues.all.filter((i) => i.level === 'loss')).toHaveLength(2)
  })
})
