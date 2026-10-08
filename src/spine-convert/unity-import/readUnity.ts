import type { Atlas, AtlasPage, AtlasRegion } from '../../core/atlas.ts'
import { decodePng, type Image } from '../../unity/png.ts'
import { parseMesh } from '../../unity/writeMesh.ts'
import { SPRITE_SKIN_SCRIPT_GUID } from '../../unity/writePrefab.ts'
import { list, map, num, parseUnityYaml, parseYamlDocument, ref, str, vec, type UnityObject, type YamlMap, type YamlValue } from '../../unity/yaml.ts'
import { IssueCollector, type ConversionIssue } from '../types.ts'
import { drawOrderOf } from '../../spine-eval/drawOrder.ts'
import { align, frameCurve, readHermite, toSpineKeys, valueAt, type SpineKey } from './curves.ts'

/**
 * Unity 产物(我们导出、可能又在 Unity 里改过的)→ Spine 4.1 JSON。
 *
 * 输出 Spine JSON 而不是直接拼中转模型:`fromJson` 已经拿真实文件逐项对过,字符串表下标这些细节交给它;
 * 顺带 Unity → Spine 也就有了。再接 Godot 写出器就是 Unity → Godot。
 *
 * ## 认的结构(与 spine-convert/unity/export.ts 写出的一致)
 *
 * - 根物体下,**不带渲染器的 Transform 是骨骼**,带 SpriteRenderer / SkinnedMeshRenderer 的是挂图节点
 * - 挂图节点名 `<slot>[__<键名>][#<帧>][@<皮肤>]`;绘制顺序取渲染器的 `m_SortingOrder`
 * - 位置单位是 Unity 单位,×`pixelsPerUnit` 换回 Spine 像素(导出时的 `--ppu`,默认 100)
 *
 * ## 几何全部转成 Spine 的 mesh(region 也是四顶点 mesh),都是精确的
 *
 * | Unity | Spine |
 * |---|---|
 * | SpriteRenderer(无 SpriteSkin) | 不加权 mesh:`骨骼局部 = 骨骼世界⁻¹ · 节点世界 · (顶点 − pivot)/ppu` |
 * | SpriteRenderer + SpriteSkin | 加权 mesh:sprite 骨骼按 Unity 的规则(根骨骼减 pivot,子骨骼不减)算绑定,`lᵢ = bindᵢ⁻¹ · v` |
 * | SkinnedMeshRenderer | 加权 mesh:`lᵢ = bindposeᵢ · v`;Blend Shape → deform,`dᵢ = lin(bindposeᵢ) · δ`,任何姿势下都精确 |
 *
 * 图集:每个 sprite 一个区域(Unity 的矩形原点在左下,换成左上);SkinnedMeshRenderer 的网格用整页做区域。
 *
 * ## 曲线
 *
 * Unity 的 Hermite 切线逐段精确变成 Spine 4.x 的贝塞尔(curves.ts)。换图 = 各挂图节点 `m_Enabled`;
 * 颜色四通道对齐关键帧(贝塞尔精确细分);逐帧绘制顺序 = `m_SortingOrder`。
 */

export interface UnityImportOptions {
  /** Unity 单位 → Spine 像素。与导出时的 `--ppu` 一致,默认 100 */
  readonly pixelsPerUnit?: number
}

export interface UnityImportResult {
  /** Spine 4.1 JSON 的根对象 */
  readonly json: Record<string, unknown>
  readonly atlas: Atlas
  /** 图集页名 → 图像 */
  readonly sources: Map<string, Image>
  readonly issues: readonly ConversionIssue[]
  /** 每个挂图节点(相对根物体的路径)读成了哪个 slot / 键名 / 皮肤 —— 排查与验收用 */
  readonly nodes: readonly { readonly path: string; readonly slot: string; readonly key: string; readonly skin: string }[]
}

type Json = Record<string, unknown>
type Affine = { a: number; b: number; c: number; d: number; x: number; y: number }

const DEG = Math.PI / 180
const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 }
const mul = (p: Affine, q: Affine): Affine => ({
  a: p.a * q.a + p.b * q.c, b: p.a * q.b + p.b * q.d,
  c: p.c * q.a + p.d * q.c, d: p.c * q.b + p.d * q.d,
  x: p.a * q.x + p.b * q.y + p.x, y: p.c * q.x + p.d * q.y + p.y,
})
const inverse = (m: Affine): Affine => {
  const det = m.a * m.d - m.b * m.c
  const a = m.d / det, b = -m.b / det, c = -m.c / det, d = m.a / det
  return { a, b, c, d, x: -(a * m.x + b * m.y), y: -(c * m.x + d * m.y) }
}
const apply = (m: Affine, x: number, y: number) => ({ x: m.a * x + m.b * y + m.x, y: m.c * x + m.d * y + m.y })
/** 四元数(只绕 z)→ 角度 */
const zDegrees = (q: { x: number; y: number; z: number; w: number }) => (2 * Math.atan2(q.z, q.w)) / DEG
/** Unity 的颜色是 {r, g, b, a},不是 {x, y, z, w} */
const rgbaOf = (v: YamlValue | undefined) => { const m = map(v); return { r: num(m['r'], 1), g: num(m['g'], 1), b: num(m['b'], 1), a: num(m['a'], 1) } }
const trs = (x: number, y: number, deg: number, sx: number, sy: number): Affine => {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG)
  return { a: c * sx, b: -s * sy, c: s * sx, d: c * sy, x, y }
}
const hex2 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')
const round = (v: number) => Math.round(v * 1e5) / 1e5

/** 小端 uint32 的十六进制串 → 三角形下标 */
function decodeIndices(hex: string): number[] {
  const out: number[] = []
  for (let i = 0; i + 8 <= hex.length; i += 8) {
    const b = hex.slice(i, i + 8)
    out.push(parseInt(b.slice(6, 8) + b.slice(4, 6) + b.slice(2, 4) + b.slice(0, 2), 16))
  }
  return out
}

interface NodeName {
  readonly slot: string
  readonly key: string
  readonly skin: string | null
}

/** `<slot>[__<键名>][#<帧>][@<皮肤>]` —— 与导出器的 attachmentNodeName 对应 */
function parseNodeName(name: string): NodeName {
  let rest = name
  let skin: string | null = null
  const at = rest.lastIndexOf('@')
  if (at > 0) {
    skin = rest.slice(at + 1)
    rest = rest.slice(0, at)
  }
  const sep = rest.indexOf('__')
  const slot = sep > 0 ? rest.slice(0, sep) : rest.replace(/#.*$/, '')
  const key = sep > 0 ? rest.slice(sep + 2) : rest === slot ? slot : rest
  return { slot, key, skin }
}

interface TransformNode {
  readonly id: string
  readonly name: string
  readonly parent: string | null
  readonly children: string[]
  readonly go: UnityObject
  readonly t: UnityObject
  readonly components: UnityObject[]
  /** 相对根物体的路径(动画曲线的 path) */
  path: string
}

export function importUnity(files: ReadonlyMap<string, string | Uint8Array>, options: UnityImportOptions = {}): UnityImportResult {
  const issues = new IssueCollector()
  const ppu = options.pixelsPerUnit ?? 100
  const text = (path: string): string => {
    const c = files.get(path)
    if (c === undefined) throw new Error(`缺文件 ${path}`)
    return typeof c === 'string' ? c : new TextDecoder().decode(c)
  }

  // ── GUID → 文件 ──
  const pathOfGuid = new Map<string, string>()
  for (const [path] of files) {
    if (!path.endsWith('.meta')) continue
    const guid = str(parseYamlDocument(text(path))['guid'])
    if (guid !== '') pathOfGuid.set(guid, path.slice(0, -'.meta'.length))
  }

  const prefabs = [...files.keys()].filter((p) => p.endsWith('.prefab'))
  if (prefabs.length !== 1) throw new Error(`目录里要正好一个 .prefab,找到 ${prefabs.length} 个`)
  const prefabName = prefabs[0]!.replace(/^.*\//, '').replace(/\.prefab$/, '')
  const objects = parseUnityYaml(text(prefabs[0]!))
  const byId = new Map(objects.map((o) => [o.fileID, o]))
  if (objects.some((o) => o.type === 'PrefabInstance')) {
    issues.add('loss', 'prefab', '预制体里有嵌套的 prefab 实例,没有展开读 —— 只读这个 prefab 自己的物体')
  }

  // ── Transform 树 ──
  const nodes = new Map<string, TransformNode>()
  for (const o of objects) {
    if (o.type !== 'Transform') continue
    const go = byId.get(ref(o.data['m_GameObject']).fileID)
    if (go === undefined) continue
    const father = ref(o.data['m_Father']).fileID
    nodes.set(o.fileID, {
      id: o.fileID,
      name: str(go.data['m_Name']),
      parent: father === '0' ? null : father,
      children: list(o.data['m_Children']).map((c) => ref(c).fileID),
      go,
      t: o,
      components: list(go.data['m_Component']).map((c) => byId.get(ref(map(c)['component']).fileID)).filter((c): c is UnityObject => c !== undefined),
      path: '',
    })
  }
  const roots = [...nodes.values()].filter((n) => n.parent === null)
  if (roots.length !== 1) throw new Error(`prefab 要有一个根物体,找到 ${roots.length} 个`)
  const container = roots[0]!
  const order: TransformNode[] = []
  const walk = (n: TransformNode, path: string) => {
    n.path = path
    order.push(n)
    for (const c of n.children) {
      const child = nodes.get(c)
      if (child !== undefined) walk(child, path === '' ? child.name : `${path}/${child.name}`)
    }
  }
  walk(container, '')
  const byPath = new Map(order.map((n) => [n.path, n]))
  const renderer = (n: TransformNode) => n.components.find((c) => c.type === 'SpriteRenderer' || c.type === 'SkinnedMeshRenderer')
  const spriteSkin = (n: TransformNode) => n.components.find((c) => c.type === 'MonoBehaviour' && ref(c.data['m_Script']).guid === SPRITE_SKIN_SCRIPT_GUID)

  // 局部 / 相对根物体的矩阵(Unity 单位)
  const localOf = (n: TransformNode): Affine => {
    const p = vec(n.t.data['m_LocalPosition'])
    const q = vec(n.t.data['m_LocalRotation'])
    const s = vec(n.t.data['m_LocalScale'])
    if (Math.abs(q.x) > 1e-6 || Math.abs(q.y) > 1e-6) issues.add('approximated', `transform.${n.path}`, '有绕 x / y 的旋转(3D),2D 骨骼只取绕 z 的部分')
    return trs(p.x, p.y, zDegrees(q), s.x, s.y)
  }
  const worldCache = new Map<string, Affine>()
  const worldOf = (n: TransformNode): Affine => {
    if (n === container) return IDENTITY
    const hit = worldCache.get(n.id)
    if (hit !== undefined) return hit
    const w = mul(worldOf(nodes.get(n.parent!)!), localOf(n))
    worldCache.set(n.id, w)
    return w
  }

  // ── 骨骼 ──
  const boneNodes = order.filter((n) => n !== container && renderer(n) === undefined)
  const boneName = new Map<string, string>()
  const used = new Set<string>()
  const claim = (wanted: string) => {
    let name = wanted
    for (let i = 2; used.has(name); i++) name = `${wanted}_${i}`
    used.add(name)
    return name
  }
  const topBones = boneNodes.filter((n) => n.parent === container.id)
  // Spine 只能有一根根骨骼:根物体下直接有几根骨骼时补一根
  const syntheticRoot = topBones.length === 1 ? null : claim('root')
  const bones: Json[] = []
  if (syntheticRoot !== null) bones.push({ name: syntheticRoot })
  const setup = new Map<string, { x: number; y: number; rotation: number; scaleX: number; scaleY: number }>()
  for (const n of boneNodes) {
    const name = claim(n.name)
    boneName.set(n.id, name)
    const p = vec(n.t.data['m_LocalPosition'])
    const s = vec(n.t.data['m_LocalScale'])
    const rotation = zDegrees(vec(n.t.data['m_LocalRotation']))
    const b: Json = { name }
    const parent = n.parent === container.id ? syntheticRoot : boneName.get(n.parent!)
    if (parent !== null && parent !== undefined) b['parent'] = parent
    const firstChild = n.children.map((c) => nodes.get(c)).find((c) => c !== undefined && renderer(c) === undefined)
    if (firstChild !== undefined) {
      const cp = vec(firstChild.t.data['m_LocalPosition'])
      const length = Math.hypot(cp.x, cp.y) * ppu
      if (length > 0.01) b['length'] = round(length)
    }
    if (p.x !== 0) b['x'] = round(p.x * ppu)
    if (p.y !== 0) b['y'] = round(p.y * ppu)
    if (Math.abs(rotation) > 1e-6) b['rotation'] = round(rotation)
    if (s.x !== 1) b['scaleX'] = round(s.x)
    if (s.y !== 1) b['scaleY'] = round(s.y)
    bones.push(b)
    setup.set(n.id, { x: p.x * ppu, y: p.y * ppu, rotation, scaleX: s.x, scaleY: s.y })
  }
  const rootBoneName = syntheticRoot ?? boneName.get(topBones[0]!.id)!

  // ── 贴图:guid → 页 ──
  const pages: AtlasPage[] = []
  const sources = new Map<string, Image>()
  const regions = new Map<string, AtlasRegion>()
  const textureMeta = new Map<string, { meta: YamlMap; page: AtlasPage; ppuTex: number }>()
  const pageOfGuid = (guid: string | null, where: string) => {
    if (guid === null) return null
    const hit = textureMeta.get(guid)
    if (hit !== undefined) return hit
    const path = pathOfGuid.get(guid)
    if (path === undefined || !files.has(path)) {
      issues.loss(where, `引用的贴图(guid ${guid})不在目录里`)
      return null
    }
    const bytes = files.get(path)!
    const image = decodePng(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes)
    const pageName = path.replace(/^.*\//, '')
    const page: AtlasPage = { name: pageName, width: image.width, height: image.height, pma: false }
    pages.push(page)
    sources.set(pageName, image)
    const meta = map(parseYamlDocument(text(`${path}.meta`))['TextureImporter'])
    const entry = { meta, page, ppuTex: num(meta['spritePixelsToUnits'], 100) }
    textureMeta.set(guid, entry)
    return entry
  }

  // ── 挂图节点 → slot / attachment ──
  interface SlotInfo { name: string; bone: string; order: number; index: number; color: string | null; attachment: string | null }
  const slots = new Map<string, SlotInfo>()
  const skins = new Map<string, Json>()
  /** 节点 id → (slot, 键名, 皮肤);动画按它把曲线归到 slot 上 */
  const attachmentOf = new Map<string, { slot: string; key: string; skin: string }>()
  const skinnedMeshes = new Map<string, { shapes: { name: string; deltas: { index: number; x: number; y: number }[] }[]; bindposes: Affine[]; boneOfIndex: string[]; weights: { bone: number; weight: number }[][]; flatStart: number[] }>()

  const nodeList = order.filter((n) => renderer(n) !== undefined)
  nodeList.forEach((n, index) => {
    const r = renderer(n)!
    const parsed = parseNodeName(n.name)
    const skin = parsed.skin ?? 'default'
    const parentBone = n.parent !== null && boneName.has(n.parent) ? boneName.get(n.parent)! : rootBoneName
    let slot = slots.get(parsed.slot)
    if (slot === undefined) {
      slot = { name: parsed.slot, bone: parentBone, order: num(r.data['m_SortingOrder']), index, color: null, attachment: null }
      slots.set(parsed.slot, slot)
    }
    const enabled = str(r.data['m_Enabled']) !== '0'
    if (enabled && skin === 'default' && slot.attachment === null) slot.attachment = parsed.key
    const skinJson = skins.get(skin) ?? {}
    skins.set(skin, skinJson)
    const bySlot = (skinJson[parsed.slot] as Json | undefined) ?? {}
    skinJson[parsed.slot] = bySlot
    let key = parsed.key
    for (let i = 2; key in bySlot; i++) key = `${parsed.key}_${i}`
    attachmentOf.set(n.id, { slot: parsed.slot, key, skin })
    const where = `node.${n.path}`

    if (r.type === 'SpriteRenderer') {
      const c = rgbaOf(r.data['m_Color'])
      const color = `${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${hex2(c.a)}`
      if (slot.color === null) slot.color = color
      const sref = ref(r.data['m_Sprite'])
      const tex = pageOfGuid(sref.guid, where)
      if (tex === null) return
      const sprite = list(map(tex.meta['spriteSheet'])['sprites']).map(map).find((s) => str(s['internalID']) === sref.fileID)
      if (sprite === undefined) {
        issues.loss(where, `贴图里找不到 sprite(internalID ${sref.fileID})`)
        return
      }
      const rect = map(sprite['rect'])
      const rw = num(rect['width']), rh = num(rect['height'])
      const pivot = map(sprite['pivot'])
      const px = num(pivot['x'], 0.5) * rw, py = num(pivot['y'], 0.5) * rh
      const regionName = str(sprite['name'])
      regions.set(regionName, {
        name: regionName, page: tex.page.name,
        x: num(rect['x']), y: tex.page.height - num(rect['y']) - rh, width: rw, height: rh,
        rotate: 0, offsetX: 0, offsetY: 0, originalWidth: rw, originalHeight: rh, index: -1,
      })
      const verts = list(sprite['vertices']).map((v) => ({ x: num(map(v)['x']), y: num(map(v)['y']) }))
      const triangles = decodeIndices(str(sprite['indices']))
      const uvs = verts.flatMap((v) => [round(v.x / rw), round(1 - v.y / rh)])
      const local = verts.map((v) => ({ x: (v.x - px) / tex.ppuTex, y: (v.y - py) / tex.ppuTex }))
      const skinComp = spriteSkin(n)
      let vertices: number[]
      if (skinComp !== undefined) {
        // 加权:sprite 骨骼的绑定 —— 根骨骼减 pivot,子骨骼相对父骨骼(writeMeta.ts 开头那三条约定)
        const spriteBones = list(sprite['bones']).map(map)
        const binds: Affine[] = []
        spriteBones.forEach((b, i) => {
          const pos = map(b['position'])
          const parentId = num(b['parentId'], -1)
          const deg = zDegrees(vec(b['rotation']))
          const isRoot = parentId < 0
          const x = (num(pos['x']) - (isRoot ? px : 0)) / tex.ppuTex
          const y = (num(pos['y']) - (isRoot ? py : 0)) / tex.ppuTex
          binds[i] = isRoot ? trs(x, y, deg, 1, 1) : mul(binds[parentId]!, trs(x, y, deg, 1, 1))
        })
        const boneTransforms = list(skinComp.data['m_BoneTransforms']).map((t) => ref(t).fileID)
        const nodeWorld = worldOf(n)
        if (Math.hypot(nodeWorld.x, nodeWorld.y) > 1e-6 || Math.abs(nodeWorld.a - 1) > 1e-6 || Math.abs(nodeWorld.b) > 1e-6) {
          issues.add('approximated', where, 'SpriteSkin 节点不在根物体原点,按原点处理')
        }
        const weights = list(sprite['weights']).map(map)
        vertices = []
        local.forEach((v, i) => {
          const w = weights[i] ?? {}
          const infl: number[] = []
          for (let k = 0; k < 4; k++) {
            const weight = num(w[`weight[${k}]`])
            if (weight <= 0) continue
            const bi = num(w[`boneIndex[${k}]`])
            const target = boneName.get(boneTransforms[bi] ?? '')
            if (target === undefined || binds[bi] === undefined) continue
            const l = apply(inverse(binds[bi]!), v.x, v.y)
            infl.push(boneIndexOf(target), round(l.x * ppu), round(l.y * ppu), round(weight))
          }
          vertices.push(infl.length / 4, ...infl)
        })
      } else {
        // 不加权:骨骼局部 = 骨骼世界⁻¹ · 节点世界 · 顶点
        const toBone = mul(inverse(parentBone === rootBoneName && syntheticRoot !== null ? IDENTITY : boneWorld(parentBone)), worldOf(n))
        vertices = local.flatMap((v) => { const p = apply(toBone, v.x, v.y); return [round(p.x * ppu), round(p.y * ppu)] })
      }
      bySlot[key] = { type: 'mesh', path: regionName, uvs, triangles, vertices, hull: 0, width: rw, height: rh }
      return
    }

    // ── SkinnedMeshRenderer ──
    const meshGuid = ref(r.data['m_Mesh']).guid
    const meshPath = meshGuid === null ? undefined : pathOfGuid.get(meshGuid)
    if (meshPath === undefined || !files.has(meshPath)) {
      issues.loss(where, 'SkinnedMeshRenderer 引用的 Mesh 不在目录里')
      return
    }
    const mesh = parseMesh(text(meshPath))
    const materialGuid = ref(list(r.data['m_Materials'])[0]).guid
    const materialPath = materialGuid === null ? undefined : pathOfGuid.get(materialGuid)
    const texGuid = materialPath === undefined ? null : textureOfMaterial(text(materialPath))
    const tex = pageOfGuid(texGuid, where)
    if (tex === null) return
    const regionName = `${prefabName}#${n.name}`
    regions.set(regionName, {
      name: regionName, page: tex.page.name, x: 0, y: 0, width: tex.page.width, height: tex.page.height,
      rotate: 0, offsetX: 0, offsetY: 0, originalWidth: tex.page.width, originalHeight: tex.page.height, index: -1,
    })
    const boneIds = list(r.data['m_Bones']).map((b) => ref(b).fileID)
    const boneOfIndex = boneIds.map((id) => boneName.get(id) ?? rootBoneName)
    const weights = mesh.fullWeights.length === mesh.vertexCount ? mesh.fullWeights : mesh.streamWeights
    const vertices: number[] = []
    const flatStart: number[] = []
    let flat = 0
    mesh.positions.forEach((p, i) => {
      const ws = (weights[i] ?? []).filter((w) => w.weight > 0)
      flatStart.push(flat)
      vertices.push(ws.length)
      for (const w of ws) {
        const l = apply(mesh.bindposes[w.bone] ?? IDENTITY, p.x, p.y)
        vertices.push(boneIndexOf(boneOfIndex[w.bone]!), round(l.x * ppu), round(l.y * ppu), round(w.weight))
        flat += 2
      }
    })
    const c = mesh.colors[0]
    if (c !== undefined && slot.color === null) slot.color = `${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${hex2(c.a)}`
    bySlot[key] = {
      type: 'mesh', path: regionName,
      uvs: mesh.uvs.flatMap((uv) => [round(uv.u), round(1 - uv.v)]),
      triangles: mesh.triangles, vertices, hull: 0,
    }
    skinnedMeshes.set(n.id, { shapes: mesh.blendShapes, bindposes: mesh.bindposes, boneOfIndex, weights: weights.map((ws) => ws.filter((w) => w.weight > 0)), flatStart })
  })

  // 骨骼名 → JSON 里的下标(加权顶点按下标引用)
  function boneIndexOf(name: string): number {
    return bones.findIndex((b) => b['name'] === name)
  }
  function boneWorld(name: string): Affine {
    const id = [...boneName.entries()].find(([, v]) => v === name)?.[0]
    return id === undefined ? IDENTITY : worldOf(nodes.get(id)!)
  }

  // slot 顺序:sortingOrder,相同的按 prefab 里的先后
  const slotList = [...slots.values()].sort((a, b) => a.order - b.order || a.index - b.index)
  const slotIndex = new Map(slotList.map((s, i) => [s.name, i]))

  // ── 动画 ──
  const clipOrder = controllerOrder(files, text, pathOfGuid)
  const clips = [...files.keys()].filter((p) => p.endsWith('.anim'))
  clips.sort((a, b) => (clipOrder.get(a) ?? 1e9) - (clipOrder.get(b) ?? 1e9) || a.localeCompare(b))
  const animations: Json = {}
  for (const clipPath of clips) {
    const clip = parseUnityYaml(text(clipPath)).find((o) => o.type === 'AnimationClip')
    if (clip === undefined) continue
    const clipName = str(clip.data['m_Name'])
    // 皮肤 clip(只写 m_IsActive)是皮肤的实现细节,不是动画
    if (clipName.includes('@skin@')) continue
    const animName = clipName.startsWith(`${prefabName}@`) ? clipName.slice(prefabName.length + 1) : clipName
    issues.scoped(animName, () => {
      animations[animName] = readClip(clip.data)
    })
  }

  function readClip(data: YamlMap): Json {
    const out: Json = {}
    // Unity 把时刻只写 7 位有效数字(11/30 秒写成 0.3666667):离帧格很近的吸附回帧格,
    // 否则阶梯跳变差出几微秒,正好在跳变那一刻采样就对不上
    const fps = num(data['m_SampleRate'], 30)
    const snap = (t: number) => {
      const f = t * fps
      const r = Math.round(f)
      return Math.abs(f - r) < 1e-3 ? r / fps : t
    }
    const hermite = (curve: YamlValue | undefined, component?: 'x' | 'y' | 'z') => readHermite(curve, component).map((k) => ({ ...k, time: snap(k.time) }))
    const bonesOut: Json = {}
    const boneAt = (path: string) => {
      const n = byPath.get(path)
      return n === undefined ? undefined : boneName.has(n.id) ? n : undefined
    }
    const vectorCurves = (field: string, kind: 'translate' | 'rotate' | 'scale') => {
      for (const entry of list(data[field]).map(map)) {
        const path = str(entry['path'])
        const n = boneAt(path)
        if (n === undefined) {
          issues.add('loss', `${field}.${path}`, '曲线指向的物体不是骨骼(或不存在),没转')
          continue
        }
        const s = setup.get(n.id)!
        const byKind = (bonesOut[boneName.get(n.id)!] as Json | undefined) ?? {}
        bonesOut[boneName.get(n.id)!] = byKind
        if (kind === 'rotate') {
          const keys = toSpineKeys(hermite(entry['curve'], 'z'), (v) => v - s.rotation)
          byKind['rotate'] = keysToFrames([keys], (vs) => ({ value: vs[0] }))
        } else if (kind === 'translate') {
          const [x, y] = align([
            toSpineKeys(hermite(entry['curve'], 'x'), (v) => v * ppu - s.x),
            toSpineKeys(hermite(entry['curve'], 'y'), (v) => v * ppu - s.y),
          ])
          byKind['translate'] = keysToFrames([x!, y!], (vs) => ({ x: vs[0], y: vs[1] }))
        } else {
          const [x, y] = align([
            toSpineKeys(hermite(entry['curve'], 'x'), (v) => (s.scaleX === 0 ? v : v / s.scaleX)),
            toSpineKeys(hermite(entry['curve'], 'y'), (v) => (s.scaleY === 0 ? v : v / s.scaleY)),
          ])
          byKind['scale'] = keysToFrames([x!, y!], (vs) => ({ x: vs[0], y: vs[1] }))
        }
      }
    }
    vectorCurves('m_PositionCurves', 'translate')
    vectorCurves('m_EulerCurves', 'rotate')
    vectorCurves('m_ScaleCurves', 'scale')
    if (list(data['m_RotationCurves']).length > 0) {
      issues.add('loss', 'm_RotationCurves', '四元数旋转曲线没转(导出时写的是欧拉曲线;在 Unity 里改成四元数插值后才会有)')
    }
    if (Object.keys(bonesOut).length > 0) out['bones'] = bonesOut

    // 渲染器的曲线按节点归到 slot
    const enabled = new Map<string, Map<string, SpineKey[]>>()
    const colors = new Map<string, Map<string, SpineKey[]>>()
    const sorting = new Map<string, SpineKey[]>()
    const blend = new Map<string, Map<string, SpineKey[]>>()
    for (const entry of list(data['m_FloatCurves']).map(map)) {
      const path = str(entry['path'])
      const attribute = str(entry['attribute'])
      const n = byPath.get(path)
      const att = n === undefined ? undefined : attachmentOf.get(n.id)
      const keys = toSpineKeys(hermite(entry['curve']))
      if (n === undefined || att === undefined) {
        issues.add('loss', `${attribute}.${path}`, '曲线指向的物体不是挂图节点(或不存在),没转')
        continue
      }
      if (attribute === 'm_Enabled') {
        const perSlot = enabled.get(att.slot) ?? new Map()
        enabled.set(att.slot, perSlot)
        perSlot.set(n.id, keys)
      } else if (attribute.startsWith('m_Color.')) {
        const perNode = colors.get(n.id) ?? new Map()
        colors.set(n.id, perNode)
        perNode.set(attribute.slice('m_Color.'.length), keys)
      } else if (attribute === 'm_SortingOrder') {
        if (!sorting.has(att.slot)) sorting.set(att.slot, keys)
      } else if (attribute.startsWith('blendShape.')) {
        const perNode = blend.get(n.id) ?? new Map()
        blend.set(n.id, perNode)
        perNode.set(attribute.slice('blendShape.'.length), keys)
      } else if (attribute !== 'm_IsActive') {
        issues.add('loss', `${attribute}.${path}`, `属性 ${attribute} 的曲线没转`)
      }
    }
    if (list(data['m_PPtrCurves']).length > 0) issues.add('loss', 'm_PPtrCurves', '换 sprite 的曲线(m_Sprite)没转 —— 导出时换图用的是节点显隐')

    const slotsOut: Json = {}
    const slotOut = (name: string) => {
      const s = (slotsOut[name] as Json | undefined) ?? {}
      slotsOut[name] = s
      return s
    }
    // 换图:同一 slot 各节点的 m_Enabled 合成「这一刻挂哪个键名」
    for (const [slotName, perNode] of enabled) {
      const times = [...new Set([...perNode.values()].flatMap((k) => k.map((x) => x.time)))].sort((a, b) => a - b)
      const frames: Json[] = []
      let last: string | null | undefined
      for (const t of times) {
        const on = [...perNode.entries()].filter(([, keys]) => valueAt(keys, t) >= 0.5).map(([id]) => attachmentOf.get(id)!.key)
        const distinct = [...new Set(on)]
        if (distinct.length > 1) issues.add('approximated', `attachment[${slotName}]`, `${t.toFixed(3)} 秒同一 slot 亮着 ${distinct.length} 个挂图节点(${distinct.join('、')}),Spine 一个 slot 只能挂一个,取第一个`)
        const name = distinct[0] ?? null
        if (name === last) continue
        last = name
        frames.push(t === 0 ? { name } : { time: t, name })
      }
      slotOut(slotName)['attachment'] = frames
    }
    // 颜色:取该 slot 第一个有颜色曲线的节点,四通道补齐关键帧
    const colorDone = new Set<string>()
    for (const [id, channels] of colors) {
      const att = attachmentOf.get(id)!
      if (colorDone.has(att.slot)) continue
      colorDone.add(att.slot)
      const n = nodes.get(id)!
      const base = rgbaOf(renderer(n)!.data['m_Color'])
      const pick = (c: string, fallback: number) => channels.get(c) ?? [{ time: 0, value: fallback }]
      const [r, g, b, a] = align([pick('r', base.r), pick('g', base.g), pick('b', base.b), pick('a', base.a)])
      slotOut(att.slot)['rgba'] = keysToFrames([r!, g!, b!, a!], (vs) => ({ color: `${hex2(vs[0]!)}${hex2(vs[1]!)}${hex2(vs[2]!)}${hex2(vs[3]!)}` }))
    }
    if (Object.keys(slotsOut).length > 0) out['slots'] = slotsOut

    // 逐帧绘制顺序:各 slot 的 sortingOrder 在关键帧时刻排一次序,换算成 Spine 的偏移
    if (sorting.size > 0) {
      const times = [...new Set([...sorting.values()].flatMap((k) => k.map((x) => x.time)))].sort((a, b) => a - b)
      out['drawOrder'] = times.map((t) => {
        const orderAt = slotList.map((s, i) => ({ name: s.name, i, v: sorting.has(s.name) ? valueAt(sorting.get(s.name)!, t) : s.order }))
        const sorted = [...orderAt].sort((p, q) => p.v - q.v || p.i - q.i)
        const offsets = sorted.map((s, newIndex) => ({ slot: s.name, offset: newIndex - s.i })).filter((o) => o.offset !== 0)
        // 自检:按 Spine 的规则铺回去要得到同一个顺序
        const rebuilt = drawOrderOf(slotList.length, offsets.map((o) => ({ slot: slotIndex.get(o.slot)!, offset: o.offset })))
        if (rebuilt.some((s, k) => s !== sorted[k]!.i)) issues.add('approximated', 'drawOrder', `${t.toFixed(3)} 秒的绘制顺序换算不回来`)
        const frame: Json = t === 0 ? {} : { time: t }
        if (offsets.length > 0) frame['offsets'] = offsets
        return frame
      })
    }

    // Blend Shape → deform
    const deform: Json = {}
    for (const [id, shapesCurves] of blend) {
      const geo = skinnedMeshes.get(id)
      const att = attachmentOf.get(id)!
      if (geo === undefined) continue
      const d = blendToDeform(geo, shapesCurves, ppu, att.key, issues)
      if (d === null) continue
      const bySkin = (deform[att.skin] as Json | undefined) ?? {}
      deform[att.skin] = bySkin
      const bySlot = (bySkin[att.slot] as Json | undefined) ?? {}
      bySkin[att.slot] = bySlot
      bySlot[att.key] = { deform: d }
    }
    if (Object.keys(deform).length > 0) out['attachments'] = deform
    return out
  }

  // ── 组装 ──
  const json: Json = {
    skeleton: { spine: '4.1.23', hash: '' },
    bones,
    slots: slotList.map((s) => {
      const j: Json = { name: s.name, bone: s.bone }
      if (s.color !== null && s.color !== 'ffffffff') j['color'] = s.color
      if (s.attachment !== null) j['attachment'] = s.attachment
      return j
    }),
    skins: [...skins.entries()]
      .sort(([a], [b]) => (a === 'default' ? -1 : b === 'default' ? 1 : 0))
      .map(([name, attachments]) => ({ name, attachments })),
    animations,
  }
  const nodesOut = [...attachmentOf.entries()].map(([id, a]) => ({ path: nodes.get(id)!.path, ...a }))
  return { json, atlas: { pages, regions }, sources, issues: issues.all, nodes: nodesOut }
}

/** 键序列 → Spine 4.x JSON 的帧:各分量已对齐到同一组时刻 */
function keysToFrames(components: readonly (readonly SpineKey[])[], values: (vs: number[]) => Json): Json[] {
  const n = components[0]!.length
  const out: Json[] = []
  for (let i = 0; i < n; i++) {
    const vs = components.map((c) => c[i]!.value)
    const frame: Json = {}
    const t = components[0]![i]!.time
    if (t !== 0) frame['time'] = t
    for (const [k, v] of Object.entries(values(vs))) frame[k] = typeof v === 'number' ? round(v) : v
    if (i + 1 < n) {
      const { curve } = frameCurve(components.map((c) => ({ a: c[i]!, b: c[i + 1]! })))
      if (curve !== undefined) frame['curve'] = curve
    }
    out.push(frame)
  }
  return out
}

/**
 * Blend Shape 权重曲线 → Spine deform。关键帧取所有目标的关键帧时刻并集,每一刻的形变 δ = Σ (w/100)·Δ,
 * 换到 Spine 的逐影响偏移 `dᵢ = lin(bindposeᵢ) · δ` —— Unity 是「加完再蒙皮」,这一步任何姿势下都精确。
 *
 * 段内的曲线:我们导出的写法是「相邻两个目标此消彼长、共用同一条进度曲线」,这时 Spine 的一段就是那条曲线,精确;
 * 认不出这种写法(用户在 Unity 里改过)就按 30 fps 采样成直线,报近似。
 */
function blendToDeform(
  geo: { shapes: { name: string; deltas: { index: number; x: number; y: number }[] }[]; bindposes: Affine[]; weights: { bone: number; weight: number }[][]; flatStart: number[] },
  curves: ReadonlyMap<string, SpineKey[]>,
  ppu: number,
  key: string,
  issues: IssueCollector,
): Json[] | null {
  const shapes = geo.shapes.filter((s) => curves.has(s.name))
  if (shapes.length === 0) return null
  const times = [...new Set(shapes.flatMap((s) => curves.get(s.name)!.map((k) => k.time)))].sort((a, b) => a - b)
  const offsetsAt = (t: number): number[] => {
    const delta = new Map<number, { x: number; y: number }>()
    for (const s of shapes) {
      const w = valueAt(curves.get(s.name)!, t) / 100
      if (Math.abs(w) < 1e-9) continue
      for (const d of s.deltas) {
        const cur = delta.get(d.index) ?? { x: 0, y: 0 }
        delta.set(d.index, { x: cur.x + d.x * w, y: cur.y + d.y * w })
      }
    }
    const flat: number[] = []
    geo.weights.forEach((ws, i) => {
      const dv = delta.get(i) ?? { x: 0, y: 0 }
      for (const w of ws) {
        const m = geo.bindposes[w.bone] ?? IDENTITY
        flat.push(round((m.a * dv.x + m.b * dv.y) * ppu), round((m.c * dv.x + m.d * dv.y) * ppu))
      }
    })
    return flat
  }
  // 段内是否是「共用一条进度曲线」:该段每个变化的目标,归一化到 0..1 后的曲线相同。
  // 返回 undefined = 直线,'stepped',控制点数组,或 null = 认不出
  const segmentCurve = (t0: number, t1: number): unknown => {
    let shape: string | null = null
    let result: unknown
    for (const sh of shapes) {
      const keys = curves.get(sh.name)!
      const va = valueAt(keys, t0)
      const vb = valueAt(keys, t1)
      if (Math.abs(vb - va) < 1e-9) continue
      const k0 = keys.find((k) => Math.abs(k.time - t0) < 1e-9)
      const k1 = keys.find((k) => Math.abs(k.time - t1) < 1e-9)
      if (k0 === undefined || k1 === undefined) return null
      const seg = k0.segment ?? { kind: 'linear' as const }
      const norm: unknown = seg.kind === 'bezier'
        ? [seg.c[0], (seg.c[1] - va) / (vb - va), seg.c[2], (seg.c[3] - va) / (vb - va)].map(round)
        : seg.kind === 'stepped' ? 'stepped' : undefined
      const signature = JSON.stringify(norm ?? 'linear')
      if (shape === null) { shape = signature; result = norm }
      else if (shape !== signature) return null
    }
    return result
  }
  const frames: Json[] = []
  let sampled = false
  for (let i = 0; i < times.length; i++) {
    const t = times[i]!
    const frame: Json = t === 0 ? {} : { time: t }
    frame['vertices'] = offsetsAt(t)
    const next = times[i + 1]
    if (next !== undefined) {
      const curve = segmentCurve(t, next)
      if (curve === null) {
        // 认不出:段内按 30 fps 插采样帧
        sampled = true
        frames.push(frame)
        for (let s = t + 1 / 30; s < next - 1e-6; s += 1 / 30) frames.push({ time: s, vertices: offsetsAt(s) })
        continue
      }
      if (curve !== undefined) frame['curve'] = curve
    }
    frames.push(frame)
  }
  if (sampled) issues.add('approximated', `deform[${key}]`, 'Blend Shape 权重曲线不是导出时的写法(在 Unity 里改过),段内按 30 fps 采样成直线')
  return frames
}

/** 材质里 _MainTex 的贴图 guid */
function textureOfMaterial(matText: string): string | null {
  const mat = parseUnityYaml(matText).find((o) => o.type === 'Material')
  const envs = list(map(mat?.data['m_SavedProperties'])['m_TexEnvs'])
  for (const e of envs) {
    const tex = map(map(e)['_MainTex'])
    if (Object.keys(tex).length > 0) return ref(tex['m_Texture']).guid
  }
  return null
}

/** controller 里 Base Layer 的 state 顺序 → .anim 文件路径的次序 */
function controllerOrder(files: ReadonlyMap<string, unknown>, text: (p: string) => string, pathOfGuid: ReadonlyMap<string, string>): Map<string, number> {
  const out = new Map<string, number>()
  const controller = [...files.keys()].find((p) => p.endsWith('.controller'))
  if (controller === undefined) return out
  let i = 0
  for (const o of parseUnityYaml(text(controller))) {
    if (o.type !== 'AnimatorState') continue
    const guid = ref(o.data['m_Motion']).guid
    const path = guid === null ? undefined : pathOfGuid.get(guid)
    if (path !== undefined && !out.has(path)) out.set(path, i++)
  }
  return out
}

export type { YamlValue }
