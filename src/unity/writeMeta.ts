/**
 * 写 Unity 的 `.meta`。
 *
 * 结构逐字段照抄真实样本(Unity 6000.3 / com.unity.2d.animation 13.0.2 产出的
 * `Assets/Res/test/test.png.meta`),见 [docs/UNITY-2D.md](../../docs/UNITY-2D.md)。
 *
 * ## 三条不能记错的约定(都在 Unity 的 SpritePostProcess 里写死)
 *
 * ```csharp
 * // 根骨骼要减 pivot,子骨骼不减
 * position = isRoot ? (bone.position - rect.size * rect.pivot) : bone.position;
 * position = position * definitionScale / pixelsPerUnit;
 * // 顶点一律减 pivot
 * vertex = (vertex - rect.size * rect.pivot) * definitionScale / pixelsPerUnit;
 * ```
 *
 * 也就是说:
 * 1. `.meta` 里的**坐标全是像素**,原点在 sprite 矩形的**左下角**
 * 2. **根骨骼与顶点**导入时会减掉 pivot,**子骨骼不会**(子骨骼是相对父骨骼的)
 * 3. 绑定姿势**只有旋转和平移,没有缩放** —— 骨骼链上有非 1 的缩放就对不上
 *
 * `indices` 是**小端** uint32 的十六进制串。Spine 的 `.skel` 是大端,两者相反。
 */

import { unityGuid } from './ids.ts'

export interface MetaBone {
  readonly name: string
  /** 32 位十六进制。同一根骨骼在所有 sprite 里必须一致,否则 Unity 认不成同一根 */
  readonly guid: string
  /** 像素。根骨骼相对矩形左下角,子骨骼相对父骨骼 */
  readonly position: { x: number; y: number }
  /** 相对父骨骼的局部旋转,四元数 */
  readonly rotation: { x: number; y: number; z: number; w: number }
  readonly length: number
  /** 本数组内的下标;根为 -1 */
  readonly parentId: number
}

/** 一个顶点最多绑 4 根骨骼 —— Unity 的 BoneWeight 就四个槽 */
export interface MetaWeight {
  readonly weights: readonly [number, number, number, number]
  readonly bones: readonly [number, number, number, number]
}

export interface MetaSprite {
  readonly name: string
  /** 在纹理里的矩形,**原点左下** */
  readonly rect: { x: number; y: number; width: number; height: number }
  /** 归一化的轴心;允许超出 [0,1] */
  readonly pivot: { x: number; y: number }
  readonly spriteID: string
  readonly internalID: number
  /** 自定义网格的顶点(像素,相对矩形左下角);空数组表示用默认矩形 */
  readonly vertices: readonly { x: number; y: number }[]
  /** 三角形下标,每三个一组 */
  readonly triangles: readonly number[]
  readonly bones: readonly MetaBone[]
  readonly weights: readonly MetaWeight[]
}

export interface TextureMetaOptions {
  readonly guid: string
  readonly pixelsPerUnit: number
  readonly sprites: readonly MetaSprite[]
}

/** Unity 的 SpriteAlignment.Custom */
const ALIGNMENT_CUSTOM = 9

function num(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)))
}

/** `indices` 的编码:每个下标一个小端 uint32,拼成十六进制串 */
export function encodeIndices(triangles: readonly number[]): string {
  let out = ''
  for (const t of triangles) {
    const v = t >>> 0
    out +=
      (v & 0xff).toString(16).padStart(2, '0') +
      ((v >>> 8) & 0xff).toString(16).padStart(2, '0') +
      ((v >>> 16) & 0xff).toString(16).padStart(2, '0') +
      ((v >>> 24) & 0xff).toString(16).padStart(2, '0')
  }
  return out
}

function boneLines(bone: MetaBone, indent: string): string[] {
  return [
    `${indent}- name: ${bone.name}`,
    `${indent}  guid: ${bone.guid}`,
    `${indent}  position: {x: ${num(bone.position.x)}, y: ${num(bone.position.y)}, z: 0}`,
    `${indent}  rotation: {x: ${num(bone.rotation.x)}, y: ${num(bone.rotation.y)}, z: ${num(bone.rotation.z)}, w: ${num(bone.rotation.w)}}`,
    `${indent}  length: ${num(bone.length)}`,
    `${indent}  parentId: ${bone.parentId}`,
    `${indent}  color:`,
    `${indent}    serializedVersion: 2`,
    `${indent}    rgba: 4278190335`,
  ]
}

function spriteLines(sprite: MetaSprite): string[] {
  const lines = [
    '    - serializedVersion: 2',
    `      name: ${sprite.name}`,
    '      rect:',
    '        serializedVersion: 2',
    `        x: ${num(sprite.rect.x)}`,
    `        y: ${num(sprite.rect.y)}`,
    `        width: ${num(sprite.rect.width)}`,
    `        height: ${num(sprite.rect.height)}`,
    `      alignment: ${ALIGNMENT_CUSTOM}`,
    `      pivot: {x: ${num(sprite.pivot.x)}, y: ${num(sprite.pivot.y)}}`,
    '      border: {x: 0, y: 0, z: 0, w: 0}',
    '      customData: ',
    '      outline: []',
    '      physicsShape: []',
    '      tessellationDetail: 0',
  ]

  if (sprite.bones.length === 0) {
    lines.push('      bones: []')
  } else {
    lines.push('      bones:')
    for (const bone of sprite.bones) lines.push(...boneLines(bone, '      '))
  }

  lines.push(`      spriteID: ${sprite.spriteID}`, `      internalID: ${sprite.internalID}`)

  if (sprite.vertices.length === 0) {
    lines.push('      vertices: []', '      indices: ')
  } else {
    lines.push('      vertices:')
    for (const v of sprite.vertices) lines.push(`      - {x: ${num(v.x)}, y: ${num(v.y)}}`)
    lines.push(`      indices: ${encodeIndices(sprite.triangles)}`)
  }

  lines.push('      edges: []')

  if (sprite.weights.length === 0) {
    lines.push('      weights: []')
  } else {
    lines.push('      weights:')
    for (const w of sprite.weights) {
      lines.push(
        `      - 'weight[0]': ${num(w.weights[0])}`,
        `        'weight[1]': ${num(w.weights[1])}`,
        `        'weight[2]': ${num(w.weights[2])}`,
        `        'weight[3]': ${num(w.weights[3])}`,
        `        'boneIndex[0]': ${w.bones[0]}`,
        `        'boneIndex[1]': ${w.bones[1]}`,
        `        'boneIndex[2]': ${w.bones[2]}`,
        `        'boneIndex[3]': ${w.bones[3]}`,
      )
    }
  }

  return lines
}

export function writeTextureMeta(options: TextureMetaOptions): string {
  const { guid, pixelsPerUnit, sprites } = options

  const lines = [
    'fileFormatVersion: 2',
    `guid: ${guid}`,
    'TextureImporter:',
    '  internalIDToNameTable: []',
    '  externalObjects: {}',
    '  serializedVersion: 13',
    '  mipmaps:',
    '    mipMapMode: 0',
    '    enableMipMap: 0',
    '    sRGBTexture: 1',
    '    linearTexture: 0',
    '    fadeOut: 0',
    '    borderMipMap: 0',
    '    mipMapsPreserveCoverage: 0',
    '    alphaTestReferenceValue: 0.5',
    '    mipMapFadeDistanceStart: 1',
    '    mipMapFadeDistanceEnd: 3',
    '  bumpmap:',
    '    convertToNormalMap: 0',
    '    externalNormalMap: 0',
    '    heightScale: 0.25',
    '    normalMapFilter: 0',
    '    flipGreenChannel: 0',
    '  isReadable: 0',
    '  streamingMipmaps: 0',
    '  streamingMipmapsPriority: 0',
    '  vTOnly: 0',
    '  ignoreMipmapLimit: 0',
    '  grayScaleToAlpha: 0',
    '  generateCubemap: 6',
    '  cubemapConvolution: 0',
    '  seamlessCubemap: 0',
    '  textureFormat: 1',
    // ⚠️ 必须 ≥ 实际尺寸。缩了的话 Unity 会按 definitionScale 缩放顶点和骨骼,
    // 我们算好的像素坐标就全对不上了
    '  maxTextureSize: 8192',
    '  textureSettings:',
    '    serializedVersion: 2',
    '    filterMode: 1',
    '    aniso: 1',
    '    mipBias: 0',
    '    wrapU: 1',
    '    wrapV: 1',
    '    wrapW: 0',
    '  nPOTScale: 0',
    '  lightmap: 0',
    '  compressionQuality: 50',
    // 2 = Multiple
    '  spriteMode: 2',
    '  spriteExtrude: 1',
    // 0 = FullRect。我们自己给了网格,不需要 Unity 再生成紧贴轮廓的
    '  spriteMeshType: 0',
    '  alignment: 0',
    '  spritePivot: {x: 0.5, y: 0.5}',
    `  spritePixelsToUnits: ${num(pixelsPerUnit)}`,
    '  spriteBorder: {x: 0, y: 0, z: 0, w: 0}',
    '  spriteGenerateFallbackPhysicsShape: 0',
    '  alphaUsage: 1',
    '  alphaIsTransparency: 1',
    '  spriteTessellationDetail: -1',
    // 8 = Sprite (2D and UI)
    '  textureType: 8',
    '  textureShape: 1',
    '  singleChannelComponent: 0',
    '  flipbookRows: 1',
    '  flipbookColumns: 1',
    '  maxTextureSizeSet: 0',
    '  compressionQualitySet: 0',
    '  textureFormatSet: 0',
    '  ignorePngGamma: 0',
    '  applyGammaDecoding: 0',
    '  swizzle: 50462976',
    '  cookieLightType: 0',
    '  platformSettings:',
    '  - serializedVersion: 4',
    '    buildTarget: DefaultTexturePlatform',
    '    maxTextureSize: 8192',
    '    resizeAlgorithm: 0',
    '    textureFormat: -1',
    '    textureCompression: 0',
    '    compressionQuality: 50',
    '    crunchedCompression: 0',
    '    allowsAlphaSplitting: 0',
    '    overridden: 0',
    '    ignorePlatformSupport: 0',
    '    androidETC2FallbackOverride: 0',
    '    forceMaximumCompressionQuality_BC6H_BC7: 0',
    '  spriteSheet:',
    '    serializedVersion: 2',
  ]

  if (sprites.length === 0) lines.push('    sprites: []')
  else {
    lines.push('    sprites:')
    for (const sprite of sprites) lines.push(...spriteLines(sprite))
  }

  // 这一段是「单图模式」用的默认值,Multiple 模式下 Unity 也照样写出来
  lines.push(
    '    outline: []',
    '    customData: ',
    '    physicsShape: []',
    '    bones: []',
    `    spriteID: ${unityGuid(`${guid}/single`)}`,
    '    internalID: 0',
    '    vertices: []',
    '    indices: ',
    '    edges: []',
    '    weights: []',
    '    secondaryTextures: []',
  )

  if (sprites.length === 0) lines.push('    nameFileIdTable: {}')
  else {
    lines.push('    nameFileIdTable:')
    // Unity 自己写出来是按名字排序的,跟着做以免每次导出 diff 乱跳
    for (const sprite of [...sprites].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      lines.push(`      ${sprite.name}: ${sprite.internalID}`)
    }
  }

  lines.push(
    '  mipmapLimitGroupName: ',
    '  pSDRemoveMatte: 0',
    '  userData: ',
    '  assetBundleName: ',
    '  assetBundleVariant: ',
    '',
  )

  return lines.join('\n')
}

/** `.anim` / `.controller` 这类 Unity 原生资源的 `.meta` */
export function writeNativeMeta(guid: string, mainObjectFileID: number): string {
  return [
    'fileFormatVersion: 2',
    `guid: ${guid}`,
    'NativeFormatImporter:',
    '  externalObjects: {}',
    `  mainObjectFileID: ${mainObjectFileID}`,
    '  userData: ',
    '  assetBundleName: ',
    '  assetBundleVariant: ',
    '',
  ].join('\n')
}

export function writePrefabMeta(guid: string): string {
  return [
    'fileFormatVersion: 2',
    `guid: ${guid}`,
    'PrefabImporter:',
    '  externalObjects: {}',
    '  userData: ',
    '  assetBundleName: ',
    '  assetBundleVariant: ',
    '',
  ].join('\n')
}
