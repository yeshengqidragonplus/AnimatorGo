import type { SkeletonPart } from '../../spine-format/binary/readSkeleton.ts'
import type { Timeline } from '../../spine-format/binary/readAnimations.ts'
import { IssueCollector, type ConversionIssue } from '../types.ts'
import { degreesToQuaternionZ, toUnityCurve, type SpineSegment, type UnityKeyframe } from '../../unity/curve.ts'
import { writeAnim, type PPtrCurve, type Vector3Curve } from '../../unity/writeAnim.ts'
import { writePrefab, type PrefabNode, type SpriteRef } from '../../unity/writePrefab.ts'

/**
 * Spine → Unity 2D。
 *
 * ## 两个必须处理对的语义差
 *
 * 1. **Spine 的关键帧是「相对绑定姿势的偏移」,Unity 的是绝对值。**
 *    转换时要把绑定姿势加回去(scale 是乘不是加)。这条错了动画会**整体系统性偏移**。
 *
 * 2. **单位**:Spine 用像素,Unity 的 Transform 用世界单位。
 *    要除以 `pixelsPerUnit`(Unity 默认 100)。
 *
 * ## 转不过去的东西(见 docs/UNITY-2D.md)
 *
 * - deform 顶点关键帧 —— Unity 的 SpriteSkin 只做骨骼蒙皮
 * - path / transform 约束
 * - 两色染色
 * - slot 的 draw order 动画 —— 静态排序可以映射成 sortingOrder,逐帧改变不行
 */

export interface UnityExportOptions {
  /** Spine 像素 → Unity 世界单位的换算,Unity 导入图片时的默认值是 100 */
  readonly pixelsPerUnit: number
  /** 图集纹理在 Unity 里的 GUID(从对应的 .meta 里读) */
  readonly textureGuid: string
  /** attachment 名 → 该 sprite 在纹理 .meta 里的 internalID */
  readonly spriteIds: ReadonlyMap<string, number>
}

export interface UnityExportResult {
  readonly prefab: string
  /** 动画名 → `.anim` 文本 */
  readonly clips: ReadonlyMap<string, string>
  readonly issues: readonly ConversionIssue[]
}

/** 常量曲线:某个分量整条时间轴都不变时用它填充 */
function constantKeys(times: readonly number[], value: number): UnityKeyframe[] {
  return times.map((time) => ({
    time,
    value,
    inSlope: 0,
    outSlope: 0,
    inWeight: 1 / 3,
    outWeight: 1 / 3,
    weightedMode: 0,
  }))
}

/**
 * 取出各段的曲线定义。
 *
 * ⚠️ **控制点的 y 分量在 Spine 的原始值空间里**(比如平移是像素、缩放是倍率),
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

/** 骨骼在 Unity 层级里的路径,例如 `hip/torso/head` */
function bonePaths(part: SkeletonPart): string[] {
  const paths: string[] = []
  part.bones.forEach((b, i) => {
    paths[i] = b.parent < 0 ? b.name : `${paths[b.parent]!}/${b.name}`
  })
  return paths
}

export function exportToUnity(
  part: SkeletonPart,
  options: UnityExportOptions,
): UnityExportResult {
  const issues = new IssueCollector()
  const scale = 1 / options.pixelsPerUnit
  const paths = bonePaths(part)

  // ── prefab:骨骼层级 + 每个 slot 一个挂图节点 ──
  const nodes: PrefabNode[] = part.bones.map((b) => ({
    name: b.name,
    parent: b.parent,
    position: { x: b.x * scale, y: b.y * scale, z: 0 },
    rotation: degreesToQuaternionZ(b.rotation),
    scale: { x: b.scaleX, y: b.scaleY, z: 1 },
    sprite: null,
    sortingOrder: 0,
  }))

  /** slot 名 → 它在 nodes 里的下标,动画里要用 */
  const slotNodeIndex = new Map<string, number>()
  const slotPaths = new Map<string, string>()

  part.slots.forEach((slot, order) => {
    const attachmentName = slot.attachmentName
    let sprite: SpriteRef | null = null

    if (attachmentName !== null) {
      const fileID = options.spriteIds.get(attachmentName)
      if (fileID === undefined) {
        issues.add(
          'loss',
          `slot.${slot.name}`,
          `图集里找不到 "${attachmentName}",该 slot 不会挂图 —— ` +
            `通常是图集没有和骨架一起导入 Unity`,
        )
      } else {
        sprite = { fileID, guid: options.textureGuid }
      }
    }

    const index = nodes.length
    nodes.push({
      name: slot.name,
      parent: slot.bone,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      sprite,
      // Spine 的 slots 数组顺序就是绘制顺序,先画的在下层
      sortingOrder: order,
    })
    slotNodeIndex.set(slot.name, index)
    slotPaths.set(slot.name, `${paths[slot.bone]!}/${slot.name}`)
  })

  const prefab = writePrefab(nodes, part.header.version)

  // ── 动画 ──
  const clips = new Map<string, string>()

  for (const anim of part.animations) {
    issues.scoped(anim.name, () => {
      const position: Vector3Curve[] = []
      const euler: Vector3Curve[] = []
      const scaleCurves: Vector3Curve[] = []
      const pptr: PPtrCurve[] = []
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
        const path = paths[t.owner]

        // 骨骼旋转:Spine 存偏移,Unity 存绝对角度 —— 要加回绑定姿势
        if (t.kind === 'rotate' && bone !== undefined && path !== undefined) {
          const times = t.frames.map((f) => f['time'] as number)
          const toAngle = (raw: number) => bone.rotation + raw
          const values = t.frames.map((f) => toAngle(f['value'] as number))
          const z = toUnityCurve(times, values, segmentsOf(t.frames, toAngle))
          approximated ||= z.approximated
          euler.push({ path, x: constantKeys(times, 0), y: constantKeys(times, 0), z: z.keys })
          noteApprox(t)
          continue
        }

        // 平移:同样加回绑定姿势,再换算单位
        if (t.kind === 'translate' && bone !== undefined && path !== undefined) {
          const times = t.frames.map((f) => f['time'] as number)
          const toX = (raw: number) => (bone.x + raw) * scale
          const toY = (raw: number) => (bone.y + raw) * scale
          const x = toUnityCurve(times, t.frames.map((f) => toX(f['x'] as number)), segmentsOf(t.frames, toX, 0))
          const y = toUnityCurve(times, t.frames.map((f) => toY(f['y'] as number)), segmentsOf(t.frames, toY, 1))
          approximated ||= x.approximated || y.approximated
          position.push({ path, x: x.keys, y: y.keys, z: constantKeys(times, 0) })
          noteApprox(t)
          continue
        }

        // 缩放:Spine 的关键帧是**倍率**,要乘绑定值而不是加
        if (t.kind === 'scale' && bone !== undefined && path !== undefined) {
          const times = t.frames.map((f) => f['time'] as number)
          const toSX = (raw: number) => bone.scaleX * raw
          const toSY = (raw: number) => bone.scaleY * raw
          const x = toUnityCurve(times, t.frames.map((f) => toSX(f['x'] as number)), segmentsOf(t.frames, toSX, 0))
          const y = toUnityCurve(times, t.frames.map((f) => toSY(f['y'] as number)), segmentsOf(t.frames, toSY, 1))
          approximated ||= x.approximated || y.approximated
          scaleCurves.push({ path, x: x.keys, y: y.keys, z: constantKeys(times, 1) })
          noteApprox(t)
          continue
        }

        // 换图:打到该 slot 节点的 SpriteRenderer 上
        if (t.kind === 'attachment') {
          const slot = part.slots[t.owner]
          const slotPath = slot === undefined ? undefined : slotPaths.get(slot.name)
          if (slotPath === undefined) continue

          const keys = t.frames.flatMap((f) => {
            const name = f['name'] as string | null
            if (name === null) return []
            const fileID = options.spriteIds.get(name)
            if (fileID === undefined) {
              issues.loss(`slot.${slot!.name}`, `换图目标 "${name}" 不在图集里,该帧被丢弃`)
              return []
            }
            return [{ time: f['time'] as number, fileID, guid: options.textureGuid }]
          })

          if (keys.length > 0) {
            pptr.push({ path: slotPath, attribute: 'm_Sprite', classID: 212, keys })
          }
          continue
        }

        // 以下都没有对应物,逐类报一次
        if (t.kind === 'deform') {
          issues.loss(
            `deform[${t.owner}]`,
            'Unity 的 SpriteSkin 只做骨骼蒙皮,没有逐顶点关键帧,该时间轴已丢弃',
          )
        } else if (t.kind === 'drawOrder') {
          issues.loss(
            'drawOrder',
            'Unity 的 sortingOrder 是静态的,无法逐帧改变绘制顺序,该时间轴已丢弃',
          )
        } else if (t.kind === 'transform' || t.kind.startsWith('path')) {
          issues.loss(t.kind, 'Unity 没有 transform / path 约束的对应物,该时间轴已丢弃')
        } else if (t.kind === 'twoColor' || t.kind === 'slotColor3' || t.kind === 'slotColor4') {
          issues.loss(t.kind, 'Unity 没有两色染色,暗色部分已丢弃')
        }
      }

      clips.set(
        anim.name,
        writeAnim({
          name: anim.name,
          sampleRate: 30,
          loop: true,
          position,
          euler,
          scale: scaleCurves,
          pptr,
        }),
      )
    })
  }

  return { prefab, clips, issues: issues.all }
}
