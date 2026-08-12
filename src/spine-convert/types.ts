/**
 * Spine 版本转换器。
 *
 * ⚠️ **这个模块和编辑器完全无关,不要让它依赖 core/。**
 *
 * 它不把数据导入成本工具的格式再导出 —— 那样会静默丢掉 IK、约束、网格形变、
 * events 等我们的格式不表达的东西,转出来的文件能播但内容残缺。
 * 它直接在 JSON 树上做变换:**只改版本之间真正变了的结构,其余原样透传。**
 */

/** 支持的版本。新增版本时同时在 registry 里加一条相邻迁移。 */
export const SPINE_VERSIONS = ['3.8', '4.0', '4.1', '4.2'] as const

export type SpineVersion = (typeof SPINE_VERSIONS)[number]

/** Spine JSON 顶层结构。刻意用宽松类型 —— 我们只认识要改的那部分。 */
export type SpineJson = Record<string, unknown>

export type IssueLevel =
  /** 有损:目标版本没有对应物,内容已经丢了 */
  | 'loss'
  /** 近似:换了种方式表达,视觉上可能有细微差别 */
  | 'approximated'
  /** 提示:做了结构调整,但语义等价 */
  | 'info'

export interface ConversionIssue {
  readonly level: IssueLevel
  /** 出问题的位置,如 `animations.walk.bones.arm` */
  readonly path: string
  readonly message: string
}

export interface ConversionReport {
  readonly from: SpineVersion
  readonly to: SpineVersion
  /** 实际走过的版本链,如 ['3.8', '4.0', '4.1'] */
  readonly path: readonly SpineVersion[]
  readonly issues: readonly ConversionIssue[]
}

/** 迁移过程中收集问题。传给每个迁移步骤。 */
export class IssueCollector {
  private readonly items: ConversionIssue[] = []
  private prefix = ''

  /** 限定后续 add 的路径前缀,便于在深层结构里定位 */
  scoped<T>(path: string, fn: () => T): T {
    const saved = this.prefix
    this.prefix = this.prefix === '' ? path : `${this.prefix}.${path}`
    try {
      return fn()
    } finally {
      this.prefix = saved
    }
  }

  add(level: IssueLevel, path: string, message: string): void {
    const full = [this.prefix, path].filter((s) => s !== '').join('.')
    this.items.push({ level, path: full, message })
  }

  loss(path: string, message: string): void {
    this.add('loss', path, message)
  }

  get all(): readonly ConversionIssue[] {
    return this.items
  }
}

/**
 * 一步**相邻版本**之间的迁移。
 *
 * 只允许相邻 —— 跨版本靠 registry 串联。这样加一个新版本只需要写一个迁移,
 * 而不是给每个已有版本各写一个。
 */
export interface Migration {
  readonly from: SpineVersion
  readonly to: SpineVersion

  /** from → to。允许原地修改传入对象,调用方已经克隆过。 */
  up(json: SpineJson, issues: IssueCollector): SpineJson

  /** to → from。降级通常有损,丢东西时必须调 issues.loss()。 */
  down(json: SpineJson, issues: IssueCollector): SpineJson
}
