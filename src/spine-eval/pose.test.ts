import { describe, expect, it } from 'vitest'
import type { BoneRecord, SkeletonPart } from '../spine-format/binary/readSkeleton.ts'
import type { AnimationData } from '../spine-format/binary/readAnimations.ts'
import { applyPoint, invert, multiply, poseAt, setupPose, timelineValue, valueBetween, worldTransforms, setupLocals } from './pose.ts'

const bone = (over: Partial<BoneRecord> & { name: string; parent: number }): BoneRecord => ({
  rotation: 0,
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  shearX: 0,
  shearY: 0,
  length: 0,
  transformMode: 0,
  skinRequired: false,
  ...over,
})

function skeleton(bones: BoneRecord[], animations: AnimationData[] = [], major: '3.8' | '4.x' = '3.8'): SkeletonPart {
  return {
    header: { major } as SkeletonPart['header'],
    strings: [],
    bones,
    slots: [],
    ik: [],
    transform: [],
    path: [],
    skins: [],
    events: [],
    animations,
    failure: null,
    endOffset: 0,
    totalBytes: 0,
  }
}

const anim = (timelines: AnimationData['timelines']): AnimationData => ({
  name: 'a',
  timelines,
  endOffset: 0,
  sectionOffsets: [],
})

describe('姿势求值', () => {
  it('父子链:子骨骼的局部原点落在父骨骼的末端', () => {
    const bones = [bone({ name: 'root', parent: -1, x: 10, y: 20 }), bone({ name: 'arm', parent: 0, x: 100, rotation: 90 })]
    const pose = setupPose(skeleton(bones))
    expect(applyPoint(pose[1]!, 0, 0)).toEqual({ x: 110, y: 20 })
    // arm 转了 90°,它局部 x 轴的正方向在世界里朝上
    const tip = applyPoint(pose[1]!, 50, 0)
    expect(tip.x).toBeCloseTo(110, 6)
    expect(tip.y).toBeCloseTo(70, 6)
  })

  it('父骨骼的缩放和旋转会传给子骨骼(默认继承),onlyTranslation 只传位置', () => {
    const parent = bone({ name: 'p', parent: -1, rotation: 90, scaleX: 2 })
    const normal = bone({ name: 'c', parent: 0, x: 10 })
    const onlyT = bone({ name: 'c2', parent: 0, x: 10, transformMode: 1 })
    const pose = setupPose(skeleton([parent, normal, onlyT]))
    // 子原点:父先缩放 x×2 再转 90° → (0, 20)
    expect(applyPoint(pose[1]!, 0, 0).x).toBeCloseTo(0, 6)
    expect(applyPoint(pose[1]!, 0, 0).y).toBeCloseTo(20, 6)
    // 默认继承:子的 x 轴也被转成朝上并放大 2 倍
    expect(applyPoint(pose[1]!, 1, 0).y).toBeCloseTo(22, 6)
    // onlyTranslation:原点一样,但自己的轴不转不缩
    expect(applyPoint(pose[2]!, 0, 0).y).toBeCloseTo(20, 6)
    expect(applyPoint(pose[2]!, 1, 0).x).toBeCloseTo(1, 6)
    expect(applyPoint(pose[2]!, 1, 0).y).toBeCloseTo(20, 6)
  })

  it('unityCompatible:忽略 shear 与继承模式', () => {
    const bones = [bone({ name: 'p', parent: -1, shearX: 30 }), bone({ name: 'c', parent: 0, x: 10, transformMode: 1 })]
    const sk = skeleton(bones)
    const spine = setupPose(sk)
    const unity = setupPose(sk, { unityCompatible: true })
    expect(spine[0]!.a).not.toBeCloseTo(unity[0]!.a, 6)
    expect(unity[0]!.a).toBeCloseTo(1, 9)
    expect(unity[0]!.c).toBeCloseTo(0, 9)
  })

  it('invert 与 multiply 互为逆', () => {
    const m = worldTransforms([bone({ name: 'b', parent: -1, x: 3, y: -4, rotation: 37, scaleX: 1.5, scaleY: 0.5 })], setupLocals([
      bone({ name: 'b', parent: -1, x: 3, y: -4, rotation: 37, scaleX: 1.5, scaleY: 0.5 }),
    ]))[0]!
    const id = multiply(m, invert(m)!)
    expect(id.a).toBeCloseTo(1, 9)
    expect(id.b).toBeCloseTo(0, 9)
    expect(id.c).toBeCloseTo(0, 9)
    expect(id.d).toBeCloseTo(1, 9)
    expect(id.x).toBeCloseTo(0, 9)
    expect(id.y).toBeCloseTo(0, 9)
  })
})

describe('时间轴取值', () => {
  const frames = [
    { time: 0, value: 0, curve: 'linear' },
    { time: 1, value: 10, curve: 'stepped' },
    { time: 2, value: 20, curve: 'bezier', beziers: [[0.9, 0.1, 0.9, 0.1]] }, // 3.8 归一化:前慢后快
    { time: 3, value: 30 },
  ]

  it('线性 / 阶梯 / 首尾之外', () => {
    expect(timelineValue(frames, 'value', -1, true)).toBeNull()
    expect(timelineValue(frames, 'value', 0.5, true)).toBeCloseTo(5, 9)
    expect(timelineValue(frames, 'value', 1.5, true)).toBe(10) // 阶梯保持前一帧
    expect(timelineValue(frames, 'value', 99, true)).toBe(30)
  })

  it('3.8 归一化贝塞尔:控制点压在起点附近 → 中点的值明显落后于线性', () => {
    const mid = valueBetween(frames, 2, 'value', 2.5, true)
    expect(mid).toBeGreaterThan(20)
    expect(mid).toBeLessThan(25) // 线性会是 25
    // 端点不受曲线影响
    expect(valueBetween(frames, 2, 'value', 2, true)).toBeCloseTo(20, 6)
    expect(valueBetween(frames, 2, 'value', 3, true)).toBeCloseTo(30, 6)
  })

  it('4.x 绝对贝塞尔:同一形状的曲线给出同一结果', () => {
    // 把上面那段归一化控制点换算成绝对坐标:x 在 [2,3],y 在 [20,30]
    const abs = [
      { time: 2, value: 20, curve: 'bezier', beziers: [[2.9, 21, 2.9, 21]] },
      { time: 3, value: 30 },
    ]
    expect(valueBetween(abs, 0, 'value', 2.5, false)).toBeCloseTo(valueBetween(frames, 2, 'value', 2.5, true), 6)
  })

  it('poseAt:旋转是偏移、缩放是倍率、第一帧之前用绑定姿势', () => {
    const bones = [bone({ name: 'b', parent: -1, rotation: 10, scaleX: 2 })]
    const a = anim([
      { kind: 'rotate', owner: 0, bezierCount: -1, frames: [{ time: 1, value: 20 }, { time: 2, value: 40 }] },
      { kind: 'scale', owner: 0, bezierCount: -1, frames: [{ time: 1, x: 1.5, y: 1 }, { time: 2, x: 1.5, y: 1 }] },
    ])
    const sk = skeleton(bones, [a])
    const before = poseAt(sk, a, 0)
    const setup = setupPose(sk)
    expect(before[0]).toEqual(setup[0])

    const at = poseAt(sk, a, 1.5)
    // 旋转 10 + 30 = 40°,x 缩放 2 × 1.5 = 3
    expect(Math.atan2(at[0]!.c, at[0]!.a) / (Math.PI / 180)).toBeCloseTo(40, 6)
    expect(Math.hypot(at[0]!.a, at[0]!.c)).toBeCloseTo(3, 6)
  })
})
