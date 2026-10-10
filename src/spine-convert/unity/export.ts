import type { SkeletonPart } from '../../spine-format/binary/readSkeleton.ts'
import type { Attachment, Sequence, Skin } from '../../spine-format/binary/readSkins.ts'
import type { AnimationData, Timeline } from '../../spine-format/binary/readAnimations.ts'
import type { Atlas } from '../../core/atlas.ts'
import { IssueCollector, type ConversionIssue } from '../types.ts'
import {
  degreesToQuaternionZ,
  toUnityCurve,
  STEPPED_SLOPE,
  type SpineSegment,
  type UnityKeyframe,
} from '../../unity/curve.ts'
import { writeAnim, type FloatCurve, type Vector3Curve } from '../../unity/writeAnim.ts'
import {
  writePrefab,
  type AssetRef,
  type PrefabNode,
  type RenderPipeline,
  type RendererSpec,
  type SkinSpec,
  type SkinsComponentSpec,
} from '../../unity/writePrefab.ts'
import { writeController, CLIP_FILE_ID } from '../../unity/writeController.ts'
import { writeNativeMeta, writePrefabMeta, writeTextureMeta, type MetaBone, type MetaSprite, type MetaWeight } from '../../unity/writeMeta.ts'
import { unityGuid, internalId, uniqueIds } from '../../unity/ids.ts'
import { encodePng, type Image } from '../../unity/png.ts'
import { writeMesh, MESH_FILE_ID, type BlendShape, type BoneInfluence, type MeshVertex } from '../../unity/writeMesh.ts'
import { writeSpriteMaterial, BLEND_SHADER_FILES, MASKED_MESH_SHADER_FILE, MATERIAL_FILE_ID, TEXTURE_FILE_ID, type SpineBlend } from '../../unity/writeMaterial.ts'
import { attachmentVertices } from '../../spine-eval/vertices.ts'
import { clipDeformOf, clipGroups, clipOnSteps, clipPolygonAt, clipToggled, triangulatePolygon, type ClipGroup, type Point } from '../clipping.ts'
import { skinWeightsLabel, UNLIMITED_SKIN_WEIGHTS, type QualityLevel } from '../../unity/qualitySettings.ts'
import { toVertexColor, type ColorSpace } from '../../unity/colorSpace.ts'
import { bindSlots, compactSlots, truncateVertex, type BoundMesh, type PosePair } from '../skinSlots.ts'
import { toAbsoluteBezier } from '../../spine-format/bezier.ts'
import {
  applyPoint,
  applyVector,
  invert,
  multiply,
  poseAt,
  setupPose,
  valueBetween,
  IDENTITY,
  type Affine,
} from '../../spine-eval/pose.ts'
import { drawOrderOf, layerOfSlot, type DrawOrderOffset } from '../../spine-eval/drawOrder.ts'
import { bakeAtlas, type BakedRect } from './bakeAtlas.ts'
import { detectPremultiplied, unpremultiply } from './alpha.ts'
import { attachmentScale, bindMesh, estimateAtlasScale, uvToRect, type SpineVertices } from './mesh.ts'
import { resolveLinkedMeshes } from './linkedMesh.ts'
import { describeTimeline, DUPLICATE_TIMELINE_MESSAGE, lastPerProperty } from '../../spine-format/duplicateTimelines.ts'
import { sequenceCycle, sequenceFrameAt, sequenceRegionName, sequenceSteps, type SequenceKey } from '../../spine-eval/sequence.ts'

/**
 * Spine → Unity 2D Animation。
 *
 * 产出一整套可以**直接丢进 Assets 目录就能播**的资源:
 * 烘焙好的图集 PNG + `.meta`(含骨骼、网格、权重)、prefab、每条动画一个 `.anim`、
 * 一个 AnimatorController,外加各自的 `.meta`。
 *
 * ## 三个必须处理对的语义差
 *
 * 1. **Spine 的关键帧是「相对绑定姿势的偏移」,Unity 的是绝对值。**
 *    转换时要把绑定姿势加回去(scale 是乘不是加)。错了动画会**整体系统性偏移**。
 * 2. **单位**:Spine 用像素,Unity 的 Transform 用世界单位,要除 `pixelsPerUnit`。
 * 3. **网格顶点的位置和 UV 在 Unity 里是绑死的** —— sprite 的顶点坐标同时决定了
 *    它在图上取哪块像素。所以顶点只能由 Spine 的 UV 反算,再用 pivot 把整体挪到位。
 *    绑定姿势下网格若被改过形(顶点和图对不上),这个平移就不是常数,只能取均值并报近似。
 *
 * ## 两条网格路径
 *
 * 默认走 SpriteRenderer + SpriteSkin(Unity 2D Animation 的原生路径,可在 Sprite Editor 里编辑)。
 * **只有 SpriteSkin 表达不了的网格**改走 SkinnedMeshRenderer + Mesh 资产:
 *
 * - 有 deform 顶点动画 → Blend Shape(每个关键帧一个形变目标,权重由 Animator 驱动)
 * - 绑定姿势下就不是刚性的(SpriteSkin 的绑定只有旋转平移;Mesh 的绑定矩阵是任意仿射)
 * - 与其他加权网格的图集缩放不一致(sprite 的顶点和 UV 绑死;Mesh 的各自独立)
 *
 * 决策与排查见 docs/DECISIONS.md、docs/PROGRESS.md。
 *
 * ## 转不过去的东西(见 docs/UNITY-2D.md)
 *
 * - path / transform 约束、IK(也没有烘进曲线)
 * - 两色染色(dark color)
 *
 * 逐帧绘制顺序(drawOrder)→ 挪过位的 slot 每条动画一条 `m_SortingOrder` 阶梯曲线。
 * 皮肤 → 全部导进一个 prefab,Animator 皮肤层切。linkedmesh → 导出前展开成独立网格(linkedMesh.ts)。
 */

export interface UnityExportOptions {
  /** 资源基名,决定文件名和 prefab 根物体的名字 */
  readonly name: string
  /** Spine 像素 → Unity 世界单位的换算,Unity 导入图片时的默认值是 100 */
  readonly pixelsPerUnit: number
  /** 决定 SpriteRenderer 用哪个默认材质 —— 给错了整个角色是粉红的 */
  readonly renderPipeline: RenderPipeline
  /**
   * SkinnedMeshRenderer 每顶点用几根骨骼蒙皮。默认 `bone4`:渲染器写 4 根。`auto` 跟随 Quality ——
   * 只有所有档位都设成 Unlimited 时才划算(能吃满 >4 根)。⚠️ 两种都以工程 Quality 的 Skin Weights
   * 为上限(实测),Bone4 盖不过它 —— 见 `qualityLevels`。
   */
  readonly skinQuality?: 'bone4' | 'auto'
  /**
   * 目标工程 Quality 各档的 Skin Weights(`ProjectSettings/QualitySettings.asset`)。它是 SkinnedMeshRenderer
   * 蒙皮根数的上限,SpriteSkin 不受影响。给了就逐档查:有档位会截到走 SkinnedMeshRenderer 的网格时报 approximated。
   * 不给就不查(不知道产物进哪个工程)。
   */
  readonly qualityLevels?: readonly QualityLevel[]
  /**
   * 目标工程的色彩空间(`ProjectSettings/ProjectSettings.asset` 的 `m_ActiveColorSpace`),默认 `linear`。
   * 只影响走 SkinnedMeshRenderer 的网格:颜色烘进顶点色,而顶点色 Unity 不做 sRGB 换算(实测,见 colorSpace.ts),
   * 线性工程要先换成线性值。SpriteRenderer 的 `m_Color` 两种工程都原样写。
   */
  readonly colorSpace?: ColorSpace
  /**
   * 跳过图集 PNG 的编码。
   *
   * 只给试运行用:批量摸底几百个骨架时,PNG 编码占了绝大部分时间,
   * 而问题报告一条都不依赖它。**烘焙照做**(区域越界、缺图都在那一步暴露),
   * 只是不把像素压成 PNG。
   */
  readonly skipImages?: boolean
  /**
   * 初始皮肤(Animator 皮肤层的默认 state)。**所有皮肤都会导进同一个 prefab**,运行时用
   * `animator.Play("皮肤名", 1)` 切;不给时初始是默认皮肤(默认皮肤空着就取第一套具名皮肤)。
   */
  readonly skin?: string
  /**
   * 皮肤怎么切。`animator`(默认):零脚本,Animator 皮肤层,所有皮肤的 sprite 硬引用在 prefab 里,
   * 实例化即全部加载。`script`:根节点挂 `AnimatorGoSkins` 组件,换装件的 sprite / 材质是软引用
   * (资产路径 + GUID),切到哪套才加载哪套 —— 代价是产物依赖那一个脚本(`tools/unity/runtime/`)。
   */
  readonly skins?: 'animator' | 'script'
  /**
   * 产物在 Unity 工程里的文件夹(`Assets/AnimatorGo/blackrichwoman` 这种),带脚本模式写进软引用的
   * 资产路径里。不给就只写文件名,编辑器里靠 GUID 也找得到。
   */
  readonly assetFolder?: string
}

export interface UnityFile {
  /** 相对输出目录的路径 */
  readonly path: string
  readonly content: string | Uint8Array
}

export interface UnityExportResult {
  readonly files: readonly UnityFile[]
  readonly issues: readonly ConversionIssue[]
  /**
   * 产物用到的共用文件(`tools/unity/runtime/` 下的文件名,连同 `.meta`),要拷进工程的 `AnimatorGoRuntime/` 一次。
   * 现在是两个着色器:混合模式不是 normal 的 slot 用的(按管线二选一)、被遮罩遮住的 SkinnedMeshRenderer 用的
   */
  readonly runtime: readonly string[]
}

/** Spine 打包的 0xRRGGBBAA → 0..1 */
function unpackColor(packed: number): { r: number; g: number; b: number; a: number } {
  return {
    r: ((packed >>> 24) & 0xff) / 255,
    g: ((packed >>> 16) & 0xff) / 255,
    b: ((packed >>> 8) & 0xff) / 255,
    a: (packed & 0xff) / 255,
  }
}

/** `SlotRecord.blendMode` 的取值 → Unity 这边要自己的材质的那三种(normal 是 null,走默认 sprite 材质) */
const BLEND_OF_MODE: readonly (SpineBlend | null)[] = [null, 'additive', 'multiply', 'screen']

type Rgba = { r: number; g: number; b: number; a: number }

/**
 * attachment 自己的颜色(region / mesh / linkedmesh 都有,缺省白)。Spine 画的时候乘在 slot 颜色上;
 * Unity 没有这一层,只能乘进挂图节点自己的颜色 —— 一个 attachment 一个节点,同一 slot 下颜色不同的件也各自精确
 */
function attachmentColor(a: Attachment): Rgba {
  return unpackColor((a.data['color'] as number | undefined) ?? -1)
}

function multiplyColor(p: Rgba, q: Rgba): Rgba {
  return { r: p.r * q.r, g: p.g * q.g, b: p.b * q.b, a: p.a * q.a }
}

const isWhite = (c: Rgba) => c.r >= 1 && c.g >= 1 && c.b >= 1

/** 逐帧修正里,阶梯跳变前补的那个采样离跳变多远(秒) */
const STEP_EPSILON = 1e-4


function key(time: number, value: number, stepped: boolean): UnityKeyframe {
  return {
    time,
    value,
    inSlope: stepped ? STEPPED_SLOPE : 0,
    outSlope: stepped ? STEPPED_SLOPE : 0,
    inWeight: 0,
    outWeight: 0,
    weightedMode: 0,
  }
}

/** 某个分量整条时间轴都不变时用它填充 */
function constantKeys(times: readonly number[], value: number): UnityKeyframe[] {
  return times.map((time) => key(time, value, false))
}

/**
 * 取出各段的曲线定义,统一成**绝对时间/取值**的控制点。
 *
 * ⚠️ **3.8 的控制点是归一化的百分比,4.x 是绝对值** —— 见
 * [bezier.ts](../../spine-format/bezier.ts)。当成同一种处理,动画照播,
 * 但所有缓动都会变形。
 *
 * ⚠️ **控制点的 y 分量在 Spine 的原始值空间里**(平移是像素、缩放是倍率),
 * 而我们的 values 已经加过绑定姿势、换算过单位。两者必须用**同一个变换**,
 * 否则控制点和端点对不上,缓动会歪。
 *
 * `component` 选第几个分量的曲线:3.8 只有一条(共用),4.x 每分量各一条。
 */
function segmentsOf(
  frames: readonly Record<string, unknown>[],
  /** 该分量每帧的**原始**取值,3.8 的归一化控制点要靠它还原成绝对值 */
  rawValues: readonly number[],
  transformValue: (raw: number) => number,
  is38: boolean,
  component = 0,
): (SpineSegment | undefined)[] {
  return frames.map((f, i) => {
    if (i === frames.length - 1) return undefined
    const curve = f['curve']
    if (curve === 'stepped') return { curve: 'stepped' as const }
    if (curve === 'bezier') {
      const all = f['beziers'] as number[][]
      const raw = all[Math.min(component, all.length - 1)]!
      const b = is38
        ? toAbsoluteBezier(
            raw,
            f['time'] as number,
            rawValues[i] ?? 0,
            frames[i + 1]!['time'] as number,
            rawValues[i + 1] ?? 0,
          )
        : raw
      // 时间分量原样保留,值分量走同一个变换
      return {
        curve: 'bezier' as const,
        bezier: [b[0]!, transformValue(b[1]!), b[2]!, transformValue(b[3]!)],
      }
    }
    return { curve: 'linear' as const }
  })
}

/**
 * Spine 在**第一帧之前**用的是绑定姿势的值,Unity 的 ClampForever 用的是第一帧的值。
 *
 * 第一帧不在 0 时两者不一致 —— 在 0 处补一个绑定值、并让这一段走阶梯,
 * 就和 Spine 完全一致了。
 */
function withSetup(
  times: readonly number[],
  values: readonly number[],
  segments: readonly (SpineSegment | undefined)[],
  setup: number,
): { times: number[]; values: number[]; segments: (SpineSegment | undefined)[] } {
  if (times.length === 0 || times[0]! <= 0) {
    return { times: [...times], values: [...values], segments: [...segments] }
  }
  return {
    times: [0, ...times],
    values: [setup, ...values],
    segments: [{ curve: 'stepped' }, ...segments],
  }
}

// ─── attachment 的归类 ───────────────────────────────────────────────────────

interface SlotAttachment {
  readonly slot: number
  readonly skin: string
  /** 皮肤里的键名,attachment 时间轴按这个名字切换 */
  readonly key: string
  readonly attachment: Attachment
  /** 图集里的区域名 */
  readonly regionName: string
  /** 该 attachment 对应的 sprite 名 */
  readonly spriteName: string
  /**
   * 4.1 序列帧 attachment 的第几帧。序列帧每帧一个节点(和换图同一个思路:换物体而不是换 sprite),
   * 显示条件 =「attachment 亮着」且「当前是这一帧」,两者合成一条 m_Enabled 阶梯曲线
   */
  readonly frame?: { readonly index: number; readonly sequence: Sequence }
  /** prefab 里的节点下标 */
  node: number
}

/** deform 时间轴的外层记录(读取器把一条 deform 包成 frames[0]) */
interface DeformRecord {
  readonly skin: number | string
  readonly attachment: string
  readonly frames: readonly Record<string, unknown>[]
}

/** 走 SkinnedMeshRenderer 的网格:几何在骨架根空间(Unity 单位),形变目标随动画转换逐步累积 */
interface SkinnedGeometry {
  readonly item: SlotAttachment
  readonly page: number
  /**
   * 骨骼槽位,顺序即 m_Bones / bindposes 的顺序。**同一根骨骼可以出现多次**,各带一个 bindpose(Unity 单位)——
   * 绑完又改过顶点的网格,各影响的局部坐标对不齐,靠多开槽位原样表达(bindSkinned)
   */
  readonly slots: readonly { readonly bone: number; readonly bindpose: Affine }[]
  /** 网格空间(= 骨架根空间,Unity 单位)的顶点 */
  readonly vertices: MeshVertex[]
  readonly triangles: readonly number[]
  /** Spine 的完整权重,骨骼用槽位下标 —— 写进 Mesh */
  readonly weights: readonly (readonly BoneInfluence[])[]
  /** Unity 实际用来蒙皮的权重(Bone4 时是前 4 根归一),用槽位下标 —— 反解增量用 */
  readonly effective: readonly (readonly { slot: number; weight: number }[])[]
  /** 原始的逐影响局部坐标,算 Spine 那边的世界偏移用 */
  readonly localVerts: SpineVertices
  readonly slotBone: number
  readonly shapes: BlendShape[]
  readonly shapeNames: Set<string>
  nodeIndex: number
}

function regionNameOf(attachment: Attachment): string {
  const path = attachment.data['path']
  return typeof path === 'string' && path.length > 0 ? path : attachment.name
}

/** Unity 的资源名不能带路径分隔符 */
function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_')
}

/**
 * 铺满矩形的四顶点网格。
 *
 * region attachment 本来不需要自定义网格,但 **`.meta` 里任何一个 sprite 的
 * `vertices` / `indices` 为空,都会让它后面所有 sprite 的网格数据失效**
 * (实测:16 个 sprite 里空的那个排第 3,结果 1、2 正常,3 之后全被 Unity
 * 用 alpha 轮廓重新生成)。所以一律写满。
 *
 * 顶点在矩形局部像素空间,原点左下。2D sprite 默认不做背面剔除,绕序无所谓。
 */
const QUAD_TRIANGLES = [0, 1, 2, 2, 3, 0] as const

function rectQuad(width: number, height: number): { x: number; y: number }[] {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ]
}

/** 每顶点最多 4 根骨骼 —— 取权重最大的四根,重新归一化 */
function topFour(
  influences: readonly { bone: number; weight: number }[],
  indexOf: (bone: number) => number,
): { weight: MetaWeight; dropped: boolean } {
  const sorted = [...influences].sort((a, b) => b.weight - a.weight)
  const dropped = sorted.length > 4
  const kept = sorted.slice(0, 4)
  const sum = kept.reduce((n, w) => n + w.weight, 0) || 1

  const weights: number[] = [0, 0, 0, 0]
  const bones: number[] = [0, 0, 0, 0]
  kept.forEach((w, i) => {
    weights[i] = w.weight / sum
    bones[i] = indexOf(w.bone)
  })

  return {
    weight: {
      weights: weights as unknown as readonly [number, number, number, number],
      bones: bones as unknown as readonly [number, number, number, number],
    },
    dropped,
  }
}

/**
 * 网格用到的骨骼,保持骨架顺序。
 *
 * ⚠️ **不带祖先。** Unity 的 `.meta` 骨骼表只用来算绑定姿势,`parentId` 全填 -1
 * 就是「每根骨骼各自记世界变换」—— 而我们的绑定姿势本来就是逐骨骼独立解出来的,
 * 没有层级可言。硬凑一棵树反而要给没参与蒙皮的祖先编一个姿势出来。
 * `SpriteSkin` 只校验数量对得上、引用非空(见包里的 `SpriteSkinUtility.Validate`),
 * 不要求层级。
 */
function boneSubset(influences: readonly (readonly { bone: number }[])[]): number[] {
  const need = new Set<number>()
  for (const entry of influences) for (const w of entry) need.add(w.bone)
  return [...need].sort((a, b) => a - b)
}

// ─── 导出 ────────────────────────────────────────────────────────────────────

export function exportToUnity(
  input: SkeletonPart,
  atlas: Atlas,
  sources: ReadonlyMap<string, Image>,
  options: UnityExportOptions,
): UnityExportResult {
  const issues = new IssueCollector()
  // linkedmesh 先展开成普通 mesh,下游全部按 mesh 处理;继承关系只有 deform 要用
  const { part, timelineParents } = resolveLinkedMeshes(input, issues)
  const scale = 1 / options.pixelsPerUnit
  const name = sanitize(options.name)
  // 3.8 的贝塞尔控制点是归一化的,4.x 是绝对的 —— segmentsOf 要靠这个区分
  const is38 = part.header.major === '3.8'

  // ── 姿势:SkinnedMeshRenderer 的绑定矩阵、deform 反解都要 ──
  // Spine 的真实 setup(含 shear、继承模式)决定顶点摆在哪;Unity 那份(纯 TRS 层级)决定
  // 绑定矩阵,因为 prefab 里的骨骼节点就是那么摆的。两者在 shear = 0 时相同。
  const setupSpine = setupPose(part)
  const setupUnity = setupPose(part, { unityCompatible: true })
  const toUnits = (m: Affine): Affine => ({ a: m.a, b: m.b, c: m.c, d: m.d, x: m.x * scale, y: m.y * scale })
  const linear = (m: Affine): Affine => ({ a: m.a, b: m.b, c: m.c, d: m.d, x: 0, y: 0 })
  const skinQuality: 0 | 4 = options.skinQuality === 'auto' ? 0 : 4
  const colorSpace: ColorSpace = options.colorSpace ?? 'linear'
  /** 带颜色(rgb 不是白)的 SkinnedMeshRenderer 网格 —— 顶点色要按工程色彩空间换算,汇总后报一次 */
  const tintedMeshes: string[] = []

  const skinNameOf = (skin: number | string): string =>
    typeof skin === 'number' ? (part.skins[skin]?.name ?? String(skin)) : skin
  /** deform 指向的 attachment 是什么类型 —— path / clipping 也能有 deform,但它们不参与渲染 */
  const attachmentTypeOf = (skinName: string, slot: number, key: string): string | null => {
    const skin = part.skins.find((s) => s.name === skinName)
    const entry = skin?.slots.find((s) => s.slot === slot)
    return entry?.attachments.find((a) => a.key === key || a.name === key)?.type ?? null
  }
  /** 有 deform 时间轴的 attachment:`皮肤/slot/键名` */
  const deformTargets = new Set<string>()
  for (const anim of part.animations) {
    for (const t of anim.timelines) {
      if (t.kind !== 'deform') continue
      const d = t.frames[0] as unknown as DeformRecord
      deformTargets.add(`${skinNameOf(d.skin)}/${t.owner}/${d.attachment}`)
    }
  }

  /**
   * 能驱动这个挂图节点的 deform 时间轴目标(`皮肤/slot/键名`)。
   * 一条时间轴可以驱动多个网格:展开后的 linkedmesh 继承父网格的时间轴。
   */
  const deformKeysOf = (item: SlotAttachment): string[] => {
    const keys = [`${item.skin}/${item.slot}/${item.key}`, `${item.skin}/${item.slot}/${item.attachment.name}`]
    const parent = timelineParents.get(item.attachment)
    if (parent !== undefined) keys.push(`${parent.skin}/${item.slot}/${parent.key}`)
    return keys
  }

  const skinned: SkinnedGeometry[] = []
  const skinnedByItem = new Map<SlotAttachment, SkinnedGeometry>()
  const skinnedByKey = new Map<string, SkinnedGeometry[]>()
  const meshGuidOf = (spriteName: string) => unityGuid(`${name}/mesh/${spriteName}`)

  for (const bone of part.bones) {
    if (bone.transformMode !== 0) {
      issues.add(
        'approximated',
        `bone.${bone.name}`,
        `Spine 的 transformMode=${bone.transformMode}(非默认继承)在 Unity 的 Transform 里没有对应物,已按普通继承处理`,
      )
    }
  }
  // Unity 的 Transform 只有 TRS,没有 shear —— 之前一声不响地丢了(BBQ_grill 的 smoke3 / smoke4 带 17.8° / −9.5°,
  // 烟雾整块歪 5 像素)。setup 带 shear 或动画里有 shear 时间轴的骨骼都报出来
  const shearAnimated = new Set<number>()
  for (const anim of part.animations) for (const t of anim.timelines) if (t.kind.startsWith('shear')) shearAnimated.add(t.owner)
  part.bones.forEach((bone, i) => {
    if (bone.shearX === 0 && bone.shearY === 0 && !shearAnimated.has(i)) return
    issues.add(
      'approximated',
      `bone.${bone.name}`,
      `Unity 的 Transform 没有 shear${bone.shearX !== 0 || bone.shearY !== 0 ? `(setup 是 ${bone.shearX.toFixed(1)}° / ${bone.shearY.toFixed(1)}°)` : ''}${shearAnimated.has(i) ? ',动画里的 shear 也没转' : ''},已忽略 —— 挂在它下面的部件会歪`,
    )
  })

  // ── 皮肤:全部导进一个 prefab,运行时靠 Animator 的皮肤层切 ──
  //
  // Spine 的皮肤是运行时查表(键名 → 当前皮肤 → 默认皮肤),Unity 没有这张表。
  // 一个挂图节点要同时满足两个条件才该显示:换图时间轴说这个键名亮着、且它属于当前皮肤。
  // 两个条件放在两个互相独立的开关上(渲染器 m_Enabled / GameObject m_IsActive),
  // 各由 Animator 的一层驱动;皮肤层每套皮肤一个 state,切皮肤 = animator.Play("皮肤名", 1)。
  // 方案在 tools/unity/AnimatorGoProbeSkin.cs 里验过。
  const isRenderable = (a: Attachment) => a.type === 'region' || a.type === 'mesh'
  const renderCount = (s: Skin) => s.slots.reduce((n, e) => n + e.attachments.filter(isRenderable).length, 0)
  const defaultSkin = part.skins.find((s) => s.name === 'default') ?? part.skins[0]
  const namedSkins = part.skins.filter((s) => s !== defaultSkin && renderCount(s) > 0)
  let initialSkin: Skin | undefined = defaultSkin
  if (options.skin !== undefined) {
    const found = part.skins.find((s) => s.name === options.skin)
    if (found === undefined) {
      throw new Error(`骨架里没有皮肤 "${options.skin}",有:${part.skins.map((s) => s.name).join('、')}`)
    }
    initialSkin = found
  } else if (defaultSkin !== undefined && renderCount(defaultSkin) === 0 && namedSkins.length > 0) {
    // 不少骨架把所有东西都放在具名皮肤里,默认皮肤是空的 —— 初始就选默认会是一个空角色
    initialSkin = namedSkins[0]!
    issues.add('info', 'skin', `默认皮肤没有可渲染的 attachment,初始皮肤取 "${initialSkin.name}"(用 --skin 指定别的)`)
  }
  /** 皮肤层的 state:默认皮肤 + 每套有东西的具名皮肤;只有一套皮肤就不需要这一层 */
  const skinStates: Skin[] = namedSkins.length > 0 ? [defaultSkin, ...namedSkins].filter((s): s is Skin => s !== undefined) : []
  /** 带脚本模式:皮肤由 AnimatorGoSkins 组件管,换装件软引用、按需加载 */
  const scriptMode = options.skins === 'script' && skinStates.length > 0
  if (skinStates.length > 0) {
    issues.add(
      'info',
      'skin',
      `${skinStates.length} 套皮肤全部导进一个 prefab(${skinStates.map((s) => `"${s.name}"`).join('、')}),初始 "${initialSkin?.name}";` +
        (scriptMode
          ? '带脚本模式:GetComponent<AnimatorGoSkins>().SetSkin("皮肤名"),换装件切到时才加载(要接 AnimatorGoSkins.LoadAsset)'
          : '运行时切换:animator.Play("皮肤名", 1)'),
    )
  }
  const isDefaultSkin = (skinName: string) => skinName === defaultSkin?.name
  /** 皮肤 `skin` 生效时这个挂图节点该不该亮 —— 皮肤那一维,不含换图时间轴 */
  const visibleUnderSkin = (item: SlotAttachment, skin: Skin | undefined): boolean => {
    if (skin === undefined) return isDefaultSkin(item.skin)
    if (item.skin === skin.name) return true
    if (!isDefaultSkin(item.skin)) return false
    // 默认皮肤的件,被具名皮肤里同 slot 同键名的那件盖住(Spine 先查皮肤再查默认)
    return !skin.slots.some((e) => e.slot === item.slot && e.attachments.some((a) => a.key === item.key && isRenderable(a)))
  }
  /**
   * 挂图节点名:slot 名(键名与 slot 同名)或 slot__键名;序列帧再带 #帧号(与图集区域的编号一致);
   * 具名皮肤的再带 @皮肤名,免得和别的皮肤同键名的撞
   */
  const attachmentNodeName = (item: SlotAttachment, slotName: string): string => {
    let base = item.key === slotName ? slotName : `${slotName}__${item.key}`
    if (item.frame !== undefined) base += `#${sequenceRegionName('', item.frame.sequence, item.frame.index)}`
    return sanitize(isDefaultSkin(item.skin) ? base : `${base}@${item.skin}`)
  }
  /** 序列帧里 setup 显示的那一帧 */
  const setupFrameOf = (seq: Sequence) => sequenceFrameAt(undefined, seq, 0)
  /** setup pose 下这个挂图节点的渲染器亮不亮(换图那一维 + 序列帧那一维) */
  const enabledAtSetup = (item: SlotAttachment): boolean =>
    item.key === part.slots[item.slot]!.attachmentName && (item.frame === undefined || item.frame.index === setupFrameOf(item.frame.sequence))

  // ── 1. 收集 attachment ──
  const used: SlotAttachment[] = []
  const spriteNames = new Set<string>()

  for (const skin of part.skins) {
    for (const entry of skin.slots) {
      for (const attachment of entry.attachments) {
        if (attachment.type === 'region' || attachment.type === 'mesh') {
          // 4.1 序列帧:每帧一张图(path + 帧号),各出一个节点。几何相同,只有取的图不同
          const seq = attachment.sequence
          const frames = seq === null || seq.count <= 0 ? [undefined] : Array.from({ length: seq.count }, (_, index) => ({ index, sequence: seq }))
          for (const frame of frames) {
            const regionName = frame === undefined ? regionNameOf(attachment) : sequenceRegionName(regionNameOf(attachment), frame.sequence, frame.index)
            // region 的几何完全由图集决定,同名的可以共用一个 sprite;
            // mesh 各有各的顶点和 pivot,必须一图一份(序列帧的 mesh 按帧的图命名)
            const meshBase = sanitize(frame === undefined ? attachment.name : regionName)
            let spriteName = attachment.type === 'region' ? sanitize(regionName) : meshBase
            if (attachment.type === 'mesh') {
              let salt = 1
              while (spriteNames.has(spriteName)) spriteName = `${meshBase}_${++salt}`
            }
            spriteNames.add(spriteName)
            used.push({
              slot: entry.slot,
              skin: skin.name,
              key: attachment.key,
              attachment,
              regionName,
              spriteName,
              ...(frame === undefined ? {} : { frame }),
              node: -1,
            })
          }
          if (seq !== null && seq.count > 0) {
            issues.add('info', `attachment.${attachment.key}`, `序列帧 ${seq.count} 帧,每帧一个节点,按 sequence 时间轴互斥地亮`)
          }
        } else if (attachment.type === 'linkedmesh') {
          // 能展开的都已变成 mesh;剩下的是父网格找不到的,resolveLinkedMeshes 已报过 loss
        } else if (attachment.type === 'clipping') {
          // 遮罩在 prefab 节点之前统一处理(clipGroups)
        } else if (attachment.type === 'path' || attachment.type === 'boundingbox' || attachment.type === 'point') {
          issues.add('info', `attachment.${attachment.key}`, `${attachment.type} 不参与渲染,已跳过`)
        }
      }
    }
  }
  // slot 的混合模式:Unity 的默认 sprite 材质只有 normal(直通 alpha 混合)。之前一声不响地全按 normal 画 ——
  // additive 的光效变成不透明的一块,multiply 的影子变成盖上去的一层。现在这些 slot 挂自带着色器的材质,
  // 混合因子取 Spine 自己的(writeMaterial.ts 的 BLEND_FACTORS);建完节点按 slot 报一条 info(blendShaders)
  const blendOfSlot = (slot: number): SpineBlend | null => BLEND_OF_MODE[part.slots[slot]!.blendMode] ?? null
  part.slots.forEach((slot, i) => {
    if (slot.blendMode !== 0 && blendOfSlot(i) === null && used.some((u) => u.slot === i)) {
      issues.loss(`slot.${slot.name}`, `不认识的混合模式 ${slot.blendMode},按 normal 画`)
    }
  })
  /** 混合模式不是 normal 的 slot → 它的渲染器用到的着色器(tools/unity/runtime/ 的文件名) */
  const blendShaders = new Map<number, Set<string>>()
  const useBlendShader = (slot: number, file: string) => blendShaders.set(slot, (blendShaders.get(slot) ?? new Set()).add(file))

  // ── 2. 烘焙图集 ──
  // Spine 导给 spine-unity 的图集默认是预乘 alpha,Unity 的 sprite 材质按直通 alpha 混合 ——
  // 不还原的话半透明部件发黑(blackrichwoman 的 face4 红晕变成脸上一块深色叠加物)。见 alpha.ts
  const straightSources = new Map<string, Image>()
  for (const [pageName, image] of sources) {
    const declared = atlas.pages.find((p) => p.name === pageName)?.pma === true
    if (declared || detectPremultiplied(image)) {
      straightSources.set(pageName, unpremultiply(image))
      issues.add(
        'info',
        `atlas.${pageName}`,
        `图集页是预乘 alpha(${declared ? '.atlas 里声明了 pma' : '按像素判断'}),Unity 的 sprite 材质要直通 alpha,已在烘焙时还原`,
      )
    } else {
      straightSources.set(pageName, image)
    }
  }
  // ── 按皮肤分组烘焙:默认皮肤一组(<骨架>.png),每套具名皮肤各一组(<骨架>@skin@<皮肤>.png)──
  // 学 Spine「每皮肤一页」的打包方式:换装件的图不混进本体的图里,好归档、好按皮肤打包。
  // 两套具名皮肤共用的图归默认组 —— 默认组反正总在。
  // ⚠️ 这不会让运行时少加载贴图:prefab 里所有皮肤的节点都硬引用着自己的 sprite,
  // 实例化时 Unity 会把每张贴图都加载进来。要按需加载得走 Addressables 之类的软引用,那是游戏侧的事。
  const groupOf = new Map<string, string>()
  for (const u of used) {
    const group = isDefaultSkin(u.skin) ? '' : u.skin
    const prev = groupOf.get(u.regionName)
    if (prev === undefined) groupOf.set(u.regionName, group)
    else if (prev !== group) groupOf.set(u.regionName, '')
  }
  const groups: { skin: string; names: string[] }[] = [{ skin: '', names: [] }, ...namedSkins.map((s) => ({ skin: s.name, names: [] as string[] }))]
  for (const [regionName, group] of groupOf) (groups.find((g) => g.skin === group) ?? groups[0]!).names.push(regionName)

  const pages: Image[] = []
  /** 页下标 → 文件名(不含扩展名) */
  const pageNames: string[] = []
  const rects = new Map<string, BakedRect>()
  const missingRegions: string[] = []
  for (const group of groups) {
    if (group.names.length === 0) continue
    const part1 = bakeAtlas(atlas, straightSources, group.names)
    const offset = pages.length
    const base = group.skin === '' ? name : sanitize(`${name}@skin@${group.skin}`)
    part1.pages.forEach((page, i) => {
      pages.push(page)
      pageNames.push(part1.pages.length === 1 ? base : `${base}_${i}`)
    })
    for (const [regionName, rect] of part1.rects) rects.set(regionName, { ...rect, page: rect.page + offset })
    missingRegions.push(...part1.missing)
    if (part1.pages.length > 1) {
      issues.add(
        'info',
        'atlas',
        `${group.skin === '' ? '默认皮肤' : `皮肤 "${group.skin}"`}的图烘焙后有 ${part1.pages.length} 页 —— ` +
          '一个 SpriteRenderer 只能引用一张图,跨页的部件会分批渲染',
      )
    }
  }
  const baked = { pages, rects, missing: missingRegions }
  for (const missing of baked.missing) {
    issues.loss(`region.${missing}`, `图集里没有 "${missing}",用到它的部件不会显示`)
  }

  const textureGuids = baked.pages.map((_, i) => unityGuid(`${name}/texture/${pageNames[i]}`))
  const materialGuids = baked.pages.map((_, i) => unityGuid(`${name}/material/${pageNames[i]}`))

  // ── 图集缩放 ──
  // Spine 导出图集时可以带缩放,`.atlas` 里没记,只能从数据反推。
  // 它不改任何坐标,只决定纹理的 spritePixelsToUnits。
  const scaleSamples = used.flatMap((u) => {
    // 序列帧只拿 setup 帧当样本 —— 各帧原图尺寸可以不同,Spine 会把每帧拉到 attachment 的宽高
    if (u.frame !== undefined && u.frame.index !== setupFrameOf(u.frame.sequence)) return []
    const rect = baked.rects.get(u.regionName)
    return rect === undefined ? [] : [{ attachment: u.attachment, region: rect.region }]
  })
  const atlasScale = estimateAtlasScale(scaleSamples)
  if (atlasScale.spread > 0.02) {
    issues.add(
      'approximated',
      'atlas',
      `各部件反推出的图集缩放不一致(中位 ${atlasScale.scale.toFixed(3)},最大偏差 ` +
        `${(atlasScale.spread * 100).toFixed(1)}%)—— 按中位数取值,个别部件可能偏大或偏小`,
    )
  } else if (Math.abs(atlasScale.scale - 1) > 0.01) {
    issues.add(
      'info',
      'atlas',
      `图集是按 1/${atlasScale.scale.toFixed(3)} 缩放导出的,纹理的 pixelsPerUnit ` +
        `取 ${(options.pixelsPerUnit / atlasScale.scale).toFixed(2)} 来抵消(不重采样图片)`,
    )
  }
  const k = atlasScale.scale
  const texturePpu = options.pixelsPerUnit / k

  // ── 3. sprite 条目 ──
  const boneGuids = new Map<string, string>()
  part.bones.forEach((b, i) => boneGuids.set(b.name, unityGuid(`${name}/bone/${i}/${b.name}`)))

  const spriteIds = uniqueIds(
    used.map((u) => u.spriteName),
    (seed) => internalId(`${name}/sprite/${seed}`),
  )

  interface SpriteInfo {
    readonly page: number
    readonly internalID: number
    /** 加权网格才有,记录 SpriteSkin 要引用的骨骼(骨架下标) */
    readonly skinBones: readonly number[] | null
    /**
     * 未加权网格才有:骨骼局部 → sprite 空间的相似变换。
     * 节点要把它反过来 —— 旋转取负、缩放取倒数(见下面 nodeScale 的推导)。
     */
    readonly rigid: { rotation: number; scale: number } | null
    /** 刚性网格挂到哪根骨骼上(骨架下标) */
    readonly rigidBone: number | null
    /** 走 SkinnedMeshRenderer —— 没有 sprite 条目,几何在 skinnedByItem 里 */
    readonly skinned: boolean
  }
  const sprites = new Map<string, SpriteInfo>()

  /** 一条动画要采样的时刻:0、所有关键帧(含 deform 的)、30 fps 帧格 */
  const sampleTimesOf = (anim: AnimationData): number[] => {
    const times = new Set<number>([0])
    let end = 0
    for (const t of anim.timelines) {
      const frames = t.kind === 'deform' || t.kind === 'sequence' ? (t.frames[0] as unknown as { frames: Record<string, unknown>[] }).frames : t.frames
      for (const f of frames) {
        const time = Number(f['time'] ?? 0)
        times.add(time)
        end = Math.max(end, time)
      }
    }
    for (let i = 1; i / 30 < end; i++) times.add(i / 30)
    return [...times].sort((a, b) => a - b)
  }

  /** 全部动画的采样姿势(含 setup):Spine 的真实姿势(目标)和 Unity 的 TRS 层级姿势(实际)成对 —— 截断拟合用 */
  let posePairs: PosePair[] | null = null
  const allPoses = () => {
    if (posePairs !== null) return posePairs
    posePairs = [{ target: setupSpine, engine: setupUnity }]
    for (const anim of part.animations) {
      for (const t of sampleTimesOf(anim)) posePairs.push({ target: poseAt(part, anim, t), engine: poseAt(part, anim, t, { unityCompatible: true }) })
    }
    return posePairs
  }

  /** 把一个网格整理成 SkinnedMeshRenderer 要的几何(骨架根空间,Unity 单位) */
  const buildSkinnedGeometry = (item: SlotAttachment, rect: BakedRect, slotBone: number, reasons: string[]): SkinnedGeometry => {
    const data = item.attachment.data
    const verts = data['vertices'] as SpineVertices
    const vertexCount = data['vertexCount'] as number
    const uvs = data['uvs'] as number[]
    const triangles = data['triangles'] as number[]
    const page = baked.pages[rect.page]!
    // SkinnedMeshRenderer 没有 m_Color:静态颜色(slot × attachment)烘进顶点色,线性工程要换成线性值
    const tint = multiplyColor(unpackColor(part.slots[item.slot]!.color), attachmentColor(item.attachment))
    if (!isWhite(tint)) tintedMeshes.push(item.spriteName)
    const color = toVertexColor(tint, colorSpace)
    const subset = verts.weighted ? boneSubset(verts.weights) : [slotBone]

    // UV:Spine 的 uv 相对未裁剪原图 → 裁剪矩形内像素 → 烘焙页上的像素 → 归一化
    const uv = Array.from({ length: vertexCount }, (_, j) => {
      const r = uvToRect(uvs[j * 2]!, uvs[j * 2 + 1]!, rect.region)
      return { u: (rect.x + r.x) / page.width, v: (rect.y + r.y) / page.height }
    })
    const setupMean = Array.from({ length: vertexCount }, (_, j) => {
      if (!verts.weighted) return applyPoint(setupSpine[slotBone]!, verts.positions[j * 2]!, verts.positions[j * 2 + 1]!)
      let x = 0
      let y = 0
      for (const w of verts.weights[j]!) {
        const p = applyPoint(setupSpine[w.bone]!, w.x, w.y)
        x += w.weight * p.x
        y += w.weight * p.y
      }
      return { x, y }
    })

    // 绑定:同一根骨骼可以占多个槽位,每个影响原样表达(skinSlots.ts)
    const bound: BoundMesh = verts.weighted
      ? bindSlots(verts.weights, subset, { engine: (b) => setupUnity[b]!, target: (b) => setupSpine[b]! }, uv.map((t) => ({ x: t.u * page.width, y: t.v * page.height })))
      : { v: setupMean, slots: [{ bone: slotBone, bind: setupUnity[slotBone]!, offset: { x: 0, y: 0 } }], slotOf: [], base: () => setupUnity[slotBone]!, fitted: false, spread: 0, baseCount: 1, bindCount: 1 }

    const vertices: MeshVertex[] = []
    const weights: BoneInfluence[][] = []
    const effective: { slot: number; weight: number }[][] = []
    let over4 = false
    /** 截断拟合后,全部动画姿势上与 Spine 的最大差(像素) */
    let truncated = 0
    for (let j = 0; j < vertexCount; j++) {
      if (verts.weighted) {
        const list = verts.weights[j]!.map((w, i) => ({ slot: bound.slotOf[j]![i]!, weight: w.weight }))
        const sorted = list.filter((w) => w.weight > 0).sort((p, q) => q.weight - p.weight)
        over4 ||= sorted.length > 4
        if (skinQuality === 4 && sorted.length > 4) {
          // Bone4 只用 4 根:挑留哪 4 根、按全部动画的姿势重新拟合它们的局部坐标和权重(skinSlots.ts)。
          // Mesh 里也只写这 4 根 —— 完整权重用不上,写了反而和拟合过的坐标、权重对不上
          const fit = truncateVertex(bound, j, verts.weights[j]!, allPoses())!
          truncated = Math.max(truncated, fit.error)
          weights.push(fit.slots.map((slot, q) => ({ bone: slot, weight: fit.weights[q]! })))
          effective.push(fit.slots.map((slot, q) => ({ slot, weight: fit.weights[q]! })))
          continue
        }
        weights.push(list.map((w) => ({ bone: w.slot, weight: w.weight })))
        const total = sorted.reduce((n, w) => n + w.weight, 0) || 1
        effective.push(sorted.map((w) => ({ slot: w.slot, weight: w.weight / total })))
      } else {
        weights.push([{ bone: 0, weight: 1 }])
        effective.push([{ slot: 0, weight: 1 }])
      }
    }
    for (let j = 0; j < vertexCount; j++) {
      vertices.push({ x: bound.v[j]!.x * scale, y: bound.v[j]!.y * scale, u: uv[j]!.u, v: uv[j]!.v, color })
    }

    // 截断拟合会让一些槽位没人用了 —— 压掉,m_Bones 里不留空槽
    const { slots: compact, renumber, extra } = compactSlots(bound, weights.flatMap((ws) => ws.map((w) => w.bone)))
    for (const ws of weights) ws.forEach((w, k) => (ws[k] = { bone: renumber.get(w.bone)!, weight: w.weight }))
    for (const es of effective) es.forEach((w, k) => (es[k] = { slot: renumber.get(w.slot)!, weight: w.weight }))

    if (verts.weighted) {
      if (extra > 0) {
        issues.add(
          'info',
          `mesh.${item.spriteName}`,
          `绑定姿势各顶点不一致(各影响的位置最多差 ${bound.spread.toFixed(1)} 像素,绑完又改过顶点):` +
            `另配了 ${extra} 个绑定矩阵(同一根骨骼在 m_Bones 里重复出现)${bound.fitted ? ',基准按贴图拟合' : ''},各影响与 Spine 逐个一致`,
        )
      } else if (bound.fitted) {
        issues.add('info', `mesh.${item.spriteName}`, `绑定姿势不是 setup 姿势(各影响的位置最多差 ${bound.spread.toFixed(1)} 像素),按贴图拟合每根骨骼的绑定矩阵`)
      }
    }

    if (over4) {
      if (skinQuality === 4) {
        issues.add(
          truncated > 0.5 ? 'approximated' : 'info',
          `mesh.${item.spriteName}`,
          `每顶点超过 4 根骨骼,SkinnedMeshRenderer 写 Bone4:按全部动画的姿势挑留哪四根、重新拟合它们的局部坐标和权重,` +
            `与 Spine 最多差 ${truncated.toFixed(1)} 像素(工程 Quality 全部档位设 Unlimited 并加 --skin-quality auto 可用满)`,
        )
      } else {
        issues.add(
          'info',
          `mesh.${item.spriteName}`,
          '每顶点超过 4 根骨骼,完整权重已写入 Mesh;只有工程 Quality **所有**档位都是 Unlimited 时才会全部生效',
        )
      }
    }

    const singular = new Set<number>()
    const slots = compact.map((s) => {
      const inv = invert(toUnits(s.bind))
      if (inv === null) {
        if (!singular.has(s.bone)) {
          singular.add(s.bone)
          issues.loss(`mesh.${item.spriteName}`, `骨骼 "${part.bones[s.bone]!.name}" 在绑定姿势下缩放为 0,绑定矩阵不可逆,该骨骼按单位矩阵处理`)
        }
        return { bone: s.bone, bindpose: IDENTITY }
      }
      return { bone: s.bone, bindpose: inv }
    })
    issues.add('info', `mesh.${item.spriteName}`, `走 SkinnedMeshRenderer:${reasons.join('、')}`)

    return {
      item,
      page: rect.page,
      slots,
      vertices,
      triangles: [...triangles],
      weights,
      effective,
      localVerts: verts,
      slotBone,
      shapes: [],
      shapeNames: new Set(),
      nodeIndex: -1,
    }
  }
  const metaSprites: MetaSprite[][] = baked.pages.map(() => [])

  const seenSprite = new Set<string>()

  for (const item of used) {
    if (seenSprite.has(item.spriteName)) continue
    const rect = baked.rects.get(item.regionName)
    if (rect === undefined) continue
    seenSprite.add(item.spriteName)

    const region = rect.region
    const internal = spriteIds.get(item.spriteName)!
    const spriteID = unityGuid(`${name}/spriteid/${item.spriteName}`)

    if (item.attachment.type === 'region') {
      // 未裁剪原图的中心要落在节点原点上 —— pivot 就是中心在裁剪矩形里的归一化位置
      sprites.set(item.spriteName, {
        page: rect.page,
        internalID: internal,
        skinBones: null,
        rigid: null,
        rigidBone: null,
        skinned: false,
      })
      metaSprites[rect.page]!.push({
        name: item.spriteName,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        pivot: {
          x: (region.originalWidth / 2 - region.offsetX) / region.width,
          y: (region.originalHeight / 2 - region.offsetY) / region.height,
        },
        spriteID,
        internalID: internal,
        // ⚠️ **每个 sprite 都要显式给网格,一个都不能空。** 见 writeMeta.ts 的说明:
        // 空的 vertices / indices 会把它**后面**所有 sprite 的网格数据一起带塌。
        // 顺带好处是 Unity 的 alpha 轮廓生成完全不参与,产物是确定的。
        vertices: rectQuad(rect.width, rect.height),
        triangles: [...QUAD_TRIANGLES],
        bones: [],
        weights: [],
      })
      continue
    }

    // ── 网格 ──
    const slotBone = part.slots[item.slot]!.bone
    const mesh = bindMesh(item.attachment, region, slotBone, k)
    const extent = Math.max(rect.width, rect.height, 1)

    // 走 SkinnedMeshRenderer 的三个理由 —— 都是 SpriteSkin 结构上表达不了的,
    // 其余网格一律留在 SpriteSkin 路径,已验证的效果不动
    const reasons: string[] = []
    if (deformKeysOf(item).some((k) => deformTargets.has(k))) {
      reasons.push(timelineParents.has(item.attachment) ? '有 deform 顶点动画(继承自父网格)' : '有 deform 顶点动画')
    }
    // 残差按 sprite 跨度的相对值判 —— 500 像素的大图差 2 像素看不出来,
    // 40 像素的小图差 2 像素就很明显
    if (mesh.residual > Math.max(1, extent * 0.02)) {
      reasons.push(`绑定姿势非刚性(残差 ${mesh.residual.toFixed(1)} 像素,占跨度 ${((mesh.residual / extent) * 100).toFixed(1)}%)`)
    }
    // 缩放只在跨度 ≥ 64px 时判:小图的比值被整数裁剪框量化主导(11px 的图差 1px 就是 9%)。
    // 小图真有缩放差时,上面的残差判据就会露出来 —— MC2 全部 31 个缩放差 > 2% 的小网格,
    // 24 个残差超标已分流(含 Valentines_flower 这几个差 50% 的),剩下 7 个缩放差 × 跨度都 < 1px,是量化噪声。
    // 全盘留在 SpriteSkin 的小网格,与姿势无关的误差上界最大 1.4px(见 PROGRESS.md)
    const own = attachmentScale(item.attachment, region)
    if (own !== null && own.extent >= 64 && Math.abs(own.scale / k - 1) > 0.02) {
      reasons.push(`图集缩放 ${own.scale.toFixed(3)} 与全局 ${k.toFixed(3)} 不一致`)
    }
    if (reasons.length > 0) {
      const geo = buildSkinnedGeometry(item, rect, slotBone, reasons)
      skinned.push(geo)
      skinnedByItem.set(item, geo)
      for (const k of new Set(deformKeysOf(item))) {
        const list = skinnedByKey.get(k)
        if (list === undefined) skinnedByKey.set(k, [geo])
        else list.push(geo)
      }
      sprites.set(item.spriteName, {
        page: rect.page,
        internalID: internal,
        skinBones: null,
        rigid: null,
        rigidBone: null,
        skinned: true,
      })
      continue
    }
    if (mesh.undetermined.length > 0) {
      issues.add(
        'info',
        `mesh.${item.spriteName}`,
        `${mesh.undetermined.length} 根骨骼只影响一个顶点,绑定姿势的角度无解,` +
          '已取同网格其余骨骼的中位角度',
      )
    }

    // 未加权网格没有 SpriteSkin,靠节点自己的变换摆位 —— 把拟合出的平移放进 pivot,
    // 节点就只剩一个反向旋转要做
    const anchor = mesh.rigid ?? { x: rect.width / 2, y: rect.height / 2 }

    const subset = mesh.bindPose === null ? [] : boneSubset(mesh.influences)
    const subsetIndex = new Map<number, number>()
    subset.forEach((b, i) => subsetIndex.set(b, i))

    let droppedAny = false
    const weights: MetaWeight[] =
      mesh.bindPose === null
        ? []
        : mesh.influences.map((inf) => {
            const r = topFour(inf, (b) => subsetIndex.get(b) ?? 0)
            droppedAny ||= r.dropped
            return r.weight
          })

    if (droppedAny) {
      issues.add(
        'approximated',
        `mesh.${item.spriteName}`,
        'Unity 每个顶点最多绑 4 根骨骼,超出的取权重最大的四根并重新归一化',
      )
    }

    // 绑定姿势是逐骨骼独立解出来的,没有层级 —— parentId 一律 -1,
    // position/rotation 就是各自在 sprite 空间里的世界变换
    const metaBones: MetaBone[] = subset.map((boneIndex) => {
      const bone = part.bones[boneIndex]!
      const fit = mesh.bindPose!.get(boneIndex)!
      return {
        name: bone.name,
        guid: boneGuids.get(bone.name)!,
        position: { x: fit.x, y: fit.y },
        rotation: degreesToQuaternionZ(fit.rotation),
        length: bone.length / k,
        parentId: -1,
      }
    })

    sprites.set(item.spriteName, {
      page: rect.page,
      internalID: internal,
      skinBones: mesh.bindPose === null ? null : subset,
      rigid: mesh.rigid,
      rigidBone: mesh.rigidBone,
      skinned: false,
    })
    metaSprites[rect.page]!.push({
      name: item.spriteName,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      // 加权网格的 pivot 在计算里会被约掉(顶点和骨骼都减同一个量),取中心便于在编辑器里看
      pivot: { x: anchor.x / rect.width, y: anchor.y / rect.height },
      spriteID,
      internalID: internal,
      vertices: mesh.vertices,
      triangles: mesh.triangles,
      bones: metaBones,
      weights,
    })
  }

  // ── 3½. clipping 遮罩 → SpriteMask ──
  //
  // 遮罩的形状是 sprite 的网格:一张 16×16 的白图,每种形状一个 sprite,顶点就是多边形(导入的 sprite 自带的自定义网格,
  // 实测 SpriteMask 用它;运行时 OverrideGeometry 的不用)。同一个遮罩的各种形状归一到同一个包围盒里,节点变换都一样。
  // ⚠️ 实测:SpriteMask 的 m_Sprite、排序范围,渲染器的 m_MaskInteraction 都**不能被动画驱动**,能动的只有 m_Enabled ——
  //   - deform:每种形状一个 SpriteMask 物体,m_Enabled 互斥地切。关键帧之间插值的按 30 fps 逐帧取形状
  //   - 开关:Spine 里遮罩没挂着时范围里的部件照常画,而渲染器的「只在遮罩里显示」改不了 —— 换成一个铺满的「不遮」遮罩
  const clips = clipGroups(part, issues)
  const CLIP_RECT = 16
  interface MaskBuild {
    readonly group: ClipGroup
    readonly base: string
    /** 各种形状,骨骼局部坐标(Spine 坐标) */
    readonly shapes: Point[][]
    /** 每条动画里形状的阶梯:时刻 → 形状下标(没有 deform 的动画不在里面) */
    readonly shapeSteps: Map<string, { t: number; shape: number }[]>
    readonly min: Point
    readonly size: Point
    /** prefab 节点:各形状一个,最后是「不遮」的 */
    readonly nodes: number[]
  }
  const maskBuilds: MaskBuild[] = []
  const shapeOf = (shapes: Point[][], poly: Point[]): number => {
    const found = shapes.findIndex((s) => s.every((p, i) => Math.abs(p.x - poly[i]!.x) < 0.01 && Math.abs(p.y - poly[i]!.y) < 0.01))
    if (found >= 0) return found
    shapes.push(poly)
    return shapes.length - 1
  }
  for (const g of clips) {
    const slot = part.slots[g.slot]!
    const path = `clipping.${slot.name}/${g.key}`
    const shapes: Point[][] = [[...g.polygon]]
    const shapeSteps = new Map<string, { t: number; shape: number }[]>()
    let sampled = false
    for (const anim of part.animations) {
      const frames = clipDeformOf(part, g, lastPerProperty(anim.timelines).kept)
      if (frames === undefined || frames.length === 0) continue
      const keyTimes = frames.map((f) => Number(f['time'] ?? 0))
      const times = new Set<number>([0, ...keyTimes])
      frames.slice(0, -1).forEach((f, i) => {
        if (f['curve'] === 'stepped') return
        const a = clipPolygonAt(part, g, frames, keyTimes[i]!), b = clipPolygonAt(part, g, frames, keyTimes[i + 1]! - 1e-6)
        if (a.every((p, j) => Math.hypot(p.x - b[j]!.x, p.y - b[j]!.y) < 0.01)) return
        sampled = true
        for (let t = keyTimes[i]! + 1 / 30; t < keyTimes[i + 1]! - 1e-6; t += 1 / 30) times.add(Number(t.toFixed(6)))
      })
      shapeSteps.set(anim.name, [...times].sort((x, y) => x - y).map((t) => ({ t, shape: shapeOf(shapes, clipPolygonAt(part, g, frames, t)) })))
    }
    const xs = shapes.flat().map((p) => p.x), ys = shapes.flat().map((p) => p.y)
    const min = { x: Math.min(...xs), y: Math.min(...ys) }
    const size = { x: Math.max(...xs) - min.x, y: Math.max(...ys) - min.y }
    if (size.x < 1e-6 || size.y < 1e-6) {
      issues.loss(path, '遮罩多边形面积为 0,没有转(范围里的部件照常画)')
      continue
    }
    if (sampled) issues.add('approximated', path, '遮罩形状在关键帧之间插值,SpriteMask 的形状不能插值 —— 按 30 fps 逐帧换一种形状(每种一个 SpriteMask 物体)')
    const base = sanitize(g.key === slot.name ? slot.name : `${slot.name}__${g.key}`)
    maskBuilds.push({ group: g, base, shapes, shapeSteps, min, size, nodes: [] })
  }
  /** 被遮的 slot → 它的遮罩 */
  const maskOfSlot = new Map<number, MaskBuild>()
  for (const b of maskBuilds) for (const s of b.group.clipped) maskOfSlot.set(s, b)
  // 被遮的 SkinnedMeshRenderer 要用自带的着色器(只有 URP 的),材质按图集页另写一份
  const maskedMeshes = options.renderPipeline === 'urp'
  const maskedPages = new Set<number>()
  const maskedMaterialGuids = pageNames.map((p) => unityGuid(`${name}/material-clip/${p}`))
  const maskTextureGuid = unityGuid(`${name}/texture/clip`)
  // 混合模式不是 normal 的 slot 的材质:SpriteRenderer 每种模式一个(<骨架>@sprite@<模式>,不带贴图,SpriteRenderer 自己塞);
  // SkinnedMeshRenderer 每张图集页 × 遮没遮 × 模式一个(<页>[@clip]@<模式>,要带贴图,被遮的用 AnimatorGoMaskedMesh)。
  // ⚠️ SpriteRenderer 的不能叫 <骨架>@<模式>:默认皮肤只有一页时页名就是骨架名,会和那一页的撞成一个文件。文件名 → 怎么写
  const blendMaterials = new Map<string, { page: number | null; masked: boolean; blend: SpineBlend; guid: string }>()
  const blendMaterialOf = (page: number | null, masked: boolean, blend: SpineBlend): { file: string; ref: AssetRef } => {
    const file = `${page === null ? `${name}@sprite` : pageNames[page]!}${masked ? '@clip' : ''}@${blend}.mat`
    const guid = unityGuid(`${name}/material-blend/${file}`)
    blendMaterials.set(file, { page, masked, blend, guid })
    return { file, ref: { fileID: MATERIAL_FILE_ID, guid } }
  }
  /** SkinnedMeshRenderer 用哪个材质(文件名 + 引用) */
  const skinnedMaterialOf = (item: SlotAttachment, page: number): { file: string; ref: AssetRef } => {
    const masked = maskOfSlot.has(item.slot) && maskedMeshes
    const blend = blendOfSlot(item.slot)
    if (blend !== null) {
      useBlendShader(item.slot, masked ? MASKED_MESH_SHADER_FILE : BLEND_SHADER_FILES[options.renderPipeline])
      return blendMaterialOf(page, masked, blend)
    }
    if (masked) maskedPages.add(page)
    return { file: `${pageNames[page]!}${masked ? '@clip' : ''}.mat`, ref: { fileID: MATERIAL_FILE_ID, guid: (masked ? maskedMaterialGuids : materialGuids)[page]! } }
  }
  const maskSpriteId = (b: number, k: number) => internalId(`${name}/clip/${b}/${k}`)

  // ── 4. prefab 节点 ──
  const nodes: PrefabNode[] = [
    {
      name,
      parent: -1,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      renderer: null,
      skin: null,
    },
  ]

  /** 骨架下标 → prefab 节点下标 */
  const boneNode = part.bones.map((_, i) => i + 1)
  part.bones.forEach((bone) => {
    nodes.push({
      name: bone.name,
      parent: bone.parent < 0 ? 0 : boneNode[bone.parent]!,
      position: { x: bone.x * scale, y: bone.y * scale, z: 0 },
      rotation: degreesToQuaternionZ(bone.rotation),
      scale: { x: bone.scaleX, y: bone.scaleY, z: 1 },
      renderer: null,
      skin: null,
    })
  })

  const nodeNames = new Map<number, Set<string>>()
  const claimName = (parent: number, wanted: string): string => {
    let taken = nodeNames.get(parent)
    if (taken === undefined) {
      taken = new Set()
      nodeNames.set(parent, taken)
    }
    let candidate = wanted
    let salt = 1
    while (taken.has(candidate)) candidate = `${wanted}_${++salt}`
    taken.add(candidate)
    return candidate
  }
  nodes.forEach((n, i) => {
    if (i > 0) claimName(n.parent, n.name)
  })

  for (const item of used) {
    const slot = part.slots[item.slot]!
    const info = sprites.get(item.spriteName)
    const rect = baked.rects.get(item.regionName)
    if (info === undefined || rect === undefined) continue

    if (info.skinned) {
      // SkinnedMeshRenderer:几何已经在骨架根空间算好,节点待在根下不动,由骨骼驱动
      const geo = skinnedByItem.get(item)!
      item.node = nodes.length
      geo.nodeIndex = item.node
      const masked = maskOfSlot.has(item.slot) && maskedMeshes
      const material = skinnedMaterialOf(item, info.page)
      nodes.push({
        name: claimName(0, attachmentNodeName(item, slot.name)),
        parent: 0,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
        renderer: null,
        skin: null,
        // 皮肤那一维:属于初始皮肤才亮
        active: visibleUnderSkin(item, initialSkin),
        skinnedMesh: {
          mesh: { fileID: MESH_FILE_ID, guid: meshGuidOf(item.spriteName) },
          // 带脚本模式下换装件不硬引用材质(材质引用着贴图),由 AnimatorGoSkins 切到时装上
          material: scriptMode && !isDefaultSkin(item.skin) ? null : material.ref,
          // 换图那一维:setup pose 只亮 attachmentName 那一个(序列帧只亮 setup 帧)
          enabled: enabledAtSetup(item),
          bones: geo.slots.map((s) => boneNode[s.bone]!),
          rootBone: boneNode[geo.slots[0]!.bone]!,
          blendShapeCount: 0, // 动画转完再补
          sortingOrder: item.slot,
          quality: skinQuality,
          ...(masked ? { maskInteraction: 1 as const } : {}),
        },
      })
      continue
    }

    const color = multiplyColor(unpackColor(slot.color), attachmentColor(item.attachment))
    let renderer: RendererSpec = {
      // 带脚本模式下换装件不硬引用 sprite,由 AnimatorGoSkins 切到时装上
      sprite: scriptMode && !isDefaultSkin(item.skin) ? null : { fileID: info.internalID, guid: textureGuids[info.page]! },
      // Spine 的 slots 数组顺序就是绘制顺序,先画的在下层
      sortingOrder: item.slot,
      color,
      // 换图那一维:setup pose 只亮 attachmentName 那一个;表情变体初始是灭的;序列帧只亮 setup 帧
      enabled: enabledAtSetup(item),
      ...(maskOfSlot.has(item.slot) ? { maskInteraction: 1 as const } : {}),
    }
    const blend = blendOfSlot(item.slot)
    // 不带贴图,带脚本模式下也能硬引用
    if (blend !== null) {
      renderer = { ...renderer, material: blendMaterialOf(null, false, blend).ref }
      useBlendShader(item.slot, BLEND_SHADER_FILES[options.renderPipeline])
    }

    let parent: number
    let skin: SkinSpec | null = null
    let position = { x: 0, y: 0, z: 0 }
    let rotation = { x: 0, y: 0, z: 0, w: 1 }
    let nodeScale = { x: 1, y: 1, z: 1 }

    if (info.skinBones !== null) {
      // 加权网格:顶点在骨架空间算好,节点必须待在骨架原点不动,由 SpriteSkin 驱动
      parent = 0
      skin = {
        rootBone: boneNode[info.skinBones[0]!]!,
        bones: info.skinBones.map((b) => boneNode[b]!),
      }
    } else if (item.attachment.type === 'mesh') {
      // 未加权网格:整块跟着 slot 的骨骼刚性移动。pivot 已经吃掉了平移,
      // 节点只要把拟合出的旋转和缩放反过来。
      //
      // 推导(f 是 bindMesh 拟合出的缩放,注意它的输入已经除过 k 了):
      //     metaVertex = f·R(θ)·(骨骼局部 / k) + t
      //     sprite 局部 = (metaVertex − pivot) / ppu纹理,pivot 取 t,ppu纹理 = ppu / k
      //                 = f·R(θ)·骨骼局部 / ppu
      // 想让最终落在 骨骼局部 / ppu,所以节点 = 转 −θ、缩放 1/f。
      // ⚠️ **不要再乘一次 k** —— 拟合的输入里已经含了。
      // ⚠️ 挂到**顶点所属的那根骨骼**,不是 slot 的骨骼 —— 加权网格里两者可以不同
      parent = boneNode[info.rigidBone ?? slot.bone]!
      rotation = degreesToQuaternionZ(-(info.rigid?.rotation ?? 0))
      const f = info.rigid?.scale ?? 1
      const inv = Math.abs(f) > 1e-9 ? 1 / f : 1
      nodeScale = { x: inv, y: inv, z: 1 }
    } else {
      parent = boneNode[slot.bone]!
      const data = item.attachment.data
      const region = rect.region
      position = {
        x: (data['x'] as number) * scale,
        y: (data['y'] as number) * scale,
        z: 0,
      }
      rotation = degreesToQuaternionZ(data['rotation'] as number)
      // attachment 的 width/height 是它想画多大(骨架单位),region 的原始尺寸是图有多大
      // (图集像素)—— 两者差一个图集缩放 k
      nodeScale = {
        x: (data['scaleX'] as number) * ((data['width'] as number) / (region.originalWidth * k)),
        y: (data['scaleY'] as number) * ((data['height'] as number) / (region.originalHeight * k)),
        z: 1,
      }
    }

    item.node = nodes.length
    nodes.push({
      name: claimName(parent, attachmentNodeName(item, slot.name)),
      parent,
      position,
      rotation,
      scale: nodeScale,
      renderer,
      skin,
      // 皮肤那一维:属于初始皮肤才亮。换图那一维在 renderer.enabled 上
      active: visibleUnderSkin(item, initialSkin),
    })
  }

  for (const [slot, files] of [...blendShaders].sort(([a], [b]) => a - b)) {
    issues.add('info', `slot.${part.slots[slot]!.name}`, `Spine 的 ${blendOfSlot(slot)} 混合 → 自带的 ${[...files].sort().join(' / ')} 着色器(拷进 AnimatorGoRuntime/),混合因子与 Spine 相同`)
  }

  // 遮罩节点:挂在遮罩 slot 的骨骼下,包围盒的左下角 + 包围盒大小(sprite 是 1×1 单位,见 CLIP_RECT);
  // 「不遮」的挂在根下(放在骨骼下的话骨骼缩放到 0 时它也没了),盖住被遮的部件在 setup 和全部动画里画到的范围再放大
  // 1.5 倍 —— 不用一个大到离谱的方块:编辑器里「聚焦」会被它拉到极远
  const reachOf = (g: ClipGroup): { center: Point; size: Point } => {
    const lo = { x: Infinity, y: Infinity }, hi = { x: -Infinity, y: -Infinity }
    const items = used.filter((u) => g.clipped.includes(u.slot))
    const eat = (pose: readonly Affine[], anim: AnimationData | null, t: number) => {
      for (const u of items) {
        let vs: { x: number; y: number }[]
        try { vs = attachmentVertices(part, atlas, u.attachment, u.skin, u.slot, pose, anim, t) } catch { continue }
        for (const p of vs) { lo.x = Math.min(lo.x, p.x); lo.y = Math.min(lo.y, p.y); hi.x = Math.max(hi.x, p.x); hi.y = Math.max(hi.y, p.y) }
      }
    }
    eat(setupSpine, null, 0)
    for (const anim of part.animations) {
      const kept = { ...anim, timelines: lastPerProperty(anim.timelines).kept }
      for (const t of sampleTimesOf(anim)) eat(poseAt(part, kept, t), kept, t)
    }
    if (!Number.isFinite(lo.x)) return { center: { x: 0, y: 0 }, size: { x: 1e4, y: 1e4 } }
    const pad = Math.max(hi.x - lo.x, hi.y - lo.y) * 0.25 + 10
    return { center: { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2 }, size: { x: hi.x - lo.x + 2 * pad, y: hi.y - lo.y + 2 * pad } }
  }
  maskBuilds.forEach((b, bi) => {
    const g = b.group
    const slot = part.slots[g.slot]!
    const on = clipOnSteps(part, g, null)[0]!.on
    const range = { back: g.slot, front: g.clipped[g.clipped.length - 1]!, sortingOrder: g.slot }
    b.shapes.forEach((_, k) => {
      const parent = boneNode[slot.bone]!
      b.nodes.push(nodes.length)
      nodes.push({
        name: claimName(parent, k === 0 ? b.base : `${b.base} #${k}`),
        parent,
        position: { x: b.min.x * scale, y: b.min.y * scale, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: b.size.x * scale, y: b.size.y * scale, z: 1 },
        renderer: null,
        skin: null,
        mask: { sprite: { fileID: maskSpriteId(bi, k), guid: maskTextureGuid }, ...range, enabled: on && k === 0 },
      })
    })
    const reach = reachOf(g)
    b.nodes.push(nodes.length)
    nodes.push({
      name: claimName(0, `${b.base} (off)`),
      parent: 0,
      position: { x: reach.center.x * scale, y: reach.center.y * scale, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: reach.size.x * scale, y: reach.size.y * scale, z: 1 },
      renderer: null,
      skin: null,
      mask: { sprite: { fileID: maskSpriteId(bi, -1), guid: maskTextureGuid }, ...range, enabled: !on },
    })
    const smr = used.filter((u) => g.clipped.includes(u.slot) && sprites.get(u.spriteName)?.skinned === true).length
    issues.add('info', `clipping.${slot.name}/${g.key}`, `遮罩 → SpriteMask(${b.shapes.length} 种形状),${g.clipped.length} 个 slot 的部件只在遮罩里显示` +
      (smr > 0 && maskedMeshes ? `;其中 ${smr} 个走 SkinnedMeshRenderer 的换成 AnimatorGoMaskedMesh 着色器(拷进 AnimatorGoRuntime/)` : ''))
    if (smr > 0 && !maskedMeshes) issues.add('approximated', `clipping.${slot.name}/${g.key}`, `内置管线下 ${smr} 个走 SkinnedMeshRenderer 的部件不受遮罩影响(遮罩用的着色器只有 URP 的)`)
    // 范围按 setup 的排序值写死(排序范围不能被动画驱动,实测):绘制顺序动画挪动了遮罩或被遮的 slot,范围就对不上了 ——
    // 被挪出范围的部件「只在遮罩里显示」又没有遮罩,整个不见
    for (const anim of part.animations) {
      const drawOrder = lastPerProperty(anim.timelines).kept.find((t) => t.kind === 'drawOrder')
      const moved = drawOrder?.frames.some((f) => {
        const layer = layerOfSlot(drawOrderOf(part.slots.length, (f['offsets'] as DrawOrderOffset[] | undefined) ?? []))
        return [g.slot, ...g.clipped].some((s) => layer[s] !== s)
      })
      if (moved === true) issues.add('approximated', `${anim.name}.clipping.${slot.name}`, 'SpriteMask 的排序范围不能动画,这条动画挪动了遮罩范围里的 slot —— 被挪出范围的部件会整个不见')
    }
  })
  if (maskBuilds.length > 0) {
    issues.add('info', 'clipping', 'SpriteMask 按排序值生效、不分角色:同一 Sorting Layer 里放几个这样的实例时,遮罩会互相叠加(Sorting Group 隔不开,实测)。要隔开就给实例用不同的 Sorting Layer')
  }

  // 动画路径:相对根物体,不含根自己
  const paths: string[] = ['']
  for (let i = 1; i < nodes.length; i++) {
    const node = nodes[i]!
    paths[i] = node.parent === 0 ? node.name : `${paths[node.parent]!}/${node.name}`
  }

  /** slot 下标 → 它的所有 attachment 节点 */
  const slotNodes = new Map<number, SlotAttachment[]>()
  for (const item of used) {
    if (item.node < 0) continue
    const list = slotNodes.get(item.slot)
    if (list === undefined) slotNodes.set(item.slot, [item])
    else list.push(item)
  }

  // ── deform → Blend Shape ──
  //
  // 每个有偏移的 deform 关键帧变成一个形变目标;两帧之间 Spine 对偏移数组做 lerp,
  // 等价于两个目标的权重交叉 (1−y, y),Spine 的曲线搬到权重曲线上。
  //
  // 增量不能直接抄 Spine 的逐影响偏移 —— 那些偏移在世界空间里并不一致(MC2 里 12~22% 的
  // 顶点分歧 >0.5px,见 PROGRESS.md)。改为**按关键帧时刻的姿势反解**:
  //     Unity 在姿势 P 下作用在增量 δ 上的是 M(P) = Σ w'ᵢ Bᵢ(P) Bᵢ(S)⁻¹
  //     Spine 在同一时刻的世界偏移是 Δ = Σ wᵢ Bᵢ(P) dᵢ
  //     令 M(Pₖ)·δ = Δₖ,关键帧时刻就严格一致;关键帧之间的分歧算出来报 approximated。
  const offsetsOf = (frame: Record<string, unknown>, length: number): number[] => {
    const flat = new Array<number>(length).fill(0)
    const vs = (frame['vertices'] as number[] | undefined) ?? []
    const start = Number(frame['start'] ?? 0)
    for (let i = 0; i < vs.length && start + i < length; i++) flat[start + i] = vs[i]!
    return flat
  }

  /** Unity 在姿势 P 下作用在第 j 个顶点增量上的矩阵:Σ w'ᵢ · Bᵢ(P) · bindposeᵢ(只取线性部分) */
  const unityDeformMatrix = (geo: SkinnedGeometry, j: number, poseU: readonly Affine[]): Affine => {
    let a = 0
    let b = 0
    let c = 0
    let d = 0
    for (const w of geo.effective[j]!) {
      const s = geo.slots[w.slot]!
      const m = multiply(linear(poseU[s.bone]!), linear(s.bindpose))
      a += w.weight * m.a
      b += w.weight * m.b
      c += w.weight * m.c
      d += w.weight * m.d
    }
    return { a, b, c, d, x: 0, y: 0 }
  }

  /** 一帧 deform 的偏移 → 每个顶点的 Blend Shape 增量(网格空间,Unity 单位) */
  const shapeDeltas = (geo: SkinnedGeometry, anim: AnimationData, time: number, flat: number[]): { x: number; y: number }[] => {
    const verts = geo.localVerts
    const out: { x: number; y: number }[] = []
    if (!verts.weighted) {
      // 不加权:Spine 在骨骼局部加偏移再乘骨骼矩阵,Unity 在网格空间加增量再乘 B(P)B(S)⁻¹,
      // 令两者在 setup 下一致 → δ = B(S)·d(线性部分)
      const B = setupSpine[geo.slotBone]!
      for (let j = 0; j < geo.vertices.length; j++) {
        const d = applyVector(B, flat[j * 2]!, flat[j * 2 + 1]!)
        out.push({ x: d.x * scale, y: d.y * scale })
      }
      return out
    }
    const poseS = poseAt(part, anim, time)
    const poseU = poseAt(part, anim, time, { unityCompatible: true })
    let idx = 0
    for (let j = 0; j < geo.vertices.length; j++) {
      const start = idx
      let dx = 0
      let dy = 0
      for (const w of verts.weights[j]!) {
        const d = applyVector(poseS[w.bone]!, flat[idx]!, flat[idx + 1]!)
        dx += w.weight * d.x
        dy += w.weight * d.y
        idx += 2
      }
      const inv = invert(unityDeformMatrix(geo, j, poseU))
      if (inv !== null) {
        const d = applyVector(inv, dx, dy)
        out.push({ x: d.x * scale, y: d.y * scale })
        continue
      }
      // 退化(骨骼缩放为 0 之类):退回 setup 姿势下的加权平均
      let sx = 0
      let sy = 0
      let kk = start
      for (const w of verts.weights[j]!) {
        const d = applyVector(setupSpine[w.bone]!, flat[kk]!, flat[kk + 1]!)
        sx += w.weight * d.x
        sy += w.weight * d.y
        kk += 2
      }
      out.push({ x: sx * scale, y: sy * scale })
    }
    return out
  }

  /** 关键帧之间 Blend Shape 与 Spine 的最大分歧(Spine 像素) */
  const deformDivergence = (
    geo: SkinnedGeometry,
    anim: AnimationData,
    frames: readonly Record<string, unknown>[],
    flats: readonly number[][],
    deltas: readonly ({ x: number; y: number }[] | null)[],
  ): number => {
    const verts = geo.localVerts
    let worst = 0
    for (let k = 0; k < frames.length - 1; k++) {
      const t0 = frames[k]!['time'] as number
      const t1 = frames[k + 1]!['time'] as number
      if (t1 <= t0) continue
      // 借 valueBetween 算这一段的进度 y(t),连同它的曲线
      const probe = [{ ...frames[k]!, p: 0 }, { time: t1, p: 1 }]
      for (let s = 1; s < 8; s++) {
        const time = t0 + ((t1 - t0) * s) / 8
        const y = valueBetween(probe, 0, 'p', time, is38, 0)
        const poseS = poseAt(part, anim, time)
        const poseU = poseAt(part, anim, time, { unityCompatible: true })
        let idx = 0
        for (let j = 0; j < geo.vertices.length; j++) {
          // Spine:偏移数组先 lerp 再蒙皮
          let sx = 0
          let sy = 0
          for (const w of verts.weights[j]!) {
            const ox = flats[k]![idx]! + (flats[k + 1]![idx]! - flats[k]![idx]!) * y
            const oy = flats[k]![idx + 1]! + (flats[k + 1]![idx + 1]! - flats[k]![idx + 1]!) * y
            const d = applyVector(poseS[w.bone]!, ox, oy)
            sx += w.weight * d.x
            sy += w.weight * d.y
            idx += 2
          }
          // Unity:两个目标权重 (1−y, y),增量在网格空间 lerp 再过 M(P)
          const a = deltas[k]?.[j] ?? { x: 0, y: 0 }
          const b = deltas[k + 1]?.[j] ?? { x: 0, y: 0 }
          const mx = (a.x + (b.x - a.x) * y) / scale
          const my = (a.y + (b.y - a.y) * y) / scale
          const u = applyVector(unityDeformMatrix(geo, j, poseU), mx, my)
          worst = Math.max(worst, Math.hypot(sx - u.x, sy - u.y))
        }
      }
    }
    return worst
  }

  /** 把一条 deform 时间轴转成形变目标 + 权重曲线;返回是否有曲线被近似 */
  /** 一条 deform 时间轴各关键帧的偏移和反解出的 Blend Shape 增量 */
  const prepareDeform = (geo: SkinnedGeometry, anim: AnimationData, d: DeformRecord) => {
    const frames = d.frames
    const verts = geo.localVerts
    const flatLength = verts.weighted ? verts.weights.reduce((s, w) => s + w.length * 2, 0) : verts.positions.length
    const flats = frames.map((f) => offsetsOf(f, flatLength))
    const times = frames.map((f) => f['time'] as number)
    const deltas = flats.map((flat, k) => (flat.some((v) => Math.abs(v) > 1e-9) ? shapeDeltas(geo, anim, times[k]!, flat) : null))
    return { frames, flats, times, deltas }
  }

  /**
   * 关键帧之间 Blend Shape 与 Spine 的最大分歧(像素)。Spine 先在各骨骼局部插值偏移再蒙皮,Unity 先在网格空间插值增量
   * 再蒙皮,只有关键帧上一致 —— 超过 0.5 像素的,这条动画改用逐帧修正(correctionShapes)
   */
  const deformGap = (geo: SkinnedGeometry, anim: AnimationData, d: DeformRecord): number => {
    if (!geo.localVerts.weighted || d.frames.length < 2) return 0
    const { frames, flats, deltas } = prepareDeform(geo, anim, d)
    return deformDivergence(geo, anim, frames, flats, deltas)
  }

  const convertDeform = (geo: SkinnedGeometry, anim: AnimationData, d: DeformRecord, floats: FloatCurve[]): boolean => {
    const n = d.frames.length
    if (n === 0) return false
    const verts = geo.localVerts
    const { frames, flats, times, deltas } = prepareDeform(geo, anim, d)

    // 有增量的帧才成为形变目标;零帧(回到原样)只贡献相邻目标权重归零的时刻
    const shapeOf: (number | null)[] = deltas.map((dl, k) => {
      if (dl === null) return null
      const sparse = dl.map((v, j) => ({ index: j, x: v.x, y: v.y })).filter((v) => Math.hypot(v.x, v.y) > 1e-7)
      if (sparse.length === 0) return null
      const base = `${sanitize(anim.name)}_${k}`
      let shapeName = base
      let salt = 1
      while (geo.shapeNames.has(shapeName)) shapeName = `${base}_${++salt}`
      geo.shapeNames.add(shapeName)
      geo.shapes.push({ name: shapeName, deltas: sparse })
      return geo.shapes.length - 1
    })

    // 帧 i → i+1 的曲线描述进度 y ∈ [0,1];toWeight 把进度映射成该目标的权重
    const progressSegment = (i: number, toWeight: (y: number) => number) =>
      segmentsOf([frames[i]!, frames[i + 1]!], [0, 1], toWeight, is38)[0]

    let approximated = false
    const path = paths[geo.nodeIndex]!
    shapeOf.forEach((si, k) => {
      if (si === null) return
      const ts: number[] = []
      const vs: number[] = []
      const segs: (SpineSegment | undefined)[] = []
      if (k > 0) {
        ts.push(times[k - 1]!)
        vs.push(0)
        segs.push(progressSegment(k - 1, (y) => 100 * y))
      }
      ts.push(times[k]!)
      vs.push(100)
      if (k < n - 1) {
        segs.push(progressSegment(k, (y) => 100 * (1 - y)))
        ts.push(times[k + 1]!)
        vs.push(0)
      }
      segs.push(undefined)
      // 第一帧之前 Spine 没有形变 → 0 处补 0 并阶梯过去(与骨骼曲线的 withSetup 同理)
      const s = withSetup(ts, vs, segs, 0)
      const curve = toUnityCurve(s.times, s.values, s.segments)
      approximated ||= curve.approximated
      floats.push({ path, attribute: `blendShape.${geo.shapes[si]!.name}`, classID: 137, keys: curve.keys })
    })

    if (verts.weighted && n > 1) {
      const worst = deformDivergence(geo, anim, frames, flats, deltas)
      if (worst > 0.5) {
        issues.add(
          'approximated',
          `deform[${geo.item.spriteName}]`,
          `Blend Shape 在关键帧之间与 Spine 最大差 ${worst.toFixed(1)} 像素(关键帧时刻精确)`,
        )
      }
    }
    return approximated
  }

  /**
   * deform 在关键帧之间与 Spine 差 0.5 像素以上的网格(deformGap):这条动画里逐帧解出让 Unity 与 Spine 完全重合的网格增量,
   * 每个采样时刻一个形变目标,权重是「前一刻 0 → 这一刻 100 → 后一刻 0」的三角,相邻目标此消彼长 —— 增量在帧间线性插值。
   * 这条动画的 deform 就不再单独转。帧间与 Spine 差得多的段自适应加密到 1/480 秒。
   *
   *     Unity:Σ w'ᵢ · Bᵢ(t) · bindposeᵢ · (v + δ)    Spine:Σ wᵢ · Bᵢ(t) · (lᵢ + dᵢ(t))
   *     令两者相等:M(t)·δ = Spine − Σ w'ᵢ · Bᵢ(t) · bindposeᵢ · v,M(t) = Σ w'ᵢ · lin(Bᵢ(t) · bindposeᵢ)
   */
  const correctionShapes = (geo: SkinnedGeometry, anim: AnimationData, timelines: readonly Timeline[], floats: FloatCurve[]): void => {
    const verts = geo.localVerts
    if (!verts.weighted) return
    const flatLength = verts.weights.reduce((n, w) => n + w.length * 2, 0)
    const keys = new Set(deformKeysOf(geo.item))
    const deform = timelines
      .filter((t) => t.kind === 'deform')
      .map((t) => ({ t, d: t.frames[0] as unknown as DeformRecord }))
      .find(({ t, d }) => keys.has(`${skinNameOf(d.skin)}/${t.owner}/${d.attachment}`))?.d
    const flats = deform?.frames.map((f) => offsetsOf(f, flatLength))
    /** Spine 在 t 时刻的 deform 偏移(逐影响平铺);第一帧之前没有形变 */
    const offsetsAt = (t: number): number[] | null => {
      if (deform === undefined || flats === undefined) return null
      const frames = deform.frames
      const first = Number(frames[0]!['time'] ?? 0)
      if (t < first) return null
      let i = frames.length - 1
      for (let k = 0; k + 1 < frames.length; k++) if (t < Number(frames[k + 1]!['time'])) { i = k; break }
      if (i === frames.length - 1) return flats[i]!
      const y = valueBetween([{ ...frames[i]!, p: 0 }, { time: frames[i + 1]!['time'], p: 1 }], 0, 'p', t, is38, 0)
      return flats[i]!.map((v, k) => v + (flats[i + 1]![k]! - v) * y)
    }
    /** t 时刻:Spine 的目标位置、Unity 不加增量时的位置(Unity 单位)和 M(t) */
    const stateAt = (t: number) => {
      const poseS = poseAt(part, anim, t)
      const poseU = poseAt(part, anim, t, { unityCompatible: true })
      const off = offsetsAt(t)
      let idx = 0
      return verts.weights.map((entry, j) => {
        let sx = 0, sy = 0
        for (const w of entry) {
          const p = applyPoint(poseS[w.bone]!, w.x + (off?.[idx] ?? 0), w.y + (off?.[idx + 1] ?? 0))
          sx += w.weight * p.x
          sy += w.weight * p.y
          idx += 2
        }
        let ux = 0, uy = 0
        const v = geo.vertices[j]!
        for (const w of geo.effective[j]!) {
          const s = geo.slots[w.slot]!
          const p = applyPoint(multiply(toUnits(poseU[s.bone]!), s.bindpose), v.x, v.y)
          ux += w.weight * p.x
          uy += w.weight * p.y
        }
        return { target: { x: sx * scale, y: sy * scale }, base: { x: ux, y: uy }, m: unityDeformMatrix(geo, j, poseU) }
      })
    }
    const solve = (state: ReturnType<typeof stateAt>) =>
      state.map((s) => {
        const inv = invert(s.m)
        return inv === null ? { x: 0, y: 0 } : applyVector(inv, s.target.x - s.base.x, s.target.y - s.base.y)
      })
    /** 增量 δ 下 Unity 与 Spine 的最大差(Spine 像素) */
    const errorOf = (state: ReturnType<typeof stateAt>, delta: readonly { x: number; y: number }[]) =>
      Math.max(0, ...state.map((s, j) => {
        const d = applyVector(s.m, delta[j]!.x, delta[j]!.y)
        return Math.hypot(s.base.x + d.x - s.target.x, s.base.y + d.y - s.target.y) / scale
      }))

    // 阶梯帧:跳变那一刻之前补一个「跳变前」的采样,跳变只占 STEP_EPSILON(与骨骼曲线的阶梯同一个办法)。
    // 不补的话,线性插值的增量会把跳变后的值提前拉过去
    const times = new Set(sampleTimesOf(anim))
    for (const t of timelines) {
      const frames = t.kind === 'deform' ? (t.frames[0] as unknown as DeformRecord).frames : t.frames
      frames.forEach((f, i) => {
        const next = frames[i + 1]
        if (f['curve'] === 'stepped' && next !== undefined) times.add(Number(next['time']) - STEP_EPSILON)
      })
    }
    // ⚠️ 来源不同的时刻(Spine 的 float32 关键帧 0.06666667 与帧格 2/30)只差 1e-9 秒,写进 .anim(7 位有效数字)
    // 就是同一时刻的两个键 —— Unity 不跳过零长度的段,斜率 1e10 的曲线一算就飞(实测权重到 -3e18,网格铺满屏)
    // 挨得太近的取最晚那个:阶梯关键帧那一刻 Spine 已经跳过去了(0.30000001 是跳变后,帧格的 0.29999999 是跳变前)
    const distinct: number[] = []
    for (const t of [...times].filter((x) => x >= 0).sort((a, b) => a - b)) {
      if (distinct.length > 0 && t - distinct[distinct.length - 1]! <= 1e-5) distinct[distinct.length - 1] = t
      else distinct.push(t)
    }
    const samples = distinct.map((t) => {
      const state = stateAt(t)
      return { t, state, delta: solve(state) }
    })
    const zero = geo.vertices.map(() => ({ x: 0, y: 0 }))
    // 这条动画里不加修正也不超过 0.5 像素(碰不到这个网格的骨骼),就不加
    const uncorrected = Math.max(0, ...samples.map((s) => errorOf(s.state, zero)))
    if (uncorrected <= 0.5) return
    // 帧间按线性插值的增量与 Spine 比,超过 0.25 像素就在中点加一个采样,最细 1/480 秒
    let residual = 0
    const refined: typeof samples = [samples[0]!]
    const refine = (a: (typeof samples)[number], b: (typeof samples)[number]) => {
      const t = (a.t + b.t) / 2
      const state = stateAt(t)
      const mid = a.delta.map((p, j) => ({ x: (p.x + b.delta[j]!.x) / 2, y: (p.y + b.delta[j]!.y) / 2 }))
      const err = errorOf(state, mid)
      if (err <= 0.25 || b.t - a.t <= 1 / 480 + 1e-9) {
        if (err > 0.25 && b.t - a.t > 2 * STEP_EPSILON) {
          // 加密到底还对不上:是没标成阶梯的瞬间跳变(同一时刻两个关键帧之类,Female staff 的 paperB 在 0.6 秒跳 118 像素)。
          // 关键帧都在采样里,跳变就落在 b —— 和阶梯帧一样在它前面 STEP_EPSILON 补一个采样,
          // 否则 Unity 会把跳变抹成 1/480 秒长的斜坡
          const pre = b.t - STEP_EPSILON
          const ps = stateAt(pre)
          const m = { t: pre, state: ps, delta: solve(ps) }
          const half = stateAt((a.t + pre) / 2)
          residual = Math.max(residual, errorOf(half, a.delta.map((p, j) => ({ x: (p.x + m.delta[j]!.x) / 2, y: (p.y + m.delta[j]!.y) / 2 }))))
          refined.push(m, b)
          return
        }
        // 阶梯跳变那一小段是故意的,不算残差
        if (b.t - a.t > 2 * STEP_EPSILON) residual = Math.max(residual, err)
        refined.push(b)
        return
      }
      const m = { t, state, delta: solve(state) }
      refine(a, m)
      refine(m, b)
    }
    for (let i = 0; i + 1 < samples.length; i++) refine(samples[i]!, samples[i + 1]!)

    const path = paths[geo.nodeIndex]!
    const straight = { curve: 'linear' as const }
    refined.forEach((s, k) => {
      const sparse = s.delta.map((v, j) => ({ index: j, x: v.x, y: v.y })).filter((v) => Math.hypot(v.x, v.y) > 1e-7)
      if (sparse.length === 0) return
      const base = `${sanitize(anim.name)}_fix${k}`
      let shapeName = base
      for (let salt = 2; geo.shapeNames.has(shapeName); salt++) shapeName = `${base}_${salt}`
      geo.shapeNames.add(shapeName)
      geo.shapes.push({ name: shapeName, deltas: sparse })
      const ts: number[] = []
      const vs: number[] = []
      const segs: (SpineSegment | undefined)[] = []
      if (k > 0) {
        ts.push(refined[k - 1]!.t)
        vs.push(0)
        segs.push(straight)
      }
      ts.push(s.t)
      vs.push(100)
      if (k + 1 < refined.length) {
        segs.push(straight)
        ts.push(refined[k + 1]!.t)
        vs.push(0)
      }
      segs.push(undefined)
      // 第一个采样之前权重保持 0(这个目标还没起作用)
      const w = withSetup(ts, vs, segs, 0)
      floats.push({ path, attribute: `blendShape.${shapeName}`, classID: 137, keys: toUnityCurve(w.times, w.values, w.segments).keys })
    })
    if (residual > 0.5) {
      issues.add('approximated', `mesh.${geo.item.spriteName}`, `逐帧修正后,帧间与 Spine 仍最多差 ${residual.toFixed(1)} 像素(采样时刻精确)`)
    }
  }

  /** slot 颜色动画落在 SkinnedMeshRenderer 上的 sprite —— 没有对应属性,汇总后报一次 */
  const skinnedColorLoss = new Set<string>()

  // ── 逐帧绘制顺序 → m_SortingOrder 阶梯曲线 ──
  //
  // Spine 的 drawOrder 一帧只存「谁挪了几位」,铺成完整顺序后,每个 slot 的层号就是它的 sortingOrder
  // (静态时 sortingOrder = slot 下标,同一套刻度)。实测 blackrichwoman 六条动画都把右手提到脸前 +28 层 ——
  // 手摸脸的动作,静态顺序下手会被脸挡住。
  //
  // 有哪些 slot 在任何动画里挪过位,就给它们在**每条**动画里都写曲线(没挪的动画写一个 setup 值):
  // 这样切动画时不依赖 Animator 的 Write Defaults 去还原,行为和 Spine「换动画回 setup」一致。
  const drawOrderSlots = new Set<number>()
  for (const anim of part.animations) {
    for (const t of anim.timelines) {
      if (t.kind !== 'drawOrder') continue
      for (const f of t.frames) {
        const layer = layerOfSlot(drawOrderOf(part.slots.length, (f['offsets'] as DrawOrderOffset[] | undefined) ?? []))
        layer.forEach((l, slot) => {
          if (l !== slot) drawOrderSlots.add(slot)
        })
      }
    }
  }

  // ── 4.1 序列帧 → 每帧节点的 m_Enabled 阶梯曲线 ──
  //
  // 渲染器亮 =「换图时间轴说这个键名亮着」且「sequence 时间轴说现在是这一帧」。两者都是阶梯函数,
  // 合起来还是阶梯。只在这条动画碰了其中之一时写 —— 都没碰就和普通换图一样,靠 Write Defaults 回 setup。
  /** 动画时长 = 所有时间轴最后一个关键帧的时刻(Spine 自己就是这么算的) */
  const durationOf = (anim: AnimationData): number => {
    let end = 0
    for (const t of anim.timelines) {
      const frames = t.kind === 'deform' || t.kind === 'sequence' ? (t.frames[0] as unknown as { frames: Record<string, unknown>[] }).frames : t.frames
      for (const f of frames) end = Math.max(end, (f['time'] as number | undefined) ?? 0)
    }
    return end
  }
  /** 同一个序列帧 attachment 的各帧节点 */
  const frameGroups = new Map<string, SlotAttachment[]>()
  for (const item of used) {
    if (item.frame === undefined || item.node < 0) continue
    const k = `${item.skin}/${item.slot}/${item.key}`
    const list = frameGroups.get(k)
    if (list === undefined) frameGroups.set(k, [item])
    else list.push(item)
  }
  /** 取阶梯函数在时刻 t 的值(steps 按时间升序,取最后一个 time ≤ t 的) */
  const stepAt = <T>(steps: readonly { time: number; value: T }[], t: number): T => {
    let v = steps[0]!.value
    for (const s of steps) {
      if (s.time > t + 1e-9) break
      v = s.value
    }
    return v
  }
  const writeSequenceCurves = (anim: AnimationData, timelines: readonly Timeline[], floats: FloatCurve[]) => {
    const animEnd = durationOf(anim)
    for (const items of frameGroups.values()) {
      const first = items[0]!
      const slot = part.slots[first.slot]!
      const seq = first.frame!.sequence
      // 时间轴按「皮肤/slot/键名」找目标,展开后的 linkedmesh 也认父网格的(与 deform 同一套键)
      const targets = new Set(deformKeysOf(first))
      const seqTimeline = timelines.find((t) => {
        if (t.kind !== 'sequence' || t.owner !== first.slot) return false
        const d = t.frames[0] as unknown as DeformRecord
        return targets.has(`${skinNameOf(d.skin)}/${t.owner}/${d.attachment}`)
      })
      const attTimeline = timelines.find((t) => t.kind === 'attachment' && t.owner === first.slot)
      if (seqTimeline === undefined && attTimeline === undefined) continue

      const keys = seqTimeline === undefined ? undefined : (seqTimeline.frames[0] as unknown as { frames: SequenceKey[] }).frames
      let end = animEnd
      if (end <= 0 && keys !== undefined) {
        // 时长为 0 的动画在 Spine 里时间照走、序列帧一直播;Unity 的剪辑要有长度才循环 —— 取一个周期
        const cycle = Math.max(0, ...keys.map((k) => sequenceCycle(k, seq.count)))
        if (cycle > 0) {
          end = cycle
          issues.add('info', `sequence[${slot.name}]`, `动画时长为 0,序列帧按一个周期(${cycle.toFixed(3)}s)写出并循环`)
        }
      }
      const frameSteps = sequenceSteps(keys, seq, end).map((s) => ({ time: s.time, value: s.frame }))
      // 换图那一维:没有换图时间轴就一直是 setup 的显隐
      const visSteps = [{ time: 0, value: slot.attachmentName === first.key }]
      for (const f of attTimeline?.frames ?? []) visSteps.push({ time: f['time'] as number, value: f['name'] === first.key })
      const changes = [...new Set([...frameSteps, ...visSteps].map((s) => s.time))].sort((a, b) => a - b)

      for (const item of items) {
        const out: UnityKeyframe[] = []
        let prev = -1
        for (const t of changes) {
          const on = stepAt(visSteps, t) && stepAt(frameSteps, t) === item.frame!.index ? 1 : 0
          if (on !== prev) {
            out.push(key(t, on, true))
            prev = on
          }
        }
        // 剪辑不能比 Spine 的动画短:末尾补一个同值的键把长度撑到 end
        if (end > out[out.length - 1]!.time + 1e-9) out.push(key(end, prev, true))
        floats.push({ path: paths[item.node]!, attribute: 'm_Enabled', classID: skinnedByItem.has(item) ? 137 : 212, keys: out })
      }
    }
  }

  // ── 5. 动画 ──
  const clipGuids = new Map<string, string>()
  const files: UnityFile[] = []

  for (const anim of part.animations) {
    const position: Vector3Curve[] = []
    const euler: Vector3Curve[] = []
    const scaleCurves: Vector3Curve[] = []
    const floats: FloatCurve[] = []
    // 同一属性的重复时间轴只取最后一条(Spine 实际播出来的那条)。两条都写的话,deform 的
    // Blend Shape 会叠加成两倍(实测 Juicer 的 work),换图 / 颜色则是一个属性两条曲线、谁生效没保证
    const { kept: timelines, dropped } = lastPerProperty(anim.timelines)
    /** 这条动画里 deform 帧间分歧太大、改用逐帧修正的网格 */
    const deformCorrected = new Set<SkinnedGeometry>()

    issues.scoped(anim.name, () => {
      for (const d of dropped) {
        if (!d.identical) issues.add('approximated', describeTimeline(part, d.timeline), DUPLICATE_TIMELINE_MESSAGE)
      }
      let approximated = false
      const noteApprox = (t: Timeline) => {
        if (!approximated) return
        approximated = false
        issues.add(
          'approximated',
          `${t.kind}[${t.owner}]`,
          'Spine 的贝塞尔控制点贴在端点上,Unity 无法精确表达,已退化为线性',
        )
      }

      for (const t of timelines) {
        const bone = part.bones[t.owner]
        const path = paths[boneNode[t.owner] ?? -1]

        if (t.kind === 'rotate' && bone !== undefined && path !== undefined) {
          const toAngle = (raw: number) => bone.rotation + raw
          const raw = t.frames.map((f) => f['value'] as number)
          const s = withSetup(
            t.frames.map((f) => f['time'] as number),
            raw.map(toAngle),
            segmentsOf(t.frames, raw, toAngle, is38),
            bone.rotation,
          )
          const z = toUnityCurve(s.times, s.values, s.segments)
          approximated ||= z.approximated
          euler.push({ path, x: constantKeys(s.times, 0), y: constantKeys(s.times, 0), z: z.keys })
          noteApprox(t)
          continue
        }

        if (t.kind === 'translate' && bone !== undefined && path !== undefined) {
          const toX = (raw: number) => (bone.x + raw) * scale
          const toY = (raw: number) => (bone.y + raw) * scale
          const rawX = t.frames.map((f) => f['x'] as number)
          const rawY = t.frames.map((f) => f['y'] as number)
          const sx = withSetup(
            t.frames.map((f) => f['time'] as number),
            rawX.map(toX),
            segmentsOf(t.frames, rawX, toX, is38, 0),
            bone.x * scale,
          )
          const sy = withSetup(
            t.frames.map((f) => f['time'] as number),
            rawY.map(toY),
            segmentsOf(t.frames, rawY, toY, is38, 1),
            bone.y * scale,
          )
          const x = toUnityCurve(sx.times, sx.values, sx.segments)
          const y = toUnityCurve(sy.times, sy.values, sy.segments)
          approximated ||= x.approximated || y.approximated
          position.push({ path, x: x.keys, y: y.keys, z: constantKeys(sx.times, 0) })
          noteApprox(t)
          continue
        }

        // 缩放:Spine 的关键帧是**倍率**,要乘绑定值而不是加
        if (t.kind === 'scale' && bone !== undefined && path !== undefined) {
          const toSX = (raw: number) => bone.scaleX * raw
          const toSY = (raw: number) => bone.scaleY * raw
          const rawX = t.frames.map((f) => f['x'] as number)
          const rawY = t.frames.map((f) => f['y'] as number)
          const sx = withSetup(
            t.frames.map((f) => f['time'] as number),
            rawX.map(toSX),
            segmentsOf(t.frames, rawX, toSX, is38, 0),
            bone.scaleX,
          )
          const sy = withSetup(
            t.frames.map((f) => f['time'] as number),
            rawY.map(toSY),
            segmentsOf(t.frames, rawY, toSY, is38, 1),
            bone.scaleY,
          )
          const x = toUnityCurve(sx.times, sx.values, sx.segments)
          const y = toUnityCurve(sy.times, sy.values, sy.segments)
          approximated ||= x.approximated || y.approximated
          scaleCurves.push({ path, x: x.keys, y: y.keys, z: constantKeys(sx.times, 1) })
          noteApprox(t)
          continue
        }

        // 换图:Spine 是「这一刻挂哪个 attachment」,Unity 侧一个 attachment 一个物体,
        // 所以变成一组互斥的阶梯曲线,打在**渲染器的 m_Enabled** 上。
        // 不能打在 GameObject 的 m_IsActive 上 —— 那是皮肤层的开关;同一个键名在几套皮肤里各有
        // 一个节点,它们共用这条曲线,谁真的显示由皮肤层决定(两个开关是 AND)
        if (t.kind === 'attachment') {
          const slot = part.slots[t.owner]
          const list = slotNodes.get(t.owner)
          if (slot === undefined || list === undefined) continue

          const times = t.frames.map((f) => f['time'] as number)
          const names = t.frames.map((f) => f['name'] as string | null)

          for (const item of list) {
            // 序列帧的节点要和帧号合成,在时间轴循环之后统一写
            if (item.frame !== undefined) continue
            const keys: UnityKeyframe[] = []
            if (times[0]! > 0) keys.push(key(0, slot.attachmentName === item.key ? 1 : 0, true))
            times.forEach((time, i) => keys.push(key(time, names[i] === item.key ? 1 : 0, true)))
            const classID = sprites.get(item.spriteName)?.skinned === true ? 137 : 212
            floats.push({ path: paths[item.node]!, attribute: 'm_Enabled', classID, keys })
          }
          continue
        }

        // slot 颜色 → SpriteRenderer.m_Color。⚠️ 3.8 的 twoColor(两色染色)也要进来:亮色照转、暗色报丢弃 ——
        // 之前条件里漏了它,整条时间轴连亮色带报告被静默跳过(wave 的 shadow)
        if (t.kind === 'color' || t.kind === 'twoColor' || t.kind.startsWith('slotColor')) {
          const slot = part.slots[t.owner]
          const list = slotNodes.get(t.owner)
          if (slot === undefined || list === undefined) continue

          const setup = unpackColor(slot.color)
          const channels = colorChannels(t, setup)
          if (channels === null) {
            issues.loss(`${t.kind}[${slot.name}]`, '未知的 slot 颜色时间轴,已丢弃')
            continue
          }
          if (t.kind === 'twoColor' || t.kind === 'slotColor3' || t.kind === 'slotColor4') {
            issues.loss(`${t.kind}[${slot.name}]`, 'Unity 没有两色染色,暗色部分已丢弃')
          }

          for (const [attribute, values, component, setupValue] of channels) {
            const times = t.frames.map((f) => f['time'] as number)
            const channel = attribute.slice('m_Color.'.length) as keyof Rgba
            // 节点颜色 = slot 颜色 × attachment 颜色:曲线按各节点的 attachment 颜色缩放。乘常数对取值、贝塞尔控制点、
            // Hermite 切线都是精确的。同一 slot 下 attachment 颜色可以不同,按系数各算一条
            const byFactor = new Map<number, UnityKeyframe[]>()
            const curveFor = (factor: number): UnityKeyframe[] => {
              const hit = byFactor.get(factor)
              if (hit !== undefined) return hit
              const scaleBy = (v: number) => v * factor
              // 颜色的取值已经是 0..1,与贝塞尔 cy 同一空间,只差这个系数
              const s = withSetup(times, values.map(scaleBy), segmentsOf(t.frames, values, scaleBy, is38, component), scaleBy(setupValue))
              const curve = toUnityCurve(s.times, s.values, s.segments)
              approximated ||= curve.approximated
              byFactor.set(factor, curve.keys)
              return curve.keys
            }
            for (const item of list) {
              if (skinnedByItem.has(item)) {
                skinnedColorLoss.add(item.spriteName)
                continue
              }
              floats.push({ path: paths[item.node]!, attribute, classID: 212, keys: curveFor(attachmentColor(item.attachment)[channel]) })
            }
          }
          noteApprox(t)
          continue
        }

        if (t.kind === 'deform') {
          const d = t.frames[0] as unknown as DeformRecord
          // 一条时间轴可以驱动多个网格:父网格本身 + 继承它时间轴的 linkedmesh
          const geos = (skinnedByKey.get(`${skinNameOf(d.skin)}/${t.owner}/${d.attachment}`) ?? []).filter((g) => g.nodeIndex >= 0)
          if (geos.length === 0) {
            const type = attachmentTypeOf(skinNameOf(d.skin), t.owner, d.attachment)
            if (type === 'clipping') {
              // 遮罩的形状变化在 SpriteMask 那边转(每种形状一个物体),见 maskBuilds
            } else if (type !== null && type !== 'mesh' && type !== 'linkedmesh') {
              // 实测 MergeCooking2 的 wave:deform 打在 path 上(路径约束用),没有可渲染的东西
              issues.add('info', `deform[${t.owner}]`, `deform 指向的 "${d.attachment}" 是 ${type},不参与渲染,已跳过`)
            } else {
              issues.loss(
                `deform[${t.owner}]`,
                `找不到 deform 指向的网格 "${d.attachment}"(多半是图集里没有这张图),该时间轴已丢弃`,
              )
            }
            continue
          }
          for (const geo of geos) {
            // 关键帧之间分歧超过 0.5 像素:这条动画也改用逐帧修正
            const gap = deformGap(geo, anim, d)
            if (gap > 0.5) {
              deformCorrected.add(geo)
              issues.add('info', `deform[${geo.item.spriteName}]`, `关键帧之间 Blend Shape 与 Spine 最多差 ${gap.toFixed(1)} 像素,改为逐帧修正`)
              continue
            }
            approximated = convertDeform(geo, anim, d, floats) || approximated
          }
          noteApprox(t)
          continue
        }

        if (t.kind === 'shear' || t.kind === 'shearX' || t.kind === 'shearY') {
          issues.loss(`${t.kind}[${bone?.name ?? t.owner}]`, 'Unity 的 Transform 没有斜切(shear),该时间轴已丢弃')
          continue
        }

        if (t.kind === 'drawOrder' || t.kind === 'sequence') {
          continue // 时间轴循环之后统一转成 m_SortingOrder / m_Enabled 曲线
        } else if (t.kind === 'transform' || t.kind.startsWith('path')) {
          issues.loss(t.kind, 'Unity 没有 transform / path 约束的对应物,该时间轴已丢弃')
        } else if (t.kind === 'ik') {
          issues.loss('ik', 'Unity 没有 IK 约束的对应物,也没有把 IK 的结果烘进曲线 —— 受 IK 驱动的骨骼会停在自己的关键帧上,外观会不一致')
        } else if (t.kind === 'event') {
          issues.add('info', 'event', 'Spine 事件没有转成 Unity 的 AnimationEvent(没有对应的回调函数名)')
        }
      }

      // 逐帧绘制顺序:挪过位的 slot 每条动画都写 m_SortingOrder 阶梯曲线
      if (drawOrderSlots.size > 0) {
        const timeline = timelines.find((t) => t.kind === 'drawOrder')
        const frames = [...(timeline?.frames ?? [])].sort((a, b) => (a['time'] as number) - (b['time'] as number))
        const layers = frames.map((f) => ({
          time: f['time'] as number,
          layer: layerOfSlot(drawOrderOf(part.slots.length, (f['offsets'] as DrawOrderOffset[] | undefined) ?? [])),
        }))
        for (const slot of drawOrderSlots) {
          const list = slotNodes.get(slot)
          if (list === undefined) continue
          const keys: UnityKeyframe[] = []
          // 第一帧之前是 setup 顺序 —— 0 处补一个 setup 值(帧正好在 0 就不用)
          if (layers.length === 0 || layers[0]!.time > 0) keys.push(key(0, slot, true))
          for (const l of layers) keys.push(key(l.time, l.layer[slot]!, true))
          for (const item of list) {
            floats.push({
              path: paths[item.node]!,
              attribute: 'm_SortingOrder',
              classID: skinnedByItem.has(item) ? 137 : 212,
              keys,
            })
          }
        }
      }

      // 遮罩:开关 + 换形状,都落在各个 SpriteMask 物体的 m_Enabled 上,同一时刻只亮一个
      for (const b of maskBuilds) {
        const steps = b.shapeSteps.get(anim.name)
        if (!clipToggled(anim, b.group) && steps === undefined) continue
        const onSteps = clipOnSteps(part, b.group, anim)
        const shapeSteps = steps ?? [{ t: 0, shape: 0 }]
        const at = <T,>(list: readonly { t: number }[], t: number, pick: (i: number) => T): T => {
          let i = 0
          for (let k = 0; k < list.length; k++) if (list[k]!.t <= t + 1e-9) i = k
          return pick(i)
        }
        const times = [...new Set([...onSteps.map((s) => s.t), ...shapeSteps.map((s) => s.t)])].sort((x, y) => x - y)
        const active = times.map((t) => (at(onSteps, t, (i) => onSteps[i]!.on) ? at(shapeSteps, t, (i) => shapeSteps[i]!.shape) : -1))
        b.nodes.forEach((node, k) => {
          const me = k === b.nodes.length - 1 ? -1 : k
          const keys: UnityKeyframe[] = []
          times.forEach((t, i) => {
            const v = active[i] === me ? 1 : 0
            if (keys.length > 0 && keys[keys.length - 1]!.value === v) return
            keys.push(key(t, v, true))
          })
          floats.push({ path: paths[node]!, attribute: 'm_Enabled', classID: 331, keys })
        })
      }

      writeSequenceCurves(anim, timelines, floats)
      for (const geo of skinned) {
        if (deformCorrected.has(geo) && geo.nodeIndex >= 0) correctionShapes(geo, anim, timelines, floats)
      }
    })

    const guid = unityGuid(`${name}/clip/${anim.name}`)
    clipGuids.set(anim.name, guid)
    const clipName = sanitize(`${name}@${anim.name}`)
    files.push({
      path: `${clipName}.anim`,
      content: writeAnim({
        name: clipName,
        sampleRate: part.header.fps ?? 30,
        loop: true,
        position,
        euler,
        scale: scaleCurves,
        float: floats,
        pptr: [],
      }),
    })
    files.push({ path: `${clipName}.anim.meta`, content: writeNativeMeta(guid, CLIP_FILE_ID) })
  }

  // ── 6. 汇总产物 ──
  baked.pages.forEach((page, i) => {
    const pageName = pageNames[i]!
    files.push({ path: `${pageName}.png`, content: options.skipImages === true ? '' : encodePng(page) })
    files.push({
      path: `${pageName}.png.meta`,
      content: writeTextureMeta({
        guid: textureGuids[i]!,
        // ⚠️ 不是 options.pixelsPerUnit —— 要抵消图集导出时的缩放
        pixelsPerUnit: texturePpu,
        sprites: metaSprites[i]!,
      }),
    })
  })

  // ── SkinnedMeshRenderer 的 Mesh 资产与材质 ──
  for (const geo of skinned) {
    if (geo.nodeIndex < 0) continue
    const node = nodes[geo.nodeIndex]!
    nodes[geo.nodeIndex] = { ...node, skinnedMesh: { ...node.skinnedMesh!, blendShapeCount: geo.shapes.length } }
    const assetName = `${name}@${geo.item.spriteName}`
    files.push({
      path: `${assetName}.asset`,
      content: writeMesh({
        name: assetName,
        vertices: geo.vertices,
        triangles: geo.triangles,
        bindposes: geo.slots.map((s) => s.bindpose),
        weights: geo.weights,
        blendShapes: geo.shapes,
      }),
    })
    files.push({ path: `${assetName}.asset.meta`, content: writeNativeMeta(meshGuidOf(geo.item.spriteName), MESH_FILE_ID) })
  }
  // SkinnedMeshRenderer 不会像 SpriteRenderer 那样自动带上 sprite 的纹理,材质要显式引用图集页
  for (const page of new Set(skinned.map((g) => g.page))) {
    const pageName = pageNames[page]!
    files.push({
      path: `${pageName}.mat`,
      content: writeSpriteMaterial({
        name: pageName,
        renderPipeline: options.renderPipeline,
        texture: { fileID: TEXTURE_FILE_ID, guid: textureGuids[page]! },
      }),
    })
    files.push({ path: `${pageName}.mat.meta`, content: writeNativeMeta(materialGuids[page]!, MATERIAL_FILE_ID) })
  }
  // 遮罩贴图:16×16 全白,每种形状一个 sprite(网格 = 多边形,归一到包围盒里),外加一个整块的给「不遮」用
  if (maskBuilds.length > 0) {
    const sprites: MetaSprite[] = []
    const unweighted = (n: number): MetaWeight[] => Array.from({ length: n }, () => ({ weights: [1, 0, 0, 0] as const, bones: [0, 0, 0, 0] as const }))
    maskBuilds.forEach((b, bi) => {
      b.shapes.forEach((shape, k) => {
        sprites.push({
          name: `${b.base}_${k}`,
          rect: { x: 0, y: 0, width: CLIP_RECT, height: CLIP_RECT },
          pivot: { x: 0, y: 0 },
          spriteID: unityGuid(`${name}/clip-spriteid/${bi}/${k}`),
          internalID: maskSpriteId(bi, k),
          vertices: shape.map((p) => ({ x: ((p.x - b.min.x) / b.size.x) * CLIP_RECT, y: ((p.y - b.min.y) / b.size.y) * CLIP_RECT })),
          triangles: triangulatePolygon(shape),
          bones: [],
          weights: unweighted(shape.length),
        })
      })
      sprites.push({
        name: `${b.base}_off`,
        rect: { x: 0, y: 0, width: CLIP_RECT, height: CLIP_RECT },
        pivot: { x: 0.5, y: 0.5 },
        spriteID: unityGuid(`${name}/clip-spriteid/${bi}/off`),
        internalID: maskSpriteId(bi, -1),
        vertices: [{ x: 0, y: 0 }, { x: CLIP_RECT, y: 0 }, { x: CLIP_RECT, y: CLIP_RECT }, { x: 0, y: CLIP_RECT }],
        triangles: [0, 1, 2, 0, 2, 3],
        bones: [],
        weights: unweighted(4),
      })
    })
    const white = { width: CLIP_RECT, height: CLIP_RECT, data: new Uint8Array(CLIP_RECT * CLIP_RECT * 4).fill(255) }
    files.push({ path: `${name}@clip.png`, content: options.skipImages === true ? '' : encodePng(white) })
    files.push({ path: `${name}@clip.png.meta`, content: writeTextureMeta({ guid: maskTextureGuid, pixelsPerUnit: CLIP_RECT, sprites }) })
  }
  for (const page of maskedPages) {
    const pageName = pageNames[page]!
    files.push({
      path: `${pageName}@clip.mat`,
      content: writeSpriteMaterial({ name: `${pageName}@clip`, renderPipeline: options.renderPipeline, texture: { fileID: TEXTURE_FILE_ID, guid: textureGuids[page]! }, masked: true }),
    })
    files.push({ path: `${pageName}@clip.mat.meta`, content: writeNativeMeta(maskedMaterialGuids[page]!, MATERIAL_FILE_ID) })
  }
  for (const [file, m] of [...blendMaterials].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    files.push({
      path: file,
      content: writeSpriteMaterial({
        name: file.slice(0, -'.mat'.length),
        renderPipeline: options.renderPipeline,
        texture: m.page === null ? null : { fileID: TEXTURE_FILE_ID, guid: textureGuids[m.page]! },
        masked: m.masked,
        blend: m.blend,
      }),
    })
    files.push({ path: `${file}.meta`, content: writeNativeMeta(m.guid, MATERIAL_FILE_ID) })
  }

  if (skinned.length > 0) {
    const shapes = skinned.reduce((n, g) => n + g.shapes.length, 0)
    issues.add(
      'info',
      'skinnedMesh',
      `${skinned.length} 个网格走 SkinnedMeshRenderer,deform 已转成 ${shapes} 个 Blend Shape 形变目标`,
    )
  }
  // 工程 Quality 的 Skin Weights 是 SkinnedMeshRenderer 的上限(实测,渲染器写 Bone4 也盖不过)——
  // 截到的档位里这些网格会变形。SpriteSkin 不受影响,所以只看走 SkinnedMeshRenderer 的
  if (options.qualityLevels !== undefined) {
    const needs = skinned.map((geo) => Math.max(1, ...geo.effective.map((e) => e.length)))
    const need = Math.max(1, ...needs)
    const capOf = (l: QualityLevel) => (l.skinWeights === UNLIMITED_SKIN_WEIGHTS ? Infinity : l.skinWeights)
    const short = options.qualityLevels.filter((l) => capOf(l) < need)
    if (short.length > 0) {
      const lowest = Math.min(...short.map(capOf))
      const hit = needs.filter((n) => n > lowest).length
      issues.add(
        'approximated',
        'skinnedMesh',
        `工程 Quality 的 Skin Weights 不够:${short.map((l) => `${l.name}(${skinWeightsLabel(l.skinWeights)})`).join('、')} —— ` +
          `${hit} 个走 SkinnedMeshRenderer 的网格每顶点最多用到 ${need} 根骨骼,在这些档位会被截掉、变形` +
          `(Skin Weights 是上限,渲染器写 Bone4 也盖不过;SpriteSkin 不受影响)。` +
          `Project Settings ▸ Quality 把这些档设成 ${need > 4 ? 'Unlimited' : 'Four Bones'}`,
      )
    }
  }
  for (const spriteName of skinnedColorLoss) {
    issues.loss(`color.${spriteName}`, 'slot 颜色动画在 SkinnedMeshRenderer 上没有对应属性(静态颜色已烘进顶点色),已丢弃')
  }
  if (tintedMeshes.length > 0) {
    issues.add(
      'info',
      'skinnedMesh',
      `${tintedMeshes.length} 个走 SkinnedMeshRenderer 的网格带颜色(slot × attachment),烘进顶点色;` +
        (colorSpace === 'linear'
          ? '按 Linear 工程换成线性值(Unity 不对顶点色做 sRGB 换算)—— Gamma 工程要用 --color-space gamma 重新导出'
          : '按 Gamma 工程原样写 —— Linear 工程里会偏亮,要用 --color-space linear 重新导出'),
    )
  }

  // ── 皮肤层:每套皮肤一条静态 clip,只写挂图节点的 m_IsActive ──
  // 剪辑名 <骨架>@skin@<皮肤>,和动画剪辑区分开(AnimatorGoRender 靠这个跳过它们)
  const skinClips: { name: string; guid: string }[] = []
  for (const skin of scriptMode ? [] : skinStates) {
    const clipName = sanitize(`${name}@skin@${skin.name}`)
    const guid = unityGuid(`${name}/skin/${skin.name}`)
    const skinFloats: FloatCurve[] = []
    for (const item of used) {
      if (item.node < 0) continue
      const on = visibleUnderSkin(item, skin) ? 1 : 0
      // 两个键撑出一点长度,免得零长度 clip 在某些版本里被当成空
      skinFloats.push({ path: paths[item.node]!, attribute: 'm_IsActive', classID: 1, keys: [key(0, on, true), key(1 / 60, on, true)] })
    }
    files.push({
      path: `${clipName}.anim`,
      content: writeAnim({
        name: clipName,
        sampleRate: part.header.fps ?? 30,
        loop: false,
        position: [],
        euler: [],
        scale: [],
        float: skinFloats,
        pptr: [],
      }),
    })
    files.push({ path: `${clipName}.anim.meta`, content: writeNativeMeta(guid, CLIP_FILE_ID) })
    skinClips.push({ name: skin.name, guid })
  }

  // ── 带脚本模式:AnimatorGoSkins 组件的数据 —— 换装件的软引用,以及每套皮肤要灭掉的默认皮肤件 ──
  let skinsComponent: SkinsComponentSpec | null = null
  if (scriptMode) {
    const folder = options.assetFolder === undefined || options.assetFolder === '' ? '' : `${options.assetFolder.replace(/\/+$/, '')}/`
    const componentNodes: SkinsComponentSpec['nodes'][number][] = []
    for (const item of used) {
      if (item.node < 0 || isDefaultSkin(item.skin)) continue
      const info = sprites.get(item.spriteName)
      if (info === undefined) continue
      const page = pageNames[info.page]!
      const material = info.skinned ? skinnedMaterialOf(item, info.page) : null
      componentNodes.push({
        node: item.node,
        skin: item.skin,
        spriteAsset: `${folder}${page}.png`,
        spriteGuid: textureGuids[info.page]!,
        spriteName: info.skinned ? '' : item.spriteName,
        materialAsset: material === null ? '' : `${folder}${material.file}`,
        materialGuid: material === null ? '' : material.ref.guid,
      })
    }
    skinsComponent = {
      defaultSkin: defaultSkin?.name ?? 'default',
      initialSkin: initialSkin?.name ?? defaultSkin?.name ?? 'default',
      nodes: componentNodes,
      skins: skinStates
        .filter((s) => s !== defaultSkin)
        .map((skin) => ({
          name: skin.name,
          hidden: used.filter((item) => item.node >= 0 && isDefaultSkin(item.skin) && !visibleUnderSkin(item, skin)).map((item) => item.node),
        })),
    }
  }

  const controllerGuid = unityGuid(`${name}/controller`)
  const prefabGuid = unityGuid(`${name}/prefab`)
  const needsController = part.animations.length > 0 || skinClips.length > 0

  files.push({
    path: `${name}.prefab`,
    content: writePrefab(nodes, {
      seed: name,
      controller: needsController ? { fileID: 9100000, guid: controllerGuid } : null,
      renderPipeline: options.renderPipeline,
      skins: skinsComponent,
    }),
  })
  files.push({ path: `${name}.prefab.meta`, content: writePrefabMeta(prefabGuid) })

  if (needsController) {
    files.push({
      path: `${name}.controller`,
      content: writeController(
        name,
        part.animations.map((a) => ({ name: sanitize(`${name}@${a.name}`), guid: clipGuids.get(a.name)! })),
        skinClips.length > 0 ? [{ name: 'Skin', states: skinClips, defaultState: initialSkin?.name ?? skinClips[0]!.name }] : [],
      ),
    })
    files.push({ path: `${name}.controller.meta`, content: writeNativeMeta(controllerGuid, 9100000) })
  }

  const blendMats = [...blendMaterials.values()]
  const runtime = [
    ...(maskedPages.size > 0 || blendMats.some((m) => m.masked) ? [MASKED_MESH_SHADER_FILE] : []),
    ...(blendMats.some((m) => !m.masked) ? [BLEND_SHADER_FILES[options.renderPipeline]] : []),
  ]
  return { files, issues: issues.all, runtime }
}

/**
 * 把 slot 颜色时间轴拆成 Unity 的四条单值曲线。
 *
 * 返回 `[属性名, 每帧的值, 曲线分量下标, 绑定姿势的值]`。
 * 3.8 把颜色打包成一个 int 且整条时间轴共用一条曲线,4.x 逐通道存字节、每通道一条曲线。
 */
function colorChannels(
  t: Timeline,
  setup: { r: number; g: number; b: number; a: number },
): [string, number[], number, number][] | null {
  const names = ['m_Color.r', 'm_Color.g', 'm_Color.b', 'm_Color.a']
  const setups = [setup.r, setup.g, setup.b, setup.a]

  if (t.kind === 'color' || t.kind === 'twoColor') {
    return names.map((attribute, i) => [
      attribute,
      t.frames.map((f) => {
        const packed = (f['colors'] as number[])[0]!
        return ((packed >>> (24 - i * 8)) & 0xff) / 255
      }),
      0,
      setups[i]!,
    ])
  }

  // 4.x:1=RGBA 2=RGB 3=RGBA+暗色 4=RGB+暗色 5=只有 A
  const layout: Record<string, number[]> = {
    slotColor1: [0, 1, 2, 3],
    slotColor2: [0, 1, 2],
    slotColor3: [0, 1, 2, 3],
    slotColor4: [0, 1, 2],
    slotColor5: [3],
  }
  const channels = layout[t.kind]
  if (channels === undefined) return null

  return channels.map((target, component) => [
    names[target]!,
    t.frames.map((f) => (f['color'] as number[])[component]! / 255),
    component,
    setups[target]!,
  ])
}
