import { _decorator, CCFloat, CCInteger, Component, Node, director } from 'cc'
import { MAT_STRIDE, combineShapes, influenceCount, skinVertices, triangulate } from './AnimatorGoSkinning'

const { ccclass, property, executeInEditMode } = _decorator

/**
 * Spine 的 clipping 遮罩。挂在遮罩 attachment 的节点上(和图片部件一样,节点 `active` 由换图时间轴驱动);
 * 多边形的顶点和网格同一种表达(骨骼 + 影响 + deform shape),每帧算成世界坐标再三角化。
 *
 * 谁被遮由绘制顺序定(Spine 的规则,`clipCovers`):`order` 是遮罩 slot 在绘制顺序里的位置,`endOrder` 是 endSlot 的;
 * 绘制顺序动画改了位置,导出器给这两个属性写阶梯轨道。被遮的 `AnimatorGoMesh` 自己来问这个组件要多边形。
 */
@ccclass('AnimatorGoClip')
@executeInEditMode
export class AnimatorGoClip extends Component {
  @property({ type: [Node], tooltip: '影响里引用的骨骼节点' })
  bones: Node[] = []

  @property({ type: [CCInteger], visible: false })
  counts: number[] = []

  @property({ type: [CCFloat], visible: false })
  influences: number[] = []

  @property({ type: [CCFloat], visible: false })
  shapes: number[] = []

  @property({ type: [CCFloat], tooltip: 'deform 各 shape 的权重(动画驱动)' })
  shapeWeights: number[] = []

  @property({ type: CCInteger, tooltip: '遮罩 slot 在绘制顺序里的位置' })
  order = 0

  @property({ type: CCInteger, tooltip: 'endSlot 在绘制顺序里的位置;不大于 order 就裁到最后' })
  endOrder = 0

  private _frame = -1
  private _mats = new Float32Array(0)
  private _offsets = new Float32Array(0)
  private _polygon = new Float32Array(0)
  private _triangles: number[] = []

  /** 这一帧的世界多边形(平铺 x,y)和它的三角形;一帧只算一次 */
  polygon(): { xy: Float32Array; count: number; triangles: number[] } {
    const frame = director.getTotalFrames()
    if (frame !== this._frame) {
      this._frame = frame
      this._compute()
    }
    return { xy: this._polygon, count: this.counts.length, triangles: this._triangles }
  }

  private _compute(): void {
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
    }
    const flat = influenceCount(this.counts) * 2
    if (this._offsets.length < flat) this._offsets = new Float32Array(flat)
    const deformed = combineShapes(this.shapes, flat, this.shapeWeights, this._offsets)
    const n = this.counts.length
    if (this._polygon.length < n * 2) this._polygon = new Float32Array(n * 2)
    skinVertices(this.counts, this.influences, mats, deformed ? this._offsets : null, this._polygon)
    triangulate(this._polygon, n, this._triangles)
  }
}
