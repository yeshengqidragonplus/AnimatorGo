import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { readSkeletonPart, type SkeletonPart } from '../spine-format/binary/readSkeleton.ts'
import { fromJsonText } from '../spine-format/json/fromJson.ts'
import { parseAtlas } from '../core/atlas.ts'
import { decodePng, type Image } from '../unity/png.ts'
import { exportToUnity } from '../spine-convert/unity/export.ts'
import type { ConversionIssue } from '../spine-convert/types.ts'

/**
 * Spine → Unity 2D Animation 的命令行入口。
 *
 * ```
 * pnpm unity <骨架文件或目录> [--out 目录] [--ppu 100] [--atlas 图集] [--dry-run]
 * ```
 *
 * 每个骨架产出一套可以**直接拖进 Assets 就能播**的资源:
 * 烘焙后的图集 PNG + `.meta`、prefab、每条动画一个 `.anim`、一个 AnimatorController。
 *
 * **不会覆盖输入** —— 默认写到 `<输入目录>_unity`。
 */

const SKEL_SUFFIXES = ['.skel', '.skel.bytes']
const JSON_SUFFIX = '.json'

interface Options {
  readonly input: string
  readonly out: string
  readonly pixelsPerUnit: number
  readonly dryRun: boolean
  /** 显式指定图集;null 表示按文件名去找 */
  readonly atlas: string | null
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

  const ppu = Number(flags.get('ppu') ?? '100')
  if (!Number.isFinite(ppu) || ppu <= 0) return `--ppu 要是正数,收到 "${flags.get('ppu')}"`

  const atlas = flags.get('atlas') ?? null
  if (atlas !== null && !existsSync(atlas)) return `图集不存在:${atlas}`

  const resolved = resolve(input)
  const base = statSync(resolved).isDirectory() ? resolved : dirname(resolved)

  return {
    input: resolved,
    out: resolve(flags.get('out') ?? `${base}_unity`),
    pixelsPerUnit: ppu,
    dryRun: flags.has('dry-run'),
    atlas: atlas === null ? null : resolve(atlas),
  }
}

/** 骨架文件名去掉后缀 —— `.skel.bytes` 要去两层 */
function stemOf(file: string): string {
  const name = basename(file)
  for (const suffix of SKEL_SUFFIXES) {
    if (name.toLowerCase().endsWith(suffix)) return name.slice(0, -suffix.length)
  }
  return name.slice(0, -extname(name).length)
}

function isSkeleton(file: string): boolean {
  const lower = file.toLowerCase()
  return SKEL_SUFFIXES.some((s) => lower.endsWith(s)) || lower.endsWith(JSON_SUFFIX)
}

function collect(input: string): string[] {
  if (!statSync(input).isDirectory()) return [input]
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (isSkeleton(full)) out.push(full)
    }
  }
  walk(input)
  return out.sort()
}

function readSkeleton(file: string): SkeletonPart {
  const bytes = readFileSync(file)
  if (file.toLowerCase().endsWith(JSON_SUFFIX)) return fromJsonText(bytes.toString('utf8'))
  return readSkeletonPart(new Uint8Array(bytes))
}

const ATLAS_SUFFIXES = ['.atlas', '.atlas.txt']

/**
 * 找骨架旁边的图集。
 *
 * Spine 导出时图集和骨架同名,但实际拿到的文件往往不是:
 * Unity 工程里习惯 `.atlas.txt`(`.atlas` 会被当成未知类型),
 * 转过版本的骨架又常带个 `_4.1` 后缀,而图集没有(实测 `BBQ_grill_4.1.skel.bytes`
 * 配的是 `BBQ_grill.atlas.txt`)。
 *
 * 所以按「同名 → 去掉版本后缀 → 目录里唯一的那个」依次退让。
 * 目录里有多个图集时**不猜**,让用户用 `--atlas` 指定。
 */
function findAtlas(skeleton: string): { path: string; guessed: boolean } | null {
  const dir = dirname(skeleton)
  const stem = stemOf(skeleton)

  const tryStem = (name: string) => {
    for (const suffix of ATLAS_SUFFIXES) {
      const candidate = join(dir, name + suffix)
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  const exact = tryStem(stem)
  if (exact !== null) return { path: exact, guessed: false }

  // 去掉 `_4.1` / `-3.8` 这类版本后缀再试
  const stripped = stem.replace(/[_-]v?\d+\.\d+(\.\d+)?$/, '')
  if (stripped !== stem) {
    const found = tryStem(stripped)
    if (found !== null) return { path: found, guessed: true }
  }

  const all = readdirSync(dir).filter((f) => ATLAS_SUFFIXES.some((s) => f.toLowerCase().endsWith(s)))
  if (all.length === 1) return { path: join(dir, all[0]!), guessed: true }

  return null
}

function describe(issue: ConversionIssue): string {
  const mark = issue.level === 'loss' ? '✗' : issue.level === 'approximated' ? '≈' : 'ℹ'
  return `    ${mark} ${issue.path}:${issue.message}`
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2))
  if (typeof parsed === 'string') {
    console.error(`✗ ${parsed}\n\n用法:pnpm unity <骨架文件或目录> [--out 目录] [--ppu 100] [--atlas 图集] [--dry-run]`)
    process.exitCode = 1
    return
  }

  const files = collect(parsed.input)
  if (files.length === 0) {
    console.error('✗ 没有找到 .skel / .skel.bytes / .json')
    process.exitCode = 1
    return
  }

  console.log(`Spine → Unity 2D Animation,共 ${files.length} 个骨架`)
  console.log(`输出:${parsed.out}${parsed.dryRun ? '(试运行,不写文件)' : ''}\n`)

  let failed = 0
  const counts: Record<string, number> = {}

  for (const file of files) {
    const stem = stemOf(file)
    console.log(`  ${basename(file)}`)

    try {
      const part = readSkeleton(file)
      if (part.failure !== null) {
        throw new Error(`动画 "${part.failure.name}" 解析失败:${part.failure.message}`)
      }

      const found = parsed.atlas === null ? findAtlas(file) : { path: parsed.atlas, guessed: false }
      if (found === null) {
        throw new Error(
          `找不到图集(试过 ${stem}.atlas / .atlas.txt,以及去掉版本后缀)—— 用 --atlas 指定`,
        )
      }
      if (found.guessed) console.log(`    ℹ 图集不同名,用了 ${basename(found.path)}`)

      const atlasPath = found.path
      const atlas = parseAtlas(readFileSync(atlasPath, 'utf8'))
      const sources = new Map<string, Image>()
      for (const page of atlas.pages) {
        const pagePath = join(dirname(atlasPath), page.name)
        if (!existsSync(pagePath)) throw new Error(`图集页缺失:${page.name}`)
        sources.set(page.name, decodePng(new Uint8Array(readFileSync(pagePath))))
      }

      const result = exportToUnity(part, atlas, sources, { name: stem, pixelsPerUnit: parsed.pixelsPerUnit })

      const dir = join(parsed.out, stem)
      if (!parsed.dryRun) {
        mkdirSync(dir, { recursive: true })
        for (const out of result.files) {
          writeFileSync(join(dir, out.path), typeof out.content === 'string' ? out.content : Buffer.from(out.content))
        }
      }

      for (const issue of result.issues) counts[issue.level] = (counts[issue.level] ?? 0) + 1
      const anims = result.files.filter((f) => f.path.endsWith('.anim')).length
      console.log(`    → ${result.files.length} 个文件,${anims} 条动画`)
      for (const issue of result.issues) console.log(describe(issue))
    } catch (error) {
      failed++
      console.log(`    ✗ ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const summary = Object.entries(counts)
    .map(([kind, n]) => `${kind} ${n}`)
    .join(',')
  console.log(`\n完成:${files.length - failed}/${files.length}${summary ? `,问题 ${summary}` : ''}`)
  if (failed > 0) process.exitCode = 1
}

main()
