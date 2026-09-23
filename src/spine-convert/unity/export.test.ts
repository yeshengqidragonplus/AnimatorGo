import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readSkeletonPart, type BoneRecord } from '../../spine-format/binary/readSkeleton.ts'
import { parseAtlas } from '../../core/atlas.ts'
import { decodePng, type Image } from '../../unity/png.ts'
import { parseMesh } from '../../unity/writeMesh.ts'
import { applyPoint, poseAt, type Affine as EvalAffine } from '../../spine-eval/pose.ts'
import { drawOrderOf, layerOfSlot } from '../../spine-eval/drawOrder.ts'
import { sequenceFrameAt, sequenceRegionName, type SequenceKey } from '../../spine-eval/sequence.ts'
import { exportToUnity, type UnityFile } from './export.ts'

/**
 * Spine → Unity 的**端到端校验**。
 *
 * 光看产物「像 Unity 文件」没有意义 —— 真正要回答的是:
 * **Unity 按它自己的规则导入之后,顶点会落在 Spine 算出来的同一个地方吗?**
 *
 * 所以这里把生成出来的 `.meta` 和 prefab **重新读回来**,照 Unity 的
 * `SpritePostProcess` + `SpriteSkin` 的算法算一遍,再和 Spine 自己的骨架求值比对。
 * 读回来而不是用内存里的中间结果,顺带把两个写入器也验了。
 *
 * Unity 侧的算法(取自 `com.unity.2d.animation` 的 `SpritePostProcess.cs`):
 * ```
 * 顶点   = (meta 顶点   - pivot × 矩形尺寸) / pixelsPerUnit
 * 根骨骼 = (meta 骨骼位置 - pivot × 矩形尺寸) / pixelsPerUnit
 * 世界顶点 = Σ 权重 × (场景骨骼世界矩阵 · 绑定姿势逆 · 顶点)
 * ```
 */

const SKELETON = 'res/spine/4.1/MX2_cat.skel.bytes'
const ATLAS = 'res/spine/4.1/MX2_cat.atlas.txt'
const PAGE = 'res/spine/4.1/MX2_cat.png'
const DEG = Math.PI / 180

const hasAssets = [SKELETON, ATLAS, PAGE].every(existsSync)

/** 二维仿射,和 Spine 的骨骼世界矩阵同构 */
interface Affine {
  x: number
  y: number
  a: number
  b: number
  c: number
  d: number
}

const apply = (m: Affine, x: number, y: number) => ({
  x: m.a * x + m.b * y + m.x,
  y: m.c * x + m.d * y + m.y,
})

/** Spine 像素 → Unity 单位(ppu 100) */
const toUnits = (m: EvalAffine): EvalAffine => ({ a: m.a, b: m.b, c: m.c, d: m.d, x: m.x / 100, y: m.y / 100 })

/** Spine 的 `Bone.UpdateWorldTransform`,绑定姿势版本 */
function setupPose(bones: readonly BoneRecord[]): Affine[] {
  const out: Affine[] = []
  bones.forEach((bone, i) => {
    const rotationY = bone.rotation + 90 + bone.shearY
    const la = Math.cos(DEG * (bone.rotation + bone.shearX)) * bone.scaleX
    const lb = Math.cos(DEG * rotationY) * bone.scaleY
    const lc = Math.sin(DEG * (bone.rotation + bone.shearX)) * bone.scaleX
    const ld = Math.sin(DEG * rotationY) * bone.scaleY
    const p = bone.parent < 0 ? null : out[bone.parent]!
    out[i] =
      p === null
        ? { x: bone.x, y: bone.y, a: la, b: lb, c: lc, d: ld }
        : {
            x: p.a * bone.x + p.b * bone.y + p.x,
            y: p.c * bone.x + p.d * bone.y + p.y,
            a: p.a * la + p.b * lc,
            b: p.a * lb + p.b * ld,
            c: p.c * la + p.d * lc,
            d: p.c * lb + p.d * ld,
          }
  })
  return out
}

// ─── 把自己写出来的文件读回来 ────────────────────────────────────────────────

interface MetaSpriteBack {
  name: string
  rect: { x: number; y: number; width: number; height: number }
  pivot: { x: number; y: number }
  vertices: { x: number; y: number }[]
  triangles: number[]
  bones: { name: string; x: number; y: number; rotation: number }[]
  weights: { weight: number[]; bone: number[] }[]
}

const pair = (line: string, kx: string, ky: string) => {
  const m = new RegExp(`${kx}: (-?[\\d.e+-]+), ${ky}: (-?[\\d.e+-]+)`).exec(line)
  if (m === null) throw new Error(`解析不出 ${kx}/${ky}:${line}`)
  return { x: Number(m[1]), y: Number(m[2]) }
}

function readMeta(text: string): { pixelsPerUnit: number; sprites: MetaSpriteBack[] } {
  const sprites: MetaSpriteBack[] = []
  let pixelsPerUnit = 100
  let cur: MetaSpriteBack | null = null
  let list: 'bones' | 'vertices' | 'weights' | 'rect' | null = null

  for (const line of text.split('\n')) {
    const t = line.trim()
    if (line.startsWith('  spritePixelsToUnits:')) pixelsPerUnit = Number(t.slice(21))
    else if (line.startsWith('    - serializedVersion: 2')) {
      cur = {
        name: '',
        rect: { x: 0, y: 0, width: 0, height: 0 },
        pivot: { x: 0, y: 0 },
        vertices: [],
        triangles: [],
        bones: [],
        weights: [],
      }
      sprites.push(cur)
      list = null
    } else if (cur === null) continue
    else if (line.startsWith('      name: ')) cur.name = t.slice(6)
    else if (line.startsWith('      rect:')) list = 'rect'
    else if (list === 'rect' && line.startsWith('        x: ')) cur.rect.x = Number(t.slice(3))
    else if (list === 'rect' && line.startsWith('        y: ')) cur.rect.y = Number(t.slice(3))
    else if (line.startsWith('        width: ')) cur.rect.width = Number(t.slice(7))
    else if (line.startsWith('        height: ')) cur.rect.height = Number(t.slice(8))
    else if (line.startsWith('      pivot: ')) cur.pivot = pair(t, 'x', 'y')
    else if (line.startsWith('      bones:')) list = 'bones'
    else if (line.startsWith('      vertices:')) list = 'vertices'
    else if (line.startsWith('      weights:')) list = 'weights'
    else if (line.startsWith('      indices: ')) {
      const hex = t.slice(9)
      for (let i = 0; i + 8 <= hex.length; i += 8) {
        // 小端 uint32
        const b = hex.slice(i, i + 8)
        cur.triangles.push(parseInt(b.slice(6, 8) + b.slice(4, 6) + b.slice(2, 4) + b.slice(0, 2), 16))
      }
    } else if (list === 'vertices' && line.startsWith('      - {x: ')) {
      cur.vertices.push(pair(t, 'x', 'y'))
    } else if (list === 'bones' && line.startsWith('      - name: ')) {
      cur.bones.push({ name: t.slice(8), x: 0, y: 0, rotation: 0 })
    } else if (list === 'bones' && line.startsWith('        position: ')) {
      Object.assign(cur.bones[cur.bones.length - 1]!, pair(t, 'x', 'y'))
    } else if (list === 'bones' && line.startsWith('        rotation: ')) {
      const q = pair(t, 'z', 'w')
      cur.bones[cur.bones.length - 1]!.rotation = (2 * Math.atan2(q.x, q.y)) / DEG
    } else if (list === 'weights' && t.startsWith("- 'weight[0]'")) {
      cur.weights.push({ weight: [Number(t.split(': ')[1])], bone: [] })
    } else if (list === 'weights' && /^'weight\[[123]]'/.test(t)) {
      cur.weights[cur.weights.length - 1]!.weight.push(Number(t.split(': ')[1]))
    } else if (list === 'weights' && /^'boneIndex\[\d]'/.test(t)) {
      cur.weights[cur.weights.length - 1]!.bone.push(Number(t.split(': ')[1]))
    }
  }
  return { pixelsPerUnit, sprites }
}

interface PrefabBack {
  /** 物体名 → 该 Transform 的 fileID(重名取最先出现的,骨骼排在挂图节点之前) */
  byName: Map<string, string>
  /** Transform 的 fileID → 物体名。挂图节点常和骨骼同名,只能靠父节点区分 */
  nameOf: Map<string, string>
  transforms: Map<string, { father: string; x: number; y: number; rotation: number; sx: number; sy: number }>
  /** Transform 的 fileID → 物体的 m_IsActive(皮肤那一维) */
  activeOf: Map<string, boolean>
  /** Transform 的 fileID → 该物体上渲染器(SpriteRenderer / SkinnedMeshRenderer)的 m_Enabled(换图那一维);没有渲染器的物体不在表里 */
  enabledOf: Map<string, boolean>
  skinCount: number
}

/**
 * 挂图节点的名字:一个 slot 挂多个 attachment 时要带上键名区分,
 * 与导出器里的 `claimName` 保持一致。
 */
const attachmentNodeName = (slotName: string, key: string) =>
  key === slotName ? slotName : `${slotName}__${key}`

/** 在某个父节点下按名字找子节点 —— 挂图节点和骨骼重名时必须这样找 */
function childNamed(prefab: PrefabBack, father: string, name: string): string {
  for (const [id, tr] of prefab.transforms) {
    if (tr.father === father && prefab.nameOf.get(id) === name) return id
  }
  throw new Error(`${father} 下没有叫 "${name}" 的子物体`)
}

function readPrefab(text: string): PrefabBack {
  const transforms = new Map<string, { father: string; x: number; y: number; rotation: number; sx: number; sy: number }>()
  const goName = new Map<string, string>()
  const goActive = new Map<string, boolean>()
  const goEnabled = new Map<string, boolean>()
  const goOfTransform = new Map<string, string>()
  let skinCount = 0

  for (const doc of text.split(/^--- /m).slice(1)) {
    const head = /^!u!(\d+) &(\d+)/.exec(doc)
    if (head === null) continue
    const [, cls, id] = head
    const go = /m_GameObject: \{fileID: (\d+)}/.exec(doc)?.[1]

    if (cls === '1') {
      goName.set(id!, /m_Name: (.*)/.exec(doc)![1]!.trim())
      goActive.set(id!, /m_IsActive: (\d)/.exec(doc)![1] === '1')
    } else if (cls === '212' || cls === '137') {
      goEnabled.set(go!, /m_Enabled: (\d)/.exec(doc)![1] === '1')
    } else if (cls === '4') {
      const rot = pair(/m_LocalRotation: .*/.exec(doc)![0], 'z', 'w')
      const pos = pair(/m_LocalPosition: .*/.exec(doc)![0], 'x', 'y')
      const scl = pair(/m_LocalScale: .*/.exec(doc)![0], 'x', 'y')
      transforms.set(id!, {
        father: /m_Father: \{fileID: (\d+)}/.exec(doc)![1]!,
        x: pos.x,
        y: pos.y,
        rotation: (2 * Math.atan2(rot.x, rot.y)) / DEG,
        sx: scl.x,
        sy: scl.y,
      })
      goOfTransform.set(id!, go!)
    } else if (cls === '114') skinCount++
  }

  const byName = new Map<string, string>()
  const nameOf = new Map<string, string>()
  const activeOf = new Map<string, boolean>()
  const enabledOf = new Map<string, boolean>()
  for (const id of transforms.keys()) {
    const go = goOfTransform.get(id)!
    const name = goName.get(go)!
    nameOf.set(id, name)
    activeOf.set(id, goActive.get(go) ?? true)
    const enabled = goEnabled.get(go)
    if (enabled !== undefined) enabledOf.set(id, enabled)
    if (!byName.has(name)) byName.set(name, id)
  }
  return { byName, nameOf, transforms, activeOf, enabledOf, skinCount }
}

/** `.anim` 里某个属性(精确匹配)的单值曲线:path → 关键帧 */
function curveMap(text: string, attribute: string): Map<string, { time: number; value: number }[]> {
  return new Map(
    readFloatCurves(text, attribute)
      .filter((c) => c.attribute === attribute)
      .map((c) => [c.path, c.keys] as const),
  )
}

/** controller 里某一层的默认 state 名 */
function defaultStateOf(controller: string, layerName: string): string | null {
  const docs = controller.split(/^--- /m).slice(1)
  const machine = docs.find((d) => d.startsWith('!u!1107') && new RegExp(`^\\s{2}m_Name: ${layerName}$`, 'm').test(d))
  const defaultId = machine === undefined ? undefined : /m_DefaultState: \{fileID: (-?\d+)}/.exec(machine)?.[1]
  if (defaultId === undefined) return null
  const state = docs.find((d) => d.startsWith(`!u!1102 &${defaultId}`))
  return state === undefined ? null : (/^\s{2}m_Name: (.*)$/m.exec(state)?.[1]?.trim() ?? null)
}

function worldOf(prefab: PrefabBack, id: string, cache: Map<string, Affine>): Affine {
  const cached = cache.get(id)
  if (cached !== undefined) return cached

  const tr = prefab.transforms.get(id)
  if (tr === undefined) throw new Error(`prefab 里没有 fileID ${id}`)
  const cos = Math.cos(DEG * tr.rotation)
  const sin = Math.sin(DEG * tr.rotation)
  const la = cos * tr.sx
  const lb = -sin * tr.sy
  const lc = sin * tr.sx
  const ld = cos * tr.sy

  let out: Affine
  if (tr.father === '0') out = { x: tr.x, y: tr.y, a: la, b: lb, c: lc, d: ld }
  else {
    const p = worldOf(prefab, tr.father, cache)
    out = {
      x: p.a * tr.x + p.b * tr.y + p.x,
      y: p.c * tr.x + p.d * tr.y + p.y,
      a: p.a * la + p.b * lc,
      b: p.a * lb + p.b * ld,
      c: p.c * la + p.d * lc,
      d: p.c * lb + p.d * ld,
    }
  }
  cache.set(id, out)
  return out
}

/** `.anim` 里的单值曲线:属性、路径、classID、关键帧(时间 → 值)。只取属性名以 prefix 开头的 */
function readFloatCurves(text: string, prefix: string): { attribute: string; path: string; classID: number; keys: { time: number; value: number }[] }[] {
  const out: { attribute: string; path: string; classID: number; keys: { time: number; value: number }[] }[] = []
  for (const block of text.split('  - serializedVersion: 2\n    curve:').slice(1)) {
    const attribute = /^\s{4}attribute: (\S+)/m.exec(block)?.[1]
    // 节点名可以带空格(Female staff 的 `head_take offence`),取整行
    const path = /^\s{4}path: (.*)$/m.exec(block)?.[1]?.trim() ?? ''
    const classID = Number(/^\s{4}classID: (\d+)/m.exec(block)?.[1] ?? 0)
    if (attribute === undefined || !attribute.startsWith(prefix)) continue
    const keys = [...block.matchAll(/time: (\S+)\n\s+value: (\S+)/g)].map((m) => ({ time: Number(m[1]), value: Number(m[2]) }))
    out.push({ attribute, path, classID, keys })
  }
  return out
}

function readBlendShapeCurves(text: string): { shape: string; path: string; keys: { time: number; value: number }[] }[] {
  return readFloatCurves(text, 'blendShape.').map((c) => ({ shape: c.attribute.slice('blendShape.'.length), path: c.path, keys: c.keys }))
}

/** prefab 里的 SkinnedMeshRenderer:挂在哪个物体、引用哪个 Mesh、骨骼 Transform 的 fileID 顺序 */
function readSkinnedRenderers(text: string): { name: string; meshGuid: string; materialGuid: string; bones: string[] }[] {
  const goName = new Map<string, string>()
  const docs = text.split(/^--- /m).slice(1)
  for (const doc of docs) {
    const head = /^!u!(\d+) &(\d+)/.exec(doc)
    if (head?.[1] === '1') goName.set(head[2]!, /m_Name: (.*)/.exec(doc)![1]!.trim())
  }
  const out: { name: string; meshGuid: string; materialGuid: string; bones: string[] }[] = []
  for (const doc of docs) {
    const head = /^!u!(\d+) &(\d+)/.exec(doc)
    if (head?.[1] !== '137') continue
    const go = /m_GameObject: \{fileID: (\d+)}/.exec(doc)![1]!
    const bonesBlock = /m_Bones:\n((?:  - \{fileID: \d+}\n)*)/.exec(doc)?.[1] ?? ''
    out.push({
      name: goName.get(go)!,
      meshGuid: /m_Mesh: \{fileID: 4300000, guid: ([0-9a-f]+)/.exec(doc)![1]!,
      materialGuid: /m_Materials:\n  - \{fileID: 2100000, guid: ([0-9a-f]+)/.exec(doc)![1]!,
      bones: [...bonesBlock.matchAll(/fileID: (\d+)/g)].map((m) => m[1]!),
    })
  }
  return out
}

// ─── 用例 ────────────────────────────────────────────────────────────────────

describe.skipIf(!hasAssets)('Spine → Unity 端到端', () => {
  const part = readSkeletonPart(new Uint8Array(readFileSync(SKELETON)))
  const atlas = parseAtlas(readFileSync(ATLAS, 'utf8'))
  const sources = new Map<string, Image>([['MX2_cat.png', decodePng(new Uint8Array(readFileSync(PAGE)))]])
  const result = exportToUnity(part, atlas, sources, { name: 'MX2_cat', pixelsPerUnit: 100, renderPipeline: 'urp' })

  const fileOf = (suffix: string): UnityFile =>
    result.files.find((f) => f.path.endsWith(suffix)) ?? (() => { throw new Error(`没产出 ${suffix}`) })()
  const textOf = (suffix: string) => fileOf(suffix).content as string

  it('产出一整套 Unity 资源,每个都带 .meta', () => {
    const paths = result.files.map((f) => f.path).sort()
    expect(paths).toContain('MX2_cat.png')
    expect(paths).toContain('MX2_cat.prefab')
    expect(paths).toContain('MX2_cat.controller')
    expect(paths).toContain('MX2_cat@idle.anim')
    expect(paths).toContain('MX2_cat@swim.anim')
    for (const path of paths) {
      if (path.endsWith('.meta')) continue
      expect(paths).toContain(`${path}.meta`)
    }
  })

  it('每个 attachment 都有 sprite 或 Mesh 资产,没有漏图', () => {
    const meta = readMeta(textOf('.png.meta'))
    // 3 个 region(bubble 共用)+ 15 个 mesh,region 去重后一共 16 个;
    // 其中 eyelid 有 deform,走 SkinnedMeshRenderer,是一个 .asset 而不是 sprite
    const meshAssets = result.files.filter((f) => f.path.endsWith('.asset')).map((f) => f.path)
    expect(meshAssets).toEqual(['MX2_cat@eyelid.asset'])
    expect(meta.sprites.length + meshAssets.length).toBe(16)
    for (const sprite of meta.sprites) {
      expect(sprite.rect.width).toBeGreaterThan(0)
      expect(sprite.rect.height).toBeGreaterThan(0)
    }
  })

  it('每个加权网格都有一个 SpriteSkin', () => {
    const prefab = readPrefab(textOf('.prefab'))
    expect(prefab.skinCount).toBe(14)
  })

  it('权重归一化,骨骼下标不越界', () => {
    const meta = readMeta(textOf('.png.meta'))
    for (const sprite of meta.sprites) {
      if (sprite.weights.length === 0) continue
      expect(sprite.weights.length).toBe(sprite.vertices.length)
      for (const w of sprite.weights) {
        // Unity 在权重和小于 0.999 时会警告
        expect(w.weight.reduce((n, v) => n + v, 0)).toBeCloseTo(1, 3)
        // 没有骨骼的 sprite(region、不加权网格)里权重只是占位 —— 它不挂
        // SpriteSkin,这些数值不参与任何计算,骨骼下标无从校验
        if (sprite.bones.length === 0) continue
        for (let i = 0; i < 4; i++) {
          if (w.weight[i]! > 0) expect(w.bone[i]!).toBeLessThan(sprite.bones.length)
        }
      }
    }
  })

  /**
   * ⚠️ **一个 sprite 的 vertices / indices 为空,会把它后面所有 sprite 的
   * 网格数据一起带塌。** 实测:16 个 sprite 里空的那个(region attachment)排第 3,
   * 结果第 1、2 个正常拿到自定义网格,第 3 个之后全被 Unity 用 alpha 轮廓重新生成,
   * 连带 12 个 SpriteSkin 报 InvalidBoneWeights。
   *
   * 所以 region 也要写一个铺满矩形的四顶点网格。
   */
  it('⭐ 没有任何 sprite 的顶点为空(空的会连累后面所有 sprite)', () => {
    const text = textOf('.png.meta')
    // sprite 条目缩进 6 空格;缩进 4 空格的那条是「单图模式」的默认块,在最后,无害
    expect(text).not.toMatch(/^ {6}vertices: \[]$/m)
    expect(text).not.toMatch(/^ {6}indices: *$/m)

    const meta = readMeta(text)
    for (const sprite of meta.sprites) {
      expect(sprite.vertices.length, `${sprite.name} 顶点为空`).toBeGreaterThanOrEqual(3)
      expect(sprite.triangles.length, `${sprite.name} 没有三角形`).toBeGreaterThanOrEqual(3)
    }
  })

  /**
   * ⚠️ **有顶点就必须有等量的 weights,哪怕这个 sprite 没有骨骼。**
   * Unity 的加载器只要 `m_Vertices` 非空就无条件读 `m_Weights[0]`,空数组直接 NRE,
   * 而抛出来的异常会中断整个 sprite 循环 —— **排在后面的 sprite 全部拿不到网格**。
   * 实测:不加权的 `eyelid` 排第 4,它一抛,#4~#16 全废。
   */
  it('⭐ 每个有顶点的 sprite 都有等量 weights(空数组会让 Unity 抛异常中断)', () => {
    const meta = readMeta(textOf('.png.meta'))
    for (const sprite of meta.sprites) {
      if (sprite.vertices.length === 0) continue
      expect(sprite.weights.length, `${sprite.name} 权重条数`).toBe(sprite.vertices.length)
    }
  })

  it('三角形下标不越界', () => {
    const meta = readMeta(textOf('.png.meta'))
    for (const sprite of meta.sprites) {
      expect(sprite.triangles.length % 3).toBe(0)
      for (const index of sprite.triangles) expect(index).toBeLessThan(sprite.vertices.length)
    }
  })

  /**
   * 这条是整个 Unity 导出的**总验收**:
   * 按 Unity 的规则把产物算一遍,顶点必须落在 Spine 算出来的同一个位置。
   */
  it('Unity 按自己的规则导入后,顶点与 Spine 的求值一致(亚像素)', () => {
    const meta = readMeta(textOf('.png.meta'))
    const prefab = readPrefab(textOf('.prefab'))
    const pose = setupPose(part.bones)
    const cache = new Map<string, Affine>()

    let worst = 0
    let worstAt = ''
    let checked = 0

    for (const skin of part.skins) {
      for (const entry of skin.slots) {
        for (const attachment of entry.attachments) {
          if (attachment.type !== 'mesh') continue
          const verts = attachment.data['vertices'] as {
            weighted: boolean
            weights: { bone: number; x: number; y: number; weight: number }[][]
          }
          if (!verts.weighted) continue

          const sprite = meta.sprites.find((s) => s.name === attachment.name)
          expect(sprite, `没找到 ${attachment.name} 的 sprite`).toBeDefined()

          const pivotX = sprite!.rect.width * sprite!.pivot.x
          const pivotY = sprite!.rect.height * sprite!.pivot.y
          const ppu = meta.pixelsPerUnit

          verts.weights.forEach((influences, i) => {
            // Spine 自己算:绑定姿势下顶点的骨架空间位置,换成 Unity 世界单位
            let sx = 0
            let sy = 0
            for (const w of influences) {
              const p = apply(pose[w.bone]!, w.x, w.y)
              sx += (p.x * w.weight) / 100
              sy += (p.y * w.weight) / 100
            }

            // Unity 算:Σ 权重 ×(场景骨骼世界矩阵 · 绑定姿势逆 · 顶点)
            const vx = (sprite!.vertices[i]!.x - pivotX) / ppu
            const vy = (sprite!.vertices[i]!.y - pivotY) / ppu
            let ux = 0
            let uy = 0
            for (let j = 0; j < 4; j++) {
              const weight = sprite!.weights[i]!.weight[j]!
              if (weight === 0) continue
              const bone = sprite!.bones[sprite!.weights[i]!.bone[j]!]!
              const bx = vx - (bone.x - pivotX) / ppu
              const by = vy - (bone.y - pivotY) / ppu
              const cos = Math.cos(-DEG * bone.rotation)
              const sin = Math.sin(-DEG * bone.rotation)
              const local = { x: cos * bx - sin * by, y: sin * bx + cos * by }
              const world = apply(worldOf(prefab, prefab.byName.get(bone.name)!, cache), local.x, local.y)
              ux += world.x * weight
              uy += world.y * weight
            }

            checked++
            // 换回像素来看误差
            const off = Math.hypot(ux - sx, uy - sy) * 100
            if (off > worst) {
              worst = off
              worstAt = `${attachment.name} 第 ${i} 个顶点`
            }
          })
        }
      }
    }

    expect(checked).toBeGreaterThan(300)
    expect(worst, `最大偏差在 ${worstAt}`).toBeLessThan(1)
  })

  /**
   * 不加权的网格走的是另一条路:没有 SpriteSkin,靠节点自己的变换摆位,
   * 拟合出的平移进 pivot、旋转由节点反着转回来。这条路错了只有那几张图会歪。
   */
  it('不加权网格:节点变换 + pivot 摆位后与 Spine 一致', () => {
    const meta = readMeta(textOf('.png.meta'))
    const prefab = readPrefab(textOf('.prefab'))
    const pose = setupPose(part.bones)
    const cache = new Map<string, Affine>()
    let checked = 0
    let skinnedUnweighted = 0

    for (const skin of part.skins) {
      for (const entry of skin.slots) {
        for (const attachment of entry.attachments) {
          if (attachment.type !== 'mesh') continue
          const verts = attachment.data['vertices'] as { weighted: boolean; positions: number[] }
          if (verts.weighted) continue
          // 走 SkinnedMeshRenderer 的没有 sprite,另有专门的用例
          if (result.files.some((f) => f.path === `MX2_cat@${attachment.name}.asset`)) {
            skinnedUnweighted++
            continue
          }

          const sprite = meta.sprites.find((s) => s.name === attachment.name)!
          const slot = part.slots[entry.slot]!
          const slotBone = pose[slot.bone]!
          // 不加权网格的节点是 slot 骨骼的子物体,名字是 slot 名
          const node = worldOf(
            prefab,
            childNamed(
              prefab,
              prefab.byName.get(part.bones[slot.bone]!.name)!,
              attachmentNodeName(slot.name, attachment.key),
            ),
            cache,
          )
          const pivotX = sprite.rect.width * sprite.pivot.x
          const pivotY = sprite.rect.height * sprite.pivot.y

          sprite.vertices.forEach((v, i) => {
            const spine = apply(slotBone, verts.positions[i * 2]!, verts.positions[i * 2 + 1]!)
            const unity = apply(node, (v.x - pivotX) / meta.pixelsPerUnit, (v.y - pivotY) / meta.pixelsPerUnit)
            expect(Math.hypot(unity.x - spine.x / 100, unity.y - spine.y / 100) * 100).toBeLessThan(1)
            checked++
          })
        }
      }
    }
    // MX2_cat 唯一的不加权网格 eyelid 有 deform,走了 SkinnedMeshRenderer —— 这里就没得查,由专门的用例覆盖
    expect(checked + skinnedUnweighted).toBeGreaterThan(0)
  })

  /**
   * region attachment 的四角。Spine 的 `RegionAttachment.UpdateRegion` 把裁剪
   * (offset / originalWidth)算进了四角偏移;我们这边是靠 pivot 加节点缩放表达的,
   * 两条路必须落在同一个地方。
   */
  it('region attachment:四角与 Spine 的 UpdateRegion 一致', () => {
    const meta = readMeta(textOf('.png.meta'))
    const prefab = readPrefab(textOf('.prefab'))
    const pose = setupPose(part.bones)
    const cache = new Map<string, Affine>()
    let checked = 0

    for (const skin of part.skins) {
      for (const entry of skin.slots) {
        for (const attachment of entry.attachments) {
          if (attachment.type !== 'region') continue
          const data = attachment.data as Record<string, number>
          const region = atlas.regions.get(attachment.name)!
          const sprite = meta.sprites.find((s) => s.name === attachment.name)!
          const slot = part.slots[entry.slot]!
          const node = worldOf(
            prefab,
            childNamed(
              prefab,
              prefab.byName.get(part.bones[slot.bone]!.name)!,
              attachmentNodeName(slot.name, attachment.key),
            ),
            cache,
          )
          const bone = pose[slot.bone]!

          // Spine 侧:UpdateRegion 的 localX / localY / localX2 / localY2
          const w = data['width']!
          const h = data['height']!
          const localX = (-w / 2 + (region.offsetX / region.originalWidth) * w) * data['scaleX']!
          const localY = (-h / 2 + (region.offsetY / region.originalHeight) * h) * data['scaleY']!
          const localX2 =
            (w / 2 - ((region.originalWidth - region.offsetX - region.width) / region.originalWidth) * w) * data['scaleX']!
          const localY2 =
            (h / 2 - ((region.originalHeight - region.offsetY - region.height) / region.originalHeight) * h) * data['scaleY']!

          const cos = Math.cos(DEG * data['rotation']!)
          const sin = Math.sin(DEG * data['rotation']!)
          const corner = (lx: number, ly: number) =>
            apply(bone, lx * cos - ly * sin + data['x']!, ly * cos + lx * sin + data['y']!)

          // Unity 侧:sprite 矩形的四角,减 pivot、除 ppu,再走节点的世界变换
          const pivotX = sprite.rect.width * sprite.pivot.x
          const pivotY = sprite.rect.height * sprite.pivot.y
          const unityCorner = (rx: number, ry: number) =>
            apply(node, (rx - pivotX) / meta.pixelsPerUnit, (ry - pivotY) / meta.pixelsPerUnit)

          const pairs: [readonly [number, number], readonly [number, number]][] = [
            [[localX, localY], [0, 0]],
            [[localX2, localY], [sprite.rect.width, 0]],
            [[localX, localY2], [0, sprite.rect.height]],
            [[localX2, localY2], [sprite.rect.width, sprite.rect.height]],
          ]
          for (const [[lx, ly], [rx, ry]] of pairs) {
            const spine = corner(lx, ly)
            const unity = unityCorner(rx, ry)
            expect(Math.hypot(unity.x - spine.x / 100, unity.y - spine.y / 100) * 100).toBeLessThan(1)
            checked++
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  /**
   * 走 SkinnedMeshRenderer 的网格(MX2_cat 里是有 deform 的 eyelid)。
   *
   * 把写出来的 Mesh 资产、prefab、`.anim` 全部读回来,照 Unity 自己的规则算:
   * ```
   * 顶点 = 网格顶点 + Σ 权重ₖ/100 × 形变目标ₖ 的增量        ← 加完再蒙皮(实测)
   * 世界 = Σ wᵢ × 骨骼ᵢ世界矩阵 · 绑定矩阵ᵢ · 顶点
   * ```
   * 权重取 `.anim` 里 blendShape 曲线在关键帧时刻的键值,再与 Spine 的 deform 求值比对。
   */
  it('⭐ SkinnedMeshRenderer:按 Unity 的规则蒙皮 + Blend Shape 后,顶点与 Spine 的 deform 一致(关键帧时刻)', () => {
    const renderers = readSkinnedRenderers(textOf('.prefab'))
    expect(renderers.map((r) => r.name)).toEqual(['eyelid'])
    const smr = renderers[0]!
    // 引用得对:Mesh 资产的 .meta 带这个 guid,材质引用图集页
    expect(textOf('@eyelid.asset.meta')).toContain(`guid: ${smr.meshGuid}`)
    expect(textOf('.mat.meta')).toContain(`guid: ${smr.materialGuid}`)
    expect(textOf('.mat')).toContain(`_MainTex:\n        m_Texture: {fileID: 2800000, guid: ${/guid: ([0-9a-f]+)/.exec(textOf('.png.meta'))![1]}`)

    const mesh = parseMesh(textOf('@eyelid.asset'))
    const prefab = readPrefab(textOf('.prefab'))
    const boneNames = smr.bones.map((id) => prefab.nameOf.get(id)!)
    const boneIndices = boneNames.map((n) => part.bones.findIndex((b) => b.name === n))
    expect(boneIndices.length).toBe(mesh.bindposes.length)
    expect(boneIndices.every((i) => i >= 0)).toBe(true)

    let found: { slot: number; positions: number[] } | null = null
    for (const skin of part.skins) {
      for (const entry of skin.slots) {
        for (const attachment of entry.attachments) {
          if (attachment.name !== 'eyelid') continue
          const verts = attachment.data['vertices'] as { weighted: boolean; positions: number[] }
          expect(verts.weighted).toBe(false)
          found = { slot: entry.slot, positions: verts.positions }
        }
      }
    }
    expect(found).not.toBeNull()
    const { slot, positions } = found!
    expect(mesh.vertexCount).toBe(positions.length / 2)
    const slotBone = part.slots[slot]!.bone
    expect(boneIndices).toEqual([slotBone])
    // 绑定矩阵 · 骨骼绑定时刻的世界矩阵 = 单位:顶点在 setup 下原样落回
    const setupUnits = toUnits(poseAt(part, part.animations[0]!, -1)[slotBone]!)
    for (let j = 0; j < mesh.vertexCount; j++) {
      const p = mesh.positions[j]!
      const local = applyPoint(mesh.bindposes[0]!, p.x, p.y)
      const back = applyPoint(setupUnits, local.x, local.y)
      const spine = applyPoint(poseAt(part, part.animations[0]!, -1)[slotBone]!, positions[j * 2]!, positions[j * 2 + 1]!)
      expect(Math.hypot(back.x * 100 - spine.x, back.y * 100 - spine.y)).toBeLessThan(0.05)
    }

    let checked = 0
    let keysWithShape = 0
    for (const anim of part.animations) {
      const curves = readBlendShapeCurves(textOf(`@${anim.name}.anim`)).filter((c) => c.path === 'eyelid')
      for (const t of anim.timelines) {
        if (t.kind !== 'deform' || t.owner !== slot) continue
        const d = t.frames[0] as unknown as { attachment: string; frames: Record<string, unknown>[] }
        if (d.attachment !== 'eyelid') continue
        for (const frame of d.frames) {
          const time = frame['time'] as number
          const offsets = new Array<number>(positions.length).fill(0)
          const vs = (frame['vertices'] as number[] | undefined) ?? []
          const start = Number(frame['start'] ?? 0)
          vs.forEach((v, i) => (offsets[start + i] = v))

          // 关键帧时刻,曲线正好落在键上:该帧的目标 100,相邻目标 0,其余没有键
          const weights = new Map<string, number>()
          for (const c of curves) {
            const k = c.keys.find((kk) => Math.abs(kk.time - time) < 1e-6)
            if (k !== undefined) weights.set(c.shape, k.value)
          }
          const active = [...weights.values()].filter((v) => v > 1e-6)
          const deformed = offsets.some((o) => Math.abs(o) > 1e-9)
          expect(active).toEqual(deformed ? [100] : [])
          if (deformed) keysWithShape++

          const spinePose = poseAt(part, anim, time)[slotBone]!
          const unityPose = toUnits(poseAt(part, anim, time, { unityCompatible: true })[slotBone]!)
          for (let j = 0; j < mesh.vertexCount; j++) {
            const spine = applyPoint(spinePose, positions[j * 2]! + offsets[j * 2]!, positions[j * 2 + 1]! + offsets[j * 2 + 1]!)
            let vx = mesh.positions[j]!.x
            let vy = mesh.positions[j]!.y
            for (const s of mesh.blendShapes) {
              const w = (weights.get(s.name) ?? 0) / 100
              if (w === 0) continue
              const delta = s.deltas.find((dd) => dd.index === j)
              if (delta !== undefined) {
                vx += w * delta.x
                vy += w * delta.y
              }
            }
            const local = applyPoint(mesh.bindposes[0]!, vx, vy)
            const world = applyPoint(unityPose, local.x, local.y)
            expect(Math.hypot(world.x * 100 - spine.x, world.y * 100 - spine.y)).toBeLessThan(0.5)
            checked++
          }
        }
      }
    }
    expect(keysWithShape).toBeGreaterThan(0)
    expect(checked).toBeGreaterThan(100)
    expect(mesh.blendShapes.length).toBe(keysWithShape)
  })

  /**
   * setup pose 的显隐:一个 slot 下只有 `attachmentName` 那一个亮着,其余灭。
   *
   * 之前所有挂图节点都是 `m_IsActive: 1` —— 没有 attachment 时间轴的动画里,
   * 表情变体会全部叠在一起(blackrichwoman 的 `stand` 里五套眼睛同时出现)。
   */
  /**
   * 两个显隐开关各管一维:渲染器 m_Enabled 是换图(setup pose 只亮 attachmentName 那一个,
   * attachment 时间轴驱动它),GameObject m_IsActive 是皮肤(单皮肤骨架全亮)。
   */
  it('⭐ 挂图节点的初始显隐按 setup pose:同一 slot 只亮一个(渲染器 m_Enabled),皮肤那一维全亮', () => {
    const prefab = readPrefab(textOf('.prefab'))
    // 期望:每个可渲染 attachment 一个节点,key ≠ slot.attachmentName 的渲染器必须是灭的
    const expected = new Map<string, boolean>()
    for (const skin of part.skins) {
      for (const entry of skin.slots) {
        const slot = part.slots[entry.slot]!
        for (const a of entry.attachments) {
          if (a.type !== 'region' && a.type !== 'mesh') continue
          expected.set(attachmentNodeName(slot.name, a.key), a.key === slot.attachmentName)
        }
      }
    }
    const disabledExpected = [...expected.values()].filter((v) => !v).length
    expect(disabledExpected).toBeGreaterThan(0) // MX2_cat 有表情变体,否则这条用例没意义

    let disabledFound = 0
    for (const [id, enabled] of prefab.enabledOf) {
      const name = prefab.nameOf.get(id)!
      if (!enabled) {
        disabledFound++
        expect(expected.get(name)).toBe(false)
      }
    }
    expect(disabledFound).toBe(disabledExpected)
    // 只有一套皮肤:GameObject 全部激活,没有皮肤层,贴图也只有一张
    expect([...prefab.activeOf.values()].every((a) => a)).toBe(true)
    expect(result.files.some((f) => f.path.includes('@skin@'))).toBe(false)
    expect(result.files.filter((f) => f.path.endsWith('.png')).map((f) => f.path)).toEqual(['MX2_cat.png'])
    expect(textOf('.controller')).not.toContain('m_Name: Skin')

    // 换图时间轴打在渲染器的 m_Enabled 上,不碰 m_IsActive
    const anims = result.files.filter((f) => f.path.endsWith('.anim')).map((f) => f.content as string)
    expect(anims.some((a) => a.includes('attribute: m_Enabled'))).toBe(true)
    expect(anims.some((a) => a.includes('attribute: m_IsActive'))).toBe(false)
  })

  /**
   * 逐帧绘制顺序 → 每个挪过位的 slot 一条 m_SortingOrder 阶梯曲线。
   * 关键帧时刻的值 = 按 Spine 规则铺出的完整顺序里该 slot 的层号;没有 drawOrder 的动画写 setup 值。
   */
  it('⭐ 逐帧绘制顺序:m_SortingOrder 曲线在每个关键帧上等于 Spine 铺出的层号', () => {
    const affected = new Set<number>()
    for (const anim of part.animations) {
      for (const t of anim.timelines) {
        if (t.kind !== 'drawOrder') continue
        for (const f of t.frames) {
          layerOfSlot(drawOrderOf(part.slots.length, f['offsets'] as { slot: number; offset: number }[])).forEach((l, s) => {
            if (l !== s) affected.add(s)
          })
        }
      }
    }
    expect(affected.size).toBeGreaterThan(0) // MX2_cat 的 swim 有 drawOrder

    let checked = 0
    for (const anim of part.animations) {
      const curves = readFloatCurves(textOf(`@${anim.name}.anim`), 'm_SortingOrder')
      const timeline = anim.timelines.find((t) => t.kind === 'drawOrder')
      for (const slot of affected) {
        const slotName = part.slots[slot]!.name
        const mine = curves.filter((c) => c.path.split('/').pop()!.startsWith(slotName))
        expect(mine.length).toBeGreaterThan(0)
        for (const c of mine) {
          expect([212, 137]).toContain(c.classID)
          // 0 处一定有键:setup 顺序
          expect(c.keys[0]!.time).toBe(0)
          if (timeline === undefined) {
            expect(c.keys).toEqual([{ time: 0, value: slot }])
            continue
          }
          for (const f of timeline.frames) {
            const time = f['time'] as number
            const expected = layerOfSlot(drawOrderOf(part.slots.length, f['offsets'] as { slot: number; offset: number }[]))[slot]!
            const k = c.keys.find((kk) => Math.abs(kk.time - time) < 1e-6)
            expect(k?.value).toBe(expected)
            checked++
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  /**
   * Spine 导出的图集是预乘 alpha(MX2_cat 也是),Unity 的 sprite 材质要直通 alpha。
   * 烘焙后的图必须已经还原:半透明像素里要有 RGB 大于 alpha 的。
   */
  it('⭐ 预乘 alpha 的图集烘焙后是直通 alpha', () => {
    const source = sources.get('MX2_cat.png')!
    let semi = 0
    let over = 0
    for (let i = 0; i < source.data.length; i += 4) {
      const a = source.data[i + 3]!
      if (a === 0 || a === 255) continue
      semi++
      if (Math.max(source.data[i]!, source.data[i + 1]!, source.data[i + 2]!) > a + 2) over++
    }
    expect(semi).toBeGreaterThan(1000)
    expect(over).toBe(0) // 源图确实是预乘的

    const baked = decodePng(fileOf('.png').content as Uint8Array)
    let bakedOver = 0
    for (let i = 0; i < baked.data.length; i += 4) {
      const a = baked.data[i + 3]!
      if (a === 0 || a === 255) continue
      if (Math.max(baked.data[i]!, baked.data[i + 1]!, baked.data[i + 2]!) > a + 2) bakedOver++
    }
    expect(bakedOver).toBeGreaterThan(100)
    expect(result.issues.some((i) => i.level === 'info' && i.message.includes('预乘'))).toBe(true)
  })

  it('有损的地方都报出来了,不静默', () => {
    const kinds = result.issues.map((i) => `${i.level}:${i.path}`)
    // deform 转成 Blend Shape、逐帧绘制顺序转成 m_SortingOrder 曲线,都不再是 loss
    expect(kinds.some((k) => k.startsWith('loss:') && k.includes('deform'))).toBe(false)
    expect(kinds).toContain('info:skinnedMesh')
    expect(kinds.some((k) => k.startsWith('loss:') && k.includes('drawOrder'))).toBe(false)
    // 网格绑定姿势现在是逐骨骼解出来的,不该再有「对不齐」这类近似
    expect(result.issues.filter((i) => i.level === 'approximated').length).toBeLessThan(3)
  })

  /**
   * 同一份动画的 3.8 与 4.1 导出,转出来的缓动应当一样。
   *
   * ⚠️ 3.8 的贝塞尔控制点是归一化的百分比,4.x 是绝对时间/取值。当成同一种处理时,
   * 3.8 的 `cx` 永远在 [0,1],减去段起始时间往往是负数,于是被当成
   * 「控制点贴在端点上」退化成线性 —— 46 条时间轴,而 4.1 是 0 条。
   * **这个数字的反常是唯一的报警信号**,曲线本身错了是看不出来的。
   */
  it('⭐ 3.8 输入不会退化成线性(两版控制点的坐标系不同)', () => {
    const skel38 = 'res/spine/3.8/MX2_cat.skel.bytes'
    const atlas38 = 'res/spine/3.8/MX2_cat.atlas.txt'
    const page38 = 'res/spine/3.8/MX2_cat.png'
    if (![skel38, atlas38, page38].every(existsSync)) return

    const part38 = readSkeletonPart(new Uint8Array(readFileSync(skel38)))
    const out = exportToUnity(
      part38,
      parseAtlas(readFileSync(atlas38, 'utf8')),
      new Map([['MX2_cat.png', decodePng(new Uint8Array(readFileSync(page38)))]]),
      { name: 'MX2_cat', pixelsPerUnit: 100, renderPipeline: 'urp' },
    )
    const degraded = out.issues.filter((i) => i.message.includes('退化为线性'))
    expect(degraded).toEqual([])
  })

  it('两次导出逐字节相同 —— 否则 Unity 里的引用会断', () => {
    const again = exportToUnity(part, atlas, sources, { name: 'MX2_cat', pixelsPerUnit: 100, renderPipeline: 'urp' })
    expect(again.files.length).toBe(result.files.length)
    again.files.forEach((file, i) => {
      const first = result.files[i]!
      expect(file.path).toBe(first.path)
      if (typeof file.content === 'string') expect(file.content).toBe(first.content)
      else expect([...file.content]).toEqual([...(first.content as Uint8Array)])
    })
  })

  /**
   * 同一属性的重复时间轴(3.8 很常见)只取最后一条 —— Spine 播放时后一条本来就整条盖掉前一条。
   * 两条都写的话 deform 的 Blend Shape 会叠成两倍:实测 MergeCooking2 的 Juicer,`work` 里
   * 5 个网格各有 `work_0` 与 `work_0_2` 两个目标同时满权重。
   */
  it('⭐ 重复的 deform 时间轴不会叠成两倍 Blend Shape:产物与没有重复时逐字节相同,并报 approximated', () => {
    let inserted = 0
    const withDuplicates = {
      ...part,
      animations: part.animations.map((a) => {
        const d = a.timelines.find((t) => t.kind === 'deform')
        if (d === undefined) return a
        // 前面插一条同属性、内容不同(顶点偏移 ×3)的时间轴
        const wrapper = d.frames[0] as { frames: Record<string, unknown>[] }
        const frames = wrapper.frames.map((f) => ({ ...f, vertices: (f['vertices'] as number[]).map((v) => v * 3) }))
        inserted++
        return { ...a, timelines: [{ ...d, frames: [{ ...wrapper, frames }] }, ...a.timelines] }
      }),
    }
    expect(inserted).toBeGreaterThan(0)

    const out = exportToUnity(withDuplicates, atlas, sources, { name: 'MX2_cat', pixelsPerUnit: 100, renderPipeline: 'urp' })
    expect(out.files.map((f) => f.path)).toEqual(result.files.map((f) => f.path))
    out.files.forEach((file, i) => {
      const first = result.files[i]!
      if (typeof file.content === 'string') expect(file.content, file.path).toBe(first.content)
      else expect([...file.content], file.path).toEqual([...(first.content as Uint8Array)])
    })
    const reported = out.issues.filter((i) => i.level === 'approximated' && i.message.includes('只保留最后一条'))
    expect(reported).toHaveLength(inserted)
    expect(reported[0]!.path).toMatch(/deform\[eyelid\//)
  })
})

// ─── 皮肤:MergeCooking2 的本地样本(不在库里,存在才跑)─────────────────────────

const MC2_BRW = 'E:/UnityProject/MergeCooking2/MergeCooking2/Assets/Export/Spine/NewSpine/Customer11/blackrichwoman.skel.bytes'

/**
 * blackrichwoman 有 default + 5 套换装皮肤(3rd_anniversary / Christmas_day / Pirate / Valentines_day / WestCowboy)。
 * Spine 一次只有一套生效;之前全部导出,海盗帽上叠着生日帽和圣诞围巾。
 */
describe.skipIf(!existsSync(MC2_BRW))('皮肤:全部导进一个 prefab,皮肤层切(MergeCooking2 本地样本)', () => {
  const dir = MC2_BRW.slice(0, MC2_BRW.lastIndexOf('/'))
  const part = readSkeletonPart(new Uint8Array(readFileSync(MC2_BRW)))
  const atlas = parseAtlas(readFileSync(`${dir}/blackrichwoman.atlas.txt`, 'utf8'))
  const sources = new Map<string, Image>()
  for (const page of atlas.pages) sources.set(page.name, decodePng(new Uint8Array(readFileSync(`${dir}/${page.name}`))))
  const textIn = (result: ReturnType<typeof exportToUnity>, suffix: string) =>
    result.files.find((f) => f.path.endsWith(suffix))!.content as string
  const prefabOf = (result: ReturnType<typeof exportToUnity>) => readPrefab(textIn(result, '.prefab'))
  const isOn = (prefab: PrefabBack, name: string) => prefab.activeOf.get(prefab.byName.get(name)!)
  const isEnabled = (prefab: PrefabBack, name: string) => prefab.enabledOf.get(prefab.byName.get(name)!)

  // 6 套皮肤:default(本体)+ 5 套换装。具名皮肤的节点带 @皮肤名;同一个 slot 的围巾在三套皮肤里各一个节点
  const PIRATE_HAT = 'Pirate_hat@Pirate'
  const PARTY_HAT = '3rd_anniversary_mz1__3rd_anniversary@3rd_anniversary'
  const SCARVES = ['WestCowboy_scarf@Christmas_day', 'WestCowboy_scarf@Valentines_day', 'WestCowboy_scarf@WestCowboy']

  it('默认初始:所有皮肤的节点都在,只有默认皮肤的亮;表情变体靠渲染器 m_Enabled 灭', () => {
    const result = exportToUnity(part, atlas, sources, { name: 'brw', pixelsPerUnit: 100, renderPipeline: 'urp' })
    const prefab = prefabOf(result)
    const all = [...prefab.nameOf.values()]
    for (const costume of [PIRATE_HAT, PARTY_HAT, ...SCARVES]) {
      expect(all).toContain(costume)
      expect(isOn(prefab, costume)).toBe(false)
    }
    // 皮肤那一维:默认皮肤全亮(连表情变体也亮,它们靠换图那一维灭)
    expect(isOn(prefab, 'eye')).toBe(true)
    expect(isOn(prefab, 'eye__eye4')).toBe(true)
    expect(isEnabled(prefab, 'eye')).toBe(true)
    expect(isEnabled(prefab, 'eye__eye4')).toBe(false)
    expect(isEnabled(prefab, 'mouth__mouth1')).toBe(true) // slot mouth 的 setup 是 mouth1
    expect(isEnabled(prefab, 'mouth__mouth2')).toBe(false)

    // 皮肤层:6 条静态 clip,controller 多一层,默认 state 是 default
    const skinClips = result.files.filter((f) => f.path.includes('@skin@') && f.path.endsWith('.anim')).map((f) => f.path)
    expect(skinClips.sort()).toEqual(
      ['3rd_anniversary', 'Christmas_day', 'Pirate', 'Valentines_day', 'WestCowboy', 'default'].map((s) => `brw@skin@${s}.anim`).sort(),
    )
    const controller = textIn(result, '.controller')
    expect(controller).toContain('m_Name: Skin')
    expect(defaultStateOf(controller, 'Skin')).toBe('default')
    expect(defaultStateOf(controller, 'Base Layer')).toBe('brw@angry')

    // 皮肤 clip 只写 m_IsActive:Pirate 的 clip 亮海盗帽、灭其他皮肤的件、默认皮肤的件保持亮
    const pirate = curveMap(textIn(result, '@skin@Pirate.anim'), 'm_IsActive')
    const at = (path: string) => pirate.get(path)![0]!.value
    expect(at(PIRATE_HAT)).toBe(1)
    expect(at(PARTY_HAT)).toBe(0)
    for (const s of SCARVES) expect(at(s)).toBe(0)
    expect(at('head')).toBe(1)
    expect(curveMap(textIn(result, '@skin@Pirate.anim'), 'm_Enabled').size).toBe(0)

    // 动画 clip 只动渲染器 m_Enabled,不碰 m_IsActive —— 三条围巾共用同一条曲线,由皮肤层决定谁真的显示
    const angry = textIn(result, '@angry.anim')
    expect(curveMap(angry, 'm_IsActive').size).toBe(0)
    expect(curveMap(angry, 'm_Enabled').has('eye__eye4')).toBe(true)

    expect(result.issues.find((i) => i.path === 'skin')?.message).toContain('animator.Play')

    // 贴图按皮肤拆:本体一张,每套具名皮肤各一张;海盗帽只在海盗那张里
    const pngs = result.files.filter((f) => f.path.endsWith('.png')).map((f) => f.path).sort()
    expect(pngs).toEqual(
      ['brw.png', ...['3rd_anniversary', 'Christmas_day', 'Pirate', 'Valentines_day', 'WestCowboy'].map((s) => `brw@skin@${s}.png`)].sort(),
    )
    // 牛仔帽是 region → 牛仔那张贴图的 sprite 表里有它,本体那张没有
    expect(textIn(result, 'brw@skin@WestCowboy.png.meta')).toContain('name: WestCowboy-hat')
    expect(textIn(result, 'brw.png.meta')).not.toContain('name: WestCowboy-hat')
    expect(textIn(result, 'brw.png.meta')).toContain('name: hair-b')
    // 海盗三件都走 SkinnedMeshRenderer(非刚性),它们的材质引用的是海盗那张贴图
    const pirateGuid = /guid: ([0-9a-f]+)/.exec(textIn(result, 'brw@skin@Pirate.png.meta'))![1]!
    expect(textIn(result, 'brw@skin@Pirate.mat')).toContain(`m_Texture: {fileID: 2800000, guid: ${pirateGuid}`)
    const pirateMatGuid = /guid: ([0-9a-f]+)/.exec(textIn(result, 'brw@skin@Pirate.mat.meta'))![1]!
    expect(readSkinnedRenderers(textIn(result, '.prefab')).find((r) => r.name === PIRATE_HAT)?.materialGuid).toBe(pirateMatGuid)
  })

  it('--skin Pirate:初始皮肤是海盗 —— 海盗三件亮,别的皮肤灭,皮肤层默认 state 是 Pirate', () => {
    const result = exportToUnity(part, atlas, sources, { name: 'brw', pixelsPerUnit: 100, renderPipeline: 'urp', skin: 'Pirate' })
    const prefab = prefabOf(result)
    expect(isOn(prefab, PIRATE_HAT)).toBe(true)
    expect(isOn(prefab, 'Pirate_waistband@Pirate')).toBe(true)
    expect(isOn(prefab, PARTY_HAT)).toBe(false)
    for (const s of SCARVES) expect(isOn(prefab, s)).toBe(false)
    expect(isOn(prefab, 'head')).toBe(true)
    expect(defaultStateOf(textIn(result, '.controller'), 'Skin')).toBe('Pirate')
    // 产物名不再带皮肤后缀 —— 一个 prefab 装全部皮肤
    expect(result.files.some((f) => f.path === 'brw.prefab')).toBe(true)
  })

  /**
   * 带脚本模式:换装件的 sprite / 材质不硬引用,由 AnimatorGoSkins 组件按软引用(路径 + GUID)切到时加载。
   * 没有皮肤层、没有皮肤 clip;本体的 sprite 照旧硬引用。
   */
  it('--skins script:根节点挂 AnimatorGoSkins,换装件的 sprite 与材质留空、写成软引用', () => {
    const result = exportToUnity(part, atlas, sources, {
      name: 'brw',
      pixelsPerUnit: 100,
      renderPipeline: 'urp',
      skins: 'script',
      assetFolder: 'Assets/AnimatorGo/brw',
    })
    expect(result.files.some((f) => f.path.includes('@skin@') && f.path.endsWith('.anim'))).toBe(false)
    expect(textIn(result, '.controller')).not.toContain('m_Name: Skin')
    // 贴图和材质照常产出(组件要加载它们),只是 prefab 不再引用换装件的那些
    expect(result.files.some((f) => f.path === 'brw@skin@Pirate.png')).toBe(true)
    expect(result.files.some((f) => f.path === 'brw@skin@Pirate.mat')).toBe(true)

    const prefabText = textIn(result, '.prefab')
    const docs = prefabText.split(/^--- /m)
    const component = docs.find((d) => d.includes('guid: 4f1a4e2b9c3d4a5e8b7c6d5e4f3a2b10'))
    expect(component).toBeDefined()
    expect(component).toContain('  defaultSkin: default')
    expect(component).toContain('  initialSkin: default')
    expect(component).toContain('    spriteAsset: Assets/AnimatorGo/brw/brw@skin@WestCowboy.png')
    expect(component).toContain('    spriteName: WestCowboy-hat')
    expect(component).toContain('    materialAsset: Assets/AnimatorGo/brw/brw@skin@Pirate.mat')
    expect(component).toContain('  - name: Pirate')

    // 牛仔帽(region)的 SpriteRenderer 没有 sprite;海盗帽(SkinnedMesh)没有材质;本体的头发还硬引用着
    const prefab = readPrefab(prefabText)
    const goOf = (name: string) => docs.find((d) => d.startsWith('!u!1 ') && d.includes(`m_Name: ${name}\n`))!.match(/^!u!1 &(\d+)/)![1]
    const rendererOf = (cls: string, goId: string) => docs.find((d) => d.startsWith(`!u!${cls}`) && d.includes(`m_GameObject: {fileID: ${goId}}`))!
    expect(rendererOf('212', goOf('WestCowboy_hat@WestCowboy')!)).toContain('m_Sprite: {fileID: 0}')
    expect(rendererOf('137', goOf(PIRATE_HAT)!)).toContain('m_Materials: []')
    expect(rendererOf('212', goOf('hair-b')!)).toMatch(/m_Sprite: \{fileID: -?\d+, guid: [0-9a-f]+, type: 3\}/)
    // 皮肤那一维的初始状态照旧:换装件灭、本体亮
    expect(prefab.activeOf.get(prefab.byName.get(PIRATE_HAT)!)).toBe(false)
    expect(prefab.activeOf.get(prefab.byName.get('hair-b')!)).toBe(true)
    expect(result.issues.find((i) => i.path === 'skin')?.message).toContain('AnimatorGoSkins')
  })

  it('不存在的皮肤名当场报错,并列出有哪些', () => {
    expect(() => exportToUnity(part, atlas, sources, { name: 'brw', pixelsPerUnit: 100, renderPipeline: 'urp', skin: 'Nope' })).toThrow(/Pirate/)
  })

  /**
   * 跨度 < 64px 的网格不看「缩放」判据 —— 小图的比值被整数裁剪框量化主导。之前担心这几个缩放差 50% 的
   * 换装小件因此留在 SpriteSkin;实测它们的绑定残差 5~19 像素,一直是被「非刚性」判据分流的。
   */
  it('跨度 < 64px、缩放差 50% 的换装小件照样走 SkinnedMeshRenderer(由绑定残差判据分流)', () => {
    const result = exportToUnity(part, atlas, sources, { name: 'brw', pixelsPerUnit: 100, renderPipeline: 'urp' })
    for (const n of ['Valentines_flower1', 'Valentines_flower2', 'WestCowboy-sign', 'Christmas_bg_flower']) {
      expect(result.files.some((f) => f.path === `brw@${n}.asset`), n).toBe(true)
      expect(result.issues.some((i) => i.path === `mesh.${n}` && i.message.includes('绑定姿势非刚性')), n).toBe(true)
    }
  })
})

// ─── 加权网格上的 deform:MergeCooking2 的本地样本(不在库里,存在才跑)────────────

const MC2_CUSTOMER = 'E:/UnityProject/MergeCooking2/MergeCooking2/Assets/Export/Spine/NewSpine/Customer1/customer_1.skel.bytes'

/**
 * 加权网格的 deform 是这条路线里最绕的一步:Spine 的偏移是逐影响、在各自骨骼局部空间存的,
 * Unity 的增量是网格空间里一个向量。导出器按关键帧时刻的姿势反解增量 —— 这里照 Unity 的规则
 * (顶点流里前 4 根归一后的权重、加完增量再蒙皮)把写出来的文件算一遍,与 Spine 比对。
 */
describe.skipIf(!existsSync(MC2_CUSTOMER))('加权网格的 deform → Blend Shape(MergeCooking2 本地样本)', () => {
  const dir = MC2_CUSTOMER.slice(0, MC2_CUSTOMER.lastIndexOf('/'))
  const part = readSkeletonPart(new Uint8Array(readFileSync(MC2_CUSTOMER)))
  const atlas = parseAtlas(readFileSync(`${dir}/customer_1.atlas.txt`, 'utf8'))
  const sources = new Map<string, Image>()
  for (const page of atlas.pages) sources.set(page.name, decodePng(new Uint8Array(readFileSync(`${dir}/${page.name}`))))
  const result = exportToUnity(part, atlas, sources, { name: 'customer_1', pixelsPerUnit: 100, renderPipeline: 'urp' })
  const textOf = (suffix: string) => result.files.find((f) => f.path.endsWith(suffix))!.content as string

  it('⭐ 加权网格:按 Unity 的规则(前 4 根归一 + 加完再蒙皮)算出的顶点,关键帧时刻与 Spine 一致', () => {
    const prefab = readPrefab(textOf('.prefab'))
    const renderers = readSkinnedRenderers(textOf('.prefab'))
    expect(renderers.length).toBeGreaterThan(0)
    const curvesByAnim = new Map(part.animations.map((a) => [a.name, readBlendShapeCurves(textOf(`@${a.name}.anim`))]))

    let checked = 0
    let weightedMeshes = 0
    let worst = 0
    for (const r of renderers) {
      // Mesh 资产按 guid 找 —— 资产名是 attachment 名,节点名是 slot 名,不一定相同
      const metaFile = result.files.find((f) => f.path.endsWith('.asset.meta') && (f.content as string).includes(`guid: ${r.meshGuid}`))!
      const mesh = parseMesh(result.files.find((f) => f.path === metaFile.path.replace(/\.meta$/, ''))!.content as string)

      // 节点名 → slot 与键名(与导出器的 claimName 约定一致;带重名后缀的这里不管)
      let slotIndex = -1
      let key = ''
      part.slots.forEach((s, i) => {
        if (r.name === s.name) {
          slotIndex = i
          key = s.name
        } else if (r.name.startsWith(`${s.name}__`)) {
          slotIndex = i
          key = r.name.slice(s.name.length + 2)
        }
      })
      if (slotIndex < 0) continue
      const attachment = part.skins.flatMap((s) => s.slots).filter((e) => e.slot === slotIndex).flatMap((e) => e.attachments).find((a) => a.key === key && a.type === 'mesh')
      if (attachment === undefined) continue
      const verts = attachment.data['vertices'] as { weighted: boolean; weights: { bone: number; x: number; y: number; weight: number }[][] }
      if (!verts.weighted) continue
      weightedMeshes++

      const boneIdx = r.bones.map((id) => part.bones.findIndex((b) => b.name === prefab.nameOf.get(id)))
      expect(boneIdx.length).toBe(mesh.bindposes.length)
      expect(boneIdx.every((i) => i >= 0)).toBe(true)
      const flatLength = verts.weights.reduce((n, w) => n + w.length * 2, 0)

      for (const anim of part.animations) {
        const curves = curvesByAnim.get(anim.name)!.filter((c) => c.path === r.name)
        for (const t of anim.timelines) {
          if (t.kind !== 'deform' || t.owner !== slotIndex) continue
          const d = t.frames[0] as unknown as { attachment: string; frames: Record<string, unknown>[] }
          if (d.attachment !== key) continue

          for (const frame of d.frames) {
            const time = frame['time'] as number
            const flat = new Array<number>(flatLength).fill(0)
            const vs = (frame['vertices'] as number[] | undefined) ?? []
            const start = Number(frame['start'] ?? 0)
            vs.forEach((v, i) => (flat[start + i] = v))
            const weights = new Map<string, number>()
            for (const c of curves) {
              const k = c.keys.find((kk) => Math.abs(kk.time - time) < 1e-6)
              if (k !== undefined) weights.set(c.shape, k.value)
            }

            const poseS = poseAt(part, anim, time)
            const poseU = poseAt(part, anim, time, { unityCompatible: true }).map(toUnits)
            let idx = 0
            for (let j = 0; j < mesh.vertexCount; j++) {
              // Spine:每个影响在自己骨骼的局部空间加偏移,再按权重混合
              let sx = 0
              let sy = 0
              for (const w of verts.weights[j]!) {
                const p = applyPoint(poseS[w.bone]!, w.x + flat[idx]!, w.y + flat[idx + 1]!)
                sx += w.weight * p.x
                sy += w.weight * p.y
                idx += 2
              }
              // Unity:网格顶点加上形变目标的增量,再用顶点流里的(前 4 根归一)权重蒙皮
              let vx = mesh.positions[j]!.x
              let vy = mesh.positions[j]!.y
              for (const s of mesh.blendShapes) {
                const w = (weights.get(s.name) ?? 0) / 100
                if (w === 0) continue
                const delta = s.deltas.find((dd) => dd.index === j)
                if (delta !== undefined) {
                  vx += w * delta.x
                  vy += w * delta.y
                }
              }
              let ux = 0
              let uy = 0
              for (const w of mesh.streamWeights[j]!) {
                const local = applyPoint(mesh.bindposes[w.bone]!, vx, vy)
                const world = applyPoint(poseU[boneIdx[w.bone]!]!, local.x, local.y)
                ux += w.weight * world.x
                uy += w.weight * world.y
              }
              worst = Math.max(worst, Math.hypot(ux * 100 - sx, uy * 100 - sy))
              checked++
            }
          }
        }
      }
    }
    expect(weightedMeshes).toBeGreaterThan(0)
    expect(checked).toBeGreaterThan(0)
    // 顶点超过 4 根骨骼的会被截到 4 根(与 SpriteSkin 一致),那部分差异在这个样本里是亚像素的
    expect(worst).toBeLessThan(0.5)
  })
})

// ─── linkedmesh:MergeCooking2 的本地样本(不在库里,存在才跑)─────────────────────
//
// Female staff 的 `head_ordinary` 是挂在 `head_take offence` 上的 linkedmesh(inheritTimelines),
// 父网格有 deform —— 同一条时间轴要同时驱动父网格和它。

const MC2_FEMALE = 'E:/UnityProject/MergeCooking2/MergeCooking2/Assets/Export/Spine/NewSpine/Customer12/Female staff.skel.bytes'

describe.skipIf(!existsSync(MC2_FEMALE))('linkedmesh 展开(MergeCooking2 本地样本)', () => {
  const dir = MC2_FEMALE.slice(0, MC2_FEMALE.lastIndexOf('/'))
  const part = readSkeletonPart(new Uint8Array(readFileSync(MC2_FEMALE)))
  const atlas = parseAtlas(readFileSync(`${dir}/Female staff.atlas.txt`, 'utf8'))
  const sources = new Map<string, Image>()
  for (const page of atlas.pages) sources.set(page.name, decodePng(new Uint8Array(readFileSync(`${dir}/${page.name}`))))
  const result = exportToUnity(part, atlas, sources, { name: 'female', pixelsPerUnit: 100, renderPipeline: 'urp' })
  const textOf = (path: string) => result.files.find((f) => f.path === path)!.content as string

  const slot = part.slots.findIndex((s) => s.name === 'head_take offence')
  const defaultSkin = part.skins.find((s) => s.name === 'default')!
  const inSlot = defaultSkin.slots.find((e) => e.slot === slot)!.attachments
  const parentAttachment = inSlot.find((a) => a.key === 'head_take offence')!
  const linkedAttachment = inSlot.find((a) => a.key === 'head_ordinary')!

  it('样本的形状符合预期:父网格有 deform,linkedmesh 继承时间轴', () => {
    expect(parentAttachment.type).toBe('mesh')
    expect(linkedAttachment.type).toBe('linkedmesh')
    expect(linkedAttachment.data['parent']).toBe('head_take offence')
    expect(linkedAttachment.data['inheritTimelines']).toBe(true)
    expect(result.issues.some((i) => i.level === 'loss' && i.path.includes('head_ordinary'))).toBe(false)
  })

  it('几何与父网格相同,UV 换成自己的图', () => {
    const linked = parseMesh(textOf('female@head_ordinary.asset'))
    const meshes = result.files
      .filter((f) => f.path.endsWith('.asset') && f.path !== 'female@head_ordinary.asset')
      .map((f) => parseMesh(f.content as string))
    // 父网格:同样的三角形、同样的顶点位置
    const parent = meshes.find(
      (m) =>
        m.vertexCount === linked.vertexCount &&
        m.triangles.every((t, i) => t === linked.triangles[i]) &&
        m.positions.every((p, i) => Math.hypot(p.x - linked.positions[i]!.x, p.y - linked.positions[i]!.y) < 1e-6),
    )
    expect(parent).toBeDefined()
    const uvDiff = linked.uvs.reduce((n, uv, i) => Math.max(n, Math.hypot(uv.u - parent!.uvs[i]!.u, uv.v - parent!.uvs[i]!.v)), 0)
    expect(uvDiff).toBeGreaterThan(1e-3)
  })

  it('⭐ 继承的 deform:按 Unity 的规则算出的顶点,关键帧时刻与 Spine 一致', () => {
    const prefab = readPrefab(textOf('female.prefab'))
    const meta = result.files.find((f) => f.path === 'female@head_ordinary.asset.meta')!.content as string
    const renderer = readSkinnedRenderers(textOf('female.prefab')).find((r) => meta.includes(`guid: ${r.meshGuid}`))!
    expect(renderer).toBeDefined()
    const mesh = parseMesh(textOf('female@head_ordinary.asset'))
    const boneIdx = renderer.bones.map((id) => part.bones.findIndex((b) => b.name === prefab.nameOf.get(id)))
    expect(boneIdx.every((i) => i >= 0)).toBe(true)

    // Spine 那边:linkedmesh 用父网格的顶点,吃打在父网格上的 deform
    const verts = parentAttachment.data['vertices'] as {
      weighted: boolean
      positions: number[]
      weights: { bone: number; x: number; y: number; weight: number }[][]
    }
    const flatLength = verts.weighted ? verts.weights.reduce((n, w) => n + w.length * 2, 0) : verts.positions.length
    const slotBone = part.slots[slot]!.bone

    let checked = 0
    let deformedKeys = 0
    let worst = 0
    for (const anim of part.animations) {
      const curves = readBlendShapeCurves(textOf(`female@${anim.name}.anim`)).filter((c) => c.path === renderer.name)
      for (const t of anim.timelines) {
        if (t.kind !== 'deform' || t.owner !== slot) continue
        const d = t.frames[0] as unknown as { attachment: string; frames: Record<string, unknown>[] }
        if (d.attachment !== 'head_take offence') continue
        expect(curves.length).toBeGreaterThan(0)

        for (const frame of d.frames) {
          const time = frame['time'] as number
          const flat = new Array<number>(flatLength).fill(0)
          const vs = (frame['vertices'] as number[] | undefined) ?? []
          const start = Number(frame['start'] ?? 0)
          vs.forEach((v, i) => (flat[start + i] = v))
          if (flat.some((v) => Math.abs(v) > 1e-9)) deformedKeys++
          const weights = new Map<string, number>()
          for (const c of curves) {
            const k = c.keys.find((kk) => Math.abs(kk.time - time) < 1e-6)
            if (k !== undefined) weights.set(c.shape, k.value)
          }

          const poseS = poseAt(part, anim, time)
          const poseU = poseAt(part, anim, time, { unityCompatible: true }).map(toUnits)
          let idx = 0
          for (let j = 0; j < mesh.vertexCount; j++) {
            let sx = 0
            let sy = 0
            if (verts.weighted) {
              for (const w of verts.weights[j]!) {
                const p = applyPoint(poseS[w.bone]!, w.x + flat[idx]!, w.y + flat[idx + 1]!)
                sx += w.weight * p.x
                sy += w.weight * p.y
                idx += 2
              }
            } else {
              const p = applyPoint(poseS[slotBone]!, verts.positions[j * 2]! + flat[j * 2]!, verts.positions[j * 2 + 1]! + flat[j * 2 + 1]!)
              sx = p.x
              sy = p.y
            }
            let vx = mesh.positions[j]!.x
            let vy = mesh.positions[j]!.y
            for (const s of mesh.blendShapes) {
              const w = (weights.get(s.name) ?? 0) / 100
              const delta = w === 0 ? undefined : s.deltas.find((dd) => dd.index === j)
              if (delta !== undefined) {
                vx += w * delta.x
                vy += w * delta.y
              }
            }
            let ux = 0
            let uy = 0
            for (const w of mesh.streamWeights[j]!) {
              const local = applyPoint(mesh.bindposes[w.bone]!, vx, vy)
              const world = applyPoint(poseU[boneIdx[w.bone]!]!, local.x, local.y)
              ux += w.weight * world.x
              uy += w.weight * world.y
            }
            worst = Math.max(worst, Math.hypot(ux * 100 - sx, uy * 100 - sy))
            checked++
          }
        }
      }
    }
    expect(deformedKeys).toBeGreaterThan(0)
    expect(checked).toBeGreaterThan(0)
    expect(mesh.blendShapes.length).toBeGreaterThan(0)
    expect(worst).toBeLessThan(0.5)
  })
})

// ─── 4.1 序列帧:本地真实样本(不在库里,存在才跑)─────────────────────────────────
//
// 每帧一个节点,渲染器 m_Enabled =「换图时间轴说这个键名亮着」且「sequence 时间轴说是这一帧」。
// 把导出的 prefab 和 .anim 读回来,照 Unity 的规则(阶梯曲线取最后一个 time ≤ t 的键;这条动画没这条
// 曲线就是 prefab 初值 —— Write Defaults)在每个采样时刻算出哪一帧亮着,与 Spine 的规则比。

const SEQUENCE_SAMPLES = [
  // region 序列帧,loop(马车轮)
  'E:/UnityProject/Cooking11/Cooking11/Assets/AssetsExports/CookingGame/Map/City11/spine/map11_damache.skel.bytes',
  // 加权 mesh 序列帧,loopReverse,从 index 3 起
  'E:/UnityProject/Cooking11/Cooking11/Assets/AssetsExports/CookingGame/Map/City8/spine/huache3.skel.bytes',
  // setup 时不显示、换图时间轴点亮;先 hold 再 once
  'E:/UnityProject/Cooking12/Cooking12/Assets/Export/Hospital/Effect/Spine/icon_clock.skel.bytes',
  // 不加权 mesh 序列帧,6 套具名皮肤
  'E:/UnityProject/FindTM1/Assets/Res/FindTM/Spines/Transportation/Boat_001/boat_1.skel.bytes',
]

for (const file of SEQUENCE_SAMPLES) {
  const base = file.slice(file.lastIndexOf('/') + 1).replace(/\.skel\.bytes$/, '')
  describe.skipIf(!existsSync(file))(`4.1 序列帧 → 每帧一个节点(本地样本 ${base})`, () => {
    const dir = file.slice(0, file.lastIndexOf('/'))
    const part = readSkeletonPart(new Uint8Array(readFileSync(file)))
    const atlas = parseAtlas(readFileSync(`${dir}/${base}.atlas.txt`, 'utf8'))
    const sources = new Map<string, Image>()
    for (const page of atlas.pages) sources.set(page.name, decodePng(new Uint8Array(readFileSync(`${dir}/${page.name}`))))
    const result = exportToUnity(part, atlas, sources, { name: base, pixelsPerUnit: 100, renderPipeline: 'urp', skipImages: true })
    const textOf = (path: string) => result.files.find((f) => f.path === path)?.content as string | undefined
    const prefab = readPrefab(textOf(`${base}.prefab`)!)
    const defaultSkin = part.skins.find((s) => s.name === 'default') ?? part.skins[0]!

    /** 每个序列帧 attachment:它的各帧节点(fileID)、帧号 */
    const groups = part.skins.flatMap((skin) =>
      skin.slots.flatMap((entry) =>
        entry.attachments
          .filter((a) => a.sequence !== null)
          .map((a) => {
            const slot = part.slots[entry.slot]!
            const nodeOf = (i: number) => {
              let name = `${attachmentNodeName(slot.name, a.key)}#${sequenceRegionName('', a.sequence!, i)}`
              if (skin !== defaultSkin) name += `@${skin.name}`
              return name
            }
            const nodes = Array.from({ length: a.sequence!.count }, (_, i) => {
              const id = [...prefab.nameOf].find(([, n]) => n === nodeOf(i))?.[0]
              return { index: i, name: nodeOf(i), id }
            })
            return { skin: skin.name, slot: entry.slot, key: a.key, seq: a.sequence!, nodes }
          }),
      ),
    )

    it('样本里确实有序列帧,每帧都有节点,且没有缺图', () => {
      expect(groups.length).toBeGreaterThan(0)
      for (const g of groups) for (const n of g.nodes) expect(n.id, n.name).toBeDefined()
      expect(result.issues.filter((i) => i.level === 'loss' && i.message.includes('图集里没有'))).toEqual([])
    })

    it('setup:只有 setup 那一帧的渲染器亮(且该 attachment 本来就是 setup 显示的)', () => {
      for (const g of groups) {
        const shown = part.slots[g.slot]!.attachmentName === g.key
        const setup = sequenceFrameAt(undefined, g.seq, 0)
        for (const n of g.nodes) expect(prefab.enabledOf.get(n.id!), n.name).toBe(shown && n.index === setup)
      }
    })

    it('⭐ 每个采样时刻,Unity 亮着的恰好是 Spine 在那一刻显示的那一帧', () => {
      const stepAt = (keys: { time: number; value: number }[], t: number) => {
        let v = keys[0]!.value
        for (const k of keys) if (k.time <= t) v = k.value
        return v
      }
      let checked = 0
      for (const anim of part.animations) {
        const clip = textOf(`${base}@${anim.name}.anim`)!
        const curves = curveMap(clip, 'm_Enabled')
        const curveOf = (name: string) => [...curves].find(([p]) => p === name || p.endsWith(`/${name}`))?.[1]
        const duration = Math.max(0, ...[...curves.values()].flatMap((ks) => ks.map((k) => k.time)))
        for (const g of groups) {
          const seqT = anim.timelines.find((t) => {
            const w = t.frames[0] as { skin?: number; attachment?: string } | undefined
            return t.kind === 'sequence' && t.owner === g.slot && w?.attachment === g.key && part.skins[w.skin!]?.name === g.skin
          })
          const keys = seqT === undefined ? undefined : (seqT.frames[0] as unknown as { frames: SequenceKey[] }).frames
          const attT = anim.timelines.find((t) => t.kind === 'attachment' && t.owner === g.slot)
          for (let t = 0; t < duration; t += 0.0137) {
            // Spine:换图时间轴决定亮不亮,sequence 时间轴决定哪一帧
            let visible = part.slots[g.slot]!.attachmentName === g.key
            for (const f of attT?.frames ?? []) if ((f['time'] as number) <= t) visible = f['name'] === g.key
            const expected = visible ? [sequenceFrameAt(keys, g.seq, t)] : []
            // Unity:每帧节点各自的 m_Enabled 曲线;这条动画没写就是 prefab 初值
            const lit = g.nodes
              .filter((n) => {
                const c = curveOf(n.name)
                return c === undefined ? prefab.enabledOf.get(n.id!) === true : stepAt(c, t) === 1
              })
              .map((n) => n.index)
            expect(lit, `${anim.name} ${g.skin}/${g.key} @${t.toFixed(4)}s`).toEqual(expected)
            checked++
          }
        }
      }
      expect(checked).toBeGreaterThan(50)
    })
  })
}
