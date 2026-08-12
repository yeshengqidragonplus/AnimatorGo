import {
  IssueCollector,
  SPINE_VERSIONS,
  type ConversionReport,
  type Migration,
  type SpineJson,
  type SpineVersion,
} from './types.ts'

/**
 * 版本链与转换调度。
 *
 * 迁移只在**相邻**版本之间定义,跨版本沿链串联:
 *
 *   3.8 ⇄ 4.0 ⇄ 4.1 ⇄ 4.2
 *
 * 3.8 → 4.2 就是依次走三步。新增 4.3 时只写 4.2⇄4.3 一个迁移,
 * 所有旧版本立刻都能转到 4.3 —— 这是不做 N×N 转换器的关键。
 */

const registry = new Map<string, Migration>()

const key = (a: SpineVersion, b: SpineVersion) => `${a}->${b}`

export function registerMigration(migration: Migration): void {
  const { from, to } = migration

  const i = SPINE_VERSIONS.indexOf(from)
  const j = SPINE_VERSIONS.indexOf(to)
  if (i < 0 || j < 0) {
    throw new Error(`未知版本:${from} 或 ${to}`)
  }
  if (j - i !== 1) {
    throw new Error(
      `迁移只能定义在相邻版本之间,收到 ${from} → ${to}。` +
        `跨版本请依赖链式串联,不要直接注册。`,
    )
  }

  registry.set(key(from, to), migration)
}

/** 仅供测试重置用 */
export function clearMigrations(): void {
  registry.clear()
}

/** 沿版本序列列出 from → to 要经过的版本,含首尾 */
export function versionPath(from: SpineVersion, to: SpineVersion): SpineVersion[] {
  const i = SPINE_VERSIONS.indexOf(from)
  const j = SPINE_VERSIONS.indexOf(to)
  if (i < 0) throw new Error(`未知版本:${from}`)
  if (j < 0) throw new Error(`未知版本:${to}`)

  const step = i <= j ? 1 : -1
  const path: SpineVersion[] = []
  for (let k = i; ; k += step) {
    path.push(SPINE_VERSIONS[k]!)
    if (k === j) break
  }
  return path
}

export interface ConvertResult {
  readonly json: SpineJson
  readonly report: ConversionReport
}

/**
 * 把 Spine JSON 从一个版本转到另一个版本。
 *
 * 输入不会被修改 —— 内部先深拷贝。缺少某一段迁移时立刻抛错,
 * 而不是跳过那一步默默产出一个半转换的文件。
 */
export function convert(json: SpineJson, from: SpineVersion, to: SpineVersion): ConvertResult {
  const path = versionPath(from, to)
  const issues = new IssueCollector()

  let current: SpineJson = structuredClone(json)

  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!
    const b = path[i + 1]!
    const forward = SPINE_VERSIONS.indexOf(a) < SPINE_VERSIONS.indexOf(b)

    // 迁移只按升序注册,降级走同一个迁移的 down()
    const migration = registry.get(forward ? key(a, b) : key(b, a))
    if (migration === undefined) {
      throw new Error(`缺少 ${a} ⇄ ${b} 的迁移,无法完成 ${from} → ${to}`)
    }

    current = issues.scoped(`[${a}→${b}]`, () =>
      forward ? migration.up(current, issues) : migration.down(current, issues),
    )
  }

  // 版本号本身也要更新,否则 Spine 会按旧版本解析
  const skeleton = current['skeleton']
  if (skeleton !== null && typeof skeleton === 'object') {
    ;(skeleton as Record<string, unknown>)['spine'] = to
  }

  return { json: current, report: { from, to, path, issues: issues.all } }
}

/** 读 skeleton.spine 字段。识别不出返回 null,由调用方决定怎么办。 */
export function detectVersion(json: SpineJson): SpineVersion | null {
  const skeleton = json['skeleton']
  if (skeleton === null || typeof skeleton !== 'object') return null

  const raw = (skeleton as Record<string, unknown>)['spine']
  if (typeof raw !== 'string') return null

  // "4.1.24" → "4.1";Spine 的补丁号不影响格式结构
  const major = raw.split('.').slice(0, 2).join('.')
  return (SPINE_VERSIONS as readonly string[]).includes(major) ? (major as SpineVersion) : null
}
