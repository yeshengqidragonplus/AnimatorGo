import type { SkeletonPart } from '../../spine-format/binary/readSkeleton.ts'
import type { Attachment, Sequence, Vertices } from '../../spine-format/binary/readSkins.ts'
import type { AnimationData, Timeline } from '../../spine-format/binary/readAnimations.ts'
import type { Atlas, AtlasRegion } from '../../core/atlas.ts'
import { encodePng, type Image } from '../../unity/png.ts'
import { detectPremultiplied, unpremultiply } from '../unity/alpha.ts'
import { resolveLinkedMeshes } from '../unity/linkedMesh.ts'
import { bindSlots, compactSlots, truncateVertex, type PosePair } from '../skinSlots.ts'
import { toAbsoluteBezier } from '../../spine-format/bezier.ts'
import { describeTimeline, DUPLICATE_TIMELINE_MESSAGE, lastPerProperty } from '../../spine-format/duplicateTimelines.ts'
import { localsAt, setupLocals, valueBetween, type Affine, type BoneLocal } from '../../spine-eval/pose.ts'
import { drawOrderOf, layerOfSlot, type DrawOrderOffset } from '../../spine-eval/drawOrder.ts'
import { sequenceCycle, sequenceFrameAt, sequenceRegionName, sequenceSteps, type SequenceKey } from '../../spine-eval/sequence.ts'
import { slotColorAt } from '../../spine-eval/color.ts'
import { IssueCollector, type ConversionIssue } from '../types.ts'
import { clipGroups, clipOnSteps, clipToggled, type ClipGroup } from '../clipping.ts'
import * as G from '../../godot/tscn.ts'

/**
 * Spine(中转模型)→ Godot 4 场景。
 *
 * 产出 `<名字>.tscn` + 图集页 PNG,拖进 Godot 工程就能播,**零运行时脚本**:
 * `Skeleton2D` + `Bone2D` 层级,每个 attachment 一个 `Polygon2D`,一个 `AnimationPlayer`。
 * 所有行为结论来自 Godot 4.7 的实测,见 docs/GODOT.md。
 *
 * ## 坐标
 *
 * Spine 的 Y 朝上、逆时针为正;Godot 2D 的 Y 朝下、顺时针为正。数据层面做翻转(`y → −y`,
 * 仿射 `M → F·M·F`),而不是给根节点挂一个 `scale.y = −1` —— 那样用户在 Godot 里往骨骼上
 * 挂的新东西全是倒的。骨骼的局部变换(见 `godotLocal`):
 *
 * ```
 * position = (x, −y)   rotation = −(rotation + shearX)   skew = shearX − shearY   scale 不变
 * ```
 *
 * Godot 2D 的单位就是像素,顶点直接用骨架单位,不需要 ppu。
 *
 * ## 网格的三种放法
 *
 * | attachment | 放在哪 | 顶点 |
 * |---|---|---|
 * | region / 不加权网格 / 只挂一根骨骼的加权网格 | 那根骨骼下面,不蒙皮 | 骨骼局部坐标 |
 * | 真正混合的加权网格 | 根节点下,`skeleton` 指向 Skeleton2D | 绑定姿势下的骨架坐标 |
 *
 * ⚠️ Godot 的绑定姿势就是 `Bone2D.rest`,**每根骨骼只有一个,所有网格共用**。不是在 setup
 * 姿势下绑的网格,在每根影响它的骨骼下挂一个辅助子骨骼表达它自己的绑定姿势(docs/GODOT.md 第 3 节)。
 *
 * ## 动画
 *
 * - 骨骼:贝塞尔轨道精确表达 Spine 的贝塞尔(控制柄是相对偏移,实测);全线性的用普通值轨道
 * - 换图 → 各挂图节点 `visible`;slot 颜色 → `self_modulate`;逐帧绘制顺序 → `z_index`
 * - deform → 直接对 `polygon` 打关键帧(Godot 会插值,且天然「加完再蒙皮」)
 * - clipping 遮罩 → 打开 `clip_children` 的 Polygon2D,被遮的部件挂在它下面(docs/GODOT.md 第 12 节)
 * - 换动画回 setup:`deterministic = true` + `RESET` 动画(实测,默认档位会留着上一条动画的值)
 * - 离散轨道:`callback_mode_discrete = 2`,否则往回拖不重新求值(实测)
 */

export interface GodotExportOptions {
  /** 场景名,也是根节点名 */
  readonly name: string
  /** 产物在 Godot 工程里的目录,贴图引用写成 `<resDir>/<页名>`。如 `res://animatorgo/MX2_cat` */
  readonly resDir: string
  /** 试运行:不编码 PNG */
  readonly skipImages?: boolean
  /** 初始皮肤(SkinPlayer 的自动播放)。不给时是默认皮肤,默认皮肤空着就取第一套具名皮肤 */
  readonly skin?: string
}

export interface GodotFile {
  readonly path: string
  readonly content: string | Uint8Array
}

export interface GodotExportResult {
  readonly files: readonly GodotFile[]
  readonly issues: readonly ConversionIssue[]
}

const DEG = Math.PI / 180
/** 阶梯段用两个挨着的关键帧模拟:下一帧之前这么久保持原值 */
const STEP_EPSILON = 1e-4
/** 有贝塞尔的颜色 / deform 按这个帧率采样成线性关键帧 */
const SAMPLE_FPS = 30

// ─── 坐标换算 ────────────────────────────────────────────────────────────────

interface GodotLocal {
  readonly x: number
  readonly y: number
  /** 弧度 */
  readonly rotation: number
  readonly skew: number
  readonly scaleX: number
  readonly scaleY: number
}

function godotLocal(l: BoneLocal): GodotLocal {
  return {
    x: l.x,
    y: -l.y,
    rotation: -(l.rotation + l.shearX) * DEG,
    skew: (l.shearX - l.shearY) * DEG,
    scaleX: l.scaleX,
    scaleY: l.scaleY,
  }
}

/** Godot 的 Transform2D(rotation, scale, skew, position),与 Node2D 自己的组合方式一致 */
function toMatrix(l: GodotLocal): Affine {
  return {
    a: Math.cos(l.rotation) * l.scaleX,
    c: Math.sin(l.rotation) * l.scaleX,
    b: -Math.sin(l.rotation + l.skew) * l.scaleY,
    d: Math.cos(l.rotation + l.skew) * l.scaleY,
    x: l.x,
    y: l.y,
  }
}

function mul(p: Affine, q: Affine): Affine {
  return {
    a: p.a * q.a + p.b * q.c,
    b: p.a * q.b + p.b * q.d,
    c: p.c * q.a + p.d * q.c,
    d: p.c * q.b + p.d * q.d,
    x: p.a * q.x + p.b * q.y + p.x,
    y: p.c * q.x + p.d * q.y + p.y,
  }
}

function inverse(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c
  const a = m.d / det
  const b = -m.b / det
  const c = -m.c / det
  const d = m.a / det
  return { a, b, c, d, x: -(a * m.x + b * m.y), y: -(c * m.x + d * m.y) }
}

const apply = (m: Affine, x: number, y: number) => ({ x: m.a * x + m.b * y + m.x, y: m.c * x + m.d * y + m.y })

/** Godot 的骨骼世界矩阵:纯矩阵继承(Godot 没有 Spine 的非默认继承模式) */
function godotWorlds(part: SkeletonPart, locals: readonly GodotLocal[]): Affine[] {
  const out: Affine[] = []
  part.bones.forEach((bone, i) => {
    const m = toMatrix(locals[i]!)
    out[i] = bone.parent < 0 ? m : mul(out[bone.parent]!, m)
  })
  return out
}

// ─── 名字 ────────────────────────────────────────────────────────────────────

/** Godot 节点名不能含 `. : @ / " %`(实测 `a@mesh` 会被改名,路径就对不上了) */
function nodeName(name: string): string {
  const s = name.replace(/[.:@/"%\\]/g, '_').trim()
  return s.length > 0 ? s : '_'
}

/** 同一父节点下的名字去重 */
class Names {
  private readonly used = new Map<string, Set<string>>()
  claim(parent: string, wanted: string): string {
    const set = this.used.get(parent) ?? new Set<string>()
    this.used.set(parent, set)
    let name = nodeName(wanted)
    for (let n = 2; set.has(name); n++) name = `${nodeName(wanted)}_${n}`
    set.add(name)
    return name
  }
}

// ─── 颜色 ────────────────────────────────────────────────────────────────────

type Rgba = readonly [number, number, number, number]

function unpackRgba(packed: number): Rgba {
  return [((packed >>> 24) & 0xff) / 255, ((packed >>> 16) & 0xff) / 255, ((packed >>> 8) & 0xff) / 255, (packed & 0xff) / 255]
}

const colorValue = (c: Rgba) => G.color(c[0], c[1], c[2], c[3])
const isWhite = (c: Rgba) => c.every((v) => Math.abs(v - 1) < 1e-6)

// ─── 轨道 ────────────────────────────────────────────────────────────────────

interface Track {
  readonly path: string
  readonly kind: 'value' | 'bezier'
  /** 值轨道:离散(visible / z_index)还是连续 */
  readonly discrete?: boolean
  readonly times: readonly number[]
  readonly values: readonly G.GodotValue[]
  /** 贝塞尔轨道每键 [入柄 x, 入柄 y, 出柄 x, 出柄 y] */
  readonly handles?: readonly (readonly [number, number, number, number])[]
}

type Segment = { curve: 'linear' } | { curve: 'stepped' } | { curve: 'bezier'; c: readonly [number, number, number, number] }

/**
 * Spine 一个分量的关键帧 → Godot 轨道。
 *
 * `toGodot` 必须是仿射(`slope · raw + offset`):贝塞尔控制点的 y 在 Spine 的原始值空间,
 * 换到 Godot 要走同一个变换,控制柄是差值,只乘斜率。
 */
function floatTrack(
  path: string,
  frames: readonly Record<string, unknown>[],
  field: string,
  component: number,
  is38: boolean,
  toGodot: { readonly slope: number; readonly offset: number },
  setupRaw: number,
): Track {
  const T = (raw: number) => toGodot.slope * raw + toGodot.offset
  const times = frames.map((f) => Number(f['time'] ?? 0))
  const raws = frames.map((f) => Number(f[field]))
  const segments: Segment[] = frames.slice(0, -1).map((f, i) => {
    const curve = f['curve']
    if (curve === 'stepped') return { curve: 'stepped' }
    if (curve !== 'bezier') return { curve: 'linear' }
    const all = f['beziers'] as number[][]
    const raw = all[Math.min(component, all.length - 1)]!
    const b = is38 ? toAbsoluteBezier(raw, times[i]!, raws[i]!, times[i + 1]!, raws[i + 1]!) : raw
    return { curve: 'bezier', c: [b[0]!, b[1]!, b[2]!, b[3]!] }
  })

  // 第一帧之前 Spine 用 setup 值;Godot 在第一帧之前保持第一帧的值 —— 在 0 处补 setup,阶梯过去
  const keys: { t: number; v: number; seg?: Segment }[] = []
  if (times.length > 0 && times[0]! > 0) keys.push({ t: 0, v: T(setupRaw), seg: { curve: 'stepped' } })
  times.forEach((t, i) => keys.push({ t, v: T(raws[i]!), ...(segments[i] === undefined ? {} : { seg: segments[i] }) }))

  const hasBezier = keys.some((k) => k.seg?.curve === 'bezier')
  // 阶梯段:在下一帧之前补一个同值的键
  const expanded: { t: number; v: number; seg?: Segment }[] = []
  keys.forEach((k, i) => {
    expanded.push(k)
    const next = keys[i + 1]
    if (k.seg?.curve === 'stepped' && next !== undefined && next.t - k.t > 2 * STEP_EPSILON) {
      expanded.push({ t: next.t - STEP_EPSILON, v: k.v, seg: { curve: 'linear' } })
    }
  })

  if (!hasBezier) {
    return { path, kind: 'value', times: expanded.map((k) => k.t), values: expanded.map((k) => G.float(k.v)) }
  }

  const handles = expanded.map(() => [0, 0, 0, 0] as [number, number, number, number])
  expanded.forEach((k, i) => {
    const next = expanded[i + 1]
    if (next === undefined) return
    const dt = next.t - k.t
    if (k.seg?.curve === 'bezier') {
      const [cx1, cy1, cx2, cy2] = k.seg.c
      handles[i]![2] = cx1 - k.t
      handles[i]![3] = toGodot.slope * cy1 + toGodot.offset - k.v
      handles[i + 1]![0] = cx2 - next.t
      handles[i + 1]![1] = toGodot.slope * cy2 + toGodot.offset - next.v
    } else {
      // 直线段(含阶梯的两段)在贝塞尔轨道里:控制柄放在三分点上
      const dv = next.v - k.v
      handles[i]![2] = dt / 3
      handles[i]![3] = dv / 3
      handles[i + 1]![0] = -dt / 3
      handles[i + 1]![1] = -dv / 3
    }
  })
  return { path, kind: 'bezier', times: expanded.map((k) => k.t), values: expanded.map((k) => k.v), handles }
}

/** 数值的值轨道 → 等价的贝塞尔轨道:直线段的控制柄放在三分点上(与 floatTrack 里直线段的写法一致) */
function asBezier(t: Track): Track {
  if (t.kind === 'bezier') return t
  const values = t.values.map((v) => (typeof v === 'number' ? v : (v as { value: number }).value))
  const handles = values.map(() => [0, 0, 0, 0] as [number, number, number, number])
  values.forEach((v, i) => {
    if (i + 1 >= values.length) return
    const dt = t.times[i + 1]! - t.times[i]!
    const dv = values[i + 1]! - v
    handles[i]![2] = dt / 3
    handles[i]![3] = dv / 3
    handles[i + 1]![0] = -dt / 3
    handles[i + 1]![1] = -dv / 3
  })
  return { path: t.path, kind: 'bezier', times: t.times, values, handles }
}

const asBezierIf = (yes: boolean, t: Track): Track => (yes ? asBezier(t) : t)

/** 离散值轨道,相邻相同的值合并 */
function stepTrack(path: string, steps: readonly { t: number; v: G.GodotValue }[]): Track {
  // 同一时刻的几步只留最后一步。⚠️ 实测:Godot 在恰好那一刻取的是**第一个**键 —— 0 秒先写 setup 值、再写第一帧的话,
  // 动画开头(以及每次循环回到 0)那一帧两张图一起亮
  const merged: { t: number; v: G.GodotValue }[] = []
  for (const s of steps) {
    const last = merged[merged.length - 1]
    if (last !== undefined && Math.abs(last.t - s.t) < 1e-9) last.v = s.v
    else merged.push({ ...s })
  }
  const times: number[] = []
  const values: G.GodotValue[] = []
  for (const s of merged) {
    if (values.length > 0 && JSON.stringify(values[values.length - 1]) === JSON.stringify(s.v)) continue
    times.push(s.t)
    values.push(s.v)
  }
  return { path, kind: 'value', discrete: true, times, values }
}

/**
 * 写出来时刻相同(7 位有效数字)的键只留最后一个。来源不同的时刻(某条时间轴的关键帧、另一条的「下一帧前 ε」、
 * 采样网格)在 double 里差一丁点,写进 .tscn 就成了同一时刻的两个键 —— Godot 在恰好那一刻取第一个,
 * Spine 取后一个
 */
function distinctTimes(t: Track): Track {
  const keep: number[] = []
  t.times.forEach((time, k) => {
    if (keep.length > 0 && G.formatNumber(t.times[keep[keep.length - 1]!]!) === G.formatNumber(time)) keep[keep.length - 1] = k
    else keep.push(k)
  })
  if (keep.length === t.times.length) return t
  return {
    ...t,
    times: keep.map((k) => t.times[k]!),
    values: keep.map((k) => t.values[k]!),
    ...(t.handles === undefined ? {} : { handles: keep.map((k) => t.handles![k]!) }),
  }
}

function animationResource(id: string, name: string, length: number, loop: boolean, tracks: readonly Track[]): G.SubResourceDecl {
  const props: [string, G.GodotValue][] = [['resource_name', name], ['length', G.float(Math.max(length, 0.001))]]
  if (loop) props.push(['loop_mode', 1])
  tracks.map(distinctTimes).forEach((t, i) => {
    const p = `tracks/${i}`
    props.push([`${p}/type`, t.kind], [`${p}/imported`, false], [`${p}/enabled`, true], [`${p}/path`, G.nodePath(t.path)])
    if (t.kind === 'value') {
      props.push([`${p}/interp`, 1], [`${p}/loop_wrap`, true], [`${p}/keys`, {
        times: G.packedFloat32(t.times),
        transitions: G.packedFloat32(t.times.map(() => 1)),
        update: t.discrete === true ? 1 : 0,
        values: t.values,
      }])
    } else {
      const points: number[] = []
      t.times.forEach((_, k) => points.push(t.values[k] as number, ...t.handles![k]!))
      props.push([`${p}/interp`, 1], [`${p}/loop_wrap`, true], [`${p}/keys`, {
        handle_modes: G.packedInt32(t.times.map(() => 0)),
        points: G.packedFloat32(points),
        times: G.packedFloat32(t.times),
      }])
    }
  })
  return { id, type: 'Animation', properties: props }
}

// ─── attachment ──────────────────────────────────────────────────────────────

function regionNameOf(a: Attachment): string {
  const path = a.data['path']
  return typeof path === 'string' && path.length > 0 ? path : a.name
}

/**
 * 区域里「正立、裁剪后、左上原点」的坐标 → 图集页的像素坐标。
 * 旋转 90° 的区域在页里是逆时针躺着的(与 bakeAtlas 的 blitUpright 同一个换算)。
 */
function toPage(region: AtlasRegion, x: number, y: number): [number, number] {
  return region.rotate === 90 ? [region.x + y, region.y + region.width - x] : [region.x + x, region.y + y]
}

/** Spine 网格的 uv(相对未裁剪原图,左上原点)→ 页像素 */
function meshUv(region: AtlasRegion, u: number, v: number): [number, number] {
  const x = u * region.originalWidth - region.offsetX
  const y = v * region.originalHeight - (region.originalHeight - region.offsetY - region.height)
  return toPage(region, x, y)
}

/** region attachment 的四角(Spine 骨骼局部,Y 上):左下、右下、右上、左上 —— 与 Spine 的 UpdateRegion 一致 */
function regionCorners(a: Attachment, region: AtlasRegion): { x: number; y: number }[] {
  const d = a.data as Record<string, number>
  const w = d['width']!
  const h = d['height']!
  const sx = d['scaleX']!
  const sy = d['scaleY']!
  const lx = (-w / 2 + (region.offsetX / region.originalWidth) * w) * sx
  const ly = (-h / 2 + (region.offsetY / region.originalHeight) * h) * sy
  const lx2 = (w / 2 - ((region.originalWidth - region.offsetX - region.width) / region.originalWidth) * w) * sx
  const ly2 = (h / 2 - ((region.originalHeight - region.offsetY - region.height) / region.originalHeight) * h) * sy
  const cos = Math.cos(DEG * d['rotation']!)
  const sin = Math.sin(DEG * d['rotation']!)
  const at = (x: number, y: number) => ({ x: x * cos - y * sin + d['x']!, y: y * cos + x * sin + d['y']! })
  return [at(lx, ly), at(lx2, ly), at(lx2, ly2), at(lx, ly2)]
}

/** 真正在混合的加权网格(有顶点挂了两根以上骨骼);只挂一根的返回那根骨骼 */
function singleBoneOf(v: Vertices): number | null {
  let only: number | null = null
  for (const entry of v.weights) {
    const active = entry.filter((w) => w.weight > 0)
    if (active.length > 1) return null
    const bone = (active[0] ?? entry[0])?.bone
    if (bone === undefined) return null
    if (only === null) only = bone
    else if (only !== bone) return null
  }
  return only
}

interface AttachmentNode {
  readonly slot: number
  readonly skin: string
  readonly key: string
  readonly attachment: Attachment
  /** 相对场景根的节点路径 */
  readonly path: string
  /**
   * 蒙皮网格:骨骼槽位(骨架下标 + 绑定矩阵,Godot 骨架空间)。**同一根骨骼可以占多个槽位** —— 绑定矩阵不是骨骼 rest 的,
   * 用一根辅助子骨骼表达(第 3 节)
   */
  readonly skinned?: {
    readonly slots: readonly { readonly bone: number; readonly bind: Affine }[]
    /** 每顶点 (槽位下标, 权重):Godot 实际用来蒙皮的,每顶点最多 4 个 */
    readonly weights: readonly (readonly { slot: number; weight: number }[])[]
  }
  /** 不蒙皮时挂在哪根骨骼下;顶点在它的局部空间 */
  readonly parentBone?: number
  /**
   * 被遮罩遮住的刚性部件(以及遮罩自己):不能挂在骨骼下,改成蒙皮到 parentBone、权重 1。
   * `polygon` 仍是骨骼局部坐标,写出时乘上这个矩阵(那根骨骼的 rest 世界矩阵)换到绑定空间 —— 几何完全等价
   */
  readonly rigidBind?: Affine
  /** rest 空间(或骨骼局部)的顶点,Godot 坐标 */
  readonly polygon: readonly number[]
  /** 4.1 序列帧 attachment 的第几帧(每帧一个节点) */
  readonly frame?: { readonly index: number; readonly sequence: Sequence }
}

/** setup 姿势下这个挂图节点亮不亮:slot 挂的是它,且(序列帧)是 setup 那一帧 */
/** 写出去的 polygon:刚性改蒙皮的,骨骼局部 → 绑定空间 */
function outPolygon(node: Pick<AttachmentNode, 'rigidBind'>, local: readonly number[]): number[] {
  const m = node.rigidBind
  if (m === undefined) return [...local]
  const out: number[] = []
  for (let i = 0; i + 1 < local.length; i += 2) {
    const p = apply(m, local[i]!, local[i + 1]!)
    out.push(p.x, p.y)
  }
  return out
}

/** 节点到场景根下 Skeleton2D 的相对路径(节点路径有几段就退几层) */
function skeletonPathFrom(path: string): string {
  return `${'../'.repeat(path.split('/').length)}Skeleton2D`
}

/** 遮罩开关:开 = clip_children 只当遮罩用;关 = 不裁、遮罩自己透明(不能藏节点 —— 子节点会跟着藏起来) */
const CLIP_ON = 1
const CLIP_OFF = 0
const clipModulate = (on: boolean) => (on ? G.color(1, 1, 1, 1) : G.color(1, 1, 1, 0))

/**
 * multiply 混合。Spine 的 multiply 看透明度:`dst · lerp(1, src.rgb, src.a)`;`CanvasItemMaterial` 的 MUL 是
 * `dst · src.rgb`,贴图和 modulate 的透明度都不看(实测),透明的地方乘成黑色。改用 `blend_mul` 的着色器,
 * 把透明度折进颜色里、alpha 写 1(dst 的 alpha 不动)。
 * ⚠️ fragment 里读到的 `COLOR` 已经是「贴图 × 顶点色 × modulate」(实测,Compatibility / Forward+ / Mobile 三种
 * 渲染器都是)—— 再乘一遍 `texture(TEXTURE, UV)` 就成了贴图的平方。实测与 Spine 的公式差不超过 1/255。
 */
const MULTIPLY_SHADER = [
  'shader_type canvas_item;',
  'render_mode blend_mul;',
  '',
  '// Spine 的 multiply:dst · lerp(1, src.rgb, src.a)(AnimatorGo 导出)',
  'void fragment() {',
  '\tCOLOR = vec4(mix(vec3(1.0), COLOR.rgb, COLOR.a), 1.0);',
  '}',
  '',
].join('\n')

function setupVisible(slot: { attachmentName: string | null }, node: { key: string; frame?: { index: number; sequence: Sequence } }): boolean {
  if (slot.attachmentName !== node.key) return false
  return node.frame === undefined || node.frame.index === sequenceFrameAt(undefined, node.frame.sequence, 0)
}

// ─── 导出 ────────────────────────────────────────────────────────────────────

export function exportToGodot(
  input: SkeletonPart,
  atlas: Atlas,
  sources: ReadonlyMap<string, Image>,
  options: GodotExportOptions,
): GodotExportResult {
  const issues = new IssueCollector()
  const { part, timelineParents } = resolveLinkedMeshes(input, issues)
  const is38 = part.header.major === '3.8'
  const rootName = nodeName(options.name)
  const names = new Names()
  // 根下这几个名字先占住,attachment 节点不能抢
  names.claim('.', 'Skeleton2D')
  names.claim('.', 'AnimationPlayer')
  names.claim('.', 'SkinPlayer')

  // ── 骨骼 ──
  const spineSetup = setupLocals(part.bones)
  const restLocals = spineSetup.map(godotLocal)
  const restWorld = godotWorlds(part, restLocals)
  const bonePath: string[] = []
  const nodes: G.NodeDecl[] = [{ name: rootName, type: 'Node2D', parent: null, properties: [] }]
  nodes.push({ name: 'Skeleton2D', type: 'Skeleton2D', parent: '.', properties: [] })

  part.bones.forEach((bone, i) => {
    const parent = bone.parent < 0 ? 'Skeleton2D' : bonePath[bone.parent]!
    const name = names.claim(parent, bone.name)
    bonePath[i] = `${parent}/${name}`
    const l = restLocals[i]!
    const props: [string, G.GodotValue][] = []
    if (l.x !== 0 || l.y !== 0) props.push(['position', G.vec2(l.x, l.y)])
    if (l.rotation !== 0) props.push(['rotation', G.float(l.rotation)])
    if (l.skew !== 0) props.push(['skew', G.float(l.skew)])
    if (l.scaleX !== 1 || l.scaleY !== 1) props.push(['scale', G.vec2(l.scaleX, l.scaleY)])
    // 长度照 Spine 的写,不让 Godot 自己推(自动推算要求有子骨骼,否则满屏警告)
    props.push(['rest', G.transform2d(toMatrix(l))], ['auto_calculate_length_and_angle', false], ['length', G.float(Math.max(bone.length, 1))], ['bone_angle', G.float(0)])
    nodes.push({ name, type: 'Bone2D', parent, properties: props })
    if (bone.transformMode !== 0) {
      issues.add('approximated', `bone.${bone.name}`, 'Godot 的节点只有完整继承,Spine 的非默认继承模式(不继承旋转/缩放等)无法表达,按完整继承处理')
    }
  })
  /** 用来实测绑定误差的姿势:setup + 每条动画按 SAMPLE_FPS 逐帧(含关键帧时刻),Godot 坐标的骨骼世界矩阵。用到才算 */
  let posesCache: Affine[][] | null = null
  const checkPoses = (): readonly (readonly Affine[])[] => {
    if (posesCache !== null) return posesCache
    posesCache = [restWorld]
    for (const anim of part.animations) {
      const kept = { ...anim, timelines: lastPerProperty(anim.timelines).kept }
      for (const t of sampleTimes(durationOf(anim), kept.timelines)) {
        posesCache.push(godotWorlds(part, localsAt(part, kept, t).map(godotLocal)))
      }
    }
    return posesCache
  }

  // ── 图集页 ──
  const files: GodotFile[] = []
  const pageId = new Map<string, string>()
  const extResources: G.ExtResourceDecl[] = []
  atlas.pages.forEach((page, i) => {
    const id = `${i + 1}_tex`
    pageId.set(page.name, id)
    // 不在 Godot 工程里时写相对路径(相对场景文件所在目录)
    extResources.push({ id, type: 'Texture2D', path: options.resDir === '' ? page.name : `${options.resDir}/${page.name}` })
    const src = sources.get(page.name)
    if (src === undefined) {
      issues.loss(`atlas.${page.name}`, `图集页 "${page.name}" 缺失,用到它的部件不会显示`)
      return
    }
    // Spine 的图集默认预乘 alpha,Godot 的 CanvasItem 按直通 alpha 混合 —— 不还原的话半透明部件发黑
    const premultiplied = page.pma || detectPremultiplied(src)
    const image = premultiplied ? unpremultiply(src) : src
    if (premultiplied) issues.add('info', `atlas.${page.name}`, '图集是预乘 alpha 的,已还原成直通 alpha(Godot 按直通混合)')
    if (options.skipImages !== true) files.push({ path: page.name, content: encodePng(image) })
  })

  // ── attachment 节点 ──
  //
  // 皮肤:所有皮肤的 attachment 都建节点(与 Unity 导出同一个思路,见 docs/UNITY-2D.md 第 13 节)。显隐拆成两个独立开关:
  //   Polygon2D.visible —— 换图(主 AnimationPlayer 的轨道驱动)
  //   外面包一层 Node2D 的 visible —— 皮肤(SkinPlayer 每套皮肤一条静态动画)
  // 父节点隐藏子节点就不画,两个开关天然是 AND。只有和皮肤有关的节点才包这一层:具名皮肤里的,
  // 以及默认皮肤里会被某套具名皮肤同 slot 同键名盖住的。
  const attachmentNodes: AttachmentNode[] = []
  const nodesOfSlot = new Map<number, AttachmentNode[]>()
  const subResources: G.SubResourceDecl[] = []
  const helperBones = new Map<string, string>()

  const defaultSkin = part.skins[0]
  const keysOfSkin = new Map<string, Set<string>>()
  for (const s of part.skins) keysOfSkin.set(s.name, new Set(s.slots.flatMap((e) => e.attachments.map((a) => `${e.slot}/${a.key}`))))
  const named = part.skins.filter((s) => s !== defaultSkin && s.slots.length > 0)
  const overridden = new Set(named.flatMap((s) => [...keysOfSkin.get(s.name)!]))
  const skinNames = part.skins.map((s) => s.name)
  if (options.skin !== undefined && !skinNames.includes(options.skin)) {
    throw new Error(`没有皮肤 "${options.skin}",这个骨架有:${skinNames.join('、')}`)
  }
  const initialSkin = options.skin ?? ((defaultSkin?.slots.length ?? 0) > 0 || named.length === 0 ? defaultSkin?.name : named[0]!.name)
  /** 在某套皮肤下,这个节点的皮肤开关是否打开 */
  const shownInSkin = (node: { skin: string; slot: number; key: string }, skin: string | undefined): boolean => {
    if (node.skin === skin) return true
    if (node.skin !== defaultSkin?.name) return false
    // 默认皮肤的:被当前皮肤同 slot 同键名盖住就关
    return skin === undefined || !keysOfSkin.get(skin)!.has(`${node.slot}/${node.key}`)
  }
  const wrappers: { path: string; node: { skin: string; slot: number; key: string } }[] = []

  // ── clipping 遮罩 ──
  //
  // 遮罩 = 场景根下一个 Polygon2D,蒙皮到遮罩 slot 的骨骼(权重 1),clip_children 只当遮罩用;被遮的部件挂在它下面。
  // ⚠️ 实测:子节点的 z_index 必须和遮罩相同(相对 0)才会被裁 —— 范围里的先后只能靠节点顺序,所以按 slot 排。
  // 刚性部件也改成单骨骼蒙皮(挂在骨骼下就不是遮罩的子节点了)
  const clips = clipGroups(part, issues)
  const masks = clips.map((g) => {
    const slot = part.slots[g.slot]!
    const name = names.claim('.', g.key === slot.name ? slot.name : `${slot.name}__${g.key}`)
    return { group: g, path: name, children: [] as { slot: number; decl: G.NodeDecl }[] }
  })
  const maskOfSlot = new Map<number, (typeof masks)[number]>()
  for (const m of masks) for (const s of m.group.clipped) maskOfSlot.set(s, m)

  const emit = (skin: (typeof part.skins)[number], slotIndex: number, a: Attachment, frame?: { index: number; sequence: Sequence }) => {
    const slot = part.slots[slotIndex]!
    const regionName = frame === undefined ? regionNameOf(a) : sequenceRegionName(regionNameOf(a), frame.sequence, frame.index)
    const region = atlas.regions.get(regionName)
    if (region === undefined) {
      issues.loss(`region.${regionName}`, `图集里没有 "${regionName}",这个部件不会显示`)
      return
    }
    const texture = pageId.get(region.page)!
    const color = unpackRgba(a.data['color'] as number)
    const slotColor = unpackRgba(slot.color)
    let base = a.key === slot.name ? slot.name : `${slot.name}__${a.key}`
    if (frame !== undefined) base += ` #${frame.sequence.start + frame.index}`

    let polygon: number[]
    let uv: number[]
    let triangles: number[][]
    let parent: string
    const common = { slot: slotIndex, skin: skin.name, key: a.key, attachment: a, ...(frame === undefined ? {} : { frame }) }
    let node: Omit<AttachmentNode, 'path'>
    const mask = maskOfSlot.get(slotIndex)
    /** 被遮的节点进遮罩的子节点列表(之后按 slot 排),其余照常 */
    const push = (decl: G.NodeDecl) => (mask === undefined ? nodes.push(decl) : mask.children.push({ slot: slotIndex, decl }))

    if (a.type === 'region') {
      polygon = regionCorners(a, region).flatMap((p) => [p.x, -p.y])
      const w = region.width
      const h = region.height
      uv = [toPage(region, 0, h), toPage(region, w, h), toPage(region, w, 0), toPage(region, 0, 0)].flat()
      triangles = [[0, 1, 2], [0, 2, 3]]
      parent = mask?.path ?? bonePath[slot.bone]!
      node = { ...common, parentBone: slot.bone, polygon, ...(mask === undefined ? {} : { rigidBind: restWorld[slot.bone]! }) }
    } else {
      const count = a.data['vertexCount'] as number
      const uvs = a.data['uvs'] as number[]
      uv = []
      for (let i = 0; i < count; i++) uv.push(...meshUv(region, uvs[i * 2]!, uvs[i * 2 + 1]!))
      const tri = a.data['triangles'] as number[]
      triangles = []
      for (let i = 0; i + 2 < tri.length; i += 3) triangles.push([tri[i]!, tri[i + 1]!, tri[i + 2]!])
      const verts = a.data['vertices'] as Vertices
      const single = verts.weighted ? singleBoneOf(verts) : slot.bone
      if (single !== null) {
        polygon = []
        for (let i = 0; i < count; i++) {
          // 只挂一根骨骼的加权网格:顶点可能还带着权重 0 的其他影响,取那根骨骼的
          const w = verts.weighted ? (verts.weights[i]!.find((e) => e.bone === single) ?? verts.weights[i]![0]!) : null
          polygon.push(w === null ? verts.positions[i * 2]! : w.x, -(w === null ? verts.positions[i * 2 + 1]! : w.y))
        }
        parent = mask?.path ?? bonePath[single]!
        node = { ...common, parentBone: single, polygon, ...(mask === undefined ? {} : { rigidBind: restWorld[single]! }) }
      } else {
        parent = mask?.path ?? '.'
        const bound = bindWeighted(verts, uv, restWorld, a.name, issues, checkPoses)
        polygon = bound.polygon
        node = { ...common, polygon, skinned: { slots: bound.slots, weights: bound.weights } }
      }
    }

    // 和皮肤有关的节点外面包一层,皮肤开关打在包装节点上
    const skinDependent = named.length > 0 && (skin !== defaultSkin || overridden.has(`${slotIndex}/${a.key}`))
    let container = parent
    if (skinDependent) {
      const wrapperName = names.claim(parent, `${base} (${skin.name})`)
      container = parent === '.' ? wrapperName : `${parent}/${wrapperName}`
      const props: [string, G.GodotValue][] = shownInSkin(common, initialSkin) ? [] : [['visible', false]]
      push({ name: wrapperName, type: 'Node2D', parent, properties: props })
      wrappers.push({ path: container, node: common })
    }
    const name = names.claim(container, base)
    const path = container === '.' ? name : `${container}/${name}`
    const finalNode: AttachmentNode = { ...node, path }
    attachmentNodes.push(finalNode)
    nodesOfSlot.set(slotIndex, [...(nodesOfSlot.get(slotIndex) ?? []), finalNode])

    const props: [string, G.GodotValue][] = []
    if (!setupVisible(slot, finalNode)) props.push(['visible', false])
    // 绘制顺序:slot 下标就是层号(祖先骨骼的 z 都是 0,相对值即绝对值)。被遮的跟遮罩同层(见上)
    if (slotIndex !== 0 && mask === undefined) props.push(['z_index', slotIndex])
    if (!isWhite(slotColor)) props.push(['self_modulate', colorValue(slotColor)])
    props.push(['texture', G.extResource(texture)])
    if (!isWhite(color)) props.push(['color', colorValue(color)])
    // 蒙皮网格挂在根下(或根下的皮肤包装节点、遮罩里),骨架路径相对它自己
    if (finalNode.skinned !== undefined || finalNode.rigidBind !== undefined) props.push(['skeleton', G.nodePath(skeletonPathFrom(path))])
    props.push(['polygon', G.packedVector2(outPolygon(finalNode, polygon))], ['uv', G.packedVector2(uv)])
    props.push(['polygons', triangles.map((t) => G.packedInt32(t))])
    if (finalNode.skinned !== undefined) {
      const s = finalNode.skinned
      const boneList: G.GodotValue[] = []
      s.slots.forEach(({ bone: b, bind }, k) => {
        let target = bonePath[b]!.slice('Skeleton2D/'.length)
        if (!sameAffine(bind, restWorld[b]!)) {
          // 辅助子骨骼:局部变换恒为单位,rest = 父骨骼 rest⁻¹ · 绑定姿势(docs/GODOT.md 第 3 节)。
          // 按「骨骼 + 绑定矩阵」共用:序列帧的各帧、绑定相同的网格用同一根。⚠️ 不能按附件名认 —— wave 有两个 slot
          // 都挂着叫 tiao 的网格(一个是 linkedmesh,贴图区域不同,按贴图拟合出的绑定也不同),按名字共用的话后一个差 21 像素
          const helperKey = [b, bind.a, bind.b, bind.c, bind.d].map((v) => v.toFixed(6)).join('/') + `/${bind.x.toFixed(4)}/${bind.y.toFixed(4)}`
          let helper = helperBones.get(helperKey)
          if (helper === undefined) {
            const hn = names.claim(bonePath[b]!, `${part.bones[b]!.name}_bind_${a.name}`)
            helper = `${bonePath[b]!}/${hn}`
            helperBones.set(helperKey, helper)
            nodes.push({
              name: hn, type: 'Bone2D', parent: bonePath[b]!,
              properties: [['rest', G.transform2d(mul(inverse(restWorld[b]!), bind))], ['auto_calculate_length_and_angle', false], ['length', G.float(1)], ['bone_angle', G.float(0)]],
            })
          }
          target = helper.slice('Skeleton2D/'.length)
        }
        boneList.push(target, G.packedFloat32(s.weights.map((ws) => ws.filter((w) => w.slot === k).reduce((n, w) => n + w.weight, 0))))
      })
      props.push(['bones', boneList])
    } else if (finalNode.rigidBind !== undefined) {
      props.push(['bones', [bonePath[finalNode.parentBone!]!.slice('Skeleton2D/'.length), G.packedFloat32(new Array<number>(polygon.length / 2).fill(1))]])
    }
    const blend = slot.blendMode
    if (blend !== 0) {
      if (blend === 3) issues.add('approximated', `slot.${slot.name}`, 'Godot 没有 screen 混合模式,按 additive 处理')
      const id = `mat_${blend}`
      if (!subResources.some((r) => r.id === id)) {
        if (blend === 2) {
          // 着色器要写在引用它的材质前面
          subResources.push({ id: 'shader_multiply', type: 'Shader', properties: [['code', MULTIPLY_SHADER]] })
          subResources.push({ id, type: 'ShaderMaterial', properties: [['shader', G.subResource('shader_multiply')]] })
        } else subResources.push({ id, type: 'CanvasItemMaterial', properties: [['blend_mode', 1]] })
      }
      props.push(['material', G.subResource(id)])
    }
    push({ name, type: 'Polygon2D', parent: container, properties: props })
  }

  for (const skin of part.skins) {
    for (const entry of skin.slots) {
      for (const a of entry.attachments) {
        if (a.type !== 'region' && a.type !== 'mesh') {
          if (a.type !== 'clipping' && a.type !== 'boundingbox' && a.type !== 'point' && a.type !== 'path') issues.loss(`attachment.${a.name}`, `不支持的 attachment 类型 ${a.type}`)
          continue
        }
        // 4.1 序列帧:每帧一个节点(换物体而不是换贴图),显示 =「attachment 亮着」且「当前是这一帧」
        if (a.sequence !== null) {
          for (let i = 0; i < a.sequence.count; i++) emit(skin, entry.slot, a, { index: i, sequence: a.sequence })
        } else emit(skin, entry.slot, a)
      }
    }
  }
  for (const slot of part.slots) if (slot.darkColor !== -1) issues.loss(`slot.${slot.name}`, '两色染色(dark color)在 Godot 里没有对应物,只保留亮色')

  // 遮罩节点 + 被遮的部件(按 slot 排:同层的先后靠节点顺序)
  for (const m of masks) {
    const g = m.group
    const slot = part.slots[g.slot]!
    const local = g.polygon.flatMap((p) => [p.x, -p.y])
    const maskNode: AttachmentNode = { slot: g.slot, skin: g.skin, key: g.key, attachment: g.attachment, path: m.path, parentBone: slot.bone, polygon: local, rigidBind: restWorld[slot.bone]! }
    attachmentNodes.push(maskNode)
    const on = clipOnSteps(part, g, null)[0]!.on
    const props: [string, G.GodotValue][] = []
    if (g.slot !== 0) props.push(['z_index', g.slot])
    props.push(['clip_children', on ? CLIP_ON : CLIP_OFF])
    if (!on) props.push(['self_modulate', clipModulate(false)])
    props.push(['skeleton', G.nodePath(skeletonPathFrom(m.path))], ['polygon', G.packedVector2(outPolygon(maskNode, local))])
    props.push(['bones', [bonePath[slot.bone]!.slice('Skeleton2D/'.length), G.packedFloat32(new Array<number>(g.polygon.length).fill(1))]])
    nodes.push({ name: m.path, type: 'Polygon2D', parent: '.', properties: props })
    for (const c of [...m.children].sort((x, y) => x.slot - y.slot)) nodes.push(c.decl)
    issues.add('info', `clipping.${slot.name}/${g.key}`, `遮罩 → clip_children 的 Polygon2D,${g.clipped.length} 个 slot 的部件挂在它下面`)
  }
  if (named.length > 0) {
    issues.add('info', 'skin', `${part.skins.length} 套皮肤全部导进一个场景,运行时 \`$SkinPlayer.play("皮肤名")\` 切换,初始是 "${initialSkin}"`)
  }

  // ── 约束 ──
  for (const c of part.ik) issues.loss(`ik.${c.name}`, 'IK 约束没有转(Godot 的 SkeletonModification2D 还是实验特性),受约束的骨骼停在自己的关键帧上')
  for (const c of part.transform) issues.loss(`transform.${c.name}`, 'transform 约束在 Godot 里没有对应物')
  for (const c of part.path) issues.loss(`path.${c.name}`, 'path 约束在 Godot 里没有对应物')

  // ── 动画 ──
  const animationIds: string[] = []
  /** 每个被动画碰过的属性的 setup 值 —— 写进 RESET */
  const resetValues = new Map<string, { value: G.GodotValue; discrete: boolean }>()
  const setupOf = (node: AttachmentNode, property: string): G.GodotValue => {
    const slot = part.slots[node.slot]!
    if (node.attachment.type === 'clipping') {
      const on = slot.attachmentName === node.key
      if (property === 'clip_children') return on ? CLIP_ON : CLIP_OFF
      if (property === 'self_modulate') return clipModulate(on)
    }
    switch (property) {
      case 'visible': return setupVisible(slot, node)
      case 'z_index': return node.slot
      case 'self_modulate': return colorValue(unpackRgba(slot.color))
      default: return G.packedVector2(outPolygon(node, node.polygon))
    }
  }

  const animTracks: { id: string; anim: AnimationData; tracks: Track[] }[] = []
  part.animations.forEach((anim, ai) => {
    const tracks: Track[] = []
    const { kept, dropped } = lastPerProperty(anim.timelines)
    issues.scoped(anim.name, () => {
      for (const d of dropped) if (!d.identical) issues.add('approximated', describeTimeline(part, d.timeline), DUPLICATE_TIMELINE_MESSAGE)
      tracks.push(...boneTracks(part, anim, kept, bonePath, is38, issues))
      tracks.push(...slotTracks(part, anim, kept, nodesOfSlot, maskOfSlot, is38, issues))
      tracks.push(...deformTracks(part, anim, kept, attachmentNodes, timelineParents, is38, issues))
      tracks.push(...clipTracks(part, anim, kept, masks))
      if (kept.some((t) => t.kind === 'event')) issues.loss('events', 'Spine 事件没有转(Godot 的方法轨道要有脚本接)')
    })
    for (const t of tracks) {
      if (resetValues.has(t.path)) continue
      const [nodePathPart, property] = splitTrackPath(t.path)
      const bone = bonePath.indexOf(nodePathPart)
      if (bone >= 0) {
        resetValues.set(t.path, { value: G.float(boneSetupProperty(restLocals[bone]!, property)), discrete: false })
        continue
      }
      const node = attachmentNodes.find((n) => n.path === nodePathPart)
      if (node !== undefined) resetValues.set(t.path, { value: setupOf(node, property), discrete: property === 'visible' || property === 'z_index' || property === 'clip_children' })
    }
    const id = `Animation_${ai}`
    animationIds.push(id)
    animTracks.push({ id, anim, tracks })
  })

  // ⚠️ 同一个属性在所有动画(含 RESET)里必须是同一种轨道(实测):Stage_rewards 的 b_box 骨骼在 5_open2 里是贝塞尔轨道、
  // RESET 里是值轨道,别的动画里它回不到 RESET,位置和缩放全是 0(骨骼缩成一个点,整个宝箱不见)。
  // 某条动画用了贝塞尔的属性,其他动画和 RESET 里也写成贝塞尔(直线段的控制柄放三分点,值不变)
  const bezierPaths = new Set(animTracks.flatMap((a) => a.tracks.filter((t) => t.kind === 'bezier').map((t) => t.path)))
  for (const { id, anim, tracks } of animTracks) {
    subResources.push(animationResource(id, anim.name, durationOf(anim), true, tracks.map((t) => (bezierPaths.has(t.path) ? asBezier(t) : t))))
  }
  const reset: Track[] = [...resetValues.entries()].map(([path, r]) => asBezierIf(bezierPaths.has(path), { path, kind: 'value', discrete: r.discrete, times: [0], values: [r.value] }))
  subResources.push(animationResource('Animation_RESET', 'RESET', 0.001, false, reset))
  const lib: Record<string, G.GodotValue> = { '&"RESET"': G.subResource('Animation_RESET') }
  part.animations.forEach((anim, i) => { lib[`&${JSON.stringify(anim.name)}`] = G.subResource(animationIds[i]!) })
  subResources.push({ id: 'AnimationLibrary_main', type: 'AnimationLibrary', properties: [['_data', lib]] })

  const playerProps: [string, G.GodotValue][] = [
    ['libraries/', G.subResource('AnimationLibrary_main')],
    // 换动画回 setup(实测:默认档位会留着上一条动画的值)
    ['deterministic', true],
    // 离散轨道每帧按当前时间求值(实测:默认档位往回拖不重新求值)
    ['callback_mode_discrete', 2],
  ]
  if (part.animations.length > 0) playerProps.push(['autoplay', part.animations[0]!.name])
  nodes.push({ name: 'AnimationPlayer', type: 'AnimationPlayer', parent: '.', properties: playerProps })

  // ── 皮肤:SkinPlayer 每套皮肤一条静态动画,只写包装节点的 visible ──
  // 不开 deterministic(它不该把主动画的属性拉回 RESET);切皮肤 = `$SkinPlayer.play("皮肤名")`
  if (wrappers.length > 0) {
    const skinLib: Record<string, G.GodotValue> = {}
    part.skins.forEach((skin, i) => {
      if (skin !== defaultSkin && skin.slots.length === 0) return
      const tracks: Track[] = wrappers.map((w) => ({ path: `${w.path}:visible`, kind: 'value', discrete: true, times: [0], values: [shownInSkin(w.node, skin.name)] }))
      const id = `Skin_${i}`
      subResources.push(animationResource(id, skin.name, 0.001, false, tracks))
      skinLib[`&${JSON.stringify(skin.name)}`] = G.subResource(id)
    })
    subResources.push({ id: 'AnimationLibrary_skins', type: 'AnimationLibrary', properties: [['_data', skinLib]] })
    nodes.push({
      name: 'SkinPlayer', type: 'AnimationPlayer', parent: '.',
      properties: [['libraries/', G.subResource('AnimationLibrary_skins')], ['callback_mode_discrete', 2], ['autoplay', initialSkin ?? '']],
    })
  }

  files.push({ path: `${options.name}.tscn`, content: G.writeScene({ extResources, subResources, nodes }) })
  return { files, issues: issues.all }
}

function sameAffine(p: Affine, q: Affine): boolean {
  return Math.abs(p.a - q.a) + Math.abs(p.b - q.b) + Math.abs(p.c - q.c) + Math.abs(p.d - q.d) < 1e-6 && Math.hypot(p.x - q.x, p.y - q.y) < 1e-3
}

function splitTrackPath(path: string): [string, string] {
  const i = path.indexOf(':')
  return [path.slice(0, i), path.slice(i + 1)]
}

function boneSetupProperty(l: GodotLocal, property: string): number {
  switch (property) {
    case 'position:x': return l.x
    case 'position:y': return l.y
    case 'rotation': return l.rotation
    case 'skew': return l.skew
    case 'scale:x': return l.scaleX
    case 'scale:y': return l.scaleY
    default: throw new Error(`没有 ${property} 的 setup 值`)
  }
}

/** Spine 的动画时长 = 所有时间轴最后一个关键帧的时刻 */
function durationOf(anim: AnimationData): number {
  let end = 0
  for (const t of anim.timelines) {
    const frames = t.kind === 'deform' || t.kind === 'sequence' ? (t.frames[0] as { frames: Record<string, unknown>[] }).frames : t.frames
    for (const f of frames) end = Math.max(end, Number(f['time'] ?? 0))
  }
  return end
}

/**
 * 加权网格的绑定。Godot 的绑定是「每根骨骼一个 rest、所有顶点共用」,而 Spine 加权网格每个影响各存一份局部坐标 ——
 * 绑完又在别的姿势下改过顶点的网格,同一顶点各影响在 setup 下对不齐(wave 的 tiao、Female staff 的 arm-RD2)。
 *
 * 解法与 Unity 导出共用(skinSlots.ts):**同一根骨骼可以占多个槽位**,每个槽位一个绑定矩阵,对不上的影响另开槽位,
 * 任何姿势下都与 Spine 逐影响相同。绑定矩阵不是骨骼 rest 的槽位,用一根辅助子骨骼表达(第 3 节)。
 * 顶点和基准两种候选(setup / 按贴图拟合),取多出来的槽位少的。
 *
 * Polygon2D 每顶点只用权重最大的 4 根骨骼(源码里写死 4 个槽,再归一)。超过的顶点:挑留哪 4 根、按全部动画的姿势
 * 重新拟合它们的局部坐标和权重,实测误差报出来 —— 之前一声不响地被 Godot 截掉。
 *
 * 之前(2026-09-28)是「两种绑定取实测偏差小的,还偏就每条动画逐帧加 polygon 修正轨道」:准是准,但轨道体积大,
 * 在 Godot 里改骨骼动画修正也不跟着变。
 */
function bindWeighted(
  verts: Vertices,
  uv: readonly number[],
  restWorld: readonly Affine[],
  name: string,
  issues: IssueCollector,
  poses: () => readonly (readonly Affine[])[],
): { polygon: number[]; slots: { bone: number; bind: Affine }[]; weights: { slot: number; weight: number }[][] } {
  // Spine 的局部坐标翻成 Godot 的(Y 朝下);Godot 的骨骼有 skew,setup 与 Spine 一致,两份基准是同一个
  const influences = verts.weights.map((e) => e.map((w) => ({ bone: w.bone, x: w.x, y: -w.y, weight: w.weight })))
  const subset: number[] = []
  for (const e of verts.weights) for (const w of e) if (!subset.includes(w.bone)) subset.push(w.bone)
  // 图上的位置(页像素,Y 朝下,与 Godot 同向)
  const image = verts.weights.map((_, i) => ({ x: uv[i * 2]!, y: uv[i * 2 + 1]! }))
  const bound = bindSlots(influences, subset, { engine: (b) => restWorld[b]!, target: (b) => restWorld[b]! }, image)

  let pairs: PosePair[] | null = null
  let truncated = 0
  let over4 = false
  const raw = influences.map((entry, j) => {
    const fit = truncateVertex(bound, j, entry, (pairs ??= poses().map((W) => ({ target: W, engine: W }))))
    if (fit === null) return entry.map((w, i) => ({ slot: bound.slotOf[j]![i]!, weight: w.weight })).filter((w) => w.weight > 0)
    over4 = true
    truncated = Math.max(truncated, fit.error)
    return fit.slots.map((slot, q) => ({ slot, weight: fit.weights[q]! }))
  })
  // 截断拟合会让一些槽位没人用了 —— 压掉,不留空的辅助骨骼
  const compact = compactSlots(bound, raw.flatMap((ws) => ws.map((w) => w.slot)))
  const slots = compact.slots.map((s) => ({ bone: s.bone, bind: s.bind }))
  const weights = raw.map((ws) => ws.map((w) => ({ slot: compact.renumber.get(w.slot)!, weight: w.weight })))

  const extra = compact.extra
  if (extra > 0) {
    issues.add('info', `mesh.${name}`,
      `绑定姿势各顶点不一致(各影响的位置最多差 ${bound.spread.toFixed(1)} 像素,绑完又改过顶点):` +
      `另配了 ${extra} 根辅助子骨骼${bound.fitted ? ',基准按贴图拟合' : ''},各影响与 Spine 逐个一致`)
  } else if (bound.fitted) {
    issues.add('info', `mesh.${name}`, `绑定姿势不是 setup 姿势(各影响的位置最多差 ${bound.spread.toFixed(1)} 像素),用辅助子骨骼表达它自己的绑定姿势`)
  }
  if (over4) {
    issues.add(truncated > 0.5 ? 'approximated' : 'info', `mesh.${name}`,
      `每顶点超过 4 根骨骼,Godot 的 Polygon2D 只用权重最大的 4 根:按全部动画的姿势挑留哪四根、重新拟合它们的局部坐标和权重,` +
      `动画里最多偏 ${truncated.toFixed(1)} 像素`)
  }
  return { polygon: bound.v.flatMap((p) => [p.x, p.y]), slots, weights }
}

// ─── 各类时间轴 ──────────────────────────────────────────────────────────────

const BONE_KINDS = new Set(['rotate', 'translate', 'translateX', 'translateY', 'scale', 'scaleX', 'scaleY', 'shear', 'shearX', 'shearY'])

function boneTracks(
  part: SkeletonPart,
  anim: AnimationData,
  timelines: readonly Timeline[],
  bonePath: readonly string[],
  is38: boolean,
  issues: IssueCollector,
): Track[] {
  const out: Track[] = []
  const sheared = new Set<number>()
  for (const t of timelines) if (t.kind.startsWith('shear')) sheared.add(t.owner)

  for (const t of timelines) {
    if (!BONE_KINDS.has(t.kind)) continue
    const bone = part.bones[t.owner]
    if (bone === undefined) continue
    const path = bonePath[t.owner]!
    // shear 同时影响 Godot 的 rotation 和 skew,且与 rotate 的关键帧对不齐 —— 这根骨骼整体采样
    if (sheared.has(t.owner)) continue
    const f = t.frames
    switch (t.kind) {
      case 'rotate':
        // Godot rotation = −(rotation + shearX),弧度
        out.push(floatTrack(`${path}:rotation`, f, 'value', 0, is38, { slope: -DEG, offset: -(bone.rotation + bone.shearX) * DEG }, 0))
        break
      case 'translate':
        out.push(floatTrack(`${path}:position:x`, f, 'x', 0, is38, { slope: 1, offset: bone.x }, 0))
        out.push(floatTrack(`${path}:position:y`, f, 'y', 1, is38, { slope: -1, offset: -bone.y }, 0))
        break
      case 'translateX':
        out.push(floatTrack(`${path}:position:x`, f, 'value', 0, is38, { slope: 1, offset: bone.x }, 0))
        break
      case 'translateY':
        out.push(floatTrack(`${path}:position:y`, f, 'value', 0, is38, { slope: -1, offset: -bone.y }, 0))
        break
      case 'scale':
        out.push(floatTrack(`${path}:scale:x`, f, 'x', 0, is38, { slope: bone.scaleX, offset: 0 }, 1))
        out.push(floatTrack(`${path}:scale:y`, f, 'y', 1, is38, { slope: bone.scaleY, offset: 0 }, 1))
        break
      case 'scaleX':
        out.push(floatTrack(`${path}:scale:x`, f, 'value', 0, is38, { slope: bone.scaleX, offset: 0 }, 1))
        break
      case 'scaleY':
        out.push(floatTrack(`${path}:scale:y`, f, 'value', 0, is38, { slope: bone.scaleY, offset: 0 }, 1))
        break
    }
  }

  // 有 shear 的骨骼:按 Spine 的求值逐帧采样 rotation / skew,其余通道照常走上面的精确转换
  if (sheared.size > 0) {
    const end = durationOf(anim)
    const times = sampleTimes(end, timelines.filter((t) => sheared.has(t.owner)))
    for (const b of sheared) {
      const rot: number[] = []
      const skew: number[] = []
      for (const time of times) {
        const l = godotLocal(localsAt(part, { ...anim, timelines: [...timelines] }, time)[b]!)
        rot.push(l.rotation)
        skew.push(l.skew)
      }
      const path = bonePath[b]!
      out.push({ path: `${path}:rotation`, kind: 'value', times, values: rot.map(G.float) })
      out.push({ path: `${path}:skew`, kind: 'value', times, values: skew.map(G.float) })
      // 其余通道(平移、缩放)照常转换
      for (const t of timelines) {
        if (t.owner !== b || t.kind === 'rotate' || t.kind.startsWith('shear')) continue
        out.push(...boneTracks(part, anim, [t], bonePath, is38, issues))
      }
      issues.add('approximated', `shear[${part.bones[b]!.name}]`, `shear 动画按 ${SAMPLE_FPS} fps 采样成线性关键帧`)
    }
  }
  return out
}

/** 关键帧时刻 + 按 SAMPLE_FPS 均匀采样,去重排序 */
function sampleTimes(end: number, timelines: readonly Timeline[]): number[] {
  // 关键帧(含阶梯段边界前的那一刻)照留,再按 SAMPLE_FPS 铺满
  const set = new Set<number>(keyTimesWithSteps(timelines))
  for (let i = 0; i * (1 / SAMPLE_FPS) < end; i++) set.add(Number((i / SAMPLE_FPS).toFixed(6)))
  set.add(end)
  return [...set].sort((a, b) => a - b)
}

function slotTracks(
  part: SkeletonPart,
  anim: AnimationData,
  timelines: readonly Timeline[],
  nodesOfSlot: ReadonlyMap<number, readonly AttachmentNode[]>,
  maskOfSlot: ReadonlyMap<number, unknown>,
  is38: boolean,
  issues: IssueCollector,
): Track[] {
  const out: Track[] = []

  // 换图:该 slot 的每个挂图节点一条 visible 阶梯轨道(序列帧节点另算,见下)
  for (const t of timelines) {
    if (t.kind !== 'attachment') continue
    const slot = part.slots[t.owner]
    const list = nodesOfSlot.get(t.owner)
    if (slot === undefined || list === undefined) continue
    for (const node of list) {
      if (node.frame !== undefined) continue
      const steps: { t: number; v: G.GodotValue }[] = [{ t: 0, v: slot.attachmentName === node.key }]
      for (const f of t.frames) steps.push({ t: Number(f['time'] ?? 0), v: f['name'] === node.key })
      out.push(stepTrack(`${node.path}:visible`, steps))
    }
  }

  // 序列帧:亮 =「换图时间轴说这个键名亮着」且「sequence 时间轴说现在是这一帧」,两个阶梯合成一个。
  // 这条动画两样都没碰就不写 —— RESET 会回到 setup 那一帧
  const skinName = (s: number | string) => (typeof s === 'number' ? (part.skins[s]?.name ?? String(s)) : s)
  for (const [slotIndex, list] of nodesOfSlot) {
    const slot = part.slots[slotIndex]!
    const groups = new Map<string, AttachmentNode[]>()
    for (const n of list) if (n.frame !== undefined) groups.set(`${n.skin}/${n.key}`, [...(groups.get(`${n.skin}/${n.key}`) ?? []), n])
    for (const frames of groups.values()) {
      const first = frames[0]!
      const seq = first.frame!.sequence
      const seqTimeline = timelines.find((t) => {
        if (t.kind !== 'sequence' || t.owner !== slotIndex) return false
        const d = t.frames[0] as { skin: number | string; attachment: string }
        return skinName(d.skin) === first.skin && (d.attachment === first.key || d.attachment === first.attachment.name)
      })
      const attTimeline = timelines.find((t) => t.kind === 'attachment' && t.owner === slotIndex)
      if (seqTimeline === undefined && attTimeline === undefined) continue
      const keys = seqTimeline === undefined ? undefined : (seqTimeline.frames[0] as unknown as { frames: SequenceKey[] }).frames
      let end = durationOf(anim)
      // 时长为 0 的动画 Spine 里时间照走、序列帧一直播;Godot 的动画要有长度才循环 —— 取一个周期
      if (end <= 0 && keys !== undefined) end = Math.max(0, ...keys.map((k) => sequenceCycle(k, seq.count)))
      const frameSteps = sequenceSteps(keys, seq, end).map((s) => ({ time: s.time, value: s.frame }))
      const visSteps = [{ time: 0, value: slot.attachmentName === first.key }]
      for (const f of attTimeline?.frames ?? []) visSteps.push({ time: Number(f['time'] ?? 0), value: f['name'] === first.key })
      const at = <T,>(steps: readonly { time: number; value: T }[], t: number): T => {
        let v = steps[0]!.value
        for (const s of steps) { if (s.time > t + 1e-9) break; v = s.value }
        return v
      }
      const changes = [...new Set([...frameSteps, ...visSteps].map((s) => s.time))].sort((x, y) => x - y)
      for (const node of frames) {
        out.push(stepTrack(`${node.path}:visible`, changes.map((t) => ({ t, v: at(visSteps, t) && at(frameSteps, t) === node.frame!.index }))))
      }
    }
  }

  // slot 颜色:同一个 slot 可以有 rgb + alpha 两条时间轴分管不同通道,统一求值后写一条 self_modulate
  const colorTimelines = new Map<number, Timeline[]>()
  for (const t of timelines) {
    if (t.kind === 'color' || t.kind === 'twoColor' || t.kind.startsWith('slotColor')) {
      const list = colorTimelines.get(t.owner) ?? []
      list.push(t)
      colorTimelines.set(t.owner, list)
      if (t.kind === 'twoColor' || t.kind === 'slotColor3' || t.kind === 'slotColor4') {
        issues.loss(`color[${part.slots[t.owner]?.name}]`, '两色染色的暗色部分没有对应物,只保留亮色')
      }
    }
  }
  for (const [slotIndex, list] of colorTimelines) {
    const slot = part.slots[slotIndex]
    const nodes = nodesOfSlot.get(slotIndex)
    if (slot === undefined || nodes === undefined) continue
    const setup = unpackRgba(slot.color)
    const curved = list.some((t) => t.frames.some((f) => f['curve'] === 'bezier'))
    const times = curved ? sampleTimes(durationOf(anim), list) : keyTimesWithSteps(list)
    const values = times.map((time) => colorValue(slotColorAt(list, setup, time, is38)))
    if (curved) issues.add('approximated', `color[${slot.name}]`, `颜色曲线按 ${SAMPLE_FPS} fps 采样成线性关键帧`)
    for (const node of nodes) out.push({ path: `${node.path}:self_modulate`, kind: 'value', times, values })
  }

  // 逐帧绘制顺序:挪过位的 slot,其挂图节点一条 z_index 阶梯轨道
  const drawOrder = timelines.find((t) => t.kind === 'drawOrder')
  if (drawOrder !== undefined) {
    const layers = drawOrder.frames.map((f) => ({
      t: Number(f['time'] ?? 0),
      layer: layerOfSlot(drawOrderOf(part.slots.length, (f['offsets'] as DrawOrderOffset[] | undefined) ?? [])),
    }))
    for (let s = 0; s < part.slots.length; s++) {
      // 被遮的跟遮罩同层,先后靠节点顺序(范围变了 clipGroups 会报)
      if (layers.every((l) => l.layer[s] === s) || maskOfSlot.has(s)) continue
      const steps = [{ t: 0, v: s as G.GodotValue }, ...layers.map((l) => ({ t: l.t, v: l.layer[s]! as G.GodotValue }))]
      for (const node of nodesOfSlot.get(s) ?? []) out.push(stepTrack(`${node.path}:z_index`, steps))
    }
  }
  return out
}

/**
 * 遮罩的开关和层号。开关打在 `clip_children` + 遮罩自己的 `self_modulate` 上(不能藏节点,见 CLIP_ON);
 * 遮罩 slot 被绘制顺序动画挪过位的,遮罩跟着挪(被遮的部件是它的子节点,一起走)
 */
function clipTracks(
  part: SkeletonPart,
  anim: AnimationData,
  timelines: readonly Timeline[],
  masks: readonly { group: ClipGroup; path: string }[],
): Track[] {
  const out: Track[] = []
  const drawOrder = timelines.find((t) => t.kind === 'drawOrder')
  for (const { group: g, path } of masks) {
    if (clipToggled(anim, g)) {
      const steps = clipOnSteps(part, g, anim)
      out.push(stepTrack(`${path}:clip_children`, steps.map((s) => ({ t: s.t, v: s.on ? CLIP_ON : CLIP_OFF }))))
      out.push(stepTrack(`${path}:self_modulate`, steps.map((s) => ({ t: s.t, v: clipModulate(s.on) }))))
    }
    if (drawOrder !== undefined) {
      const layers = drawOrder.frames.map((f) => ({
        t: Number(f['time'] ?? 0),
        layer: layerOfSlot(drawOrderOf(part.slots.length, (f['offsets'] as DrawOrderOffset[] | undefined) ?? []))[g.slot]!,
      }))
      if (layers.some((l) => l.layer !== g.slot)) out.push(stepTrack(`${path}:z_index`, [{ t: 0, v: g.slot }, ...layers.map((l) => ({ t: l.t, v: l.layer }))]))
    }
  }
  return out
}

/** 关键帧时刻,阶梯段在下一帧之前补一个时刻 —— 值轨道线性插值,靠它变成阶梯 */
function keyTimesWithSteps(timelines: readonly Timeline[]): number[] {
  const set = new Set<number>([0])
  for (const t of timelines) {
    t.frames.forEach((f, i) => {
      const time = Number(f['time'] ?? 0)
      set.add(time)
      const next = t.frames[i + 1]
      if (f['curve'] === 'stepped' && next !== undefined) set.add(Number(next['time']) - STEP_EPSILON)
    })
    const first = Number(t.frames[0]?.['time'] ?? 0)
    if (first > 0) set.add(first - STEP_EPSILON)
  }
  return [...set].sort((a, b) => a - b)
}

interface DeformRecord {
  readonly skin: number | string
  readonly attachment: string
  readonly frames: readonly Record<string, unknown>[]
}

/**
 * deform → 对 `polygon` 打关键帧。
 *
 * 不蒙皮的网格:polygon = 原顶点 + 偏移(骨骼局部空间),任何姿势下都精确。
 * 蒙皮网格:Spine 的偏移是逐影响、在各自骨骼局部空间里的;Godot 的 polygon 在绑定空间。
 * 按关键帧时刻的姿势反解 `M(P)·δ = Δ`(与 Unity Blend Shape 同一套推导,见 docs/UNITY-2D.md 11.4):
 * `M(P) = Σ wᵢ · lin(Bᵢ(P) · Bindᵢ⁻¹)`,`Δ = Σ wᵢ · lin(Bᵢ(P)) · dᵢ`。关键帧时刻精确。
 */
function deformTracks(
  part: SkeletonPart,
  anim: AnimationData,
  timelines: readonly Timeline[],
  nodes: readonly AttachmentNode[],
  timelineParents: ReadonlyMap<Attachment, { skin: string; key: string }>,
  is38: boolean,
  issues: IssueCollector,
): Track[] {
  const out: Track[] = []
  const skinName = (s: number | string) => (typeof s === 'number' ? (part.skins[s]?.name ?? String(s)) : s)
  for (const t of timelines) {
    if (t.kind !== 'deform') continue
    const d = t.frames[0] as unknown as DeformRecord
    const targets = nodes.filter((n) => {
      if (n.slot !== t.owner) return false
      const parent = timelineParents.get(n.attachment)
      if (parent !== undefined) return parent.skin === skinName(d.skin) && parent.key === d.attachment
      return n.skin === skinName(d.skin) && (n.key === d.attachment || n.attachment.name === d.attachment)
    })
    for (const node of targets) {
      const a = node.attachment
      if (a.type !== 'mesh' && a.type !== 'clipping') continue
      const verts = a.data['vertices'] as Vertices
      if (a.type === 'clipping' && verts.weighted) {
        issues.add('approximated', `deform[${a.name}]`, '加权遮罩多边形上的 deform 没有转')
        continue
      }
      const count = a.data['vertexCount'] as number
      const flatLength = verts.weighted ? verts.weights.reduce((n, w) => n + w.length * 2, 0) : count * 2
      const frames = d.frames
      const offsetsOf = (f: Record<string, unknown>): number[] => {
        const v = (f['vertices'] as number[] | undefined) ?? []
        const start = Number(f['start'] ?? 0)
        const flat = new Array<number>(flatLength).fill(0)
        v.forEach((x, k) => { if (start + k < flatLength) flat[start + k] = x })
        return flat
      }
      const polygonAt = (flat: readonly number[], time: number): number[] => {
        if (node.skinned === undefined) {
          // 不蒙皮:顶点就在骨骼局部空间,偏移直接加(Y 翻转)。
          // 只挂一根骨骼的加权网格,偏移是逐影响排的 —— 取那根骨骼那一份
          const outP: number[] = []
          if (!verts.weighted) {
            for (let i = 0; i < count; i++) outP.push(node.polygon[i * 2]! + flat[i * 2]!, node.polygon[i * 2 + 1]! - flat[i * 2 + 1]!)
            return outP
          }
          let k = 0
          verts.weights.forEach((entry, i) => {
            const at = Math.max(0, entry.findIndex((w) => w.bone === node.parentBone))
            outP.push(node.polygon[i * 2]! + flat[k + at * 2]!, node.polygon[i * 2 + 1]! - flat[k + at * 2 + 1]!)
            k += entry.length * 2
          })
          return outP
        }
        return skinnedPolygonAt(part, { ...anim, timelines: [...timelines] }, node, flat, time)
      }
      const curved = frames.some((f) => f['curve'] === 'bezier')
      const keyTimes = frames.map((f) => Number(f['time'] ?? 0))
      // 蒙皮网格的反解只在求解的那一刻精确:两帧之间 Godot 在绑定空间线性插值,而 Spine 是在各骨骼局部插值后再蒙皮,
      // 姿势一变两者就分开(Unity 的 Blend Shape 同样如此,只能报分歧)。Godot 的 polygon 轨道可以多打键,所以逐帧反解
      const asTimeline = [{ kind: 'deform', owner: t.owner, frames, bezierCount: -1 }]
      const times = curved || node.skinned !== undefined ? sampleTimes(durationOf(anim), asTimeline) : keyTimesWithSteps(asTimeline)
      const values = times.map((time) => {
        const pack = (local: readonly number[]) => G.packedVector2(outPolygon(node, local))
        if (time < keyTimes[0]!) return pack(node.skinned === undefined ? node.polygon : polygonAt(new Array<number>(flatLength).fill(0), time))
        let i = frames.length - 1
        for (let k = 0; k < frames.length - 1; k++) if (time < keyTimes[k + 1]!) { i = k; break }
        const f0 = offsetsOf(frames[i]!)
        if (i === frames.length - 1) return pack(polygonAt(f0, time))
        const f1 = offsetsOf(frames[i + 1]!)
        // deform 的曲线是 0..1 的进度(两版一致,见 bezier.ts)
        const p = valueBetween([{ ...frames[i]!, v: 0 }, { ...frames[i + 1]!, v: 1 }], 0, 'v', time, is38)
        return pack(polygonAt(f0.map((x, j) => x + (f1[j]! - x) * p), time))
      })
      if (curved) issues.add('approximated', `deform[${a.name}]`, `deform 曲线按 ${SAMPLE_FPS} fps 采样成线性关键帧`)
      out.push({ path: `${node.path}:polygon`, kind: 'value', times, values })
    }
  }
  return out
}

/**
 * 蒙皮网格在 time 时刻、带 Spine 偏移 flat(逐影响,骨骼局部)时,Godot 的 polygon 应取什么值。
 *
 * 反解 M(P)·δ = Δ:`M(P) = Σ w'ₖ · lin(Bₖ(P) · Bindₖ⁻¹)`(Godot 实际用的槽位和权重),Δ = Spine 的完整位置(全部影响 + 偏移)
 * − Godot 不加形变时的位置。每个影响原样表达时 Δ 就是 Σ wᵢ Bᵢ dᵢ;超过 4 根被截掉的顶点,顺带把截断误差也消掉。求解的那一刻精确。
 */
function skinnedPolygonAt(part: SkeletonPart, anim: AnimationData, node: AttachmentNode, flat: readonly number[], time: number): number[] {
  const s = node.skinned!
  const verts = node.attachment.data['vertices'] as Vertices
  const worlds = godotWorlds(part, localsAt(part, anim, time).map(godotLocal))
  const ms = s.slots.map((slot) => mul(worlds[slot.bone]!, inverse(slot.bind)))
  const out: number[] = []
  let k = 0
  verts.weights.forEach((entry, i) => {
    // Spine:局部坐标 + 偏移(Y 上)→ Godot 局部 (x, −y) → 世界
    let tx = 0, ty = 0
    for (const w of entry) {
      const sp = apply(worlds[w.bone]!, w.x + (flat[k] ?? 0), -(w.y + (flat[k + 1] ?? 0)))
      tx += w.weight * sp.x
      ty += w.weight * sp.y
      k += 2
    }
    // Godot:槽位蒙皮
    let m00 = 0, m01 = 0, m10 = 0, m11 = 0, bx = 0, by = 0
    const vx = node.polygon[i * 2]!, vy = node.polygon[i * 2 + 1]!
    for (const e of s.weights[i]!) {
      const D = ms[e.slot]!
      m00 += e.weight * D.a; m01 += e.weight * D.b; m10 += e.weight * D.c; m11 += e.weight * D.d
      const b = apply(D, vx, vy)
      bx += e.weight * b.x
      by += e.weight * b.y
    }
    const det = m00 * m11 - m01 * m10
    const dx = tx - bx
    const dy = ty - by
    out.push(
      vx + (Math.abs(det) < 1e-12 ? 0 : (m11 * dx - m01 * dy) / det),
      vy + (Math.abs(det) < 1e-12 ? 0 : (-m10 * dx + m00 * dy) / det),
    )
  })
  return out
}
