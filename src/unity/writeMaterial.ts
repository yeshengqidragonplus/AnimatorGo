import type { AssetRef, RenderPipeline } from './writePrefab.ts'

/**
 * 写一个 sprite 材质(`.mat`,classID 21)。
 *
 * SpriteRenderer 会自己把 sprite 的纹理塞给材质,所以它能共用包里的默认材质;
 * **SkinnedMeshRenderer 不会** —— 挂默认材质出来是纯白。所以走 SkinnedMeshRenderer 的
 * 网格需要一个明确引用了图集的材质,每张图集页一个。混合模式不是 normal 的 slot 另有自己的材质
 * (自带着色器 + Spine 的混合因子,docs/UNITY-2D.md 第 18 节),SpriteRenderer 用的那种不带纹理。
 *
 * URP 的写法取自包内样本 `Runtime/Materials/Sprite-Unlit-Default.mat`(shader guid 跨工程稳定)。
 * 内置管线用 `Sprites/Default`(内置 shader,fileID 10753)—— **这条没有实测**,
 * 验证工程是 URP 的。
 */

export const MATERIAL_FILE_ID = 2100000
/** Texture2D 主对象的 fileID(classID 28 × 100000) */
export const TEXTURE_FILE_ID = 2800000

/**
 * 被 clipping 遮罩遮住的 SkinnedMeshRenderer 用的着色器(`tools/unity/runtime/AnimatorGoMaskedMesh.shader`,
 * 随产物拷进 `AnimatorGoRuntime/` 一次)。GUID 写死在它的 `.shader.meta` 里 —— 改了这里就得同步改那个 meta。
 * 只有 URP 的(自带的 Sprite-Unlit-Default 兼容 SRP Batcher,遮罩对 SkinnedMeshRenderer 不生效,见那个文件头)
 */
export const MASKED_MESH_SHADER_GUID = '8d2c6a1e4b7f49a3a5e0c9b8d7f6e1a2'
export const MASKED_MESH_SHADER_FILE = 'AnimatorGoMaskedMesh.shader'

/** Spine 的混合模式里 Unity 默认 sprite 材质没有的三种 */
export type SpineBlend = 'additive' | 'multiply' | 'screen'

/**
 * Spine 自己的混合因子(`UnityEngine.Rendering.BlendMode` 的取值),按**预乘颜色**写 —— 着色器输出 rgb × a。
 * alpha 一律 One / dst(Spine 也是)。multiply 展开就是 `dst · lerp(1, src.rgb, src.a)`:透明的地方不变暗
 */
export const BLEND_FACTORS: Record<SpineBlend, { readonly src: number; readonly dst: number }> = {
  additive: { src: 1, dst: 1 }, // One, One
  multiply: { src: 2, dst: 10 }, // DstColor, OneMinusSrcAlpha
  screen: { src: 1, dst: 6 }, // One, OneMinusSrcColor
}

/**
 * 混合模式用的着色器(`tools/unity/runtime/`,随产物拷进 `AnimatorGoRuntime/` 一次),两套管线各一个:URP 照 Sprite-Unlit-Default、
 * 内置照 Sprites/Default,只把混合因子改成材质属性(`_SrcBlend` / `_DstBlend`)。SpriteRenderer、SkinnedMeshRenderer 共用。
 * GUID 写死在各自的 `.shader.meta` 里 —— 改了这里就得同步改那个 meta。被遮罩遮住的 SkinnedMeshRenderer 不用它,用
 * AnimatorGoMaskedMesh(同样的两个属性)
 */
export const BLEND_SHADER_GUIDS: Record<RenderPipeline, string> = {
  urp: 'ad1ac387dff50e11b2c7dc7f9736e993',
  builtin: '1a02f113a0fca20e62f8c617256f5e2e',
}
export const BLEND_SHADER_FILES: Record<RenderPipeline, string> = {
  urp: 'AnimatorGoBlend.shader',
  builtin: 'AnimatorGoBlendBuiltin.shader',
}

const SHADERS: Record<RenderPipeline, string> = {
  urp: '{fileID: 4800000, guid: 13c02b14c4d048fa9653293d54f6e0e1, type: 3}',
  builtin: '{fileID: 10753, guid: 0000000000000000f000000000000000, type: 0}',
}

export interface SpriteMaterialOptions {
  readonly name: string
  readonly renderPipeline: RenderPipeline
  /** 图集页的纹理(fileID 取 TEXTURE_FILE_ID);null = 不带(SpriteRenderer 用的,它自己把 sprite 的纹理塞给材质) */
  readonly texture: AssetRef | null
  /** 用 AnimatorGoMaskedMesh 着色器(被遮罩遮住的 SkinnedMeshRenderer;只有 URP) */
  readonly masked?: boolean
  /** Spine 的混合模式:不遮的用 AnimatorGoBlend 着色器,遮住的用 AnimatorGoMaskedMesh,混合因子写进 `_SrcBlend` / `_DstBlend` */
  readonly blend?: SpineBlend
}

export function writeSpriteMaterial(options: SpriteMaterialOptions): string {
  const texEnv = (name: string, texture: string) => [
    `    - ${name}:`,
    `        m_Texture: ${texture}`,
    '        m_Scale: {x: 1, y: 1}',
    '        m_Offset: {x: 0, y: 0}',
  ]
  const main = options.texture === null ? '{fileID: 0}' : `{fileID: ${options.texture.fileID}, guid: ${options.texture.guid}, type: 3}`
  const urp = options.renderPipeline === 'urp'
  const shader =
    options.masked === true ? `{fileID: 4800000, guid: ${MASKED_MESH_SHADER_GUID}, type: 3}`
    : options.blend !== undefined ? `{fileID: 4800000, guid: ${BLEND_SHADER_GUIDS[options.renderPipeline]}, type: 3}`
    : SHADERS[options.renderPipeline]
  const factors = options.blend === undefined ? null : BLEND_FACTORS[options.blend]

  return [
    '%YAML 1.1',
    '%TAG !u! tag:unity3d.com,2011:',
    `--- !u!21 &${MATERIAL_FILE_ID}`,
    'Material:',
    '  serializedVersion: 6',
    '  m_ObjectHideFlags: 0',
    '  m_CorrespondingSourceObject: {fileID: 0}',
    '  m_PrefabInstance: {fileID: 0}',
    '  m_PrefabAsset: {fileID: 0}',
    `  m_Name: ${options.name}`,
    `  m_Shader: ${shader}`,
    '  m_ShaderKeywords: ETC1_EXTERNAL_ALPHA',
    '  m_LightmapFlags: 4',
    '  m_EnableInstancingVariants: 0',
    '  m_DoubleSidedGI: 0',
    '  m_CustomRenderQueue: -1',
    '  stringTagMap: {}',
    '  disabledShaderPasses: []',
    '  m_SavedProperties:',
    '    serializedVersion: 3',
    '    m_TexEnvs:',
    ...texEnv('_AlphaTex', '{fileID: 0}'),
    ...texEnv('_MainTex', main),
    ...(urp ? [...texEnv('_MaskTex', '{fileID: 0}'), ...texEnv('_NormalMap', '{fileID: 0}')] : []),
    '    m_Ints: []',
    '    m_Floats:',
    '    - PixelSnap: 0',
    ...(factors === null ? [] : [`    - _DstBlend: ${factors.dst}`]),
    '    - _EnableExternalAlpha: 0',
    ...(factors === null ? [] : [`    - _SrcBlend: ${factors.src}`]),
    '    m_Colors:',
    '    - _Color: {r: 1, g: 1, b: 1, a: 1}',
    '    - _Flip: {r: 1, g: 1, b: 1, a: 1}',
    '    - _RendererColor: {r: 1, g: 1, b: 1, a: 1}',
    '  m_BuildTextureStacks: []',
    '',
  ].join('\n')
}
