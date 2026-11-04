import type { SkeletonPart } from '../../spine-format/binary/readSkeleton.ts'
import type { Attachment, Sequence, Vertices } from '../../spine-format/binary/readSkins.ts'
import type { AnimationData, Timeline } from '../../spine-format/binary/readAnimations.ts'
import type { Atlas, AtlasRegion } from '../../core/atlas.ts'
import { encodePng, type Image } from '../../unity/png.ts'
import { detectPremultiplied, unpremultiply } from '../unity/alpha.ts'
import { resolveLinkedMeshes } from '../unity/linkedMesh.ts'
import { fitAffine } from '../unity/mesh.ts'
import { toAbsoluteBezier } from '../../spine-format/bezier.ts'
import { describeTimeline, DUPLICATE_TIMELINE_MESSAGE, lastPerProperty } from '../../spine-format/duplicateTimelines.ts'
import { applyPoint, invert, setupLocals, setupPose, type Affine, type BoneLocal } from '../../spine-eval/pose.ts'
import { drawOrderOf, layerOfSlot, type DrawOrderOffset } from '../../spine-eval/drawOrder.ts'
import { sequenceCycle, sequenceFrameAt, sequenceRegionName, sequenceSteps, type SequenceKey } from '../../spine-eval/sequence.ts'
import { slotColorAt, unpackRgba, type Rgba } from '../../spine-eval/color.ts'
import { IssueCollector, type ConversionIssue } from '../types.ts'
import { cocosUuid, spriteFrameUuid } from '../../cocos/ids.ts'
import { animation, BLEND, PrefabDoc, sorting2D, sprite, uiTransform } from '../../cocos/json.ts'
import { CONSTANT, realKeys, type RealKey, type Segment } from '../../cocos/curve.ts'
import { clipJson, type PathStep, type Track } from '../../cocos/clip.ts'
import { animationClipMeta, AUTO_ATLAS_CONTENT, autoAtlasMeta, directoryMeta, imageMeta, prefabMeta } from '../../cocos/meta.ts'

/**
 * Spine(中转模型)→ Cocos Creator 3.8 的原生节点 + `cc.Animation` + `.anim`,零运行时脚本。
 *
 * 产物:`<名字>.prefab`、每条动画一个 `<名字>@<动画>.anim`、`images/` 里每个图集区域一张 PNG(+ 自动图集 `.pac`),
 * 各自带 `.meta`。拖进工程的 `assets/` 就能用:拖 prefab 进 Canvas,`playOnLoad` 播第一条动画。
 *
 * 坐标:Spine 的像素就是 Cocos UI 的单位,Y 朝上、角度逆时针为正,都和 Spine 一致,不用换算。
 *
 * 结构(和 Unity / Godot 导出同一个思路,见 docs/COCOS.md):
 * - 骨骼 → 普通节点,位移 / 旋转 / 缩放就是 Spine 的 setup 值。Cocos 没有斜切,shearX 折进旋转,shearY ≠ shearX 的报近似
 * - 每个 attachment 一个节点,挂在骨骼下:`cc.UITransform` + `cc.Sprite` + `cc.Sorting2D`。
 *   换图 = 节点 `active`;绘制顺序 = `sortingOrder`(slot 下标,挪过位的 slot 一条阶梯轨道);颜色 = Sprite 的 `color`;
 *   混合模式 = Sprite 自己的 src / dst 混合因子
 * - 图片部件精确;网格先按矩形 Sprite 画(报近似 / 损失),等 CPU 蒙皮的脚本组件做好再改走它(docs/COCOS.md 第 1 节)
 *
 * ⚠️ 挂在骨骼下的部件只能靠 `cc.Sorting2D` 按 Spine 的绘制顺序画(不然按层级顺序),工程要开 `sorting-2d` 功能。
 */

export interface CocosExportOptions {
  readonly name: string
  /** 初始皮肤;null / 不给 = 默认皮肤(默认皮肤空着就取第一套具名皮肤) */
  readonly skin?: string
  /** 跳过 PNG 编码(只验结构时省时间) */
  readonly skipImages?: boolean
}

export interface CocosFile {
  readonly path: string
  readonly content: string | Uint8Array
}

/** 一张写出的图(端到端测试拿它对 uuid → 像素) */
export interface CocosImage {
  readonly path: string
  readonly uuid: string
  readonly width: number
  readonly height: number
  readonly image: Image
}

export interface CocosExportResult {
  readonly files: CocosFile[]
  readonly issues: readonly ConversionIssue[]
  readonly images: ReadonlyMap<string, CocosImage>
  /** 每个画得出来的 attachment 对应的节点(端到端测试用) */
  readonly attachments: readonly AttachmentNode[]
}

const DEG = Math.PI / 180
/** 阶梯跳变前补的那个键离跳变多远(秒)。要大于引擎认「同一时刻」的 1e-6 */
const STEP_EPSILON = 1e-4
const SAMPLE_FPS = 30
/** 网格按矩形画,拟合残差超过这个就报近似 */
const MESH_TOLERANCE = 0.5

// ─── 名字 ────────────────────────────────────────────────────────────────────

/** 节点名:`/` 是 HierarchyPath 的分隔符,不能留 */
function nodeName(name: string): string {
  const s = name.replace(/[/\\]/g, '_').trim()
  return s.length > 0 ? s : '_'
}

/** 同一父节点下的名字去重 */
class Names {
  private readonly used = new Map<number, Set<string>>()
  claim(parent: number, wanted: string): string {
    const set = this.used.get(parent) ?? new Set<string>()
    this.used.set(parent, set)
    let name = nodeName(wanted)
    for (let n = 2; set.has(name); n++) name = `${nodeName(wanted)}_${n}`
    set.add(name)
    return name
  }
}

// ─── 颜色 / 混合 ─────────────────────────────────────────────────────────────

const to255 = (c: Rgba): [number, number, number, number] => [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255), Math.round(c[3] * 255)]
const mulColor = (p: Rgba, q: Rgba): Rgba => [p[0] * q[0], p[1] * q[1], p[2] * q[2], p[3] * q[3]]

/**
 * slot 的混合模式 → Sprite 的混合因子。贴图是直通 alpha 的,着色器输出 color × texture(不预乘):
 * - normal:   src·a + dst·(1 − a)
 * - additive: src·a + dst                       精确
 * - multiply: dst·src + dst·(1 − a) —— 要等于 Spine 的 dst·(src·a + 1 − a),贴图得是预乘的(src = rgb·a),
 *             所以 multiply / screen 的 slot 用一张预乘过的副本;slot 的 alpha 动画在它们上面只是近似(颜色里的 a 乘不到 rgb)
 * - screen:   src + dst·(1 − src)             同样要预乘的贴图
 */
const BLEND_OF_MODE: readonly { src: number; dst: number; pma: boolean; name: string }[] = [
  { src: BLEND.SRC_ALPHA, dst: BLEND.ONE_MINUS_SRC_ALPHA, pma: false, name: 'normal' },
  { src: BLEND.SRC_ALPHA, dst: BLEND.ONE, pma: false, name: 'additive' },
  { src: BLEND.DST_COLOR, dst: BLEND.ONE_MINUS_SRC_ALPHA, pma: true, name: 'multiply' },
  { src: BLEND.ONE, dst: BLEND.ONE_MINUS_SRC_COLOR, pma: true, name: 'screen' },
]

// ─── 图 ──────────────────────────────────────────────────────────────────────

/** 从图集页上把一个区域摆正着抠出来(旋转的映射与 bakeAtlas.blitUpright 相同) */
function regionImage(src: Image, region: AtlasRegion): Image {
  const { x: X, y: Y, width: w, height: h, rotate } = region
  const data = new Uint8Array(w * h * 4)
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const sx = rotate === 90 ? X + ty : X + tx
      const sy = rotate === 90 ? Y + w - 1 - tx : Y + ty
      const o = (ty * w + tx) * 4
      if (sx >= 0 && sy >= 0 && sx < src.width && sy < src.height) {
        const i = (sy * src.width + sx) * 4
        data[o] = src.data[i]!
        data[o + 1] = src.data[i + 1]!
        data[o + 2] = src.data[i + 2]!
        data[o + 3] = src.data[i + 3]!
      }
    }
  }
  return { width: w, height: h, data }
}

function cropImage(src: Image, x: number, y: number, w: number, h: number): Image {
  const data = new Uint8Array(w * h * 4)
  for (let ty = 0; ty < h; ty++) {
    const srcRow = (y + ty) * src.width + x
    data.set(src.data.subarray(srcRow * 4, (srcRow + w) * 4), ty * w * 4)
  }
  return { width: w, height: h, data }
}

function premultiply(src: Image): Image {
  const data = new Uint8Array(src.data)
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]! / 255
    data[i] = Math.round(data[i]! * a)
    data[i + 1] = Math.round(data[i + 1]! * a)
    data[i + 2] = Math.round(data[i + 2]! * a)
  }
  return { width: src.width, height: src.height, data }
}

interface Crop {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** 写出的图,按「区域 + 裁剪 + 预乘」去重;文件名由区域名来,撞了加序号 */
class Images {
  readonly entries = new Map<string, CocosImage>()
  private readonly files = new Set<string>()
  private readonly name: string
  private readonly pages: ReadonlyMap<string, Image>
  // ⚠️ 不能写成构造函数参数属性(`constructor(private name)`):CLI 用 node --experimental-strip-types 跑,它不认这种写法
  constructor(name: string, pages: ReadonlyMap<string, Image>) {
    this.name = name
    this.pages = pages
  }

  get(region: AtlasRegion, crop: Crop | null, pma: boolean): CocosImage | null {
    const page = this.pages.get(region.page)
    if (page === undefined) return null
    const key = `${region.name}${crop === null ? '' : `@${crop.x},${crop.y},${crop.width},${crop.height}`}${pma ? '@pma' : ''}`
    const hit = this.entries.get(key)
    if (hit !== undefined) return hit
    let image = regionImage(page, region)
    if (crop !== null) image = cropImage(image, crop.x, crop.y, crop.width, crop.height)
    if (pma) image = premultiply(image)
    let stem = region.name.replace(/[\\/:*?"<>|]/g, '_')
    if (crop !== null) stem += `@${crop.x}_${crop.y}`
    if (pma) stem += '@pma'
    let file = stem
    for (let n = 2; this.files.has(file.toLowerCase()); n++) file = `${stem}_${n}`
    this.files.add(file.toLowerCase())
    const entry: CocosImage = { path: `images/${file}.png`, uuid: cocosUuid(`${this.name}/image/${key}`), width: image.width, height: image.height, image }
    this.entries.set(key, entry)
    return entry
  }
}

// ─── 部件的摆法 ─────────────────────────────────────────────────────────────

/** 一个 Sprite 节点:节点变换 + UITransform 的大小 / 锚点,矩形 = [−ax·w, (1−ax)·w] × [−ay·h, (1−ay)·h] */
interface Placement {
  readonly x: number
  readonly y: number
  readonly rotation: number
  readonly scaleX: number
  readonly scaleY: number
  readonly width: number
  readonly height: number
  readonly anchorX: number
  readonly anchorY: number
}

/**
 * region attachment:Spine 画的是一个 `width × height`(再乘 scaleX/Y)的矩形,中心在 (x, y),绕 rotation 转;
 * 图集里存的是裁掉透明边的那一块(offsetX / offsetY 是裁剪矩形在原图里的左下角)。
 * 节点取 attachment 自己的变换,Sprite 画裁剪矩形:大小按 width / originalWidth 缩放,锚点把原图中心放回节点原点。
 */
function regionPlacement(a: Attachment, region: AtlasRegion): Placement {
  const d = a.data as Record<string, number>
  const kx = d['width']! / region.originalWidth
  const ky = d['height']! / region.originalHeight
  const width = region.width * kx
  const height = region.height * ky
  return {
    x: d['x']!, y: d['y']!, rotation: d['rotation']!, scaleX: d['scaleX']!, scaleY: d['scaleY']!,
    width, height,
    anchorX: (region.originalWidth / 2 - region.offsetX) / region.width,
    anchorY: (region.originalHeight / 2 - region.offsetY) / region.height,
  }
}

/**
 * 网格按矩形画:图上的点 →(最小二乘仿射)→ 骨骼局部,仿射拆成旋转 + 缩放给节点,斜切丢掉。
 * 只用到图的一部分的网格(共用一张图的 linkedmesh 常见)按 uv 包围盒裁图。
 * 返回残差(每个顶点按这个矩形画出来的位置和 Spine 的差,取最大)—— 脚本组件做好之前,网格就先这样
 */
function meshPlacement(local: readonly { x: number; y: number }[], uvs: readonly number[], region: AtlasRegion): { placement: Placement; crop: Crop | null; residual: number } {
  const n = local.length
  // uv(相对未裁剪原图,左上原点)→ 裁剪区域里的像素坐标(左上原点)
  const px = (i: number) => uvs[i * 2]! * region.originalWidth - region.offsetX
  const py = (i: number) => uvs[i * 2 + 1]! * region.originalHeight - (region.originalHeight - region.offsetY - region.height)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, px(i)); maxX = Math.max(maxX, px(i))
    minY = Math.min(minY, py(i)); maxY = Math.max(maxY, py(i))
  }
  const cx = Math.max(0, Math.floor(minX - 1e-6))
  const cy = Math.max(0, Math.floor(minY - 1e-6))
  const cw = Math.min(region.width, Math.ceil(maxX + 1e-6)) - cx
  const ch = Math.min(region.height, Math.ceil(maxY + 1e-6)) - cy
  const full = cx === 0 && cy === 0 && cw === region.width && ch === region.height
  const crop: Crop | null = full || cw <= 0 || ch <= 0 ? null : { x: cx, y: cy, width: cw, height: ch }
  const w = crop?.width ?? region.width
  const h = crop?.height ?? region.height
  const ox = crop?.x ?? 0
  const oy = crop?.y ?? 0
  // 图的局部坐标:左下原点、Y 朝上 —— 锚点 (0,0) 的 Sprite 矩形就是 [0,w]×[0,h]
  const src = local.map((_, i) => ({ x: px(i) - ox, y: oy + h - py(i) }))
  const M = fitAffine(src, local)
  let placement: Placement
  if (M === null) {
    // 退化(顶点太少 / 共线):不转不缩,对上重心
    let dx = 0, dy = 0
    for (let i = 0; i < n; i++) { dx += (local[i]!.x - src[i]!.x) / n; dy += (local[i]!.y - src[i]!.y) / n }
    placement = { x: dx, y: dy, rotation: 0, scaleX: 1, scaleY: 1, width: w, height: h, anchorX: 0, anchorY: 0 }
  } else {
    const scaleX = Math.hypot(M.a, M.c)
    const rotation = Math.atan2(M.c, M.a) / DEG
    const scaleY = (M.a * M.d - M.b * M.c) / scaleX
    placement = { x: M.x, y: M.y, rotation, scaleX, scaleY, width: w, height: h, anchorX: 0, anchorY: 0 }
  }
  const cos = Math.cos(DEG * placement.rotation)
  const sin = Math.sin(DEG * placement.rotation)
  let residual = 0
  for (let i = 0; i < n; i++) {
    const sx = src[i]!.x * placement.scaleX
    const sy = src[i]!.y * placement.scaleY
    const x = cos * sx - sin * sy + placement.x
    const y = sin * sx + cos * sy + placement.y
    residual = Math.max(residual, Math.hypot(x - local[i]!.x, y - local[i]!.y))
  }
  return { placement, crop, residual }
}

/** 加权网格的顶点换到某一根骨骼的局部坐标(setup 姿势下) */
function verticesInBone(verts: Vertices, bone: number, setup: readonly Affine[]): { x: number; y: number }[] {
  const inv = invert(setup[bone]!)
  return verts.weights.map((entry) => {
    const own = entry.find((w) => w.bone === bone)
    if (own !== undefined && entry.length === 1) return { x: own.x, y: own.y }
    let x = 0, y = 0
    for (const w of entry) {
      const p = applyPoint(setup[w.bone]!, w.x, w.y)
      x += p.x * w.weight
      y += p.y * w.weight
    }
    return inv === null ? { x, y } : applyPoint(inv, x, y)
  })
}

/** 加权网格挂在哪根骨骼上:权重加起来最大的那根 */
function dominantBone(verts: Vertices): number {
  const total = new Map<number, number>()
  for (const entry of verts.weights) for (const w of entry) total.set(w.bone, (total.get(w.bone) ?? 0) + w.weight)
  let best = -1, bestWeight = -1
  for (const [bone, weight] of total) if (weight > bestWeight) { best = bone; bestWeight = weight }
  return best
}

function regionNameOf(a: Attachment): string {
  const path = a.data['path']
  return typeof path === 'string' && path.length > 0 ? path : a.name
}

// ─── 轨道 ───────────────────────────────────────────────────────────────────

/**
 * Spine 一个分量的关键帧 → Cocos 关键帧。`map` 必须是仿射(`slope · raw + offset`):贝塞尔控制点的值走同一个变换。
 * 第一帧之前 Spine 用 setup 值,Cocos 保持第一帧的值 —— 第一帧不在 0 时在 0 补一个 setup 值的阶梯键
 */
function floatKeys(frames: readonly Record<string, unknown>[], field: string, component: number, is38: boolean, map: { slope: number; offset: number }, setupRaw: number): RealKey[] {
  const T = (raw: number) => map.slope * raw + map.offset
  const times = frames.map((f) => Number(f['time'] ?? 0))
  const raws = frames.map((f) => Number(f[field]))
  const segments: (Segment | undefined)[] = frames.map((f, i) => {
    if (i + 1 >= frames.length) return undefined
    const curve = f['curve']
    if (curve === 'stepped') return { curve: 'stepped' }
    if (curve !== 'bezier') return { curve: 'linear' }
    const all = f['beziers'] as number[][]
    const raw = all[Math.min(component, all.length - 1)]!
    const b = is38 ? toAbsoluteBezier(raw, times[i]!, raws[i]!, times[i + 1]!, raws[i + 1]!) : raw
    return { curve: 'bezier', c: [b[0]!, T(b[1]!), b[2]!, T(b[3]!)] }
  })
  const keyTimes: number[] = []
  const values: number[] = []
  const segs: (Segment | undefined)[] = []
  if (times.length > 0 && times[0]! > 0) {
    keyTimes.push(0)
    values.push(T(setupRaw))
    segs.push({ curve: 'stepped' })
  }
  times.forEach((t, i) => {
    // 同一时刻(引擎按 1e-6 认)的键只留最后一个
    if (keyTimes.length > 0 && Math.abs(keyTimes[keyTimes.length - 1]! - t) < 1e-6) {
      values[values.length - 1] = T(raws[i]!)
      segs[segs.length - 1] = segments[i]
      return
    }
    keyTimes.push(t)
    values.push(T(raws[i]!))
    segs.push(segments[i])
  })
  return realKeys(keyTimes, values, segs)
}

/** 离散的数值(sortingOrder):阶梯键,相邻相同的合并、同一时刻只留最后一步 */
function stepKeys(steps: readonly { t: number; v: number }[]): RealKey[] {
  const merged: { t: number; v: number }[] = []
  for (const s of steps) {
    const last = merged[merged.length - 1]
    if (last !== undefined && Math.abs(last.t - s.t) < 1e-6) last.v = s.v
    else if (last === undefined || last.v !== s.v) merged.push({ ...s })
  }
  return merged.map((s) => ({ time: s.t, value: s.v, mode: CONSTANT, leftTangent: 0, leftWeight: 0, rightTangent: 0, rightWeight: 0, weightMode: 0 }))
}

function objectSteps(steps: readonly { t: number; v: unknown }[]): { times: number[]; values: unknown[] } {
  const merged: { t: number; v: unknown }[] = []
  for (const s of steps) {
    const last = merged[merged.length - 1]
    if (last !== undefined && Math.abs(last.t - s.t) < 1e-6) last.v = s.v
    else if (last === undefined || last.v !== s.v) merged.push({ ...s })
  }
  return { times: merged.map((s) => s.t), values: merged.map((s) => s.v) }
}

/** 线性键(采样来的) */
const linearKeys = (times: readonly number[], values: readonly number[]): RealKey[] => realKeys(times, values, times.map(() => undefined))

function durationOf(anim: AnimationData): number {
  let end = 0
  for (const t of anim.timelines) {
    const frames = t.kind === 'deform' || t.kind === 'sequence' ? (t.frames[0] as { frames: Record<string, unknown>[] }).frames : t.frames
    for (const f of frames) end = Math.max(end, Number(f['time'] ?? 0))
  }
  return end
}

/**
 * 排序去重。⚠️ 引擎的关键帧查找差 1e-6 以内算同一时刻(binarySearchEpsilon):关键帧 1.1666667 和采样网格的 1.166667
 * 在 double 里是两个数,写进曲线就是同一时刻的两个键 —— 靠得太近的只留前一个
 */
function distinctTimes(times: Iterable<number>): number[] {
  const sorted = [...times].sort((a, b) => a - b)
  const out: number[] = []
  for (const t of sorted) if (out.length === 0 || t - out[out.length - 1]! > 2e-6) out.push(t)
  return out
}

/** 关键帧时刻,阶梯段在下一帧之前补一个时刻 —— 线性插值的键靠它变成阶梯 */
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
  return distinctTimes(set)
}

/** 关键帧时刻 + 按 SAMPLE_FPS 均匀采样 */
function sampleTimes(end: number, timelines: readonly Timeline[]): number[] {
  const set = new Set<number>(keyTimesWithSteps(timelines))
  for (let i = 0; i * (1 / SAMPLE_FPS) < end; i++) set.add(Number((i / SAMPLE_FPS).toFixed(6)))
  set.add(end)
  return distinctTimes(set)
}

const BONE_KINDS = new Set(['rotate', 'translate', 'translateX', 'translateY', 'scale', 'scaleX', 'scaleY', 'shear', 'shearX', 'shearY'])

/**
 * 骨骼节点在 Cocos 里的旋转。Cocos 的节点没有斜切,shear 一律忽略(和 Unity 导出一致,报近似)——
 * 端到端测试按同样忽略 shear 的 Spine 求值(`unityCompatible`)比,别的地方都要精确
 */
function cocosRotation(l: BoneLocal): number {
  return l.rotation
}

// ─── 导出 ───────────────────────────────────────────────────────────────────

export interface AttachmentNode {
  readonly slot: number
  readonly skin: string
  readonly key: string
  readonly attachment: Attachment
  readonly frame?: { readonly index: number; readonly sequence: Sequence }
  /** 从 prefab 根算起的节点路径(HierarchyPath 用) */
  readonly path: string
  /** 节点颜色里 attachment 自己那一份(slot 颜色动画要乘它) */
  readonly ownColor: Rgba
  /** 网格:图裁掉的那一块(左上原点);region 和整张图的网格为 null */
  readonly crop: Crop | null
  /** 网格按矩形画的拟合残差(像素);region 为 0 */
  readonly residual: number
  /** 加权网格(两根以上骨骼):按这根骨骼画的 */
  readonly weightedOn: number | null
  /** linkedmesh:deform 时间轴打在父网格上(皮肤 + 键名),这个节点跟着父网格变形 */
  readonly deformSource: { readonly skin: string; readonly key: string } | null
}

function setupVisible(slot: { attachmentName: string | null }, node: { key: string; frame?: { index: number; sequence: Sequence } }): boolean {
  if (slot.attachmentName !== node.key) return false
  return node.frame === undefined || node.frame.index === sequenceFrameAt(undefined, node.frame.sequence, 0)
}

export function exportToCocos(input: SkeletonPart, atlas: Atlas, sources: ReadonlyMap<string, Image>, options: CocosExportOptions): CocosExportResult {
  const issues = new IssueCollector()
  const { part, timelineParents } = resolveLinkedMeshes(input, issues)
  const is38 = part.header.major === '3.8'
  const name = options.name
  const doc = new PrefabDoc(name)
  const names = new Names()
  const root = doc.node({ name, parent: null })
  uiTransform(doc, root, 0, 0, 0.5, 0.5)

  // ── 骨骼 ──
  const locals = setupLocals(part.bones)
  const setup = setupPose(part)
  const boneNode: number[] = []
  part.bones.forEach((bone, i) => {
    const parent = bone.parent < 0 ? root : boneNode[bone.parent]!
    const l = locals[i]!
    boneNode[i] = doc.node({ name: names.claim(parent, bone.name), parent, x: l.x, y: l.y, rotation: cocosRotation(l), scaleX: l.scaleX, scaleY: l.scaleY })
    if (bone.transformMode !== 0) issues.add('approximated', `bone.${bone.name}`, 'Cocos 的节点只有完整继承,Spine 的非默认继承模式(不继承旋转 / 缩放等)无法表达,按完整继承处理')
    if (Math.abs(l.shearX) > 1e-6 || Math.abs(l.shearY) > 1e-6) {
      issues.add('approximated', `bone.${bone.name}`, `Cocos 的节点没有斜切(setup 是 ${l.shearX.toFixed(1)}° / ${l.shearY.toFixed(1)}°),已忽略 —— 挂在它下面的部件会歪`)
    }
  })

  // ── 图集页:Spine 的图集默认预乘 alpha,Cocos 的 sprite 材质按直通 alpha 混合 ──
  const pages = new Map<string, Image>()
  for (const page of atlas.pages) {
    const src = sources.get(page.name)
    if (src === undefined) {
      issues.loss(`atlas.${page.name}`, `图集页 "${page.name}" 缺失,用到它的部件不会显示`)
      continue
    }
    const premultiplied = page.pma || detectPremultiplied(src)
    pages.set(page.name, premultiplied ? unpremultiply(src) : src)
    if (premultiplied) issues.add('info', `atlas.${page.name}`, '图集是预乘 alpha 的,已还原成直通 alpha(Cocos 的 sprite 材质按直通混合)')
  }
  const images = new Images(name, pages)

  // ── 皮肤:所有皮肤的 attachment 都建节点,显隐拆成两个开关(与 Unity / Godot 导出同一个思路) ──
  //   attachment 节点的 active —— 换图(动画轨道驱动)
  //   外面包一层节点的 active —— 皮肤(初始皮肤决定,切皮肤 = 改这些包装节点)
  // 只有和皮肤有关的节点才包:具名皮肤里的,以及默认皮肤里会被某套具名皮肤同 slot 同键名盖住的
  const defaultSkin = part.skins[0]
  const keysOfSkin = new Map<string, Set<string>>()
  for (const s of part.skins) keysOfSkin.set(s.name, new Set(s.slots.flatMap((e) => e.attachments.map((a) => `${e.slot}/${a.key}`))))
  const named = part.skins.filter((s) => s !== defaultSkin && s.slots.length > 0)
  const overridden = new Set(named.flatMap((s) => [...keysOfSkin.get(s.name)!]))
  const skinNames = part.skins.map((s) => s.name)
  if (options.skin !== undefined && !skinNames.includes(options.skin)) throw new Error(`没有皮肤 "${options.skin}",这个骨架有:${skinNames.join('、')}`)
  const initialSkin = options.skin ?? ((defaultSkin?.slots.length ?? 0) > 0 || named.length === 0 ? defaultSkin?.name : named[0]!.name)
  const shownInSkin = (node: { skin: string; slot: number; key: string }, skin: string | undefined): boolean => {
    if (node.skin === skin) return true
    if (node.skin !== defaultSkin?.name) return false
    return skin === undefined || !keysOfSkin.get(skin)!.has(`${node.slot}/${node.key}`)
  }

  const attachmentNodes: AttachmentNode[] = []
  const nodesOfSlot = new Map<number, AttachmentNode[]>()
  const wrapperCount = { n: 0 }
  const meshesReported = new Set<string>()

  const emit = (skin: (typeof part.skins)[number], slotIndex: number, a: Attachment, frame?: { index: number; sequence: Sequence }) => {
    const slot = part.slots[slotIndex]!
    const regionName = frame === undefined ? regionNameOf(a) : sequenceRegionName(regionNameOf(a), frame.sequence, frame.index)
    const region = atlas.regions.get(regionName)
    if (region === undefined) {
      issues.loss(`region.${regionName}`, `图集里没有 "${regionName}",这个部件不会显示`)
      return
    }
    const blend = BLEND_OF_MODE[slot.blendMode]
    if (blend === undefined) {
      issues.loss(`slot.${slot.name}`, `不认识的混合模式 ${slot.blendMode},按 normal 画`)
    }
    const b = blend ?? BLEND_OF_MODE[0]!
    const ownColor = unpackRgba(a.data['color'] as number)
    const slotColor = unpackRgba(slot.color)
    let base = a.key === slot.name ? slot.name : `${slot.name}__${a.key}`
    if (frame !== undefined) base += ` #${frame.sequence.start + frame.index}`

    let placement: Placement
    let crop: Crop | null = null
    let bone = slot.bone
    let residual = 0
    let weightedOn: number | null = null
    if (a.type === 'region') {
      placement = regionPlacement(a, region)
    } else {
      const count = a.data['vertexCount'] as number
      const uvs = a.data['uvs'] as number[]
      const verts = a.data['vertices'] as Vertices
      let local: { x: number; y: number }[]
      if (!verts.weighted) {
        local = []
        for (let i = 0; i < count; i++) local.push({ x: verts.positions[i * 2]!, y: verts.positions[i * 2 + 1]! })
      } else {
        bone = dominantBone(verts)
        local = verticesInBone(verts, bone, setup)
        const bones = new Set(verts.weights.flatMap((e) => e.map((w) => w.bone)))
        if (bones.size > 1) {
          weightedOn = bone
          if (!meshesReported.has(`w/${a.name}`)) {
            meshesReported.add(`w/${a.name}`)
            issues.loss(`mesh.${a.name}`, `加权网格(${bones.size} 根骨骼)还没转:按挂在 "${part.bones[bone]!.name}" 上的矩形画,不随别的骨骼变形 —— CPU 蒙皮的脚本组件做好后改走它`)
          }
        }
      }
      const fit = meshPlacement(local, uvs, region)
      placement = fit.placement
      crop = fit.crop
      residual = fit.residual
      if (!meshesReported.has(a.name) && weightedOn === null) {
        meshesReported.add(a.name)
        issues.add(fit.residual > MESH_TOLERANCE ? 'approximated' : 'info', `mesh.${a.name}`,
          `网格按矩形 Sprite 画(图上的点按最小二乘仿射摆到顶点上,斜切丢掉),顶点最多差 ${fit.residual.toFixed(1)} 像素 —— 脚本组件做好后改走它`)
      }
    }
    const image = images.get(region, crop, b.pma)
    if (image === null) return

    const common = { slot: slotIndex, skin: skin.name, key: a.key, attachment: a, ownColor, ...(frame === undefined ? {} : { frame }) }
    let parent = boneNode[bone]!
    const skinDependent = named.length > 0 && (skin !== defaultSkin || overridden.has(`${slotIndex}/${a.key}`))
    if (skinDependent) {
      parent = doc.node({ name: names.claim(parent, `${base} (${skin.name})`), parent, active: shownInSkin(common, initialSkin) })
      wrapperCount.n++
    }
    const node = doc.node({
      name: names.claim(parent, base), parent,
      x: placement.x, y: placement.y, rotation: placement.rotation, scaleX: placement.scaleX, scaleY: placement.scaleY,
      active: setupVisible(slot, common),
    })
    uiTransform(doc, node, placement.width, placement.height, placement.anchorX, placement.anchorY)
    sprite(doc, node, { spriteFrame: spriteFrameUuid(image.uuid), color: to255(mulColor(slotColor, ownColor)), srcBlend: b.src, dstBlend: b.dst })
    sorting2D(doc, node, slotIndex)
    const info: AttachmentNode = { ...common, path: doc.pathOf(node), crop, residual, weightedOn, deformSource: timelineParents.get(a) ?? null }
    attachmentNodes.push(info)
    nodesOfSlot.set(slotIndex, [...(nodesOfSlot.get(slotIndex) ?? []), info])
  }

  const clippingSeen = new Set<string>()
  for (const skin of part.skins) {
    for (const entry of skin.slots) {
      for (const a of entry.attachments) {
        if (a.type === 'clipping') {
          if (!clippingSeen.has(a.name)) {
            clippingSeen.add(a.name)
            issues.loss(`clipping.${a.name}`, 'clipping 遮罩还没转(等脚本组件一起做),被遮的部件按整张画')
          }
          continue
        }
        if (a.type !== 'region' && a.type !== 'mesh') {
          if (a.type !== 'boundingbox' && a.type !== 'point' && a.type !== 'path') issues.loss(`attachment.${a.name}`, `不支持的 attachment 类型 ${a.type}`)
          continue
        }
        if (a.sequence !== null) {
          for (let i = 0; i < a.sequence.count; i++) emit(skin, entry.slot, a, { index: i, sequence: a.sequence })
        } else emit(skin, entry.slot, a)
      }
    }
  }
  part.slots.forEach((slot, i) => {
    if (slot.darkColor !== -1) issues.loss(`slot.${slot.name}`, '两色染色(dark color)在 Cocos 里没有对应物,只保留亮色')
    const b = BLEND_OF_MODE[slot.blendMode]
    if (b !== undefined && b.pma && nodesOfSlot.has(i)) {
      issues.add('info', `slot.${slot.name}`, `${b.name} 混合:贴图用预乘 alpha 的副本 + 混合因子,与 Spine 相同;这个 slot 上的 alpha 动画只是近似(淡出时暗部不跟着减)`)
    }
  })
  if (named.length > 0) {
    issues.add('info', 'skin', `${part.skins.length} 套皮肤全部导进一个 prefab,初始是 "${initialSkin}";切皮肤 = 把名字带 "(皮肤名)" 的包装节点 active 切一下(${wrapperCount.n} 个)`)
  }

  // ── 约束 ──
  for (const c of part.ik) issues.loss(`ik.${c.name}`, 'IK 约束没有转(没有求解器),受约束的骨骼停在自己的关键帧上')
  for (const c of part.transform) issues.loss(`transform.${c.name}`, 'transform 约束在 Cocos 里没有对应物')
  for (const c of part.path) issues.loss(`path.${c.name}`, 'path 约束在 Cocos 里没有对应物')

  // ── 动画 ──
  const files: CocosFile[] = []
  const clipUuids: string[] = []
  const bonePath = boneNode.map((n) => doc.pathOf(n))
  const deformReported = new Set<string>()
  for (const anim of part.animations) {
    const tracks: Track[] = []
    const { kept, dropped } = lastPerProperty(anim.timelines)
    issues.scoped(anim.name, () => {
      for (const d of dropped) if (!d.identical) issues.add('approximated', describeTimeline(part, d.timeline), DUPLICATE_TIMELINE_MESSAGE)
      tracks.push(...boneTracks(part, kept, bonePath, locals, is38, issues))
      tracks.push(...slotTracks(part, anim, kept, nodesOfSlot, is38, issues))
      for (const t of kept) {
        if (t.kind === 'deform') {
          const owner = (t.frames[0] as { attachment: string }).attachment
          if (!deformReported.has(owner)) {
            deformReported.add(owner)
            issues.loss(`deform.${owner}`, 'deform 顶点动画还没转(等脚本组件),网格按不变形画')
          }
        }
      }
      if (kept.some((t) => t.kind === 'event')) issues.loss('events', 'Spine 事件没有转(Cocos 的动画事件要有脚本里的方法接)')
    })
    const uuid = cocosUuid(`${name}/anim/${anim.name}`)
    clipUuids.push(uuid)
    // 剪辑在 Cocos 里的名字是文件名(资源库按文件名起,`_name` 不算数,实测):文件就叫动画名,`play('idle')` 才对得上。
    // 每个骨架一个目录,同名动画不会撞
    const file = `${anim.name.replace(/[\\/:*?"<>|]/g, '_')}.anim`
    files.push({ path: file, content: clipJson({ name: anim.name, duration: Math.max(durationOf(anim), 1 / 60), loop: true, tracks }) })
    files.push({ path: `${file}.meta`, content: animationClipMeta(uuid, anim.name) })
  }
  animation(doc, root, clipUuids, clipUuids[0] ?? null, clipUuids.length > 0)

  // ── 文件 ──
  const prefabUuid = cocosUuid(`${name}/prefab`)
  files.push({ path: `${name}.prefab`, content: doc.text() })
  files.push({ path: `${name}.prefab.meta`, content: prefabMeta(prefabUuid, name) })
  if (images.entries.size > 0) {
    files.push({ path: 'images.meta', content: directoryMeta(cocosUuid(`${name}/images`)) })
    files.push({ path: 'images/AutoAtlas.pac', content: AUTO_ATLAS_CONTENT })
    files.push({ path: 'images/AutoAtlas.pac.meta', content: autoAtlasMeta(cocosUuid(`${name}/images/AutoAtlas`), 2048) })
  }
  for (const img of images.entries.values()) {
    if (options.skipImages !== true) files.push({ path: img.path, content: encodePng(img.image) })
    files.push({ path: `${img.path}.meta`, content: imageMeta(img.uuid, img.path.replace(/^images\//, '').replace(/\.png$/, ''), img.width, img.height) })
  }
  return { files, issues: issues.all, images: images.entries, attachments: attachmentNodes }
}

/** 网格顶点在图上的位置 → 节点局部坐标(锚点 (0,0) 的矩形,左下原点、Y 朝上)—— 端到端测试按它算「这个顶点该画在哪」 */
export function meshVertexLocal(node: AttachmentNode, region: AtlasRegion, u: number, v: number): { x: number; y: number } {
  const px = u * region.originalWidth - region.offsetX
  const py = v * region.originalHeight - (region.originalHeight - region.offsetY - region.height)
  const ox = node.crop?.x ?? 0
  const oy = node.crop?.y ?? 0
  const h = node.crop?.height ?? region.height
  return { x: px - ox, y: oy + h - py }
}

// ─── 各类时间轴 ──────────────────────────────────────────────────────────────

function boneTracks(part: SkeletonPart, timelines: readonly Timeline[], bonePath: readonly string[], locals: readonly BoneLocal[], is38: boolean, issues: IssueCollector): Track[] {
  const out: Track[] = []
  const sheared = new Set<number>()
  for (const t of timelines) if (t.kind.startsWith('shear')) sheared.add(t.owner)

  /** 同一根骨骼的 position / scale 两个分量可能来自两条时间轴(translateX + translateY),先攒起来再写轨道 */
  const vector = new Map<string, { path: readonly PathStep[]; components: 2 | 3; channels: (RealKey[] | null)[] }>()
  const put = (bone: number, property: 'position' | 'scale' | 'eulerAngles', component: number, keys: RealKey[]) => {
    const id = `${bone}/${property}`
    let v = vector.get(id)
    if (v === undefined) {
      v = { path: [{ node: bonePath[bone]! }, property], components: property === 'scale' ? 3 : 3, channels: [null, null, null, null] }
      vector.set(id, v)
    }
    v.channels[component] = keys
  }

  for (const t of timelines) {
    if (!BONE_KINDS.has(t.kind)) continue
    const bone = part.bones[t.owner]
    if (bone === undefined) continue
    const l = locals[t.owner]!
    const f = t.frames
    switch (t.kind) {
      case 'rotate':
        put(t.owner, 'eulerAngles', 2, floatKeys(f, 'value', 0, is38, { slope: 1, offset: cocosRotation(l) }, 0))
        break
      case 'translate':
        put(t.owner, 'position', 0, floatKeys(f, 'x', 0, is38, { slope: 1, offset: l.x }, 0))
        put(t.owner, 'position', 1, floatKeys(f, 'y', 1, is38, { slope: 1, offset: l.y }, 0))
        break
      case 'translateX':
        put(t.owner, 'position', 0, floatKeys(f, 'value', 0, is38, { slope: 1, offset: l.x }, 0))
        break
      case 'translateY':
        put(t.owner, 'position', 1, floatKeys(f, 'value', 0, is38, { slope: 1, offset: l.y }, 0))
        break
      case 'scale':
        put(t.owner, 'scale', 0, floatKeys(f, 'x', 0, is38, { slope: l.scaleX, offset: 0 }, 1))
        put(t.owner, 'scale', 1, floatKeys(f, 'y', 1, is38, { slope: l.scaleY, offset: 0 }, 1))
        break
      case 'scaleX':
        put(t.owner, 'scale', 0, floatKeys(f, 'value', 0, is38, { slope: l.scaleX, offset: 0 }, 1))
        break
      case 'scaleY':
        put(t.owner, 'scale', 1, floatKeys(f, 'value', 0, is38, { slope: l.scaleY, offset: 0 }, 1))
        break
    }
  }

  // shear 动画:Cocos 没有斜切,整条忽略(setup 的 shear 也忽略了,两边一致)
  for (const b of sheared) issues.add('approximated', `shear[${part.bones[b]!.name}]`, 'Cocos 的节点没有斜切,shear 动画已忽略 —— 挂在它下面的部件会歪')
  for (const v of vector.values()) out.push({ kind: 'vector', path: v.path, components: v.components, channels: v.channels })
  return out
}

function slotTracks(part: SkeletonPart, anim: AnimationData, timelines: readonly Timeline[], nodesOfSlot: ReadonlyMap<number, readonly AttachmentNode[]>, is38: boolean, issues: IssueCollector): Track[] {
  const out: Track[] = []
  const activeTrack = (node: AttachmentNode, steps: readonly { t: number; v: boolean }[]): Track => {
    const s = objectSteps(steps)
    return { kind: 'object', path: [{ node: node.path }, 'active'], times: s.times, values: s.values }
  }

  // 换图:该 slot 的每个挂图节点一条 active 阶梯轨道(序列帧节点另算,见下)
  for (const t of timelines) {
    if (t.kind !== 'attachment') continue
    const slot = part.slots[t.owner]
    const list = nodesOfSlot.get(t.owner)
    if (slot === undefined || list === undefined) continue
    for (const node of list) {
      if (node.frame !== undefined) continue
      const steps: { t: number; v: boolean }[] = [{ t: 0, v: slot.attachmentName === node.key }]
      for (const f of t.frames) steps.push({ t: Number(f['time'] ?? 0), v: f['name'] === node.key })
      out.push(activeTrack(node, steps))
    }
  }

  // 序列帧:亮 =「换图时间轴说这个键名亮着」且「sequence 时间轴说现在是这一帧」
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
        out.push(activeTrack(node, changes.map((t) => ({ t, v: at(visSteps, t) && at(frameSteps, t) === node.frame!.index }))))
      }
    }
  }

  // slot 颜色:同一个 slot 可以有 rgb + alpha 两条时间轴,统一求值后每个节点一条 ColorTrack(乘上 attachment 自己的颜色)
  const colorTimelines = new Map<number, Timeline[]>()
  for (const t of timelines) {
    if (t.kind === 'color' || t.kind === 'twoColor' || t.kind.startsWith('slotColor')) {
      colorTimelines.set(t.owner, [...(colorTimelines.get(t.owner) ?? []), t])
      if (t.kind === 'twoColor' || t.kind === 'slotColor3' || t.kind === 'slotColor4') issues.loss(`color[${part.slots[t.owner]?.name}]`, '两色染色的暗色部分没有对应物,只保留亮色')
    }
  }
  for (const [slotIndex, list] of colorTimelines) {
    const slot = part.slots[slotIndex]
    const nodes = nodesOfSlot.get(slotIndex)
    if (slot === undefined || nodes === undefined) continue
    const setupColor = unpackRgba(slot.color)
    const curved = list.some((t) => t.frames.some((f) => f['curve'] === 'bezier'))
    const times = curved ? sampleTimes(durationOf(anim), list) : keyTimesWithSteps(list)
    const colors = times.map((time) => slotColorAt(list, setupColor, time, is38))
    if (curved) issues.add('approximated', `color[${slot.name}]`, `颜色曲线按 ${SAMPLE_FPS} fps 采样成线性关键帧`)
    for (const node of nodes) {
      const channels = [0, 1, 2, 3].map((k) => linearKeys(times, colors.map((c) => to255(mulColor(c, node.ownColor))[k]!)))
      out.push({ kind: 'color', path: [{ node: node.path }, { component: 'cc.Sprite' }, 'color'], channels })
    }
  }

  // 逐帧绘制顺序:挪过位的 slot,其挂图节点一条 sortingOrder 阶梯轨道
  const drawOrder = timelines.find((t) => t.kind === 'drawOrder')
  if (drawOrder !== undefined) {
    const layers = drawOrder.frames.map((f) => ({
      t: Number(f['time'] ?? 0),
      layer: layerOfSlot(drawOrderOf(part.slots.length, (f['offsets'] as DrawOrderOffset[] | undefined) ?? [])),
    }))
    for (let s = 0; s < part.slots.length; s++) {
      if (layers.every((l) => l.layer[s] === s)) continue
      const keys = stepKeys([{ t: 0, v: s }, ...layers.map((l) => ({ t: l.t, v: l.layer[s]! }))])
      for (const node of nodesOfSlot.get(s) ?? []) out.push({ kind: 'real', path: [{ node: node.path }, { component: 'cc.Sorting2D' }, 'sortingOrder'], keys })
    }
  }
  return out
}
