import { describe, expect, it } from 'vitest'
import { Skeleton } from './Skeleton.ts'
import { fromTRS, identity, invert, multiply, shortestAngleDelta, transformPoint } from './math.ts'
import type { BoneData, SkeletonData } from './types.ts'

function bone(name: string, parent: number, x: number, y: number, rotation: number): BoneData {
  return {
    name, parent, x, y, rotation,
    scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, length: 10,
    inheritRotation: true, inheritScale: true,
  }
}

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6)

describe('math', () => {
  it('绕原点旋转 90° 时逆时针为正(Y 向上)', () => {
    const m = fromTRS(identity(), 0, 0, 90, 1, 1)
    const [x, y] = transformPoint(m, 1, 0)
    near(x, 0)
    near(y, 1) // +X 转到 +Y —— 逆时针
  })

  it('变换顺序为 T * R * S', () => {
    const m = fromTRS(identity(), 100, 0, 90, 2, 2)
    const [x, y] = transformPoint(m, 1, 0)
    near(x, 100) // 先缩放到 (2,0),再转到 (0,2),最后平移
    near(y, 2)
  })

  it('求逆后往返回到原点', () => {
    const m = fromTRS(identity(), 33, -7, 41, 1.5, 0.8, 12, -5)
    const inv = identity()
    expect(invert(inv, m)).toBe(true)

    const [px, py] = transformPoint(m, 9, -4)
    const [rx, ry] = transformPoint(inv, px, py)
    near(rx, 9)
    near(ry, -4)
  })

  it('矩阵不可逆时返回 false', () => {
    expect(invert(identity(), fromTRS(identity(), 0, 0, 0, 0, 1))).toBe(false)
  })

  it('旋转差值走最短路径', () => {
    near(shortestAngleDelta(350, 10), 20)   // 不是 -340
    near(shortestAngleDelta(10, 350), -20)  // 不是 +340
    near(shortestAngleDelta(0, 180), 180)   // 边界取正
  })

  it('multiply 的结果等价于依次变换', () => {
    const a = fromTRS(identity(), 10, 5, 30, 1, 1)
    const b = fromTRS(identity(), -3, 8, 15, 2, 2)
    const [ax, ay] = transformPoint(b, 4, 1)
    const expected = transformPoint(a, ax, ay)
    const actual = transformPoint(multiply(identity(), a, b), 4, 1)
    near(actual[0], expected[0])
    near(actual[1], expected[1])
  })
})

describe('Skeleton 世界变换', () => {
  const data: SkeletonData = {
    name: 't',
    bones: [
      bone('root', -1, 0, 0, 0),
      bone('a', 0, 100, 0, 90),   // 在 root 右侧 100,自转 90°
      bone('b', 1, 50, 0, 0),     // 沿 a 的局部 +X 再走 50
    ],
    slots: [], skins: new Map(), defaultSkin: 'default',
  }

  it('子骨骼继承父骨骼的旋转', () => {
    const s = new Skeleton(data)
    s.updateWorldTransform()

    const b = s.getBone('b')!
    // a 转了 90°,所以 b 的局部 +X 偏移变成世界 +Y
    near(b.worldX, 100)
    near(b.worldY, 50)
  })

  it('worldToParent 是世界变换的逆运算', () => {
    const s = new Skeleton(data)
    s.updateWorldTransform()

    const b = s.getBone('b')!
    const [px, py] = b.worldToParent(b.worldX, b.worldY)
    near(px, b.x) // 换算回父空间应当回到自身的局部坐标
    near(py, b.y)
  })

  it('父骨骼下标不小于自身时报错(而非静默出错)', () => {
    expect(
      () => new Skeleton({ ...data, bones: [bone('x', 1, 0, 0, 0), bone('y', -1, 0, 0, 0)] }),
    ).toThrow(/必须按层级排序/)
  })

  it('未实现的继承标志会报错而不是被忽略', () => {
    const bad = { ...bone('r', -1, 0, 0, 0), inheritScale: false }
    expect(() => new Skeleton({ ...data, bones: [bad] })).toThrow(/尚未实现/)
  })
})
