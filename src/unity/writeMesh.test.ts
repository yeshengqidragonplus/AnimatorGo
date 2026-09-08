import { crc32 as zlibCrc32 } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { crc32 } from './crc32.ts'
import { invert, type Affine } from '../spine-eval/pose.ts'
import { parseMesh, writeMesh, type MeshAsset } from './writeMesh.ts'

describe('CRC32', () => {
  it('与 zlib 一致,且对上 Unity 实测的 nameHash', () => {
    for (const s of ['shape0', 'shape1', 'm_SortingOrder', 'spr', 'skin', 'blendShape.idle_0', '中文']) {
      expect(crc32(s)).toBe(zlibCrc32(s) >>> 0)
    }
    // tools/unity/AnimatorGoProbe.cs 存出来的样本:shape0 → 2081338680,m_SortingOrder → 3762991556
    expect(crc32('shape0')).toBe(2081338680)
    expect(crc32('m_SortingOrder')).toBe(3762991556)
  })
})

/** 与排查样本同构的网格:6 顶点、6 根骨骼,v5 绑 6 根,两个形变目标 */
function sample(): MeshAsset {
  const bones: Affine[] = []
  for (let i = 0; i < 6; i++) {
    const r = (i * 10 * Math.PI) / 180
    const sx = i === 1 ? 2 : 1
    const sy = i === 1 ? 0.5 : 1
    bones.push({ a: Math.cos(r) * sx, b: -Math.sin(r) * sy, c: Math.sin(r) * sx, d: Math.cos(r) * sy, x: i * 0.25, y: i * 0.5 })
  }
  const white = { r: 1, g: 1, b: 1, a: 1 }
  const xy = [
    [-0.5, 0],
    [0.5, 0],
    [-0.5, 1],
    [0.5, 1],
    [-0.5, 2],
    [0.5, 2],
  ]
  return {
    name: 'probe',
    vertices: xy.map(([x, y]) => ({ x: x!, y: y!, u: x! + 0.5, v: y! / 2, color: white })),
    triangles: [0, 2, 1, 1, 2, 3, 2, 4, 3, 3, 4, 5],
    bindposes: bones.map((b) => invert(b)!),
    weights: [
      [{ bone: 0, weight: 1 }],
      [{ bone: 0, weight: 1 }],
      [{ bone: 1, weight: 1 }],
      [{ bone: 1, weight: 1 }],
      [{ bone: 2, weight: 1 }],
      [
        { bone: 0, weight: 0.3 },
        { bone: 1, weight: 0.25 },
        { bone: 2, weight: 0.2 },
        { bone: 3, weight: 0.1 },
        { bone: 4, weight: 0.09 },
        { bone: 5, weight: 0.06 },
      ],
    ],
    blendShapes: [
      { name: 'shape0', deltas: [{ index: 4, x: 1, y: 0 }, { index: 5, x: 1, y: 0 }] },
      { name: 'shape1', deltas: [{ index: 0, x: 0, y: -1 }] },
    ],
  }
}

describe('Mesh 资产', () => {
  const mesh = sample()
  const yaml = writeMesh(mesh)
  const back = parseMesh(yaml)

  it('结构与真实样本一致:classID 43、serializedVersion 12、三个 stream、14 个通道', () => {
    expect(yaml.startsWith('%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!43 &4300000\nMesh:')).toBe(true)
    expect(yaml).toContain('  serializedVersion: 12')
    expect((yaml.match(/^    - stream: /gm) ?? []).length).toBe(14)
    // 6 顶点:72 → 80,72 → 80,96 → 共 256 字节,与 Unity 自己存出来的一样
    expect(yaml).toContain('    m_DataSize: 256')
    expect(yaml).toContain('  m_IndexBuffer: 000002000100010002000300020004000300030004000500')
  })

  it('顶点 / UV / 颜色 / 三角形逐个回读一致', () => {
    expect(back.vertexCount).toBe(6)
    back.positions.forEach((p, i) => {
      expect(p.x).toBeCloseTo(mesh.vertices[i]!.x, 6)
      expect(p.y).toBeCloseTo(mesh.vertices[i]!.y, 6)
    })
    back.uvs.forEach((uv, i) => {
      expect(uv.u).toBeCloseTo(mesh.vertices[i]!.u, 6)
      expect(uv.v).toBeCloseTo(mesh.vertices[i]!.v, 6)
    })
    expect(back.colors.every((c) => c.r === 1 && c.a === 1)).toBe(true)
    expect(back.triangles).toEqual(mesh.triangles)
  })

  it('绑定矩阵回读一致', () => {
    expect(back.bindposes.length).toBe(6)
    back.bindposes.forEach((m, i) => {
      const src = mesh.bindposes[i]!
      for (const k of ['a', 'b', 'c', 'd', 'x', 'y'] as const) expect(m[k]).toBeCloseTo(src[k], 5)
    })
  })

  it('⭐ 顶点流只放前 4 根且归一到 65535;完整权重另存,6 根都在', () => {
    const v5 = back.streamWeights[5]!
    expect(v5.length).toBe(4)
    expect(v5.map((w) => w.bone)).toEqual([0, 1, 2, 3])
    expect(v5.reduce((n, w) => n + w.weight, 0)).toBeCloseTo(1, 4)
    // 0.30 / 0.85 = 0.3529 —— 与 Unity 样本里的 0x5a5a 一致
    expect(v5[0]!.weight).toBeCloseTo(0.3 / 0.85, 3)

    const full = back.fullWeights[5]!
    expect(full.length).toBe(6)
    expect(full.map((w) => w.bone)).toEqual([0, 1, 2, 3, 4, 5])
    expect(full.reduce((n, w) => n + w.weight, 0)).toBeCloseTo(1, 4)
    expect(full[0]!.weight).toBeCloseTo(0.3, 3)
    expect(full[5]!.weight).toBeCloseTo(0.06, 3)
    // 单根骨骼的顶点:权重正好是 65535/65535
    expect(back.fullWeights[0]).toEqual([{ bone: 0, weight: 1 }])
  })

  it('Blend Shape 稀疏存储,nameHash 是 CRC32', () => {
    expect(back.blendShapes.length).toBe(2)
    expect(back.blendShapes[0]!.name).toBe('shape0')
    expect(back.blendShapes[0]!.nameHash).toBe(2081338680)
    expect(back.blendShapes[0]!.deltas).toEqual([
      { index: 4, x: 1, y: 0 },
      { index: 5, x: 1, y: 0 },
    ])
    expect(back.blendShapes[1]!.deltas).toEqual([{ index: 0, x: 0, y: -1 }])
    // 整体包围盒要把形变目标算进去(x 到 1.5,y 到 -1)
    expect(yaml).toMatch(/m_LocalAABB:\n\s+m_Center: \{x: 0\.5, y: 0\.5, z: 0\}\n\s+m_Extent: \{x: 1, y: 1\.5, z: 0\}/)
  })

  it('没有形变目标时列表为空而不是缺字段', () => {
    const plain = writeMesh({ ...mesh, blendShapes: [] })
    expect(plain).toContain('  m_Shapes:\n    vertices: []\n    shapes: []\n    channels: []\n    fullWeights: []')
    expect(parseMesh(plain).blendShapes).toEqual([])
  })

  it('权重条数与顶点数不符、索引越界、骨骼越界都当场报错', () => {
    expect(() => writeMesh({ ...mesh, weights: mesh.weights.slice(1) })).toThrow(/一一对应/)
    expect(() => writeMesh({ ...mesh, triangles: [0, 1, 9] })).toThrow(/越界/)
    expect(() => writeMesh({ ...mesh, weights: mesh.weights.map(() => [{ bone: 7, weight: 1 }]) })).toThrow(/不存在的骨骼/)
    expect(() => writeMesh({ ...mesh, blendShapes: [{ name: 's', deltas: [{ index: 6, x: 0, y: 0 }] }] })).toThrow(/越界/)
  })
})
