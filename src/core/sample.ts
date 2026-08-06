import type { BoneData, SkeletonData } from './types.ts'

/** 省掉在 fixture 里重复写默认值 */
function bone(
  name: string,
  parent: number,
  x: number,
  y: number,
  rotation: number,
  length: number,
): BoneData {
  return {
    name,
    parent,
    x,
    y,
    rotation,
    scaleX: 1,
    scaleY: 1,
    shearX: 0,
    shearY: 0,
    length,
    inheritRotation: true,
    inheritScale: true,
  }
}

/**
 * 手写的临时骨架,用来验证层级变换。图集导入做好之后就删掉。
 *
 * ⚠️ bones 必须按层级排序(父在子之前),Skeleton 构造时会校验。
 *
 * 角度是**相对父骨骼**的。hip 朝上(世界 90°),所以它的子骨骼要朝下就得写
 * 接近 ±175 而不是 -90 —— 世界角 = 父世界角 + 局部角。
 */
export const SAMPLE_SKELETON: SkeletonData = {
  name: 'sample',
  bones: [
    //   名字          父  x   y   局部旋转  长度      世界朝向
    bone('root', -1, 0, 0, 0, 0),
    bone('hip', 0, 0, 0, 90, 60), //           上
    bone('torso', 1, 60, 0, 0, 70), //           上
    bone('head', 2, 70, 0, 0, 40), //           上
    bone('arm_l', 2, 55, 12, 145, 50), //     左下
    bone('forearm_l', 4, 50, 0, 25, 45), //       下
    bone('arm_r', 2, 55, -12, -145, 50), //     右下
    bone('forearm_r', 6, 50, 0, -25, 45), //       下
    bone('thigh_l', 1, 0, 14, 175, 55), //       下
    bone('shin_l', 8, 55, 0, 8, 50), //       下
    bone('thigh_r', 1, 0, -14, -175, 55), //       下
    bone('shin_r', 10, 55, 0, -8, 50), //       下
  ],
  slots: [],
  skins: new Map(),
  defaultSkin: 'default',
}
