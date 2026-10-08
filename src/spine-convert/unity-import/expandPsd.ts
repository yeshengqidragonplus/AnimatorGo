import { readPsd, type PsdLayer } from '../../psd/readPsd.ts'
import { encodePng } from '../../unity/png.ts'
import { decodeIndices } from '../../unity/spriteMeta.ts'
import { writePrefab, type PrefabNode } from '../../unity/writePrefab.ts'
import { writeTextureMeta, type MetaBone, type MetaSprite, type MetaWeight } from '../../unity/writeMeta.ts'
import { fileId } from '../../unity/ids.ts'
import { list, map, num, parseYamlDocument, str, vec, type YamlMap } from '../../unity/yaml.ts'
import type { ConversionIssue } from '../types.ts'

/**
 * 2D PSD Importer 的角色(`.psb` / `.psd` + `.meta`)→ 等价的普通 Unity 文件:一个 prefab、一张贴图和它的 `.meta`。
 *
 * Unity 导入这种角色时**在内存里**生成 prefab 和拼好的大图,磁盘上只有 Photoshop 文件和 `.meta`。这里照 PSD Importer
 * 的源码(com.unity.2d.psdimporter 12.x 的 `PSDImporter.OnProducePrefab`、`ExtractLayerTask`、2D Common 的 `ImagePacker`)
 * 把它们重建出来,交给 Unity 读取器 —— 之后的读取、参照物、Godot 导出都不用知道 PSB 的存在。
 *
 * - **几何全在 `.meta` 里**:`layeredSpriteImportData` 每个 sprite 的 rect(在大图里)、pivot、顶点、权重、`spriteBone`;
 *   `characterData` 的骨骼和每个部件用哪几根骨骼;`psdLayers` 的图层顺序(决定 Order in Layer)
 * - **Photoshop 文件只用来取像素**:按 `.meta` 里的 rect 和 `uvTransform` 把图层像素摆回大图原来的位置,
 *   所以 sprite 的 rect 原样可用,`.anim` 里按 fileID 引用的 sprite 也认得(fileID 来自 `internalIDToNameTable`)
 * - 物体:根物体 `<贴图名>_GO`;每个导入的图层一个物体(按图层顺序),位置 =(spritePosition + pivot)/ ppu − 文档轴心;
 *   再挂骨骼,根骨骼减文档轴心;Order in Layer = 图层总数 − 图层序号;有骨骼的部件挂 SpriteSkin,根骨骼是根物体
 *
 * 和 Unity 的结果比对见 readUnity.test.ts(Unity 自己导出的标准答案:tools/unity/AnimatorGoDumpPsd.cs)。
 */

/** PSD Importer 的 ScriptedImporter 脚本 GUID(随 com.unity.2d.psdimporter 发布,所有工程都一样) */
export const PSD_IMPORTER_SCRIPT_GUID = 'b2a9591990af98743ba3ff7cf1000886'

/** SpriteAlignment 的预设轴心:Center、TopLeft、Top、TopRight、Left、Right、BottomLeft、Bottom、BottomRight */
const ALIGNMENTS: readonly (readonly [number, number])[] = [[0.5, 0.5], [0, 1], [0.5, 1], [1, 1], [0, 0.5], [1, 0.5], [0, 0], [0.5, 0], [1, 0]]
const ALIGNMENT_CUSTOM = 9

export interface ExpandedPsd {
  readonly files: Map<string, string | Uint8Array>
  readonly issues: readonly ConversionIssue[]
}

/** 目录里的每个 PSD Importer 角色换成 prefab + 贴图;别的文件原样保留 */
export function expandPsdImports(files: ReadonlyMap<string, string | Uint8Array>): ExpandedPsd {
  const out = new Map(files)
  const issues: ConversionIssue[] = []
  for (const [path, content] of files) {
    if (!/\.ps[bd]$/i.test(path) || !(content instanceof Uint8Array)) continue
    const metaText = files.get(`${path}.meta`)
    if (typeof metaText !== 'string') continue
    const meta = parseYamlDocument(metaText)
    const importer = map(meta['ScriptedImporter'])
    if (str(map(importer['script'])['guid']) !== PSD_IMPORTER_SCRIPT_GUID) continue
    const where = path.replace(/^.*\//, '')
    const add = (level: ConversionIssue['level'], message: string) => issues.push({ level, path: where, message })
    const expanded = expandOne(path, content, str(meta['guid']), importer, add)
    if (expanded === null) continue
    out.delete(path)
    out.delete(`${path}.meta`)
    for (const [p, c] of expanded) out.set(p, c)
  }
  return { files: out, issues }
}

interface LayerRecord {
  readonly name: string
  readonly spriteID: string
  readonly layerID: number
  readonly isGroup: boolean
  readonly parentIndex: number
  readonly isImported: boolean
  readonly isVisible: boolean
}

function expandOne(
  path: string,
  bytes: Uint8Array,
  guid: string,
  importer: YamlMap,
  add: (level: ConversionIssue['level'], message: string) => void,
): Map<string, string | Uint8Array> | null {
  const settings = map(importer['textureImporterSettings'])
  if (num(settings['spriteMode'], 1) !== 2 || num(importer['mosaicLayers']) !== 1 || num(importer['characterMode']) !== 1) {
    add('loss', '不是「拼图 + 角色」模式导入的(Sprite Mode 不是 Multiple,或没勾 Mosaic / Use as Rig),Unity 不会生成角色 prefab,没转')
    return null
  }
  if (num(importer['paperDollMode']) === 1) {
    add('loss', '纸娃娃模式(Paper Doll)生成的层级没支持,没转')
    return null
  }
  const ppu = num(settings['spritePixelsToUnits'], 100)
  // 迁移前的老 .meta 把数据放在 rig* / mosaic* 里(PSDImporter.MigrateOlderSpriteImportData)
  const pick = (...keys: string[]) => keys.map((k) => list(importer[k])).find((l) => l.length > 0) ?? []
  const sprites = pick('layeredSpriteImportData', 'rigSpriteImportData', 'mosaicSpriteImportData').map(map)
  const layers: LayerRecord[] = pick('psdLayers', 'rigPSDLayers', 'mosaicPSDLayers').map(map).map((l) => ({
    name: str(l['name']),
    spriteID: str(l['spriteID']),
    layerID: num(l['layerID'], -1),
    isGroup: num(l['isGroup']) === 1,
    parentIndex: num(l['parentIndex'], -1),
    isImported: num(l['isImported']) === 1,
    isVisible: num(l['isVisible'], 1) === 1,
  }))
  // 共享骨架(Skeleton Sharing):引用了别的 .psb 的骨架时,Unity 用 sharedRigCharacterData(PSDImporter.characterData)
  const shared = map(importer['sharedRigCharacterData'])
  const character = str(importer['skeletonAssetReferenceID']) !== '' && list(shared['bones']).length > 0 ? shared : map(importer['characterData'])
  const bones = list(character['bones']).map(map)
  const parts = list(character['parts']).map(map)
  if (num(importer['spriteSizeExpand']) > 0) add('approximated', `Sprite Size Expand = ${num(importer['spriteSizeExpand'])},按居中摆放还原像素(没有样本验证过)`)
  if (list(map(importer['spriteCategoryList'])['categories']).length > 0) {
    add('approximated', '有 Sprite Library 分类:Unity 只给每类第一张图建物体并挂 SpriteResolver,这里每张图各建一个物体,SpriteResolver 换图没转')
  }

  // sprite 引用的 fileID:internalIDToNameTable 里类型 213(Sprite)的那些,second 是 spriteID
  const fileIdOfSprite = new Map<string, number>()
  for (const e of list(importer['internalIDToNameTable']).map(map)) {
    const id = str(map(e['first'])['213'])
    if (id !== '') fileIdOfSprite.set(str(e['second']), Number(id))
  }

  const psd = readPsd(bytes)
  const name = str(importer['textureAssetName']) || 'root'
  const stem = path.replace(/\.ps[bd]$/i, '')

  // ── 贴图:按 .meta 里的 rect 和 uvTransform 把图层像素摆回 Unity 拼好的大图里原来的位置 ──
  const layerById = new Map<number, PsdLayer>()
  for (const l of psd.layers) if (l.id !== null && l.kind === 'layer') layerById.set(l.id, l)
  const byName = new Map<string, PsdLayer>()
  for (const l of psd.layers) if (l.kind === 'layer' && !byName.has(l.name)) byName.set(l.name, l)
  let atlasW = 1, atlasH = 1
  for (const s of sprites) {
    const r = map(s['rect'])
    atlasW = Math.max(atlasW, num(r['x']) + num(r['width']))
    atlasH = Math.max(atlasH, num(r['y']) + num(r['height']))
  }
  const pot = (v: number) => 2 ** Math.ceil(Math.log2(Math.max(1, v)))
  atlasW = pot(atlasW)
  atlasH = pot(atlasH)
  const atlas = new Uint8Array(atlasW * atlasH * 4)
  const platform = list(importer['platformSettings']).map(map).find((p) => (str(p['buildTarget']) || str(p['name'])) === 'DefaultTexturePlatform')
  const maxSize = num(platform?.['maxTextureSize'], 0) > 0 ? num(platform?.['maxTextureSize']) : 2048
  if (atlasW > maxSize || atlasH > maxSize) {
    // Unity 把贴图和 sprite 的 rect、ppu 一起缩小(definitionScale),按 Unity 单位算的几何不变 —— 这里保留原分辨率
    add('info', `拼好的大图(${atlasW}×${atlasH})超过 Max Size ${maxSize},Unity 里会被缩小;这里保留原分辨率,几何不受影响`)
  }
  const expand = num(importer['spriteSizeExpand'])

  for (const s of sprites) {
    const id = str(s['spriteID'])
    const layerRecord = layers.find((l) => l.spriteID === id)
    const layer = layerRecord === undefined ? undefined : (layerById.get(layerRecord.layerID) ?? byName.get(layerRecord.name))
    if (layer === undefined || layer.rgba === null) {
      add('loss', `sprite "${str(s['name'])}" 在 Photoshop 文件里找不到对应的图层,没有像素`)
      continue
    }
    blitLayer(atlas, atlasW, atlasH, layer, psd.width, psd.height, map(s['rect']), vec(s['uvTransform']), expand, () =>
      add('approximated', `图层 "${layer.name}" 的像素范围和 .meta 里的 sprite 对不上 —— Photoshop 文件改过、Unity 还没重新导入`),
    )
  }
  const image = { width: atlasW, height: atlasH, data: flipRows(atlas, atlasW, atlasH) }

  // ── 贴图的 .meta:sprite 原样搬过来,internalID 用 Unity 给它的 fileID ──
  const metaSprites: MetaSprite[] = sprites.map((s) => {
    const r = map(s['rect'])
    const rect = { x: num(r['x']), y: num(r['y']), width: num(r['width']), height: num(r['height']) }
    const alignment = num(s['alignment'])
    const p = map(s['pivot'])
    const [px, py] = alignment === ALIGNMENT_CUSTOM ? [num(p['x'], 0.5), num(p['y'], 0.5)] : (ALIGNMENTS[alignment] ?? [0.5, 0.5])
    const verts = list(s['vertices']).map(map)
    const spriteBones: MetaBone[] = list(s['spriteBone']).map(map).map((b) => {
      const pos = vec(b['position'])
      const rot = vec(b['rotation'])
      return { name: str(b['name']), guid: str(b['guid']), position: { x: pos.x, y: pos.y }, rotation: { x: rot.x, y: rot.y, z: rot.z, w: rot.w }, length: num(b['length']), parentId: num(b['parentId'], -1) }
    })
    const weights: MetaWeight[] = verts.map((v) => {
      const w = map(v['boneWeight'])
      return {
        weights: [num(w['weight0']), num(w['weight1']), num(w['weight2']), num(w['weight3'])],
        bones: [num(w['boneIndex0']), num(w['boneIndex1']), num(w['boneIndex2']), num(w['boneIndex3'])],
      }
    })
    const spriteID = str(s['spriteID'])
    return {
      name: str(s['name']),
      rect,
      pivot: { x: px!, y: py! },
      spriteID,
      internalID: fileIdOfSprite.get(spriteID) ?? fileId(`${guid}/${spriteID}`),
      vertices: verts.map((v) => { const q = vec(v['position']); return { x: q.x, y: q.y } }),
      triangles: decodeIndices(str(s['indices'])),
      bones: spriteBones,
      weights,
    }
  })
  const spriteOfId = new Map(metaSprites.map((m) => [m.spriteID, m]))

  // ── prefab:照 PSDImporter.OnProducePrefab ──
  const canvasW = psd.width, canvasH = psd.height
  const docPivot = documentPivot(canvasW / ppu, canvasH / ppu, num(importer['documentAlignment']), vec(importer['documentPivot']))
  const nodes: PrefabNode[] = [{ name: `${name}_GO`, parent: -1, position: zero3, rotation: identityQ, scale: one3, renderer: null, skin: null }]
  // GameObjectCreationFactory:图层物体和骨骼共用一个去重表(根物体不算),重名的加 _1、_2……
  // —— Knight 的骨骼 neck / head 与同名图层撞了,Unity 里叫 neck_1 / head_1,.anim 的路径也是这么写的
  const takenNames = new Set<string>()
  const uniqueName = (wanted: string) => {
    const base = wanted === '.' || wanted === '..' || wanted === '/' ? `${wanted}_` : wanted.replaceAll(String.fromCharCode(0), ' ')
    let candidate = base
    for (let i = 1; takenNames.has(candidate); i++) candidate = `${base}_${i}`
    takenNames.add(candidate)
    return candidate
  }
  const generateHierarchy = num(importer['generateGOHierarchy']) === 1
  const importHidden = num(importer['importHiddenLayers']) === 1
  const nodeOfLayer = new Map<number, number>()
  const visibleInHierarchy = (i: number): boolean => {
    const l = layers[i]!
    return l.isVisible && (l.parentIndex < 0 || visibleInHierarchy(l.parentIndex))
  }
  const buildLayer = (i: number) => {
    if (nodeOfLayer.has(i)) return
    const l = layers[i]!
    const spriteImported = l.spriteID !== '' && l.isImported && spriteOfId.has(l.spriteID)
    const visibleGroup = l.isGroup && (visibleInHierarchy(i) || importHidden) && generateHierarchy
    if (!spriteImported && !visibleGroup) return
    let parent = 0
    if (l.parentIndex >= 0 && generateHierarchy) {
      buildLayer(l.parentIndex)
      parent = nodeOfLayer.get(l.parentIndex) ?? 0
    }
    nodeOfLayer.set(i, nodes.length)
    nodes.push({ name: uniqueName(spriteOfId.get(l.spriteID)?.name ?? l.name), parent, position: zero3, rotation: identityQ, scale: one3, renderer: null, skin: null })
  }
  layers.forEach((_, i) => buildLayer(i))

  // 骨骼:父骨骼先建(PSDImporter.CreateBoneGO)
  const nodeOfBone: number[] = []
  const buildBone = (i: number) => {
    if (nodeOfBone[i] !== undefined) return
    const b = bones[i]!
    const parentId = num(b['parentId'], -1)
    if (parentId >= 0) buildBone(parentId)
    const pos = vec(b['position'])
    const rot = vec(b['rotation'])
    nodeOfBone[i] = nodes.length
    nodes.push({
      name: uniqueName(str(b['name'])),
      parent: parentId >= 0 ? nodeOfBone[parentId]! : 0,
      // 根骨骼减文档轴心(根物体在原点,世界 = 局部)
      position: parentId >= 0 ? { x: pos.x / ppu, y: pos.y / ppu, z: pos.z / ppu } : { x: pos.x / ppu - docPivot.x, y: pos.y / ppu - docPivot.y, z: pos.z / ppu },
      rotation: { x: rot.x, y: rot.y, z: rot.z, w: rot.w },
      scale: one3,
      renderer: null,
      skin: null,
    })
  }
  bones.forEach((_, i) => buildBone(i))

  // 挂图物体的渲染器、位置、蒙皮
  layers.forEach((l, i) => {
    const index = nodeOfLayer.get(i)
    const sprite = spriteOfId.get(l.spriteID)
    const s = sprites.find((x) => str(x['spriteID']) === l.spriteID)
    if (index === undefined || sprite === undefined || s === undefined) return
    const spritePosition = vec(s['spritePosition'])
    const parentWorld = worldPosition(nodes, nodes[index]!.parent)
    const world = { x: (spritePosition.x + sprite.pivot.x * sprite.rect.width) / ppu, y: (spritePosition.y + sprite.pivot.y * sprite.rect.height) / ppu }
    const part = parts.find((p) => str(p['spriteId']) === l.spriteID)
    // int 数组在 Unity 的 YAML 里是小端 uint32 的十六进制串(和 indices 一样);老版本也可能是列表
    const raw = part?.['bones']
    const partBones = (typeof raw === 'string' ? decodeIndices(raw) : list(raw).map((b) => num(b, -1))).filter((b) => b >= 0 && b < bones.length)
    nodes[index] = {
      ...nodes[index]!,
      position: { x: world.x - parentWorld.x - docPivot.x, y: world.y - parentWorld.y - docPivot.y, z: 0 },
      renderer: { sprite: { fileID: sprite.internalID, guid }, sortingOrder: layers.length - i, color: { r: 1, g: 1, b: 1, a: 1 } },
      skin: partBones.length > 0 && sprite.bones.length > 0 ? { rootBone: 0, bones: partBones.map((b) => nodeOfBone[b]!) } : null,
    }
  })

  const out = new Map<string, string | Uint8Array>()
  out.set(`${stem}.prefab`, writePrefab(nodes, { seed: guid, controller: null, renderPipeline: 'urp' }))
  out.set(`${stem}.png`, encodePng(image))
  out.set(`${stem}.png.meta`, writeTextureMeta({ guid, pixelsPerUnit: ppu, sprites: metaSprites }))
  return out
}

const zero3 = { x: 0, y: 0, z: 0 }
const one3 = { x: 1, y: 1, z: 1 }
const identityQ = { x: 0, y: 0, z: 0, w: 1 }

/** 物体在根物体空间的位置(只有平移 —— 图层物体和图层组物体都不转不缩) */
function worldPosition(nodes: readonly PrefabNode[], index: number): { x: number; y: number } {
  let x = 0, y = 0
  for (let i = index; i > 0; i = nodes[i]!.parent) {
    x += nodes[i]!.position.x
    y += nodes[i]!.position.y
  }
  return { x, y }
}

/** ImportUtilities.GetPivotPoint:文档矩形(Unity 单位,左下原点)上的轴心 */
function documentPivot(w: number, h: number, alignment: number, custom: { x: number; y: number }): { x: number; y: number } {
  if (alignment === ALIGNMENT_CUSTOM) return { x: w * custom.x, y: h * custom.y }
  const [px, py] = ALIGNMENTS[alignment] ?? [0.5, 0.5]
  return { x: w * px!, y: h * py! }
}

/**
 * 一个图层的像素按 Unity 拼大图的规则摆进 sprite 的 rect(大图左下原点,行从下到上):
 *
 * 1. ExtractLayerTask:图层裁到画布,翻成左下原点;单个图层合成到透明底上 ——
 *    `rgb = (c·a)·(1/a)`、透明像素清成 (0,0,0,0),浮点算完转回字节
 * 2. ImagePacker:取不透明像素的紧包围盒拼进大图,`uvTransform` = 拼进去的位置 − 紧包围盒的位置
 *
 * 所以大图 (X, Y) = 图层缓冲 (X − uvTransform.x, Y − uvTransform.y)。
 */
function blitLayer(
  atlas: Uint8Array, atlasW: number, atlasH: number,
  layer: PsdLayer, canvasW: number, canvasH: number,
  rect: YamlMap, uv: { x: number; y: number }, expand: number,
  mismatch: () => void,
): void {
  const w = layer.right - layer.left
  const h = layer.bottom - layer.top
  // 图层矩形(Unity 坐标,左下原点)裁到画布 —— 这是图层缓冲的原点
  const x0 = Math.max(0, layer.left)
  const y0 = Math.max(0, canvasH - layer.top - h)
  const x1 = Math.min(canvasW, layer.left + w)
  const y1 = Math.min(canvasH, canvasH - layer.top)
  const rx = num(rect['x']), ry = num(rect['y']), rw = num(rect['width']), rh = num(rect['height'])
  // Sprite Size Expand:紧包围盒在拼好的格子里居中(ImagePacker.BurstedBlit)
  const shift = expand > 0 ? Math.trunc(expand / 2) : 0
  let opaqueOutside = false
  // 紧包围盒(缓冲坐标)应当正好落进 rect —— 核对一下,对不上说明 .meta 过期
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let by = 0; by < y1 - y0; by++) {
    for (let bx = 0; bx < x1 - x0; bx++) {
      const a = sample(layer, bx + x0 - layer.left, canvasH - 1 - (by + y0) - layer.top, w, h)[3]
      if (a === 0) continue
      minX = Math.min(minX, bx); maxX = Math.max(maxX, bx); minY = Math.min(minY, by); maxY = Math.max(maxY, by)
    }
  }
  if (minX !== Infinity && (maxX - minX + 1 + expand !== rw || maxY - minY + 1 + expand !== rh || minX + uv.x !== rx || minY + uv.y !== ry)) opaqueOutside = true
  for (let Y = ry; Y < ry + rh; Y++) {
    for (let X = rx; X < rx + rw; X++) {
      if (X < 0 || Y < 0 || X >= atlasW || Y >= atlasH) continue
      const bx = X - uv.x - shift
      const by = Y - uv.y - shift
      if (bx < 0 || by < 0 || bx >= x1 - x0 || by >= y1 - y0) continue
      const c = sample(layer, bx + x0 - layer.left, canvasH - 1 - (by + y0) - layer.top, w, h)
      const o = (Y * atlasW + X) * 4
      atlas[o] = c[0]; atlas[o + 1] = c[1]; atlas[o + 2] = c[2]; atlas[o + 3] = c[3]
    }
  }
  if (opaqueOutside) mismatch()
}

/** 图层 (x, y)(左上原点)合成到透明底上的颜色 —— 按 Unity 的浮点运算 */
function sample(layer: PsdLayer, x: number, y: number, w: number, h: number): [number, number, number, number] {
  if (x < 0 || y < 0 || x >= w || y >= h) return [0, 0, 0, 0]
  const o = (y * w + x) * 4
  const rgba = layer.rgba!
  const a8 = rgba[o + 3]!
  if (a8 === 0) return [0, 0, 0, 0]
  const f = Math.fround
  const a = f(a8 / 255)
  const inv = f(1 / a)
  const channel = (c8: number) => Math.round(Math.min(1, Math.max(0, f(f(f(c8 / 255) * a) * inv))) * 255)
  return [channel(rgba[o]!), channel(rgba[o + 1]!), channel(rgba[o + 2]!), Math.round(a * 255)]
}

/** 左下原点(行从下到上)→ PNG 的左上原点 */
function flipRows(data: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(data.length)
  for (let y = 0; y < h; y++) out.set(data.subarray(y * w * 4, (y + 1) * w * 4), (h - 1 - y) * w * 4)
  return out
}
