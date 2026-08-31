import { SpineInput } from './input.ts'
import { readSkins, type Skin } from './readSkins.ts'
import { readAnimations, readEvents, type AnimationData, type EventDef } from './readAnimations.ts'

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
  readonly attachmentNameIndex: number
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

/**
 * Path 约束。与 transform 约束同样的拆分:3.8 的 `translateMix`
 * 在 4.x 拆成了 `mixX` / `mixY`。这里统一存 4.x 形式。
 */
export interface PathRecord {
  readonly name: string
  readonly order: number
  readonly skinRequired: boolean
  readonly bones: readonly number[]
  /** ⚠️ 指向 **slot** 下标,不是骨骼 */
  readonly target: number
  readonly positionMode: number
  readonly spacingMode: number
  readonly rotateMode: number
  readonly offsetRotation: number
  readonly position: number
  readonly spacing: number
  readonly mixRotate: number
  readonly mixX: number
  readonly mixY: number
}

export interface SkeletonPart {
  readonly header: SkeletonHeader
  readonly strings: readonly (string | null)[]
  readonly bones: readonly BoneRecord[]
  readonly slots: readonly SlotRecord[]
  readonly ik: readonly IkRecord[]
  readonly transform: readonly TransformRecord[]
  readonly path: readonly PathRecord[]
  readonly skins: readonly Skin[]
  readonly events: readonly EventDef[]
  readonly animations: readonly AnimationData[]
  /** 动画解析失败时的定位信息;null 表示全部读通 */
  readonly failure: {
    name: string
    index: number
    offset: number
    message: string
    trace: { section: string; offset: number }[]
  } | null
  /** 读完之后停在哪个字节。**应当正好等于 totalBytes** —— 不等就是布局有误 */
  readonly endOffset: number
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
    const name = input.readString() ?? ''
    const bone = input.readVarInt()
    const color = input.readInt()
    const darkColor = input.readInt()
    const attachment = input.readStringRefAt()
    slots.push({
      name,
      bone,
      color,
      darkColor,
      attachmentName: attachment.value,
      attachmentNameIndex: attachment.index,
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

function readPath(input: SpineInput, is38: boolean): PathRecord[] {
  const count = input.readVarInt()
  const out: PathRecord[] = []

  for (let i = 0; i < count; i++) {
    const head = {
      name: input.readString() ?? '',
      order: input.readVarInt(),
      skinRequired: input.readBoolean(),
      bones: readBoneList(input),
      target: input.readVarInt(), // slot 下标
      positionMode: input.readVarInt(),
      spacingMode: input.readVarInt(),
      rotateMode: input.readVarInt(),
      offsetRotation: input.readFloat(),
      position: input.readFloat(),
      spacing: input.readFloat(),
    }

    if (is38) {
      const mixRotate = input.readFloat()
      const translateMix = input.readFloat()
      out.push({ ...head, mixRotate, mixX: translateMix, mixY: translateMix })
    } else {
      out.push({
        ...head,
        mixRotate: input.readFloat(),
        mixX: input.readFloat(),
        mixY: input.readFloat(),
      })
    }
  }
  return out
}

/**
 * 读到约束部分为止。后面(path 约束、皮肤、事件、动画)尚未实现。
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
    // 自动判断:3.8 的开头是「长度前缀的哈希字符串」,4.x 是 8 字节定长哈希。
    // 两种都试,取能读出合法版本号的那个。
    //
    // ⚠️ **试读必须允许失败。** 4.x 的哈希是任意 8 字节,当成字符串长度读出来
    // 往往是个天文数字(实测 BBQ_grill 的头两字节 `eb 47` → 要 9194 字节,
    // 整个文件才 6568)。早先没有捕获,4.x 文件只要哈希首字节带高位就直接抛错。
    const probe = (as: SpineMajor): string | null => {
      try {
        const p = new SpineInput(bytes)
        if (as === '3.8') p.readString()
        else p.readLongHex()
        const v = p.readString() ?? ''
        return /^\d+\.\d+/.test(v) ? v : null
      } catch {
        return null
      }
    }

    // 3.8 布局要读出 3.x 的版本号才算数 —— 别的都当 4.x
    const v38 = probe('3.8')
    major = v38 !== null && v38.startsWith('3.') ? '3.8' : '4.x'

    if (major === '3.8') {
      hash = input.readString()
      version = input.readString() ?? ''
    } else {
      const v4x = probe('4.x')
      if (v4x === null) {
        throw new Error('认不出版本号 —— 两种头部布局都试过了,这大概不是 Spine 的 .skel 文件')
      }
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
  const path = readPath(input, is38)
  const skins = readSkins(input, is38, nonessential)
  const events = readEvents(input)
  const animationsResult = readAnimations(input, is38)

  return {
    header: { hash, version, major, x, y, width, height, nonessential, fps, imagesPath, audioPath },
    strings,
    bones,
    slots,
    ik,
    transform,
    path,
    skins,
    events,
    animations: animationsResult.animations,
    failure: animationsResult.failure,
    endOffset: input.offset,
    totalBytes: bytes.length,
  }
}
