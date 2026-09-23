import type { SkeletonPart } from '../../spine-format/binary/readSkeleton.ts'
import type { Attachment, Skin, SkinSlotEntry } from '../../spine-format/binary/readSkins.ts'
import type { IssueCollector } from '../types.ts'

/**
 * linkedmesh(共享网格)展开成普通 mesh。
 *
 * Spine 运行时里 linkedmesh 就是「借父网格的顶点、三角形、UV、权重,用自己的图」:
 * 加载时 `setParentMesh` 把这些拷过来,UV 再按自己的 region 重算。所以导出前原地展开,
 * 后面整条网格管线(SpriteSkin / SkinnedMeshRenderer 分流、Blend Shape)一行都不用改。
 *
 * 父网格的查法和 Spine 一致:**同一个 slot**,在 linkedmesh 记的那套皮肤里(null = 默认皮肤)
 * 按键名找。⚠️ 父网格可以在**另一套**皮肤里 —— MC2 的 chopping_board 皮肤 `5` 的件就挂在皮肤 `4` 上。
 *
 * `inheritTimelines`(3.8 叫 `inheritDeform`)为真时,打在父网格上的 deform 时间轴也驱动它。
 * 展开后它就是个普通 mesh,认不出这层关系了,所以单独返回 `timelineParents` 给 deform 那边用。
 */

export interface TimelineParent {
  /** 父网格所在皮肤的名字 */
  readonly skin: string
  /** 父网格在皮肤里的键名 —— deform 时间轴按它找目标 */
  readonly key: string
}

export interface ResolvedLinkedMeshes {
  readonly part: SkeletonPart
  /** 展开后的 attachment → 它继承谁的 deform 时间轴。没有这一项的不继承 */
  readonly timelineParents: ReadonlyMap<Attachment, TimelineParent>
}

/** 父网格链的深度上限 —— 编辑器不允许 linkedmesh 挂 linkedmesh,这里只防坏数据里的环 */
const MAX_DEPTH = 8

/** 从父网格拷的字段,其余(path、color、名字、width/height)用 linkedmesh 自己的 */
const INHERITED = ['vertexCount', 'uvs', 'triangles', 'vertices', 'hullLength', 'edges'] as const

export function resolveLinkedMeshes(part: SkeletonPart, issues: IssueCollector): ResolvedLinkedMeshes {
  const hasLinked = part.skins.some((s) => s.slots.some((e) => e.attachments.some((a) => a.type === 'linkedmesh')))
  if (!hasLinked) return { part, timelineParents: new Map() }

  const defaultSkin = part.skins.find((s) => s.name === 'default') ?? part.skins[0]
  const findSkin = (name: string | null): Skin | undefined =>
    name === null ? defaultSkin : part.skins.find((s) => s.name === name)

  /** 沿父链找到真正带几何的那个 mesh;找不到返回原因 */
  const sourceMesh = (slot: number, linked: Attachment): Attachment | string => {
    let current = linked
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const skinName = (current.data['skinName'] as string | null | undefined) ?? null
      const parentKey = current.data['parent'] as string | null | undefined
      const skin = findSkin(skinName)
      if (skin === undefined) return `找不到父网格所在的皮肤 "${skinName}"`
      const parent = skin.slots.find((e) => e.slot === slot)?.attachments.find((a) => a.key === parentKey)
      if (parent === undefined) return `皮肤 "${skin.name}" 的同一 slot 里没有父网格 "${parentKey}"`
      if (parent.type === 'mesh') return parent
      if (parent.type !== 'linkedmesh') return `父网格 "${parentKey}" 是 ${parent.type},不是网格`
      current = parent
    }
    return '父网格链过深(多半是互相引用成环)'
  }

  const timelineParents = new Map<Attachment, TimelineParent>()
  let resolved = 0

  const skins: Skin[] = part.skins.map((skin) => ({
    ...skin,
    slots: skin.slots.map((entry): SkinSlotEntry => ({
      ...entry,
      attachments: entry.attachments.map((attachment) => {
        if (attachment.type !== 'linkedmesh') return attachment

        const source = sourceMesh(entry.slot, attachment)
        if (typeof source === 'string') {
          // 留着 linkedmesh 类型,收集阶段按不认识的件报 loss
          issues.loss(`attachment.${attachment.key}`, `linkedmesh 展开失败:${source},该部件已丢弃`)
          return attachment
        }

        const data: Record<string, unknown> = {
          path: attachment.data['path'],
          pathIndex: attachment.data['pathIndex'],
          color: attachment.data['color'],
          width: attachment.data['width'] ?? source.data['width'],
          height: attachment.data['height'] ?? source.data['height'],
        }
        for (const field of INHERITED) {
          if (source.data[field] !== undefined) data[field] = source.data[field]
        }
        const mesh: Attachment = { ...attachment, type: 'mesh', data }

        if (attachment.data['inheritTimelines'] !== false) {
          // 继承的是**直接**父网格的时间轴(4.x 的 timelineAttachment、3.8 的 applyDeform 都只认这一层)
          const skinName = (attachment.data['skinName'] as string | null | undefined) ?? null
          timelineParents.set(mesh, {
            skin: findSkin(skinName)!.name,
            key: attachment.data['parent'] as string,
          })
        }
        resolved++
        return mesh
      }),
    })),
  }))

  if (resolved > 0) {
    issues.add('info', 'linkedmesh', `${resolved} 个 linkedmesh(共享网格)已展开成独立网格,几何取自父网格、图用自己的`)
  }
  return { part: { ...part, skins }, timelineParents }
}
