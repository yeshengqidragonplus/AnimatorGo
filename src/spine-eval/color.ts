import type { Timeline } from '../spine-format/binary/readAnimations.ts'
import { valueBetween } from './pose.ts'

/** 0..1 的 RGBA */
export type Rgba = readonly [number, number, number, number]

/** Spine 打包的 0xRRGGBBAA → 0..1 */
export function unpackRgba(packed: number): Rgba {
  return [((packed >>> 24) & 0xff) / 255, ((packed >>> 16) & 0xff) / 255, ((packed >>> 8) & 0xff) / 255, (packed & 0xff) / 255]
}

/** 某一时刻 slot 的颜色:各颜色时间轴按顺序套用(rgba 管四个通道,rgb 管三个,alpha 管一个) */
export function slotColorAt(timelines: readonly Timeline[], setup: Rgba, time: number, is38: boolean): Rgba {
  const c = [...setup] as [number, number, number, number]
  for (const t of timelines) {
    const frames = t.frames
    if (frames.length === 0 || time < Number(frames[0]!['time'] ?? 0)) continue
    let i = frames.length - 1
    for (let k = 0; k < frames.length - 1; k++) if (time < Number(frames[k + 1]!['time'])) { i = k; break }
    const channel = (idx: number): number => {
      const get = (f: Record<string, unknown>) => {
        if (t.kind === 'color' || t.kind === 'twoColor') return unpackRgba((f['colors'] as number[])[0]!)[idx]!
        const bytes = f['color'] as number[]
        return bytes[idx]! / 255
      }
      if (i === frames.length - 1) return get(frames[i]!)
      // 借 valueBetween 的曲线求值:把这一通道临时放进一个字段
      const pair = [{ ...frames[i]!, v: get(frames[i]!) }, { ...frames[i + 1]!, v: get(frames[i + 1]!) }]
      return valueBetween(pair, 0, 'v', time, is38, idx)
    }
    if (t.kind === 'slotColor5') c[3] = channel(0)
    else if (t.kind === 'slotColor2' || t.kind === 'slotColor4') { c[0] = channel(0); c[1] = channel(1); c[2] = channel(2) }
    else { c[0] = channel(0); c[1] = channel(1); c[2] = channel(2); c[3] = channel(3) }
  }
  return c
}

