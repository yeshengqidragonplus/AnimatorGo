import type { SequenceMode } from '../spine-format/binary/readAnimations.ts'
import type { Sequence } from '../spine-format/binary/readSkins.ts'

/**
 * 4.1 序列帧(sequence)的求值 —— 时间 → 显示第几帧。
 *
 * 语义照 Spine 运行时的 SequenceTimeline.apply + Sequence.apply 自行实现:
 *
 * - 第一个关键帧之前(以及没有时间轴时):显示 `setupIndex`
 * - 关键帧 `(time, mode, index, delay)` 起作用到下一个关键帧;`hold` 就停在 index,
 *   其余模式从 index 起每 `delay` 秒走一帧:`index + (t − time) / delay + 0.0001` 取整
 *   (那个 0.0001 是 Spine 自己加的,防止 0.1 / 0.0333 算成 2.9999 少走一帧)
 * - 算出来 ≥ 帧数时取最后一帧
 *
 * 帧 i 用的图集区域名 = path + (start + i),补零到 digits 位。
 */

export interface SequenceKey {
  readonly time: number
  readonly mode: SequenceMode
  readonly index: number
  readonly delay: number
}

/** 帧 i 对应的图集区域名 */
export function sequenceRegionName(basePath: string, seq: Sequence, i: number): string {
  return basePath + String(seq.start + i).padStart(seq.digits, '0')
}

const clampFrame = (index: number, count: number) => Math.max(0, Math.min(count - 1, index))

/** 关键帧 k 在时刻 time 给出的帧号(未夹到帧数内之前的原始值,模式已算完) */
function indexFromKey(k: SequenceKey, time: number, count: number): number {
  let index = k.index
  if (k.mode === 'hold' || !(k.delay > 0)) return index
  index = Math.trunc(index + (time - k.time) / k.delay + 0.0001)
  switch (k.mode) {
    case 'once':
      return Math.min(count - 1, index)
    case 'loop':
      return index % count
    case 'pingpong': {
      const n = (count << 1) - 2
      index = n === 0 ? 0 : index % n
      return index >= count ? n - index : index
    }
    case 'onceReverse':
      return Math.max(count - 1 - index, 0)
    case 'loopReverse':
      return count - 1 - (index % count)
    case 'pingpongReverse': {
      const n = (count << 1) - 2
      index = n === 0 ? 0 : (index + count - 1) % n
      return index >= count ? n - index : index
    }
  }
}

/** 时刻 time 显示第几帧(0 ≤ 结果 < count) */
export function sequenceFrameAt(keys: readonly SequenceKey[] | undefined, seq: Sequence, time: number): number {
  if (keys === undefined || keys.length === 0 || time < keys[0]!.time) return clampFrame(seq.setupIndex, seq.count)
  let i = 0
  while (i + 1 < keys.length && keys[i + 1]!.time <= time) i++
  return clampFrame(indexFromKey(keys[i]!, time, seq.count), seq.count)
}

/** 一个非 hold 关键帧走完一轮要多久 —— 动画时长为 0 时拿它当剪辑长度 */
export function sequenceCycle(k: SequenceKey, count: number): number {
  if (k.mode === 'hold' || !(k.delay > 0)) return 0
  const frames = k.mode === 'pingpong' || k.mode === 'pingpongReverse' ? Math.max(1, 2 * count - 2) : count
  return frames * k.delay
}

/** 单条时间轴最多铺多少步,防坏数据(delay 极小)把曲线撑爆 */
const MAX_STEPS = 20000

/**
 * 铺成阶梯:从 0 开始、每次换帧一个点,直到 end(end 之后的变化不要)。
 * 相邻同值的点合并掉。
 */
export function sequenceSteps(
  keys: readonly SequenceKey[] | undefined,
  seq: Sequence,
  end: number,
): { time: number; frame: number }[] {
  const times = new Set<number>([0])
  if (keys !== undefined) {
    keys.forEach((k, i) => {
      times.add(k.time)
      if (k.mode === 'hold' || !(k.delay > 0)) return
      const until = Math.min(keys[i + 1]?.time ?? end, end)
      for (let j = 1; j < MAX_STEPS; j++) {
        // Spine 的 +0.0001 让换帧比 time + j·delay **早**一点点(0.0001 个 delay),步点跟着它走 ——
        // 不然正好采在步点上时和 Spine 差一帧
        const t = k.time + (j - 0.0001) * k.delay
        if (t >= until - 1e-9) break
        times.add(t)
      }
    })
  }
  const out: { time: number; frame: number }[] = []
  for (const time of [...times].filter((t) => t <= end + 1e-9).sort((a, b) => a - b)) {
    // 在步点上稍微往后一点求值,避开浮点把整数步算成 x.9999 的边界
    const frame = sequenceFrameAt(keys, seq, time + 1e-7)
    if (out.length === 0 || out[out.length - 1]!.frame !== frame) out.push({ time, frame })
  }
  return out
}
