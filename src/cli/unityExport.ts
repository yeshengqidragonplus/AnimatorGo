import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { readSkeletonPart, type SkeletonPart } from '../spine-format/binary/readSkeleton.ts'
import { fromJsonText } from '../spine-format/json/fromJson.ts'
import { parseAtlas } from '../core/atlas.ts'
import { decodePng, type Image } from '../unity/png.ts'
import { exportToUnity } from '../spine-convert/unity/export.ts'
import type { RenderPipeline } from '../unity/writePrefab.ts'
import type { ConversionIssue } from '../spine-convert/types.ts'

/**
 * Spine → Unity 2D Animation 的命令行入口。
 *
 * ```
 * pnpm unity <骨架文件或目录> [--out 目录] [--ppu 100] [--atlas 图集] [--rp urp|builtin] [--dry-run]
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
  /** null 表示从输出目录所在的 Unity 工程自动认 */
  readonly renderPipeline: RenderPipeline | null
  /** SkinnedMeshRenderer 的蒙皮根数:bone4 写死 4 根(默认),auto 跟随工程 Quality */
  readonly skinQuality: 'bone4' | 'auto'
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

  const rp = flags.get('rp') ?? null
  if (rp !== null && rp !== 'urp' && rp !== 'builtin') return `--rp 只能是 urp 或 builtin,收到 "${rp}"`

  const skinQuality = flags.get('skin-quality') ?? 'bone4'
  if (skinQuality !== 'bone4' && skinQuality !== 'auto') return `--skin-quality 只能是 bone4 或 auto,收到 "${skinQuality}"`

  const resolved = resolve(input)
  const base = statSync(resolved).isDirectory() ? resolved : dirname(resolved)

  return {
    input: resolved,
    out: resolve(flags.get('out') ?? `${base}_unity`),
    pixelsPerUnit: ppu,
    dryRun: flags.has('dry-run'),
    atlas: atlas === null ? null : resolve(atlas),
    renderPipeline: rp as RenderPipeline | null,
    skinQuality,
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

/**
 * 是不是骨架文件。
 *
 * ⚠️ **`.json` 不能只看后缀。** 工程里满是 `areas.json`、`locale_loading_de.json`
 * 这类游戏配置和本地化文件 —— 实测 MergeCooking2 下 751 个候选里 200 多个是这种,
 * 全当成骨架去转,报出来的「失败」把真正的失败埋掉了。
 *
 * Spine JSON 顶层一定有 `"skeleton": { "spine": "4.1.23", ... }`,认这个就够。
 */
function isSkeleton(file: string): boolean {
  const lower = file.toLowerCase()
  if (SKEL_SUFFIXES.some((s) => lower.endsWith(s))) return true
  if (!lower.endsWith(JSON_SUFFIX)) return false

  try {
    // 只读开头一段 —— Spine 把 skeleton 写在最前面,不必为几 MB 的配置全文解析
    const head = readFileSync(file, 'utf8').slice(0, 4096)
    return /"skeleton"\s*:\s*\{/.test(head) && /"spine"\s*:\s*"/.test(head)
  } catch {
    return false
  }
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

/**
 * 从输出目录往上找 Unity 工程,看它用的是哪套渲染管线。
 *
 * ⚠️ **两套管线的默认 sprite 材质不是同一个**,给错了整个角色是粉红的。
 * 输出目录通常就在 `Assets/` 下面,所以往上走能找到 `Packages/manifest.json`。
 * 找不到就按内置管线 —— 那是 Unity 的默认。
 */
function detectRenderPipeline(outDir: string): { pipeline: RenderPipeline; from: string | null } {
  let dir = resolve(outDir)
  for (let up = 0; up < 12; up++) {
    const manifest = join(dir, 'Packages', 'manifest.json')
    if (existsSync(manifest)) {
      const text = readFileSync(manifest, 'utf8')
      const urp = text.includes('com.unity.render-pipelines.universal')
      return { pipeline: urp ? 'urp' : 'builtin', from: manifest }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { pipeline: 'builtin', from: null }
}

/**
 * 工程 Quality 各档位的 `skinWeights`(1/2/4 根,255 = Unlimited)。
 *
 * SkinnedMeshRenderer 按 Auto 走时跟随这个设置 —— 实测 UnityAnimationGo 的 Low/Medium/High
 * 档是 2 根,MergeCooking2 是 2/4/2。所以默认把渲染器写死 Bone4,这里只是把事实报出来,
 * 让人知道 `--skin-quality auto` 在这个工程里会发生什么。
 */
function detectSkinWeights(outDir: string): { levels: { name: string; skinWeights: number }[]; from: string } | null {
  let dir = resolve(outDir)
  for (let up = 0; up < 12; up++) {
    const file = join(dir, 'ProjectSettings', 'QualitySettings.asset')
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8')
      const levels: { name: string; skinWeights: number }[] = []
      let current: string | null = null
      for (const line of text.split('\n')) {
        const name = /^\s{4}name: (.*)$/.exec(line)
        if (name !== null) current = name[1]!.trim()
        const sw = /^\s{4}skinWeights: (\d+)/.exec(line)
        if (sw !== null && current !== null) levels.push({ name: current, skinWeights: Number(sw[1]) })
      }
      return { levels, from: file }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const MARKS: Record<string, string> = { loss: '✗', approximated: '≈', info: 'ℹ' }

function describe(issue: ConversionIssue): string {
  return `    ${MARKS[issue.level] ?? '·'} ${issue.path}:${issue.message}`
}

/**
 * 把消息里的具体数字抹成 N,好让「同一类问题」归到一起。
 *
 * 批量跑几百个骨架时,逐条列问题没法看 —— 要的是「哪类问题涉及多少个骨架」,
 * 那才能排优先级。
 */
const normalize = (message: string) => message.replace(/-?\d+(\.\d+)?/g, 'N')

interface Tally {
  readonly level: string
  readonly sample: string
  count: number
  readonly files: Set<string>
}

/** 按问题类别归并后的排行榜,涉及骨架最多的排前面 */
function summarize(tallies: ReadonlyMap<string, Tally>, title: string): string[] {
  if (tallies.size === 0) return []
  const rows = [...tallies.values()].sort((a, b) => b.files.size - a.files.size || b.count - a.count)
  return [
    '',
    `── ${title} ──`,
    ...rows.map((r) => `  ${MARKS[r.level] ?? '·'} ${r.files.size} 个骨架 / ${r.count} 处  ${r.sample}`),
  ]
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2))
  if (typeof parsed === 'string') {
    console.error(`✗ ${parsed}\n\n用法:pnpm unity <骨架文件或目录> [--out 目录] [--ppu 100] [--atlas 图集] [--rp urp|builtin] [--dry-run]`)
    process.exitCode = 1
    return
  }

  const files = collect(parsed.input)
  if (files.length === 0) {
    console.error('✗ 没有找到 .skel / .skel.bytes / .json')
    process.exitCode = 1
    return
  }

  const detected = detectRenderPipeline(parsed.out)
  const pipeline = parsed.renderPipeline ?? detected.pipeline

  console.log(`Spine → Unity 2D Animation,共 ${files.length} 个骨架`)
  console.log(`输出:${parsed.out}${parsed.dryRun ? '(试运行,不写文件)' : ''}`)
  if (parsed.renderPipeline !== null) console.log(`渲染管线:${pipeline}(命令行指定)`)
  else if (detected.from !== null) console.log(`渲染管线:${pipeline}(认自 ${detected.from})`)
  else console.log(`渲染管线:${pipeline}(输出目录不在 Unity 工程里,按默认;不对就加 --rp)`)

  // SkinnedMeshRenderer 的蒙皮根数:写死 Bone4 时不受 Quality 影响,但把工程的实际档位报出来,
  // 免得有人开 --skin-quality auto 之后在 Low 档看到只剩 2 根骨骼
  const quality = detectSkinWeights(parsed.out)
  if (quality !== null && quality.levels.length > 0) {
    const levels = quality.levels.map((l) => `${l.name}=${l.skinWeights === 255 ? 'Unlimited' : `${l.skinWeights}根`}`).join(' ')
    const allUnlimited = quality.levels.every((l) => l.skinWeights === 255)
    if (parsed.skinQuality === 'bone4') {
      console.log(`蒙皮根数:SkinnedMeshRenderer 写死 4 根(工程 Quality 各档 ${levels}${allUnlimited ? ';全是 Unlimited,可用 --skin-quality auto 吃满 >4 根' : ''})`)
    } else if (allUnlimited) {
      console.log(`蒙皮根数:跟随工程 Quality(各档 ${levels}),>4 根全部生效`)
    } else {
      console.log(`⚠️ 蒙皮根数:跟随工程 Quality,但有档位不是 Unlimited(${levels})—— 那些档位下 SkinnedMeshRenderer 会被截到相应根数,比 SpriteSkin 还少`)
    }
  } else if (parsed.skinQuality === 'auto') {
    console.log('⚠️ 蒙皮根数:--skin-quality auto,但找不到工程的 QualitySettings.asset,无法判断各档位会截到几根')
  }
  console.log()

  let failed = 0
  const counts: Record<string, number> = {}
  const issueTally = new Map<string, Tally>()
  const failTally = new Map<string, Tally>()
  const versions = new Map<string, number>()

  const tally = (map: Map<string, Tally>, level: string, message: string, file: string) => {
    const key = `${level} ${normalize(message)}`
    let row = map.get(key)
    if (row === undefined) {
      row = { level, sample: message, count: 0, files: new Set() }
      map.set(key, row)
    }
    row.count++
    row.files.add(file)
  }

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

      const result = exportToUnity(part, atlas, sources, {
        name: stem,
        pixelsPerUnit: parsed.pixelsPerUnit,
        renderPipeline: pipeline,
        skinQuality: parsed.skinQuality,
        // 试运行不写文件,那就别费时间编码 PNG
        skipImages: parsed.dryRun,
      })

      const dir = join(parsed.out, stem)
      if (!parsed.dryRun) {
        mkdirSync(dir, { recursive: true })
        for (const out of result.files) {
          writeFileSync(join(dir, out.path), typeof out.content === 'string' ? out.content : Buffer.from(out.content))
        }
      }

      for (const issue of result.issues) {
        counts[issue.level] = (counts[issue.level] ?? 0) + 1
        tally(issueTally, issue.level, issue.message, file)
      }
      versions.set(part.header.version, (versions.get(part.header.version) ?? 0) + 1)
      const anims = result.files.filter((f) => f.path.endsWith('.anim')).length
      console.log(`    → ${result.files.length} 个文件,${anims} 条动画`)
      for (const issue of result.issues) console.log(describe(issue))
    } catch (error) {
      failed++
      const message = error instanceof Error ? error.message : String(error)
      console.log(`    ✗ ${message}`)
      tally(failTally, 'loss', message, file)
    }
  }

  // 批量跑的时候,末尾的排行榜才是有用的东西 —— 几百个骨架的逐行输出没法看
  if (files.length > 1) {
    for (const line of summarize(failTally, '转换失败,按涉及骨架数排')) console.log(line)
    for (const line of summarize(issueTally, '有损与近似,按涉及骨架数排')) console.log(line)
    if (versions.size > 0) {
      const list = [...versions.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} × ${n}`)
      console.log(`
── Spine 版本 ──
  ${list.join('   ')}`)
    }
  }

  const summary = Object.entries(counts)
    .map(([kind, n]) => `${kind} ${n}`)
    .join(',')
  console.log(`\n完成:${files.length - failed}/${files.length}${summary ? `,问题 ${summary}` : ''}`)
  if (failed > 0) process.exitCode = 1
}

main()
