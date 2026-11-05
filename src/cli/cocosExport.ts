import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectSkeletons, findAtlas, loadAtlas, readSkeleton, stemOf } from './skeletonInputs.ts'
import { describeClashes, planOutputNames, skeletonContentKey } from './outputNames.ts'
import { exportToCocos } from '../spine-convert/cocos/export.ts'
import { cocosUuid, RUNTIME_DIR_UUID, RUNTIME_SCRIPTS } from '../cocos/ids.ts'
import { directoryMeta } from '../cocos/meta.ts'
import type { ConversionIssue } from '../spine-convert/types.ts'

/**
 * Spine → Cocos Creator 3.8 的命令行入口。
 *
 * ```
 * pnpm cocos <骨架文件或目录> [--out 目录] [--atlas 图集] [--skin 初始皮肤] [--dry-run]
 * ```
 *
 * 每个骨架一个目录(带 `.meta`):`<名字>.prefab`、每条动画一个 `.anim`、`images/` 里每个图集区域一张 PNG + 自动图集。
 * 有网格 / 遮罩的骨架要脚本组件,运行时脚本(tools/cocos/runtime/)拷到输出目录下 `AnimatorGoRuntime/` **一次**。
 * 整个目录拷进 Cocos 工程的 `assets/` 就能用(或者 `--out` 直接指到 `assets/` 下面)。**不会覆盖输入** ——
 * 默认写到 `<输入目录>_cocos`。不同目录下的同名骨架怎么起名见 `outputNames.ts`。
 */

interface Options {
  readonly input: string
  readonly out: string
  readonly dryRun: boolean
  readonly atlas: string | null
  /** 初始皮肤;null = 默认皮肤。所有皮肤都会导出 */
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
    out: resolve(flags.get('out') ?? `${base}_cocos`),
    dryRun: flags.has('dry-run'),
    atlas: atlas === null ? null : resolve(atlas),
    skin: flags.get('skin') ?? null,
  }
}

const MARKS: Record<string, string> = { loss: '✗', approximated: '≈', info: 'ℹ' }
const describe = (issue: ConversionIssue) => `    ${MARKS[issue.level] ?? '·'} ${issue.path}:${issue.message}`

/** 输出目录在不在某个 Cocos 工程的 assets/ 下面 */
function insideAssets(out: string): boolean {
  let dir = out
  for (let up = 0; up < 12; up++) {
    if (basename(dir) === 'assets' && existsSync(join(dirname(dir), 'package.json'))) return true
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return false
}

/**
 * 运行时脚本随产物拷进工程一次(输出目录下 AnimatorGoRuntime/,不放每个骨架目录 —— 同一个类出现两次编译不过)。
 * `.meta` 带固定 uuid(ids.ts 的 RUNTIME_SCRIPTS),prefab 里的组件靠它认类。内容没变就不碰
 */
function installRuntime(outDir: string): string {
  const src = fileURLToPath(new URL('../../tools/cocos/runtime/', import.meta.url))
  const dir = join(outDir, 'AnimatorGoRuntime')
  mkdirSync(dir, { recursive: true })
  writeIfChanged(`${dir}.meta`, directoryMeta(RUNTIME_DIR_UUID))
  for (const name of Object.keys(RUNTIME_SCRIPTS)) {
    for (const file of [`${name}.ts`, `${name}.ts.meta`]) writeIfChanged(join(dir, file), readFileSync(join(src, file)))
  }
  return dir
}

function writeIfChanged(target: string, content: string | Uint8Array): void {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
  // 内容没变就不碰 —— Cocos 编辑器开着时每次重写都会触发重新导入
  if (existsSync(target) && readFileSync(target).equals(bytes)) return
  writeFileSync(target, bytes)
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2))
  if (typeof parsed === 'string') {
    console.error(`✗ ${parsed}\n\n用法:pnpm cocos <骨架文件或目录> [--out 目录] [--atlas 图集] [--skin 初始皮肤] [--dry-run]`)
    process.exitCode = 1
    return
  }
  const files = collectSkeletons(parsed.input)
  if (files.length === 0) {
    console.error('✗ 没有找到 .skel / .skel.bytes / .json')
    process.exitCode = 1
    return
  }
  const root = statSync(parsed.input).isDirectory() ? parsed.input : dirname(parsed.input)
  const rel = (file: string) => relative(root, file).split(sep).join('/')
  const plan = planOutputNames(files, root, (file) => skeletonContentKey(file, parsed.atlas))
  console.log(`Spine → Cocos Creator 3.8,共 ${files.length} 个骨架`)
  console.log(`输出:${parsed.out}${parsed.dryRun ? '(试运行,不写文件)' : ''}`)
  if (!insideAssets(parsed.out)) console.log('ℹ 输出目录不在 Cocos 工程的 assets/ 下 —— 整个目录拷进 assets/ 即可(.meta 一起拷,uuid 才不会变)')
  for (const line of describeClashes(plan, root, parsed.out)) console.log(line)
  console.log()

  let failed = 0
  let shared = 0
  let runtimeInstalled = false
  const failedFiles = new Set<string>()
  const counts: Record<string, number> = {}
  for (const { file, name, sameAs, clashes } of plan) {
    const stem = stemOf(file)
    console.log(`  ${clashes.length > 0 ? rel(file) : basename(file)}`)
    if (sameAs !== null) {
      if (failedFiles.has(sameAs)) {
        failed++
        console.log(`    ✗ 与 ${rel(sameAs)} 逐字节相同,它没转过去`)
      } else {
        shared++
        counts['info'] = (counts['info'] ?? 0) + 1
        console.log(`    ℹ 与 ${rel(sameAs)} 逐字节相同(骨架、图集、图集页),共用 ${name}/,不再导一遍`)
      }
      continue
    }
    if (name !== stem) {
      counts['info'] = (counts['info'] ?? 0) + 1
      console.log(`    ℹ 别的目录下有同名骨架、内容不同,产物改名为 ${name}`)
    }
    try {
      const part = readSkeleton(file)
      if (part.failure !== null) throw new Error(`动画 "${part.failure.name}" 解析失败:${part.failure.message}`)
      const found = parsed.atlas === null ? findAtlas(file) : { path: parsed.atlas, guessed: false }
      if (found === null) throw new Error(`找不到图集(试过 ${stem}.atlas / .atlas.txt,以及去掉版本后缀)—— 用 --atlas 指定`)
      if (found.guessed) console.log(`    ℹ 图集不同名,用了 ${basename(found.path)}`)
      const { atlas, sources } = loadAtlas(found.path)

      const dir = join(parsed.out, name)
      const result = exportToCocos(part, atlas, sources, { name, skipImages: parsed.dryRun, ...(parsed.skin === null ? {} : { skin: parsed.skin }) })
      if (!parsed.dryRun) {
        mkdirSync(join(dir, 'images'), { recursive: true })
        writeIfChanged(`${dir}.meta`, directoryMeta(cocosUuid(`${name}/dir`)))
        for (const out of result.files) writeIfChanged(join(dir, out.path), out.content)
        if (result.runtime && !runtimeInstalled) {
          runtimeInstalled = true
          console.log(`    ℹ 运行时脚本已拷到 ${relative(parsed.out, installRuntime(parsed.out)) || '.'}/(AnimatorGoMesh / AnimatorGoClip),整个目录一起拷进工程`)
        }
      }
      for (const issue of result.issues) counts[issue.level] = (counts[issue.level] ?? 0) + 1
      console.log(`    → ${result.files.length} 个文件,${part.animations.length} 条动画,${result.images.size} 张图`)
      for (const issue of result.issues) console.log(describe(issue))
    } catch (error) {
      failed++
      failedFiles.add(file)
      console.log(`    ✗ ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const summary = Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(',')
  const sharedNote = shared > 0 ? `(其中 ${shared} 个与同名骨架逐字节相同,共用产物)` : ''
  console.log(`\n完成:${files.length - failed}/${files.length}${sharedNote}${summary ? `,问题 ${summary}` : ''}`)
  if (failed > 0) process.exitCode = 1
}

main()
