import { SPRITE_FRAME_SUB_ID, TEXTURE_SUB_ID } from './ids.ts'

/**
 * `.meta` 文件。Cocos 的资源库(asset-db)按 `.meta` 里的 `uuid` 认资源、按 `userData` 读导入设置 ——
 * 文件里带着 meta 一起拖进工程,uuid 就不会变(和 Unity 的 `.meta` 一个意思)。
 *
 * `imported: false` + 空的 `files`:让资源库第一次打开时自己导入,它会把 `imported`、`files`、`ver` 补全
 * (实测 3.8.8:我们写的 uuid 和 userData 都保留)。
 */

const text = (o: unknown) => JSON.stringify(o, null, 2) + '\n'

function base(importer: string, uuid: string, ver: string, userData: Record<string, unknown>, subMetas: Record<string, unknown> = {}): Record<string, unknown> {
  return { ver, importer, imported: false, uuid, files: [], subMetas, userData }
}

/**
 * 图片:导成 sprite-frame。两个子资源 id 固定(`@6c48a` 贴图、`@f9941` spriteFrame)。
 *
 * ⚠️ `trimType: 'none'`:资源库默认会把透明边裁掉再改 rect / offset,我们的图本来就是裁好的,
 * 而且 UITransform 的大小和锚点是按整张图算的 —— 再裁一次锚点就偏了。
 */
export function imageMeta(uuid: string, name: string, width: number, height: number): string {
  const spriteFrame = {
    importer: 'sprite-frame',
    uuid: `${uuid}@${SPRITE_FRAME_SUB_ID}`,
    displayName: name,
    id: SPRITE_FRAME_SUB_ID,
    name: 'spriteFrame',
    userData: {
      trimType: 'none',
      trimThreshold: 1,
      rotated: false,
      offsetX: 0,
      offsetY: 0,
      trimX: 0,
      trimY: 0,
      width,
      height,
      rawWidth: width,
      rawHeight: height,
      borderTop: 0,
      borderBottom: 0,
      borderLeft: 0,
      borderRight: 0,
      packable: true,
      pixelsToUnit: 100,
      pivotX: 0.5,
      pivotY: 0.5,
      meshType: 0,
      vertices: {
        rawPosition: [-width / 2, -height / 2, 0, width / 2, -height / 2, 0, -width / 2, height / 2, 0, width / 2, height / 2, 0],
        indexes: [0, 1, 2, 2, 1, 3],
        uv: [0, height, width, height, 0, 0, width, 0],
        nuv: [0, 0, 1, 0, 0, 1, 1, 1],
        minPos: [-width / 2, -height / 2, 0],
        maxPos: [width / 2, height / 2, 0],
      },
      isUuid: true,
      imageUuidOrDatabaseUri: `${uuid}@${TEXTURE_SUB_ID}`,
      atlasUuid: '',
    },
    ver: '1.0.12',
    imported: false,
    files: [],
    subMetas: {},
  }
  const texture = {
    importer: 'texture',
    uuid: `${uuid}@${TEXTURE_SUB_ID}`,
    displayName: name,
    id: TEXTURE_SUB_ID,
    name: 'texture',
    userData: {
      wrapModeS: 'clamp-to-edge',
      wrapModeT: 'clamp-to-edge',
      imageUuidOrDatabaseUri: uuid,
      isUuid: true,
      visible: false,
      minfilter: 'linear',
      magfilter: 'linear',
      mipfilter: 'none',
      anisotropy: 0,
    },
    ver: '1.0.22',
    imported: false,
    files: [],
    subMetas: {},
  }
  return text(base('image', uuid, '1.0.27', { type: 'sprite-frame', hasAlpha: true, fixAlphaTransparencyArtifacts: false, redirect: `${uuid}@${TEXTURE_SUB_ID}` }, { [TEXTURE_SUB_ID]: texture, [SPRITE_FRAME_SUB_ID]: spriteFrame }))
}

export function prefabMeta(uuid: string, name: string): string {
  return text(base('prefab', uuid, '1.1.50', { syncNodeName: name }))
}

export function animationClipMeta(uuid: string, name: string): string {
  return text(base('animation-clip', uuid, '2.0.4', { name }))
}

export function directoryMeta(uuid: string): string {
  return text(base('directory', uuid, '1.2.0', { compressionType: {}, isRemoteBundle: {} }))
}

/**
 * 自动图集(`.pac`):构建时把这个目录里的图打进一张图集,编辑器里照旧是一张张小图。
 * 内容照 3.8.8 的 `default_file_content/auto-atlas`。
 */
export const AUTO_ATLAS_CONTENT = '{\n    "__type__": "cc.SpriteAtlas"\n}\n'

export function autoAtlasMeta(uuid: string, maxSize: number): string {
  return text(base('auto-atlas', uuid, '1.0.8', {
    maxWidth: maxSize,
    maxHeight: maxSize,
    padding: 2,
    allowRotation: true,
    forceSquared: false,
    powerOfTwo: false,
    algorithm: 'MaxRects',
    format: 'png',
    quality: 80,
    contourBleed: true,
    paddingBleed: true,
    filterUnused: true,
    removeTextureInBundle: true,
    removeImageInBundle: true,
    removeSpriteAtlasInBundle: true,
    compressSettings: {},
    textureSetting: { wrapModeS: 'clamp-to-edge', wrapModeT: 'clamp-to-edge', minfilter: 'linear', magfilter: 'linear', mipfilter: 'none', anisotropy: 0 },
  }))
}
