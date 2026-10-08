import type { Atlas, AtlasPage, AtlasRegion } from '../../core/atlas.ts'
import { decodePng, type Image } from '../../unity/png.ts'
import { parseMesh } from '../../unity/writeMesh.ts'
import { SPRITE_SKIN_SCRIPT_GUID } from '../../unity/writePrefab.ts'
import { spriteRecord } from '../../unity/spriteMeta.ts'
import { list, map, num, parseUnityYaml, parseYamlDocument, ref, str, vec, type UnityObject, type UnityRef, type YamlMap, type YamlValue } from '../../unity/yaml.ts'
import { IssueCollector, type ConversionIssue } from '../types.ts'
import { drawOrderOf } from '../../spine-eval/drawOrder.ts'
import { align, frameCurve, readHermite, toSpineKeys, valueAt, type SpineKey } from './curves.ts'
import { expandPsdImports } from './expandPsd.ts'

/**
 * Unity 角色(我们导出、在 Unity 里改过的,或者别的工具 / 手工在 Unity 里做的)→ Spine 4.1 JSON。
 *
 * 输出 Spine JSON 而不是直接拼中转模型:`fromJson` 已经拿真实文件逐项对过,字符串表下标这些细节交给它;
 * 顺带 Unity → Spine 也就有了。再接 Godot 写出器就是 Unity → Godot。
 *
 * ## 结构
 *
 * - 一个目录一个角色:正好一个 `.prefab`,根物体是角色本身(它的变换是摆在场景里的位置,不算骨骼)
 * - **骨骼**:不带渲染器的物体;带渲染器的物体下面挂着东西、被变换曲线驱动、或被蒙皮引用时也是骨骼
 *   (别人做的角色常把图直接挂在骨骼上)
 * - **slot**:每个带 SpriteRenderer / SkinnedMeshRenderer 的物体。我们导出的物体名 `<slot>[__<键名>][#<帧>][@<皮肤>]`
 *   会把几个物体合成一个 slot —— 合不起来的(setup 时同时亮着、或挂在不同骨骼上)按物体各自成 slot
 * - **显示** = 渲染器 `m_Enabled` 且自己和各级父物体 `m_IsActive`(Unity 的规则);`m_Sprite` 曲线换图,每张图一个 attachment。
 *   我们导出的多皮肤角色里,挂图物体自己的 `m_IsActive` 是皮肤那一维,交给 Spine 的皮肤
 * - **绘制顺序**:Sorting Group → Sorting Layer → Order in Layer → z(离镜头远的先画)→ 层级先后
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
 * Unity 的 Hermite 切线逐段精确变成 Spine 4.x 的贝塞尔(curves.ts)。第一个键不在 0 秒的,0 秒补一个同值的键
 * (Unity 在第一个键之前取第一个键的值,Spine 取 setup)。clip 比最后一个键长的,末尾补一个不改变任何东西的
 * 绘制顺序帧把时长撑回来(Spine 的时长 = 最后一个键)。
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
  /**
   * 每个挂图物体(相对根物体的路径)的每张图读成了哪个 slot / 键名 / 皮肤 —— 排查与验收用。
   * `sprite` 是贴图引用 `guid:fileID`(SkinnedMeshRenderer 为 null)
   */
  readonly nodes: readonly { readonly path: string; readonly slot: string; readonly key: string; readonly skin: string; readonly sprite: string | null }[]
  /** prefab 里亮着的那套具名皮肤(没有就是 null,用默认皮肤) */
  readonly initialSkin: string | null
  /** 角色名(prefab 的文件名;PSD Importer 的角色是 Photoshop 文件名) */
  readonly name: string
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
const spriteId = (r: UnityRef): string | null => (r.guid === null || r.fileID === '0' ? null : `${r.guid}:${r.fileID}`)
/** 依次比较:Sorting Group 链上每一层、再到渲染器自己的 [层, 序, −z, 层级先后] */
const compareKeys = (p: readonly number[], q: readonly number[]) => {
  for (let i = 0; i < Math.min(p.length, q.length); i++) if (p[i] !== q[i]) return p[i]! - q[i]!
  return p.length - q.length
}

/** Unity 的 classID */
const CLASS_GAME_OBJECT = 1
const CLASS_SKINNED_MESH_RENDERER = 137
const CLASS_SORTING_GROUP = 210
const CLASS_SPRITE_RENDERER = 212
const TRANSFORM_CURVES = ['m_PositionCurves', 'm_EulerCurves', 'm_ScaleCurves', 'm_RotationCurves'] as const

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
  /** 层级里的先后(深度优先) */
  index: number
}

export function importUnity(input: ReadonlyMap<string, string | Uint8Array>, options: UnityImportOptions = {}): UnityImportResult {
  const issues = new IssueCollector()
  // PSD Importer 的角色(.psb / .psd)先展开成等价的 prefab + 贴图
  const expanded = expandPsdImports(input)
  for (const i of expanded.issues) issues.add(i.level, i.path, i.message)
  const files: ReadonlyMap<string, string | Uint8Array> = expanded.files
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
      index: 0,
    })
  }
  const roots = [...nodes.values()].filter((n) => n.parent === null)
  if (roots.length !== 1) throw new Error(`prefab 要有一个根物体,找到 ${roots.length} 个`)
  const container = roots[0]!
  const order: TransformNode[] = []
  const walk = (n: TransformNode, path: string) => {
    n.path = path
    n.index = order.length
    order.push(n)
    for (const c of n.children) {
      const child = nodes.get(c)
      if (child !== undefined) walk(child, path === '' ? child.name : `${path}/${child.name}`)
    }
  }
  walk(container, '')
  // 同名兄弟的路径相同:Unity 的曲线绑定到第一个
  const byPath = new Map<string, TransformNode>()
  for (const n of order) if (!byPath.has(n.path)) byPath.set(n.path, n)
  const renderer = (n: TransformNode) => n.components.find((c) => c.type === 'SpriteRenderer' || c.type === 'SkinnedMeshRenderer')
  const spriteSkin = (n: TransformNode) => n.components.find((c) => c.type === 'MonoBehaviour' && ref(c.data['m_Script']).guid === SPRITE_SKIN_SCRIPT_GUID)
  const parentOf = (n: TransformNode) => (n.parent === null ? undefined : nodes.get(n.parent))
  /** 自己和各级父物体(不含根物体),由内到外 */
  const chainOf = (n: TransformNode): TransformNode[] => {
    const out: TransformNode[] = []
    for (let m: TransformNode | undefined = n; m !== undefined && m !== container; m = parentOf(m)) out.push(m)
    return out
  }

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
  /** 相对根物体的 z(只用来排绘制顺序) */
  const zOf = (n: TransformNode): number => {
    let z = 0
    const chain = chainOf(n).reverse()
    let scale = 1
    for (const m of chain) {
      z += vec(m.t.data['m_LocalPosition']).z * scale
      scale *= vec(m.t.data['m_LocalScale']).z || 1
    }
    return z
  }

  // ── 动画 clip:先解析 —— 哪些物体被变换曲线驱动,决定它是不是骨骼 ──
  const clipOrder = controllerOrder(files, text, pathOfGuid)
  const clipPaths = [...files.keys()].filter((p) => p.endsWith('.anim'))
  clipPaths.sort((a, b) => (clipOrder.get(a) ?? 1e9) - (clipOrder.get(b) ?? 1e9) || a.localeCompare(b))
  const clips = clipPaths
    .map((p) => parseUnityYaml(text(p)).find((o) => o.type === 'AnimationClip'))
    .filter((c): c is UnityObject => c !== undefined)
    .map((c) => ({ name: str(c.data['m_Name']), data: c.data }))
    // 皮肤 clip(我们导出的多皮肤角色,只写 m_IsActive)是皮肤的实现细节,不是动画
    .filter((c) => !c.name.includes('@skin@'))
  const transformDriven = new Set<string>()
  /** 物体 id → m_Sprite 曲线里出现过的图 */
  const curveSprites = new Map<string, UnityRef[]>()
  for (const c of clips) {
    for (const field of TRANSFORM_CURVES) for (const e of list(c.data[field]).map(map)) transformDriven.add(str(e['path']))
    for (const e of list(c.data['m_PPtrCurves']).map(map)) {
      const n = byPath.get(str(e['path']))
      if (n === undefined || str(e['attribute']) !== 'm_Sprite' || num(e['classID']) !== CLASS_SPRITE_RENDERER) continue
      const refs = curveSprites.get(n.id) ?? []
      curveSprites.set(n.id, refs)
      for (const k of list(e['curve'])) refs.push(ref(map(k)['value']))
    }
  }
  const referencedAsBone = new Set<string>()
  for (const n of order) {
    for (const t of list(spriteSkin(n)?.data['m_BoneTransforms'])) referencedAsBone.add(ref(t).fileID)
    const r = renderer(n)
    if (r?.type === 'SkinnedMeshRenderer') for (const b of list(r.data['m_Bones'])) referencedAsBone.add(ref(b).fileID)
  }

  // ── 骨骼 ──
  const isBone = (n: TransformNode) =>
    n !== container &&
    (renderer(n) === undefined || n.children.some((c) => nodes.has(c)) || transformDriven.has(n.path) || referencedAsBone.has(n.id))
  const boneNodes = order.filter(isBone)
  const boneName = new Map<string, string>()
  const used = new Set<string>()
  const claim = (taken: Set<string>, wanted: string) => {
    let name = wanted
    for (let i = 2; taken.has(name); i++) name = `${wanted}_${i}`
    taken.add(name)
    return name
  }
  const topBones = boneNodes.filter((n) => n.parent === container.id)
  // Spine 只能有一根根骨骼:根物体下直接有几根骨骼(或一根都没有)时补一根
  const syntheticRoot = topBones.length === 1 ? null : claim(used, 'root')
  const bones: Json[] = []
  if (syntheticRoot !== null) bones.push({ name: syntheticRoot })
  const setup = new Map<string, { x: number; y: number; rotation: number; scaleX: number; scaleY: number }>()
  for (const n of boneNodes) {
    const name = claim(used, n.name)
    boneName.set(n.id, name)
    const p = vec(n.t.data['m_LocalPosition'])
    const s = vec(n.t.data['m_LocalScale'])
    const rotation = zDegrees(vec(n.t.data['m_LocalRotation']))
    const b: Json = { name }
    const parent = n.parent === container.id ? syntheticRoot : boneName.get(n.parent!)
    if (parent !== null && parent !== undefined) b['parent'] = parent
    const firstChild = n.children.map((c) => nodes.get(c)).find((c) => c !== undefined && isBone(c))
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
  // 骨骼名 → JSON 里的下标(加权顶点按下标引用)
  const boneIndexOf = (name: string): number => bones.findIndex((b) => b['name'] === name)
  const boneWorld = (name: string): Affine => {
    const id = [...boneName.entries()].find(([, v]) => v === name)?.[0]
    return id === undefined ? IDENTITY : worldOf(nodes.get(id)!)
  }
  /** 挂图物体的 slot 挂在哪根骨骼上:自己是骨骼就挂自己,否则挂父物体 */
  const slotBoneOf = (n: TransformNode) =>
    boneName.get(n.id) ?? (n.parent !== null && boneName.has(n.parent) ? boneName.get(n.parent)! : rootBoneName)

  // ── 贴图:guid → 页 ──
  const pages: AtlasPage[] = []
  const sources = new Map<string, Image>()
  const regions = new Map<string, AtlasRegion>()
  const regionOfSprite = new Map<string, string>()
  const textureMeta = new Map<string, { meta: YamlMap; page: AtlasPage; ppuTex: number; name: string }>()
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
    const entry = { meta, page, ppuTex: num(meta['spritePixelsToUnits'], 100), name: pageName.replace(/\.[^.]*$/, '') }
    textureMeta.set(guid, entry)
    return entry
  }

  // ── 挂图物体 → slot ──
  const rendererNodes = order.filter((n) => renderer(n) !== undefined)
  const activeSelf = (n: TransformNode) => str(n.go.data['m_IsActive']) !== '0'
  const enabledSelf = (n: TransformNode) => str(renderer(n)!.data['m_Enabled']) !== '0'
  /** 按 Unity 的规则 setup 时画不画:渲染器开着,自己和各级父物体都激活 */
  const shownRaw = (n: TransformNode) => enabledSelf(n) && chainOf(n).every(activeSelf)
  // 我们导出的物体名会把几个物体合成一个 slot。合不起来的组 —— setup 时同时亮着两个以上,或者(SkinnedMeshRenderer 之外)
  // 挂在不同骨骼上 —— 说明名字不是这个约定(别人的角色里 `arm__L` 之类),组里的物体按名字各自成 slot
  const parsed = new Map(rendererNodes.map((n) => [n.id, parseNodeName(n.name)]))
  const groups = new Map<string, TransformNode[]>()
  for (const n of rendererNodes) {
    const p = parsed.get(n.id)!
    const k = `group:${p.skin ?? ''}/${p.slot}`
    groups.set(k, [...(groups.get(k) ?? []), n])
  }
  /** 物体 id → 组;拆开的物体各自一组 */
  const groupOf = new Map<string, string>()
  for (const [k, group] of groups) {
    const rigidBones = new Set(group.filter((n) => renderer(n)!.type === 'SpriteRenderer' && spriteSkin(n) === undefined).map(slotBoneOf))
    const split = group.length > 1 && (group.filter(shownRaw).length > 1 || rigidBones.size > 1)
    for (const n of group) {
      if (split) parsed.set(n.id, { slot: n.name, key: n.name, skin: null })
      groupOf.set(n.id, split ? `split:${n.id}` : k)
    }
  }
  // slot 名:不同皮肤里同名的 slot 是同一个;名字撞了的(别人的角色里左右手都叫 Hand)加后缀
  const slotOfGroup = new Map<string, string>()
  {
    const taken = new Set<string>()
    const shared = new Map<string, string>()
    for (const n of rendererNodes) {
      const g = groupOf.get(n.id)!
      if (slotOfGroup.has(g)) continue
      const p = parsed.get(n.id)!
      const split = g.startsWith('split:')
      const name = (split ? undefined : shared.get(p.slot)) ?? claim(taken, p.slot)
      if (!split) shared.set(p.slot, name)
      slotOfGroup.set(g, name)
    }
  }
  const slotOfNode = new Map(rendererNodes.map((n) => [n.id, slotOfGroup.get(groupOf.get(n.id)!)!]))

  interface SlotInfo { name: string; bone: string; rep: TransformNode; color: string | null; attachment: string | null }
  const slots = new Map<string, SlotInfo>()
  const skins = new Map<string, Json>()
  /** 物体 id → slot / 皮肤 / 每张图的键名 */
  const attachmentOf = new Map<string, { slot: string; skin: string; keyOfSprite: Map<string | null, string> }>()
  const skinnedMeshes = new Map<string, { shapes: { name: string; deltas: { index: number; x: number; y: number }[] }[]; bindposes: Affine[]; boneOfIndex: string[]; weights: { bone: number; weight: number }[][]; flatStart: number[] }>()

  /** SpriteRenderer 的一张图 → Spine mesh(顶点在 slot 骨骼的局部坐标里) */
  const spriteMesh = (n: TransformNode, sref: UnityRef, slotBone: string, where: string): { name: string; json: Json } | null => {
    const tex = pageOfGuid(sref.guid, where)
    if (tex === null) return null
    const sprite = spriteRecord(tex.meta, sref.fileID, tex.name, tex.page)
    if (sprite === null) {
      issues.loss(where, `贴图 ${tex.page.name} 里找不到 sprite(fileID ${sref.fileID})`)
      return null
    }
    const { width: rw, height: rh } = sprite.rect
    // 区域名按图唯一:别人的角色里不同贴图常有同名的 sprite
    const id = spriteId(sref)!
    let regionName = regionOfSprite.get(id)
    if (regionName === undefined) {
      regionName = sprite.name
      for (let i = 2; regions.has(regionName); i++) regionName = `${sprite.name}_${i}`
      regionOfSprite.set(id, regionName)
      regions.set(regionName, {
        name: regionName, page: tex.page.name,
        x: sprite.rect.x, y: tex.page.height - sprite.rect.y - rh, width: rw, height: rh,
        rotate: 0, offsetX: 0, offsetY: 0, originalWidth: rw, originalHeight: rh, index: -1,
      })
    }
    const uvs = sprite.vertices.flatMap((v) => [round(v.x / rw), round(1 - v.y / rh)])
    const local = sprite.vertices.map((v) => ({ x: (v.x - sprite.pivot.x) / tex.ppuTex, y: (v.y - sprite.pivot.y) / tex.ppuTex }))
    const skinComp = spriteSkin(n)
    let vertices: number[]
    if (skinComp !== undefined) {
      // 加权:sprite 骨骼的绑定 —— 根骨骼减 pivot,子骨骼相对父骨骼(writeMeta.ts 开头那三条约定)
      // ⚠️ 骨骼不一定父在前(PSD Importer 的角色里常是子骨骼先列),按 parentId 递归算
      const binds: Affine[] = []
      const bindOf = (i: number): Affine => {
        const hit = binds[i]
        if (hit !== undefined) return hit
        const b = sprite.bones[i]!
        const pos = map(b['position'])
        const parentId = num(b['parentId'], -1)
        const deg = zDegrees(vec(b['rotation']))
        const isRoot = parentId < 0
        const x = (num(pos['x']) - (isRoot ? sprite.pivot.x : 0)) / tex.ppuTex
        const y = (num(pos['y']) - (isRoot ? sprite.pivot.y : 0)) / tex.ppuTex
        binds[i] = isRoot ? trs(x, y, deg, 1, 1) : mul(bindOf(parentId), trs(x, y, deg, 1, 1))
        return binds[i]!
      }
      sprite.bones.forEach((_, i) => bindOf(i))
      const boneTransforms = list(skinComp.data['m_BoneTransforms']).map((t) => ref(t).fileID)
      // SpriteSkin 节点自己的变换不参与:SpriteSkinUtility.Deform 先乘它的 worldToLocal,渲染时再乘回 localToWorld,
      // 正好抵消 —— 顶点 = Σ w · 骨骼世界 · bindpose · v。PSD Importer 的角色里这些节点都摆在图层位置上,不在原点
      vertices = []
      local.forEach((v, i) => {
        const w = sprite.weights[i] ?? {}
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
      const toBone = mul(inverse(slotBone === rootBoneName && syntheticRoot !== null ? IDENTITY : boneWorld(slotBone)), worldOf(n))
      vertices = local.flatMap((v) => { const p = apply(toBone, v.x, v.y); return [round(p.x * ppu), round(p.y * ppu)] })
    }
    return { name: sprite.name, json: { type: 'mesh', path: regionName, uvs, triangles: [...sprite.indices], vertices, hull: 0, width: rw, height: rh } }
  }

  for (const n of rendererNodes) {
    const r = renderer(n)!
    const p = parsed.get(n.id)!
    const slotName = slotOfNode.get(n.id)!
    const skin = p.skin ?? 'default'
    const slotBone = slotBoneOf(n)
    let slot = slots.get(slotName)
    if (slot === undefined) {
      slot = { name: slotName, bone: slotBone, rep: n, color: null, attachment: null }
      slots.set(slotName, slot)
    }
    const skinJson = skins.get(skin) ?? {}
    skins.set(skin, skinJson)
    const bySlot = (skinJson[slotName] as Json | undefined) ?? {}
    skinJson[slotName] = bySlot
    const uniqueKey = (wanted: string) => {
      let key = wanted
      for (let i = 2; key in bySlot; i++) key = `${wanted}_${i}`
      return key
    }
    const keyOfSprite = new Map<string | null, string>()
    attachmentOf.set(n.id, { slot: slotName, skin, keyOfSprite })
    const where = `node.${n.path}`

    if (r.type === 'SpriteRenderer') {
      const c = rgbaOf(r.data['m_Color'])
      if (slot.color === null) slot.color = `${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${hex2(c.a)}`
      const setupSprite = ref(r.data['m_Sprite'])
      const swaps = curveSprites.get(n.id) ?? []
      // 有换图曲线的物体,每张图一个 attachment,按图名;没有的就是物体名里的键名
      const all = new Map<string, UnityRef>()
      for (const s of [setupSprite, ...swaps]) { const id = spriteId(s); if (id !== null && !all.has(id)) all.set(id, s) }
      for (const [id, sref] of all) {
        const mesh = spriteMesh(n, sref, slotBone, where)
        if (mesh === null) continue
        const key = uniqueKey(swaps.length > 0 ? mesh.name : p.key)
        bySlot[key] = mesh.json
        keyOfSprite.set(id, key)
      }
      continue
    }

    // ── SkinnedMeshRenderer ──
    const meshGuid = ref(r.data['m_Mesh']).guid
    const meshPath = meshGuid === null ? undefined : pathOfGuid.get(meshGuid)
    if (meshPath === undefined || !files.has(meshPath)) {
      issues.loss(where, 'SkinnedMeshRenderer 引用的 Mesh 不在目录里')
      continue
    }
    const mesh = parseMesh(text(meshPath))
    const materialGuid = ref(list(r.data['m_Materials'])[0]).guid
    const materialPath = materialGuid === null ? undefined : pathOfGuid.get(materialGuid)
    const texGuid = materialPath === undefined ? null : textureOfMaterial(text(materialPath))
    const tex = pageOfGuid(texGuid, where)
    if (tex === null) continue
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
    mesh.positions.forEach((q, i) => {
      const ws = (weights[i] ?? []).filter((w) => w.weight > 0)
      flatStart.push(flat)
      vertices.push(ws.length)
      for (const w of ws) {
        const l = apply(mesh.bindposes[w.bone] ?? IDENTITY, q.x, q.y)
        vertices.push(boneIndexOf(boneOfIndex[w.bone]!), round(l.x * ppu), round(l.y * ppu), round(w.weight))
        flat += 2
      }
    })
    const c = mesh.colors[0]
    if (c !== undefined && slot.color === null) slot.color = `${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${hex2(c.a)}`
    const key = uniqueKey(p.key)
    bySlot[key] = {
      type: 'mesh', path: regionName,
      uvs: mesh.uvs.flatMap((uv) => [round(uv.u), round(1 - uv.v)]),
      triangles: mesh.triangles, vertices, hull: 0,
    }
    keyOfSprite.set(null, key)
    skinnedMeshes.set(n.id, { shapes: mesh.blendShapes, bindposes: mesh.bindposes, boneOfIndex, weights: weights.map((ws) => ws.filter((w) => w.weight > 0)), flatStart })
  }
  const setupSpriteOf = (n: TransformNode): string | null => (renderer(n)!.type === 'SpriteRenderer' ? spriteId(ref(renderer(n)!.data['m_Sprite'])) : null)

  // ── 皮肤 ──
  // 我们导出的多皮肤角色:具名皮肤的挂图物体只有初始皮肤的亮着;默认皮肤里被初始皮肤同 slot 同键名盖住的也灭着。
  // 这两种物体自己的 m_IsActive 是「皮肤」那一维,交给 Spine 的皮肤,不当显隐读
  const named = rendererNodes.filter((n) => attachmentOf.get(n.id)?.skin !== 'default' && attachmentOf.has(n.id))
  const activeSkins = [...new Set(named.filter(activeSelf).map((n) => attachmentOf.get(n.id)!.skin))]
  if (activeSkins.length > 1) issues.add('approximated', 'skin', `几套皮肤的挂图物体同时亮着(${activeSkins.join('、')}),初始皮肤取 ${activeSkins[0]}`)
  const initialSkin = activeSkins[0] ?? null
  const setupKeyOf = (n: TransformNode) => attachmentOf.get(n.id)?.keyOfSprite.get(setupSpriteOf(n))
  const skinDimension = (n: TransformNode): boolean => {
    const a = attachmentOf.get(n.id)
    if (a === undefined) return false
    if (a.skin !== 'default') return true
    if (activeSelf(n)) return false
    const key = setupKeyOf(n)
    return named.some((m) => activeSelf(m) && attachmentOf.get(m.id)!.slot === a.slot && setupKeyOf(m) === key)
  }
  /** 显隐用的 m_IsActive:皮肤那一维的当作激活 */
  const activeForShow = (n: TransformNode) => skinDimension(n) || activeSelf(n)
  for (const n of rendererNodes) {
    const a = attachmentOf.get(n.id)
    const slot = slots.get(slotOfNode.get(n.id)!)!
    if (a === undefined || slot.attachment !== null) continue
    if (enabledSelf(n) && chainOf(n).every(activeForShow)) slot.attachment = setupKeyOf(n) ?? null
  }

  // ── 绘制顺序 ──
  /** 排序键:外层 Sorting Group 到渲染器自己,每层 [Sorting Layer, Order in Layer, −z, 层级先后] */
  const sortKeyOf = (n: TransformNode, orderAt: (m: TransformNode, cls: number) => number | undefined): number[] => {
    const key: number[] = []
    const levels = [container, ...chainOf(n).reverse()]
    for (const m of levels) {
      const group = m.components.find((c) => c.type === 'SortingGroup')
      if (group === undefined || str(group.data['m_Enabled']) === '0') continue
      key.push(num(group.data['m_SortingLayer']), orderAt(m, CLASS_SORTING_GROUP) ?? num(group.data['m_SortingOrder']), -zOf(m), m.index)
    }
    const r = renderer(n)!
    key.push(num(r.data['m_SortingLayer']), orderAt(n, r.type === 'SpriteRenderer' ? CLASS_SPRITE_RENDERER : CLASS_SKINNED_MESH_RENDERER) ?? num(r.data['m_SortingOrder']), -zOf(n), n.index)
    return key
  }
  const slotList = [...slots.values()].sort((a, b) => compareKeys(sortKeyOf(a.rep, () => undefined), sortKeyOf(b.rep, () => undefined)))
  const slotIndex = new Map(slotList.map((s, i) => [s.name, i]))
  const slotNodes = new Map<string, TransformNode[]>()
  for (const n of rendererNodes) slotNodes.set(slotOfNode.get(n.id)!, [...(slotNodes.get(slotOfNode.get(n.id)!) ?? []), n])

  // ── 动画 ──
  const animations: Json = {}
  for (const clip of clips) {
    const animName = clip.name.startsWith(`${prefabName}@`) ? clip.name.slice(prefabName.length + 1) : clip.name
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
    /** Unity 曲线 → Spine 的键。第一个键不在 0 秒的,0 秒补一个同值的键:Unity 在第一个键之前取它的值,Spine 取 setup */
    const spineKeys = (curve: YamlValue | undefined, component?: 'x' | 'y' | 'z', transform?: (v: number) => number): SpineKey[] => {
      const keys = toSpineKeys(readHermite(curve, component).map((k) => ({ ...k, time: snap(k.time) })), transform)
      return keys.length > 0 && keys[0]!.time > 1e-9 ? [{ time: 0, value: keys[0]!.value, segment: { kind: 'linear' } }, ...keys] : keys
    }
    const bonesOut: Json = {}
    const vectorCurves = (field: string, kind: 'translate' | 'rotate' | 'scale') => {
      for (const entry of list(data[field]).map(map)) {
        const path = str(entry['path'])
        const n = byPath.get(path)
        if (n === container) {
          issues.add('loss', `${field}.(根物体)`, '根物体自己的变换动画没转 —— 根物体的位置是角色摆在场景里的位置,不是骨骼')
          continue
        }
        if (n === undefined || !boneName.has(n.id)) {
          issues.add('loss', `${field}.${path}`, '曲线指向的物体不存在,没转')
          continue
        }
        const s = setup.get(n.id)!
        const byKind = (bonesOut[boneName.get(n.id)!] as Json | undefined) ?? {}
        bonesOut[boneName.get(n.id)!] = byKind
        if (kind === 'rotate') {
          const keys = spineKeys(entry['curve'], 'z', (v) => v - s.rotation)
          byKind['rotate'] = keysToFrames([keys], (vs) => ({ value: vs[0] }))
        } else if (kind === 'translate') {
          const [x, y] = align([spineKeys(entry['curve'], 'x', (v) => v * ppu - s.x), spineKeys(entry['curve'], 'y', (v) => v * ppu - s.y)])
          byKind['translate'] = keysToFrames([x!, y!], (vs) => ({ x: vs[0], y: vs[1] }))
          const z = readHermite(entry['curve'], 'z')
          if (z.some((k) => Math.abs(k.value - z[0]!.value) > 1e-6)) {
            issues.add('approximated', `m_PositionCurves.${path}`, 'z 坐标的动画没转 —— 2D 里它只影响同层同序的物体谁先画')
          }
        } else {
          const [x, y] = align([
            spineKeys(entry['curve'], 'x', (v) => (s.scaleX === 0 ? v : v / s.scaleX)),
            spineKeys(entry['curve'], 'y', (v) => (s.scaleY === 0 ? v : v / s.scaleY)),
          ])
          byKind['scale'] = keysToFrames([x!, y!], (vs) => ({ x: vs[0], y: vs[1] }))
        }
      }
    }
    vectorCurves('m_PositionCurves', 'translate')
    vectorCurves('m_EulerCurves', 'rotate')
    vectorCurves('m_ScaleCurves', 'scale')
    // 四元数旋转曲线(动画窗口默认的「Euler Angles (Quaternion)」插值就存成这个):四个分量各一条 Hermite,
    // 角度 = 2·atan2(z, w) 不是三次曲线,Spine 的贝塞尔表达不了 —— 关键帧和帧格上采样成折线,阶梯段保持阶梯,实测最大偏差
    for (const entry of list(data['m_RotationCurves']).map(map)) {
      const path = str(entry['path'])
      const n = byPath.get(path)
      if (n === container) {
        issues.add('loss', 'm_RotationCurves.(根物体)', '根物体自己的变换动画没转 —— 根物体的位置是角色摆在场景里的位置,不是骨骼')
        continue
      }
      if (n === undefined || !boneName.has(n.id)) {
        issues.add('loss', `m_RotationCurves.${path}`, '曲线指向的物体不存在,没转')
        continue
      }
      const s = setup.get(n.id)!
      const q = align((['x', 'y', 'z', 'w'] as const).map((c) => toSpineKeys(readHermite(entry['curve'], c).map((k) => ({ ...k, time: snap(k.time) })))))
      const [qx, qy, qz, qw] = q as [SpineKey[], SpineKey[], SpineKey[], SpineKey[]]
      if ([...qx, ...qy].some((k) => Math.abs(k.value) > 1e-6)) issues.add('approximated', `m_RotationCurves.${path}`, '有绕 x / y 的旋转(3D),2D 骨骼只取绕 z 的部分')
      const angleAt = (t: number) => (2 * Math.atan2(valueAt(qz, t), valueAt(qw, t))) / DEG
      const keys: SpineKey[] = []
      let previous: number | null = null
      const push = (t: number, stepped: boolean) => {
        let a = angleAt(t)
        if (previous !== null) a += 360 * Math.round((previous - a) / 360)
        previous = a
        keys.push({ time: t, value: a - s.rotation, segment: { kind: stepped ? 'stepped' : 'linear' } })
      }
      for (let i = 0; i < qz.length; i++) {
        const t0 = qz[i]!.time
        const next = qz[i + 1]
        const stepped = qz[i]!.segment?.kind === 'stepped' && qw[i]!.segment?.kind === 'stepped'
        push(t0, stepped)
        if (next === undefined || stepped) continue
        for (let f = Math.floor(t0 * fps + 1e-6) + 1; f / fps < next.time - 1e-6; f++) push(f / fps, false)
      }
      if (keys.length > 0 && keys[0]!.time > 1e-9) keys.unshift({ time: 0, value: keys[0]!.value, segment: { kind: 'linear' } })
      // 相邻采样点的中点上,折线与真实角度差多少
      let worst = 0
      for (let i = 0; i + 1 < keys.length; i++) {
        if (keys[i]!.segment?.kind === 'stepped') continue
        const mid = (keys[i]!.time + keys[i + 1]!.time) / 2
        const truth = angleAt(mid) - s.rotation
        const line = (keys[i]!.value + keys[i + 1]!.value) / 2
        worst = Math.max(worst, Math.abs(((truth - line + 540) % 360) - 180))
      }
      const byKind = (bonesOut[boneName.get(n.id)!] as Json | undefined) ?? {}
      bonesOut[boneName.get(n.id)!] = byKind
      byKind['rotate'] = keysToFrames([keys], (vs) => ({ value: vs[0] }))
      if (worst > 0.01) issues.add('approximated', `m_RotationCurves.${path}`, `四元数旋转曲线按 ${fps} fps 采样成折线,最多偏 ${worst.toFixed(3)}°`)
    }
    if (Object.keys(bonesOut).length > 0) out['bones'] = bonesOut

    // 渲染器 / GameObject 的曲线:按物体 id 收
    const enabledCurves = new Map<string, SpineKey[]>()
    const activeCurves = new Map<string, SpineKey[]>()
    const orderCurves = new Map<string, SpineKey[]>()
    const colors = new Map<string, Map<string, SpineKey[]>>()
    const blend = new Map<string, Map<string, SpineKey[]>>()
    for (const entry of list(data['m_FloatCurves']).map(map)) {
      const path = str(entry['path'])
      const attribute = str(entry['attribute'])
      const cls = num(entry['classID'])
      const n = byPath.get(path)
      const keys = spineKeys(entry['curve'])
      const onRenderer = n !== undefined && attachmentOf.has(n.id) && (cls === CLASS_SPRITE_RENDERER || cls === CLASS_SKINNED_MESH_RENDERER)
      if (n !== undefined && cls === CLASS_GAME_OBJECT && attribute === 'm_IsActive') {
        if (n === container) issues.add('loss', 'm_IsActive.(根物体)', '根物体自己的显隐动画没转')
        else activeCurves.set(n.id, keys)
      } else if (n !== undefined && cls === CLASS_SORTING_GROUP && attribute === 'm_SortingOrder') {
        orderCurves.set(`${n.id}|${cls}`, keys)
      } else if (onRenderer && attribute === 'm_Enabled') {
        enabledCurves.set(n.id, keys)
      } else if (onRenderer && attribute === 'm_SortingOrder') {
        orderCurves.set(`${n.id}|${cls}`, keys)
      } else if (onRenderer && attribute.startsWith('m_Color.')) {
        const perNode = colors.get(n.id) ?? new Map()
        colors.set(n.id, perNode)
        perNode.set(attribute.slice('m_Color.'.length), keys)
      } else if (onRenderer && attribute.startsWith('blendShape.')) {
        const perNode = blend.get(n.id) ?? new Map()
        blend.set(n.id, perNode)
        perNode.set(attribute.slice('blendShape.'.length), keys)
      } else {
        issues.add('loss', `${attribute}.${path || '(根物体)'}`, n === undefined ? '曲线指向的物体不存在,没转' : `属性 ${attribute} 的曲线没转`)
      }
    }
    /** 物体 id → m_Sprite 的阶梯键 */
    const spriteCurves = new Map<string, { time: number; id: string | null }[]>()
    for (const entry of list(data['m_PPtrCurves']).map(map)) {
      const path = str(entry['path'])
      const attribute = str(entry['attribute'])
      const n = byPath.get(path)
      if (n === undefined || attribute !== 'm_Sprite' || num(entry['classID']) !== CLASS_SPRITE_RENDERER || !attachmentOf.has(n.id)) {
        issues.add('loss', `${attribute}.${path || '(根物体)'}`, `引用类曲线 ${attribute} 没转`)
        continue
      }
      spriteCurves.set(n.id, list(entry['curve']).map(map).map((k) => ({ time: snap(num(k['time'])), id: spriteId(ref(k['value'])) })))
    }

    const slotsOut: Json = {}
    const slotOut = (name: string) => {
      const s = (slotsOut[name] as Json | undefined) ?? {}
      slotsOut[name] = s
      return s
    }
    // 换图:按 Unity 的规则逐个物体算「这一刻画不画、画哪张图」,合成这个 slot 挂哪个键名
    const enabledAt = (n: TransformNode, t: number) => { const k = enabledCurves.get(n.id); return k === undefined ? enabledSelf(n) : valueAt(k, t) >= 0.5 }
    const activeAt = (n: TransformNode, t: number) => { const k = activeCurves.get(n.id); return k === undefined ? activeForShow(n) : valueAt(k, t) >= 0.5 }
    const spriteAt = (n: TransformNode, t: number) => {
      const ks = spriteCurves.get(n.id)
      if (ks === undefined || ks.length === 0) return setupSpriteOf(n)
      let id = ks[0]!.id
      for (const k of ks) if (k.time <= t + 1e-9) id = k.id
      return id
    }
    const keyAt = (n: TransformNode, t: number): string | null =>
      enabledAt(n, t) && chainOf(n).every((m) => activeAt(m, t)) ? attachmentOf.get(n.id)!.keyOfSprite.get(spriteAt(n, t)) ?? null : null
    for (const [slotName, members] of slotNodes) {
      const times = new Set<number>()
      for (const n of members) {
        for (const k of enabledCurves.get(n.id) ?? []) times.add(k.time)
        for (const k of spriteCurves.get(n.id) ?? []) times.add(k.time)
        for (const m of chainOf(n)) for (const k of activeCurves.get(m.id) ?? []) times.add(k.time)
      }
      if (times.size === 0) continue
      times.add(0)
      const frames: Json[] = []
      let last: string | null | undefined
      for (const t of [...times].sort((a, b) => a - b)) {
        // 几套皮肤的物体一起看:同一时刻亮着的键名在各皮肤里是同一个(导出时按键名开关),皮肤只决定挂哪一份
        const on = members.map((n) => keyAt(n, t)).filter((k): k is string => k !== null)
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

    // 逐帧绘制顺序:各 slot 的排序键在关键帧时刻排一次序,换算成 Spine 的偏移
    if (orderCurves.size > 0) {
      const times = [...new Set([0, ...[...orderCurves.values()].flatMap((k) => k.map((x) => x.time))])].sort((a, b) => a - b)
      out['drawOrder'] = times.map((t) => {
        const orderAt = (m: TransformNode, cls: number) => { const k = orderCurves.get(`${m.id}|${cls}`); return k === undefined ? undefined : Math.round(valueAt(k, t)) }
        const keyed = slotList.map((s, i) => ({ name: s.name, i, key: sortKeyOf(s.rep, orderAt) }))
        const sorted = [...keyed].sort((p, q) => compareKeys(p.key, q.key))
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
      const d = blendToDeform(geo, shapesCurves, ppu, att.keyOfSprite.get(null)!, issues)
      if (d === null) continue
      const bySkin = (deform[att.skin] as Json | undefined) ?? {}
      deform[att.skin] = bySkin
      const bySlot = (bySkin[att.slot] as Json | undefined) ?? {}
      bySkin[att.slot] = bySlot
      bySlot[att.keyOfSprite.get(null)!] = { deform: d }
    }
    if (Object.keys(deform).length > 0) out['attachments'] = deform

    // clip 比最后一个键长(逐帧动画最后一帧要停一会儿):补一个不改变任何东西的绘制顺序帧把时长撑回来
    const stop = snap(num(map(data['m_AnimationClipSettings'])['m_StopTime']))
    if (stop > lastKeyTime(out) + 1e-6) {
      const drawOrder = (out['drawOrder'] as Json[] | undefined) ?? []
      const previous = drawOrder[drawOrder.length - 1]
      drawOrder.push(previous?.['offsets'] === undefined ? { time: stop } : { time: stop, offsets: previous['offsets'] })
      out['drawOrder'] = drawOrder
    }
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
  const nodesOut = [...attachmentOf.entries()].flatMap(([id, a]) =>
    [...a.keyOfSprite.entries()].map(([sprite, key]) => ({ path: nodes.get(id)!.path, slot: a.slot, key, skin: a.skin, sprite })),
  )
  return { json, atlas: { pages, regions }, sources, issues: issues.all, nodes: nodesOut, initialSkin, name: prefabName }
}

/** Spine 4.x JSON 一条动画里最晚的关键帧时刻 */
function lastKeyTime(anim: Json): number {
  let end = 0
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const f of v) {
        if (f !== null && typeof f === 'object' && typeof (f as Json)['time'] === 'number') end = Math.max(end, (f as Json)['time'] as number)
        visit(f)
      }
    } else if (v !== null && typeof v === 'object') {
      for (const x of Object.values(v as Json)) if (typeof x === 'object') visit(x)
    }
  }
  visit(anim)
  return end
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
