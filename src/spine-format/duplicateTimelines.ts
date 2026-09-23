import type { Timeline } from './binary/readAnimations.ts'
import type { SkeletonPart } from './binary/readSkeleton.ts'

/**
 * 同一属性上的重复时间轴。
 *
 * `.skel` 里同一个 slot 的同类时间轴可以在一组里出现两次 —— 3.8 很常见(全盘 99 个文件、约 4800 处,
 * attachment / color / deform 三类),4.1 也有一处 rotate。运行时按文件顺序逐条套用,满权重时
 * **后一条整条盖掉前一条**,连它首帧之前的时段也会被拉回 setup,所以真正播出来的只有最后一条。
 *
 * 二进制往返原样保留(写回要逐字节相同)。但下游两处都只能留一条:
 *
 * - JSON 表达不了 —— 同一个键只能有一个值
 * - Unity 不能两条都写 —— Blend Shape 是叠加的,两条 deform 会让形变翻倍;
 *   换图 / 颜色则是同一属性上两条曲线,谁生效没有保证
 *
 * 全盘约 4500 处前后两条内容完全相同,丢掉没有任何影响;不同的约 300 处要报告 ——
 * 正常播放看不出区别,只在动画之间混合过渡(权重 < 1)时可能有细微差异。
 */

export interface DroppedTimeline {
  readonly timeline: Timeline
  /** 与留下的那条内容完全相同 —— 丢掉无损,不必报告 */
  readonly identical: boolean
}

/** 作用于哪个属性:同类、同 owner;deform / sequence 还要同皮肤、同 attachment */
function propertyOf(t: Timeline): string {
  if (t.kind === 'deform' || t.kind === 'sequence') {
    const w = t.frames[0] as Record<string, unknown>
    return `${t.kind}/${t.owner}/${String(w['skin'])}/${String(w['attachment'])}`
  }
  return `${t.kind}/${t.owner}`
}

/** 每个属性只留最后一条(即 Spine 实际播出来的那条),其余按原顺序列进 dropped */
export function lastPerProperty(timelines: readonly Timeline[]): { kept: Timeline[]; dropped: DroppedTimeline[] } {
  const winner = new Map<string, Timeline>()
  for (const t of timelines) winner.set(propertyOf(t), t)
  if (winner.size === timelines.length) return { kept: [...timelines], dropped: [] }

  const kept: Timeline[] = []
  const dropped: DroppedTimeline[] = []
  for (const t of timelines) {
    const w = winner.get(propertyOf(t))!
    if (w === t) kept.push(t)
    // 同一个读取器读出来的帧,字段顺序一致,序列化后比较就够了
    else dropped.push({ timeline: t, identical: JSON.stringify(t.frames) === JSON.stringify(w.frames) })
  }
  return { kept, dropped }
}

/** 报告里定位用:`attachment[eye]`、`deform[body/body_mesh]`,owner 换成名字 */
export function describeTimeline(part: SkeletonPart, t: Timeline): string {
  const k = t.kind
  if (k === 'deform' || k === 'sequence') {
    const w = t.frames[0] as Record<string, unknown>
    return `${k}[${part.slots[t.owner]?.name ?? t.owner}/${String(w['attachment'])}]`
  }
  const owner =
    k === 'attachment' || k === 'color' || k === 'twoColor' || k.startsWith('slotColor') ? part.slots[t.owner]?.name
      : k === 'ik' ? part.ik[t.owner]?.name
      : k === 'transform' ? part.transform[t.owner]?.name
      : k.startsWith('path') ? part.path[t.owner]?.name
      : part.bones[t.owner]?.name
  return `${k}[${owner ?? t.owner}]`
}

/** 报告里用的一句话 —— JSON 与 Unity 两处共用 */
export const DUPLICATE_TIMELINE_MESSAGE =
  '同一属性有两条内容不同的时间轴,只保留最后一条 —— Spine 播放时后一条本来就整条覆盖前一条,' +
  '正常播放效果相同;动画之间混合过渡时可能有细微差异'
