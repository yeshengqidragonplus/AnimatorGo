import type { SkeletonPart, SpineMajor } from '../../spine-format/binary/readSkeleton.ts'
import type { AnimationData, Timeline } from '../../spine-format/binary/readAnimations.ts'
import { IssueCollector, type ConversionIssue } from '../types.ts'
import { curveValuesOf, toAbsoluteBezier, toNormalizedBezier } from '../../spine-format/bezier.ts'

/**
 * `.skel` 的版本转换。
 *
 * 读取器已经把一部分差异**归一化**成 4.x 的形状了(transform / path 约束的 mix
 * 拆分、骨骼时间轴类型),所以这里只需要处理剩下真正需要变形的部分:
 *
 * | 项目 | 升级 3.8 → 4.x | 降级 4.x → 3.8 |
 * |---|---|---|
 * | 文件头 hash | 字符串 → 8 字节(重算) | 反之 |
 * | slot 颜色时间轴 | 打包 int → 分通道字节 | 反之 |
 * | 贝塞尔曲线 | 一条**归一化** → 每分量一条**绝对** | 反之,N 条取一条,可能有损 |
 * | bezierCount | 需要算出来 | 丢弃 |
 * | 单轴时间轴 | —— | **3.8 没有,需合成或丢弃** |
 * | sequence | 无 → null | **有则丢失** |
 *
 * ⚠️ 贝塞尔那一行不是「复制」那么简单 —— **两版的控制点坐标系不同**,
 * 3.8 是归一化的百分比,4.x 是绝对的时间与取值。照抄过去动画照播,
 * 但所有缓动都会变形。见 [bezier.ts](../../spine-format/bezier.ts)。
 *
 * 见 [docs/SPINE-BINARY.md](../../../docs/SPINE-BINARY.md)。
 */

export interface SkelConversionResult {
  readonly part: SkeletonPart
  readonly issues: readonly ConversionIssue[]
}

/** 各时间轴的值分量数 —— 决定 4.x 要写几条贝塞尔 */
function componentsOf(kind: string): number {
  if (kind.startsWith('slotColor')) {
    return { slotColor1: 4, slotColor2: 3, slotColor3: 7, slotColor4: 6, slotColor5: 1 }[kind] ?? 1
  }
  switch (kind) {
    case 'color': return 4
    case 'twoColor': return 7
    case 'translate': case 'scale': case 'shear': return 2
    case 'ik': return 2
    case 'transform': return 6
    case 'path2': return 3
    case 'deform': return 1
    default: return 1
  }
}

/** 4.x 时间轴头里的贝塞尔总数 = 各帧曲线所占的分量数之和 */
function countBeziers(frames: readonly Record<string, unknown>[], components: number): number {
  let total = 0
  for (let i = 0; i < frames.length - 1; i++) {
    if (frames[i]!['curve'] === 'bezier') total += components
  }
  return total
}

// ─── 颜色编码 ────────────────────────────────────────────────────────────────

/** 0xRRGGBBAA → [r, g, b, a] */
function unpackRgba(color: number): number[] {
  return [(color >>> 24) & 0xff, (color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff]
}

/** 0x00RRGGBB → [r, g, b] */
function unpackRgb(color: number): number[] {
  return [(color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff]
}

function packRgba(bytes: readonly number[]): number {
  return (((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0) | 0
}

function packRgb(bytes: readonly number[]): number {
  return (bytes[0]! << 16) | (bytes[1]! << 8) | bytes[2]!
}

// ─── 曲线 ────────────────────────────────────────────────────────────────────

/**
 * 升级:3.8 的单条**归一化**曲线 → 4.x 每分量一条**绝对**曲线。
 *
 * ⚠️ 不只是复制。3.8 的控制点是「占该段时间/取值的百分比」,4.x 是绝对的时间和取值 ——
 * 直接抄过去动画照播,但**所有缓动都会变形**。见 [bezier.ts](../../spine-format/bezier.ts)。
 *
 * 各分量的取值范围不同,所以换算出来的 N 条曲线一般**互不相同**。
 */
function expandCurves(
  kind: string,
  frames: readonly Record<string, unknown>[],
  components: number,
): Record<string, unknown>[] {
  return frames.map((frame, i) => {
    if (frame['curve'] !== 'bezier') return frame
    const single = (frame['beziers'] as number[][])[0]!
    const next = frames[i + 1]

    // 取值空间一致(deform)或没有数值可插值时不换算,原样复制
    const from = next === undefined ? null : curveValuesOf(kind, frame, true)
    const to = next === undefined ? null : curveValuesOf(kind, next, true)
    if (from === null || to === null) {
      return { ...frame, beziers: Array.from({ length: components }, () => [...single]) }
    }

    const t0 = frame['time'] as number
    const t1 = next!['time'] as number
    return {
      ...frame,
      beziers: Array.from({ length: components }, (_, c) =>
        toAbsoluteBezier(single, t0, from[c] ?? 0, t1, to[c] ?? 0),
      ),
    }
  })
}

/**
 * 降级:4.x 每分量一条**绝对**曲线 → 3.8 单条**归一化**曲线。
 *
 * 先各自归一化再比较 —— 各分量取值范围不同,绝对值几乎必然不等,
 * 直接比会把「形状其实一样」的情况也报成有损。
 *
 * 代表分量取**取值变化最大**的那个:首尾取值相同的分量归一化没有意义,
 * 拿它当代表会把曲线丢成一条直线。
 *
 * `report` 每条时间轴只调一次 —— 逐帧报会刷屏,而用户关心的是
 * 「哪条时间轴受影响」,不是「第几帧」。
 */
function collapseCurves(
  kind: string,
  frames: readonly Record<string, unknown>[],
  report: () => void,
): Record<string, unknown>[] {
  return frames.map((frame, i) => {
    if (frame['curve'] !== 'bezier') return frame
    const beziers = frame['beziers'] as number[][]
    const next = frames[i + 1]

    const from = next === undefined ? null : curveValuesOf(kind, frame, false)
    const to = next === undefined ? null : curveValuesOf(kind, next, false)
    if (from === null || to === null) {
      if (beziers.some((b) => b.some((n, at) => n !== beziers[0]![at]))) report()
      return { ...frame, beziers: [[...beziers[0]!]] }
    }

    const t0 = frame['time'] as number
    const t1 = next!['time'] as number
    const normalized = beziers.map((b, c) => toNormalizedBezier(b, t0, from[c] ?? 0, t1, to[c] ?? 0))

    let best = 0
    let bestSpan = -1
    beziers.forEach((_, c) => {
      const span = Math.abs((to[c] ?? 0) - (from[c] ?? 0))
      if (span > bestSpan) {
        bestSpan = span
        best = c
      }
    })

    const chosen = normalized[best]!
    // 取值不变的分量归一化后是全 0,不算「形状不同」
    const differs = normalized.some(
      (n, c) => Math.abs((to[c] ?? 0) - (from[c] ?? 0)) > 1e-9 && n.some((v, at) => Math.abs(v - chosen[at]!) > 1e-6),
    )
    if (differs) report()
    return { ...frame, beziers: [[...chosen]] }
  })
}

/** 造一个「同一条时间轴只报一次」的回调 */
function onceReporter(issues: IssueCollector, where: string, message: string): () => void {
  let reported = false
  return () => {
    if (reported) return
    reported = true
    issues.loss(where, message)
  }
}

const CURVE_COLLAPSE_MESSAGE =
  '各分量的贝塞尔曲线形状不同,3.8 每条时间轴只能存一条,已取取值变化最大的那个分量'

// ─── 时间轴 ──────────────────────────────────────────────────────────────────

function upgradeTimeline(t: Timeline): Timeline {
  // slot 颜色:打包 int → 分通道字节
  if (t.kind === 'color' || t.kind === 'twoColor') {
    const kind = t.kind === 'color' ? 'slotColor1' : 'slotColor3'
    const components = componentsOf(kind)
    // 先按 3.8 的形状换算曲线,再改帧的形状 —— 换算要读原来的 colors
    const frames = expandCurves(t.kind, t.frames, components).map((f) => {
      const colors = f['colors'] as number[]
      const bytes =
        t.kind === 'color'
          ? unpackRgba(colors[0]!)
          : [...unpackRgba(colors[0]!), ...unpackRgb(colors[1]!)]
      const { colors: _drop, ...rest } = f
      return { ...rest, color: bytes }
    })
    return { kind, owner: t.owner, frames, bezierCount: countBeziers(frames, components) }
  }

  if (t.kind === 'attachment' || t.kind === 'drawOrder' || t.kind === 'event') {
    return { ...t, bezierCount: -1 }
  }

  // deform 的帧套了一层(skin/attachment 包装)
  if (t.kind === 'deform') {
    const wrapper = t.frames[0] as Record<string, unknown>
    const inner = expandCurves(t.kind, wrapper['frames'] as Record<string, unknown>[], 1)
    return {
      kind: t.kind,
      owner: t.owner,
      frames: [{ ...wrapper, frames: inner }],
      bezierCount: countBeziers(inner, 1),
    }
  }

  const components = componentsOf(t.kind)
  const frames = expandCurves(t.kind, t.frames, components)
  return { kind: t.kind, owner: t.owner, frames, bezierCount: countBeziers(frames, components) }
}

function downgradeTimeline(t: Timeline, issues: IssueCollector): Timeline | null {
  const where = `${t.kind}[${t.owner}]`
  const collapsed = onceReporter(issues, where, CURVE_COLLAPSE_MESSAGE)

  // 4.x 的单轴时间轴在 3.8 没有容器 —— 补上中性的另一轴即可无损表达
  const SINGLE_AXIS: Record<string, { kind: string; axis: 'x' | 'y'; neutral: number }> = {
    translateX: { kind: 'translate', axis: 'x', neutral: 0 },
    translateY: { kind: 'translate', axis: 'y', neutral: 0 },
    scaleX: { kind: 'scale', axis: 'x', neutral: 1 },
    scaleY: { kind: 'scale', axis: 'y', neutral: 1 },
    shearX: { kind: 'shear', axis: 'x', neutral: 0 },
    shearY: { kind: 'shear', axis: 'y', neutral: 0 },
  }

  const single = SINGLE_AXIS[t.kind]
  if (single !== undefined) {
    issues.add(
      'approximated',
      where,
      `3.8 没有单轴时间轴,已转成双轴并把另一轴填为中性值 ${single.neutral}`,
    )
    const other = single.axis === 'x' ? 'y' : 'x'
    const frames = collapseCurves(t.kind, t.frames, collapsed).map((f) => {
      const { value, ...rest } = f
      return { ...rest, [single.axis]: value, [other]: single.neutral }
    })
    return { kind: single.kind, owner: t.owner, frames, bezierCount: -1 }
  }

  // slot 颜色:分通道字节 → 打包 int
  if (t.kind.startsWith('slotColor')) {
    const type = Number(t.kind.replace('slotColor', ''))
    if (type === 2 || type === 4 || type === 5) {
      issues.add(
        'approximated',
        where,
        '3.8 没有只改部分通道的颜色时间轴,已补齐为完整 RGBA',
      )
    }
    const twoColor = type === 3 || type === 4
    const frames = collapseCurves(t.kind, t.frames, collapsed).map((f) => {
      const c = f['color'] as number[]
      // 缺的通道补 255(不透明白),这是 3.8 里的中性值
      const rgba = [c[0] ?? 255, c[1] ?? 255, c[2] ?? 255, type === 5 ? c[0]! : (c[3] ?? 255)]
      const colors = twoColor ? [packRgba(rgba), packRgb(c.slice(4))] : [packRgba(rgba)]
      const { color: _drop, ...rest } = f
      return { ...rest, colors }
    })
    return { kind: twoColor ? 'twoColor' : 'color', owner: t.owner, frames, bezierCount: -1 }
  }

  if (t.kind === 'attachment' || t.kind === 'drawOrder' || t.kind === 'event') {
    return { ...t, bezierCount: -1 }
  }

  if (t.kind === 'deform') {
    const wrapper = t.frames[0] as Record<string, unknown>
    const inner = collapseCurves(t.kind, wrapper['frames'] as Record<string, unknown>[], collapsed)
    return { kind: t.kind, owner: t.owner, frames: [{ ...wrapper, frames: inner }], bezierCount: -1 }
  }

  const frames = collapseCurves(t.kind, t.frames, collapsed)
  return { kind: t.kind, owner: t.owner, frames, bezierCount: -1 }
}

function convertAnimation(
  anim: AnimationData,
  toMajor: SpineMajor,
  issues: IssueCollector,
): AnimationData {
  return issues.scoped(anim.name, () => {
    const timelines = anim.timelines
      .map((t) => (toMajor === '4.x' ? upgradeTimeline(t) : downgradeTimeline(t, issues)))
      .filter((t): t is Timeline => t !== null)
    return { ...anim, timelines }
  })
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

/** 目标版本号写进文件头。Spine 只看前两段,补丁号取各版本的常见值。 */
const VERSION_STRING: Record<SpineMajor, string> = { '3.8': '3.8.95', '4.x': '4.1.23' }

export function convertSkeleton(
  part: SkeletonPart,
  toMajor: SpineMajor,
  targetVersion?: string,
): SkelConversionResult {
  const issues = new IssueCollector()

  if (part.header.major === toMajor) {
    return { part, issues: issues.all }
  }

  // hash 是内容校验和,跨版本无法沿用 —— 置零。Spine 运行时只拿它做缓存比对,
  // 置零不影响播放,但要说明,免得有人以为是数据损坏。
  issues.add('info', 'header.hash', '版本变更后原 hash 失效,已置零(仅用于缓存比对,不影响播放)')

  if (toMajor === '4.x') {
    issues.add('info', 'header', '升级方向:3.8 的每条曲线会复制到各分量上,无损')
  } else {
    issues.add('info', 'header', '降级方向:4.x 独有的特性无法完整表达,详见其余条目')

    const withSequence = part.skins.flatMap((s) =>
      s.slots.flatMap((e) => e.attachments.filter((a) => a.sequence !== null)),
    )
    for (const a of withSequence) {
      issues.loss(`skin.${a.key}`, 'sequence 是 4.1 新增特性,3.8 没有对应物,已丢弃')
    }
  }

  const header = {
    ...part.header,
    major: toMajor,
    version: targetVersion ?? VERSION_STRING[toMajor],
    hash: toMajor === '4.x' ? '0000000000000000' : null,
  }

  const animations = part.animations.map((a) => convertAnimation(a, toMajor, issues))

  // 降级时清掉 sequence(升级方向 3.8 本来就是 null)
  const skins =
    toMajor === '3.8'
      ? part.skins.map((s) => ({
          ...s,
          slots: s.slots.map((e) => ({
            ...e,
            attachments: e.attachments.map((a) => ({ ...a, sequence: null })),
          })),
        }))
      : part.skins

  return { part: { ...part, header, skins, animations }, issues: issues.all }
}
