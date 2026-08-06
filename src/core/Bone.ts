import { fromTRS, identity, invert, multiply, transformPoint, type Mat2d } from './math.ts'
import type { BoneData } from './types.ts'

/**
 * 骨骼的**运行时实例**。
 *
 * 姿势字段(x / rotation / scaleX ...)是「绑定姿势 + 动画偏移」之后的当前值。
 * 动画时间轴写入这些字段,然后 Skeleton.updateWorldTransform() 算出世界矩阵。
 *
 * 见 docs/FORMAT.md:关键帧语义是**相对绑定姿势的偏移**——
 *   translate / rotate / shear 是加,scale 是乘。
 */
export class Bone {
  readonly data: BoneData
  readonly parent: Bone | null
  readonly children: Bone[] = []

  // 当前姿势(局部空间)
  x = 0
  y = 0
  rotation = 0
  scaleX = 1
  scaleY = 1
  shearX = 0
  shearY = 0

  readonly local: Mat2d = identity()
  readonly world: Mat2d = identity()

  constructor(data: BoneData, parent: Bone | null) {
    this.data = data
    this.parent = parent
    parent?.children.push(this)
    this.setToSetupPose()
  }

  setToSetupPose(): void {
    const d = this.data
    this.x = d.x
    this.y = d.y
    this.rotation = d.rotation
    this.scaleX = d.scaleX
    this.scaleY = d.scaleY
    this.shearX = d.shearX
    this.shearY = d.shearY
  }

  /** 由当前姿势算出 local,再乘上父骨骼的 world。父骨骼必须已经更新过。 */
  updateWorldTransform(): void {
    fromTRS(this.local, this.x, this.y, this.rotation, this.scaleX, this.scaleY, this.shearX, this.shearY)
    if (this.parent === null) {
      this.world[0] = this.local[0]
      this.world[1] = this.local[1]
      this.world[2] = this.local[2]
      this.world[3] = this.local[3]
      this.world[4] = this.local[4]
      this.world[5] = this.local[5]
    } else {
      multiply(this.world, this.parent.world, this.local)
    }
  }

  get worldX(): number {
    return this.world[4]
  }

  get worldY(): number {
    return this.world[5]
  }

  /** 骨骼末端的世界坐标。骨骼沿自身 +X 方向延伸 length。 */
  tipWorld(): [number, number] {
    return transformPoint(this.world, this.data.length, 0)
  }

  /**
   * 把世界坐标换算到本骨骼的**父空间**。
   *
   * 编辑器拖动骨骼时用:鼠标在世界空间,但要写回的是局部姿势。
   */
  worldToParent(x: number, y: number): [number, number] {
    if (this.parent === null) return [x, y]
    const inv = identity()
    if (!invert(inv, this.parent.world)) return [x, y]
    return transformPoint(inv, x, y)
  }
}
