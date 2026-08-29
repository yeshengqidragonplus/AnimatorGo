import { SpineOutput } from './output.ts'
import type { SkeletonPart } from './readSkeleton.ts'
import type { Attachment, Skin, Vertices } from './readSkins.ts'
import { ATTACHMENT_TYPES } from './readSkins.ts'
import type { AnimationData, EventDef, Timeline } from './readAnimations.ts'
import { CURVE_BEZIER, CURVE_LINEAR, CURVE_STEPPED } from './readAnimations.ts'

/**
 * 把读出来的结构写回 `.skel`。
 *
 * **严格按 [readSkeleton.ts](./readSkeleton.ts) 的镜像实现** —— 每个 read 对应一个 write,
 * 顺序与条件分支完全一致。验收标准是**读进来再写回去,与原文件逐字节相同**;
 * 差一个字节就说明某处读或写理解有误。
 *
 * 布局说明见 [docs/SPINE-BINARY.md](../../../docs/SPINE-BINARY.md)。
 */

// ─── 皮肤 ────────────────────────────────────────────────────────────────────

function writeVertices(out: SpineOutput, v: Vertices): void {
  out.writeBoolean(v.weighted)
  if (!v.weighted) {
    for (const n of v.positions) out.writeFloat(n)
    return
  }
  for (const entry of v.weights) {
    out.writeVarInt(entry.length)
    for (const w of entry) {
      out.writeVarInt(w.bone)
      out.writeFloat(w.x)
      out.writeFloat(w.y)
      out.writeFloat(w.weight)
    }
  }
}

function writeShorts(out: SpineOutput, values: readonly number[]): void {
  out.writeVarInt(values.length)
  for (const n of values) {
    out.writeByte((n >> 8) & 0xff)
    out.writeByte(n & 0xff)
  }
}

function writeAttachment(
  out: SpineOutput,
  a: Attachment,
  is38: boolean,
  nonessential: boolean,
): void {
  out.writeStringRefIndex(a.nameIndex)
  out.writeByte(ATTACHMENT_TYPES.indexOf(a.type))

  const d = a.data
  const f = (k: string) => out.writeFloat(d[k] as number)
  const seq = () => {
    if (is38) return
    if (a.sequence === null) {
      out.writeBoolean(false)
      return
    }
    out.writeBoolean(true)
    out.writeVarInt(a.sequence.count)
    out.writeVarInt(a.sequence.start)
    out.writeVarInt(a.sequence.digits)
    out.writeVarInt(a.sequence.setupIndex)
  }

  switch (a.type) {
    case 'region':
      out.writeStringRefIndex(d['pathIndex'] as number)
      f('rotation'); f('x'); f('y'); f('scaleX'); f('scaleY'); f('width'); f('height')
      out.writeInt(d['color'] as number)
      seq()
      break

    case 'boundingbox':
      out.writeVarInt(d['vertexCount'] as number)
      writeVertices(out, d['vertices'] as Vertices)
      if (nonessential) out.writeInt(d['color'] as number)
      break

    case 'mesh':
      out.writeStringRefIndex(d['pathIndex'] as number)
      out.writeInt(d['color'] as number)
      out.writeVarInt(d['vertexCount'] as number)
      for (const n of d['uvs'] as number[]) out.writeFloat(n)
      writeShorts(out, d['triangles'] as number[])
      writeVertices(out, d['vertices'] as Vertices)
      out.writeVarInt(d['hullLength'] as number)
      seq()
      if (nonessential) {
        writeShorts(out, d['edges'] as number[])
        f('width'); f('height')
      }
      break

    case 'linkedmesh':
      out.writeStringRefIndex(d['pathIndex'] as number)
      out.writeInt(d['color'] as number)
      out.writeStringRefIndex(d['skinNameIndex'] as number)
      out.writeStringRefIndex(d['parentIndex'] as number)
      out.writeBoolean(d['inheritTimelines'] as boolean)
      seq()
      if (nonessential) { f('width'); f('height') }
      break

    case 'path':
      out.writeBoolean(d['closed'] as boolean)
      out.writeBoolean(d['constantSpeed'] as boolean)
      out.writeVarInt(d['vertexCount'] as number)
      writeVertices(out, d['vertices'] as Vertices)
      for (const n of d['lengths'] as number[]) out.writeFloat(n)
      if (nonessential) out.writeInt(d['color'] as number)
      break

    case 'point':
      f('rotation'); f('x'); f('y')
      if (nonessential) out.writeInt(d['color'] as number)
      break

    case 'clipping':
      out.writeVarInt(d['endSlot'] as number)
      out.writeVarInt(d['vertexCount'] as number)
      writeVertices(out, d['vertices'] as Vertices)
      if (nonessential) out.writeInt(d['color'] as number)
      break
  }
}

function writeSkins(
  out: SpineOutput,
  skins: readonly Skin[],
  is38: boolean,
  nonessential: boolean,
): void {
  const writeSlots = (skin: Skin) => {
    for (const entry of skin.slots) {
      out.writeVarInt(entry.slot)
      out.writeVarInt(entry.attachments.length)
      for (const a of entry.attachments) {
        out.writeStringRefIndex(a.keyIndex)
        writeAttachment(out, a, is38, nonessential)
      }
    }
  }

  // 默认皮肤没有名字和约束列表,直接以 slot 数量开头;为 0 表示没有默认皮肤
  const def = skins.find((s) => s.name === 'default')
  out.writeVarInt(def === undefined ? 0 : def.slots.length)
  if (def !== undefined) writeSlots(def)

  const extra = skins.filter((s) => s !== def)
  out.writeVarInt(extra.length)
  for (const skin of extra) {
    out.writeStringRefIndex(skin.nameIndex)
    for (const list of [skin.bones, skin.ik, skin.transform, skin.path]) {
      out.writeVarInt(list.length)
      for (const n of list) out.writeVarInt(n)
    }
    out.writeVarInt(skin.slots.length)
    writeSlots(skin)
  }
}

// ─── 动画 ────────────────────────────────────────────────────────────────────

/** 曲线段。3.8 只写一条,4.x 每分量各一条。 */
function writeCurve(out: SpineOutput, frame: Record<string, unknown>): void {
  const curve = frame['curve'] as string | undefined
  if (curve === 'stepped') {
    out.writeByte(CURVE_STEPPED)
    return
  }
  if (curve !== 'bezier') {
    out.writeByte(CURVE_LINEAR)
    return
  }
  out.writeByte(CURVE_BEZIER)
  for (const b of frame['beziers'] as number[][]) {
    for (const n of b) out.writeFloat(n)
  }
}

function writeValueTimeline(
  out: SpineOutput,
  is38: boolean,
  frames: readonly Record<string, unknown>[],
  valueNames: readonly string[],
): void {
  const values = (f: Record<string, unknown>) => {
    for (const n of valueNames) out.writeFloat(f[n] as number)
  }

  if (is38) {
    // 3.8:每帧「时间 → 值 → 曲线」
    frames.forEach((f, i) => {
      out.writeFloat(f['time'] as number)
      values(f)
      if (i < frames.length - 1) writeCurve(out, f)
    })
    return
  }

  // 4.x:先写第一帧,循环里写「下一帧的时间和值 → 上一帧的曲线」
  const first = frames[0]!
  out.writeFloat(first['time'] as number)
  values(first)

  for (let i = 0; i < frames.length - 1; i++) {
    const next = frames[i + 1]!
    out.writeFloat(next['time'] as number)
    values(next)
    writeCurve(out, frames[i]!)
  }
}

const BONE_KINDS_38 = ['rotate', 'translate', 'scale', 'shear']
const BONE_KINDS_4X = [
  'rotate', 'translate', 'translateX', 'translateY',
  'scale', 'scaleX', 'scaleY',
  'shear', 'shearX', 'shearY',
]

const BONE_VALUE_NAMES: Record<string, string[]> = {
  rotate: ['value'],
  translate: ['x', 'y'],
  translateX: ['value'], translateY: ['value'],
  scale: ['x', 'y'], scaleX: ['value'], scaleY: ['value'],
  shear: ['x', 'y'], shearX: ['value'], shearY: ['value'],
}

/** 4.x 的 slot 颜色时间轴通道数,与读取端一致 */
const SLOT_CHANNELS: Record<number, number> = { 1: 4, 2: 3, 3: 7, 4: 6, 5: 1 }

function writeTimelineHead(out: SpineOutput, t: Timeline, is38: boolean): void {
  out.writeVarInt(t.frames.length)
  // bezierCount 只在带曲线的时间轴上出现(读取时记为 -1 表示没有)
  if (!is38 && t.bezierCount >= 0) out.writeVarInt(t.bezierCount)
}

function writeSlotTimeline(out: SpineOutput, t: Timeline, is38: boolean): void {
  if (t.kind === 'attachment') {
    out.writeByte(0)
    writeTimelineHead(out, t, is38)
    for (const f of t.frames) {
      out.writeFloat(f['time'] as number)
      out.writeStringRefIndex(f['nameIndex'] as number)
    }
    return
  }

  if (is38) {
    out.writeByte(t.kind === 'color' ? 1 : 2)
    writeTimelineHead(out, t, is38)
    t.frames.forEach((f, i) => {
      out.writeFloat(f['time'] as number)
      for (const c of f['colors'] as number[]) out.writeInt(c)
      if (i < t.frames.length - 1) writeCurve(out, f)
    })
    return
  }

  const type = Number(t.kind.replace('slotColor', ''))
  out.writeByte(type)
  writeTimelineHead(out, t, is38)

  const channels = SLOT_CHANNELS[type]!
  const colorOf = (f: Record<string, unknown>) => {
    const c = f['color'] as number[]
    for (let i = 0; i < channels; i++) out.writeByte(c[i]!)
  }

  const first = t.frames[0]!
  out.writeFloat(first['time'] as number)
  colorOf(first)
  for (let i = 0; i < t.frames.length - 1; i++) {
    const next = t.frames[i + 1]!
    out.writeFloat(next['time'] as number)
    colorOf(next)
    writeCurve(out, t.frames[i]!)
  }
}

function writeAnimation(out: SpineOutput, anim: AnimationData, is38: boolean): void {
  const by = (pred: (t: Timeline) => boolean) => anim.timelines.filter(pred)
  const groupByOwner = (list: Timeline[]) => {
    const map = new Map<number, Timeline[]>()
    for (const t of list) {
      const arr = map.get(t.owner)
      if (arr === undefined) map.set(t.owner, [t])
      else arr.push(t)
    }
    return map
  }

  // ⚠️ 4.x 每条动画开头是时间轴总数
  if (!is38) out.writeVarInt(anim.timelines.length)

  // ── slot ──
  const slotKinds = (t: Timeline) =>
    t.kind === 'attachment' || t.kind === 'color' || t.kind === 'twoColor' || t.kind.startsWith('slotColor')
  const slotGroups = groupByOwner(by(slotKinds))
  out.writeVarInt(slotGroups.size)
  for (const [slot, list] of slotGroups) {
    out.writeVarInt(slot)
    out.writeVarInt(list.length)
    for (const t of list) writeSlotTimeline(out, t, is38)
  }

  // ── 骨骼 ──
  const kinds = is38 ? BONE_KINDS_38 : BONE_KINDS_4X
  const boneGroups = groupByOwner(by((t) => kinds.includes(t.kind)))
  out.writeVarInt(boneGroups.size)
  for (const [bone, list] of boneGroups) {
    out.writeVarInt(bone)
    out.writeVarInt(list.length)
    for (const t of list) {
      out.writeByte(kinds.indexOf(t.kind))
      writeTimelineHead(out, t, is38)
      writeValueTimeline(out, is38, t.frames, BONE_VALUE_NAMES[t.kind]!)
    }
  }

  // ── IK ──
  const ik = by((t) => t.kind === 'ik')
  out.writeVarInt(ik.length)
  for (const t of ik) {
    out.writeVarInt(t.owner)
    writeTimelineHead(out, t, is38)
    const tail = (f: Record<string, unknown>) => {
      out.writeSByte(f['bendDirection'] as number)
      out.writeBoolean(f['compress'] as boolean)
      out.writeBoolean(f['stretch'] as boolean)
    }
    const head = (f: Record<string, unknown>) => {
      out.writeFloat(f['time'] as number)
      out.writeFloat(f['mix'] as number)
      out.writeFloat(f['softness'] as number)
    }

    if (is38) {
      t.frames.forEach((f, i) => {
        head(f)
        tail(f)
        if (i < t.frames.length - 1) writeCurve(out, f)
      })
    } else {
      head(t.frames[0]!)
      tail(t.frames[0]!)
      for (let i = 0; i < t.frames.length - 1; i++) {
        head(t.frames[i + 1]!)
        writeCurve(out, t.frames[i]!)
        tail(t.frames[i + 1]!)
      }
    }
  }

  // ── transform ──
  const transform = by((t) => t.kind === 'transform')
  out.writeVarInt(transform.length)
  const transformNames = is38
    ? ['mixRotate', 'mixTranslate', 'mixScale', 'mixShear']
    : ['mixRotate', 'mixX', 'mixY', 'mixScaleX', 'mixScaleY', 'mixShearY']
  for (const t of transform) {
    out.writeVarInt(t.owner)
    writeTimelineHead(out, t, is38)
    writeValueTimeline(out, is38, t.frames, transformNames)
  }

  // ── path ──
  const path = by((t) => t.kind.startsWith('path'))
  const pathGroups = groupByOwner(path)
  out.writeVarInt(pathGroups.size)
  for (const [owner, list] of pathGroups) {
    out.writeVarInt(owner)
    out.writeVarInt(list.length)
    for (const t of list) {
      const type = Number(t.kind.replace('path', ''))
      out.writeByte(type)
      writeTimelineHead(out, t, is38)
      const names =
        type === 2
          ? is38 ? ['mixRotate', 'mixTranslate'] : ['mixRotate', 'mixX', 'mixY']
          : ['value']
      writeValueTimeline(out, is38, t.frames, names)
    }
  }

  // ── deform ──
  const deform = by((t) => t.kind === 'deform')
  // 读取时每条 deform 单独成一条时间轴,写回时要按 skin → slot 重新分组
  const bySkin = new Map<number, Timeline[]>()
  for (const t of deform) {
    const skin = (t.frames[0] as Record<string, unknown>)['skin'] as number
    const arr = bySkin.get(skin)
    if (arr === undefined) bySkin.set(skin, [t])
    else arr.push(t)
  }

  out.writeVarInt(bySkin.size)
  for (const [skin, list] of bySkin) {
    out.writeVarInt(skin)
    const bySlot = groupByOwner(list)
    out.writeVarInt(bySlot.size)
    for (const [slot, entries] of bySlot) {
      out.writeVarInt(slot)
      out.writeVarInt(entries.length)
      for (const t of entries) {
        const wrapper = t.frames[0] as Record<string, unknown>
        out.writeStringRefIndex(wrapper['attachmentIndex'] as number)
        if (!is38) out.writeByte(0) // 子类型:0 = deform
        const inner = wrapper['frames'] as Record<string, unknown>[]
        out.writeVarInt(inner.length)
        if (!is38 && t.bezierCount >= 0) out.writeVarInt(t.bezierCount)

        const verts = (f: Record<string, unknown>) => {
          const v = f['vertices'] as number[]
          out.writeVarInt(v.length)
          if (v.length !== 0) {
            out.writeVarInt(f['start'] as number)
            for (const n of v) out.writeFloat(n)
          }
        }

        if (is38) {
          inner.forEach((f, i) => {
            out.writeFloat(f['time'] as number)
            verts(f)
            if (i < inner.length - 1) writeCurve(out, f)
          })
        } else {
          out.writeFloat(inner[0]!['time'] as number)
          for (let i = 0; ; i++) {
            verts(inner[i]!)
            if (i === inner.length - 1) break
            out.writeFloat(inner[i + 1]!['time'] as number)
            writeCurve(out, inner[i]!)
          }
        }
      }
    }
  }

  // ── draw order ──
  const drawOrder = by((t) => t.kind === 'drawOrder')[0]
  out.writeVarInt(drawOrder === undefined ? 0 : drawOrder.frames.length)
  if (drawOrder !== undefined) {
    for (const f of drawOrder.frames) {
      out.writeFloat(f['time'] as number)
      const offsets = f['offsets'] as { slot: number; offset: number }[]
      out.writeVarInt(offsets.length)
      for (const o of offsets) {
        out.writeVarInt(o.slot)
        out.writeVarInt(o.offset)
      }
    }
  }

  // ── 事件 ──
  const event = by((t) => t.kind === 'event')[0]
  out.writeVarInt(event === undefined ? 0 : event.frames.length)
  if (event !== undefined) {
    for (const f of event.frames) {
      out.writeFloat(f['time'] as number)
      out.writeVarInt(f['event'] as number)
      out.writeVarInt(f['int'] as number, false)
      out.writeFloat(f['float'] as number)
      const s = f['string'] as string | null
      out.writeBoolean(s !== null)
      if (s !== null) out.writeString(s)
    }
  }
}

function writeEvents(out: SpineOutput, events: readonly EventDef[]): void {
  out.writeVarInt(events.length)
  for (const e of events) {
    out.writeStringRefIndex(e.nameIndex)
    out.writeVarInt(e.int, false)
    out.writeFloat(e.float)
    out.writeString(e.string)
    out.writeString(e.audioPath)
    if (e.audioPath !== null) {
      out.writeFloat(e.volume)
      out.writeFloat(e.balance)
    }
  }
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

export function writeSkeleton(part: SkeletonPart): Uint8Array {
  const out = new SpineOutput(Math.max(1 << 16, part.totalBytes * 2))
  const h = part.header
  const is38 = h.major === '3.8'

  // 文件头 —— 唯一的版本差异是 hash 的编码
  if (is38) out.writeString(h.hash)
  else out.writeLongHex(h.hash ?? '0000000000000000')
  out.writeString(h.version)
  out.writeFloat(h.x)
  out.writeFloat(h.y)
  out.writeFloat(h.width)
  out.writeFloat(h.height)
  out.writeBoolean(h.nonessential)
  if (h.nonessential) {
    out.writeFloat(h.fps ?? 30)
    out.writeString(h.imagesPath)
    out.writeString(h.audioPath)
  }

  out.writeVarInt(part.strings.length)
  for (const s of part.strings) out.writeString(s)
  out.strings = part.strings

  out.writeVarInt(part.bones.length)
  part.bones.forEach((b, i) => {
    out.writeString(b.name)
    if (i > 0) out.writeVarInt(b.parent)
    out.writeFloat(b.rotation)
    out.writeFloat(b.x)
    out.writeFloat(b.y)
    out.writeFloat(b.scaleX)
    out.writeFloat(b.scaleY)
    out.writeFloat(b.shearX)
    out.writeFloat(b.shearY)
    out.writeFloat(b.length)
    out.writeVarInt(b.transformMode)
    out.writeBoolean(b.skinRequired)
    if (h.nonessential) out.writeInt(0) // 骨骼颜色,读取时丢弃
  })

  out.writeVarInt(part.slots.length)
  for (const s of part.slots) {
    out.writeString(s.name)
    out.writeVarInt(s.bone)
    out.writeInt(s.color)
    out.writeInt(s.darkColor)
    out.writeStringRefIndex(s.attachmentNameIndex)
    out.writeVarInt(s.blendMode)
  }

  out.writeVarInt(part.ik.length)
  for (const c of part.ik) {
    out.writeString(c.name)
    out.writeVarInt(c.order)
    out.writeBoolean(c.skinRequired)
    out.writeVarInt(c.bones.length)
    for (const b of c.bones) out.writeVarInt(b)
    out.writeVarInt(c.target)
    out.writeFloat(c.mix)
    out.writeFloat(c.softness)
    out.writeSByte(c.bendDirection)
    out.writeBoolean(c.compress)
    out.writeBoolean(c.stretch)
    out.writeBoolean(c.uniform)
  }

  out.writeVarInt(part.transform.length)
  for (const c of part.transform) {
    out.writeString(c.name)
    out.writeVarInt(c.order)
    out.writeBoolean(c.skinRequired)
    out.writeVarInt(c.bones.length)
    for (const b of c.bones) out.writeVarInt(b)
    out.writeVarInt(c.target)
    out.writeBoolean(c.local)
    out.writeBoolean(c.relative)
    out.writeFloat(c.offsetRotation)
    out.writeFloat(c.offsetX)
    out.writeFloat(c.offsetY)
    out.writeFloat(c.offsetScaleX)
    out.writeFloat(c.offsetScaleY)
    out.writeFloat(c.offsetShearY)
    if (is38) {
      // 3.8 只有四个 mix —— 两轴合一
      out.writeFloat(c.mixRotate)
      out.writeFloat(c.mixX)
      out.writeFloat(c.mixScaleX)
      out.writeFloat(c.mixShearY)
    } else {
      out.writeFloat(c.mixRotate)
      out.writeFloat(c.mixX)
      out.writeFloat(c.mixY)
      out.writeFloat(c.mixScaleX)
      out.writeFloat(c.mixScaleY)
      out.writeFloat(c.mixShearY)
    }
  }

  out.writeVarInt(part.path.length)
  for (const c of part.path) {
    out.writeString(c.name)
    out.writeVarInt(c.order)
    out.writeBoolean(c.skinRequired)
    out.writeVarInt(c.bones.length)
    for (const b of c.bones) out.writeVarInt(b)
    out.writeVarInt(c.target)
    out.writeVarInt(c.positionMode)
    out.writeVarInt(c.spacingMode)
    out.writeVarInt(c.rotateMode)
    out.writeFloat(c.offsetRotation)
    out.writeFloat(c.position)
    out.writeFloat(c.spacing)
    out.writeFloat(c.mixRotate)
    out.writeFloat(c.mixX)
    if (!is38) out.writeFloat(c.mixY)
  }

  writeSkins(out, part.skins, is38, h.nonessential)
  writeEvents(out, part.events)

  out.writeVarInt(part.animations.length)
  for (const anim of part.animations) {
    out.writeString(anim.name)
    writeAnimation(out, anim, is38)
  }

  return out.toUint8Array()
}
