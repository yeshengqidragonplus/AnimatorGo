import { _decorator, CCFloat, CCInteger, Node, SpriteFrame, UIRenderer, type RenderData, type IAssembler } from 'cc'
import { JSB } from 'cc/env'
import { AnimatorGoClip } from './AnimatorGoClip'
import {
  MAT_STRIDE, MAX_INDICES, MAX_VERTICES, clipCovers, clipMesh, combineShapes, createClipBuffers, frameUv, influenceCount, skinVertices,
  type ClipBuffers,
} from './AnimatorGoSkinning'

const { ccclass, property, executeInEditMode, serializable } = _decorator

/**
 * Spine 的网格(含加权、deform)在 Cocos 里的渲染器:`UIRenderer` 子类 + 自己的 assembler,CPU 蒙皮。
 *
 * 和 `cc.Sprite` 走同一条 2D 批处理管线(同一个内置材质 `ui-sprite-material`、同一张图集就合批),同样被 `cc.Sorting2D` 排序、
 * 同样吃 `color` 和混合因子 —— 这是它存在的全部理由:3D 的 SkinnedMeshRenderer 放进 UI 不参与 Sorting2D 排序(docs/COCOS.md 第 0 节)。
 *
 * 顶点表达照 Spine 原样(AnimatorGoSkinning.ts):每顶点若干影响、deform 先加偏移再蒙皮、每顶点骨骼数不限。
 * uv 是相对 spriteFrame 的 (s 向右, t 向下),每帧按 `spriteFrame.uv` 的四个角换算 —— 自动图集 / 动态合图 / 转 90° 都不用管。
 *
 * 被遮罩(`clips` 里某个 AnimatorGoClip 正生效且按绘制顺序盖住了自己)时在 CPU 上裁三角形,和 Spine 的 SkeletonClipping 一样。
 *
 * 每帧的流程:`lateUpdate`(骨骼动画已经更新完)标脏 → 引擎调 assembler.updateRenderData 算顶点、按需扩缓冲 → 顶点(世界坐标、
 * 换算后的 uv、顶点色)写进 2D 顶点缓冲、索引进网格缓冲。最后一步两种管线不一样:
 *   - Web / 小游戏:批处理遍历节点树时调 assembler.fillBuffers,那里写顶点、追加索引;
 *   - 原生(JSB):2D 批处理在 C++ 里,不调 JS 的 fillBuffers。所以顶点在 updateRenderData 里就写进顶点缓冲(JS 和 C++ 共享同一块内存),
 *     索引写进 chunk 自带的索引数组,C++ 每帧原样拷进网格缓冲。渲染数据标了 isVertexPositionInWorld,C++ 不再拿节点矩阵乘一遍
 *     (引擎自己的 MotionStreak 就这么走);顶点色标成按顶点填充(_useVertexOpacity),C++ 也不按 color 整体覆盖。
 *     索引数组比这一帧多出来的部分填成退化三角形(三个顶点同一个),什么都不画。
 * 顶点色的透明度取节点树级联后的值(自己的 color.a × 各级 UIOpacity),引擎遍历节点树时算好放在 node._uiProps.opacity。
 */
@ccclass('AnimatorGoMesh')
@executeInEditMode
export class AnimatorGoMesh extends UIRenderer {
  @serializable
  private _spriteFrame: SpriteFrame | null = null

  @property({ type: SpriteFrame, tooltip: '贴图(uv 相对它)' })
  get spriteFrame(): SpriteFrame | null {
    return this._spriteFrame
  }
  set spriteFrame(value: SpriteFrame | null) {
    if (this._spriteFrame === value) return
    this._spriteFrame = value
    this.setTextureDirty()
    this._markForUpdateRenderData()
    this.updateMaterial()
  }

  @property({ type: [Node], tooltip: '影响里引用的骨骼节点' })
  bones: Node[] = []

  @property({ type: [CCInteger], visible: false })
  counts: number[] = []

  @property({ type: [CCFloat], visible: false })
  influences: number[] = []

  @property({ type: [CCFloat], visible: false })
  uvs: number[] = []

  @property({ type: [CCInteger], visible: false })
  indices: number[] = []

  @property({ type: [CCFloat], visible: false })
  shapes: number[] = []

  @property({ type: [CCFloat], tooltip: 'deform 各 shape 的权重(动画驱动)' })
  shapeWeights: number[] = []

  @property({ type: [AnimatorGoClip], tooltip: '可能遮住这个网格的遮罩' })
  clips: AnimatorGoClip[] = []

  // 每帧算出来的几何(世界坐标)
  private _mats = new Float32Array(0)
  private _offsets = new Float32Array(0)
  private _skinned = new Float32Array(0)
  private _clipped: ClipBuffers | null = null
  /** 这一帧要画的:位置、区域相对 uv、索引(裁了就指向 _clipped,没裁就是蒙皮结果 + 原 uv / 索引) */
  _pos: ArrayLike<number> = this._skinned
  _uv: ArrayLike<number> = this.uvs
  _idx: ArrayLike<number> = this.indices
  _vertexCount = 0
  _indexCount = 0
  _z = 0
  private _ib = new Uint16Array(0)
  private _sorting: { sortingOrder: number } | null = null
  private _warned = false

  constructor() {
    super()
    // 顶点色由自己写(透明度含级联的 UIOpacity),引擎不要再按 color 整体填 —— 原生的 C++ 批处理只认这个开关
    this._useVertexOpacity = true
  }

  public onEnable(): void {
    super.onEnable()
    this._sorting = this.node.getComponent('cc.Sorting2D') as unknown as { sortingOrder: number } | null
  }

  public lateUpdate(): void {
    // 骨骼每帧都在动,引擎只重算标了脏的渲染器 —— 动画系统更新完(lateUpdate 在它后面)标一次
    this._markForUpdateRenderData()
  }

  protected _render(render: unknown): void {
    ;(render as { commitComp(comp: UIRenderer, data: RenderData | null, frame: SpriteFrame | null, assembler: IAssembler, transform: Node | null): void })
      .commitComp(this, this.renderData, this._spriteFrame, this._assembler!, null)
  }

  protected _canRender(): boolean {
    if (!super._canRender()) return false
    const frame = this._spriteFrame
    return !!frame && !!frame.texture && this._indexCount > 0
  }

  protected _flushAssembler(): void {
    if (this._assembler !== assembler) {
      this.destroyRenderData()
      this._assembler = assembler
    }
    if (!this._renderData) {
      const rd = assembler.createData(this)
      rd.material = this.getRenderMaterial(0)
      if (JSB) {
        // 顶点已经是世界坐标,C++ 批处理不要再乘节点矩阵(createData 之后才有 drawInfo;关掉再开会重新 createData,这里会再走一遍)
        rd.renderDrawInfo.setVertexPositionInWorld(true)
      }
      this._markForUpdateRenderData()
      this._updateColor()
    }
  }

  /** 这一帧的几何:蒙皮 → (被遮就裁) → 按需扩缓冲 */
  _compute(rd: RenderData): void {
    const bones = this.bones
    if (this._mats.length < bones.length * MAT_STRIDE) this._mats = new Float32Array(bones.length * MAT_STRIDE)
    const mats = this._mats
    for (let i = 0; i < bones.length; i++) {
      const o = i * MAT_STRIDE
      const bone = bones[i]
      if (!bone) {
        mats[o] = 1; mats[o + 1] = 0; mats[o + 2] = 0; mats[o + 3] = 1; mats[o + 4] = 0; mats[o + 5] = 0
        continue
      }
      const m = bone.worldMatrix
      mats[o] = m.m00; mats[o + 1] = m.m04; mats[o + 2] = m.m01; mats[o + 3] = m.m05; mats[o + 4] = m.m12; mats[o + 5] = m.m13
      if (i === 0) this._z = m.m14
    }
    const n = this.counts.length
    const flat = influenceCount(this.counts) * 2
    if (this._offsets.length < flat) this._offsets = new Float32Array(flat)
    const deformed = combineShapes(this.shapes, flat, this.shapeWeights, this._offsets)
    if (this._skinned.length < n * 2) this._skinned = new Float32Array(n * 2)
    skinVertices(this.counts, this.influences, mats, deformed ? this._offsets : null, this._skinned)

    const clip = this._activeClip()
    if (clip === null) {
      this._pos = this._skinned
      this._uv = this.uvs
      this._idx = this.indices
      this._vertexCount = n
      this._indexCount = this.indices.length
    } else {
      const poly = clip.polygon()
      const out = this._clipped ?? (this._clipped = createClipBuffers())
      clipMesh(this._skinned, this.uvs, this.indices, this.indices.length, poly.xy, poly.triangles, out)
      if (out.truncated && !this._warned) {
        this._warned = true
        console.warn(`AnimatorGoMesh ${this.node.name}:裁剪后的三角形超过了一个渲染器的上限(${MAX_VERTICES} 顶点 / ${MAX_INDICES} 索引),多出来的没画`)
      }
      this._pos = out.pos
      this._uv = out.uv
      this._idx = out.idx
      this._vertexCount = out.vertexCount
      this._indexCount = out.indexCount
    }
    // 容量按 chunk 自己算,不另外记:组件关掉再开(destroyRenderData → createData)chunk 会换成 4 个顶点的新块,
    // 记在组件上的容量就对不上了 —— 实测写出去的顶点越界丢掉、索引指到别的网格的顶点,一屏尖刺。
    // rd.dataLength(引擎自己那份逐顶点对象)一直是 createData 给的 4 个,顶点不经过它,不跟着扩
    const capV = rd.chunk ? rd.chunk.vb.length / rd.floatStride : 0
    if (this._vertexCount > capV || this._indexCount > this._ib.length) {
      const newV = Math.min(MAX_VERTICES, Math.max(this._vertexCount, capV))
      const newI = Math.min(MAX_INDICES, Math.max(this._indexCount, this._ib.length))
      rd.resize(newV, newI)
      this._ib = new Uint16Array(newI)
    }
  }

  /** 正盖着自己的遮罩:生效的(节点激活)、按绘制顺序覆盖自己的里面,最先画的那个(Spine 同时只认一个遮罩) */
  private _activeClip(): AnimatorGoClip | null {
    const clips = this.clips
    if (clips.length === 0 || this._sorting === null) return null
    const mine = this._sorting.sortingOrder
    let best: AnimatorGoClip | null = null
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i]
      if (!c || !c.enabledInHierarchy) continue
      if (!clipCovers(c.order, c.endOrder, mine)) continue
      if (best === null || c.order < best.order) best = c
    }
    return best
  }

  _indexBuffer(): Uint16Array {
    return this._ib
  }
}

/**
 * 把这一帧的顶点写进 chunk 的顶点缓冲(格式 vfmtPosUvColor:x y z u v r g b a,共 9 个 float),返回写了几个。
 * chunk 装不下就不画多出来的(正常不会到这里,_compute 已经按需扩过)
 */
function writeVertices(mesh: AnimatorGoMesh, rd: RenderData, frame: SpriteFrame): number {
  const chunk = rd.chunk
  const vb = chunk.vb
  const stride = rd.floatStride
  const uvs = frame.uv
  const color = mesh.color
  const r = color.r / 255, g = color.g / 255, b = color.b / 255
  // 级联透明度:自己的 color.a × 各级 UIOpacity,引擎遍历节点树时算好的(Web 在 fillBuffers 之前算,原生是上一帧 C++ 算的)
  const a = mesh.node._uiProps.opacity
  const pos = mesh._pos
  const uv = mesh._uv
  const z = mesh._z
  const n = Math.min(mesh._vertexCount, Math.floor(vb.length / stride))
  for (let i = 0, o = 0; i < n; i++, o += stride) {
    vb[o] = pos[i * 2]
    vb[o + 1] = pos[i * 2 + 1]
    vb[o + 2] = z
    frameUv(uv[i * 2], uv[i * 2 + 1], uvs, vb, o + 3)
    vb[o + 5] = r
    vb[o + 6] = g
    vb[o + 7] = b
    vb[o + 8] = a
  }
  return n
}

/** 原生:顶点写进共享的顶点缓冲,索引写进 chunk 自带的索引数组(C++ 每帧按 chunk 的索引容量原样拷走,多出来的填退化三角形) */
function fillNative(mesh: AnimatorGoMesh, rd: RenderData, frame: SpriteFrame): void {
  const n = writeVertices(mesh, rd, frame)
  const chunk = rd.chunk
  const ib = chunk.ib as Uint16Array
  const idx = mesh._idx
  const base = chunk.vertexOffset
  const ic = n < mesh._vertexCount ? 0 : Math.min(mesh._indexCount, ib.length)
  for (let k = 0; k < ic; k++) ib[k] = base + idx[k]
  for (let k = ic; k < ib.length; k++) ib[k] = base
}

const assembler: IAssembler = {
  createData(comp: UIRenderer): RenderData {
    const rd = comp.requestRenderData()
    // dataLength 只是让引擎把自己那份逐顶点对象和原生侧的共享结构建起来,顶点不经过它,后面也不跟着扩
    rd.dataLength = 4
    rd.resize(4, 6)
    return rd
  },

  updateRenderData(comp: UIRenderer): void {
    const mesh = comp as AnimatorGoMesh
    const rd = mesh.renderData
    const frame = mesh.spriteFrame
    if (!rd || !frame) return
    mesh._compute(rd)
    if (JSB) fillNative(mesh, rd, frame)
    rd.updateRenderData(mesh, frame)
  },

  fillBuffers(comp: UIRenderer, renderer: unknown): void {
    void renderer
    const mesh = comp as AnimatorGoMesh
    const rd = mesh.renderData
    const frame = mesh.spriteFrame
    if (!rd || !rd.chunk || !frame) return
    const chunk = rd.chunk
    const n = writeVertices(mesh, rd, frame)
    const idx = mesh._idx
    const ib = mesh._indexBuffer()
    const ic = n < mesh._vertexCount ? 0 : Math.min(mesh._indexCount, ib.length)
    const base = chunk.vertexOffset
    for (let k = 0; k < ic; k++) ib[k] = base + idx[k]
    chunk.vertexAccessor.appendIndices(chunk.bufferId, ib.subarray(0, ic))
  },

  updateColor(): void {
    // 颜色每帧随顶点一起写(writeVertices),这里不用做
  },
}
