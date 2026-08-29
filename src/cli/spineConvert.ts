import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { readSkeletonPart, type SpineMajor } from '../spine-format/binary/readSkeleton.ts'
import { writeSkeleton } from '../spine-format/binary/writeSkeleton.ts'
import { convertSkeleton } from '../spine-convert/skel/convert.ts'
import type { ConversionIssue } from '../spine-convert/types.ts'

/**
 * Spine `.skel` 批量版本转换的命令行入口。
 *
 * ```
 * pnpm convert <输入路径> --to 4.1 [--out 目录] [--dry-run]
 * ```
 *
 * **不会覆盖输入文件** —— 默认写到 `<输入目录>_converted`。
 * 同名的 `.atlas` / `.png` 会一并复制过去,让产物可以直接使用。
 */

const SKEL_SUFFIXES = ['.skel', '.skel.bytes']
/** 图集与贴图不随版本变化,直接复制 */
const COMPANION_SUFFIXES = ['.atlas', '.atlas.txt', '.png']

interface Options {
  readonly input: string
  readonly to: SpineMajor
  readonly targetVersion: string
  readonly out: string
  readonly dryRun: boolean
}

function parseArgs(argv: readonly string[]): Options | string {
  const positional: string[] = []
  const flags = new Map<string, string>()

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const key = arg.slice(2)
    if (key === 'dry-run') {
      flags.set(key, 'true')
      continue
    }
    const value = argv[++i]
    if (value === undefined) return `--${key} 缺少取值`
    flags.set(key, value)
  }

  const input = positional[0]
  if (input === undefined) return '缺少输入路径'
  if (!existsSync(input)) return `路径不存在:${input}`

  const to = flags.get('to')
  if (to === undefined) return '缺少 --to(目标版本,如 --to 4.1 或 --to 3.8)'
  if (!/^[34]\.\d/.test(to)) return `无法识别的目标版本:${to}`

  const major: SpineMajor = to.startsWith('3.') ? '3.8' : '4.x'
  const inputIsDir = statSync(input).isDirectory()
  const baseDir = inputIsDir ? input : dirname(input)

  return {
    input: resolve(input),
    to: major,
    // 用户给了完整版本号(如 4.1.23)就照写,否则用该大版本的常见补丁号
    targetVersion: /^\d+\.\d+\.\d+$/.test(to) ? to : major === '3.8' ? '3.8.95' : '4.1.23',
    out: resolve(flags.get('out') ?? `${baseDir}_converted`),
    dryRun: flags.has('dry-run'),
  }
}

function isSkel(name: string): boolean {
  return SKEL_SUFFIXES.some((s) => name.endsWith(s))
}

function collectSkelFiles(root: string): string[] {
  if (statSync(root).isFile()) return isSkel(root) ? [root] : []

  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (isSkel(entry.name)) out.push(full)
    }
  }
  walk(root)
  return out.sort()
}

/** 去掉 .skel / .skel.bytes 后缀,拿到用于配对 atlas / png 的基名 */
function skeletonBaseName(file: string): string {
  const name = basename(file)
  for (const suffix of SKEL_SUFFIXES) {
    if (name.endsWith(suffix)) return name.slice(0, -suffix.length)
  }
  return name.slice(0, -extname(name).length)
}

interface FileResult {
  readonly file: string
  readonly from: string
  readonly to: string
  readonly status: 'converted' | 'skipped' | 'failed'
  readonly note: string
  readonly issues: readonly ConversionIssue[]
}

function convertFile(file: string, options: Options, baseDir: string): FileResult {
  const rel = relative(baseDir, file)
  const bytes = new Uint8Array(readFileSync(file))

  let part
  try {
    part = readSkeletonPart(bytes)
  } catch (error) {
    return {
      file: rel, from: '?', to: options.targetVersion, status: 'failed',
      note: error instanceof Error ? error.message : String(error), issues: [],
    }
  }

  if (part.failure !== null) {
    return {
      file: rel, from: part.header.version, to: options.targetVersion, status: 'failed',
      note: `解析中断于动画「${part.failure.name}」偏移 ${part.failure.offset}:${part.failure.message}`,
      issues: [],
    }
  }

  if (part.header.major === options.to) {
    return {
      file: rel, from: part.header.version, to: part.header.version, status: 'skipped',
      note: '已经是目标版本', issues: [],
    }
  }

  const { part: converted, issues } = convertSkeleton(part, options.to, options.targetVersion)
  const output = writeSkeleton(converted)

  // 立刻回读一遍 —— 与其产出一个坏文件,不如当场失败
  const verify = readSkeletonPart(output)
  if (verify.failure !== null || verify.endOffset !== verify.totalBytes) {
    return {
      file: rel, from: part.header.version, to: options.targetVersion, status: 'failed',
      note: `产物自检未通过:${verify.failure?.message ?? '未读到文件末尾'}`, issues,
    }
  }

  if (!options.dryRun) {
    const target = join(options.out, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, output)

    // 图集与贴图不随版本变化,一并复制,让产物可直接使用
    const base = skeletonBaseName(file)
    for (const suffix of COMPANION_SUFFIXES) {
      const companion = join(dirname(file), base + suffix)
      if (existsSync(companion)) {
        copyFileSync(companion, join(dirname(target), base + suffix))
      }
    }
  }

  return {
    file: rel, from: part.header.version, to: options.targetVersion,
    status: 'converted', note: '', issues,
  }
}

function report(results: readonly FileResult[], options: Options): number {
  const width = Math.max(4, ...results.map((r) => r.file.length))
  console.log('')
  for (const r of results) {
    const mark = { converted: '✅', skipped: '·', failed: '❌' }[r.status]
    const losses = r.issues.filter((i) => i.level === 'loss').length
    const approx = r.issues.filter((i) => i.level === 'approximated').length
    const tail = [
      losses > 0 ? `丢失 ${losses}` : '',
      approx > 0 ? `近似 ${approx}` : '',
      r.note,
    ].filter(Boolean).join('  ')
    console.log(`  ${mark} ${r.file.padEnd(width)}  ${r.from} → ${r.to}  ${tail}`)
  }

  // 有损项逐条列出 —— 这是本工具存在的意义之一,不能只给个数字
  const withIssues = results.filter((r) => r.issues.some((i) => i.level !== 'info'))
  if (withIssues.length > 0) {
    console.log('\n── 需要人工确认的转换损失 ──')
    for (const r of withIssues) {
      console.log(`\n  ${r.file}`)

      // 同一条说明往往命中很多条时间轴 —— 按说明归组再列出受影响的位置。
      // 逐条重复打印同一句话,只会把真正重要的信息淹掉。
      const grouped = new Map<string, { level: string; paths: string[] }>()
      for (const i of r.issues) {
        if (i.level === 'info') continue
        const g = grouped.get(i.message)
        if (g === undefined) grouped.set(i.message, { level: i.level, paths: [i.path] })
        else g.paths.push(i.path)
      }

      for (const [message, g] of grouped) {
        console.log(`    [${g.level}] ${message}`)
        const shown = g.paths.slice(0, 8).join('、')
        const more = g.paths.length > 8 ? ` 等 ${g.paths.length} 处` : ''
        console.log(`      影响 ${g.paths.length} 处:${shown}${more}`)
      }
    }
  }

  const converted = results.filter((r) => r.status === 'converted').length
  const skipped = results.filter((r) => r.status === 'skipped').length
  const failed = results.filter((r) => r.status === 'failed').length

  console.log(
    `\n合计 ${results.length} 个文件:转换 ${converted},跳过 ${skipped},失败 ${failed}` +
      (options.dryRun ? '\n(--dry-run,未写出任何文件)' : `\n输出目录:${options.out}`),
  )
  return failed > 0 ? 1 : 0
}

function main(): number {
  const parsed = parseArgs(process.argv.slice(2))
  if (typeof parsed === 'string') {
    console.error(`✗ ${parsed}\n`)
    console.error('用法:  pnpm convert <输入路径> --to <版本> [--out <目录>] [--dry-run]')
    console.error('例:    pnpm convert res/spine/3.8 --to 4.1')
    console.error('       pnpm convert res/spine --to 3.8 --out /tmp/out --dry-run')
    return 2
  }

  const files = collectSkelFiles(parsed.input)
  if (files.length === 0) {
    console.error(`✗ ${parsed.input} 下没有找到 .skel / .skel.bytes 文件`)
    return 1
  }

  const baseDir = statSync(parsed.input).isDirectory() ? parsed.input : dirname(parsed.input)
  console.log(`找到 ${files.length} 个骨骼文件,目标版本 ${parsed.targetVersion}`)

  return report(files.map((f) => convertFile(f, parsed, baseDir)), parsed)
}

process.exit(main())
