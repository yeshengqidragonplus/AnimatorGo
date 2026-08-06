import { Bone } from './Bone.ts'
import type { SkeletonData } from './types.ts'

/**
 * 骨架的**运行时实例**。
 *
 * 一份 SkeletonData 可以创建多个 Skeleton —— 屏幕上十个小兵共享同一份数据,
 * 各自有独立的姿势。
 */
export class Skeleton {
  readonly data: SkeletonData
  readonly bones: Bone[] = []
  private readonly boneByName = new Map<string, Bone>()

  constructor(data: SkeletonData) {
    this.data = data

    for (let i = 0; i < data.bones.length; i++) {
      const boneData = data.bones[i]!

      if (boneData.parent >= i) {
        throw new Error(
          `骨骼 "${boneData.name}" 的父骨骼下标 ${boneData.parent} 不小于自身下标 ${i}。` +
            `SkeletonData.bones 必须按层级排序,父骨骼排在子骨骼之前。`,
        )
      }

      // 静默忽略会导致「动画看着有点怪但说不出哪里怪」,所以宁可炸掉
      if (!boneData.inheritRotation || !boneData.inheritScale) {
        throw new Error(
          `骨骼 "${boneData.name}" 使用了非默认的继承标志,但该功能尚未实现。` +
            `见 docs/FORMAT.md「缩放继承」。`,
        )
      }

      const parent = boneData.parent < 0 ? null : this.bones[boneData.parent]!
      const bone = new Bone(boneData, parent)
      this.bones.push(bone)
      this.boneByName.set(boneData.name, bone)
    }
  }

  /**
   * 更新所有骨骼的世界变换。
   *
   * 因为 bones 保证按层级排序(构造时已校验),单遍正序遍历即可 —— 轮到某根骨骼时
   * 它的父骨骼一定已经更新过了。不需要递归。
   */
  updateWorldTransform(): void {
    for (const bone of this.bones) {
      bone.updateWorldTransform()
    }
  }

  setToSetupPose(): void {
    for (const bone of this.bones) {
      bone.setToSetupPose()
    }
  }

  getBone(name: string): Bone | undefined {
    return this.boneByName.get(name)
  }

  get rootBone(): Bone | undefined {
    return this.bones[0]
  }
}
