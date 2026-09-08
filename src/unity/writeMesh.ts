import type { Affine } from '../spine-eval/pose.ts'
import { crc32 } from './crc32.ts'

/**
 * 写 Unity 的 Mesh 资产(`.asset`,classID 43)—— 带蒙皮权重、绑定矩阵和 Blend Shape。
 *
 * 结构取自真实样本:用 Unity 6000.3 自己的 API(`SetBoneWeights` / `AddBlendShapeFrame`)
 * 造一个网格再 `CreateAsset`,拿到的 YAML 逐字段对照(见 `tools/unity/AnimatorGoProbe.cs`
 * 与 docs/UNITY-2D.md 第 11 节)。
 *
 * ## 顶点流(`m_VertexData`,serializedVersion 3)
 *
 * 14 个通道槽位固定顺序:Position, Normal, Tangent, Color, TexCoord0..7, BlendWeight, BlendIndices。
 * 用到的分三个 stream,每个 stream 起点对齐到 16 字节:
 *
 * | stream | 内容 | 格式 | 每顶点字节 |
 * |---|---|---|---|
 * | 0 | Position | float32 × 3 | 12 |
 * | 1 | Color + TexCoord0 | UNorm8 × 4 + float32 × 2 | 12 |
 * | 2 | BlendWeight + BlendIndices | UNorm16 × 4 + UInt16 × 4 | 16 |
 *
 * ⚠️ **顶点流里只放权重最大的 4 根(重新归一到 65535)。** 每顶点超过 4 根的完整权重
 * 另存在 `m_VariableBoneCountWeights`,只有工程 Quality 的 `skinWeights` 为 Unlimited
 * 且渲染器 `m_Quality` 为 Auto 时才会被用到。
 *
 * ## Blend Shape(`m_Shapes`)
 *
 * 稀疏存储:只存有增量的顶点(`vertex` + `index`)。每个形变目标一帧,`fullWeights` 100。
 * `nameHash` 是名字的 **CRC32**,与 `.anim` 里 `blendShape.<名>` 曲线绑定的哈希一致。
 *
 * 增量与蒙皮的顺序是**加完再蒙皮**(实测),和 Spine 的 deform 一样。
 */

/** Mesh 在自己的 .asset 里的 fileID(classID 43 × 100000) */
export const MESH_FILE_ID = 4300000

export interface MeshVertex {
  /** 网格空间(Unity 单位)*/
  readonly x: number
  readonly y: number
  /** Unity 纹理坐标,原点左下 */
  readonly u: number
  readonly v: number
  /** 0..1 */
  readonly color: { r: number; g: number; b: number; a: number }
}

export interface BoneInfluence {
  /** 下标指向 bindposes */
  readonly bone: number
  readonly weight: number
}

export interface BlendShape {
  readonly name: string
  /** 只列有增量的顶点。增量在网格空间(Unity 单位) */
  readonly deltas: readonly { index: number; x: number; y: number }[]
}

export interface MeshAsset {
  readonly name: string
  readonly vertices: readonly MeshVertex[]
  readonly triangles: readonly number[]
  /** 每根骨骼的绑定矩阵:网格空间 → 骨骼空间,即骨骼在绑定时刻世界矩阵的逆 */
  readonly bindposes: readonly Affine[]
  /** 每顶点的骨骼影响,条数任意;会按权重降序、去零、归一 */
  readonly weights: readonly (readonly BoneInfluence[])[]
  readonly blendShapes: readonly BlendShape[]
}

const UNORM16 = 65535

function num(value: number): string {
  if (!Number.isFinite(value)) return '0'
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toFixed(7)))
}

const v3 = (x: number, y: number, z = 0) => `{x: ${num(x)}, y: ${num(y)}, z: ${num(z)}}`

function hex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

const alignTo16 = (n: number) => (n + 15) & ~15

/** 按权重降序、去掉零权重、归一到 1;空的绑到 0 号骨骼 */
function normalize(influences: readonly BoneInfluence[]): BoneInfluence[] {
  const kept = influences.filter((w) => w.weight > 0).sort((p, q) => q.weight - p.weight)
  if (kept.length === 0) return [{ bone: 0, weight: 1 }]
  const total = kept.reduce((n, w) => n + w.weight, 0)
  return kept.map((w) => ({ bone: w.bone, weight: w.weight / total }))
}

/** 量化到 UNorm16,并把舍入误差记到最大的那一根上,保证总和正好 65535(与 Unity 一致) */
function quantize(weights: readonly number[]): number[] {
  const total = weights.reduce((n, w) => n + w, 0)
  const q = weights.map((w) => Math.round((w / total) * UNORM16))
  const sum = q.reduce((n, w) => n + w, 0)
  q[0] = q[0]! + (UNORM16 - sum)
  return q
}

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const emptyBounds = (): Bounds => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
function extend(b: Bounds, x: number, y: number): void {
  b.minX = Math.min(b.minX, x)
  b.minY = Math.min(b.minY, y)
  b.maxX = Math.max(b.maxX, x)
  b.maxY = Math.max(b.maxY, y)
}
const finite = (b: Bounds): Bounds =>
  Number.isFinite(b.minX) ? b : { minX: 0, minY: 0, maxX: 0, maxY: 0 }

function aabbYaml(indent: string, b: Bounds): string[] {
  const f = finite(b)
  return [
    `${indent}m_Center: ${v3((f.minX + f.maxX) / 2, (f.minY + f.maxY) / 2)}`,
    `${indent}m_Extent: ${v3((f.maxX - f.minX) / 2, (f.maxY - f.minY) / 2)}`,
  ]
}

function matrixYaml(m: Affine): string[] {
  // 4×4 行主序:平面仿射放进 x/y,z 保持单位
  const rows = [
    [m.a, m.b, 0, m.x],
    [m.c, m.d, 0, m.y],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ]
  const lines: string[] = []
  rows.forEach((row, r) => row.forEach((v, c) => lines.push(`${r === 0 && c === 0 ? '  - ' : '    '}e${r}${c}: ${num(v)}`)))
  return lines
}

export function writeMesh(mesh: MeshAsset): string {
  const count = mesh.vertices.length
  if (count === 0) throw new Error(`Mesh "${mesh.name}" 没有顶点`)
  if (count > 65535) throw new Error(`Mesh "${mesh.name}" 有 ${count} 个顶点,超过 uint16 索引上限`)
  if (mesh.weights.length !== count) {
    throw new Error(`Mesh "${mesh.name}":顶点 ${count} 个,权重 ${mesh.weights.length} 组,必须一一对应`)
  }
  if (mesh.bindposes.length === 0) throw new Error(`Mesh "${mesh.name}" 没有绑定矩阵`)
  if (mesh.triangles.length % 3 !== 0) throw new Error(`Mesh "${mesh.name}" 的索引数不是 3 的倍数`)
  for (const i of mesh.triangles) {
    if (!Number.isInteger(i) || i < 0 || i >= count) throw new Error(`Mesh "${mesh.name}" 的三角形索引 ${i} 越界`)
  }
  for (const s of mesh.blendShapes) {
    for (const d of s.deltas) {
      if (d.index < 0 || d.index >= count) throw new Error(`Mesh "${mesh.name}" 的形变目标 "${s.name}" 顶点下标 ${d.index} 越界`)
    }
  }

  const weights = mesh.weights.map(normalize)
  for (const [i, list] of weights.entries()) {
    for (const w of list) {
      if (w.bone < 0 || w.bone >= mesh.bindposes.length) {
        throw new Error(`Mesh "${mesh.name}" 顶点 ${i} 引用了不存在的骨骼 ${w.bone}(共 ${mesh.bindposes.length} 根)`)
      }
    }
  }

  // ── 顶点流 ──
  const STRIDE = [12, 12, 16]
  const streamStart = [0, 0, 0]
  streamStart[1] = alignTo16(streamStart[0]! + count * STRIDE[0]!)
  streamStart[2] = alignTo16(streamStart[1]! + count * STRIDE[1]!)
  const dataSize = alignTo16(streamStart[2]! + count * STRIDE[2]!)
  const data = new Uint8Array(dataSize)
  const view = new DataView(data.buffer)

  mesh.vertices.forEach((vert, i) => {
    let o = streamStart[0]! + i * 12
    view.setFloat32(o, vert.x, true)
    view.setFloat32(o + 4, vert.y, true)
    view.setFloat32(o + 8, 0, true)

    o = streamStart[1]! + i * 12
    const c = vert.color
    data[o] = Math.round(Math.min(1, Math.max(0, c.r)) * 255)
    data[o + 1] = Math.round(Math.min(1, Math.max(0, c.g)) * 255)
    data[o + 2] = Math.round(Math.min(1, Math.max(0, c.b)) * 255)
    data[o + 3] = Math.round(Math.min(1, Math.max(0, c.a)) * 255)
    view.setFloat32(o + 4, vert.u, true)
    view.setFloat32(o + 8, vert.v, true)

    o = streamStart[2]! + i * 16
    const top = weights[i]!.slice(0, 4)
    const q = quantize(top.map((w) => w.weight))
    for (let k = 0; k < 4; k++) {
      view.setUint16(o + k * 2, k < q.length ? q[k]! : 0, true)
      view.setUint16(o + 8 + k * 2, k < top.length ? top[k]!.bone : 0, true)
    }
  })

  // ── 完整的可变根数权重:每顶点起始字偏移表 + 总字数 + (骨骼 u16, 权重 UNorm16) 列表 ──
  const totalEntries = weights.reduce((n, w) => n + w.length, 0)
  const headerWords = count + 1
  const variable = new Uint8Array((headerWords + totalEntries) * 4)
  const vv = new DataView(variable.buffer)
  let word = headerWords
  weights.forEach((list, i) => {
    vv.setUint32(i * 4, word, true)
    word += list.length
  })
  vv.setUint32(count * 4, headerWords + totalEntries, true)
  let entry = headerWords
  for (const list of weights) {
    const q = quantize(list.map((w) => w.weight))
    list.forEach((w, k) => {
      vv.setUint16(entry * 4, w.bone, true)
      vv.setUint16(entry * 4 + 2, q[k]!, true)
      entry++
    })
  }

  // ── 索引 ──
  const index = new Uint8Array(mesh.triangles.length * 2)
  const iv = new DataView(index.buffer)
  mesh.triangles.forEach((t, i) => iv.setUint16(i * 2, t, true))

  // ── 包围盒:子网格只看基础顶点;整体和每根骨骼的要把形变目标也算进去(Unity 就是这么算的)──
  const base = emptyBounds()
  const whole = emptyBounds()
  mesh.vertices.forEach((v) => {
    extend(base, v.x, v.y)
    extend(whole, v.x, v.y)
  })
  for (const s of mesh.blendShapes) {
    for (const d of s.deltas) {
      const v = mesh.vertices[d.index]!
      extend(whole, v.x + d.x, v.y + d.y)
    }
  }
  const perBone = mesh.bindposes.map(emptyBounds)
  const deltasOf = new Map<number, { x: number; y: number }[]>()
  for (const s of mesh.blendShapes) {
    for (const d of s.deltas) {
      const list = deltasOf.get(d.index)
      if (list === undefined) deltasOf.set(d.index, [{ x: d.x, y: d.y }])
      else list.push({ x: d.x, y: d.y })
    }
  }
  mesh.vertices.forEach((v, i) => {
    const points = [{ x: v.x, y: v.y }, ...(deltasOf.get(i) ?? []).map((d) => ({ x: v.x + d.x, y: v.y + d.y }))]
    for (const w of weights[i]!) {
      const bind = mesh.bindposes[w.bone]!
      const box = perBone[w.bone]!
      for (const p of points) extend(box, bind.a * p.x + bind.b * p.y + bind.x, bind.c * p.x + bind.d * p.y + bind.y)
    }
  })

  // ── Blend Shape ──
  const shapeLines: string[] = ['  m_Shapes:']
  if (mesh.blendShapes.length === 0) {
    shapeLines.push('    vertices: []', '    shapes: []', '    channels: []', '    fullWeights: []')
  } else {
    shapeLines.push('    vertices:')
    for (const s of mesh.blendShapes) {
      for (const d of s.deltas) {
        shapeLines.push(
          `    - vertex: ${v3(d.x, d.y)}`,
          '      normal: {x: 0, y: 0, z: 0}',
          '      tangent: {x: 0, y: 0, z: 0}',
          `      index: ${d.index}`,
        )
      }
    }
    shapeLines.push('    shapes:')
    let first = 0
    for (const s of mesh.blendShapes) {
      shapeLines.push(`    - firstVertex: ${first}`, `      vertexCount: ${s.deltas.length}`, '      hasNormals: 0', '      hasTangents: 0')
      first += s.deltas.length
    }
    shapeLines.push('    channels:')
    mesh.blendShapes.forEach((s, i) => {
      shapeLines.push(`    - name: ${s.name}`, `      nameHash: ${crc32(s.name)}`, `      frameIndex: ${i}`, '      frameCount: 1')
    })
    shapeLines.push('    fullWeights:')
    for (const _ of mesh.blendShapes) shapeLines.push('    - 100')
  }

  const channel = (stream: number, offset: number, format: number, dimension: number) => [
    `    - stream: ${stream}`,
    `      offset: ${offset}`,
    `      format: ${format}`,
    `      dimension: ${dimension}`,
  ]
  const unused = channel(0, 0, 0, 0)
  // 格式码:0 = Float32,2 = UNorm8,4 = UNorm16,8 = UInt16
  const channels = [
    ...channel(0, 0, 0, 3), // Position
    ...unused, // Normal
    ...unused, // Tangent
    ...channel(1, 0, 2, 4), // Color
    ...channel(1, 4, 0, 2), // TexCoord0
    ...unused,
    ...unused,
    ...unused,
    ...unused,
    ...unused,
    ...unused,
    ...unused, // TexCoord1..7
    ...channel(2, 0, 4, 4), // BlendWeight
    ...channel(2, 8, 8, 4), // BlendIndices
  ]

  const emptyPacked = (name: string, ranged: boolean) => [
    `    ${name}:`,
    '      m_NumItems: 0',
    ...(ranged ? ['      m_Range: 0', '      m_Start: 0'] : []),
    '      m_Data: ',
    '      m_BitSize: 0',
  ]

  const lines = [
    '%YAML 1.1',
    '%TAG !u! tag:unity3d.com,2011:',
    `--- !u!43 &${MESH_FILE_ID}`,
    'Mesh:',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    `  m_Name: ${mesh.name}`,
    '  serializedVersion: 12',
    '  m_SubMeshes:',
    '  - serializedVersion: 2',
    '    firstByte: 0',
    `    indexCount: ${mesh.triangles.length}`,
    '    topology: 0',
    '    baseVertex: 0',
    '    firstVertex: 0',
    `    vertexCount: ${count}`,
    '    localAABB:',
    ...aabbYaml('      ', base),
    ...shapeLines,
    '  m_BindPose:',
    ...mesh.bindposes.flatMap(matrixYaml),
    '  m_BoneNameHashes: ',
    '  m_RootBoneNameHash: 0',
    '  m_BonesAABB:',
    ...perBone.flatMap((b) => {
      const f = finite(b)
      return [`  - m_Min: ${v3(f.minX, f.minY)}`, `    m_Max: ${v3(f.maxX, f.maxY)}`]
    }),
    '  m_VariableBoneCountWeights:',
    `    m_Data: ${hex(variable)}`,
    '  m_MeshCompression: 0',
    '  m_IsReadable: 1',
    '  m_KeepVertices: 1',
    '  m_KeepIndices: 1',
    '  m_IndexFormat: 0',
    `  m_IndexBuffer: ${hex(index)}`,
    '  m_VertexData:',
    '    serializedVersion: 3',
    `    m_VertexCount: ${count}`,
    '    m_Channels:',
    ...channels,
    `    m_DataSize: ${dataSize}`,
    `    _typelessdata: ${hex(data)}`,
    '  m_CompressedMesh:',
    ...emptyPacked('m_Vertices', true),
    ...emptyPacked('m_UV', true),
    ...emptyPacked('m_Normals', true),
    ...emptyPacked('m_Tangents', true),
    ...emptyPacked('m_Weights', false),
    ...emptyPacked('m_NormalSigns', false),
    ...emptyPacked('m_TangentSigns', false),
    ...emptyPacked('m_FloatColors', true),
    ...emptyPacked('m_BoneIndices', false),
    ...emptyPacked('m_Triangles', false),
    '    m_UVInfo: 0',
    '  m_LocalAABB:',
    ...aabbYaml('    ', whole),
    '  m_MeshUsageFlags: 0',
    '  m_CookingOptions: 30',
    '  m_BakedConvexCollisionMesh: ',
    '  m_BakedTriangleCollisionMesh: ',
    "  'm_MeshMetrics[0]': 1",
    "  'm_MeshMetrics[1]': 1",
    '  m_MeshOptimizationFlags: 1',
    '  m_StreamData:',
    '    serializedVersion: 2',
    '    offset: 0',
    '    size: 0',
    '    path: ',
    '  m_MeshLodInfo:',
    '    serializedVersion: 2',
    '    m_LodSelectionCurve:',
    '      serializedVersion: 1',
    '      m_LodSlope: 0',
    '      m_LodBias: 0',
    '    m_NumLevels: 1',
    '    m_SubMeshes:',
    '    - serializedVersion: 2',
    '      m_Levels:',
    '      - serializedVersion: 1',
    '        m_IndexStart: 0',
    '        m_IndexCount: 0',
    '',
  ]
  return lines.join('\n')
}

// ─── 回读(测试与自检用)──────────────────────────────────────────────────────

export interface ParsedMesh {
  readonly vertexCount: number
  readonly positions: { x: number; y: number }[]
  readonly uvs: { u: number; v: number }[]
  readonly colors: { r: number; g: number; b: number; a: number }[]
  /** 顶点流里的前 4 根(归一化后) */
  readonly streamWeights: { bone: number; weight: number }[][]
  /** m_VariableBoneCountWeights 里的完整权重 */
  readonly fullWeights: { bone: number; weight: number }[][]
  readonly triangles: number[]
  readonly bindposes: Affine[]
  readonly blendShapes: { name: string; nameHash: number; deltas: { index: number; x: number; y: number }[] }[]
}

function unhex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** 把 writeMesh 的产物按 Unity 的规则读回来 —— 只认这里写出的布局 */
export function parseMesh(yaml: string): ParsedMesh {
  const field = (name: string): string => {
    const m = new RegExp(`^\\s*${name.replace('[', '\\[').replace(']', '\\]')}: (.*)$`, 'm').exec(yaml)
    if (m === null) throw new Error(`回读 Mesh:找不到 ${name}`)
    return m[1]!.trim()
  }
  const vertexCount = Number(field('m_VertexCount'))
  const data = unhex(field('_typelessdata'))
  const view = new DataView(data.buffer)
  const s1 = alignTo16(vertexCount * 12)
  const s2 = alignTo16(s1 + vertexCount * 12)

  const positions: { x: number; y: number }[] = []
  const uvs: { u: number; v: number }[] = []
  const colors: { r: number; g: number; b: number; a: number }[] = []
  const streamWeights: { bone: number; weight: number }[][] = []
  for (let i = 0; i < vertexCount; i++) {
    positions.push({ x: view.getFloat32(i * 12, true), y: view.getFloat32(i * 12 + 4, true) })
    const o1 = s1 + i * 12
    colors.push({ r: data[o1]! / 255, g: data[o1 + 1]! / 255, b: data[o1 + 2]! / 255, a: data[o1 + 3]! / 255 })
    uvs.push({ u: view.getFloat32(o1 + 4, true), v: view.getFloat32(o1 + 8, true) })
    const o2 = s2 + i * 16
    const list: { bone: number; weight: number }[] = []
    for (let k = 0; k < 4; k++) {
      const w = view.getUint16(o2 + k * 2, true)
      if (w > 0) list.push({ bone: view.getUint16(o2 + 8 + k * 2, true), weight: w / UNORM16 })
    }
    streamWeights.push(list)
  }

  const variable = unhex(field('m_Data'))
  const vv = new DataView(variable.buffer)
  const fullWeights: { bone: number; weight: number }[][] = []
  const totalWords = vv.getUint32(vertexCount * 4, true)
  for (let i = 0; i < vertexCount; i++) {
    const start = vv.getUint32(i * 4, true)
    const end = i + 1 < vertexCount ? vv.getUint32((i + 1) * 4, true) : totalWords
    const list: { bone: number; weight: number }[] = []
    for (let w = start; w < end; w++) list.push({ bone: vv.getUint16(w * 4, true), weight: vv.getUint16(w * 4 + 2, true) / UNORM16 })
    fullWeights.push(list)
  }

  const indexBytes = unhex(field('m_IndexBuffer'))
  const iv = new DataView(indexBytes.buffer)
  const triangles: number[] = []
  for (let i = 0; i < indexBytes.length / 2; i++) triangles.push(iv.getUint16(i * 2, true))

  const bindposes: Affine[] = []
  const matrixRe = /- e00: (\S+)\n\s+e01: (\S+)\n\s+e02: \S+\n\s+e03: (\S+)\n\s+e10: (\S+)\n\s+e11: (\S+)\n\s+e12: \S+\n\s+e13: (\S+)/g
  for (const m of yaml.matchAll(matrixRe)) {
    bindposes.push({ a: Number(m[1]), b: Number(m[2]), x: Number(m[3]), c: Number(m[4]), d: Number(m[5]), y: Number(m[6]) })
  }

  const blendShapes: ParsedMesh['blendShapes'] = []
  const shapesBlock = /m_Shapes:\n([\s\S]*?)\n  m_BindPose:/.exec(yaml)?.[1] ?? ''
  const verts = [...shapesBlock.matchAll(/- vertex: \{x: (\S+), y: (\S+), z: \S+\}\n\s+normal: .*\n\s+tangent: .*\n\s+index: (\d+)/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
    index: Number(m[3]),
  }))
  const ranges = [...shapesBlock.matchAll(/- firstVertex: (\d+)\n\s+vertexCount: (\d+)/g)].map((m) => ({ first: Number(m[1]), count: Number(m[2]) }))
  const names = [...shapesBlock.matchAll(/- name: (.*)\n\s+nameHash: (\d+)/g)].map((m) => ({ name: m[1]!.trim(), hash: Number(m[2]) }))
  names.forEach((n, i) => {
    const r = ranges[i]!
    blendShapes.push({ name: n.name, nameHash: n.hash, deltas: verts.slice(r.first, r.first + r.count) })
  })

  return { vertexCount, positions, uvs, colors, streamWeights, fullWeights, triangles, bindposes, blendShapes }
}
