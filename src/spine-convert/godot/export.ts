import type { SkeletonPart } from '../../spine-format/binary/readSkeleton.ts'
import type { Attachment, Sequence, Vertices } from '../../spine-format/binary/readSkins.ts'
import type { AnimationData, Timeline } from '../../spine-format/binary/readAnimations.ts'
import type { Atlas, AtlasRegion } from '../../core/atlas.ts'
import { encodePng, type Image } from '../../unity/png.ts'
import { detectPremultiplied, unpremultiply } from '../unity/alpha.ts'
import { resolveLinkedMeshes } from '../unity/linkedMesh.ts'
import { fitSimilarity, applyFit, type Fit } from '../unity/mesh.ts'
import { toAbsoluteBezier } from '../../spine-format/bezier.ts'
import { describeTimeline, DUPLICATE_TIMELINE_MESSAGE, lastPerProperty } from '../../spine-format/duplicateTimelines.ts'
import { localsAt, setupLocals, valueBetween, type Affine, type BoneLocal } from '../../spine-eval/pose.ts'
import { drawOrderOf, layerOfSlot, type DrawOrderOffset } from '../../spine-eval/drawOrder.ts'
import { sequenceCycle, sequenceFrameAt, sequenceRegionName, sequenceSteps, type SequenceKey } from '../../spine-eval/sequence.ts'
import { IssueCollector, type ConversionIssue } from '../types.ts'
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

/** 最小二乘仿射 `dst ≈ M·src + t`;点不足 3 个或近乎共线时返回 null */
function fitAffine(src: readonly { x: number; y: number }[], dst: readonly { x: number; y: number }[]): Affine | null {
  const n = src.length
  if (n < 3) return null
  let sx = 0, sy = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) { sx += src[i]!.x / n; sy += src[i]!.y / n; dx += dst[i]!.x / n; dy += dst[i]!.y / n }
  let sxx = 0, sxy = 0, syy = 0, cxx = 0, cxy = 0, cyx = 0, cyy = 0
  for (let i = 0; i < n; i++) {
    const px = src[i]!.x - sx, py = src[i]!.y - sy
    const qx = dst[i]!.x - dx, qy = dst[i]!.y - dy
    sxx += px * px; sxy += px * py; syy += py * py
    cxx += qx * px; cxy += qx * py; cyx += qy * px; cyy += qy * py
  }
  const det = sxx * syy - sxy * sxy
  // 相对判据:点铺得太扁(共线)时仿射不定
  if (det < 1e-6 * (sxx + syy) * (sxx + syy) || det < 1e-9) return null
  const i00 = syy / det, i01 = -sxy / det, i11 = sxx / det
  const a = cxx * i00 + cxy * i01
  const b = cxx * i01 + cxy * i11
  const c = cyx * i00 + cyy * i01
  const d = cyx * i01 + cyy * i11
  return { a, b, c, d, x: dx - (a * sx + b * sy), y: dy - (c * sx + d * sy) }
}

function fitToAffine(f: Fit): Affine {
  const c = Math.cos(DEG * f.rotation) * f.scale
  const s = Math.sin(DEG * f.rotation) * f.scale
  return { a: c, b: -s, c: s, d: c, x: f.x, y: f.y }
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

/** 离散值轨道,相邻相同的值合并 */
function stepTrack(path: string, steps: readonly { t: number; v: G.GodotValue }[]): Track {
  const times: number[] = []
  const values: G.GodotValue[] = []
  for (const s of steps) {
    if (values.length > 0 && JSON.stringify(values[values.length - 1]) === JSON.stringify(s.v)) continue
    times.push(s.t)
    values.push(s.v)
  }
  return { path, kind: 'value', discrete: true, times, values }
}

function animationResource(id: string, name: string, length: number, loop: boolean, tracks: readonly Track[]): G.SubResourceDecl {
  const props: [string, G.GodotValue][] = [['resource_name', name], ['length', G.float(Math.max(length, 0.001))]]
  if (loop) props.push(['loop_mode', 1])
  tracks.forEach((t, i) => {
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
  /** 蒙皮网格:参与的骨骼(骨架下标 → 绑定骨骼在 Skeleton2D 下的路径)与绑定矩阵(Godot 骨架空间) */
  readonly skinned?: {
    readonly bones: readonly number[]
    readonly binds: readonly Affine[]
    /** 每顶点 (骨骼在 bones 里的下标, 权重) */
    readonly weights: readonly (readonly { index: number; weight: number }[])[]
    /** 绑定不一致(bindWeighted 第 3 档):按 setup 绑,每条动画另加逐帧修正轨道 */
    readonly inconsistent?: { readonly uncorrected: number }
  }
  /** 不蒙皮时挂在哪根骨骼下;顶点在它的局部空间 */
  readonly parentBone?: number
  /** rest 空间(或骨骼局部)的顶点,Godot 坐标 */
  readonly polygon: readonly number[]
  /** 4.1 序列帧 attachment 的第几帧(每帧一个节点) */
  readonly frame?: { readonly index: number; readonly sequence: Sequence }
}

/** setup 姿势下这个挂图节点亮不亮:slot 挂的是它,且(序列帧)是 setup 那一帧 */
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

    if (a.type === 'region') {
      polygon = regionCorners(a, region).flatMap((p) => [p.x, -p.y])
      const w = region.width
      const h = region.height
      uv = [toPage(region, 0, h), toPage(region, w, h), toPage(region, w, 0), toPage(region, 0, 0)].flat()
      triangles = [[0, 1, 2], [0, 2, 3]]
      parent = bonePath[slot.bone]!
      node = { ...common, parentBone: slot.bone, polygon }
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
        parent = bonePath[single]!
        node = { ...common, parentBone: single, polygon }
      } else {
        parent = '.'
        const bound = bindWeighted(verts, uv, restWorld, a.name, issues, checkPoses)
        polygon = bound.polygon
        const bones: number[] = []
        const indexOf = new Map<number, number>()
        for (const e of verts.weights) for (const w of e) if (!indexOf.has(w.bone)) { indexOf.set(w.bone, bones.length); bones.push(w.bone) }
        node = {
          ...common, polygon,
          skinned: {
            bones,
            binds: bones.map((b) => bound.binds.get(b) ?? restWorld[b]!),
            weights: verts.weights.map((e) => e.map((w) => ({ index: indexOf.get(w.bone)!, weight: w.weight }))),
            ...(bound.inconsistent === undefined ? {} : { inconsistent: bound.inconsistent }),
          },
        }
      }
    }

    // 和皮肤有关的节点外面包一层,皮肤开关打在包装节点上
    const skinDependent = named.length > 0 && (skin !== defaultSkin || overridden.has(`${slotIndex}/${a.key}`))
    let container = parent
    if (skinDependent) {
      const wrapperName = names.claim(parent, `${base} (${skin.name})`)
      container = parent === '.' ? wrapperName : `${parent}/${wrapperName}`
      const props: [string, G.GodotValue][] = shownInSkin(common, initialSkin) ? [] : [['visible', false]]
      nodes.push({ name: wrapperName, type: 'Node2D', parent, properties: props })
      wrappers.push({ path: container, node: common })
    }
    const name = names.claim(container, base)
    const path = container === '.' ? name : `${container}/${name}`
    const finalNode: AttachmentNode = { ...node, path }
    attachmentNodes.push(finalNode)
    nodesOfSlot.set(slotIndex, [...(nodesOfSlot.get(slotIndex) ?? []), finalNode])

    const props: [string, G.GodotValue][] = []
    if (!setupVisible(slot, finalNode)) props.push(['visible', false])
    // 绘制顺序:slot 下标就是层号(祖先骨骼的 z 都是 0,相对值即绝对值)
    if (slotIndex !== 0) props.push(['z_index', slotIndex])
    if (!isWhite(slotColor)) props.push(['self_modulate', colorValue(slotColor)])
    props.push(['texture', G.extResource(texture)])
    if (!isWhite(color)) props.push(['color', colorValue(color)])
    // 蒙皮网格挂在根下(或根下的皮肤包装节点里),骨架路径相对它自己
    if (finalNode.skinned !== undefined) props.push(['skeleton', G.nodePath(skinDependent ? '../../Skeleton2D' : '../Skeleton2D')])
    props.push(['polygon', G.packedVector2(polygon)], ['uv', G.packedVector2(uv)])
    props.push(['polygons', triangles.map((t) => G.packedInt32(t))])
    if (finalNode.skinned !== undefined) {
      const s = finalNode.skinned
      const boneList: G.GodotValue[] = []
      s.bones.forEach((b, k) => {
        const bind = s.binds[k]!
        let target = bonePath[b]!.slice('Skeleton2D/'.length)
        if (!sameAffine(bind, restWorld[b]!)) {
          // 辅助子骨骼:局部变换恒为单位,rest = 父骨骼 rest⁻¹ · 绑定姿势(docs/GODOT.md 第 3 节)
          const helperKey = `${b}/${skin.name}/${a.name}`
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
        boneList.push(target, G.packedFloat32(s.weights.map((ws) => ws.filter((w) => w.index === k).reduce((n, w) => n + w.weight, 0))))
      })
      props.push(['bones', boneList])
    }
    const blend = slot.blendMode
    if (blend !== 0) {
      const mode = blend === 1 ? 1 : blend === 2 ? 3 : 1
      if (blend === 3) issues.add('approximated', `slot.${slot.name}`, 'Godot 没有 screen 混合模式,按 additive 处理')
      const id = `mat_${blend}`
      if (!subResources.some((r) => r.id === id)) subResources.push({ id, type: 'CanvasItemMaterial', properties: [['blend_mode', mode]] })
      props.push(['material', G.subResource(id)])
    }
    nodes.push({ name, type: 'Polygon2D', parent: container, properties: props })
  }

  for (const skin of part.skins) {
    for (const entry of skin.slots) {
      for (const a of entry.attachments) {
        if (a.type !== 'region' && a.type !== 'mesh') {
          if (a.type === 'clipping') issues.loss(`attachment.${a.name}`, 'clipping 遮罩在 Godot 2D 里没有对应物(CanvasGroup 的裁剪不是任意多边形),已丢弃')
          else if (a.type !== 'boundingbox' && a.type !== 'point' && a.type !== 'path') issues.loss(`attachment.${a.name}`, `不支持的 attachment 类型 ${a.type}`)
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
  if (named.length > 0) {
    issues.add('info', 'skin', `${part.skins.length} 套皮肤全部导进一个场景,运行时 \`$SkinPlayer.play("皮肤名")\` 切换,初始是 "${initialSkin}"`)
  }

  // ── 约束 ──
  for (const c of part.ik) issues.loss(`ik.${c.name}`, 'IK 约束没有转(Godot 的 SkeletonModification2D 还是实验特性),受约束的骨骼停在自己的关键帧上')
  for (const c of part.transform) issues.loss(`transform.${c.name}`, 'transform 约束在 Godot 里没有对应物')
  for (const c of part.path) issues.loss(`path.${c.name}`, 'path 约束在 Godot 里没有对应物')

  // ── 动画 ──
  const animationIds: string[] = []
  /** 绑定修正轨道在采样帧之间的最大偏差,节点路径 → 像素 */
  const correctionError = new Map<string, number>()
  /** 每个被动画碰过的属性的 setup 值 —— 写进 RESET */
  const resetValues = new Map<string, { value: G.GodotValue; discrete: boolean }>()
  const setupOf = (node: AttachmentNode, property: string): G.GodotValue => {
    const slot = part.slots[node.slot]!
    switch (property) {
      case 'visible': return setupVisible(slot, node)
      case 'z_index': return node.slot
      case 'self_modulate': return colorValue(unpackRgba(slot.color))
      default: return G.packedVector2(node.polygon)
    }
  }

  part.animations.forEach((anim, ai) => {
    const tracks: Track[] = []
    const { kept, dropped } = lastPerProperty(anim.timelines)
    issues.scoped(anim.name, () => {
      for (const d of dropped) if (!d.identical) issues.add('approximated', describeTimeline(part, d.timeline), DUPLICATE_TIMELINE_MESSAGE)
      tracks.push(...boneTracks(part, anim, kept, bonePath, is38, issues))
      tracks.push(...slotTracks(part, anim, kept, nodesOfSlot, is38, issues))
      tracks.push(...deformTracks(part, anim, kept, attachmentNodes, timelineParents, is38, issues))
      tracks.push(...bindCorrectionTracks(part, anim, kept, attachmentNodes, new Set(tracks.map((t) => t.path)), correctionError))
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
      if (node !== undefined) resetValues.set(t.path, { value: setupOf(node, property), discrete: property === 'visible' || property === 'z_index' })
    }
    const id = `Animation_${ai}`
    animationIds.push(id)
    subResources.push(animationResource(id, anim.name, durationOf(anim), true, tracks))
  })

  for (const node of attachmentNodes) {
    const inc = node.skinned?.inconsistent
    if (inc === undefined) continue
    const between = correctionError.get(node.path) ?? 0
    if (between > 0.5) issues.add('approximated', `mesh.${node.attachment.name}`, `绑定姿势不一致,已逐帧修正;${SAMPLE_FPS} fps 采样帧之间最多偏 ${between.toFixed(1)} 像素(不修正是 ${inc.uncorrected.toFixed(1)})`)
  }

  const reset: Track[] = [...resetValues.entries()].map(([path, r]) => ({ path, kind: 'value', discrete: r.discrete, times: [0], values: [r.value] }))
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
 * 加权网格的绑定姿势。Godot 的绑定是「每根骨骼一个矩阵、所有顶点共用」,与 Unity 的 SkinnedMeshRenderer 同构,
 * 所以只有当网格的各影响能被**同一组**逐骨骼矩阵解释时才精确。按 Unity 那边同样的顺序选:
 *
 * 1. setup 姿势下绑的(每个顶点各影响算出的位置一致):顶点 = 该位置,绑定 = 骨骼 rest。精确
 * 2. 否则从网格自己的数据里解:每根骨骼「局部坐标 → 图上的位置」各拟合一个仿射(图上的位置由 UV 给出,
 *    绑定时网格就是照着图摆的 —— MX2_cat 的「第二套」就是这种),再整体挪到 setup 附近(只为编辑器里好看)。
 *    拟合得上(残差 < 0.5 像素)就用它,精确
 * 3. 两样都不行 —— 绑完又在别的姿势下改过顶点,各顶点对应的不是同一个绑定姿势(wave 的 tiao、Female staff 的
 *    arm-RD2)。退回 1:setup 姿势精确,动起来各影响之间的不一致会露出来。**实测**所有动画关键帧上最多偏多少,报 approximated
 */
function bindWeighted(
  verts: Vertices,
  uv: readonly number[],
  restWorld: readonly Affine[],
  name: string,
  issues: IssueCollector,
  poses: () => readonly (readonly Affine[])[],
): { polygon: number[]; binds: Map<number, Affine>; inconsistent?: { uncorrected: number } } {
  const setupPositions: { x: number; y: number }[] = []
  let spread = 0
  verts.weights.forEach((entry) => {
    const ps = entry.map((w) => apply(restWorld[w.bone]!, w.x, -w.y))
    const mean = ps.reduce((acc, p, k) => ({ x: acc.x + p.x * entry[k]!.weight, y: acc.y + p.y * entry[k]!.weight }), { x: 0, y: 0 })
    for (const p of ps) spread = Math.max(spread, Math.hypot(p.x - mean.x, p.y - mean.y))
    setupPositions.push(mean)
  })
  // 顶点和骨骼都是 float32 存的,在 setup 下绑的网格也有 1e-3 像素级的舍入差
  const atSetup = { polygon: setupPositions.flatMap((p) => [p.x, p.y]), binds: new Map<number, Affine>() }
  if (spread < 0.05) return atSetup

  // 图上的位置(页像素,Y 朝下,与 Godot 同向)
  const image = verts.weights.map((_, i) => ({ x: uv[i * 2]!, y: uv[i * 2 + 1]! }))
  const byBone = new Map<number, { src: { x: number; y: number }[]; dst: { x: number; y: number }[] }>()
  verts.weights.forEach((entry, i) => {
    for (const w of entry) {
      const g = byBone.get(w.bone) ?? { src: [], dst: [] }
      byBone.set(w.bone, g)
      g.src.push({ x: w.x, y: -w.y })
      g.dst.push(image[i]!)
    }
  })
  // 图 → setup 附近:整体相似变换(纯为编辑器里好看)
  const place = fitSimilarity(image, setupPositions).fit
  const placeM = fitToAffine(place)
  const binds = new Map<number, Affine>()
  for (const [bone, g] of byBone) {
    // Spine 绑定时骨骼可以带缩放 / shear,「局部坐标 → 图上位置」一般是仿射;Godot 的 rest 是任意 Transform2D,
    // 所以按仿射拟合。点太少或共线解不出仿射时退回相似变换
    let m = fitAffine(g.src, g.dst)
    if (m === null) {
      const { fit, determined } = fitSimilarity(g.src, g.dst)
      m = determined ? fitToAffine(fit) : { a: 1, b: 0, c: 0, d: 1, x: g.dst[0]!.x - g.src[0]!.x, y: g.dst[0]!.y - g.src[0]!.y }
    }
    binds.set(bone, mul(placeM, m))
  }
  const fitted = { polygon: image.flatMap((p) => { const q = applyFit(place, p.x, p.y); return [q.x, q.y] }), binds }

  // 两种绑定各自在全部动画姿势上逐帧量**加权后**的实际偏差(和画面上看到的一致 —— 权重小的影响对不齐,
  // 对画面的贡献也小;只看逐影响残差会判得过严,把本来拟合得很好的网格推到更差的一档),取小的那个
  const driftOf = (c: { polygon: readonly number[]; binds: ReadonlyMap<number, Affine> }): number => {
    let worst = 0
    for (const W of poses()) {
      verts.weights.forEach((entry, i) => {
        let gx = 0, gy = 0, sx = 0, sy = 0
        for (const w of entry) {
          const bind = c.binds.get(w.bone) ?? restWorld[w.bone]!
          const g = apply(mul(W[w.bone]!, inverse(bind)), c.polygon[i * 2]!, c.polygon[i * 2 + 1]!)
          const sp = apply(W[w.bone]!, w.x, -w.y)
          gx += g.x * w.weight; gy += g.y * w.weight; sx += sp.x * w.weight; sy += sp.y * w.weight
        }
        worst = Math.max(worst, Math.hypot(gx - sx, gy - sy))
      })
    }
    return worst
  }
  const driftSetup = driftOf(atSetup)
  const driftFitted = driftOf(fitted)
  const chosen = driftFitted < driftSetup ? fitted : atSetup
  const worst = Math.min(driftSetup, driftFitted)
  const how = chosen === fitted ? '用辅助子骨骼表达它自己的绑定姿势' : '按 setup 绑定'
  if (worst <= 0.5) {
    if (chosen === fitted) issues.add('info', `mesh.${name}`, `绑定姿势不是 setup 姿势(各影响的位置最多差 ${spread.toFixed(1)} 像素),${how}`)
    return chosen
  }

  // 3. 两种都偏:绑完又在别的姿势下改过顶点。取偏得少的那种,每条动画逐帧加修正(bindCorrectionTracks);
  //    setup 姿势的顶点直接反解成精确值 —— Godot 的蒙皮对顶点是线性的,给定绑定就有唯一解
  const polygon: number[] = []
  verts.weights.forEach((entry) => {
    let m00 = 0, m01 = 0, m10 = 0, m11 = 0, rx = 0, ry = 0
    for (const w of entry) {
      const D = mul(restWorld[w.bone]!, inverse(chosen.binds.get(w.bone) ?? restWorld[w.bone]!))
      m00 += w.weight * D.a; m01 += w.weight * D.b; m10 += w.weight * D.c; m11 += w.weight * D.d
      const sp = apply(restWorld[w.bone]!, w.x, -w.y)
      rx += w.weight * (sp.x - D.x); ry += w.weight * (sp.y - D.y)
    }
    const det = m00 * m11 - m01 * m10
    polygon.push((m11 * rx - m01 * ry) / det, (-m10 * rx + m00 * ry) / det)
  })
  issues.add('info', `mesh.${name}`,
    `绑定姿势各顶点不一致(各影响最多差 ${spread.toFixed(1)} 像素),两种绑定都对不上 —— ${how},动画里逐帧加修正` +
    `(不修正的话误差达 ${worst.toFixed(1)} 像素)`)
  return { polygon, binds: chosen.binds, inconsistent: { uncorrected: worst } }
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
      if (layers.every((l) => l.layer[s] === s)) continue
      const steps = [{ t: 0, v: s as G.GodotValue }, ...layers.map((l) => ({ t: l.t, v: l.layer[s]! as G.GodotValue }))]
      for (const node of nodesOfSlot.get(s) ?? []) out.push(stepTrack(`${node.path}:z_index`, steps))
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

/** 某一时刻 slot 的颜色:各颜色时间轴按顺序套用(rgba 管四个通道,rgb 管三个,alpha 管一个) */
function slotColorAt(timelines: readonly Timeline[], setup: Rgba, time: number, is38: boolean): Rgba {
  const c = [...setup] as [number, number, number, number]
  for (const t of timelines) {
    const frames = t.frames
    if (frames.length === 0 || time < Number(frames[0]!['time'] ?? 0)) continue
    let i = frames.length - 1
    for (let k = 0; k < frames.length - 1; k++) if (time < Number(frames[k + 1]!['time'])) { i = k; break }
    const channel = (idx: number): number => {
      const get = (f: Record<string, unknown>) => {
        if (t.kind === 'color' || t.kind === 'twoColor') return unpackRgba((f['colors'] as number[])[0]!)[idx]!
        const bytes = f['color'] as number[]
        return bytes[idx]! / 255
      }
      if (i === frames.length - 1) return get(frames[i]!)
      // 借 valueBetween 的曲线求值:把这一通道临时放进一个字段
      const pair = [{ ...frames[i]!, v: get(frames[i]!) }, { ...frames[i + 1]!, v: get(frames[i + 1]!) }]
      return valueBetween(pair, 0, 'v', time, is38, idx)
    }
    if (t.kind === 'slotColor5') c[3] = channel(0)
    else if (t.kind === 'slotColor2' || t.kind === 'slotColor4') { c[0] = channel(0); c[1] = channel(1); c[2] = channel(2) }
    else { c[0] = channel(0); c[1] = channel(1); c[2] = channel(2); c[3] = channel(3) }
  }
  return c
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
      if (a.type !== 'mesh') continue
      const verts = a.data['vertices'] as Vertices
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
        if (time < keyTimes[0]!) return G.packedVector2(node.skinned === undefined ? node.polygon : polygonAt(new Array<number>(flatLength).fill(0), time))
        let i = frames.length - 1
        for (let k = 0; k < frames.length - 1; k++) if (time < keyTimes[k + 1]!) { i = k; break }
        const f0 = offsetsOf(frames[i]!)
        if (i === frames.length - 1) return G.packedVector2(polygonAt(f0, time))
        const f1 = offsetsOf(frames[i + 1]!)
        // deform 的曲线是 0..1 的进度(两版一致,见 bezier.ts)
        const p = valueBetween([{ ...frames[i]!, v: 0 }, { ...frames[i + 1]!, v: 1 }], 0, 'v', time, is38)
        return G.packedVector2(polygonAt(f0.map((x, j) => x + (f1[j]! - x) * p), time))
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
 * 反解 M(P)·δ = Δ:`M(P) = Σ wᵢ · lin(Bᵢ(P) · Bindᵢ⁻¹)`,Δ = Spine 的完整位置 − Godot 不加形变时的位置。
 * 绑定一致时 Δ 就是 Σ wᵢ Bᵢ dᵢ;绑定不一致(bindWeighted 第 3 档)时顺带把那部分误差也消掉。求解的那一刻精确。
 */
function skinnedPolygonAt(part: SkeletonPart, anim: AnimationData, node: AttachmentNode, flat: readonly number[], time: number): number[] {
  const s = node.skinned!
  const verts = node.attachment.data['vertices'] as Vertices
  const worlds = godotWorlds(part, localsAt(part, anim, time).map(godotLocal))
  const out: number[] = []
  let k = 0
  verts.weights.forEach((entry, i) => {
    let m00 = 0, m01 = 0, m10 = 0, m11 = 0, dx = 0, dy = 0
    const vx = node.polygon[i * 2]!, vy = node.polygon[i * 2 + 1]!
    for (const w of entry) {
      const Bi = worlds[w.bone]!
      const D = mul(Bi, inverse(s.binds[s.bones.indexOf(w.bone)]!))
      m00 += w.weight * D.a; m01 += w.weight * D.b; m10 += w.weight * D.c; m11 += w.weight * D.d
      // Spine 的局部坐标 + 偏移(Y 上)→ Godot 局部 (x, −y) → 世界
      const spine = apply(Bi, w.x + (flat[k] ?? 0), -(w.y + (flat[k + 1] ?? 0)))
      const base = apply(D, vx, vy)
      dx += w.weight * (spine.x - base.x)
      dy += w.weight * (spine.y - base.y)
      k += 2
    }
    const det = m00 * m11 - m01 * m10
    out.push(
      vx + (Math.abs(det) < 1e-12 ? 0 : (m11 * dx - m01 * dy) / det),
      vy + (Math.abs(det) < 1e-12 ? 0 : (-m10 * dx + m00 * dy) / det),
    )
  })
  return out
}

/**
 * 绑定不一致的蒙皮网格(bindWeighted 第 3 档)在没有 deform 的动画里也会偏 —— 按 SAMPLE_FPS 逐帧反解出
 * 修正量,打成 polygon 轨道。这条动画里偏不到 0.5 像素就不写。已有 polygon 轨道的(deform)那条自带修正。
 */
function bindCorrectionTracks(
  part: SkeletonPart,
  anim: AnimationData,
  timelines: readonly Timeline[],
  nodes: readonly AttachmentNode[],
  existing: ReadonlySet<string>,
  between: Map<string, number>,
): Track[] {
  const out: Track[] = []
  const kept = { ...anim, timelines: [...timelines] }
  for (const node of nodes) {
    if (node.skinned?.inconsistent === undefined || existing.has(`${node.path}:polygon`)) continue
    const times = sampleTimes(durationOf(anim), timelines.filter((t) => BONE_KINDS.has(t.kind)))
    const polygons = times.map((t) => skinnedPolygonAt(part, kept, node, [], t))
    let worst = 0
    for (const p of polygons) for (let i = 0; i < p.length; i += 2) worst = Math.max(worst, Math.hypot(p[i]! - node.polygon[i]!, p[i + 1]! - node.polygon[i + 1]!))
    if (worst < 0.5) continue
    // 采样帧之间 Godot 线性插值:拿中点的精确解和插值比。超过 0.5 像素就在中间插一帧,
    // 直到够了或者密到 1/480 秒(动得很快的部件 30 fps 不够,实测 female_lead 的 nvzhu_t_gb6 帧间差 8 像素)
    const midGap = (k: number): number => {
      const mid = (times[k]! + times[k + 1]!) / 2
      const exact = skinnedWorld(part, kept, node, skinnedPolygonAt(part, kept, node, [], mid), mid)
      const lerped = skinnedWorld(part, kept, node, polygons[k]!.map((v, j) => (v + polygons[k + 1]![j]!) / 2), mid)
      let g = 0
      for (let j = 0; j < exact.length; j += 2) g = Math.max(g, Math.hypot(exact[j]! - lerped[j]!, exact[j + 1]! - lerped[j + 1]!))
      return g
    }
    let gap = between.get(node.path) ?? 0
    for (let k = 0; k + 1 < times.length;) {
      const g = midGap(k)
      if (g > 0.5 && times[k + 1]! - times[k]! > 2 / 480) {
        const mid = (times[k]! + times[k + 1]!) / 2
        times.splice(k + 1, 0, mid)
        polygons.splice(k + 1, 0, skinnedPolygonAt(part, kept, node, [], mid))
        continue
      }
      gap = Math.max(gap, g)
      k++
    }
    between.set(node.path, gap)
    out.push({ path: `${node.path}:polygon`, kind: 'value', times, values: polygons.map((p) => G.packedVector2(p)) })
  }
  return out
}

/** 蒙皮网格在 time 时刻、polygon 取 poly 时,Godot 画出来的顶点(骨架空间) */
function skinnedWorld(part: SkeletonPart, anim: AnimationData, node: AttachmentNode, poly: readonly number[], time: number): number[] {
  const s = node.skinned!
  const worlds = godotWorlds(part, localsAt(part, anim, time).map(godotLocal))
  const ms = s.bones.map((b, k) => mul(worlds[b]!, inverse(s.binds[k]!)))
  const out: number[] = []
  s.weights.forEach((ws, i) => {
    let x = 0, y = 0
    for (const w of ws) {
      const p = apply(ms[w.index]!, poly[i * 2]!, poly[i * 2 + 1]!)
      x += p.x * w.weight
      y += p.y * w.weight
    }
    out.push(x, y)
  })
  return out
}
