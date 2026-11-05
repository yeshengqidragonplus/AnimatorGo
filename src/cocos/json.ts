import { CLIP_TYPE, fileId, MESH_TYPE } from './ids.ts'

/**
 * Cocos Creator 的资源 JSON(prefab / scene / anim 都是这一种):一个对象数组,`__type__` 是类名,
 * 对象之间用 `{"__id__": n}` 引用数组下标,资源之间用 `{"__uuid__": "…"}`。第 0 项是资源本身
 * (`cc.Prefab` / `cc.AnimationClip`)。
 *
 * 写法照 3.8.8 编辑器自己写出的文件(`editor/assets/default_prefab/ui/Canvas.prefab`、`Button.prefab`),
 * 字段顺序也照它 —— 反序列化不在乎顺序,但 diff 好看。
 */

export type Ref = { readonly __id__: number }
export type AssetRef = { readonly __uuid__: string }
export type Json = Record<string, unknown>

/** 2D UI 节点所在的层(Layers.Enum.UI_2D = 1 << 25);画布相机只看这一层 */
export const UI_2D_LAYER = 1 << 25

export const vec2 = (x: number, y: number): Json => ({ __type__: 'cc.Vec2', x: r(x), y: r(y) })
export const vec3 = (x: number, y: number, z: number): Json => ({ __type__: 'cc.Vec3', x: r(x), y: r(y), z: r(z) })
export const size = (width: number, height: number): Json => ({ __type__: 'cc.Size', width: r(width), height: r(height) })
export const rgba = (red: number, green: number, blue: number, alpha: number): Json => ({ __type__: 'cc.Color', r: red, g: green, b: blue, a: alpha })

/** 只绕 Z 轴的四元数(Spine 只有平面旋转) */
export function quatZ(degrees: number): Json {
  const half = (degrees * Math.PI) / 360
  return { __type__: 'cc.Quat', x: 0, y: 0, z: r(Math.sin(half)), w: r(Math.cos(half)) }
}

/** 写文件时把 double 的尾巴去掉:1e-7 以下对任何引擎都是噪音,留着只会让文件变大、diff 变脏 */
export function r(v: number): number {
  if (!Number.isFinite(v)) return v
  const rounded = Math.round(v * 1e7) / 1e7
  return Object.is(rounded, -0) ? 0 : rounded
}

export class Doc {
  readonly objects: Json[] = []

  add(o: Json): number {
    this.objects.push(o)
    return this.objects.length - 1
  }

  ref(i: number): Ref {
    return { __id__: i }
  }

  text(): string {
    return JSON.stringify(this.objects, null, 2) + '\n'
  }
}

export interface NodeSpec {
  readonly name: string
  /** null = 根节点 */
  readonly parent: number | null
  readonly x?: number
  readonly y?: number
  /** 绕 Z 的角度,逆时针为正(与 Spine 同向) */
  readonly rotation?: number
  readonly scaleX?: number
  readonly scaleY?: number
  readonly active?: boolean
}

/**
 * prefab 文档:根节点在下标 1,每个节点带 `cc.PrefabInfo`、每个组件带 `cc.CompPrefabInfo`
 * (编辑器靠它们认「这个节点属于哪个 prefab」,没有的话把 prefab 拖进场景会丢节点)。
 */
export class PrefabDoc extends Doc {
  private readonly seedOf = new Map<number, string>()
  readonly name: string

  // ⚠️ 不能写成构造函数参数属性(`constructor(readonly name)`):CLI 用 node --experimental-strip-types 跑,它不认这种写法
  constructor(name: string) {
    super()
    this.name = name
    this.add({ __type__: 'cc.Prefab', _name: name, _objFlags: 0, __editorExtras__: {}, _native: '', data: { __id__: 1 }, optimizationPolicy: 0, persistent: false })
  }

  /** 节点在文档里的路径(根不算),用来生成 fileId 和动画轨道路径 */
  pathOf(node: number): string {
    return this.seedOf.get(node) ?? ''
  }

  node(spec: NodeSpec): number {
    const parentPath = spec.parent === null ? null : this.pathOf(spec.parent)
    const path = parentPath === null ? '' : parentPath === '' ? spec.name : `${parentPath}/${spec.name}`
    const index = this.add({
      __type__: 'cc.Node',
      _name: spec.name,
      _objFlags: 0,
      __editorExtras__: {},
      _parent: spec.parent === null ? null : this.ref(spec.parent),
      _children: [],
      _active: spec.active ?? true,
      _components: [],
      _prefab: null,
      _lpos: vec3(spec.x ?? 0, spec.y ?? 0, 0),
      _lrot: quatZ(spec.rotation ?? 0),
      _lscale: vec3(spec.scaleX ?? 1, spec.scaleY ?? 1, 1),
      _mobility: 0,
      _layer: UI_2D_LAYER,
      _euler: vec3(0, 0, spec.rotation ?? 0),
      _id: '',
    })
    this.seedOf.set(index, path)
    const info = this.add({ __type__: 'cc.PrefabInfo', root: this.ref(1), asset: this.ref(0), fileId: fileId(`${this.name}/node/${path}`), targetOverrides: null, nestedPrefabInstanceRoots: null })
    this.objects[index]!['_prefab'] = this.ref(info)
    if (spec.parent !== null) (this.objects[spec.parent]!['_children'] as Ref[]).push(this.ref(index))
    return index
  }

  component(node: number, type: string, fields: Json): number {
    const path = this.pathOf(node)
    const index = this.add({ __type__: type, _name: '', _objFlags: 0, __editorExtras__: {}, node: this.ref(node), _enabled: true, __prefab: null, ...fields, _id: '' })
    const info = this.add({ __type__: 'cc.CompPrefabInfo', fileId: fileId(`${this.name}/comp/${path}/${type}`) })
    this.objects[index]!['__prefab'] = this.ref(info)
    ;(this.objects[node]!['_components'] as Ref[]).push(this.ref(index))
    return index
  }
}

// ── 常用组件 ──

export interface SpriteFields {
  readonly spriteFrame: string
  /** 0..255 */
  readonly color: readonly [number, number, number, number]
  readonly srcBlend: number
  readonly dstBlend: number
}

/** gfx.BlendFactor */
export const BLEND = { ZERO: 0, ONE: 1, SRC_ALPHA: 2, DST_ALPHA: 3, ONE_MINUS_SRC_ALPHA: 4, ONE_MINUS_DST_ALPHA: 5, SRC_COLOR: 6, DST_COLOR: 7, ONE_MINUS_SRC_COLOR: 8 } as const

export function uiTransform(doc: PrefabDoc, node: number, width: number, height: number, anchorX: number, anchorY: number): number {
  return doc.component(node, 'cc.UITransform', { _contentSize: size(width, height), _anchorPoint: vec2(anchorX, anchorY) })
}

/**
 * Sprite:`_sizeMode` CUSTOM(0)+ `_isTrimmedMode` false —— 矩形由 UITransform 定,不跟着图走
 * (图是我们自己裁好的,trim 一律关掉,见 meta.ts)
 */
export function sprite(doc: PrefabDoc, node: number, f: SpriteFields): number {
  return doc.component(node, 'cc.Sprite', {
    _visFlags: 0,
    _customMaterial: null,
    _srcBlendFactor: f.srcBlend,
    _dstBlendFactor: f.dstBlend,
    _color: rgba(f.color[0], f.color[1], f.color[2], f.color[3]),
    _spriteFrame: { __uuid__: f.spriteFrame },
    _type: 0,
    _fillType: 0,
    _sizeMode: 0,
    _fillCenter: vec2(0, 0),
    _fillStart: 0,
    _fillRange: 0,
    _isTrimmedMode: false,
    _useGrayscale: false,
    _atlas: null,
  })
}

/** 2D 排序:同一层里 `sortingOrder` 大的后画。工程要开 sorting-2d 功能(新建的 2D 工程默认开) */
export function sorting2D(doc: PrefabDoc, node: number, order: number): number {
  return doc.component(node, 'cc.Sorting2D', { _sortingLayer: 0, _sortingOrder: order })
}

export function animation(doc: PrefabDoc, node: number, clips: readonly string[], defaultClip: string | null, playOnLoad: boolean): number {
  return doc.component(node, 'cc.Animation', {
    playOnLoad,
    _clips: clips.map((uuid) => ({ __uuid__: uuid })),
    _defaultClip: defaultClip === null ? null : { __uuid__: defaultClip },
  })
}

// ── AnimatorGo 的运行时组件(tools/cocos/runtime/)──

/** 网格 / 遮罩共用的顶点来源:骨骼节点 + 逐顶点影响 + deform shape(布局见 AnimatorGoSkinning.ts) */
export interface VertexSourceFields {
  /** 骨骼节点在文档里的下标 */
  readonly bones: readonly number[]
  readonly counts: readonly number[]
  /** [骨骼局部下标, x, y, 权重] × 影响 */
  readonly influences: readonly number[]
  /** shape 平铺(每个 2 × 影响数) */
  readonly shapes: readonly number[]
  readonly shapeCount: number
}

export interface MeshFields extends VertexSourceFields {
  readonly spriteFrame: string
  readonly color: readonly [number, number, number, number]
  readonly srcBlend: number
  readonly dstBlend: number
  /** 区域相对的 (s 向右, t 向下) × 顶点 */
  readonly uvs: readonly number[]
  readonly indices: readonly number[]
}

/** `AnimatorGoMesh`(UIRenderer 子类,字段顺序先父类的再自己的)。`clips` 留空,导出器最后统一填 */
export function meshRenderer(doc: PrefabDoc, node: number, f: MeshFields): number {
  return doc.component(node, MESH_TYPE, {
    _visFlags: 0,
    _customMaterial: null,
    _srcBlendFactor: f.srcBlend,
    _dstBlendFactor: f.dstBlend,
    _color: rgba(f.color[0], f.color[1], f.color[2], f.color[3]),
    _spriteFrame: { __uuid__: f.spriteFrame },
    bones: f.bones.map((b) => doc.ref(b)),
    counts: [...f.counts],
    influences: f.influences.map(r),
    uvs: f.uvs.map(r),
    indices: [...f.indices],
    shapes: f.shapes.map(r),
    shapeWeights: new Array<number>(f.shapeCount).fill(0),
    clips: [],
  })
}

export interface ClipFields extends VertexSourceFields {
  readonly order: number
  readonly endOrder: number
}

/** `AnimatorGoClip`:遮罩多边形 + 它在绘制顺序里的起止 */
export function clipComponent(doc: PrefabDoc, node: number, f: ClipFields): number {
  return doc.component(node, CLIP_TYPE, {
    bones: f.bones.map((b) => doc.ref(b)),
    counts: [...f.counts],
    influences: f.influences.map(r),
    shapes: f.shapes.map(r),
    shapeWeights: new Array<number>(f.shapeCount).fill(0),
    order: f.order,
    endOrder: f.endOrder,
  })
}
