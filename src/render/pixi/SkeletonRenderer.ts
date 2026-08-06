import { Graphics } from 'pixi.js'
import type { Bone, Skeleton } from '@core/index.ts'
import { transformPoint } from '@core/index.ts'

/**
 * 把骨架画出来。**这一层可以依赖 PixiJS —— core/ 不行。**
 *
 * 它只读 Skeleton 的世界变换,不修改任何东西。移植到别的引擎时,
 * 只有这个文件需要重写。
 */

const COLOR_BONE = 0x6b7a99
const COLOR_BONE_SELECTED = 0xffb454
const COLOR_JOINT = 0x2a3142
const COLOR_JOINT_ROOT = 0x8899bb

/** 骨骼根部的半宽,按长度缩放但设上限,免得长骨骼画得太胖 */
function shoulderWidth(length: number): number {
  return Math.min(length * 0.15, 7)
}

function boneOutline(bone: Bone): [number, number][] {
  const len = bone.data.length
  const w = shoulderWidth(len)
  // 骨骼在自身局部空间里沿 +X 延伸
  return [
    transformPoint(bone.world, 0, 0),
    transformPoint(bone.world, w, w),
    transformPoint(bone.world, len, 0),
    transformPoint(bone.world, w, -w),
  ]
}

export class SkeletonRenderer {
  readonly graphics = new Graphics()

  /** 调用前 skeleton 必须已经 updateWorldTransform() 过 */
  draw(skeleton: Skeleton, selectedBoneName: string | null): void {
    const g = this.graphics
    g.clear()

    for (const bone of skeleton.bones) {
      if (bone.data.length <= 0) continue // 根骨骼等无长度骨骼只画关节点

      const selected = bone.data.name === selectedBoneName
      const pts = boneOutline(bone)

      g.moveTo(pts[0]![0], pts[0]![1])
      g.lineTo(pts[1]![0], pts[1]![1])
      g.lineTo(pts[2]![0], pts[2]![1])
      g.lineTo(pts[3]![0], pts[3]![1])
      g.closePath()
      g.fill({ color: selected ? COLOR_BONE_SELECTED : COLOR_BONE, alpha: selected ? 0.95 : 0.7 })
      g.stroke({ width: 1, color: selected ? COLOR_BONE_SELECTED : COLOR_JOINT, alpha: 0.9 })
    }

    // 关节点画在骨骼之上,避免被子骨骼盖住
    for (const bone of skeleton.bones) {
      const isRoot = bone.parent === null
      const selected = bone.data.name === selectedBoneName
      g.circle(bone.worldX, bone.worldY, isRoot ? 5 : 3.5)
      g.fill({ color: selected ? COLOR_BONE_SELECTED : isRoot ? COLOR_JOINT_ROOT : COLOR_JOINT })
      g.stroke({ width: 1, color: 0xdde3ee, alpha: 0.55 })
    }
  }

  destroy(): void {
    this.graphics.destroy()
  }
}
