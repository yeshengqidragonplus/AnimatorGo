import { fileId } from './ids.ts'

/**
 * 写 Unity prefab。
 *
 * 结构取自真实样本(Unity 6000.3 产出的 `Assets/Res/test/_sample/SampleCharacter.prefab`):
 * 每个对象是一个 YAML 文档,`--- !u!<classID> &<fileID>` 开头,互相用 fileID 引用。
 *
 * ⚠️ **fileID 必须稳定。** Unity 靠它认对象;每次生成都换一批 ID 的话,
 * 场景里对这个 prefab 的引用会全部断掉,而且断得悄无声息。所以 ID 一律由名字哈希
 * 得来(见 [ids.ts](ids.ts))。
 *
 * ⚠️ **nodes[0] 必须是唯一的根**,其余节点的 parent 都 ≥ 0 —— prefab 只能有一个根物体。
 */

export const CLASS_GAME_OBJECT = 1
export const CLASS_TRANSFORM = 4
export const CLASS_ANIMATOR = 95
export const CLASS_MONO_BEHAVIOUR = 114
export const CLASS_SPRITE_RENDERER = 212
export const CLASS_SKINNED_MESH_RENDERER = 137

/**
 * `SpriteSkin` 脚本的 GUID。
 *
 * 随 `com.unity.2d.animation` 包一起发布(`Runtime/SpriteSkin.cs.meta`),
 * 装了这个包的工程里都是同一个值,所以可以写死。
 */
export const SPRITE_SKIN_SCRIPT_GUID = '57c008f954fe54a8bb972de1018a2cb8'

/**
 * 默认 sprite 材质。**两套渲染管线不是同一个**,给错了整个角色是粉红的。
 *
 * - 内置管线:`Sprites-Default`,在 Unity 的内置资源里(guid 全零)
 * - URP:`Sprite-Unlit-Default`,随 URP 包发布(包内资源 guid 跨工程稳定)
 */
export const SPRITE_MATERIALS = {
  builtin: '{fileID: 10754, guid: 0000000000000000f000000000000000, type: 0}',
  urp: '{fileID: 2100000, guid: 9dfc825aed78fcd4ba02077103263b40, type: 2}',
} as const

export type RenderPipeline = keyof typeof SPRITE_MATERIALS

export interface AssetRef {
  readonly fileID: number
  readonly guid: string
}

export interface RendererSpec {
  /** null 表示这个 slot 在绑定姿势下没有挂图(动画里可能再挂上) */
  readonly sprite: AssetRef | null
  /** 越大越靠前 */
  readonly sortingOrder: number
  readonly color: { r: number; g: number; b: number; a: number }
  /**
   * 渲染器初始是否启用(`m_Enabled`)。不给就是启用。
   *
   * 这是「换图」那一维的开关:一个 slot 下只有 setup 的 `attachmentName` 那一个亮着,
   * 表情变体初始是灭的;attachment 时间轴以阶梯曲线驱动它。皮肤那一维走 GameObject 的
   * `m_IsActive`(见 PrefabNode.active),两个开关是 AND,各由 Animator 的一层驱动。
   */
  readonly enabled?: boolean
}

/** 蒙皮网格才需要。骨骼下标指向 nodes 数组 */
export interface SkinSpec {
  readonly rootBone: number
  readonly bones: readonly number[]
}

/**
 * 走 `SkinnedMeshRenderer` 的网格(有 deform / 绑定非刚性 / 缩放不一致的那些)。
 *
 * 它吃一个 Mesh 资产而不是 sprite,所以材质要自己带纹理(见 writeMaterial.ts)。
 * 节点应当放在骨架根下、变换为单位 —— 网格空间就是骨架空间,绑定矩阵按此算。
 */
export interface SkinnedMeshSpec {
  /** Mesh 资产,fileID 取 MESH_FILE_ID */
  readonly mesh: AssetRef
  /** 带纹理的材质,fileID 取 MATERIAL_FILE_ID */
  readonly material: AssetRef
  /** 骨骼下标指向 nodes 数组,顺序必须与 Mesh 的 bindposes 一致 */
  readonly bones: readonly number[]
  readonly rootBone: number
  readonly blendShapeCount: number
  readonly sortingOrder: number
  /** 与 RendererSpec.enabled 同义:换图那一维的初始开关 */
  readonly enabled?: boolean
  /**
   * 每顶点用几根骨骼蒙皮。**4 = Bone4,写死,外观不随工程 Quality 档位变**(学 Spine);
   * 0 = Auto 跟随 Quality —— 真实工程的 Low/Medium/High 档往往只有 2 根,会比 SpriteSkin 还差。
   * 只有工程所有档位都设成 Unlimited 时 Auto 才划算(能吃满 >4 根)。
   */
  readonly quality: 0 | 4
}

export interface PrefabNode {
  readonly name: string
  /** 父节点在数组中的下标;根为 -1。**必须父在子之前** */
  readonly parent: number
  readonly position: { x: number; y: number; z: number }
  /** 四元数 */
  readonly rotation: { x: number; y: number; z: number; w: number }
  readonly scale: { x: number; y: number; z: number }
  readonly renderer: RendererSpec | null
  readonly skin: SkinSpec | null
  readonly skinnedMesh?: SkinnedMeshSpec | null
  /**
   * 物体初始是否激活(`m_IsActive`)。不给就是激活。
   *
   * 这是「皮肤」那一维的开关:挂图节点属于初始皮肤(或默认皮肤且没被初始皮肤盖住)才亮。
   * 换图那一维在渲染器的 `m_Enabled` 上(见 RendererSpec.enabled)。
   */
  readonly active?: boolean
}

export interface PrefabOptions {
  /** 用来给 fileID 加盐,保证不同骨架之间不撞 */
  readonly seed: string
  /** 挂在根节点上的 AnimatorController;不需要就传 null */
  readonly controller: AssetRef | null
  readonly renderPipeline: RenderPipeline
}

const v3 = (v: { x: number; y: number; z: number }) =>
  `{x: ${num(v.x)}, y: ${num(v.y)}, z: ${num(v.z)}}`

function num(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)))
}

const ref = (r: AssetRef, type: number) => `{fileID: ${r.fileID}, guid: ${r.guid}, type: ${type}}`

interface Ids {
  readonly go: number
  readonly transform: number
  readonly renderer: number
  readonly skin: number
  readonly skinnedMesh: number
  readonly animator: number
}

const COMMON_HEADER = [
  '  m_ObjectHideFlags: 0',
  '  m_CorrespondingSourceObject: {fileID: 0}',
  '  m_PrefabInstance: {fileID: 0}',
  '  m_PrefabAsset: {fileID: 0}',
]

export function writePrefab(nodes: readonly PrefabNode[], options: PrefabOptions): string {
  if (nodes.length === 0) throw new Error('prefab 至少要有一个根节点')
  if (nodes[0]!.parent !== -1) throw new Error('nodes[0] 必须是根节点')
  for (let i = 1; i < nodes.length; i++) {
    const parent = nodes[i]!.parent
    if (parent < 0) throw new Error(`节点 "${nodes[i]!.name}" 是第二个根 —— prefab 只能有一个根`)
    if (parent >= i) throw new Error(`节点 "${nodes[i]!.name}" 的父节点排在它后面`)
  }

  // 名字可能重复,加上下标保证 ID 唯一且稳定
  const ids: Ids[] = nodes.map((n, i) => {
    const key = `${options.seed}/${i}/${n.name}`
    return {
      go: fileId(`${key}/go`),
      transform: fileId(`${key}/tr`),
      renderer: fileId(`${key}/sr`),
      skin: fileId(`${key}/sk`),
      skinnedMesh: fileId(`${key}/smr`),
      animator: fileId(`${key}/an`),
    }
  })

  const childrenOf = nodes.map<number[]>(() => [])
  nodes.forEach((n, i) => {
    if (n.parent >= 0) childrenOf[n.parent]!.push(i)
  })

  const docs: string[] = []

  nodes.forEach((node, i) => {
    const id = ids[i]!
    const components = [`  - component: {fileID: ${id.transform}}`]
    if (node.renderer !== null) components.push(`  - component: {fileID: ${id.renderer}}`)
    if (node.skin !== null) components.push(`  - component: {fileID: ${id.skin}}`)
    if (node.skinnedMesh) components.push(`  - component: {fileID: ${id.skinnedMesh}}`)
    if (i === 0 && options.controller !== null) components.push(`  - component: {fileID: ${id.animator}}`)

    docs.push(
      [
        `--- !u!${CLASS_GAME_OBJECT} &${id.go}`,
        'GameObject:',
        ...COMMON_HEADER,
        '  serializedVersion: 6',
        '  m_Component:',
        ...components,
        '  m_Layer: 0',
        `  m_Name: ${node.name}`,
        '  m_TagString: Untagged',
        '  m_Icon: {fileID: 0}',
        '  m_NavMeshLayer: 0',
        '  m_StaticEditorFlags: 0',
        `  m_IsActive: ${node.active === false ? 0 : 1}`,
      ].join('\n'),
    )

    const kids = childrenOf[i]!
    docs.push(
      [
        `--- !u!${CLASS_TRANSFORM} &${id.transform}`,
        'Transform:',
        ...COMMON_HEADER,
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

    if (node.renderer !== null) {
      const r = node.renderer
      docs.push(
        [
          `--- !u!${CLASS_SPRITE_RENDERER} &${id.renderer}`,
          'SpriteRenderer:',
          '  serializedVersion: 2',
          ...COMMON_HEADER,
          `  m_GameObject: {fileID: ${id.go}}`,
          `  m_Enabled: ${r.enabled === false ? 0 : 1}`,
          '  m_CastShadows: 0',
          '  m_ReceiveShadows: 0',
          '  m_DynamicOccludee: 1',
          '  m_StaticShadowCaster: 0',
          '  m_MotionVectors: 1',
          '  m_LightProbeUsage: 1',
          '  m_ReflectionProbeUsage: 1',
          '  m_RayTracingMode: 0',
          '  m_RayTraceProcedural: 0',
          '  m_RenderingLayerMask: 1',
          '  m_RendererPriority: 0',
          '  m_Materials:',
          `  - ${SPRITE_MATERIALS[options.renderPipeline]}`,
          '  m_StaticBatchInfo:',
          '    firstSubMesh: 0',
          '    subMeshCount: 0',
          '  m_StaticBatchRoot: {fileID: 0}',
          '  m_ProbeAnchor: {fileID: 0}',
          '  m_LightProbeVolumeOverride: {fileID: 0}',
          '  m_ScaleInLightmap: 1',
          '  m_ReceiveGI: 1',
          '  m_PreserveUVs: 0',
          '  m_IgnoreNormalsForChartDetection: 0',
          '  m_ImportantGI: 0',
          '  m_StitchLightmapSeams: 1',
          '  m_SelectedEditorRenderState: 0',
          '  m_MinimumChartSize: 4',
          '  m_AutoUVMaxDistance: 0.5',
          '  m_AutoUVMaxAngle: 89',
          '  m_LightmapParameters: {fileID: 0}',
          '  m_SortingLayerID: 0',
          '  m_SortingLayer: 0',
          `  m_SortingOrder: ${r.sortingOrder}`,
          '  m_MaskInteraction: 0',
          `  m_Sprite: ${r.sprite === null ? '{fileID: 0}' : ref(r.sprite, 3)}`,
          `  m_Color: {r: ${num(r.color.r)}, g: ${num(r.color.g)}, b: ${num(r.color.b)}, a: ${num(r.color.a)}}`,
          '  m_FlipX: 0',
          '  m_FlipY: 0',
          '  m_DrawMode: 0',
          '  m_Size: {x: 1, y: 1}',
          '  m_AdaptiveModeThreshold: 0.5',
          '  m_SpriteTileMode: 0',
          `  m_WasSpriteAssigned: ${r.sprite === null ? 0 : 1}`,
          '  m_SpriteSortPoint: 0',
        ].join('\n'),
      )
    }

    if (node.skin !== null) {
      const s = node.skin
      docs.push(
        [
          `--- !u!${CLASS_MONO_BEHAVIOUR} &${id.skin}`,
          'MonoBehaviour:',
          ...COMMON_HEADER,
          `  m_GameObject: {fileID: ${id.go}}`,
          '  m_Enabled: 1',
          '  m_EditorHideFlags: 0',
          `  m_Script: {fileID: 11500000, guid: ${SPRITE_SKIN_SCRIPT_GUID}, type: 3}`,
          '  m_Name: ',
          '  m_EditorClassIdentifier: ',
          `  m_RootBone: {fileID: ${ids[s.rootBone]!.transform}}`,
          s.bones.length === 0
            ? '  m_BoneTransforms: []'
            : `  m_BoneTransforms:\n${s.bones.map((b) => `  - {fileID: ${ids[b]!.transform}}`).join('\n')}`,
          '  m_Bounds:',
          '    m_Center: {x: 0, y: 0, z: 0}',
          '    m_Extent: {x: 0, y: 0, z: 0}',
          '  m_AlwaysUpdate: 1',
          '  m_AutoRebind: 0',
        ].join('\n'),
      )
    }

    if (node.skinnedMesh) {
      const m = node.skinnedMesh
      // 字段取自真实样本(Unity 6000.3 存出来的 SkinnedMeshRenderer),
      // 阴影关掉与 SpriteRenderer 一致;m_DirtyAABB 让 Unity 自己重算包围盒
      docs.push(
        [
          `--- !u!${CLASS_SKINNED_MESH_RENDERER} &${id.skinnedMesh}`,
          'SkinnedMeshRenderer:',
          ...COMMON_HEADER,
          `  m_GameObject: {fileID: ${id.go}}`,
          `  m_Enabled: ${m.enabled === false ? 0 : 1}`,
          '  m_CastShadows: 0',
          '  m_ReceiveShadows: 0',
          '  m_DynamicOccludee: 1',
          '  m_StaticShadowCaster: 0',
          '  m_MotionVectors: 1',
          '  m_LightProbeUsage: 1',
          '  m_ReflectionProbeUsage: 1',
          '  m_RayTracingMode: 3',
          '  m_RayTraceProcedural: 0',
          '  m_RayTracingAccelStructBuildFlagsOverride: 0',
          '  m_RayTracingAccelStructBuildFlags: 1',
          '  m_SmallMeshCulling: 1',
          '  m_ForceMeshLod: -1',
          '  m_MeshLodSelectionBias: 0',
          '  m_RenderingLayerMask: 1',
          '  m_RendererPriority: 0',
          '  m_Materials:',
          `  - ${ref(m.material, 2)}`,
          '  m_StaticBatchInfo:',
          '    firstSubMesh: 0',
          '    subMeshCount: 0',
          '  m_StaticBatchRoot: {fileID: 0}',
          '  m_ProbeAnchor: {fileID: 0}',
          '  m_LightProbeVolumeOverride: {fileID: 0}',
          '  m_ScaleInLightmap: 1',
          '  m_ReceiveGI: 1',
          '  m_PreserveUVs: 0',
          '  m_IgnoreNormalsForChartDetection: 0',
          '  m_ImportantGI: 0',
          '  m_StitchLightmapSeams: 1',
          '  m_SelectedEditorRenderState: 3',
          '  m_MinimumChartSize: 4',
          '  m_AutoUVMaxDistance: 0.5',
          '  m_AutoUVMaxAngle: 89',
          '  m_LightmapParameters: {fileID: 0}',
          '  m_GlobalIlluminationMeshLod: 0',
          '  m_SortingLayerID: 0',
          '  m_SortingLayer: 0',
          `  m_SortingOrder: ${m.sortingOrder}`,
          '  m_MaskInteraction: 0',
          '  serializedVersion: 2',
          `  m_Quality: ${m.quality}`,
          '  m_UpdateWhenOffscreen: 0',
          '  m_SkinnedMotionVectors: 1',
          `  m_Mesh: ${ref(m.mesh, 2)}`,
          m.bones.length === 0
            ? '  m_Bones: []'
            : `  m_Bones:\n${m.bones.map((b) => `  - {fileID: ${ids[b]!.transform}}`).join('\n')}`,
          m.blendShapeCount === 0
            ? '  m_BlendShapeWeights: []'
            : `  m_BlendShapeWeights:\n${Array.from({ length: m.blendShapeCount }, () => '  - 0').join('\n')}`,
          `  m_RootBone: {fileID: ${ids[m.rootBone]!.transform}}`,
          '  m_AABB:',
          '    m_Center: {x: 0, y: 0, z: 0}',
          '    m_Extent: {x: 0, y: 0, z: 0}',
          '  m_DirtyAABB: 1',
        ].join('\n'),
      )
    }

    if (i === 0 && options.controller !== null) {
      docs.push(
        [
          `--- !u!${CLASS_ANIMATOR} &${id.animator}`,
          'Animator:',
          '  serializedVersion: 7',
          ...COMMON_HEADER,
          `  m_GameObject: {fileID: ${id.go}}`,
          '  m_Enabled: 1',
          '  m_Avatar: {fileID: 0}',
          `  m_Controller: ${ref(options.controller, 2)}`,
          '  m_CullingMode: 0',
          '  m_UpdateMode: 0',
          '  m_ApplyRootMotion: 0',
          '  m_LinearVelocityBlending: 0',
          '  m_StabilizeFeet: 0',
          '  m_AnimatePhysics: 0',
          '  m_WarningMessage: ',
          '  m_HasTransformHierarchy: 1',
          '  m_AllowConstantClipSamplingOptimization: 1',
          '  m_KeepAnimatorStateOnDisable: 0',
          '  m_WriteDefaultValuesOnDisable: 0',
        ].join('\n'),
      )
    }
  })

  return `%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n${docs.join('\n')}\n`
}
