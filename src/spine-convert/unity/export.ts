import type { SkeletonPart } from '../../spine-format/binary/readSkeleton.ts'
import type { Attachment } from '../../spine-format/binary/readSkins.ts'
import type { Timeline } from '../../spine-format/binary/readAnimations.ts'
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
import { writePrefab, type PrefabNode, type RendererSpec, type SkinSpec } from '../../unity/writePrefab.ts'
import { writeController, CLIP_FILE_ID } from '../../unity/writeController.ts'
import { writeNativeMeta, writePrefabMeta, writeTextureMeta, type MetaBone, type MetaSprite, type MetaWeight } from '../../unity/writeMeta.ts'
import { unityGuid, internalId, uniqueIds } from '../../unity/ids.ts'
import { encodePng, type Image } from '../../unity/png.ts'
import { bakeAtlas } from './bakeAtlas.ts'
import { bindMesh, estimateAtlasScale } from './mesh.ts'

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
 * ## 转不过去的东西(见 docs/UNITY-2D.md)
 *
 * - deform 顶点关键帧 —— Unity 的 SpriteSkin 只做骨骼蒙皮
 * - path / transform 约束、IK
 * - 两色染色(dark color)
 * - 逐帧改变绘制顺序(drawOrder)—— sortingOrder 是静态的
 */

export interface UnityExportOptions {
  /** 资源基名,决定文件名和 prefab 根物体的名字 */
  readonly name: string
  /** Spine 像素 → Unity 世界单位的换算,Unity 导入图片时的默认值是 100 */
  readonly pixelsPerUnit: number
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
 * 取出各段的曲线定义。
 *
 * ⚠️ **控制点的 y 分量在 Spine 的原始值空间里**(平移是像素、缩放是倍率),
 * 而我们的 values 已经加过绑定姿势、换算过单位。两者必须用**同一个变换**,
 * 否则控制点和端点对不上,缓动会歪。
 *
 * `component` 选第几个分量的曲线:3.8 只有一条(共用),4.x 每分量各一条。
 */
function segmentsOf(
  frames: readonly Record<string, unknown>[],
  transformValue: (raw: number) => number,
  component = 0,
): (SpineSegment | undefined)[] {
  return frames.map((f, i) => {
    if (i === frames.length - 1) return undefined
    const curve = f['curve']
    if (curve === 'stepped') return { curve: 'stepped' as const }
    if (curve === 'bezier') {
      const all = f['beziers'] as number[][]
      const b = all[Math.min(component, all.length - 1)]!
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

function regionNameOf(attachment: Attachment): string {
  const path = attachment.data['path']
  return typeof path === 'string' && path.length > 0 ? path : attachment.name
}

/** Unity 的资源名不能带路径分隔符 */
function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_')
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

  for (const bone of part.bones) {
    if (bone.transformMode !== 0) {
      issues.add(
        'approximated',
        `bone.${bone.name}`,
        `Spine 的 transformMode=${bone.transformMode}(非默认继承)在 Unity 的 Transform 里没有对应物,已按普通继承处理`,
      )
    }
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
  const baked = bakeAtlas(atlas, sources, used.map((u) => u.regionName))
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
    /** 未加权网格才有:骨骼局部 → sprite 空间的刚体变换,节点要反着转回来 */
    readonly rigid: { rotation: number } | null
  }
  const sprites = new Map<string, SpriteInfo>()
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
      sprites.set(item.spriteName, { page: rect.page, internalID: internal, skinBones: null, rigid: null })
      metaSprites[rect.page]!.push({
        name: item.spriteName,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        pivot: {
          x: (region.originalWidth / 2 - region.offsetX) / region.width,
          y: (region.originalHeight / 2 - region.offsetY) / region.height,
        },
        spriteID,
        internalID: internal,
        vertices: [],
        triangles: [],
        bones: [],
        weights: [],
      })
      continue
    }

    // ── 网格 ──
    const slotBone = part.slots[item.slot]!.bone
    const mesh = bindMesh(item.attachment, region, slotBone, k)

    if (mesh.residual > 0.5) {
      issues.add(
        'approximated',
        `mesh.${item.spriteName}`,
        `绑定姿势拟合残差 ${mesh.residual.toFixed(1)} 像素 —— 该网格不是刚性绑定的,` +
          'Unity 的 SpriteSkin 只能做刚性蒙皮,形状会有偏差',
      )
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

    const color = unpackColor(slot.color)
    const renderer: RendererSpec = {
      sprite: { fileID: info.internalID, guid: textureGuids[info.page]! },
      // Spine 的 slots 数组顺序就是绘制顺序,先画的在下层
      sortingOrder: item.slot,
      color,
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
      // 未加权网格:整块跟着 slot 的骨骼刚性移动。
      // pivot 已经吃掉了平移,这里只要把拟合出的旋转转回去
      parent = boneNode[slot.bone]!
      rotation = degreesToQuaternionZ(-(info.rigid?.rotation ?? 0))
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
      name: claimName(parent, sanitize(item.key === slot.name ? slot.name : `${slot.name}__${item.key}`)),
      parent,
      position,
      rotation,
      scale: nodeScale,
      renderer,
      skin,
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
          const s = withSetup(
            t.frames.map((f) => f['time'] as number),
            t.frames.map((f) => toAngle(f['value'] as number)),
            segmentsOf(t.frames, toAngle),
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
          const sx = withSetup(
            t.frames.map((f) => f['time'] as number),
            t.frames.map((f) => toX(f['x'] as number)),
            segmentsOf(t.frames, toX, 0),
            bone.x * scale,
          )
          const sy = withSetup(
            t.frames.map((f) => f['time'] as number),
            t.frames.map((f) => toY(f['y'] as number)),
            segmentsOf(t.frames, toY, 1),
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
          const sx = withSetup(
            t.frames.map((f) => f['time'] as number),
            t.frames.map((f) => toSX(f['x'] as number)),
            segmentsOf(t.frames, toSX, 0),
            bone.scaleX,
          )
          const sy = withSetup(
            t.frames.map((f) => f['time'] as number),
            t.frames.map((f) => toSY(f['y'] as number)),
            segmentsOf(t.frames, toSY, 1),
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
        // 所以变成一组互斥的 m_IsActive 阶梯曲线
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
            floats.push({ path: paths[item.node]!, attribute: 'm_IsActive', classID: 1, keys })
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
            const s = withSetup(times, values, segmentsOf(t.frames, (v) => v, component), setupValue)
            const curve = toUnityCurve(s.times, s.values, s.segments)
            approximated ||= curve.approximated
            for (const item of list) {
              floats.push({ path: paths[item.node]!, attribute, classID: 212, keys: curve.keys })
            }
          }
          noteApprox(t)
          continue
        }

        if (t.kind === 'deform') {
          issues.loss(`deform[${t.owner}]`, 'Unity 的 SpriteSkin 只做骨骼蒙皮,没有逐顶点关键帧,该时间轴已丢弃')
        } else if (t.kind === 'drawOrder') {
          issues.loss('drawOrder', 'Unity 的 sortingOrder 是静态的,无法逐帧改变绘制顺序,该时间轴已丢弃')
        } else if (t.kind === 'transform' || t.kind.startsWith('path')) {
          issues.loss(t.kind, 'Unity 没有 transform / path 约束的对应物,该时间轴已丢弃')
        } else if (t.kind === 'ik') {
          issues.loss('ik', 'Spine 的 IK 约束没有直接搬过去 —— 骨骼的最终位置已经烘进曲线,外观一致但不可再调')
        } else if (t.kind === 'event') {
          issues.add('info', 'event', 'Spine 事件没有转成 Unity 的 AnimationEvent(没有对应的回调函数名)')
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
    files.push({ path: `${pageName}.png`, content: encodePng(page) })
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

  const controllerGuid = unityGuid(`${name}/controller`)
  const prefabGuid = unityGuid(`${name}/prefab`)

  files.push({
    path: `${name}.prefab`,
    content: writePrefab(nodes, {
      seed: name,
      controller: part.animations.length === 0 ? null : { fileID: 9100000, guid: controllerGuid },
    }),
  })
  files.push({ path: `${name}.prefab.meta`, content: writePrefabMeta(prefabGuid) })

  if (part.animations.length > 0) {
    files.push({
      path: `${name}.controller`,
      content: writeController(
        name,
        part.animations.map((a) => ({ name: sanitize(`${name}@${a.name}`), guid: clipGuids.get(a.name)! })),
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
