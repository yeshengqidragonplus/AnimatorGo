import { describe, expect, it } from 'vitest'
import { Skeleton } from './Skeleton.ts'
import { applyAnimation, putKeyframe, removeKeyframe, samplePose, type AnimationData } from './animation.ts'
import type { BoneData, SkeletonData } from './types.ts'

function bone(name: string, parent: number, rotation = 0, x = 0): BoneData {
  return {
    name, parent, x, y: 0, rotation,
    scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, length: 20,
    inheritRotation: true, inheritScale: true,
  }
}

const DATA: SkeletonData = {
  name: 't',
  bones: [bone('root', -1), bone('arm', 0, 30, 10), bone('leg', 0, -45, 5)],
  slots: [], skins: new Map(), defaultSkin: 'default',
}

function anim(bones: AnimationData['bones'], duration = 1): AnimationData {
  return { name: 'a', duration, bones }
}

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 5)

describe('关键帧语义', () => {
  it('rotate 是相对绑定姿势的偏移,不是绝对值', () => {
    const s = new Skeleton(DATA)
    // arm 的绑定姿势旋转是 30°
    applyAnimation(s, anim(new Map([['arm', { rotate: [{ time: 0, value: 90 }] }]])), 0)
    near(s.getBone('arm')!.rotation, 120) // 30 + 90,不是 90
  })

  it('scale 是乘不是加', () => {
    const data: SkeletonData = {
      ...DATA,
      bones: [bone('root', -1), { ...bone('arm', 0), scaleX: 2, scaleY: 3 }],
    }
    const s = new Skeleton(data)
    applyAnimation(s, anim(new Map([['arm', { scale: [{ time: 0, x: 0.5, y: 2 }] }]])), 0)
    near(s.getBone('arm')!.scaleX, 1) // 2 × 0.5
    near(s.getBone('arm')!.scaleY, 6) // 3 × 2
  })

  it('translate 叠加在绑定姿势位置上', () => {
    const s = new Skeleton(DATA)
    applyAnimation(s, anim(new Map([['arm', { translate: [{ time: 0, x: 7, y: -3 }] }]])), 0)
    near(s.getBone('arm')!.x, 17) // 绑定 10 + 7
    near(s.getBone('arm')!.y, -3)
  })

  it('shear 叠加在绑定姿势上', () => {
    const data: SkeletonData = {
      ...DATA,
      bones: [bone('root', -1), { ...bone('arm', 0), shearX: 5, shearY: -5 }],
    }
    const s = new Skeleton(data)
    applyAnimation(s, anim(new Map([['arm', { shear: [{ time: 0, x: 10, y: 20 }] }]])), 0)
    near(s.getBone('arm')!.shearX, 15) // 5 + 10
    near(s.getBone('arm')!.shearY, 15) // -5 + 20
  })

  it('没有时间轴的骨骼保持绑定姿势', () => {
    const s = new Skeleton(DATA)
    applyAnimation(s, anim(new Map([['arm', { rotate: [{ time: 0, value: 90 }] }]])), 0)
    near(s.getBone('leg')!.rotation, -45) // 绑定值,不是 0
  })

  it('apply 是幂等的 —— 连调两次结果相同', () => {
    const s = new Skeleton(DATA)
    const a = anim(new Map([['arm', { rotate: [{ time: 0, value: 10 }, { time: 1, value: 50 }] }]]))
    applyAnimation(s, a, 0.5)
    const once = s.getBone('arm')!.rotation
    applyAnimation(s, a, 0.5)
    near(s.getBone('arm')!.rotation, once)
  })
})

describe('插值', () => {
  const rotate = (keys: { time: number; value: number; curve?: never }[]) =>
    anim(new Map([['arm', { rotate: keys }]]))

  const at = (a: AnimationData, t: number) => {
    const s = new Skeleton(DATA)
    applyAnimation(s, a, t)
    return s.getBone('arm')!.rotation - 30 // 减掉绑定姿势,只看动画偏移
  }

  it('线性插值', () => {
    const a = rotate([{ time: 0, value: 0 }, { time: 1, value: 100 }])
    near(at(a, 0), 0)
    near(at(a, 0.25), 25)
    near(at(a, 1), 100)
  })

  it('第一帧之前保持第一帧,最后一帧之后保持末值', () => {
    const a = rotate([{ time: 1, value: 40 }, { time: 2, value: 80 }])
    near(at(a, 0), 40)
    near(at(a, 5), 80)
  })

  it('stepped 保持前值直到下一帧', () => {
    const a = anim(new Map([['arm', {
      rotate: [{ time: 0, value: 0, curve: 'stepped' as const }, { time: 1, value: 100 }],
    }]]))
    near(at(a, 0.99), 0)
    near(at(a, 1), 100)
  })

  it('关键帧之间旋转走最短路径', () => {
    const a = rotate([{ time: 0, value: 350 }, { time: 1, value: 10 }])
    near(at(a, 0.5), 360) // 350 + 20×0.5 = 360,不是走 -340 到 180
  })

  it('贝塞尔曲线过端点,中段被缓动', () => {
    const a = anim(new Map([['arm', {
      rotate: [
        { time: 0, value: 0, curve: [0.75, 0, 0.25, 1] as const }, // ease-in-out
        { time: 1, value: 100 },
      ],
    }]]))
    near(at(a, 0), 0)
    near(at(a, 1), 100)
    near(at(a, 0.5), 50) // 对称曲线的中点仍是 50
    expect(at(a, 0.25)).toBeLessThan(25) // 起步慢
    expect(at(a, 0.75)).toBeGreaterThan(75) // 收尾快
  })

  it('单个关键帧时全程保持该值', () => {
    const a = rotate([{ time: 0.5, value: 42 }])
    near(at(a, 0), 42)
    near(at(a, 0.5), 42)
    near(at(a, 9), 42)
  })
})

describe('samplePose', () => {
  it('返回各通道在时刻 t 的偏移,没有时间轴的通道给单位值', () => {
    const a = anim(new Map([['arm', {
      rotate: [{ time: 0, value: 0 }, { time: 1, value: 100 }],
      scale: [{ time: 0, x: 2, y: 4 }],
    }]]))
    const pose = samplePose(a, 'arm', 0.5)
    near(pose.rotation, 50)
    near(pose.scaleX, 2)
    near(pose.scaleY, 4)
    // 没碰过的通道:translate/shear 是 0
    near(pose.x, 0)
    near(pose.shearX, 0)
  })

  it('完全没有时间轴的骨骼返回单位偏移(scale 为 1)', () => {
    const pose = samplePose(anim(new Map()), 'arm', 0.5)
    near(pose.rotation, 0)
    near(pose.scaleX, 1)
    near(pose.scaleY, 1)
  })
})

describe('关键帧编辑', () => {
  it('按时间插入到正确位置,保持有序', () => {
    let keys = [{ time: 0, value: 0 }, { time: 2, value: 20 }]
    keys = putKeyframe(keys, { time: 1, value: 10 })
    expect(keys.map((k) => k.time)).toEqual([0, 1, 2])
  })

  it('同一时刻的关键帧被替换而不是重复插入', () => {
    let keys = [{ time: 0, value: 0 }, { time: 1, value: 10 }]
    keys = putKeyframe(keys, { time: 1, value: 99 })
    expect(keys).toHaveLength(2)
    expect(keys[1]!.value).toBe(99)
  })

  it('浮点时间的微小误差算同一帧', () => {
    let keys = [{ time: 0.3, value: 1 }]
    keys = putKeyframe(keys, { time: 0.3 + 1e-9, value: 2 })
    expect(keys).toHaveLength(1)
    expect(keys[0]!.value).toBe(2)
  })

  it('不修改原数组', () => {
    const keys = [{ time: 0, value: 0 }]
    const next = putKeyframe(keys, { time: 1, value: 10 })
    expect(keys).toHaveLength(1)
    expect(next).toHaveLength(2)
  })

  it('删除关键帧', () => {
    const keys = [{ time: 0, value: 0 }, { time: 1, value: 10 }]
    expect(removeKeyframe(keys, 1)).toHaveLength(1)
    expect(removeKeyframe(keys, 5)).toHaveLength(2) // 不存在时是空操作
  })
})
