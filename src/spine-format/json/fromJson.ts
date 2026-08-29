import type {
  BoneRecord, IkRecord, PathRecord, SkeletonPart, SlotRecord, SpineMajor, TransformRecord,
} from '../binary/readSkeleton.ts'
import type { Attachment, AttachmentType, Skin, SkinSlotEntry, Vertices } from '../binary/readSkins.ts'
import type { AnimationData, EventDef, Timeline } from '../binary/readAnimations.ts'

/**
 * Spine JSON → 模型。是 [toJson.ts](./toJson.ts) 的镜像。
 *
 * ⚠️ **JSON 里没有字符串表** —— 二进制用下标引用字符串,JSON 直接写名字。
 * 所以这里要**重建一张表**:把所有需要 stringRef 的名字收集起来去重编号。
 *
 * 因此 `skel → json → skel` **不会逐字节相同**(重建的表与原表下标不同),
 * 但结构必须完全一致。逐字节相同只适用于 `skel → skel`。
 *
 * **Spine JSON 省略等于默认值的字段**,这里要用同一套默认值补回来 ——
 * 少补一个,转出来的动画就会悄悄变样。
 */

type Json = Record<string, unknown>

const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

const TRANSFORM_MODES = ['normal', 'onlyTranslation', 'noRotationOrReflection', 'noScale', 'noScaleOrReflection']
const BLEND_MODES = ['normal', 'additive', 'multiply', 'screen']
const POSITION_MODES = ['fixed', 'percent']
const SPACING_MODES = ['length', 'fixed', 'percent', 'proportional']
const ROTATE_MODES = ['tangent', 'chain', 'chainScale']

const indexOfMode = (list: readonly string[], v: unknown, fallback: string): number => {
  const i = list.indexOf(typeof v === 'string' ? v : fallback)
  return i < 0 ? list.indexOf(fallback) : i
}

/** "rrggbbaa" → 0xRRGGBBAA(有符号 32 位,与二进制读出来的一致) */
const parseRgba = (hex: unknown, fallback: number): number =>
  typeof hex === 'string' ? parseInt(hex.padEnd(8, 'f').slice(0, 8), 16) | 0 : fallback

const parseRgb = (hex: unknown, fallback: number): number =>
  typeof hex === 'string' ? parseInt(hex.slice(0, 6), 16) : fallback

const hexToBytes = (hex: string): number[] => {
  const out: number[] = []
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16))
  return out
}

/** 重建字符串表:登记一个名字并拿到它的 1 基下标(null 记为 0) */
class StringTable {
  readonly values: (string | null)[] = []
  private readonly index = new Map<string, number>()

  ref(value: string | null): number {
    if (value === null) return 0
    const existing = this.index.get(value)
    if (existing !== undefined) return existing
    this.values.push(value)
    const i = this.values.length
    this.index.set(value, i)
    return i
  }
}

// ─── 顶点 ────────────────────────────────────────────────────────────────────

/**
 * JSON 的顶点数组是变长的:长度等于 `vertexCount * 2` 时是未加权的裸坐标,
 * 否则是 `[骨骼数, 下标, x, y, 权重, …]` 的加权编码。
 */
function verticesFromJson(raw: readonly number[], vertexCount: number): Vertices {
  if (raw.length === vertexCount * 2) {
    return { weighted: false, positions: [...raw], weights: [] }
  }
  const weights: { bone: number; x: number; y: number; weight: number }[][] = []
  let i = 0
  for (let v = 0; v < vertexCount; v++) {
    const boneCount = raw[i++]!
    const entry: { bone: number; x: number; y: number; weight: number }[] = []
    for (let b = 0; b < boneCount; b++) {
      entry.push({ bone: raw[i++]!, x: raw[i++]!, y: raw[i++]!, weight: raw[i++]! })
    }
    weights.push(entry)
  }
  return { weighted: true, positions: [], weights }
}

// ─── 曲线 ────────────────────────────────────────────────────────────────────

/** components 是该时间轴的值分量数 —— 4.x 的 bezier 数组按它切分 */
function curveFromJson(j: Json, is38: boolean, components: number): Json {
  const curve = j['curve']
  if (curve === undefined) return { curve: 'linear' }
  if (curve === 'stepped') return { curve: 'stepped' }

  if (is38) {
    return { curve: 'bezier', beziers: [[...(curve as number[])]] }
  }

  // 4.x:curve 恒为 "bezier",控制点平铺在 bezier 数组里,每 4 个一组
  const flat = (j['bezier'] as number[]) ?? []
  const beziers: number[][] = []
  for (let i = 0; i < components; i++) beziers.push(flat.slice(i * 4, i * 4 + 4))
  return { curve: 'bezier', beziers }
}

function framesFromJson(
  raw: readonly Json[],
  is38: boolean,
  valueNames: readonly string[],
  defaults: readonly number[],
  rename?: Record<string, string>,
): Record<string, unknown>[] {
  return raw.map((j) => {
    const f: Record<string, unknown> = { time: num(j['time'], 0) }
    valueNames.forEach((name, i) => {
      f[name] = num(j[rename?.[name] ?? name], defaults[i] ?? 0)
    })
    return { ...f, ...curveFromJson(j, is38, valueNames.length) }
  })
}

// ─── attachment ──────────────────────────────────────────────────────────────

function attachmentFromJson(key: string, j: Json, table: StringTable, is38: boolean): Attachment {
  const type = (str(j['type']) ?? 'region') as AttachmentType
  const nameRef = str(j['name'])
  const path = str(j['path']) ?? (nameRef ?? key)
  const data: Record<string, unknown> = {}

  const vertexCount = num(j['vertexCount'], 0)
  const setVerts = (count: number) => {
    data['vertexCount'] = count
    data['vertices'] = verticesFromJson((j['vertices'] as number[]) ?? [], count)
  }

  switch (type) {
    case 'region':
      data['path'] = path
      data['pathIndex'] = table.ref(path)
      data['rotation'] = num(j['rotation'], 0)
      data['x'] = num(j['x'], 0)
      data['y'] = num(j['y'], 0)
      data['scaleX'] = num(j['scaleX'], 1)
      data['scaleY'] = num(j['scaleY'], 1)
      data['width'] = num(j['width'], 0)
      data['height'] = num(j['height'], 0)
      data['color'] = parseRgba(j['color'], -1)
      break

    case 'mesh': {
      data['path'] = path
      data['pathIndex'] = table.ref(path)
      data['color'] = parseRgba(j['color'], -1)
      const uvs = (j['uvs'] as number[]) ?? []
      data['vertexCount'] = uvs.length / 2
      data['uvs'] = uvs
      data['triangles'] = (j['triangles'] as number[]) ?? []
      data['vertices'] = verticesFromJson((j['vertices'] as number[]) ?? [], uvs.length / 2)
      data['hullLength'] = num(j['hull'], 0)
      if (j['edges'] !== undefined) data['edges'] = j['edges']
      if (j['width'] !== undefined) data['width'] = j['width']
      if (j['height'] !== undefined) data['height'] = j['height']
      break
    }

    case 'linkedmesh': {
      data['path'] = path
      data['pathIndex'] = table.ref(path)
      data['color'] = parseRgba(j['color'], -1)
      const skinName = str(j['skin'])
      const parent = str(j['parent'])
      data['skinName'] = skinName
      data['skinNameIndex'] = table.ref(skinName)
      data['parent'] = parent
      data['parentIndex'] = table.ref(parent)
      data['inheritTimelines'] = bool(j[is38 ? 'deform' : 'timelines'], true)
      if (j['width'] !== undefined) data['width'] = j['width']
      if (j['height'] !== undefined) data['height'] = j['height']
      break
    }

    case 'boundingbox':
      setVerts(vertexCount)
      break

    case 'path':
      data['closed'] = bool(j['closed'], false)
      data['constantSpeed'] = bool(j['constantSpeed'], true)
      setVerts(vertexCount)
      data['lengths'] = (j['lengths'] as number[]) ?? []
      break

    case 'point':
      data['rotation'] = num(j['rotation'], 0)
      data['x'] = num(j['x'], 0)
      data['y'] = num(j['y'], 0)
      break

    case 'clipping':
      data['endSlot'] = num(j['end'], 0)
      setVerts(vertexCount)
      break
  }

  const seq = j['sequence'] as Json | undefined
  return {
    key,
    keyIndex: table.ref(key),
    name: nameRef ?? key,
    nameRef,
    nameIndex: table.ref(nameRef),
    type,
    sequence:
      seq === undefined
        ? null
        : {
            count: num(seq['count'], 0),
            start: num(seq['start'], 1),
            digits: num(seq['digits'], 0),
            setupIndex: num(seq['setup'], 0),
          },
    data,
  }
}

// ─── 动画 ────────────────────────────────────────────────────────────────────

const BONE_VALUE_NAMES: Record<string, { names: string[]; defaults: number[] }> = {
  rotate: { names: ['value'], defaults: [0] },
  translate: { names: ['x', 'y'], defaults: [0, 0] },
  translateX: { names: ['value'], defaults: [0] },
  translateY: { names: ['value'], defaults: [0] },
  scale: { names: ['x', 'y'], defaults: [1, 1] },
  scaleX: { names: ['value'], defaults: [1] },
  scaleY: { names: ['value'], defaults: [1] },
  shear: { names: ['x', 'y'], defaults: [0, 0] },
  shearX: { names: ['value'], defaults: [0] },
  shearY: { names: ['value'], defaults: [0] },
}

const SLOT_COLOR_TYPE: Record<string, number> = { rgba: 1, rgb: 2, rgba2: 3, rgb2: 4, alpha: 5 }
const SLOT_COLOR_CHANNELS: Record<number, number> = { 1: 4, 2: 3, 3: 7, 4: 6, 5: 1 }

interface NameLookup {
  readonly slots: readonly string[]
  readonly bones: readonly string[]
  readonly ik: readonly string[]
  readonly transform: readonly string[]
  readonly path: readonly string[]
  readonly skins: readonly string[]
  readonly events: readonly string[]
}

function animationFromJson(
  name: string,
  j: Json,
  is38: boolean,
  names: NameLookup,
  table: StringTable,
): AnimationData {
  const timelines: Timeline[] = []
  const at = (list: readonly string[], key: string) => Math.max(0, list.indexOf(key))

  // ── slot ──
  for (const [slotName, byKind] of Object.entries((j['slots'] as Json) ?? {})) {
    const owner = at(names.slots, slotName)
    for (const [kind, raw] of Object.entries(byKind as Json)) {
      const frames = raw as Json[]

      if (kind === 'attachment') {
        timelines.push({
          kind: 'attachment',
          owner,
          bezierCount: -1,
          frames: frames.map((f) => {
            const value = str(f['name'])
            return { time: num(f['time'], 0), name: value, nameIndex: table.ref(value) }
          }),
        })
        continue
      }

      if (is38) {
        const twoColor = kind === 'twoColor'
        timelines.push({
          kind: twoColor ? 'twoColor' : 'color',
          owner,
          bezierCount: -1,
          frames: frames.map((f) => ({
            time: num(f['time'], 0),
            colors: twoColor
              ? [parseRgba(f['light'], -1), parseRgb(f['dark'], 0)]
              : [parseRgba(f['color'], -1)],
            ...curveFromJson(f, true, 1),
          })),
        })
        continue
      }

      const type = SLOT_COLOR_TYPE[kind] ?? 1
      const channels = SLOT_COLOR_CHANNELS[type]!
      timelines.push({
        kind: `slotColor${type}`,
        owner,
        bezierCount: -1,
        frames: frames.map((f) => {
          const parts =
            type === 3
              ? [...hexToBytes(str(f['color']) ?? 'ffffffff'), ...hexToBytes(str(f['dark']) ?? '000000')]
              : type === 4
                ? [...hexToBytes(str(f['light']) ?? 'ffffff'), ...hexToBytes(str(f['dark']) ?? '000000')]
                : hexToBytes(str(f['color']) ?? 'ff'.repeat(channels))
          return { time: num(f['time'], 0), color: parts, ...curveFromJson(f, false, channels) }
        }),
      })
    }
  }

  // ── 骨骼 ──
  for (const [boneName, byKind] of Object.entries((j['bones'] as Json) ?? {})) {
    const owner = at(names.bones, boneName)
    for (const [kind, raw] of Object.entries(byKind as Json)) {
      const shape = BONE_VALUE_NAMES[kind]
      if (shape === undefined) continue
      const rename = kind === 'rotate' && is38 ? { value: 'angle' } : undefined
      timelines.push({
        kind,
        owner,
        bezierCount: -1,
        frames: framesFromJson(raw as Json[], is38, shape.names, shape.defaults, rename),
      })
    }
  }

  // ── IK ──
  for (const [ikName, raw] of Object.entries((j['ik'] as Json) ?? {})) {
    timelines.push({
      kind: 'ik',
      owner: at(names.ik, ikName),
      bezierCount: -1,
      frames: (raw as Json[]).map((f) => ({
        time: num(f['time'], 0),
        mix: num(f['mix'], 1),
        softness: num(f['softness'], 0),
        bendDirection: bool(f['bendPositive'], true) ? 1 : -1,
        compress: bool(f['compress'], false),
        stretch: bool(f['stretch'], false),
        ...curveFromJson(f, is38, 2),
      })),
    })
  }

  // ── transform ──
  for (const [tName, raw] of Object.entries((j['transform'] as Json) ?? {})) {
    const valueNames = is38
      ? ['mixRotate', 'mixTranslate', 'mixScale', 'mixShear']
      : ['mixRotate', 'mixX', 'mixY', 'mixScaleX', 'mixScaleY', 'mixShearY']
    const rename = is38
      ? { mixRotate: 'rotateMix', mixTranslate: 'translateMix', mixScale: 'scaleMix', mixShear: 'shearMix' }
      : undefined
    timelines.push({
      kind: 'transform',
      owner: at(names.transform, tName),
      bezierCount: -1,
      frames: framesFromJson(raw as Json[], is38, valueNames, valueNames.map(() => 1), rename),
    })
  }

  // ── path ──
  for (const [pName, byKind] of Object.entries((j['path'] as Json) ?? {})) {
    const owner = at(names.path, pName)
    for (const [kind, raw] of Object.entries(byKind as Json)) {
      const type = kind === 'position' ? 0 : kind === 'spacing' ? 1 : 2
      const valueNames =
        type === 2 ? (is38 ? ['mixRotate', 'mixTranslate'] : ['mixRotate', 'mixX', 'mixY']) : ['value']
      const rename =
        type === 2
          ? is38 ? { mixRotate: 'rotateMix', mixTranslate: 'translateMix' } : undefined
          : { value: kind }
      timelines.push({
        kind: `path${type}`,
        owner,
        bezierCount: -1,
        frames: framesFromJson(raw as Json[], is38, valueNames, valueNames.map(() => (type === 2 ? 1 : 0)), rename),
      })
    }
  }

  // ── deform / attachments ──
  const deformRoot = (j[is38 ? 'deform' : 'attachments'] as Json) ?? {}
  for (const [skinName, bySlot] of Object.entries(deformRoot)) {
    const skin = at(names.skins, skinName)
    for (const [slotName, byAttachment] of Object.entries(bySlot as Json)) {
      const owner = at(names.slots, slotName)
      for (const [attachmentName, raw] of Object.entries(byAttachment as Json)) {
        const inner = (raw as Json[]).map((f) => {
          const verts = (f['vertices'] as number[]) ?? []
          return {
            time: num(f['time'], 0),
            start: verts.length === 0 ? 0 : num(f['offset'], 0),
            vertices: verts,
            ...curveFromJson(f, is38, 1),
          }
        })
        timelines.push({
          kind: 'deform',
          owner,
          bezierCount: -1,
          frames: [{
            skin,
            attachment: attachmentName,
            attachmentIndex: table.ref(attachmentName),
            frames: inner,
          }],
        })
      }
    }
  }

  // ── draw order ──
  const drawOrder = j['drawOrder'] as Json[] | undefined
  if (drawOrder !== undefined) {
    timelines.push({
      kind: 'drawOrder',
      owner: -1,
      bezierCount: -1,
      frames: drawOrder.map((f) => ({
        time: num(f['time'], 0),
        offsets: ((f['offsets'] as Json[]) ?? []).map((o) => ({
          slot: at(names.slots, str(o['slot']) ?? ''),
          offset: num(o['offset'], 0),
        })),
      })),
    })
  }

  // ── 事件 ──
  const events = j['events'] as Json[] | undefined
  if (events !== undefined) {
    timelines.push({
      kind: 'event',
      owner: -1,
      bezierCount: -1,
      frames: events.map((f) => ({
        time: num(f['time'], 0),
        event: at(names.events, str(f['name']) ?? ''),
        int: num(f['int'], 0),
        float: num(f['float'], 0),
        string: str(f['string']),
      })),
    })
  }

  return { name, timelines, endOffset: 0, sectionOffsets: [] }
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

export function fromJson(root: Json, major?: SpineMajor): SkeletonPart {
  const skeleton = (root['skeleton'] as Json) ?? {}
  const version = str(skeleton['spine']) ?? '4.1.23'
  const resolved: SpineMajor = major ?? (version.startsWith('3.') ? '3.8' : '4.x')
  const is38 = resolved === '3.8'
  const table = new StringTable()

  const rawBones = (root['bones'] as Json[]) ?? []
  const boneNames = rawBones.map((b) => str(b['name']) ?? '')
  const bones: BoneRecord[] = rawBones.map((b) => ({
    name: str(b['name']) ?? '',
    parent: b['parent'] === undefined ? -1 : boneNames.indexOf(str(b['parent']) ?? ''),
    rotation: num(b['rotation'], 0),
    x: num(b['x'], 0),
    y: num(b['y'], 0),
    scaleX: num(b['scaleX'], 1),
    scaleY: num(b['scaleY'], 1),
    shearX: num(b['shearX'], 0),
    shearY: num(b['shearY'], 0),
    length: num(b['length'], 0),
    transformMode: indexOfMode(TRANSFORM_MODES, b['transform'], 'normal'),
    skinRequired: bool(b['skin'], false),
  }))

  const rawSlots = (root['slots'] as Json[]) ?? []
  const slotNames = rawSlots.map((s) => str(s['name']) ?? '')
  const slots: SlotRecord[] = rawSlots.map((s) => {
    const attachmentName = str(s['attachment'])
    return {
      name: str(s['name']) ?? '',
      bone: boneNames.indexOf(str(s['bone']) ?? ''),
      color: parseRgba(s['color'], -1),
      darkColor: s['dark'] === undefined ? -1 : parseRgb(s['dark'], 0),
      attachmentName,
      attachmentNameIndex: table.ref(attachmentName),
      blendMode: indexOfMode(BLEND_MODES, s['blend'], 'normal'),
    }
  })

  const rawIk = (root['ik'] as Json[]) ?? []
  const ik: IkRecord[] = rawIk.map((c) => ({
    name: str(c['name']) ?? '',
    order: num(c['order'], 0),
    skinRequired: bool(c['skin'], false),
    bones: ((c['bones'] as string[]) ?? []).map((b) => boneNames.indexOf(b)),
    target: boneNames.indexOf(str(c['target']) ?? ''),
    mix: num(c['mix'], 1),
    softness: num(c['softness'], 0),
    bendDirection: bool(c['bendPositive'], true) ? 1 : -1,
    compress: bool(c['compress'], false),
    stretch: bool(c['stretch'], false),
    uniform: bool(c['uniform'], false),
  }))

  const rawTransform = (root['transform'] as Json[]) ?? []
  const transform: TransformRecord[] = rawTransform.map((c) => ({
    name: str(c['name']) ?? '',
    order: num(c['order'], 0),
    skinRequired: bool(c['skin'], false),
    bones: ((c['bones'] as string[]) ?? []).map((b) => boneNames.indexOf(b)),
    target: boneNames.indexOf(str(c['target']) ?? ''),
    local: bool(c['local'], false),
    relative: bool(c['relative'], false),
    offsetRotation: num(c['rotation'], 0),
    offsetX: num(c['x'], 0),
    offsetY: num(c['y'], 0),
    offsetScaleX: num(c['scaleX'], 0),
    offsetScaleY: num(c['scaleY'], 0),
    offsetShearY: num(c['shearY'], 0),
    mixRotate: num(is38 ? c['rotateMix'] : c['mixRotate'], 1),
    mixX: num(is38 ? c['translateMix'] : c['mixX'], 1),
    mixY: num(is38 ? c['translateMix'] : c['mixY'], 1),
    mixScaleX: num(is38 ? c['scaleMix'] : c['mixScaleX'], 1),
    mixScaleY: num(is38 ? c['scaleMix'] : c['mixScaleY'], 1),
    mixShearY: num(is38 ? c['shearMix'] : c['mixShearY'], 1),
  }))

  const rawPath = (root['path'] as Json[]) ?? []
  const path: PathRecord[] = rawPath.map((c) => ({
    name: str(c['name']) ?? '',
    order: num(c['order'], 0),
    skinRequired: bool(c['skin'], false),
    bones: ((c['bones'] as string[]) ?? []).map((b) => boneNames.indexOf(b)),
    target: slotNames.indexOf(str(c['target']) ?? ''),
    positionMode: indexOfMode(POSITION_MODES, c['positionMode'], 'percent'),
    spacingMode: indexOfMode(SPACING_MODES, c['spacingMode'], 'length'),
    rotateMode: indexOfMode(ROTATE_MODES, c['rotateMode'], 'tangent'),
    offsetRotation: num(c['rotation'], 0),
    position: num(c['position'], 0),
    spacing: num(c['spacing'], 0),
    mixRotate: num(is38 ? c['rotateMix'] : c['mixRotate'], 1),
    mixX: num(is38 ? c['translateMix'] : c['mixX'], 1),
    mixY: num(is38 ? c['translateMix'] : c['mixY'], 1),
  }))

  const rawSkins = (root['skins'] as Json[]) ?? []
  const skinNames = rawSkins.map((s) => str(s['name']) ?? 'default')
  const skins: Skin[] = rawSkins.map((s) => {
    const name = str(s['name']) ?? 'default'
    const entries: SkinSlotEntry[] = []
    for (const [slotName, byKey] of Object.entries((s['attachments'] as Json) ?? {})) {
      entries.push({
        slot: slotNames.indexOf(slotName),
        attachments: Object.entries(byKey as Json).map(([key, j]) =>
          attachmentFromJson(key, j as Json, table, is38),
        ),
      })
    }
    return {
      name,
      // 默认皮肤在二进制里不写名字,重建时保持一致
      nameIndex: name === 'default' ? 0 : table.ref(name),
      bones: ((s['bones'] as string[]) ?? []).map((b) => boneNames.indexOf(b)),
      ik: ((s['ik'] as string[]) ?? []).map((n) => rawIk.findIndex((c) => c['name'] === n)),
      transform: ((s['transform'] as string[]) ?? []).map((n) => rawTransform.findIndex((c) => c['name'] === n)),
      path: ((s['path'] as string[]) ?? []).map((n) => rawPath.findIndex((c) => c['name'] === n)),
      slots: entries,
    }
  })

  const rawEvents = (root['events'] as Json) ?? {}
  const events: EventDef[] = Object.entries(rawEvents).map(([name, j]) => {
    const e = j as Json
    const audioPath = str(e['audio'])
    return {
      name,
      nameIndex: table.ref(name),
      int: num(e['int'], 0),
      float: num(e['float'], 0),
      string: str(e['string']),
      audioPath,
      volume: num(e['volume'], 1),
      balance: num(e['balance'], 0),
    }
  })

  const names: NameLookup = {
    slots: slotNames, bones: boneNames,
    ik: rawIk.map((c) => str(c['name']) ?? ''),
    transform: rawTransform.map((c) => str(c['name']) ?? ''),
    path: rawPath.map((c) => str(c['name']) ?? ''),
    skins: skinNames,
    events: events.map((e) => e.name),
  }

  const animations = Object.entries((root['animations'] as Json) ?? {}).map(([name, j]) =>
    animationFromJson(name, j as Json, is38, names, table),
  )

  return {
    header: {
      hash: str(skeleton['hash']),
      version,
      major: resolved,
      x: num(skeleton['x'], 0),
      y: num(skeleton['y'], 0),
      width: num(skeleton['width'], 0),
      height: num(skeleton['height'], 0),
      // JSON 里没有 nonessential 开关;有 fps/images 就说明是带编辑器信息的导出
      nonessential: skeleton['fps'] !== undefined || skeleton['images'] !== undefined,
      fps: skeleton['fps'] === undefined ? null : num(skeleton['fps'], 30),
      imagesPath: str(skeleton['images']),
      audioPath: str(skeleton['audio']),
    },
    strings: table.values,
    bones, slots, ik, transform, path, skins, events, animations,
    failure: null,
    endOffset: 0,
    totalBytes: 0,
  }
}

export function fromJsonText(text: string, major?: SpineMajor): SkeletonPart {
  return fromJson(JSON.parse(text) as Json, major)
}
