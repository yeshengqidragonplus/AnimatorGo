/**
 * Spine 的 clipping 遮罩:哪些 slot 被遮、遮罩形状和开关随时间怎么变。Unity(SpriteMask)和 Godot(clip_children)共用。
 *
 * Spine 的规则(画 slot 的循环里):画到挂着 clipping attachment 的 slot 时开始裁剪,之后画的每个 slot 都按这个多边形裁,
 * 画完 `endSlot` 那个 slot 后结束;`endSlot` 不在它后面就一直裁到最后。同一时间只有一个遮罩 —— 已经在裁的时候又碰到
 * 一个 clipping attachment,后来的那个不生效。遮罩挂着才裁:slot 当前的 attachment 不是它(被换图时间轴换掉、setup 里
 * 没挂)时,范围里的部件照常画。
 *
 * 两个引擎都没法逐帧改「谁被遮」:Unity 的范围是排序值区间,Godot 是节点树里的父子关系。所以范围按 setup 的绘制顺序定,
 * 绘制顺序动画改了范围就报。
 */
import type { SkeletonPart } from '../spine-format/binary/readSkeleton.ts'
import type { Attachment, Vertices } from '../spine-format/binary/readSkins.ts'
import type { AnimationData, Timeline } from '../spine-format/binary/readAnimations.ts'
import { lastPerProperty } from '../spine-format/duplicateTimelines.ts'
import { drawOrderOf, type DrawOrderOffset } from '../spine-eval/drawOrder.ts'
import { applyPoint, invert, setupPose, valueBetween, IDENTITY } from '../spine-eval/pose.ts'
import type { IssueCollector } from './types.ts'

export type Point = { x: number; y: number }

export interface ClipGroup {
  readonly skin: string
  /** 挂遮罩的 slot */
  readonly slot: number
  readonly key: string
  readonly attachment: Attachment
  /** 被遮的 slot,按 setup 的绘制顺序 */
  readonly clipped: readonly number[]
  /** setup 的多边形,遮罩 slot 骨骼的局部坐标(Spine 坐标,Y 朝上) */
  readonly polygon: readonly Point[]
}

/** 被遮的 slot 有哪些:遮罩之后、到 endSlot 为止(endSlot 不在后面就到最后) */
function rangeIn(order: readonly number[], slot: number, end: number): number[] {
  const from = order.indexOf(slot)
  if (from < 0) return []
  const to = order.indexOf(end)
  return order.slice(from + 1, to > from ? to + 1 : order.length)
}

/**
 * 骨架里的全部遮罩。一个 slot 只归一个遮罩(范围重叠时先画的那个,与 Spine「同一时间只有一个」一致);
 * 绘制顺序动画改了范围、范围重叠、加权的多边形,都报出来。
 */
export function clipGroups(part: SkeletonPart, issues: IssueCollector): ClipGroup[] {
  const setupOrder = part.slots.map((_, i) => i)
  const out: ClipGroup[] = []
  const owner = new Map<number, ClipGroup>()
  for (const skin of part.skins) {
    for (const entry of skin.slots) {
      for (const a of entry.attachments) {
        if (a.type !== 'clipping') continue
        const end = a.data['endSlot'] as number
        const path = `clipping.${part.slots[entry.slot]!.name}/${a.key}`
        const range = rangeIn(setupOrder, entry.slot, end)
        if (range.length === 0) {
          issues.add('info', path, '遮罩范围里没有 slot,不影响画面,跳过')
          continue
        }
        if (skin !== part.skins[0]) issues.add('approximated', path, `遮罩在皮肤 "${skin.name}" 里,按「slot 挂着它就生效」处理,不区分当前皮肤`)
        const verts = a.data['vertices'] as Vertices
        if (verts.weighted) issues.add('approximated', path, '加权的遮罩多边形按 setup 姿势刚性挂在遮罩 slot 的骨骼上')
        const clipped = range.filter((s) => {
          const other = owner.get(s)
          if (other === undefined) return true
          issues.add('approximated', path, `和 "${part.slots[other.slot]!.name}" 的遮罩范围重叠,重叠的 slot 只按先画的那个遮`)
          return false
        })
        const group: ClipGroup = { skin: skin.name, slot: entry.slot, key: a.key, attachment: a, clipped, polygon: localPolygon(part, entry.slot, verts) }
        for (const s of clipped) owner.set(s, group)
        out.push(group)
      }
    }
  }
  // 绘制顺序动画:范围按 setup 定,改了就报
  for (const anim of part.animations) {
    const drawOrder = lastPerProperty(anim.timelines).kept.find((t) => t.kind === 'drawOrder')
    if (drawOrder === undefined) continue
    for (const g of out) {
      const changed = drawOrder.frames.some((f) => {
        const r = rangeIn(drawOrderOf(part.slots.length, (f['offsets'] as DrawOrderOffset[] | undefined) ?? []), g.slot, g.attachment.data['endSlot'] as number)
        return r.join(',') !== rangeIn(setupOrder, g.slot, g.attachment.data['endSlot'] as number).join(',')
      })
      if (changed) issues.add('approximated', `${anim.name}.clipping.${part.slots[g.slot]!.name}`, '绘制顺序动画改变了遮罩的范围(或范围里的先后),按 setup 的范围处理')
    }
  }
  return out
}

/** 遮罩多边形在遮罩 slot 骨骼的局部坐标。加权的:setup 姿势下算出世界坐标再换回去 */
function localPolygon(part: SkeletonPart, slot: number, verts: Vertices, flat?: readonly number[]): Point[] {
  if (!verts.weighted) {
    const n = verts.positions.length / 2
    return Array.from({ length: n }, (_, i) => ({ x: verts.positions[i * 2]! + (flat?.[i * 2] ?? 0), y: verts.positions[i * 2 + 1]! + (flat?.[i * 2 + 1] ?? 0) }))
  }
  const setup = setupPose(part)
  const back = invert(setup[part.slots[slot]!.bone]!) ?? IDENTITY
  let k = 0
  return verts.weights.map((entry) => {
    let x = 0, y = 0
    for (const w of entry) {
      const p = applyPoint(setup[w.bone]!, w.x + (flat?.[k] ?? 0), w.y + (flat?.[k + 1] ?? 0))
      x += w.weight * p.x
      y += w.weight * p.y
      k += 2
    }
    return applyPoint(back, x, y)
  })
}

const skinNameOf = (part: SkeletonPart, s: number | string) => (typeof s === 'number' ? (part.skins[s]?.name ?? String(s)) : s)

/** 这条动画里打在遮罩上的 deform 时间轴(没有就 undefined) */
export function clipDeformOf(part: SkeletonPart, g: ClipGroup, timelines: readonly Timeline[]): readonly Record<string, unknown>[] | undefined {
  for (const t of timelines) {
    if (t.kind !== 'deform' || t.owner !== g.slot) continue
    const d = t.frames[0] as unknown as { skin: number | string; attachment: string; frames: Record<string, unknown>[] }
    if (skinNameOf(part, d.skin) === g.skin && (d.attachment === g.key || d.attachment === g.attachment.name)) return d.frames
  }
  return undefined
}

/** t 时刻的遮罩多边形(骨骼局部,Spine 坐标)。第一帧之前是 setup 的形状 */
export function clipPolygonAt(part: SkeletonPart, g: ClipGroup, frames: readonly Record<string, unknown>[] | undefined, t: number): Point[] {
  if (frames === undefined || frames.length === 0) return [...g.polygon]
  const verts = g.attachment.data['vertices'] as Vertices
  const flatLength = verts.weighted ? verts.weights.reduce((n, w) => n + w.length * 2, 0) : verts.positions.length
  const offsetsOf = (f: Record<string, unknown>): number[] => {
    const v = (f['vertices'] as number[] | undefined) ?? []
    const start = Number(f['start'] ?? 0)
    const flat = new Array<number>(flatLength).fill(0)
    v.forEach((x, k) => { if (start + k < flatLength) flat[start + k] = x })
    return flat
  }
  const times = frames.map((f) => Number(f['time'] ?? 0))
  if (t < times[0]!) return [...g.polygon]
  let i = frames.length - 1
  for (let k = 0; k < frames.length - 1; k++) if (t < times[k + 1]!) { i = k; break }
  const f0 = offsetsOf(frames[i]!)
  if (i === frames.length - 1) return localPolygon(part, g.slot, verts, f0)
  const f1 = offsetsOf(frames[i + 1]!)
  // deform 的曲线是 0..1 的进度(两版一致,见 bezier.ts)
  const p = valueBetween([{ ...frames[i]!, v: 0 }, { ...frames[i + 1]!, v: 1 }], 0, 'v', t, part.header.major === '3.8')
  return localPolygon(part, g.slot, verts, f0.map((x, j) => x + (f1[j]! - x) * p))
}

/** 遮罩开关的阶梯:这条动画里 slot 挂着这个遮罩的时间段。没有换图时间轴就只有 0 时刻一项 */
export function clipOnSteps(part: SkeletonPart, g: ClipGroup, anim: AnimationData | null): { t: number; on: boolean }[] {
  const steps = [{ t: 0, on: part.slots[g.slot]!.attachmentName === g.key }]
  if (anim === null) return steps
  const tl = lastPerProperty(anim.timelines).kept.find((t) => t.kind === 'attachment' && t.owner === g.slot)
  for (const f of tl?.frames ?? []) steps.push({ t: Number(f['time'] ?? 0), on: f['name'] === g.key })
  return steps
}

/** 这条动画动没动遮罩的开关 */
export function clipToggled(anim: AnimationData, g: ClipGroup): boolean {
  return lastPerProperty(anim.timelines).kept.some((t) => t.kind === 'attachment' && t.owner === g.slot)
}

/**
 * 简单多边形的三角化(耳切法),返回顶点下标三元组。遮罩多边形只有十几个顶点,O(n³) 无所谓。
 * 顺逆时针都行;自相交、退化得切不下去时,剩下的部分退回扇形
 */
export function triangulatePolygon(points: readonly Point[]): number[] {
  const n = points.length
  if (n < 3) return []
  let area = 0
  for (let i = 0; i < n; i++) {
    const p = points[i]!, q = points[(i + 1) % n]!
    area += p.x * q.y - q.x * p.y
  }
  const sign = area >= 0 ? 1 : -1
  const cross = (a: Point, b: Point, c: Point) => ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) * sign
  const inside = (p: Point, a: Point, b: Point, c: Point) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0
  const idx = Array.from({ length: n }, (_, i) => i)
  const out: number[] = []
  while (idx.length > 3) {
    let cut = -1
    for (let i = 0; i < idx.length && cut < 0; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length]!, ib = idx[i]!, ic = idx[(i + 1) % idx.length]!
      const a = points[ia]!, b = points[ib]!, c = points[ic]!
      if (cross(a, b, c) <= 1e-12) continue // 凹角或共线,不是耳朵
      if (idx.some((j) => j !== ia && j !== ib && j !== ic && inside(points[j]!, a, b, c))) continue
      out.push(ia, ib, ic)
      cut = i
    }
    if (cut < 0) break
    idx.splice(cut, 1)
  }
  for (let i = 1; i + 1 < idx.length; i++) out.push(idx[0]!, idx[i]!, idx[i + 1]!)
  return out
}
