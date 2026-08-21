import type { AnimationData, BoneTimelines } from '@core/animation.ts'
import type { Attachment, BoneData, SkeletonData, SlotData } from '@core/types.ts'

/** 当前可读的项目文件版本。升级格式时只新增迁移，不原地猜旧字段。 */
export const PROJECT_FORMAT_VERSION = 1 as const

/** 原始图片；path 始终相对项目 `images/` 目录。 */
export interface ImageAsset {
  readonly id: string
  readonly path: string
  readonly width: number
  readonly height: number
}

/** 打包产物的一页大图。区域数据不入库 —— 从 .atlas 文本解析(parseAtlas)即可复原。 */
export interface AtlasPageAsset {
  /** .atlas 文本里的页名,即 PNG 文件名 */
  readonly name: string
  /** 相对项目目录,例如 `atlases/character.png` */
  readonly path: string
}

export interface AtlasAsset {
  readonly id: string
  /** 相对项目目录的 atlas 文本路径，例如 `atlases/character.atlas`。 */
  readonly path: string
  readonly pages: readonly AtlasPageAsset[]
}

/**
 * 运行时项目快照。Map 让 core 的动画和皮肤查找保持高效；保存时通过 ProjectDocument
 * 转为 JSON 友好的数组结构。
 */
export interface ProjectData {
  readonly formatVersion: typeof PROJECT_FORMAT_VERSION
  readonly name: string
  readonly images: readonly ImageAsset[]
  readonly atlases: readonly AtlasAsset[]
  readonly skeleton: SkeletonData
  readonly animations: ReadonlyMap<string, AnimationData>
}

interface SkinEntryDocument {
  readonly slot: number
  readonly attachments: readonly Attachment[]
}

interface SkinDocument {
  readonly name: string
  readonly entries: readonly SkinEntryDocument[]
}

interface SkeletonDocument {
  readonly name: string
  readonly bones: readonly BoneData[]
  readonly slots: readonly SlotData[]
  readonly skins: readonly SkinDocument[]
  readonly defaultSkin: string
}

interface BoneTimelineDocument {
  readonly bone: string
  readonly timelines: BoneTimelines
}

interface AnimationDocument {
  readonly name: string
  readonly duration: number
  readonly bones: readonly BoneTimelineDocument[]
}

/** project.json 的稳定、JSON 可序列化形态。 */
export interface ProjectDocument {
  readonly formatVersion: typeof PROJECT_FORMAT_VERSION
  readonly name: string
  readonly images: readonly ImageAsset[]
  readonly atlases: readonly AtlasAsset[]
  readonly skeleton: SkeletonDocument
  readonly animations: readonly AnimationDocument[]
}

function toSkinDocument(skins: ReadonlyMap<string, ReadonlyMap<number, ReadonlyMap<string, Attachment>>>): SkinDocument[] {
  return [...skins].map(([name, slots]) => ({
    name,
    entries: [...slots].map(([slot, attachments]) => ({ slot, attachments: [...attachments.values()] })),
  }))
}

function fromSkinDocument(skins: readonly SkinDocument[]): ReadonlyMap<string, ReadonlyMap<number, ReadonlyMap<string, Attachment>>> {
  return new Map(
    skins.map((skin) => [
      skin.name,
      new Map(
        skin.entries.map((entry) => [
          entry.slot,
          new Map(entry.attachments.map((attachment) => [attachment.name, attachment])),
        ]),
      ),
    ]),
  )
}

export function toProjectDocument(project: ProjectData): ProjectDocument {
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    name: project.name,
    images: project.images,
    atlases: project.atlases,
    skeleton: {
      name: project.skeleton.name,
      bones: project.skeleton.bones,
      slots: project.skeleton.slots,
      skins: toSkinDocument(project.skeleton.skins),
      defaultSkin: project.skeleton.defaultSkin,
    },
    animations: [...project.animations.values()].map((animation) => ({
      name: animation.name,
      duration: animation.duration,
      bones: [...animation.bones].map(([bone, timelines]) => ({ bone, timelines })),
    })),
  }
}

export function fromProjectDocument(document: ProjectDocument): ProjectData {
  if (document.formatVersion !== PROJECT_FORMAT_VERSION) {
    throw new Error(`不支持的项目文件版本: ${String(document.formatVersion)}`)
  }

  const animations = new Map<string, AnimationData>()
  for (const animation of document.animations) {
    if (animations.has(animation.name)) throw new Error(`动画名称重复: ${animation.name}`)
    animations.set(animation.name, {
      name: animation.name,
      duration: animation.duration,
      bones: new Map(animation.bones.map((entry) => [entry.bone, entry.timelines])),
    })
  }

  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    name: document.name,
    images: document.images,
    atlases: document.atlases,
    skeleton: {
      name: document.skeleton.name,
      bones: document.skeleton.bones,
      slots: document.skeleton.slots,
      skins: fromSkinDocument(document.skeleton.skins),
      defaultSkin: document.skeleton.defaultSkin,
    },
    animations,
  }
}

/** 新建项目的最小合法形态；编辑器可以从它开始添加图片、骨骼和动画。 */
export function createEmptyProject(name = 'Untitled'): ProjectData {
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    name,
    images: [],
    atlases: [],
    skeleton: { name, bones: [], slots: [], skins: new Map([['default', new Map()]]), defaultSkin: 'default' },
    animations: new Map(),
  }
}
