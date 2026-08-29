import type { SpineInput } from './input.ts'

/**
 * 事件与动画时间轴 —— `.skel` 里最大的一段。
 *
 * ## 两版的曲线编码差异(最关键的一处)
 *
 * | | 3.8 | 4.x |
 * |---|---|---|
 * | 时间轴头 | type, frameCount | type, frameCount, **+ bezierCount** |
 * | 多值通道的贝塞尔 | **一条曲线共用** | **每个分量各一条** |
 *
 * 也就是说 translate 的贝塞尔在 3.8 是 4 个 float,在 4.x 是 8 个(x 和 y 各一条);
 * RGBA 在 3.8 是 4 个,在 4.x 是 16 个。
 *
 * **降级时若各分量曲线不同,只能保留一条 —— 必须报 loss。**
 *
 * 见 [docs/SPINE-BINARY.md](../../../docs/SPINE-BINARY.md)。
 */

export const CURVE_LINEAR = 0
export const CURVE_STEPPED = 1
export const CURVE_BEZIER = 2

export interface EventDef {
  readonly name: string
  readonly nameIndex: number
  readonly int: number
  readonly float: number
  readonly string: string | null
  readonly audioPath: string | null
  readonly volume: number
  readonly balance: number
}

/** 一条时间轴。值原样保留,便于原封写回。 */
export interface Timeline {
  readonly kind: string
  /** slot / bone / 约束的下标,drawOrder 与 event 时间轴为 -1 */
  readonly owner: number
  readonly frames: readonly Record<string, unknown>[]
  /** 4.x 时间轴头里的贝塞尔总数。3.8 没有这个字段,记为 -1。写回时要原样还原。 */
  readonly bezierCount: number
}

export interface AnimationData {
  readonly name: string
  readonly timelines: readonly Timeline[]
  /** 读完这条动画后的字节偏移 —— 排查布局错位用 */
  readonly endOffset: number
  /** 每读完一段记一个偏移 —— 布局错位时用它定位是哪一段 */
  readonly sectionOffsets: readonly { section: string; offset: number }[]
}

// ─── 曲线 ────────────────────────────────────────────────────────────────────

/**
 * 读一帧之后的曲线段。
 *
 * `components` 是该时间轴的值分量个数 —— 3.8 无论几个分量都只存一条曲线,
 * 4.x 每个分量各存一条。
 */
function readCurve(input: SpineInput, is38: boolean, components: number): unknown {
  const type = input.readByte()
  if (type === CURVE_LINEAR) return { curve: 'linear' }
  if (type === CURVE_STEPPED) return { curve: 'stepped' }

  const curves: number[][] = []
  const count = is38 ? 1 : components
  for (let i = 0; i < count; i++) {
    curves.push([input.readFloat(), input.readFloat(), input.readFloat(), input.readFloat()])
  }
  return { curve: 'bezier', beziers: curves }
}

/**
 * 通用的「时间 + N 个值 + 曲线」时间轴。
 *
 * ⚠️ 帧的读法是错位的:先读第一帧的时间和值,循环里读**下一帧**的,
 * 曲线夹在两帧之间。最后一帧后面没有曲线。
 */
function readValueTimeline(
  input: SpineInput,
  is38: boolean,
  frameCount: number,
  valueCount: number,
  valueNames: readonly string[],
): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = []
  const readValues = () => {
    const v: number[] = []
    for (let i = 0; i < valueCount; i++) v.push(input.readFloat())
    return v
  }
  const toRecord = (time: number, values: number[]) => {
    const r: Record<string, unknown> = { time }
    valueNames.forEach((n, i) => (r[n] = values[i]))
    return r
  }

  if (is38) {
    // 3.8:每帧读自己的时间和值,后面跟一个曲线(最后一帧没有)
    for (let frame = 0; frame < frameCount; frame++) {
      const record = toRecord(input.readFloat(), readValues())
      if (frame < frameCount - 1) Object.assign(record, readCurve(input, true, valueCount))
      frames.push(record)
    }
    return frames
  }

  // 4.x:曲线挪到了**下一帧的值之后**,所以要先读第一帧再错位循环
  let time = input.readFloat()
  let values = readValues()

  for (let frame = 0; ; frame++) {
    const record = toRecord(time, values)
    if (frame === frameCount - 1) {
      frames.push(record)
      break
    }
    const nextTime = input.readFloat()
    const nextValues = readValues()
    Object.assign(record, readCurve(input, false, valueCount))
    frames.push(record)
    time = nextTime
    values = nextValues
  }
  return frames
}

/** 逐字节读的颜色(4.x 的 slot 颜色是分通道字节,不是打包的 int) */
function readColorBytes(input: SpineInput, channels: number): number[] {
  const out: number[] = []
  for (let i = 0; i < channels; i++) out.push(input.readByte())
  return out
}

// ─── slot 时间轴 ─────────────────────────────────────────────────────────────

const SLOT_ATTACHMENT = 0
// 3.8
const SLOT_COLOR_38 = 1
const SLOT_TWO_COLOR_38 = 2
// 4.x
const SLOT_RGBA = 1
const SLOT_RGB = 2
const SLOT_RGBA2 = 3
const SLOT_RGB2 = 4
const SLOT_ALPHA = 5

/** 4.x 各 slot 颜色时间轴的通道数 —— 同时也是贝塞尔分量数 */
const SLOT_CHANNELS: Record<number, number> = {
  [SLOT_RGBA]: 4,
  [SLOT_RGB]: 3,
  [SLOT_RGBA2]: 7, // rgba + rgb(暗色)
  [SLOT_RGB2]: 6,
  [SLOT_ALPHA]: 1,
}

function readSlotTimeline(
  input: SpineInput,
  is38: boolean,
  type: number,
  frameCount: number,
): { kind: string; frames: Record<string, unknown>[] } {
  if (type === SLOT_ATTACHMENT) {
    const frames: Record<string, unknown>[] = []
    for (let i = 0; i < frameCount; i++) {
      const time = input.readFloat()
      const at = input.readStringRefAt()
      frames.push({ time, name: at.value, nameIndex: at.index })
    }
    return { kind: 'attachment', frames }
  }

  if (is38) {
    // 3.8:颜色打包成 int,整条时间轴共用一条曲线,且是「每帧后跟曲线」的简单循环
    const ints = type === SLOT_TWO_COLOR_38 ? 2 : 1
    const frames: Record<string, unknown>[] = []
    for (let frame = 0; frame < frameCount; frame++) {
      const record: Record<string, unknown> = {
        time: input.readFloat(),
        colors: Array.from({ length: ints }, () => input.readInt()),
      }
      if (frame < frameCount - 1) Object.assign(record, readCurve(input, true, 1))
      frames.push(record)
    }
    return { kind: type === SLOT_COLOR_38 ? 'color' : 'twoColor', frames }
  }

  // 4.x:分通道字节,每通道一条贝塞尔
  const channels = SLOT_CHANNELS[type]
  if (channels === undefined) throw new Error(`未知的 4.x slot 时间轴类型 ${type}`)

  const frames: Record<string, unknown>[] = []
  let time = input.readFloat()
  let color = readColorBytes(input, channels)

  for (let frame = 0; ; frame++) {
    const record: Record<string, unknown> = { time, color }
    if (frame === frameCount - 1) {
      frames.push(record)
      break
    }
    const nextTime = input.readFloat()
    const nextColor = readColorBytes(input, channels)
    Object.assign(record, readCurve(input, false, channels))
    frames.push(record)
    time = nextTime
    color = nextColor
  }
  return { kind: `slotColor${type}`, frames }
}

// ─── 骨骼时间轴 ──────────────────────────────────────────────────────────────

/** 各类型的值分量数。4.x 多出的单轴变体都是 1 个值。 */
function boneTimelineShape(type: number, is38: boolean): { kind: string; values: string[] } {
  if (is38) {
    switch (type) {
      case 0: return { kind: 'rotate', values: ['value'] }
      case 1: return { kind: 'translate', values: ['x', 'y'] }
      case 2: return { kind: 'scale', values: ['x', 'y'] }
      case 3: return { kind: 'shear', values: ['x', 'y'] }
      default: throw new Error(`未知的 3.8 骨骼时间轴类型 ${type}`)
    }
  }
  switch (type) {
    case 0: return { kind: 'rotate', values: ['value'] }
    case 1: return { kind: 'translate', values: ['x', 'y'] }
    case 2: return { kind: 'translateX', values: ['value'] }
    case 3: return { kind: 'translateY', values: ['value'] }
    case 4: return { kind: 'scale', values: ['x', 'y'] }
    case 5: return { kind: 'scaleX', values: ['value'] }
    case 6: return { kind: 'scaleY', values: ['value'] }
    case 7: return { kind: 'shear', values: ['x', 'y'] }
    case 8: return { kind: 'shearX', values: ['value'] }
    case 9: return { kind: 'shearY', values: ['value'] }
    default: throw new Error(`未知的 4.x 骨骼时间轴类型 ${type}`)
  }
}

// ─── 动画 ────────────────────────────────────────────────────────────────────

/** 4.x 在 frameCount 之后多一个 bezierCount —— 这是两版时间轴头的唯一差异 */
function readTimelineHead(
  input: SpineInput,
  is38: boolean,
  hasCurves = true,
): { frameCount: number; bezierCount: number } {
  const frameCount = input.readVarInt()
  // bezierCount 只在带曲线的时间轴上出现;attachment / drawOrder / event 没有
  const bezierCount = !is38 && hasCurves ? input.readVarInt() : -1
  return { frameCount, bezierCount }
}

function readAnimation(
  input: SpineInput,
  name: string,
  is38: boolean,
  sectionOffsets: { section: string; offset: number }[],
): AnimationData {
  const timelines: Timeline[] = []
  const mark = (section: string) => sectionOffsets.push({ section, offset: input.offset })

  // ⚠️ 4.x 每条动画开头多一个时间轴总数(3.8 没有)
  if (!is38) input.readVarInt()
  mark('start')

  // ── slot ──
  for (let i = 0, n = input.readVarInt(); i < n; i++) {
    const slot = input.readVarInt()
    for (let ii = 0, nn = input.readVarInt(); ii < nn; ii++) {
      const type = input.readByte()
      // ⚠️ attachment 时间轴没有曲线,因此 4.x 也**不写** bezierCount
      const { frameCount, bezierCount } = readTimelineHead(input, is38, type !== SLOT_ATTACHMENT)
      const { kind, frames } = readSlotTimeline(input, is38, type, frameCount)
      timelines.push({ kind, owner: slot, frames, bezierCount })
    }
  }

  mark('骨骼 之前')
  // ── 骨骼 ──
  for (let i = 0, n = input.readVarInt(); i < n; i++) {
    const bone = input.readVarInt()
    for (let ii = 0, nn = input.readVarInt(); ii < nn; ii++) {
      const type = input.readByte()
      const { frameCount, bezierCount } = readTimelineHead(input, is38)
      const shape = boneTimelineShape(type, is38)
      timelines.push({
        kind: shape.kind,
        owner: bone,
        frames: readValueTimeline(input, is38, frameCount, shape.values.length, shape.values),
        bezierCount,
      })
    }
  }

  mark('IK 约束 之前')
  // ── IK 约束 ──
  for (let i = 0, n = input.readVarInt(); i < n; i++) {
    const index = input.readVarInt()
    const { frameCount, bezierCount } = readTimelineHead(input, is38)
    const frames: Record<string, unknown>[] = []

    if (is38) {
      for (let frame = 0; frame < frameCount; frame++) {
        const record: Record<string, unknown> = {
          time: input.readFloat(),
          mix: input.readFloat(),
          softness: input.readFloat(),
          bendDirection: input.readSByte(),
          compress: input.readBoolean(),
          stretch: input.readBoolean(),
        }
        if (frame < frameCount - 1) Object.assign(record, readCurve(input, true, 2))
        frames.push(record)
      }
    } else {
      let time = input.readFloat()
      let mix = input.readFloat()
      let softness = input.readFloat()
      for (let frame = 0; ; frame++) {
        const record: Record<string, unknown> = {
          time,
          mix,
          softness,
          bendDirection: input.readSByte(),
          compress: input.readBoolean(),
          stretch: input.readBoolean(),
        }
        if (frame === frameCount - 1) {
          frames.push(record)
          break
        }
        const t2 = input.readFloat()
        const m2 = input.readFloat()
        const s2 = input.readFloat()
        Object.assign(record, readCurve(input, false, 2))
        frames.push(record)
        time = t2
        mix = m2
        softness = s2
      }
    }
    timelines.push({ kind: 'ik', owner: index, frames, bezierCount })
  }

  mark('transform 约束 之前')
  // ── transform 约束 ──
  for (let i = 0, n = input.readVarInt(); i < n; i++) {
    const index = input.readVarInt()
    const { frameCount, bezierCount } = readTimelineHead(input, is38)
    // 3.8:rotate/translate/scale/shear 四个 mix;4.x:六个
    const names = is38
      ? ['mixRotate', 'mixTranslate', 'mixScale', 'mixShear']
      : ['mixRotate', 'mixX', 'mixY', 'mixScaleX', 'mixScaleY', 'mixShearY']
    timelines.push({
      kind: 'transform',
      owner: index,
      frames: readValueTimeline(input, is38, frameCount, names.length, names),
      bezierCount,
    })
  }

  mark('path 约束 之前')
  // ── path 约束 ──
  for (let i = 0, n = input.readVarInt(); i < n; i++) {
    const index = input.readVarInt()
    for (let ii = 0, nn = input.readVarInt(); ii < nn; ii++) {
      const type = input.readByte()
      const { frameCount, bezierCount } = readTimelineHead(input, is38)

      // 0=position 1=spacing 都是单值;2=mix 在 3.8 是两值,4.x 是三值
      const names =
        type === 2
          ? is38
            ? ['mixRotate', 'mixTranslate']
            : ['mixRotate', 'mixX', 'mixY']
          : ['value']

      timelines.push({
        kind: `path${type}`,
        owner: index,
        frames: readValueTimeline(input, is38, frameCount, names.length, names),
        bezierCount,
      })
    }
  }

  mark('deform 之前')
  // ── deform ──
  for (let i = 0, n = input.readVarInt(); i < n; i++) {
    const skin = input.readVarInt()
    for (let ii = 0, nn = input.readVarInt(); ii < nn; ii++) {
      const slot = input.readVarInt()
      for (let iii = 0, nnn = input.readVarInt(); iii < nnn; iii++) {
        const attachmentAt = input.readStringRefAt()
        const attachment = attachmentAt.value
        // 4.x 把这段改名为 attachment 时间轴,并加了子类型(0=deform 1=sequence)
        if (!is38) input.readByte()
        const { frameCount, bezierCount } = readTimelineHead(input, is38)
        const frames: Record<string, unknown>[] = []

        /** 一帧的顶点偏移:count 为 0 表示无形变,否则先读起始下标再读 count 个 float */
        const readDeform = () => {
          const count = input.readVarInt()
          if (count === 0) return { start: 0, vertices: [] as number[] }
          const start = input.readVarInt()
          const vertices: number[] = []
          for (let v = 0; v < count; v++) vertices.push(input.readFloat())
          return { start, vertices }
        }

        if (is38) {
          // 3.8:每帧「时间 → 顶点 → 曲线」
          for (let frame = 0; frame < frameCount; frame++) {
            const record: Record<string, unknown> = { time: input.readFloat(), ...readDeform() }
            if (frame < frameCount - 1) Object.assign(record, readCurve(input, true, 1))
            frames.push(record)
          }
        } else {
          // 4.x:时间先读一个,循环里是「顶点 → 下一帧时间 → 曲线」
          let time = input.readFloat()
          for (let frame = 0; ; frame++) {
            const record: Record<string, unknown> = { time, ...readDeform() }
            if (frame === frameCount - 1) {
              frames.push(record)
              break
            }
            const nextTime = input.readFloat()
            Object.assign(record, readCurve(input, false, 1))
            frames.push(record)
            time = nextTime
          }
        }

        timelines.push({ kind: 'deform', owner: slot, frames: [{ skin, attachment, attachmentIndex: attachmentAt.index, frames }], bezierCount })
      }
    }
  }

  mark('draw order 之前')
  // ── draw order ──
  const drawOrderCount = input.readVarInt()
  if (drawOrderCount > 0) {
    const frames: Record<string, unknown>[] = []
    for (let i = 0; i < drawOrderCount; i++) {
      const time = input.readFloat()
      const offsets: { slot: number; offset: number }[] = []
      for (let ii = 0, nn = input.readVarInt(); ii < nn; ii++) {
        offsets.push({ slot: input.readVarInt(), offset: input.readVarInt() })
      }
      frames.push({ time, offsets })
    }
    timelines.push({ kind: 'drawOrder', owner: -1, frames, bezierCount: -1 })
  }

  mark('事件 之前')
  // ── 事件 ──
  const eventCount = input.readVarInt()
  if (eventCount > 0) {
    const frames: Record<string, unknown>[] = []
    for (let i = 0; i < eventCount; i++) {
      frames.push({
        time: input.readFloat(),
        event: input.readVarInt(),
        int: input.readVarInt(false),
        float: input.readFloat(),
        string: input.readBoolean() ? input.readString() : null,
        // volume/balance 只在事件带音频时才有 —— 由调用方按事件定义补读
      })
    }
    timelines.push({ kind: 'event', owner: -1, frames, bezierCount: -1 })
  }

  mark('结束')
  return { name, timelines, endOffset: input.offset, sectionOffsets }
}

/** 事件定义表。带 audioPath 的事件后面多两个 float。 */
export function readEvents(input: SpineInput): EventDef[] {
  const count = input.readVarInt()
  const out: EventDef[] = []
  for (let i = 0; i < count; i++) {
    const nameAt = input.readStringRefAt()
    const name = nameAt.value ?? ''
    const int = input.readVarInt(false)
    const float = input.readFloat()
    const string = input.readString()
    const audioPath = input.readString()
    let volume = 1
    let balance = 0
    if (audioPath !== null) {
      volume = input.readFloat()
      balance = input.readFloat()
    }
    out.push({ name, nameIndex: nameAt.index, int, float, string, audioPath, volume, balance })
  }
  return out
}

export interface AnimationsResult {
  readonly animations: readonly AnimationData[]
  /** 解析失败时记录是哪条动画、在哪个字节 —— 布局排查全靠它 */
  readonly failure: {
    name: string
    index: number
    offset: number
    message: string
    /** 失败前已走完的分段 —— 直接指出是哪一段布局错了 */
    trace: { section: string; offset: number }[]
  } | null
}

export function readAnimations(input: SpineInput, is38: boolean): AnimationsResult {
  const count = input.readVarInt()
  const animations: AnimationData[] = []

  for (let i = 0; i < count; i++) {
    const name = input.readString() ?? ''
    const trace: { section: string; offset: number }[] = []
    try {
      animations.push(readAnimation(input, name, is38, trace))
    } catch (error) {
      return {
        animations,
        failure: {
          name,
          index: i,
          offset: input.offset,
          message: error instanceof Error ? error.message : String(error),
          trace,
        },
      }
    }
  }
  return { animations, failure: null }
}
