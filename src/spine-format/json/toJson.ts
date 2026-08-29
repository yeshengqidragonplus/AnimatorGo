import type { SkeletonPart, SpineMajor } from '../binary/readSkeleton.ts'
import type { Attachment, Vertices } from '../binary/readSkins.ts'
import type { Timeline } from '../binary/readAnimations.ts'

/**
 * 模型 → Spine JSON。
 *
 * JSON 与 `.skel` 是**同一份数据的两种编码**,所以直接复用二进制读出来的模型。
 *
 * 两版的字段名不同(3.8 有官方规范,4.x 的名字由二进制结构与运行时 API 改名推得):
 *
 * | 含义 | 3.8 | 4.x |
 * |---|---|---|
 * | rotate 关键帧的值 | `angle` | `value` |
 * | slot 颜色时间轴 | `color` / `twoColor` | `rgba` / `rgb` / `rgba2` / `rgb2` / `alpha` |
 * | transform 约束的 mix | `rotateMix` / `translateMix` / … | `mixRotate` / `mixX` / `mixY` / … |
 * | 网格形变时间轴 | `deform` | `attachments` |
 *
 * **Spine JSON 会省略等于默认值的字段**,这里照做 —— 否则文件会膨胀好几倍,
 * 而且和 Spine 自己的导出对不上。读取端要用同一套默认值补回来。
 */

type Json = Record<string, unknown>

/** 只在值不等于默认值时写入 */
function put(obj: Json, key: string, value: unknown, fallback?: unknown): void {
  if (value === fallback) return
  if (value === null || value === undefined) return
  obj[key] = value
}

/** 0xRRGGBBAA → "rrggbbaa" */
function hexRgba(color: number): string {
  return (color >>> 0).toString(16).padStart(8, '0')
}

/** 0x00RRGGBB → "rrggbb" */
function hexRgb(color: number): string {
  return (color & 0xffffff).toString(16).padStart(6, '0')
}

function bytesToHex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
}

const TRANSFORM_MODES = [
  'normal',
  'onlyTranslation',
  'noRotationOrReflection',
  'noScale',
  'noScaleOrReflection',
]
const BLEND_MODES = ['normal', 'additive', 'multiply', 'screen']
const POSITION_MODES = ['fixed', 'percent']
const SPACING_MODES = ['length', 'fixed', 'percent', 'proportional']
const ROTATE_MODES = ['tangent', 'chain', 'chainScale']

// ─── 顶点 ────────────────────────────────────────────────────────────────────

/**
 * 顶点数组。未加权时就是 x/y 交替;加权时是变长编码:
 * `[骨骼数, 骨骼下标, x, y, 权重, …]`
 */
function verticesToJson(v: Vertices): number[] {
  if (!v.weighted) return [...v.positions]
  const out: number[] = []
  for (const entry of v.weights) {
    out.push(entry.length)
    for (const w of entry) out.push(w.bone, w.x, w.y, w.weight)
  }
  return out
}

// ─── attachment ──────────────────────────────────────────────────────────────

function attachmentToJson(a: Attachment, is38: boolean): Json {
  const d = a.data
  const out: Json = {}

  // type 为 region 时可省略(Spine 的默认)
  if (a.type !== 'region') out['type'] = a.type
  // path 与键名相同时省略
  if (d['path'] !== null && d['path'] !== a.key) out['path'] = d['path']
  if (a.nameRef !== null && a.nameRef !== a.key) out['name'] = a.nameRef

  switch (a.type) {
    case 'region':
      put(out, 'x', d['x'], 0)
      put(out, 'y', d['y'], 0)
      put(out, 'scaleX', d['scaleX'], 1)
      put(out, 'scaleY', d['scaleY'], 1)
      put(out, 'rotation', d['rotation'], 0)
      out['width'] = d['width']
      out['height'] = d['height']
      put(out, 'color', hexRgba(d['color'] as number), 'ffffffff')
      break

    case 'mesh':
      out['uvs'] = d['uvs']
      out['triangles'] = d['triangles']
      out['vertices'] = verticesToJson(d['vertices'] as Vertices)
      put(out, 'hull', d['hullLength'], 0)
      put(out, 'color', hexRgba(d['color'] as number), 'ffffffff')
      if (d['edges'] !== undefined) out['edges'] = d['edges']
      if (d['width'] !== undefined) out['width'] = d['width']
      if (d['height'] !== undefined) out['height'] = d['height']
      break

    case 'linkedmesh':
      put(out, 'skin', d['skinName'])
      out['parent'] = d['parent']
      // 3.8 叫 deform,4.x 叫 timelines —— 字段位置相同,只是改名
      put(out, is38 ? 'deform' : 'timelines', d['inheritTimelines'], true)
      put(out, 'color', hexRgba(d['color'] as number), 'ffffffff')
      if (d['width'] !== undefined) out['width'] = d['width']
      if (d['height'] !== undefined) out['height'] = d['height']
      break

    case 'boundingbox':
      out['vertexCount'] = d['vertexCount']
      out['vertices'] = verticesToJson(d['vertices'] as Vertices)
      break

    case 'path':
      put(out, 'closed', d['closed'], false)
      put(out, 'constantSpeed', d['constantSpeed'], true)
      out['vertexCount'] = d['vertexCount']
      out['vertices'] = verticesToJson(d['vertices'] as Vertices)
      out['lengths'] = d['lengths']
      break

    case 'point':
      put(out, 'x', d['x'], 0)
      put(out, 'y', d['y'], 0)
      put(out, 'rotation', d['rotation'], 0)
      break

    case 'clipping':
      out['end'] = d['endSlot']
      out['vertexCount'] = d['vertexCount']
      out['vertices'] = verticesToJson(d['vertices'] as Vertices)
      break
  }

  if (a.sequence !== null) {
    out['sequence'] = {
      count: a.sequence.count,
      start: a.sequence.start,
      digits: a.sequence.digits,
      setup: a.sequence.setupIndex,
    }
  }
  return out
}

// ─── 曲线 ────────────────────────────────────────────────────────────────────

/**
 * 曲线写进帧对象。
 *
 * 3.8:`"curve": [cx1, cy1, cx2, cy2]`,一条管所有分量。
 * 4.x:`"curve": "bezier"` 外加把各分量的控制点**平铺**成一个数组。
 */
function putCurve(frame: Json, f: Record<string, unknown>, is38: boolean): void {
  const curve = f['curve']
  if (curve === 'stepped') {
    frame['curve'] = 'stepped'
    return
  }
  if (curve !== 'bezier') return // linear 是默认,省略

  const beziers = f['beziers'] as number[][]
  if (is38) {
    frame['curve'] = [...beziers[0]!]
    return
  }
  frame['curve'] = 'bezier'
  frame['bezier'] = beziers.flat()
}

// ─── 时间轴 ──────────────────────────────────────────────────────────────────

/** 3.8 的 rotate 关键帧字段叫 angle,4.x 叫 value */
const ROTATE_VALUE_KEY = { '3.8': 'angle', '4.x': 'value' } as const

function framesToJson(
  t: Timeline,
  is38: boolean,
  valueNames: readonly string[],
  rename?: Record<string, string>,
): Json[] {
  return t.frames.map((f) => {
    const frame: Json = {}
    put(frame, 'time', f['time'], 0)
    for (const name of valueNames) {
      const key = rename?.[name] ?? name
      // scale 的默认是 1,其余是 0
      const fallback = t.kind.startsWith('scale') ? 1 : 0
      put(frame, key, f[name], fallback)
    }
    putCurve(frame, f, is38)
    return frame
  })
}

const BONE_VALUE_NAMES: Record<string, string[]> = {
  rotate: ['value'],
  translate: ['x', 'y'], translateX: ['value'], translateY: ['value'],
  scale: ['x', 'y'], scaleX: ['value'], scaleY: ['value'],
  shear: ['x', 'y'], shearX: ['value'], shearY: ['value'],
}

/** 4.x 的 slot 颜色时间轴类型编号 → JSON 里的键名 */
const SLOT_COLOR_KEYS: Record<number, string> = {
  1: 'rgba', 2: 'rgb', 3: 'rgba2', 4: 'rgb2', 5: 'alpha',
}

function slotTimelineToJson(t: Timeline, is38: boolean): { key: string; value: unknown } {
  if (t.kind === 'attachment') {
    return {
      key: 'attachment',
      value: t.frames.map((f) => {
        const frame: Json = {}
        put(frame, 'time', f['time'], 0)
        frame['name'] = f['name']
        return frame
      }),
    }
  }

  if (is38) {
    const twoColor = t.kind === 'twoColor'
    return {
      key: twoColor ? 'twoColor' : 'color',
      value: t.frames.map((f) => {
        const colors = f['colors'] as number[]
        const frame: Json = {}
        put(frame, 'time', f['time'], 0)
        if (twoColor) {
          frame['light'] = hexRgba(colors[0]!)
          frame['dark'] = hexRgb(colors[1]!)
        } else {
          frame['color'] = hexRgba(colors[0]!)
        }
        putCurve(frame, f, true)
        return frame
      }),
    }
  }

  const type = Number(t.kind.replace('slotColor', ''))
  const key = SLOT_COLOR_KEYS[type] ?? 'rgba'
  return {
    key,
    value: t.frames.map((f) => {
      const c = f['color'] as number[]
      const frame: Json = {}
      put(frame, 'time', f['time'], 0)
      // rgba2 / rgb2 是「亮色 + 暗色」两段
      if (type === 3) {
        frame['color'] = bytesToHex(c.slice(0, 4))
        frame['dark'] = bytesToHex(c.slice(4))
      } else if (type === 4) {
        frame['light'] = bytesToHex(c.slice(0, 3))
        frame['dark'] = bytesToHex(c.slice(3))
      } else {
        frame['color'] = bytesToHex(c)
      }
      putCurve(frame, f, false)
      return frame
    }),
  }
}

function animationToJson(
  timelines: readonly Timeline[],
  is38: boolean,
  slotNames: readonly string[],
  boneNames: readonly string[],
  ikNames: readonly string[],
  transformNames: readonly string[],
  pathNames: readonly string[],
  skinNames: readonly string[],
): Json {
  const out: Json = {}
  const group = (holder: Json, name: string, key: string, value: unknown) => {
    const bucket = (holder[name] as Json) ?? (holder[name] = {})
    bucket[key] = value
  }

  const slots: Json = {}
  const bones: Json = {}
  const ik: Json = {}
  const transform: Json = {}
  const path: Json = {}
  const deform: Json = {}

  for (const t of timelines) {
    if (t.kind === 'attachment' || t.kind === 'color' || t.kind === 'twoColor' || t.kind.startsWith('slotColor')) {
      const { key, value } = slotTimelineToJson(t, is38)
      group(slots, slotNames[t.owner] ?? String(t.owner), key, value)
      continue
    }

    const boneValues = BONE_VALUE_NAMES[t.kind]
    if (boneValues !== undefined) {
      const rename = t.kind === 'rotate' ? { value: ROTATE_VALUE_KEY[is38 ? '3.8' : '4.x'] } : undefined
      group(bones, boneNames[t.owner] ?? String(t.owner), t.kind, framesToJson(t, is38, boneValues, rename))
      continue
    }

    if (t.kind === 'ik') {
      ik[ikNames[t.owner] ?? String(t.owner)] = t.frames.map((f) => {
        const frame: Json = {}
        put(frame, 'time', f['time'], 0)
        put(frame, 'mix', f['mix'], 1)
        put(frame, 'softness', f['softness'], 0)
        put(frame, 'bendPositive', f['bendDirection'] === 1, true)
        put(frame, 'compress', f['compress'], false)
        put(frame, 'stretch', f['stretch'], false)
        putCurve(frame, f, is38)
        return frame
      })
      continue
    }

    if (t.kind === 'transform') {
      const names = is38
        ? ['mixRotate', 'mixTranslate', 'mixScale', 'mixShear']
        : ['mixRotate', 'mixX', 'mixY', 'mixScaleX', 'mixScaleY', 'mixShearY']
      const rename = is38
        ? { mixRotate: 'rotateMix', mixTranslate: 'translateMix', mixScale: 'scaleMix', mixShear: 'shearMix' }
        : undefined
      transform[transformNames[t.owner] ?? String(t.owner)] = framesToJson(t, is38, names, rename)
      continue
    }

    if (t.kind.startsWith('path')) {
      const type = Number(t.kind.replace('path', ''))
      const key = type === 0 ? 'position' : type === 1 ? 'spacing' : 'mix'
      const names =
        type === 2
          ? is38 ? ['mixRotate', 'mixTranslate'] : ['mixRotate', 'mixX', 'mixY']
          : ['value']
      const rename =
        type === 2 && is38
          ? { mixRotate: 'rotateMix', mixTranslate: 'translateMix' }
          : type !== 2
            ? { value: key }
            : undefined
      group(path, pathNames[t.owner] ?? String(t.owner), key, framesToJson(t, is38, names, rename))
      continue
    }

    if (t.kind === 'deform') {
      const wrapper = t.frames[0] as Record<string, unknown>
      const skin = skinNames[wrapper['skin'] as number] ?? 'default'
      const slot = slotNames[t.owner] ?? String(t.owner)
      const attachment = wrapper['attachment'] as string
      const inner = wrapper['frames'] as Record<string, unknown>[]

      const bySkin = (deform[skin] as Json) ?? (deform[skin] = {})
      const bySlot = (bySkin[slot] as Json) ?? (bySkin[slot] = {})
      bySlot[attachment] = inner.map((f) => {
        const frame: Json = {}
        put(frame, 'time', f['time'], 0)
        const verts = f['vertices'] as number[]
        if (verts.length > 0) {
          put(frame, 'offset', f['start'], 0)
          frame['vertices'] = verts
        }
        putCurve(frame, f, is38)
        return frame
      })
      continue
    }

    if (t.kind === 'drawOrder') {
      out['drawOrder'] = t.frames.map((f) => {
        const frame: Json = {}
        put(frame, 'time', f['time'], 0)
        const offsets = f['offsets'] as { slot: number; offset: number }[]
        if (offsets.length > 0) {
          frame['offsets'] = offsets.map((o) => ({
            slot: slotNames[o.slot] ?? String(o.slot),
            offset: o.offset,
          }))
        }
        return frame
      })
      continue
    }

    if (t.kind === 'event') {
      out['events'] = t.frames.map((f) => {
        const frame: Json = { time: f['time'] }
        frame['name'] = f['event']
        put(frame, 'int', f['int'], 0)
        put(frame, 'float', f['float'], 0)
        put(frame, 'string', f['string'])
        return frame
      })
    }
  }

  if (Object.keys(slots).length > 0) out['slots'] = slots
  if (Object.keys(bones).length > 0) out['bones'] = bones
  if (Object.keys(ik).length > 0) out['ik'] = ik
  if (Object.keys(transform).length > 0) out['transform'] = transform
  if (Object.keys(path).length > 0) out['path'] = path
  // 3.8 叫 deform,4.x 叫 attachments
  if (Object.keys(deform).length > 0) out[is38 ? 'deform' : 'attachments'] = deform
  return out
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

export function toJson(part: SkeletonPart): Json {
  const is38 = part.header.major === '3.8'
  const h = part.header

  const boneNames = part.bones.map((b) => b.name)
  const slotNames = part.slots.map((s) => s.name)
  const ikNames = part.ik.map((c) => c.name)
  const transformNames = part.transform.map((c) => c.name)
  const pathNames = part.path.map((c) => c.name)
  const skinNames = part.skins.map((s) => s.name)

  const skeleton: Json = { spine: h.version }
  put(skeleton, 'hash', h.hash)
  put(skeleton, 'x', h.x, 0)
  put(skeleton, 'y', h.y, 0)
  put(skeleton, 'width', h.width, 0)
  put(skeleton, 'height', h.height, 0)
  put(skeleton, 'fps', h.fps, 30)
  put(skeleton, 'images', h.imagesPath)
  put(skeleton, 'audio', h.audioPath)

  const out: Json = { skeleton }

  out['bones'] = part.bones.map((b) => {
    const j: Json = { name: b.name }
    if (b.parent >= 0) j['parent'] = boneNames[b.parent]
    put(j, 'length', b.length, 0)
    put(j, 'rotation', b.rotation, 0)
    put(j, 'x', b.x, 0)
    put(j, 'y', b.y, 0)
    put(j, 'scaleX', b.scaleX, 1)
    put(j, 'scaleY', b.scaleY, 1)
    put(j, 'shearX', b.shearX, 0)
    put(j, 'shearY', b.shearY, 0)
    put(j, 'transform', TRANSFORM_MODES[b.transformMode], 'normal')
    put(j, 'skin', b.skinRequired, false)
    return j
  })

  out['slots'] = part.slots.map((s) => {
    const j: Json = { name: s.name, bone: boneNames[s.bone] }
    put(j, 'color', hexRgba(s.color), 'ffffffff')
    if (s.darkColor !== -1) j['dark'] = hexRgb(s.darkColor)
    put(j, 'attachment', s.attachmentName)
    put(j, 'blend', BLEND_MODES[s.blendMode], 'normal')
    return j
  })

  if (part.ik.length > 0) {
    out['ik'] = part.ik.map((c) => {
      const j: Json = { name: c.name, bones: c.bones.map((b) => boneNames[b]), target: boneNames[c.target] }
      put(j, 'order', c.order, 0)
      put(j, 'skin', c.skinRequired, false)
      put(j, 'mix', c.mix, 1)
      put(j, 'softness', c.softness, 0)
      put(j, 'bendPositive', c.bendDirection === 1, true)
      put(j, 'compress', c.compress, false)
      put(j, 'stretch', c.stretch, false)
      put(j, 'uniform', c.uniform, false)
      return j
    })
  }

  if (part.transform.length > 0) {
    out['transform'] = part.transform.map((c) => {
      const j: Json = { name: c.name, bones: c.bones.map((b) => boneNames[b]), target: boneNames[c.target] }
      put(j, 'order', c.order, 0)
      put(j, 'skin', c.skinRequired, false)
      put(j, 'local', c.local, false)
      put(j, 'relative', c.relative, false)
      put(j, 'rotation', c.offsetRotation, 0)
      put(j, 'x', c.offsetX, 0)
      put(j, 'y', c.offsetY, 0)
      put(j, 'scaleX', c.offsetScaleX, 0)
      put(j, 'scaleY', c.offsetScaleY, 0)
      put(j, 'shearY', c.offsetShearY, 0)
      if (is38) {
        put(j, 'rotateMix', c.mixRotate, 1)
        put(j, 'translateMix', c.mixX, 1)
        put(j, 'scaleMix', c.mixScaleX, 1)
        put(j, 'shearMix', c.mixShearY, 1)
      } else {
        put(j, 'mixRotate', c.mixRotate, 1)
        put(j, 'mixX', c.mixX, 1)
        put(j, 'mixY', c.mixY, 1)
        put(j, 'mixScaleX', c.mixScaleX, 1)
        put(j, 'mixScaleY', c.mixScaleY, 1)
        put(j, 'mixShearY', c.mixShearY, 1)
      }
      return j
    })
  }

  if (part.path.length > 0) {
    out['path'] = part.path.map((c) => {
      const j: Json = { name: c.name, bones: c.bones.map((b) => boneNames[b]), target: slotNames[c.target] }
      put(j, 'order', c.order, 0)
      put(j, 'skin', c.skinRequired, false)
      put(j, 'positionMode', POSITION_MODES[c.positionMode], 'percent')
      put(j, 'spacingMode', SPACING_MODES[c.spacingMode], 'length')
      put(j, 'rotateMode', ROTATE_MODES[c.rotateMode], 'tangent')
      put(j, 'rotation', c.offsetRotation, 0)
      put(j, 'position', c.position, 0)
      put(j, 'spacing', c.spacing, 0)
      if (is38) {
        put(j, 'rotateMix', c.mixRotate, 1)
        put(j, 'translateMix', c.mixX, 1)
      } else {
        put(j, 'mixRotate', c.mixRotate, 1)
        put(j, 'mixX', c.mixX, 1)
        put(j, 'mixY', c.mixY, 1)
      }
      return j
    })
  }

  out['skins'] = part.skins.map((skin) => {
    const attachments: Json = {}
    for (const entry of skin.slots) {
      const bySlot: Json = {}
      for (const a of entry.attachments) bySlot[a.key] = attachmentToJson(a, is38)
      attachments[slotNames[entry.slot] ?? String(entry.slot)] = bySlot
    }
    const j: Json = { name: skin.name, attachments }
    if (skin.bones.length > 0) j['bones'] = skin.bones.map((b) => boneNames[b])
    if (skin.ik.length > 0) j['ik'] = skin.ik.map((i) => ikNames[i])
    if (skin.transform.length > 0) j['transform'] = skin.transform.map((i) => transformNames[i])
    if (skin.path.length > 0) j['path'] = skin.path.map((i) => pathNames[i])
    return j
  })

  if (part.events.length > 0) {
    const events: Json = {}
    for (const e of part.events) {
      const j: Json = {}
      put(j, 'int', e.int, 0)
      put(j, 'float', e.float, 0)
      put(j, 'string', e.string)
      put(j, 'audio', e.audioPath)
      if (e.audioPath !== null) {
        put(j, 'volume', e.volume, 1)
        put(j, 'balance', e.balance, 0)
      }
      events[e.name] = j
    }
    out['events'] = events
  }

  const animations: Json = {}
  const eventNames = part.events.map((e) => e.name)
  for (const anim of part.animations) {
    const j = animationToJson(
      anim.timelines, is38, slotNames, boneNames, ikNames, transformNames, pathNames, skinNames,
    )
    // 事件时间轴里存的是事件下标,JSON 用名字
    const evts = j['events'] as Json[] | undefined
    if (evts !== undefined) {
      for (const e of evts) e['name'] = eventNames[e['name'] as number] ?? e['name']
    }
    animations[anim.name] = j
  }
  out['animations'] = animations

  return out
}

/** 便捷入口:直接产出格式化后的 JSON 文本 */
export function toJsonText(part: SkeletonPart, indent = 2): string {
  return JSON.stringify(toJson(part), null, indent)
}

export type { SpineMajor }
