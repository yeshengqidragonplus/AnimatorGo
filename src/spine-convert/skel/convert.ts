import type { SkeletonPart, SpineMajor } from '../../spine-format/binary/readSkeleton.ts'
import type { AnimationData, Timeline } from '../../spine-format/binary/readAnimations.ts'
import { IssueCollector, type ConversionIssue } from '../types.ts'

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
 * | 贝塞尔曲线 | 一条 → 每分量各一条(复制) | **N 条取第一条,有损** |
 * | bezierCount | 需要算出来 | 丢弃 |
 * | 单轴时间轴 | —— | **3.8 没有,需合成或丢弃** |
 * | sequence | 无 → null | **有则丢失** |
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

/** 升级:3.8 的单条曲线复制到每个分量上。无损。 */
function expandCurve(frame: Record<string, unknown>, components: number): Record<string, unknown> {
  if (frame['curve'] !== 'bezier') return frame
  const single = (frame['beziers'] as number[][])[0]!
  return { ...frame, beziers: Array.from({ length: components }, () => [...single]) }
}

/**
 * 降级:N 条曲线只能留一条。各分量曲线不同时会丢信息。
 *
 * `report` 每条时间轴只调一次 —— 逐帧报会刷屏,而用户关心的是
 * 「哪条时间轴受影响」,不是「第几帧」。
 */
function collapseCurve(
  frame: Record<string, unknown>,
  report: () => void,
): Record<string, unknown> {
  if (frame['curve'] !== 'bezier') return frame
  const beziers = frame['beziers'] as number[][]
  const first = beziers[0]!

  if (beziers.some((b) => b.some((n, i) => n !== first[i]))) report()
  return { ...frame, beziers: [[...first]] }
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
  '各分量的贝塞尔曲线不同,3.8 每条时间轴只能存一条,已取第一个分量的曲线'

// ─── 时间轴 ──────────────────────────────────────────────────────────────────

function upgradeTimeline(t: Timeline): Timeline {
  // slot 颜色:打包 int → 分通道字节
  if (t.kind === 'color' || t.kind === 'twoColor') {
    const kind = t.kind === 'color' ? 'slotColor1' : 'slotColor3'
    const components = componentsOf(kind)
    const frames = t.frames.map((f) => {
      const colors = f['colors'] as number[]
      const bytes =
        t.kind === 'color'
          ? unpackRgba(colors[0]!)
          : [...unpackRgba(colors[0]!), ...unpackRgb(colors[1]!)]
      const { colors: _drop, ...rest } = f
      return expandCurve({ ...rest, color: bytes }, components)
    })
    return { kind, owner: t.owner, frames, bezierCount: countBeziers(frames, components) }
  }

  if (t.kind === 'attachment' || t.kind === 'drawOrder' || t.kind === 'event') {
    return { ...t, bezierCount: -1 }
  }

  // deform 的帧套了一层(skin/attachment 包装)
  if (t.kind === 'deform') {
    const wrapper = t.frames[0] as Record<string, unknown>
    const inner = (wrapper['frames'] as Record<string, unknown>[]).map((f) => expandCurve(f, 1))
    return {
      kind: t.kind,
      owner: t.owner,
      frames: [{ ...wrapper, frames: inner }],
      bezierCount: countBeziers(inner, 1),
    }
  }

  const components = componentsOf(t.kind)
  const frames = t.frames.map((f) => expandCurve(f, components))
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
    const frames = t.frames.map((f) => {
      const { value, ...rest } = f
      const other = single.axis === 'x' ? 'y' : 'x'
      return collapseCurve({ ...rest, [single.axis]: value, [other]: single.neutral }, collapsed)
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
    const frames = t.frames.map((f) => {
      const c = f['color'] as number[]
      // 缺的通道补 255(不透明白),这是 3.8 里的中性值
      const rgba = [c[0] ?? 255, c[1] ?? 255, c[2] ?? 255, type === 5 ? c[0]! : (c[3] ?? 255)]
      const colors = twoColor ? [packRgba(rgba), packRgb(c.slice(4))] : [packRgba(rgba)]
      const { color: _drop, ...rest } = f
      return collapseCurve({ ...rest, colors }, collapsed)
    })
    return { kind: twoColor ? 'twoColor' : 'color', owner: t.owner, frames, bezierCount: -1 }
  }

  if (t.kind === 'attachment' || t.kind === 'drawOrder' || t.kind === 'event') {
    return { ...t, bezierCount: -1 }
  }

  if (t.kind === 'deform') {
    const wrapper = t.frames[0] as Record<string, unknown>
    const inner = (wrapper['frames'] as Record<string, unknown>[]).map((f) =>
      collapseCurve(f, collapsed),
    )
    return { kind: t.kind, owner: t.owner, frames: [{ ...wrapper, frames: inner }], bezierCount: -1 }
  }

  const frames = t.frames.map((f) => collapseCurve(f, collapsed))
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
