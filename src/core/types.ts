/**
 * 数据模型。对应 docs/FORMAT.md 第 2 节。
 *
 * 命名约定:`XxxData` 是**绑定姿势**,来自数据文件,不可变、可在多个实例间共享。
 * 不带 Data 后缀的(见 Skeleton.ts / Bone.ts)是**运行时实例**,持有当前姿势,每个角色一份。
 *
 * 这个区分不能省:同一个骨架数据可能同时驱动屏幕上的十个小兵。
 */

// ─── Bone ────────────────────────────────────────────────────────────────────

export interface BoneData {
  readonly name: string
  /** 父骨骼在 SkeletonData.bones 中的下标;根骨骼为 -1 */
  readonly parent: number
  readonly x: number
  readonly y: number
  /** 度,逆时针为正 */
  readonly rotation: number
  readonly scaleX: number
  readonly scaleY: number
  readonly shearX: number
  readonly shearY: number
  /** 仅用于编辑器显示骨骼长度,不参与变换计算 */
  readonly length: number
  /**
   * ⚠️ 尚未实现。非默认值目前会在 Skeleton 构造时抛错而不是被静默忽略。
   * 见 docs/FORMAT.md「缩放继承」。
   */
  readonly inheritRotation: boolean
  readonly inheritScale: boolean
}

// ─── Slot / Attachment ───────────────────────────────────────────────────────

/** RGBA,各分量 0..1,sRGB 非预乘 */
export interface Color {
  r: number
  g: number
  b: number
  a: number
}

export type BlendMode = 'normal' | 'additive' | 'multiply' | 'screen'

export interface SlotData {
  readonly name: string
  /** 所属骨骼在 SkeletonData.bones 中的下标 */
  readonly bone: number
  /** 绑定姿势下挂哪个 attachment;null 表示不显示 */
  readonly attachment: string | null
  readonly color: Color
  readonly blend: BlendMode
}

export interface RegionAttachment {
  readonly type: 'region'
  readonly name: string
  /** 图集中的区域名,缺省与 name 相同 */
  readonly path: string
  readonly x: number
  readonly y: number
  readonly rotation: number
  readonly scaleX: number
  readonly scaleY: number
  /** 原始尺寸(未裁剪透明边之前) */
  readonly width: number
  readonly height: number
}

// mesh / boundingbox 见 docs/FORMAT.md,实现顺序第 5 步再加
export type Attachment = RegionAttachment

/** 皮肤:slot 下标 → (attachment 名 → attachment) */
export type Skin = ReadonlyMap<number, ReadonlyMap<string, Attachment>>

// ─── SkeletonData ────────────────────────────────────────────────────────────

export interface SkeletonData {
  readonly name: string
  /** **必须按层级排序:父骨骼一定排在子骨骼之前。** 世界变换靠这个顺序单遍算完。 */
  readonly bones: readonly BoneData[]
  /** 数组顺序即默认绘制顺序,先画的在下层 */
  readonly slots: readonly SlotData[]
  readonly skins: ReadonlyMap<string, Skin>
  readonly defaultSkin: string
}

// ─── core 的输出 ─────────────────────────────────────────────────────────────

/**
 * `core/` 求值后交给 `render/` 的东西。
 *
 * ⚠️ 这里不允许出现任何渲染 API 类型(PixiJS / WebGL / 引擎类型)。
 * 见 CLAUDE.md「硬约束」。
 */
export interface RenderCommand {
  readonly slotName: string
  readonly attachmentName: string
  /** 图集区域名 */
  readonly path: string
  /** 四个角,世界空间,顺序 左下→右下→右上→左上,每点 2 个 float */
  readonly vertices: Float32Array
  readonly uvs: Float32Array
  readonly color: Color
  readonly blend: BlendMode
}
