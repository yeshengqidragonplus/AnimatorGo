import { SpineInput } from './input.ts'

/**
 * 读 `.skel` 的骨架部分(不含皮肤、事件、动画)。
 *
 * 按 [docs/SPINE-BINARY.md](../../../docs/SPINE-BINARY.md) 实现,不是源码翻译。
 * 两个版本的差异只在两处,都用 `is38` 分支处理 —— 见文档第 2、5 节。
 */

export type SpineMajor = '3.8' | '4.x'

export interface SkeletonHeader {
  readonly hash: string | null
  readonly version: string
  readonly major: SpineMajor
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly nonessential: boolean
  readonly fps: number | null
  readonly imagesPath: string | null
  readonly audioPath: string | null
}

export interface BoneRecord {
  readonly name: string
  readonly parent: number // -1 = 根骨骼
  readonly rotation: number
  readonly x: number
  readonly y: number
  readonly scaleX: number
  readonly scaleY: number
  readonly shearX: number
  readonly shearY: number
  readonly length: number
  readonly transformMode: number
  readonly skinRequired: boolean
}

export interface SlotRecord {
  readonly name: string
  readonly bone: number
  readonly color: number
  readonly darkColor: number // -1 = 无暗色
  readonly attachmentName: string | null
  readonly blendMode: number
}

export interface IkRecord {
  readonly name: string
  readonly order: number
  readonly skinRequired: boolean
  readonly bones: readonly number[]
  readonly target: number
  readonly mix: number
  readonly softness: number
  readonly bendDirection: number
  readonly compress: boolean
  readonly stretch: boolean
  readonly uniform: boolean
}

/**
 * Transform 约束。
 *
 * ⚠️ 3.8 有 4 个 mix,4.x 有 6 个 —— `translateMix` 拆成了 `mixX`/`mixY`,
 * `scaleMix` 拆成了 `mixScaleX`/`mixScaleY`。这里统一存成 4.x 的六字段形式,
 * 读 3.8 时把单值复制到两个轴上(升级方向无损)。
 */
export interface TransformRecord {
  readonly name: string
  readonly order: number
  readonly skinRequired: boolean
  readonly bones: readonly number[]
  readonly target: number
  readonly local: boolean
  readonly relative: boolean
  readonly offsetRotation: number
  readonly offsetX: number
  readonly offsetY: number
  readonly offsetScaleX: number
  readonly offsetScaleY: number
  readonly offsetShearY: number
  readonly mixRotate: number
  readonly mixX: number
  readonly mixY: number
  readonly mixScaleX: number
  readonly mixScaleY: number
  readonly mixShearY: number
}

export interface SkeletonPart {
  readonly header: SkeletonHeader
  readonly strings: readonly (string | null)[]
  readonly bones: readonly BoneRecord[]
  readonly slots: readonly SlotRecord[]
  readonly ik: readonly IkRecord[]
  readonly transform: readonly TransformRecord[]
  /** 读到哪个字节为止 —— 后面是 path 约束、皮肤、事件、动画,尚未实现 */
  readonly offsetAfterTransform: number
  readonly totalBytes: number
}

/**
 * 从版本字符串判断走哪套布局。
 *
 * 4.x 运行时是靠"version 字符串长度 > 13 就当成旧文件"来区分的 ——
 * 说明两版**无法自识别**,必须由调用方或版本号决定。
 */
export function majorOf(version: string): SpineMajor {
  return version.startsWith('3.') ? '3.8' : '4.x'
}

function readBones(input: SpineInput, nonessential: boolean): BoneRecord[] {
  const count = input.readVarInt()
  const bones: BoneRecord[] = []

  for (let i = 0; i < count; i++) {
    const name = input.readString() ?? ''
    // 根骨骼没有 parent 字段
    const parent = i === 0 ? -1 : input.readVarInt()
    const bone: BoneRecord = {
      name,
      parent,
      rotation: input.readFloat(),
      x: input.readFloat(),
      y: input.readFloat(),
      scaleX: input.readFloat(),
      scaleY: input.readFloat(),
      shearX: input.readFloat(),
      shearY: input.readFloat(),
      length: input.readFloat(),
      transformMode: input.readVarInt(),
      skinRequired: input.readBoolean(),
    }
    if (nonessential) input.readInt() // 编辑器里显示用的骨骼颜色,运行时不用
    bones.push(bone)
  }
  return bones
}

function readSlots(input: SpineInput): SlotRecord[] {
  const count = input.readVarInt()
  const slots: SlotRecord[] = []
  for (let i = 0; i < count; i++) {
    slots.push({
      name: input.readString() ?? '',
      bone: input.readVarInt(),
      color: input.readInt(),
      darkColor: input.readInt(),
      attachmentName: input.readStringRef(),
      blendMode: input.readVarInt(),
    })
  }
  return slots
}

function readBoneList(input: SpineInput): number[] {
  const n = input.readVarInt()
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(input.readVarInt())
  return out
}

function readIk(input: SpineInput): IkRecord[] {
  const count = input.readVarInt()
  const out: IkRecord[] = []
  for (let i = 0; i < count; i++) {
    out.push({
      name: input.readString() ?? '',
      order: input.readVarInt(),
      skinRequired: input.readBoolean(),
      bones: readBoneList(input),
      target: input.readVarInt(),
      mix: input.readFloat(),
      softness: input.readFloat(),
      bendDirection: input.readSByte(),
      compress: input.readBoolean(),
      stretch: input.readBoolean(),
      uniform: input.readBoolean(),
    })
  }
  return out
}

function readTransform(input: SpineInput, is38: boolean): TransformRecord[] {
  const count = input.readVarInt()
  const out: TransformRecord[] = []

  for (let i = 0; i < count; i++) {
    const head = {
      name: input.readString() ?? '',
      order: input.readVarInt(),
      skinRequired: input.readBoolean(),
      bones: readBoneList(input),
      target: input.readVarInt(),
      local: input.readBoolean(),
      relative: input.readBoolean(),
      offsetRotation: input.readFloat(),
      offsetX: input.readFloat(),
      offsetY: input.readFloat(),
      offsetScaleX: input.readFloat(),
      offsetScaleY: input.readFloat(),
      offsetShearY: input.readFloat(),
    }

    if (is38) {
      // 3.8:rotateMix, translateMix, scaleMix, shearMix
      const mixRotate = input.readFloat()
      const translateMix = input.readFloat()
      const scaleMix = input.readFloat()
      const shearMix = input.readFloat()
      out.push({
        ...head,
        mixRotate,
        mixX: translateMix, // 单值管两轴,升级到 4.x 复制即可,无损
        mixY: translateMix,
        mixScaleX: scaleMix,
        mixScaleY: scaleMix,
        mixShearY: shearMix,
      })
    } else {
      out.push({
        ...head,
        mixRotate: input.readFloat(),
        mixX: input.readFloat(),
        mixY: input.readFloat(),
        mixScaleX: input.readFloat(),
        mixScaleY: input.readFloat(),
        mixShearY: input.readFloat(),
      })
    }
  }
  return out
}

/**
 * 读到 transform 约束为止。后面(path 约束、皮肤、事件、动画)尚未实现。
 *
 * `expectedMajor` 用于覆盖版本推断 —— 两版格式无法自识别,
 * 万一 version 字符串靠不住可以强制指定。
 */
export function readSkeletonPart(bytes: Uint8Array, expectedMajor?: SpineMajor): SkeletonPart {
  const input = new SpineInput(bytes)

  // 3.8 的 hash 是长度前缀字符串,4.x 是 8 字节定长 —— 唯一的头部差异。
  // 无法自识别,所以先按 4.x 试读 8 字节 hash + version,失败就回退。
  let hash: string | null
  let version: string
  let major: SpineMajor

  if (expectedMajor === '3.8') {
    hash = input.readString()
    version = input.readString() ?? ''
    major = '3.8'
  } else if (expectedMajor === '4.x') {
    hash = input.readLongHex()
    version = input.readString() ?? ''
    major = '4.x'
  } else {
    // 自动判断:3.8 的第一个字节是字符串长度(哈希约 27 字符 → 0x1c)。
    // 4.x 第一个字节是哈希的高位字节,可能是任何值。
    // 可靠做法是两种都试,取能读出合法版本号的那个。
    const probe = new SpineInput(bytes)
    const asString = probe.readString()
    const v38 = probe.readString() ?? ''

    if (/^3\.\d/.test(v38)) {
      hash = asString
      version = v38
      major = '3.8'
      input.readString()
      input.readString()
    } else {
      hash = input.readLongHex()
      version = input.readString() ?? ''
      major = majorOf(version)
    }
  }

  const x = input.readFloat()
  const y = input.readFloat()
  const width = input.readFloat()
  const height = input.readFloat()
  const nonessential = input.readBoolean()

  let fps: number | null = null
  let imagesPath: string | null = null
  let audioPath: string | null = null
  if (nonessential) {
    fps = input.readFloat()
    imagesPath = input.readString()
    audioPath = input.readString()
  }

  // 字符串表 —— 后面的 stringRef 都索引它
  const stringCount = input.readVarInt()
  const strings: (string | null)[] = []
  for (let i = 0; i < stringCount; i++) strings.push(input.readString())
  input.strings = strings

  const is38 = major === '3.8'
  const bones = readBones(input, nonessential)
  const slots = readSlots(input)
  const ik = readIk(input)
  const transform = readTransform(input, is38)

  return {
    header: { hash, version, major, x, y, width, height, nonessential, fps, imagesPath, audioPath },
    strings,
    bones,
    slots,
    ik,
    transform,
    offsetAfterTransform: input.offset,
    totalBytes: bytes.length,
  }
}
