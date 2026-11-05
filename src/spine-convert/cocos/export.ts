import type { SkeletonPart } from '../../spine-format/binary/readSkeleton.ts'
import type { Attachment, Sequence, Vertices } from '../../spine-format/binary/readSkins.ts'
import type { AnimationData, Timeline } from '../../spine-format/binary/readAnimations.ts'
import type { Atlas, AtlasRegion } from '../../core/atlas.ts'
import { encodePng, type Image } from '../../unity/png.ts'
import { detectPremultiplied, unpremultiply } from '../unity/alpha.ts'
import { resolveLinkedMeshes, type TimelineParent } from '../unity/linkedMesh.ts'
import { rangeIn } from '../clipping.ts'
import { toAbsoluteBezier } from '../../spine-format/bezier.ts'
import { describeTimeline, DUPLICATE_TIMELINE_MESSAGE, lastPerProperty } from '../../spine-format/duplicateTimelines.ts'
import { applyPoint, invert, setupLocals, setupPose, type Affine, type BoneLocal } from '../../spine-eval/pose.ts'
import { drawOrderOf, layerOfSlot, type DrawOrderOffset } from '../../spine-eval/drawOrder.ts'
import { sequenceCycle, sequenceFrameAt, sequenceRegionName, sequenceSteps, type SequenceKey } from '../../spine-eval/sequence.ts'
import { slotColorAt, unpackRgba, type Rgba } from '../../spine-eval/color.ts'
import { IssueCollector, type ConversionIssue } from '../types.ts'
import { CLIP_CLASS, cocosUuid, MESH_CLASS, spriteFrameUuid } from '../../cocos/ids.ts'
import { animation, BLEND, clipComponent, meshRenderer, PrefabDoc, sorting2D, sprite, uiTransform } from '../../cocos/json.ts'
import { CONSTANT, realKeys, type RealKey, type Segment } from '../../cocos/curve.ts'
import { clipJson, type PathStep, type Track } from '../../cocos/clip.ts'
import { animationClipMeta, AUTO_ATLAS_CONTENT, autoAtlasMeta, directoryMeta, imageMeta, prefabMeta } from '../../cocos/meta.ts'

/**
 * Spine(中转模型)→ Cocos Creator 3.8 的原生节点 + `cc.Animation` + `.anim`。图片部件零脚本;网格 / deform / 遮罩走两个
 * 脚本组件(`tools/cocos/runtime/`,CLI 拷到输出目录 `AnimatorGoRuntime/`)。
 *
 * 产物:`<名字>.prefab`、每条动画一个 `<动画>.anim`、`images/` 里每个图集区域一张 PNG(+ 自动图集 `.pac`),
 * 各自带 `.meta`。拖进工程的 `assets/` 就能用:拖 prefab 进 Canvas,`playOnLoad` 播第一条动画。
 *
 * 坐标:Spine 的像素就是 Cocos UI 的单位,Y 朝上、角度逆时针为正,都和 Spine 一致,不用换算。
 *
 * 结构(和 Unity / Godot 导出同一个思路,见 docs/COCOS.md):
 * - 骨骼 → 普通节点,位移 / 旋转 / 缩放就是 Spine 的 setup 值。Cocos 没有斜切,shearX 折进旋转,shearY ≠ shearX 的报近似
 * - 每个 attachment 一个节点,挂在 slot 的骨骼下:`cc.UITransform` + `cc.Sprite` + `cc.Sorting2D`。
 *   换图 = 节点 `active`;绘制顺序 = `sortingOrder`(slot 下标,挪过位的 slot 一条阶梯轨道);颜色 = Sprite 的 `color`;
 *   混合模式 = Sprite 自己的 src / dst 混合因子
 * - 网格(加权、deform 都算)→ `AnimatorGoMesh`(UIRenderer 子类,CPU 蒙皮,和 Sprite 同一条批处理管线、同样被 Sorting2D 排):
 *   顶点照 Spine 原样存(每顶点若干个「骨骼 + 局部坐标 + 权重」),deform 的每个关键帧一个 shape,权重走 RealArrayTrack
 * - clipping 遮罩 → `AnimatorGoClip`(多边形同样的表达 + 它在绘制顺序里的起止),被遮的网格在 CPU 上裁三角形;
 *   遮罩范围里的图片部件也改走 AnimatorGoMesh(Sprite 裁不了)
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
  /** 用到了脚本组件(网格 / 遮罩):AnimatorGoRuntime/ 要一起拷进工程 */
  readonly runtime: boolean
}

const DEG = Math.PI / 180
/** 阶梯跳变前补的那个键离跳变多远(秒)。要大于引擎认「同一时刻」的 1e-6 */
const STEP_EPSILON = 1e-4
const SAMPLE_FPS = 30

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

/** 写出的图,按「区域 + 预乘」去重;文件名由区域名来,撞了加序号 */
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

  get(region: AtlasRegion, pma: boolean): CocosImage | null {
    const page = this.pages.get(region.page)
    if (page === undefined) return null
    const key = `${region.name}${pma ? '@pma' : ''}`
    const hit = this.entries.get(key)
    if (hit !== undefined) return hit
    let image = regionImage(page, region)
    if (pma) image = premultiply(image)
    let stem = region.name.replace(/[\\/:*?"<>|]/g, '_')
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

interface VertexSource {
  /** 用到的骨骼(骨架下标),影响里的骨骼下标指向它 */
  readonly bones: number[]
  readonly counts: number[]
  /** [骨骼局部下标, x, y, 权重] × 影响 */
  readonly influences: number[]
}

/** Spine 的顶点 → 运行时(AnimatorGoSkinning.ts)的表达。没加权的全挂在 slot 的骨骼上 */
function vertexSource(verts: Vertices, slotBone: number): VertexSource {
  if (!verts.weighted) return rigidSource(pairs(verts.positions), slotBone)
  const bones: number[] = []
  const counts: number[] = []
  const influences: number[] = []
  for (const entry of verts.weights) {
    counts.push(entry.length)
    for (const w of entry) {
      let i = bones.indexOf(w.bone)
      if (i < 0) {
        i = bones.length
        bones.push(w.bone)
      }
      influences.push(i, w.x, w.y, w.weight)
    }
  }
  return { bones, counts, influences }
}

function rigidSource(points: readonly { x: number; y: number }[], bone: number): VertexSource {
  const influences: number[] = []
  for (const p of points) influences.push(0, p.x, p.y, 1)
  return { bones: [bone], counts: points.map(() => 1), influences }
}

const pairs = (flat: readonly number[]): { x: number; y: number }[] => Array.from({ length: flat.length / 2 }, (_, i) => ({ x: flat[i * 2]!, y: flat[i * 2 + 1]! }))

/**
 * region attachment 当网格画:四角在 slot 骨骼局部的位置(Spine 的 UpdateRegion:左下、右下、右上、左上,
 * 和 spine-eval/vertices.ts 同一个公式)和各角的区域相对 uv(s 向右、t 向下)
 */
function regionQuad(a: Attachment, region: AtlasRegion): { local: { x: number; y: number }[]; uvs: number[] } {
  const d = a.data as Record<string, number>
  const w = d['width']!, h = d['height']!
  const lx = (-w / 2 + (region.offsetX / region.originalWidth) * w) * d['scaleX']!
  const ly = (-h / 2 + (region.offsetY / region.originalHeight) * h) * d['scaleY']!
  const lx2 = (w / 2 - ((region.originalWidth - region.offsetX - region.width) / region.originalWidth) * w) * d['scaleX']!
  const ly2 = (h / 2 - ((region.originalHeight - region.offsetY - region.height) / region.originalHeight) * h) * d['scaleY']!
  const cos = Math.cos(DEG * d['rotation']!), sin = Math.sin(DEG * d['rotation']!)
  const local = [[lx, ly], [lx2, ly], [lx2, ly2], [lx, ly2]].map(([x, y]) => ({ x: x! * cos - y! * sin + d['x']!, y: y! * cos + x! * sin + d['y']! }))
  return { local, uvs: [0, 1, 1, 1, 1, 0, 0, 0] }
}

/** 网格的 uv(相对未裁剪的原图,左上原点)→ 相对裁剪后区域的 (s, t)。可能略出 0..1(顶点落在裁掉的透明边上),和 Spine 一样 */
function meshUvs(uvs: readonly number[], region: AtlasRegion): number[] {
  const out: number[] = []
  for (let i = 0; i * 2 < uvs.length; i++) {
    out.push((uvs[i * 2]! * region.originalWidth - region.offsetX) / region.width)
    out.push((uvs[i * 2 + 1]! * region.originalHeight - (region.originalHeight - region.offsetY - region.height)) / region.height)
  }
  return out
}

/** 顶点的包围盒 → UITransform 的大小 / 锚点(只给编辑器画个框,渲染不用它) */
function bounds(points: readonly { x: number; y: number }[]): { width: number; height: number; anchorX: number; anchorY: number } {
  if (points.length === 0) return { width: 1, height: 1, anchorX: 0.5, anchorY: 0.5 }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
  }
  const width = Math.max(maxX - minX, 1), height = Math.max(maxY - minY, 1)
  return { width, height, anchorX: -minX / width, anchorY: -minY / height }
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
  /** sprite = cc.Sprite(图片部件);mesh = AnimatorGoMesh;clip = AnimatorGoClip */
  readonly kind: AttachmentKind
  /** 网格 / 遮罩上的 deform;没有为 null */
  readonly deform: MeshDeform | null
  /** linkedmesh:deform 时间轴打在父网格上(皮肤 + 键名),这个节点跟着父网格变形 */
  readonly deformSource: TimelineParent | null
}

export type AttachmentKind = 'sprite' | 'mesh' | 'clip'

/** 一个网格 / 遮罩的 deform:去重后的 shape(平铺偏移,逐影响 x,y,与 Spine 的 deform 时间轴同一个布局)和每条动画里的帧序列 */
export interface MeshDeform {
  readonly shapes: readonly (readonly number[])[]
  readonly perAnim: ReadonlyMap<string, DeformSeq>
}

export interface DeformSeq {
  readonly frames: readonly Record<string, unknown>[]
  /** 每帧对应的 shape 下标;−1 = 没有形变(setup) */
  readonly shape: readonly number[]
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
  const keptOf = new Map(part.animations.map((anim) => [anim.name, lastPerProperty(anim.timelines).kept] as const))
  // 可能被遮罩盖住的 slot(setup 和所有绘制顺序关键帧下都算):它们的图片部件也得走 AnimatorGoMesh,Sprite 裁不了
  const clippedSlots = potentiallyClipped(part, keptOf)
  const meshComps = new Map<AttachmentNode, number>()
  const clipComps: number[] = []
  const stats = { meshes: 0, weighted: 0, deformed: 0, quads: 0, clips: 0 }

  const register = (info: AttachmentNode) => {
    attachmentNodes.push(info)
    nodesOfSlot.set(info.slot, [...(nodesOfSlot.get(info.slot) ?? []), info])
  }
  /** 节点挂在 slot 的骨骼下;和皮肤有关的再包一层按皮肤开关的节点 */
  const placeUnder = (skin: (typeof part.skins)[number], slotIndex: number, key: string, base: string, common: { skin: string; slot: number; key: string }): number => {
    let parent = boneNode[part.slots[slotIndex]!.bone]!
    const skinDependent = named.length > 0 && (skin !== defaultSkin || overridden.has(`${slotIndex}/${key}`))
    if (skinDependent) {
      parent = doc.node({ name: names.claim(parent, `${base} (${skin.name})`), parent, active: shownInSkin(common, initialSkin) })
      wrapperCount.n++
    }
    return parent
  }

  const emit = (skin: (typeof part.skins)[number], slotIndex: number, a: Attachment, frame?: { index: number; sequence: Sequence }) => {
    const slot = part.slots[slotIndex]!
    const blend = BLEND_OF_MODE[slot.blendMode]
    if (blend === undefined) issues.loss(`slot.${slot.name}`, `不认识的混合模式 ${slot.blendMode},按 normal 画`)
    const b = blend ?? BLEND_OF_MODE[0]!
    const ownColor = unpackRgba(a.data['color'] as number)
    const slotColor = unpackRgba(slot.color)
    let base = a.key === slot.name ? slot.name : `${slot.name}__${a.key}`
    if (frame !== undefined) base += ` #${frame.sequence.start + frame.index}`
    const common = { slot: slotIndex, skin: skin.name, key: a.key, attachment: a, ownColor, ...(frame === undefined ? {} : { frame }) }
    const deformSource = timelineParents.get(a) ?? null

    // 遮罩:没有图,只有多边形 + 它在绘制顺序里的起止
    if (a.type === 'clipping') {
      const verts = a.data['vertices'] as Vertices
      const source = vertexSource(verts, slot.bone)
      const deform = deformOf(part, keptOf, common, verts, deformSource)
      const parent = placeUnder(skin, slotIndex, a.key, base, common)
      const node = doc.node({ name: names.claim(parent, base), parent, active: setupVisible(slot, common) })
      clipComps.push(clipComponent(doc, node, {
        bones: source.bones.map((i) => boneNode[i]!), counts: source.counts, influences: source.influences,
        shapes: deform?.shapes.flat() ?? [], shapeCount: deform?.shapes.length ?? 0,
        order: slotIndex, endOrder: a.data['endSlot'] as number,
      }))
      stats.clips++
      register({ ...common, kind: 'clip', path: doc.pathOf(node), deform, deformSource })
      return
    }

    const regionName = frame === undefined ? regionNameOf(a) : sequenceRegionName(regionNameOf(a), frame.sequence, frame.index)
    const region = atlas.regions.get(regionName)
    if (region === undefined) {
      issues.loss(`region.${regionName}`, `图集里没有 "${regionName}",这个部件不会显示`)
      return
    }
    const image = images.get(region, b.pma)
    if (image === null) return
    const color = to255(mulColor(slotColor, ownColor))

    // 图片部件:cc.Sprite,零脚本
    if (a.type === 'region' && !clippedSlots.has(slotIndex)) {
      const placement = regionPlacement(a, region)
      const parent = placeUnder(skin, slotIndex, a.key, base, common)
      const node = doc.node({
        name: names.claim(parent, base), parent,
        x: placement.x, y: placement.y, rotation: placement.rotation, scaleX: placement.scaleX, scaleY: placement.scaleY,
        active: setupVisible(slot, common),
      })
      uiTransform(doc, node, placement.width, placement.height, placement.anchorX, placement.anchorY)
      sprite(doc, node, { spriteFrame: spriteFrameUuid(image.uuid), color, srcBlend: b.src, dstBlend: b.dst })
      sorting2D(doc, node, slotIndex)
      register({ ...common, kind: 'sprite', path: doc.pathOf(node), deform: null, deformSource: null })
      return
    }

    // 网格(或遮罩范围里的图片部件):AnimatorGoMesh。节点是 slot 骨骼下的一个恒等节点,顶点自己带骨骼
    let source: VertexSource
    let uvs: number[]
    let indices: number[]
    let local: { x: number; y: number }[]
    let deform: MeshDeform | null = null
    if (a.type === 'region') {
      const quad = regionQuad(a, region)
      source = rigidSource(quad.local, slot.bone)
      uvs = quad.uvs
      indices = [0, 1, 2, 0, 2, 3]
      local = quad.local
      stats.quads++
    } else {
      const verts = a.data['vertices'] as Vertices
      source = vertexSource(verts, slot.bone)
      uvs = meshUvs(a.data['uvs'] as number[], region)
      indices = a.data['triangles'] as number[]
      local = verts.weighted ? verticesInBone(verts, slot.bone, setup) : pairs(verts.positions)
      deform = deformOf(part, keptOf, common, verts, deformSource)
      stats.meshes++
      if (source.bones.length > 1) stats.weighted++
      if (deform !== null) stats.deformed++
    }
    const parent = placeUnder(skin, slotIndex, a.key, base, common)
    const node = doc.node({ name: names.claim(parent, base), parent, active: setupVisible(slot, common) })
    const box = bounds(local)
    uiTransform(doc, node, box.width, box.height, box.anchorX, box.anchorY)
    const comp = meshRenderer(doc, node, {
      spriteFrame: spriteFrameUuid(image.uuid), color, srcBlend: b.src, dstBlend: b.dst,
      bones: source.bones.map((i) => boneNode[i]!), counts: source.counts, influences: source.influences, uvs, indices,
      shapes: deform?.shapes.flat() ?? [], shapeCount: deform?.shapes.length ?? 0,
    })
    sorting2D(doc, node, slotIndex)
    const info: AttachmentNode = { ...common, kind: 'mesh', path: doc.pathOf(node), deform, deformSource }
    register(info)
    if (clippedSlots.has(slotIndex)) meshComps.set(info, comp)
  }

  for (const skin of part.skins) {
    for (const entry of skin.slots) {
      for (const a of entry.attachments) {
        if (a.type !== 'region' && a.type !== 'mesh' && a.type !== 'clipping') {
          if (a.type !== 'boundingbox' && a.type !== 'point' && a.type !== 'path') issues.loss(`attachment.${a.name}`, `不支持的 attachment 类型 ${a.type}`)
          continue
        }
        if (a.sequence !== null) {
          for (let i = 0; i < a.sequence.count; i++) emit(skin, entry.slot, a, { index: i, sequence: a.sequence })
        } else emit(skin, entry.slot, a)
      }
    }
  }
  // 可能被遮的网格认识全部遮罩,运行时按绘制顺序挑正盖着自己的那个
  for (const comp of meshComps.values()) doc.objects[comp]!['clips'] = clipComps.map((c) => doc.ref(c))
  const runtime = stats.meshes + stats.quads + stats.clips > 0
  if (runtime) {
    issues.add('info', 'runtime', `${stats.meshes} 个网格(加权 ${stats.weighted}、deform ${stats.deformed})走 AnimatorGoMesh(CPU 蒙皮的脚本组件)`
      + (stats.clips > 0 ? `,${stats.clips} 个遮罩走 AnimatorGoClip` : '')
      + (stats.quads > 0 ? `,遮罩范围里的 ${stats.quads} 个图片部件也改走 AnimatorGoMesh(只有它会被裁)` : '')
      + ' —— 脚本在 AnimatorGoRuntime/,要一起拷进工程')
  }
  if (stats.clips > 1) issues.add('info', 'clipping', '多个遮罩:同一部件同时被几个盖住时按先画的那个裁(Spine 同时也只认一个遮罩)')
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
  for (const anim of part.animations) {
    const tracks: Track[] = []
    const { kept, dropped } = lastPerProperty(anim.timelines)
    issues.scoped(anim.name, () => {
      for (const d of dropped) if (!d.identical) issues.add('approximated', describeTimeline(part, d.timeline), DUPLICATE_TIMELINE_MESSAGE)
      tracks.push(...boneTracks(part, kept, bonePath, locals, is38, issues))
      tracks.push(...slotTracks(part, anim, kept, nodesOfSlot, is38, issues))
      tracks.push(...deformTracks(anim, attachmentNodes, is38))
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
  return { files, issues: issues.all, images: images.entries, attachments: attachmentNodes, runtime }
}

// ─── 网格 / 遮罩的 deform ─────────────────────────────────────────────────────

const skinNameOf = (part: SkeletonPart, s: number | string): string => (typeof s === 'number' ? (part.skins[s]?.name ?? String(s)) : s)

/** 一帧的 deform 偏移展开成整条(Spine 存的是从 start 起的一段) */
function flatOffsets(f: Record<string, unknown>, flatLength: number): number[] {
  const out = new Array<number>(flatLength).fill(0)
  const v = (f['vertices'] as number[] | undefined) ?? []
  const start = Number(f['start'] ?? 0)
  v.forEach((x, k) => { if (start + k < flatLength) out[start + k] = x })
  return out
}

/**
 * 打在这个网格 / 遮罩上的 deform:每条动画里的帧序列,帧去重成 shape(同样的偏移只存一份;全零 = setup,不占 shape)。
 * 目标按「皮肤 + slot + 键名」认(几套皮肤同键名各有各的);linkedmesh 跟着父网格(`source`)的时间轴变形。
 */
function deformOf(part: SkeletonPart, keptOf: ReadonlyMap<string, readonly Timeline[]>, node: { slot: number; skin: string; key: string; attachment: Attachment }, verts: Vertices, source: TimelineParent | null): MeshDeform | null {
  const flatLength = verts.weighted ? verts.weights.reduce((n, w) => n + w.length * 2, 0) : verts.positions.length
  const shapes: number[][] = []
  const index = new Map<string, number>()
  const perAnim = new Map<string, DeformSeq>()
  for (const anim of part.animations) {
    for (const t of keptOf.get(anim.name) ?? []) {
      if (t.kind !== 'deform' || t.owner !== node.slot) continue
      const rec = t.frames[0] as unknown as { skin: number | string; attachment: string; frames: Record<string, unknown>[] }
      const skin = skinNameOf(part, rec.skin)
      const own = skin === node.skin && (rec.attachment === node.key || rec.attachment === node.attachment.name)
      const inherited = source !== null && skin === source.skin && rec.attachment === source.key
      if (!own && !inherited) continue
      const shape = rec.frames.map((f) => {
        const flat = flatOffsets(f, flatLength)
        if (flat.every((x) => x === 0)) return -1
        const key = flat.map((x) => x.toFixed(4)).join(',')
        let i = index.get(key)
        if (i === undefined) {
          i = shapes.length
          shapes.push(flat)
          index.set(key, i)
        }
        return i
      })
      perAnim.set(anim.name, { frames: rec.frames, shape })
      break
    }
  }
  return shapes.length === 0 ? null : { shapes, perAnim }
}

/**
 * 一条动画里 shape 权重的曲线:第 k 条通道在打到 shape k 的帧上是 1、别的帧 0,帧间走 Spine 这一帧的曲线
 * (deform 的曲线是 0..1 的进度,两版一致)。两条相邻通道一升一降用同一条曲线,混出来 = (1−p)·δₖ + p·δₖ₊₁,正是 Spine 的插值。
 * 第一帧之前是 setup(0),最后一帧之后保持。没有 deform 的动画也写一条全 0 的 —— 切动画时 Cocos 不会把没键的属性回 setup
 */
function shapeChannels(seq: DeformSeq | undefined, shapeCount: number, is38: boolean): RealKey[][] {
  const zero = (): RealKey[] => realKeys([0], [0], [undefined])
  if (seq === undefined) return Array.from({ length: shapeCount }, zero)
  const frames = seq.frames
  const times = frames.map((f) => Number(f['time'] ?? 0))
  return Array.from({ length: shapeCount }, (_, k) => {
    const vals = seq.shape.map((s) => (s === k ? 1 : 0))
    if (vals.every((v) => v === 0)) return zero()
    const keyTimes: number[] = []
    const values: number[] = []
    const segs: (Segment | undefined)[] = []
    if (times[0]! > 0) {
      keyTimes.push(0)
      values.push(0)
      segs.push({ curve: 'stepped' })
    }
    frames.forEach((f, j) => {
      const v0 = vals[j]!
      let seg: Segment | undefined
      if (j + 1 < frames.length) {
        const v1 = vals[j + 1]!
        const curve = f['curve']
        if (curve === 'stepped') seg = { curve: 'stepped' }
        else if (curve === 'bezier' && v0 !== v1) {
          const raw = (f['beziers'] as number[][])[0]!
          const b = is38 ? toAbsoluteBezier(raw, times[j]!, 0, times[j + 1]!, 1) : raw
          seg = { curve: 'bezier', c: [b[0]!, v0 + (v1 - v0) * b[1]!, b[2]!, v0 + (v1 - v0) * b[3]!] }
        } else seg = { curve: 'linear' }
      }
      const t = times[j]!
      if (keyTimes.length > 0 && Math.abs(keyTimes[keyTimes.length - 1]! - t) < 1e-6) {
        values[values.length - 1] = v0
        segs[segs.length - 1] = seg
        return
      }
      keyTimes.push(t)
      values.push(v0)
      segs.push(seg)
    })
    return realKeys(keyTimes, values, segs)
  })
}

/** 每个带 shape 的网格 / 遮罩一条 `shapeWeights` 的 RealArrayTrack */
function deformTracks(anim: AnimationData, nodes: readonly AttachmentNode[], is38: boolean): Track[] {
  const out: Track[] = []
  for (const n of nodes) {
    if (n.deform === null) continue
    const channels = shapeChannels(n.deform.perAnim.get(anim.name), n.deform.shapes.length, is38)
    out.push({ kind: 'realArray', path: [{ node: n.path }, { component: n.kind === 'clip' ? CLIP_CLASS : MESH_CLASS }, 'shapeWeights'], channels })
  }
  return out
}

/** 可能被遮罩盖住的 slot:setup 和每条动画的每个绘制顺序关键帧下,遮罩 slot 之后到 endSlot 为止的(Spine 的规则,clipping.ts 的 rangeIn) */
function potentiallyClipped(part: SkeletonPart, keptOf: ReadonlyMap<string, readonly Timeline[]>): Set<number> {
  const clips: { slot: number; end: number }[] = []
  for (const skin of part.skins) for (const e of skin.slots) for (const a of e.attachments) if (a.type === 'clipping') clips.push({ slot: e.slot, end: a.data['endSlot'] as number })
  const out = new Set<number>()
  if (clips.length === 0) return out
  const orders: number[][] = [part.slots.map((_, i) => i)]
  for (const kept of keptOf.values()) {
    const tl = kept.find((t) => t.kind === 'drawOrder')
    for (const f of tl?.frames ?? []) orders.push(drawOrderOf(part.slots.length, (f['offsets'] as DrawOrderOffset[] | undefined) ?? []))
  }
  for (const c of clips) for (const o of orders) for (const s of rangeIn(o, c.slot, c.end)) out.add(s)
  return out
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
      if (node.kind === 'clip') continue
      const channels = [0, 1, 2, 3].map((k) => linearKeys(times, colors.map((c) => to255(mulColor(c, node.ownColor))[k]!)))
      out.push({ kind: 'color', path: [{ node: node.path }, { component: node.kind === 'sprite' ? 'cc.Sprite' : MESH_CLASS }, 'color'], channels })
    }
  }

  // 逐帧绘制顺序:挪过位的 slot,其挂图节点一条 sortingOrder 阶梯轨道
  const drawOrder = timelines.find((t) => t.kind === 'drawOrder')
  if (drawOrder !== undefined) {
    const layers = drawOrder.frames.map((f) => ({
      t: Number(f['time'] ?? 0),
      layer: layerOfSlot(drawOrderOf(part.slots.length, (f['offsets'] as DrawOrderOffset[] | undefined) ?? [])),
    }))
    /** 这个 slot 在绘制顺序里的位置随时间的阶梯;没挪过位就 null */
    const orderKeys = (s: number): RealKey[] | null => {
      if (s < 0 || s >= part.slots.length || layers.every((l) => l.layer[s] === s)) return null
      return stepKeys([{ t: 0, v: s }, ...layers.map((l) => ({ t: l.t, v: l.layer[s]! }))])
    }
    for (let s = 0; s < part.slots.length; s++) {
      const keys = orderKeys(s)
      for (const node of nodesOfSlot.get(s) ?? []) {
        if (node.kind !== 'clip') {
          if (keys !== null) out.push({ kind: 'real', path: [{ node: node.path }, { component: 'cc.Sorting2D' }, 'sortingOrder'], keys })
          continue
        }
        // 遮罩的起止跟着绘制顺序走
        if (keys !== null) out.push({ kind: 'real', path: [{ node: node.path }, { component: CLIP_CLASS }, 'order'], keys })
        const endKeys = orderKeys(node.attachment.data['endSlot'] as number)
        if (endKeys !== null) out.push({ kind: 'real', path: [{ node: node.path }, { component: CLIP_CLASS }, 'endOrder'], keys: endKeys })
      }
    }
  }
  return out
}
