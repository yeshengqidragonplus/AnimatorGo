import type { SkeletonPart } from '../spine-format/binary/readSkeleton.ts'
import type { Attachment, Vertices } from '../spine-format/binary/readSkins.ts'
import type { AnimationData } from '../spine-format/binary/readAnimations.ts'
import type { Atlas } from '../core/atlas.ts'
import { lastPerProperty } from '../spine-format/duplicateTimelines.ts'
import { applyPoint, valueBetween, type Affine } from './pose.ts'

/**
 * 按 Spine 的规则算 attachment 在某一时刻的世界顶点(骨架坐标,Y 朝上)。
 *
 * region:Spine 的 UpdateRegion 四角(左下、右下、右上、左上);mesh:局部坐标 + deform 偏移,加权的逐影响蒙皮。
 * deform 按「皮肤 + slot + 键名」认目标 —— 几套皮肤同键名的 attachment 各有各的。
 * 用来做端到端校验:导出到别的引擎、按那边的规则算出的顶点,应当落在这里算出的位置。
 */
export function attachmentVertices(
  part: SkeletonPart,
  atlas: Atlas | null,
  a: Attachment,
  skinName: string,
  slotIndex: number,
  pose: readonly Affine[],
  anim: AnimationData | null,
  t: number,
): { x: number; y: number }[] {
  const slot = part.slots[slotIndex]!
  const DEG = Math.PI / 180
  if (a.type === 'region') {
    const d = a.data as Record<string, number>
    const region = atlas?.regions.get((a.data['path'] as string | null) ?? a.name)
    if (region === undefined) throw new Error(`region "${a.name}" 需要图集`)
    const w = d['width']!, h = d['height']!
    const lx = (-w / 2 + (region.offsetX / region.originalWidth) * w) * d['scaleX']!
    const ly = (-h / 2 + (region.offsetY / region.originalHeight) * h) * d['scaleY']!
    const lx2 = (w / 2 - ((region.originalWidth - region.offsetX - region.width) / region.originalWidth) * w) * d['scaleX']!
    const ly2 = (h / 2 - ((region.originalHeight - region.offsetY - region.height) / region.originalHeight) * h) * d['scaleY']!
    const cos = Math.cos(DEG * d['rotation']!), sin = Math.sin(DEG * d['rotation']!)
    const bone = pose[slot.bone]!
    return [[lx, ly], [lx2, ly], [lx2, ly2], [lx, ly2]].map(([x, y]) => applyPoint(bone, x! * cos - y! * sin + d['x']!, y! * cos + x! * sin + d['y']!))
  }
  const verts = a.data['vertices'] as Vertices
  const count = a.data['vertexCount'] as number
  const flatLength = verts.weighted ? verts.weights.reduce((n, w) => n + w.length * 2, 0) : count * 2
  const offsets = deformOffsets(part, a, skinName, slotIndex, flatLength, anim, t)
  if (!verts.weighted) {
    const bone = pose[slot.bone]!
    return Array.from({ length: count }, (_, i) => applyPoint(bone, verts.positions[i * 2]! + offsets[i * 2]!, verts.positions[i * 2 + 1]! + offsets[i * 2 + 1]!))
  }
  const out: { x: number; y: number }[] = []
  let k = 0
  for (const entry of verts.weights) {
    let x = 0, y = 0
    for (const w of entry) {
      const p = applyPoint(pose[w.bone]!, w.x + offsets[k]!, w.y + offsets[k + 1]!)
      x += p.x * w.weight
      y += p.y * w.weight
      k += 2
    }
    out.push({ x, y })
  }
  return out
}

/** 该 attachment 在 t 时刻的 deform 偏移(平铺,逐影响);没有 deform 全 0 */
function deformOffsets(part: SkeletonPart, a: Attachment, skinName: string, slotIndex: number, flatLength: number, anim: AnimationData | null, t: number): number[] {
  const offsets = new Array<number>(flatLength).fill(0)
  if (anim === null) return offsets
  for (const tl of lastPerProperty(anim.timelines).kept) {
    if (tl.kind !== 'deform' || tl.owner !== slotIndex) continue
    const rec = tl.frames[0] as { skin: number | string; attachment: string; frames: Record<string, unknown>[] }
    const recSkin = typeof rec.skin === 'number' ? part.skins[rec.skin]?.name : rec.skin
    if (recSkin !== skinName || (rec.attachment !== a.key && rec.attachment !== a.name)) continue
    const frames = rec.frames
    if (t < Number(frames[0]!['time'] ?? 0)) continue
    let i = frames.length - 1
    for (let k = 0; k < frames.length - 1; k++) if (t < Number(frames[k + 1]!['time'])) { i = k; break }
    const flat = (f: Record<string, unknown>) => {
      const out = new Array<number>(flatLength).fill(0)
      const v = (f['vertices'] as number[] | undefined) ?? []
      v.forEach((x, k) => { out[Number(f['start'] ?? 0) + k] = x })
      return out
    }
    const f0 = flat(frames[i]!)
    const f1 = i + 1 < frames.length ? flat(frames[i + 1]!) : f0
    const p = i + 1 < frames.length ? valueBetween([{ ...frames[i]!, v: 0 }, { ...frames[i + 1]!, v: 1 }], 0, 'v', t, part.header.major === '3.8') : 0
    f0.forEach((x, k) => { offsets[k] = x + (f1[k]! - x) * p })
  }
  return offsets
}
