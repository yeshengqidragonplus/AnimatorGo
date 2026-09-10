import type { SkeletonPart } from '../../spine-format/binary/readSkeleton.ts'
import type { Attachment, Skin } from '../../spine-format/binary/readSkins.ts'
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
import { writePrefab, type PrefabNode, type RenderPipeline, type RendererSpec, type SkinSpec } from '../../unity/writePrefab.ts'
import { writeController, CLIP_FILE_ID } from '../../unity/writeController.ts'
import { writeNativeMeta, writePrefabMeta, writeTextureMeta, type MetaBone, type MetaSprite, type MetaWeight } from '../../unity/writeMeta.ts'
import { unityGuid, internalId, uniqueIds } from '../../unity/ids.ts'
import { encodePng, type Image } from '../../unity/png.ts'
import { writeMesh, MESH_FILE_ID, type BlendShape, type BoneInfluence, type MeshVertex } from '../../unity/writeMesh.ts'
import { writeSpriteMaterial, MATERIAL_FILE_ID, TEXTURE_FILE_ID } from '../../unity/writeMaterial.ts'
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
 * - clipping 遮罩
 * - 皮肤:一次只导一套(默认 + `skin` 选的),Unity 没有运行时切皮肤的对应物
 *
 * 逐帧绘制顺序(drawOrder)→ 挪过位的 slot 每条动画一条 `m_SortingOrder` 阶梯曲线。
 */

export interface UnityExportOptions {
  /** 资源基名,决定文件名和 prefab 根物体的名字 */
  readonly name: string
  /** Spine 像素 → Unity 世界单位的换算,Unity 导入图片时的默认值是 100 */
  readonly pixelsPerUnit: number
  /** 决定 SpriteRenderer 用哪个默认材质 —— 给错了整个角色是粉红的 */
  readonly renderPipeline: RenderPipeline
  /**
   * SkinnedMeshRenderer 每顶点用几根骨骼蒙皮。默认 `bone4`:写死 4 根,外观不随工程
   * Quality 档位变(学 Spine)。`auto` 跟随 Quality —— 只有所有档位都设成 Unlimited 时
   * 才划算(能吃满 >4 根);真实工程的 Low/Medium 档往往只有 2 根,会比 SpriteSkin 还差。
   */
  readonly skinQuality?: 'bone4' | 'auto'
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
}

export interface UnityFile {
  /** 相对输出目录的路径 */
  readonly path: string
  readonly content: string | Uint8Array
}

export interface UnityExportResult {
  readonly files: readonly UnityFile[]
  readonly issues: readonly ConversionIssue[]
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
  /** 参与蒙皮的骨骼(骨架下标),顺序即 bindposes 顺序 */
  readonly subset: readonly number[]
  readonly vertices: readonly MeshVertex[]
  readonly triangles: readonly number[]
  /** Spine 的完整权重,骨骼用 subset 下标 —— 写进 Mesh */
  readonly weights: readonly (readonly BoneInfluence[])[]
  /** Unity 实际用来蒙皮的权重(Bone4 时是前 4 根归一),骨骼用**骨架**下标 —— 反解增量用 */
  readonly effective: readonly (readonly { bone: number; weight: number }[])[]
  /** 原始的逐影响局部坐标,算 Spine 那边的世界偏移用 */
  readonly localVerts: SpineVertices
  readonly slotBone: number
  readonly bindposes: readonly Affine[]
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
  part: SkeletonPart,
  atlas: Atlas,
  sources: ReadonlyMap<string, Image>,
  options: UnityExportOptions,
): UnityExportResult {
  const issues = new IssueCollector()
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
  const setupUnityInv = setupUnity.map((m) => invert(linear(m)))
  const skinQuality: 0 | 4 = options.skinQuality === 'auto' ? 0 : 4

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

  const skinned: SkinnedGeometry[] = []
  const skinnedByItem = new Map<SlotAttachment, SkinnedGeometry>()
  const skinnedByKey = new Map<string, SkinnedGeometry>()
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
  if (skinStates.length > 0) {
    issues.add(
      'info',
      'skin',
      `${skinStates.length} 套皮肤全部导进一个 prefab(${skinStates.map((s) => `"${s.name}"`).join('、')}),初始 "${initialSkin?.name}";` +
        '运行时切换:animator.Play("皮肤名", 1)',
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
  /** 挂图节点名:slot 名(键名与 slot 同名)或 slot__键名;具名皮肤的再带 @皮肤名,免得和别的皮肤同键名的撞 */
  const attachmentNodeName = (item: SlotAttachment, slotName: string): string => {
    const base = item.key === slotName ? slotName : `${slotName}__${item.key}`
    return sanitize(isDefaultSkin(item.skin) ? base : `${base}@${item.skin}`)
  }

  // ── 1. 收集 attachment ──
  const used: SlotAttachment[] = []
  const spriteNames = new Set<string>()

  for (const skin of part.skins) {
    for (const entry of skin.slots) {
      for (const attachment of entry.attachments) {
        if (attachment.type === 'region' || attachment.type === 'mesh') {
          const regionName = regionNameOf(attachment)
          // region 的几何完全由图集决定,同名的可以共用一个 sprite;
          // mesh 各有各的顶点和 pivot,必须一图一份
          let spriteName =
            attachment.type === 'region' ? sanitize(regionName) : sanitize(attachment.name)
          if (attachment.type === 'mesh') {
            let salt = 1
            while (spriteNames.has(spriteName)) spriteName = `${sanitize(attachment.name)}_${++salt}`
          }
          spriteNames.add(spriteName)
          used.push({
            slot: entry.slot,
            skin: skin.name,
            key: attachment.key,
            attachment,
            regionName,
            spriteName,
            node: -1,
          })
        } else if (attachment.type === 'linkedmesh') {
          issues.loss(`attachment.${attachment.key}`, 'linkedmesh(共享网格)没有对应物,已丢弃')
        } else if (attachment.type === 'clipping') {
          issues.loss(`attachment.${attachment.key}`, 'Unity 没有 clipping 遮罩的对应物,已丢弃')
        } else if (attachment.type === 'path' || attachment.type === 'boundingbox' || attachment.type === 'point') {
          issues.add('info', `attachment.${attachment.key}`, `${attachment.type} 不参与渲染,已跳过`)
        }
      }
    }
  }

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
  const baked = bakeAtlas(atlas, straightSources, used.map((u) => u.regionName))
  for (const missing of baked.missing) {
    issues.loss(`region.${missing}`, `图集里没有 "${missing}",用到它的部件不会显示`)
  }
  if (baked.pages.length > 1) {
    issues.add(
      'info',
      'atlas',
      `烘焙后有 ${baked.pages.length} 张图集页 —— 一个 SpriteRenderer 只能引用一张图,` +
        '跨页的部件会分批渲染',
    )
  }

  const textureGuids = baked.pages.map((_, i) => unityGuid(`${name}/texture/${i}`))
  const materialGuids = baked.pages.map((_, i) => unityGuid(`${name}/material/${i}`))

  // ── 图集缩放 ──
  // Spine 导出图集时可以带缩放,`.atlas` 里没记,只能从数据反推。
  // 它不改任何坐标,只决定纹理的 spritePixelsToUnits。
  const scaleSamples = used.flatMap((u) => {
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

  /** 把一个网格整理成 SkinnedMeshRenderer 要的几何(骨架根空间,Unity 单位) */
  const buildSkinnedGeometry = (item: SlotAttachment, rect: BakedRect, slotBone: number, reasons: string[]): SkinnedGeometry => {
    const data = item.attachment.data
    const verts = data['vertices'] as SpineVertices
    const vertexCount = data['vertexCount'] as number
    const uvs = data['uvs'] as number[]
    const triangles = data['triangles'] as number[]
    const page = baked.pages[rect.page]!
    const color = unpackColor(part.slots[item.slot]!.color)
    const subset = verts.weighted ? boneSubset(verts.weights) : [slotBone]
    const subsetIndex = new Map<number, number>()
    subset.forEach((b, i) => subsetIndex.set(b, i))

    const vertices: MeshVertex[] = []
    const weights: BoneInfluence[][] = []
    const effective: { bone: number; weight: number }[][] = []
    let over4 = false
    for (let j = 0; j < vertexCount; j++) {
      let px = 0
      let py = 0
      if (verts.weighted) {
        const list: BoneInfluence[] = []
        for (const w of verts.weights[j]!) {
          const p = applyPoint(setupSpine[w.bone]!, w.x, w.y)
          px += w.weight * p.x
          py += w.weight * p.y
          list.push({ bone: subsetIndex.get(w.bone)!, weight: w.weight })
        }
        weights.push(list)
        const sorted = verts.weights[j]!.filter((w) => w.weight > 0).sort((p, q) => q.weight - p.weight)
        over4 ||= sorted.length > 4
        const kept = skinQuality === 4 ? sorted.slice(0, 4) : sorted
        const total = kept.reduce((n, w) => n + w.weight, 0) || 1
        effective.push(kept.map((w) => ({ bone: w.bone, weight: w.weight / total })))
      } else {
        const p = applyPoint(setupSpine[slotBone]!, verts.positions[j * 2]!, verts.positions[j * 2 + 1]!)
        px = p.x
        py = p.y
        weights.push([{ bone: 0, weight: 1 }])
        effective.push([{ bone: slotBone, weight: 1 }])
      }
      // UV:Spine 的 uv 相对未裁剪原图 → 裁剪矩形内像素 → 烘焙页上的像素 → 归一化
      const r = uvToRect(uvs[j * 2]!, uvs[j * 2 + 1]!, rect.region)
      vertices.push({
        x: px * scale,
        y: py * scale,
        u: (rect.x + r.x) / page.width,
        v: (rect.y + r.y) / page.height,
        color,
      })
    }

    if (over4) {
      if (skinQuality === 4) {
        issues.add(
          'approximated',
          `mesh.${item.spriteName}`,
          '每顶点超过 4 根骨骼,SkinnedMeshRenderer 写死 Bone4,取权重最大的四根并重新归一化' +
            '(完整权重已写入 Mesh;工程 Quality 全部档位设 Unlimited 并加 --skin-quality auto 可用满)',
        )
      } else {
        issues.add(
          'info',
          `mesh.${item.spriteName}`,
          '每顶点超过 4 根骨骼,完整权重已写入 Mesh;只有工程 Quality **所有**档位都是 Unlimited 时才会全部生效',
        )
      }
    }

    const bindposes = subset.map((b) => {
      const inv = invert(toUnits(setupUnity[b]!))
      if (inv === null) {
        issues.loss(`mesh.${item.spriteName}`, `骨骼 "${part.bones[b]!.name}" 在绑定姿势下缩放为 0,绑定矩阵不可逆,该骨骼按单位矩阵处理`)
        return IDENTITY
      }
      return inv
    })
    issues.add('info', `mesh.${item.spriteName}`, `走 SkinnedMeshRenderer:${reasons.join('、')}`)

    return {
      item,
      page: rect.page,
      subset,
      vertices,
      triangles: [...triangles],
      weights,
      effective,
      localVerts: verts,
      slotBone,
      bindposes,
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
    if (
      deformTargets.has(`${item.skin}/${item.slot}/${item.key}`) ||
      deformTargets.has(`${item.skin}/${item.slot}/${item.attachment.name}`)
    ) {
      reasons.push('有 deform 顶点动画')
    }
    // 残差按 sprite 跨度的相对值判 —— 500 像素的大图差 2 像素看不出来,
    // 40 像素的小图差 2 像素就很明显
    if (mesh.residual > Math.max(1, extent * 0.02)) {
      reasons.push(`绑定姿势非刚性(残差 ${mesh.residual.toFixed(1)} 像素,占跨度 ${((mesh.residual / extent) * 100).toFixed(1)}%)`)
    }
    const own = attachmentScale(item.attachment, region)
    if (own !== null && own.extent >= 64 && Math.abs(own.scale / k - 1) > 0.02) {
      reasons.push(`图集缩放 ${own.scale.toFixed(3)} 与全局 ${k.toFixed(3)} 不一致`)
    }
    if (reasons.length > 0) {
      const geo = buildSkinnedGeometry(item, rect, slotBone, reasons)
      skinned.push(geo)
      skinnedByItem.set(item, geo)
      skinnedByKey.set(`${item.skin}/${item.slot}/${item.key}`, geo)
      skinnedByKey.set(`${item.skin}/${item.slot}/${item.attachment.name}`, geo)
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
          material: { fileID: MATERIAL_FILE_ID, guid: materialGuids[info.page]! },
          // 换图那一维:setup pose 只亮 attachmentName 那一个
          enabled: item.key === slot.attachmentName,
          bones: geo.subset.map((b) => boneNode[b]!),
          rootBone: boneNode[geo.subset[0]!]!,
          blendShapeCount: 0, // 动画转完再补
          sortingOrder: item.slot,
          quality: skinQuality,
        },
      })
      continue
    }

    const color = unpackColor(slot.color)
    const renderer: RendererSpec = {
      sprite: { fileID: info.internalID, guid: textureGuids[info.page]! },
      // Spine 的 slots 数组顺序就是绘制顺序,先画的在下层
      sortingOrder: item.slot,
      color,
      // 换图那一维:setup pose 只亮 attachmentName 那一个;表情变体初始是灭的
      enabled: item.key === slot.attachmentName,
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

  /** Unity 在姿势 P 下作用在增量上的矩阵:Σ w'ᵢ · Bᵢ(P) · Bᵢ(S)⁻¹(只取线性部分) */
  const unityDeformMatrix = (effective: readonly { bone: number; weight: number }[], poseU: readonly Affine[]): Affine => {
    let a = 0
    let b = 0
    let c = 0
    let d = 0
    for (const w of effective) {
      const inv = setupUnityInv[w.bone]
      if (inv === null || inv === undefined) continue
      const m = multiply(linear(poseU[w.bone]!), inv)
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
      const inv = invert(unityDeformMatrix(geo.effective[j]!, poseU))
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
          const u = applyVector(unityDeformMatrix(geo.effective[j]!, poseU), mx, my)
          worst = Math.max(worst, Math.hypot(sx - u.x, sy - u.y))
        }
      }
    }
    return worst
  }

  /** 把一条 deform 时间轴转成形变目标 + 权重曲线;返回是否有曲线被近似 */
  const convertDeform = (geo: SkinnedGeometry, anim: AnimationData, d: DeformRecord, floats: FloatCurve[]): boolean => {
    const frames = d.frames
    const n = frames.length
    if (n === 0) return false
    const verts = geo.localVerts
    const flatLength = verts.weighted ? verts.weights.reduce((s, w) => s + w.length * 2, 0) : verts.positions.length
    const flats = frames.map((f) => offsetsOf(f, flatLength))
    const times = frames.map((f) => f['time'] as number)
    const deltas = flats.map((flat, k) => (flat.some((v) => Math.abs(v) > 1e-9) ? shapeDeltas(geo, anim, times[k]!, flat) : null))

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

  // ── 5. 动画 ──
  const clipGuids = new Map<string, string>()
  const files: UnityFile[] = []

  for (const anim of part.animations) {
    const position: Vector3Curve[] = []
    const euler: Vector3Curve[] = []
    const scaleCurves: Vector3Curve[] = []
    const floats: FloatCurve[] = []

    issues.scoped(anim.name, () => {
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

      for (const t of anim.timelines) {
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
            const keys: UnityKeyframe[] = []
            if (times[0]! > 0) keys.push(key(0, slot.attachmentName === item.key ? 1 : 0, true))
            times.forEach((time, i) => keys.push(key(time, names[i] === item.key ? 1 : 0, true)))
            const classID = sprites.get(item.spriteName)?.skinned === true ? 137 : 212
            floats.push({ path: paths[item.node]!, attribute: 'm_Enabled', classID, keys })
          }
          continue
        }

        // slot 颜色 → SpriteRenderer.m_Color
        if (t.kind === 'color' || t.kind.startsWith('slotColor')) {
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
            // 颜色的取值已经是 0..1,与贝塞尔 cy 同一空间,不用再变换
            const s = withSetup(times, values, segmentsOf(t.frames, values, (v) => v, is38, component), setupValue)
            const curve = toUnityCurve(s.times, s.values, s.segments)
            approximated ||= curve.approximated
            for (const item of list) {
              if (skinnedByItem.has(item)) {
                skinnedColorLoss.add(item.spriteName)
                continue
              }
              floats.push({ path: paths[item.node]!, attribute, classID: 212, keys: curve.keys })
            }
          }
          noteApprox(t)
          continue
        }

        if (t.kind === 'deform') {
          const d = t.frames[0] as unknown as DeformRecord
          const geo = skinnedByKey.get(`${skinNameOf(d.skin)}/${t.owner}/${d.attachment}`)
          if (geo === undefined || geo.nodeIndex < 0) {
            const type = attachmentTypeOf(skinNameOf(d.skin), t.owner, d.attachment)
            if (type !== null && type !== 'mesh' && type !== 'linkedmesh') {
              // 实测 MergeCooking2 的 wave:deform 打在 path 上(路径约束用),没有可渲染的东西
              issues.add('info', `deform[${t.owner}]`, `deform 指向的 "${d.attachment}" 是 ${type},不参与渲染,已跳过`)
            } else {
              issues.loss(
                `deform[${t.owner}]`,
                `找不到 deform 指向的网格 "${d.attachment}"(${type === 'linkedmesh' ? 'linkedmesh 尚未支持' : '多半是图集里没有这张图'}),该时间轴已丢弃`,
              )
            }
            continue
          }
          approximated ||= convertDeform(geo, anim, d, floats)
          noteApprox(t)
          continue
        }

        if (t.kind === 'shear' || t.kind === 'shearX' || t.kind === 'shearY') {
          issues.loss(`${t.kind}[${bone?.name ?? t.owner}]`, 'Unity 的 Transform 没有斜切(shear),该时间轴已丢弃')
          continue
        }

        if (t.kind === 'drawOrder') {
          continue // 时间轴循环之后统一转成 m_SortingOrder 曲线
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
        const timeline = anim.timelines.find((t) => t.kind === 'drawOrder')
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
    const pageName = baked.pages.length === 1 ? name : `${name}_${i}`
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
        bindposes: geo.bindposes,
        weights: geo.weights,
        blendShapes: geo.shapes,
      }),
    })
    files.push({ path: `${assetName}.asset.meta`, content: writeNativeMeta(meshGuidOf(geo.item.spriteName), MESH_FILE_ID) })
  }
  // SkinnedMeshRenderer 不会像 SpriteRenderer 那样自动带上 sprite 的纹理,材质要显式引用图集页
  for (const page of new Set(skinned.map((g) => g.page))) {
    const pageName = baked.pages.length === 1 ? name : `${name}_${page}`
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
  if (skinned.length > 0) {
    const shapes = skinned.reduce((n, g) => n + g.shapes.length, 0)
    issues.add(
      'info',
      'skinnedMesh',
      `${skinned.length} 个网格走 SkinnedMeshRenderer,deform 已转成 ${shapes} 个 Blend Shape 形变目标`,
    )
  }
  for (const spriteName of skinnedColorLoss) {
    issues.loss(`color.${spriteName}`, 'slot 颜色动画在 SkinnedMeshRenderer 上没有对应属性(静态颜色已烘进顶点色),已丢弃')
  }

  // ── 皮肤层:每套皮肤一条静态 clip,只写挂图节点的 m_IsActive ──
  // 剪辑名 <骨架>@skin@<皮肤>,和动画剪辑区分开(AnimatorGoRender 靠这个跳过它们)
  const skinClips: { name: string; guid: string }[] = []
  for (const skin of skinStates) {
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

  const controllerGuid = unityGuid(`${name}/controller`)
  const prefabGuid = unityGuid(`${name}/prefab`)
  const needsController = part.animations.length > 0 || skinClips.length > 0

  files.push({
    path: `${name}.prefab`,
    content: writePrefab(nodes, {
      seed: name,
      controller: needsController ? { fileID: 9100000, guid: controllerGuid } : null,
      renderPipeline: options.renderPipeline,
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

  return { files, issues: issues.all }
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
