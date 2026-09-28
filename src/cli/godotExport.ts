import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { collectSkeletons, findAtlas, loadAtlas, readSkeleton, stemOf } from './skeletonInputs.ts'
import { exportToGodot } from '../spine-convert/godot/export.ts'
import type { ConversionIssue } from '../spine-convert/types.ts'

/**
 * Spine → Godot 4 的命令行入口。
 *
 * ```
 * pnpm godot <骨架文件或目录> [--out 目录] [--atlas 图集] [--skin 初始皮肤] [--dry-run]
 * ```
 *
 * 每个骨架一个目录:`<名字>.tscn` + 图集页 PNG。输出目录在某个 Godot 工程里时(往上能找到
 * `project.godot`),贴图按 `res://` 路径引用,拖进去就能用。**不会覆盖输入** —— 默认写到 `<输入目录>_godot`。
 */

interface Options {
  readonly input: string
  readonly out: string
  readonly dryRun: boolean
  readonly atlas: string | null
  /** 初始皮肤(SkinPlayer 自动播放的那条);null = 默认皮肤。所有皮肤都会导出 */
  readonly skin: string | null
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
  const atlas = flags.get('atlas') ?? null
  if (atlas !== null && !existsSync(atlas)) return `图集不存在:${atlas}`
  const resolved = resolve(input)
  const base = statSync(resolved).isDirectory() ? resolved : dirname(resolved)
  return {
    input: resolved,
    out: resolve(flags.get('out') ?? `${base}_godot`),
    dryRun: flags.has('dry-run'),
    atlas: atlas === null ? null : resolve(atlas),
    skin: flags.get('skin') ?? null,
  }
}

/** 输出目录所在的 Godot 工程根(有 project.godot 的那层);不在工程里返回 null */
function findGodotProject(outDir: string): string | null {
  let dir = resolve(outDir)
  for (let up = 0; up < 16; up++) {
    if (existsSync(join(dir, 'project.godot'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const MARKS: Record<string, string> = { loss: '✗', approximated: '≈', info: 'ℹ' }
const describe = (issue: ConversionIssue) => `    ${MARKS[issue.level] ?? '·'} ${issue.path}:${issue.message}`

function main(): void {
  const parsed = parseArgs(process.argv.slice(2))
  if (typeof parsed === 'string') {
    console.error(`✗ ${parsed}\n\n用法:pnpm godot <骨架文件或目录> [--out 目录] [--atlas 图集] [--skin 初始皮肤] [--dry-run]`)
    process.exitCode = 1
    return
  }
  const files = collectSkeletons(parsed.input)
  if (files.length === 0) {
    console.error('✗ 没有找到 .skel / .skel.bytes / .json')
    process.exitCode = 1
    return
  }
  const project = findGodotProject(parsed.out)
  console.log(`Spine → Godot 4,共 ${files.length} 个骨架`)
  console.log(`输出:${parsed.out}${parsed.dryRun ? '(试运行,不写文件)' : ''}`)
  console.log(project === null
    ? '⚠️ 输出目录不在 Godot 工程里,贴图按相对路径引用 —— 整个目录拷进工程后在 Godot 里打开场景即可'
    : `Godot 工程:${project}`)
  console.log()

  let failed = 0
  const counts: Record<string, number> = {}
  for (const file of files) {
    const stem = stemOf(file)
    console.log(`  ${basename(file)}`)
    try {
      const part = readSkeleton(file)
      if (part.failure !== null) throw new Error(`动画 "${part.failure.name}" 解析失败:${part.failure.message}`)
      const found = parsed.atlas === null ? findAtlas(file) : { path: parsed.atlas, guessed: false }
      if (found === null) throw new Error(`找不到图集(试过 ${stem}.atlas / .atlas.txt,以及去掉版本后缀)—— 用 --atlas 指定`)
      if (found.guessed) console.log(`    ℹ 图集不同名,用了 ${basename(found.path)}`)
      const { atlas, sources } = loadAtlas(found.path)

      const dir = join(parsed.out, stem)
      const resDir = project === null ? '' : `res://${relative(project, dir).split(sep).join('/')}`
      const result = exportToGodot(part, atlas, sources, { name: stem, resDir, skipImages: parsed.dryRun, ...(parsed.skin === null ? {} : { skin: parsed.skin }) })
      if (!parsed.dryRun) {
        mkdirSync(dir, { recursive: true })
        for (const out of result.files) {
          const target = join(dir, out.path)
          const content = typeof out.content === 'string' ? Buffer.from(out.content, 'utf8') : Buffer.from(out.content)
          // 内容没变就不碰 —— Godot 编辑器开着时每次重写都会触发重新导入
          if (existsSync(target) && readFileSync(target).equals(content)) continue
          writeFileSync(target, content)
        }
      }
      for (const issue of result.issues) counts[issue.level] = (counts[issue.level] ?? 0) + 1
      console.log(`    → ${result.files.length} 个文件,${part.animations.length} 条动画`)
      for (const issue of result.issues) console.log(describe(issue))
    } catch (error) {
      failed++
      console.log(`    ✗ ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const summary = Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(',')
  console.log(`\n完成:${files.length - failed}/${files.length}${summary ? `,问题 ${summary}` : ''}`)
  if (failed > 0) process.exitCode = 1
}

main()
