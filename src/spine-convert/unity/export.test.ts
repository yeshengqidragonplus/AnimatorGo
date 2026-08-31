import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readSkeletonPart, type BoneRecord } from '../../spine-format/binary/readSkeleton.ts'
import { parseAtlas } from '../../core/atlas.ts'
import { decodePng, type Image } from '../../unity/png.ts'
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
  const goOfTransform = new Map<string, string>()
  let skinCount = 0

  for (const doc of text.split(/^--- /m).slice(1)) {
    const head = /^!u!(\d+) &(\d+)/.exec(doc)
    if (head === null) continue
    const [, cls, id] = head
    const go = /m_GameObject: \{fileID: (\d+)}/.exec(doc)?.[1]

    if (cls === '1') goName.set(id!, /m_Name: (.*)/.exec(doc)![1]!.trim())
    else if (cls === '4') {
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
  for (const id of transforms.keys()) {
    const name = goName.get(goOfTransform.get(id)!)!
    nameOf.set(id, name)
    if (!byName.has(name)) byName.set(name, id)
  }
  return { byName, nameOf, transforms, skinCount }
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

// ─── 用例 ────────────────────────────────────────────────────────────────────

describe.skipIf(!hasAssets)('Spine → Unity 端到端', () => {
  const part = readSkeletonPart(new Uint8Array(readFileSync(SKELETON)))
  const atlas = parseAtlas(readFileSync(ATLAS, 'utf8'))
  const sources = new Map<string, Image>([['MX2_cat.png', decodePng(new Uint8Array(readFileSync(PAGE)))]])
  const result = exportToUnity(part, atlas, sources, { name: 'MX2_cat', pixelsPerUnit: 100 })

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

  it('每个 attachment 都有 sprite,没有漏图', () => {
    const meta = readMeta(textOf('.png.meta'))
    // 3 个 region(bubble 共用)+ 15 个 mesh,region 去重后一共 16 个
    expect(meta.sprites.length).toBe(16)
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
        for (let i = 0; i < 4; i++) {
          if (w.weight[i]! > 0) expect(w.bone[i]!).toBeLessThan(sprite.bones.length)
        }
      }
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

    for (const skin of part.skins) {
      for (const entry of skin.slots) {
        for (const attachment of entry.attachments) {
          if (attachment.type !== 'mesh') continue
          const verts = attachment.data['vertices'] as { weighted: boolean; positions: number[] }
          if (verts.weighted) continue

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
    expect(checked).toBeGreaterThan(0)
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

  it('有损的地方都报出来了,不静默', () => {
    const kinds = result.issues.map((i) => `${i.level}:${i.path}`)
    // deform 顶点动画和逐帧绘制顺序 Unity 确实没有对应物,必须报
    expect(kinds.some((k) => k.startsWith('loss:') && k.includes('deform'))).toBe(true)
    expect(kinds.some((k) => k.startsWith('loss:') && k.includes('drawOrder'))).toBe(true)
    // 网格绑定姿势现在是逐骨骼解出来的,不该再有「对不齐」这类近似
    expect(result.issues.filter((i) => i.level === 'approximated').length).toBeLessThan(3)
  })

  it('两次导出逐字节相同 —— 否则 Unity 里的引用会断', () => {
    const again = exportToUnity(part, atlas, sources, { name: 'MX2_cat', pixelsPerUnit: 100 })
    expect(again.files.length).toBe(result.files.length)
    again.files.forEach((file, i) => {
      const first = result.files[i]!
      expect(file.path).toBe(first.path)
      if (typeof file.content === 'string') expect(file.content).toBe(first.content)
      else expect([...file.content]).toEqual([...(first.content as Uint8Array)])
    })
  })
})
