import type { AssetRef, RenderPipeline } from './writePrefab.ts'

/**
 * 写一个带纹理的 sprite 材质(`.mat`,classID 21)。
 *
 * SpriteRenderer 会自己把 sprite 的纹理塞给材质,所以它能共用包里的默认材质;
 * **SkinnedMeshRenderer 不会** —— 挂默认材质出来是纯白。所以走 SkinnedMeshRenderer 的
 * 网格需要一个明确引用了图集的材质,每张图集页一个。
 *
 * URP 的写法取自包内样本 `Runtime/Materials/Sprite-Unlit-Default.mat`(shader guid 跨工程稳定)。
 * 内置管线用 `Sprites/Default`(内置 shader,fileID 10753)—— **这条没有实测**,
 * 验证工程是 URP 的。
 */

export const MATERIAL_FILE_ID = 2100000
/** Texture2D 主对象的 fileID(classID 28 × 100000) */
export const TEXTURE_FILE_ID = 2800000

const SHADERS: Record<RenderPipeline, string> = {
  urp: '{fileID: 4800000, guid: 13c02b14c4d048fa9653293d54f6e0e1, type: 3}',
  builtin: '{fileID: 10753, guid: 0000000000000000f000000000000000, type: 0}',
}

export interface SpriteMaterialOptions {
  readonly name: string
  readonly renderPipeline: RenderPipeline
  /** 图集页的纹理(fileID 取 TEXTURE_FILE_ID) */
  readonly texture: AssetRef
}

export function writeSpriteMaterial(options: SpriteMaterialOptions): string {
  const texEnv = (name: string, texture: string) => [
    `    - ${name}:`,
    `        m_Texture: ${texture}`,
    '        m_Scale: {x: 1, y: 1}',
    '        m_Offset: {x: 0, y: 0}',
  ]
  const main = `{fileID: ${options.texture.fileID}, guid: ${options.texture.guid}, type: 3}`
  const urp = options.renderPipeline === 'urp'

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
    `  m_Shader: ${SHADERS[options.renderPipeline]}`,
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
    '    - _EnableExternalAlpha: 0',
    '    m_Colors:',
    '    - _Color: {r: 1, g: 1, b: 1, a: 1}',
    '    - _Flip: {r: 1, g: 1, b: 1, a: 1}',
    '    - _RendererColor: {r: 1, g: 1, b: 1, a: 1}',
    '  m_BuildTextureStacks: []',
    '',
  ].join('\n')
}
