import type { Atlas, AtlasRegion } from './atlas.ts'
import { regionUVs } from './atlas.ts'
import { fromTRS, identity, multiply, transformPoint } from './math.ts'
import type { Skeleton } from './Skeleton.ts'
import type { RegionAttachment, RenderCommand } from './types.ts'

/**
 * 为当前骨架姿势生成 region attachment 的绘制命令。
 *
 * 输入骨架必须已经调用 updateWorldTransform()。本函数只产生纯顶点、UV 与颜色数据，
 * 不依赖任何渲染 API，因此编辑器预览和所有引擎运行时共用这条路径。
 */
export function buildRenderCommands(skeleton: Skeleton, atlas: Atlas): RenderCommand[] {
  const skin = skeleton.data.skins.get(skeleton.data.defaultSkin)
  if (skin === undefined) return []

  const commands: RenderCommand[] = []
  for (let slotIndex = 0; slotIndex < skeleton.data.slots.length; slotIndex++) {
    const slot = skeleton.data.slots[slotIndex]!
    if (slot.attachment === null) continue

    const attachment = skin.get(slotIndex)?.get(slot.attachment)
    if (attachment === undefined || attachment.type !== 'region') continue

    const region = atlas.regions.get(attachment.path)
    if (region === undefined) {
      throw new Error(`slot "${slot.name}" 引用的图集区域不存在: ${attachment.path}`)
    }
    const page = atlas.pages.find((candidate) => candidate.name === region.page)
    if (page === undefined) throw new Error(`图集区域 "${region.name}" 引用了不存在的页: ${region.page}`)

    const bone = skeleton.bones[slot.bone]
    if (bone === undefined) throw new Error(`slot "${slot.name}" 引用了不存在的骨骼: ${slot.bone}`)

    commands.push({
      slotName: slot.name,
      attachmentName: attachment.name,
      path: attachment.path,
      vertices: regionVertices(bone.world, attachment, region),
      uvs: regionUVs(region, page),
      color: slot.color,
      blend: slot.blend,
    })
  }
  return commands
}

/** attachment 局部空间以图片中心为原点，再乘所属骨骼的世界矩阵。 */
function regionVertices(
  boneWorld: ReturnType<typeof identity>,
  attachment: RegionAttachment,
  region: AtlasRegion,
): Float32Array {
  const local = fromTRS(
    identity(),
    attachment.x,
    attachment.y,
    attachment.rotation,
    attachment.scaleX,
    attachment.scaleY,
  )
  const world = multiply(identity(), boneWorld, local)
  // 图集裁掉透明边后，不能再直接画 attachment 的完整矩形。先在原图坐标中
  // 取出裁剪后的子矩形，再按 attachment 的显示尺寸缩放；否则每张裁剪图的锚点都会漂。
  const xScale = attachment.width / region.originalWidth
  const yScale = attachment.height / region.originalHeight
  const left = -attachment.width / 2 + region.offsetX * xScale
  const bottom = -attachment.height / 2 + region.offsetY * yScale
  const right = left + region.width * xScale
  const top = bottom + region.height * yScale
  const corners = [
    [left, bottom],
    [right, bottom],
    [right, top],
    [left, top],
  ] as const
  const vertices = new Float32Array(8)

  for (let i = 0; i < corners.length; i++) {
    const [x, y] = transformPoint(world, corners[i]![0], corners[i]![1])
    vertices[i * 2] = x
    vertices[i * 2 + 1] = y
  }
  return vertices
}
