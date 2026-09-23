import { describe, expect, it } from 'vitest'
import { sequenceCycle, sequenceFrameAt, sequenceRegionName, sequenceSteps, type SequenceKey } from './sequence.ts'

const seq = (count: number, setupIndex = 0, start = 1, digits = 0) => ({ count, start, digits, setupIndex })
const key = (time: number, mode: SequenceKey['mode'], index: number, delay: number): SequenceKey => ({ time, mode, index, delay })
/** 每隔 dt 采一次,返回帧号序列 —— 采在步点之后一点点,避开边界 */
const sample = (keys: SequenceKey[], s: ReturnType<typeof seq>, dt: number, n: number) =>
  Array.from({ length: n }, (_, i) => sequenceFrameAt(keys, s, i * dt + 1e-6))

describe('序列帧区域名', () => {
  it('path + (start + i),补零到 digits 位', () => {
    expect(sequenceRegionName('left-wing', seq(9, 0, 1, 2), 0)).toBe('left-wing01') // dragon.json
    expect(sequenceRegionName('fire_', seq(13, 0, 1, 0), 12)).toBe('fire_13') // jiesuan_xianzi
    expect(sequenceRegionName('water_', seq(3, 0, 0, 0), 0)).toBe('water_0') // milkshake:start 为 0
  })
})

describe('序列帧求值(Spine 的 SequenceTimeline + Sequence 规则)', () => {
  it('没有时间轴、以及第一个关键帧之前,都显示 setupIndex', () => {
    expect(sequenceFrameAt(undefined, seq(5, 2), 1)).toBe(2)
    expect(sequenceFrameAt([key(0.5, 'hold', 4, 0)], seq(5, 2), 0.2)).toBe(2)
  })

  it('hold 停在 index;index 超过帧数取最后一帧', () => {
    expect(sample([key(0, 'hold', 1, 0.05)], seq(3), 0.05, 4)).toEqual([1, 1, 1, 1])
    expect(sequenceFrameAt([key(0, 'hold', 10, 0)], seq(3), 0)).toBe(2)
  })

  it('loop / once / pingpong 及三种倒放', () => {
    const d = 0.05
    expect(sample([key(0, 'loop', 0, d)], seq(3), d, 7)).toEqual([0, 1, 2, 0, 1, 2, 0])
    expect(sample([key(0, 'once', 0, d)], seq(3), d, 5)).toEqual([0, 1, 2, 2, 2])
    expect(sample([key(0, 'pingpong', 0, d)], seq(3), d, 7)).toEqual([0, 1, 2, 1, 0, 1, 2])
    expect(sample([key(0, 'onceReverse', 0, d)], seq(3), d, 5)).toEqual([2, 1, 0, 0, 0])
    expect(sample([key(0, 'loopReverse', 0, d)], seq(3), d, 5)).toEqual([2, 1, 0, 2, 1])
    expect(sample([key(0, 'pingpongReverse', 0, d)], seq(3), d, 7)).toEqual([2, 1, 0, 1, 2, 1, 0])
  })

  it('huache3 的车轮:loopReverse 从 index 3 起(4 帧)', () => {
    expect(sample([key(0, 'loopReverse', 3, 0.05)], seq(4), 0.05, 5)).toEqual([0, 3, 2, 1, 0])
  })

  it('+0.0001:1/30 秒的 delay 在 0.1 秒整时已经是第 3 帧,不会因为浮点少走一帧', () => {
    const delay = Math.fround(1 / 30) // Spine 里是 float
    expect(sequenceFrameAt([key(0, 'once', 0, delay)], seq(14), Math.fround(0.1))).toBe(3)
  })

  it('一个关键帧只管到下一个关键帧为止', () => {
    // icon_clock:先 hold 在 0,到 0.1 秒改成 once 从 0 起播
    const keys = [key(0, 'hold', 0, 0.05), key(0.1, 'once', 0, 0.05)]
    expect(sample(keys, seq(5), 0.05, 6)).toEqual([0, 0, 0, 1, 2, 3])
  })
})

describe('铺成阶梯', () => {
  it('每次换帧一个点,相邻同值合并,end 之后不要', () => {
    // end 取 0.19:0.2 前一点点(0.199995)Spine 已经换到下一帧,那一步在 0.2 之内
    const steps = sequenceSteps([key(0, 'loop', 0, 0.05)], seq(3), 0.19)
    expect(steps.map((s) => s.frame)).toEqual([0, 1, 2, 0])
    // 步点比 j·delay 早 0.0001 个 delay —— 与 Spine 在步点上的取整一致
    steps.slice(1).forEach((s, i) => {
      expect(s.time).toBeLessThan((i + 1) * 0.05)
      expect(s.time).toBeCloseTo((i + 1) * 0.05, 4)
    })
  })

  it('阶梯在任何时刻都与逐点求值一致', () => {
    const s = seq(4)
    const keys = [key(0, 'loop', 1, 0.07), key(0.5, 'hold', 3, 0), key(0.62, 'pingpong', 0, 0.03)]
    const steps = sequenceSteps(keys, s, 1)
    for (let t = 0; t < 1; t += 0.0037) {
      const at = [...steps].reverse().find((st) => st.time <= t)!.frame
      expect(at).toBe(sequenceFrameAt(keys, s, t))
    }
  })

  it('没有时间轴时就是 setup 帧一个点', () => {
    expect(sequenceSteps(undefined, seq(4, 2), 1)).toEqual([{ time: 0, frame: 2 }])
  })

  it('一个周期多长 —— 动画时长为 0 时拿它当剪辑长度', () => {
    expect(sequenceCycle(key(0, 'loop', 0, 0.1), 5)).toBeCloseTo(0.5)
    expect(sequenceCycle(key(0, 'pingpong', 0, 0.1), 5)).toBeCloseTo(0.8)
    expect(sequenceCycle(key(0, 'hold', 0, 0.1), 5)).toBe(0)
  })
})
