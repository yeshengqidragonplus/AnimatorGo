import type { SkeletonPart } from '../spine-format/binary/readSkeleton.ts'
import type { AnimationData } from '../spine-format/binary/readAnimations.ts'
import { lastPerProperty } from '../spine-format/duplicateTimelines.ts'
import { drawOrderOf, type DrawOrderOffset } from './drawOrder.ts'

/**
 * 按 Spine 的规则算某一时刻每个 slot 挂哪个 attachment、按什么顺序画 —— 端到端校验「画了哪些、谁压着谁」用。
 * 第一帧之前都是 setup(attachment / drawOrder 时间轴在第一帧之前回到 setup)。
 */

/** 各 slot 挂的 attachment 名(按 slot 下标);null = 不挂 */
export function slotAttachmentsAt(part: SkeletonPart, anim: AnimationData | null, t: number): (string | null)[] {
  const out = part.slots.map((s) => s.attachmentName)
  if (anim === null) return out
  for (const tl of lastPerProperty(anim.timelines).kept) {
    if (tl.kind !== 'attachment') continue
    let frame: Record<string, unknown> | undefined
    for (const f of tl.frames) if (Number(f['time'] ?? 0) <= t) frame = f
    if (frame !== undefined) out[tl.owner] = (frame['name'] as string | null | undefined) ?? null
  }
  return out
}

/** 画的先后:第 i 项是第 i 个画的 slot 下标(先画的在前) */
export function drawOrderAt(part: SkeletonPart, anim: AnimationData | null, t: number): number[] {
  const setup = part.slots.map((_, i) => i)
  const tl = anim === null ? undefined : lastPerProperty(anim.timelines).kept.find((x) => x.kind === 'drawOrder')
  if (tl === undefined) return setup
  let frame: Record<string, unknown> | undefined
  for (const f of tl.frames) if (Number(f['time'] ?? 0) <= t) frame = f
  return frame === undefined ? setup : drawOrderOf(part.slots.length, (frame['offsets'] as DrawOrderOffset[] | undefined) ?? [])
}
