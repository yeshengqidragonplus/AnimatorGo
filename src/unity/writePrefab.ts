/**
 * 写 Unity prefab。
 *
 * 结构取自真实样本(`HP3D2/Assets/Res/test/_sample/SampleCharacter.prefab`):
 * 每个对象是一个 YAML 文档,`--- !u!<classID> &<fileID>` 开头,互相用 fileID 引用。
 *
 * ⚠️ **fileID 必须稳定。** Unity 靠它认对象;每次生成都换一批 ID 的话,
 * 场景里对这个 prefab 的引用会全部断掉,动画也绑不上。所以这里用名字哈希
 * 生成确定性 ID,同一个骨架反复导出结果一致。
 */

export const CLASS_GAME_OBJECT = 1
export const CLASS_TRANSFORM = 4
export const CLASS_SPRITE_RENDERER = 212

export interface SpriteRef {
  readonly fileID: number
  readonly guid: string
}

export interface PrefabNode {
  readonly name: string
  /** 父节点在数组中的下标;根为 -1。**必须父在子之前** */
  readonly parent: number
  readonly position: { x: number; y: number; z: number }
  /** 四元数 */
  readonly rotation: { x: number; y: number; z: number; w: number }
  readonly scale: { x: number; y: number; z: number }
  /** 该节点挂的图片;不挂图则为 null */
  readonly sprite: SpriteRef | null
  /** 绘制顺序,越大越靠前 */
  readonly sortingOrder: number
}

/**
 * 由字符串生成稳定的正整数 fileID。
 *
 * 用 FNV-1a 再折成 53 位以内的正数 —— Unity 的 fileID 是 int64,
 * 但 JS 的安全整数只有 53 位,超了会在 JSON/字符串化时失真。
 */
function stableId(seed: string): number {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0
  }
  // 拼成 <= 2^52 的正数,避免落到 0(Unity 用 0 表示空引用)
  const value = h1 * 0x100000 + (h2 % 0x100000)
  return value === 0 ? 1 : value
}

const v3 = (v: { x: number; y: number; z: number }) =>
  `{x: ${num(v.x)}, y: ${num(v.y)}, z: ${num(v.z)}}`

function num(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)))
}

interface Ids {
  readonly go: number
  readonly transform: number
  readonly renderer: number
}

export function writePrefab(nodes: readonly PrefabNode[], rootName: string): string {
  // 名字可能重复,加上下标保证 ID 唯一且稳定
  const ids: Ids[] = nodes.map((n, i) => ({
    go: stableId(`${rootName}/${i}/${n.name}/go`),
    transform: stableId(`${rootName}/${i}/${n.name}/tr`),
    renderer: stableId(`${rootName}/${i}/${n.name}/sr`),
  }))

  const childrenOf = nodes.map<number[]>(() => [])
  nodes.forEach((n, i) => {
    if (n.parent >= 0) childrenOf[n.parent]!.push(i)
  })

  const docs: string[] = []

  nodes.forEach((node, i) => {
    const id = ids[i]!
    const components = [`  - component: {fileID: ${id.transform}}`]
    if (node.sprite !== null) components.push(`  - component: {fileID: ${id.renderer}}`)

    docs.push(
      [
        `--- !u!${CLASS_GAME_OBJECT} &${id.go}`,
        'GameObject:',
        '  m_ObjectHideFlags: 0',
        '  m_CorrespondingSourceObject: {fileID: 0}',
        '  m_PrefabInstance: {fileID: 0}',
        '  m_PrefabAsset: {fileID: 0}',
        '  serializedVersion: 6',
        '  m_Component:',
        ...components,
        '  m_Layer: 0',
        `  m_Name: ${node.name}`,
        '  m_TagString: Untagged',
        '  m_Icon: {fileID: 0}',
        '  m_NavMeshLayer: 0',
        '  m_StaticEditorFlags: 0',
        '  m_IsActive: 1',
      ].join('\n'),
    )

    const kids = childrenOf[i]!
    docs.push(
      [
        `--- !u!${CLASS_TRANSFORM} &${id.transform}`,
        'Transform:',
        '  m_ObjectHideFlags: 0',
        '  m_CorrespondingSourceObject: {fileID: 0}',
        '  m_PrefabInstance: {fileID: 0}',
        '  m_PrefabAsset: {fileID: 0}',
        `  m_GameObject: {fileID: ${id.go}}`,
        '  serializedVersion: 2',
        `  m_LocalRotation: {x: ${num(node.rotation.x)}, y: ${num(node.rotation.y)}, z: ${num(node.rotation.z)}, w: ${num(node.rotation.w)}}`,
        `  m_LocalPosition: ${v3(node.position)}`,
        `  m_LocalScale: ${v3(node.scale)}`,
        '  m_ConstrainProportionsScale: 0',
        kids.length === 0
          ? '  m_Children: []'
          : `  m_Children:\n${kids.map((k) => `  - {fileID: ${ids[k]!.transform}}`).join('\n')}`,
        `  m_Father: {fileID: ${node.parent < 0 ? 0 : ids[node.parent]!.transform}}`,
        '  m_LocalEulerAnglesHint: {x: 0, y: 0, z: 0}',
      ].join('\n'),
    )

    if (node.sprite !== null) {
      docs.push(
        [
          `--- !u!${CLASS_SPRITE_RENDERER} &${id.renderer}`,
          'SpriteRenderer:',
          '  serializedVersion: 2',
          '  m_ObjectHideFlags: 0',
          '  m_CorrespondingSourceObject: {fileID: 0}',
          '  m_PrefabInstance: {fileID: 0}',
          '  m_PrefabAsset: {fileID: 0}',
          `  m_GameObject: {fileID: ${id.go}}`,
          '  m_Enabled: 1',
          '  m_CastShadows: 0',
          '  m_ReceiveShadows: 0',
          '  m_RendererPriority: 0',
          // 留空让 Unity 用默认的 Sprites-Default 材质
          '  m_Materials: []',
          '  m_SortingLayerID: 0',
          '  m_SortingLayer: 0',
          `  m_SortingOrder: ${node.sortingOrder}`,
          `  m_Sprite: {fileID: ${node.sprite.fileID}, guid: ${node.sprite.guid}, type: 3}`,
          '  m_Color: {r: 1, g: 1, b: 1, a: 1}',
          '  m_FlipX: 0',
          '  m_FlipY: 0',
          '  m_DrawMode: 0',
          '  m_Size: {x: 1, y: 1}',
          '  m_AdaptiveModeThreshold: 0.5',
          '  m_SpriteTileMode: 0',
          '  m_WasSpriteAssigned: 1',
          '  m_MaskInteraction: 0',
          '  m_SpriteSortPoint: 0',
        ].join('\n'),
      )
    }
  })

  return `%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n${docs.join('\n')}\n`
}

export { stableId }
