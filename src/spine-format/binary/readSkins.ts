import type { SpineInput } from './input.ts'

/**
 * 皮肤与 attachment。
 *
 * **两版差异只有一处**:4.x 的 Region / Mesh / Linkedmesh 多了一个 `sequence`
 * 字段(4.1 新增的序列帧附件)。其余类型的字节布局完全一致。
 *
 * 见 [docs/SPINE-BINARY.md](../../../docs/SPINE-BINARY.md)。
 */

export const ATTACHMENT_TYPES = [
  'region',
  'boundingbox',
  'mesh',
  'linkedmesh',
  'path',
  'point',
  'clipping',
] as const

export type AttachmentType = (typeof ATTACHMENT_TYPES)[number]

/** 4.1 新增。3.8 没有对应物,降级时必丢。 */
export interface Sequence {
  readonly count: number
  readonly start: number
  readonly digits: number
  readonly setupIndex: number
}

/**
 * 顶点数据。未绑定骨骼时是裸的 x/y 数组;绑定后每个顶点带若干
 * (骨骼下标, x, y, 权重)。
 */
export interface Vertices {
  readonly weighted: boolean
  /** 未加权时的 x,y 交替数组 */
  readonly positions: readonly number[]
  /** 加权时:每顶点一组 [骨骼下标, x, y, 权重] × n */
  readonly weights: readonly { bone: number; x: number; y: number; weight: number }[][]
}

export interface Attachment {
  /** 皮肤里的键名 */
  readonly key: string
  /** attachment 自己的名字,通常与 key 相同 */
  readonly name: string
  readonly type: AttachmentType
  readonly sequence: Sequence | null
  /** 各类型的具体字段,保持原样以便原封写回 */
  readonly data: Record<string, unknown>
}

export interface SkinSlotEntry {
  readonly slot: number
  readonly attachments: readonly Attachment[]
}

export interface Skin {
  readonly name: string
  readonly bones: readonly number[]
  readonly ik: readonly number[]
  readonly transform: readonly number[]
  readonly path: readonly number[]
  readonly slots: readonly SkinSlotEntry[]
}

function readIndexList(input: SpineInput): number[] {
  const n = input.readVarInt()
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(input.readVarInt())
  return out
}

function readFloats(input: SpineInput, n: number): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(input.readFloat())
  return out
}

/** 长度前缀的 short 数组,每项 2 字节大端 */
function readShorts(input: SpineInput): number[] {
  const n = input.readVarInt()
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push((input.readByte() << 8) | input.readByte())
  return out
}

function readVertices(input: SpineInput, vertexCount: number): Vertices {
  const weighted = input.readBoolean()

  if (!weighted) {
    return { weighted: false, positions: readFloats(input, vertexCount * 2), weights: [] }
  }

  const weights: { bone: number; x: number; y: number; weight: number }[][] = []
  for (let i = 0; i < vertexCount; i++) {
    const boneCount = input.readVarInt()
    const entry: { bone: number; x: number; y: number; weight: number }[] = []
    for (let ii = 0; ii < boneCount; ii++) {
      entry.push({
        bone: input.readVarInt(),
        x: input.readFloat(),
        y: input.readFloat(),
        weight: input.readFloat(),
      })
    }
    weights.push(entry)
  }
  return { weighted: true, positions: [], weights }
}

/** 4.x 才有。先一个 bool 表示有没有,有的话跟 4 个 varint。 */
function readSequence(input: SpineInput, is38: boolean): Sequence | null {
  if (is38) return null
  if (!input.readBoolean()) return null
  return {
    count: input.readVarInt(),
    start: input.readVarInt(),
    digits: input.readVarInt(),
    setupIndex: input.readVarInt(),
  }
}

function readAttachment(
  input: SpineInput,
  key: string,
  is38: boolean,
  nonessential: boolean,
): Attachment | null {
  const nameRef = input.readStringRef()
  const name = nameRef ?? key
  const typeIndex = input.readByte()
  const type = ATTACHMENT_TYPES[typeIndex]

  if (type === undefined) {
    throw new Error(`未知的 attachment 类型 ${typeIndex}(${key})—— 通常说明前面的字节布局错了`)
  }

  const data: Record<string, unknown> = {}
  let sequence: Sequence | null = null

  switch (type) {
    case 'region': {
      data['path'] = input.readStringRef()
      data['rotation'] = input.readFloat()
      data['x'] = input.readFloat()
      data['y'] = input.readFloat()
      data['scaleX'] = input.readFloat()
      data['scaleY'] = input.readFloat()
      data['width'] = input.readFloat()
      data['height'] = input.readFloat()
      data['color'] = input.readInt()
      sequence = readSequence(input, is38)
      break
    }
    case 'boundingbox': {
      const vertexCount = input.readVarInt()
      data['vertexCount'] = vertexCount
      data['vertices'] = readVertices(input, vertexCount)
      if (nonessential) data['color'] = input.readInt()
      break
    }
    case 'mesh': {
      data['path'] = input.readStringRef()
      data['color'] = input.readInt()
      const vertexCount = input.readVarInt()
      data['vertexCount'] = vertexCount
      data['uvs'] = readFloats(input, vertexCount * 2)
      data['triangles'] = readShorts(input)
      data['vertices'] = readVertices(input, vertexCount)
      data['hullLength'] = input.readVarInt()
      sequence = readSequence(input, is38)
      if (nonessential) {
        data['edges'] = readShorts(input)
        data['width'] = input.readFloat()
        data['height'] = input.readFloat()
      }
      break
    }
    case 'linkedmesh': {
      data['path'] = input.readStringRef()
      data['color'] = input.readInt()
      data['skinName'] = input.readStringRef()
      data['parent'] = input.readStringRef()
      // 3.8 叫 inheritDeform,4.x 叫 inheritTimelines —— 只是改名,字节位置相同
      data['inheritTimelines'] = input.readBoolean()
      sequence = readSequence(input, is38)
      if (nonessential) {
        data['width'] = input.readFloat()
        data['height'] = input.readFloat()
      }
      break
    }
    case 'path': {
      data['closed'] = input.readBoolean()
      data['constantSpeed'] = input.readBoolean()
      const vertexCount = input.readVarInt()
      data['vertexCount'] = vertexCount
      data['vertices'] = readVertices(input, vertexCount)
      data['lengths'] = readFloats(input, Math.floor(vertexCount / 3))
      if (nonessential) data['color'] = input.readInt()
      break
    }
    case 'point': {
      data['rotation'] = input.readFloat()
      data['x'] = input.readFloat()
      data['y'] = input.readFloat()
      if (nonessential) data['color'] = input.readInt()
      break
    }
    case 'clipping': {
      data['endSlot'] = input.readVarInt()
      const vertexCount = input.readVarInt()
      data['vertexCount'] = vertexCount
      data['vertices'] = readVertices(input, vertexCount)
      if (nonessential) data['color'] = input.readInt()
      break
    }
  }

  return { key, name, type, sequence, data }
}

function readSkinSlots(input: SpineInput, slotCount: number, is38: boolean, nonessential: boolean) {
  const slots: SkinSlotEntry[] = []
  for (let i = 0; i < slotCount; i++) {
    const slot = input.readVarInt()
    const attachmentCount = input.readVarInt()
    const attachments: Attachment[] = []
    for (let ii = 0; ii < attachmentCount; ii++) {
      const key = input.readStringRef() ?? ''
      const attachment = readAttachment(input, key, is38, nonessential)
      if (attachment !== null) attachments.push(attachment)
    }
    slots.push({ slot, attachments })
  }
  return slots
}

/**
 * 读全部皮肤。
 *
 * 默认皮肤在前且**没有名字和约束列表** —— 直接以 slot 数量开头,为 0 表示没有默认皮肤。
 * 其余皮肤每个都带名字、骨骼列表和三种约束列表。
 */
export function readSkins(input: SpineInput, is38: boolean, nonessential: boolean): Skin[] {
  const skins: Skin[] = []

  const defaultSlotCount = input.readVarInt()
  if (defaultSlotCount > 0) {
    skins.push({
      name: 'default',
      bones: [],
      ik: [],
      transform: [],
      path: [],
      slots: readSkinSlots(input, defaultSlotCount, is38, nonessential),
    })
  }

  const extra = input.readVarInt()
  for (let i = 0; i < extra; i++) {
    const name = input.readStringRef() ?? ''
    const bones = readIndexList(input)
    const ik = readIndexList(input)
    const transform = readIndexList(input)
    const path = readIndexList(input)
    const slotCount = input.readVarInt()
    skins.push({
      name,
      bones,
      ik,
      transform,
      path,
      slots: readSkinSlots(input, slotCount, is38, nonessential),
    })
  }

  return skins
}
