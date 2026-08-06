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
 */
export const SAMPLE_SKELETON: SkeletonData = {
  name: 'sample',
  bones: [
    bone('root', -1, 0, 0, 0, 0),
    bone('hip', 0, 0, 0, 90, 60),
    bone('torso', 1, 60, 0, 0, 70),
    bone('head', 2, 70, 0, 0, 40),
    bone('arm_l', 2, 55, 12, 65, 50),
    bone('forearm_l', 4, 50, 0, 45, 45),
    bone('arm_r', 2, 55, -12, -65, 50),
    bone('forearm_r', 6, 50, 0, -45, 45),
    bone('thigh_l', 1, 0, 14, -75, 55),
    bone('shin_l', 8, 55, 0, -20, 50),
    bone('thigh_r', 1, 0, -14, -105, 55),
    bone('shin_r', 10, 55, 0, 20, 50),
  ],
  slots: [],
  skins: new Map(),
  defaultSkin: 'default',
}
