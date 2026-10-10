import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectSkeletons, findAtlas, loadAtlas, readSkeleton, stemOf } from './skeletonInputs.ts'
import { describeClashes, planOutputNames, skeletonContentKey } from './outputNames.ts'
import { exportToUnity } from '../spine-convert/unity/export.ts'
import type { RenderPipeline } from '../unity/writePrefab.ts'
import type { ConversionIssue } from '../spine-convert/types.ts'
import { parseQualitySkinWeights, skinWeightsLabel, type QualityLevel } from '../unity/qualitySettings.ts'
import type { ColorSpace } from '../unity/colorSpace.ts'
import { detectColorSpace } from './unityDir.ts'

/**
 * Spine → Unity 2D Animation 的命令行入口。
 *
 * ```
 * pnpm unity <骨架文件或目录> [--out 目录] [--ppu 100] [--atlas 图集] [--rp urp|builtin] [--color-space linear|gamma] [--dry-run]
 * ```
 *
 * 每个骨架产出一套可以**直接拖进 Assets 就能播**的资源:
 * 烘焙后的图集 PNG + `.meta`、prefab、每条动画一个 `.anim`、一个 AnimatorController。
 *
 * **不会覆盖输入** —— 默认写到 `<输入目录>_unity`。不同目录下的同名骨架怎么起名见 `outputNames.ts`。
 */

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
  /** 初始皮肤(皮肤层的默认 state);null = 默认皮肤。所有皮肤都会导出 */
  readonly skin: string | null
  /** 皮肤怎么切:animator 零脚本(默认),script 挂 AnimatorGoSkins 组件按需加载 */
  readonly skins: 'animator' | 'script'
  /** null 表示从输出目录所在的 Unity 工程自动认;不在工程里按 linear */
  readonly colorSpace: ColorSpace | null
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

  const skins = flags.get('skins') ?? 'animator'
  if (skins !== 'animator' && skins !== 'script') return `--skins 只能是 animator 或 script,收到 "${skins}"`
  const colorSpace = flags.get('color-space') ?? null
  if (colorSpace !== null && colorSpace !== 'linear' && colorSpace !== 'gamma') return `--color-space 只能是 linear 或 gamma,收到 "${colorSpace}"`

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
    skin: flags.get('skin') ?? null,
    skins,
    colorSpace: colorSpace as ColorSpace | null,
  }
}

/** 输出目录所在的 Unity 工程根(有 Packages/manifest.json 的那层);不在工程里返回 null */
function findUnityProject(outDir: string): string | null {
  let dir = resolve(outDir)
  for (let up = 0; up < 12; up++) {
    if (existsSync(join(dir, 'Packages', 'manifest.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * 共用的运行时文件(带脚本模式的 AnimatorGoSkins.cs、混合模式和被遮罩遮住的 SkinnedMeshRenderer 用的着色器),随产物拷进工程
 * **一次**(放在输出目录下 AnimatorGoRuntime/,不放每个骨架目录 —— 同一个类出现两次就编译不过,同一个 GUID 出现两次
 * Unity 会改掉一个)。`.meta` 带固定 GUID,prefab / 材质靠它认。内容没变就不碰
 */
function installRuntime(outDir: string, names: readonly string[]): string {
  const src = fileURLToPath(new URL('../../tools/unity/runtime/', import.meta.url))
  const dir = join(outDir, 'AnimatorGoRuntime')
  mkdirSync(dir, { recursive: true })
  for (const file of names.flatMap((n) => [n, `${n}.meta`])) {
    const target = join(dir, file)
    if (existsSync(target) && readFileSync(target).equals(readFileSync(join(src, file)))) continue
    copyFileSync(join(src, file), target)
  }
  return dir
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

/** 输出目录所在工程的 Quality 各档 Skin Weights;不在工程里返回 null */
function detectSkinWeights(outDir: string): { levels: QualityLevel[]; from: string } | null {
  let dir = resolve(outDir)
  for (let up = 0; up < 12; up++) {
    const file = join(dir, 'ProjectSettings', 'QualitySettings.asset')
    if (existsSync(file)) return { levels: parseQualitySkinWeights(readFileSync(file, 'utf8')), from: file }
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
    console.error(`✗ ${parsed}\n\n用法:pnpm unity <骨架文件或目录> [--out 目录] [--ppu 100] [--atlas 图集] [--rp urp|builtin] [--skin 初始皮肤] [--skins animator|script] [--skin-quality bone4|auto] [--dry-run]`)
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

  const detected = detectRenderPipeline(parsed.out)
  const pipeline = parsed.renderPipeline ?? detected.pipeline

  console.log(`Spine → Unity 2D Animation,共 ${files.length} 个骨架`)
  console.log(`输出:${parsed.out}${parsed.dryRun ? '(试运行,不写文件)' : ''}`)
  if (parsed.renderPipeline !== null) console.log(`渲染管线:${pipeline}(命令行指定)`)
  else if (detected.from !== null) console.log(`渲染管线:${pipeline}(认自 ${detected.from})`)
  else console.log(`渲染管线:${pipeline}(输出目录不在 Unity 工程里,按默认;不对就加 --rp)`)

  // 工程 Quality 的 Skin Weights 是 SkinnedMeshRenderer 蒙皮根数的上限(渲染器写 Bone4 也盖不过)。
  // 逐个骨架查有没有网格会被截,在导出结果里报;这里只交代读的是哪个工程
  const quality = detectSkinWeights(parsed.out)
  const qualityLevels = quality !== null && quality.levels.length > 0 ? quality.levels : null
  if (qualityLevels !== null) {
    const levels = qualityLevels.map((l) => `${l.name}=${skinWeightsLabel(l.skinWeights)}`).join(' ')
    console.log(`蒙皮根数:SkinnedMeshRenderer ${parsed.skinQuality === 'bone4' ? '写 4 根' : '跟随工程'},以工程 Quality 各档的 Skin Weights 为上限(${levels})`)
  } else {
    const why = quality === null ? '输出目录不在 Unity 工程里' : `${quality.from} 里读不出各档的 Skin Weights`
    console.log(`蒙皮根数:${why},没法检查 —— 有网格走 SkinnedMeshRenderer 时,工程 Quality 各档要设成 Four Bones(SpriteSkin 不受影响)`)
  }

  const detectedSpace = parsed.colorSpace === null ? detectColorSpace(parsed.out) : null
  const colorSpace: ColorSpace | null = parsed.colorSpace ?? detectedSpace?.space ?? null
  if (parsed.colorSpace !== null) console.log(`色彩空间:${colorSpace}(命令行指定)`)
  else if (detectedSpace !== null) console.log(`色彩空间:${colorSpace}(认自 ${detectedSpace.from})`)
  else console.log(`色彩空间:输出目录不在 Unity 工程里(或读不出),按 linear —— 只影响带颜色的 SkinnedMeshRenderer 网格,会报出来;Gamma 工程加 --color-space gamma`)
  for (const line of describeClashes(plan, root, parsed.out)) console.log(line)
  console.log()

  let failed = 0
  let shared = 0
  const failedFiles = new Set<string>()
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

  const projectRoot = findUnityProject(parsed.out)
  if (parsed.skins === 'script') {
    if (parsed.dryRun) console.log('皮肤:带脚本模式(试运行,不拷运行时脚本)')
    else console.log(`皮肤:带脚本模式,运行时脚本已放到 ${installRuntime(parsed.out, ['AnimatorGoSkins.cs'])}(游戏启动时接 AnimatorGoSkins.LoadAsset)`)
  }
  const installed = new Set<string>()

  for (const { file, name: stem, sameAs, clashes } of plan) {
    const base = stemOf(file)
    console.log(`  ${clashes.length > 0 ? rel(file) : basename(file)}${parsed.skin === null ? '' : `(初始皮肤 ${parsed.skin})`}`)
    if (sameAs !== null) {
      if (failedFiles.has(sameAs)) {
        failed++
        console.log(`    ✗ 与 ${rel(sameAs)} 逐字节相同,它没转过去`)
        tally(failTally, 'loss', '与同名骨架逐字节相同,那个没转过去', file)
      } else {
        shared++
        const message = `与 ${rel(sameAs)} 逐字节相同(骨架、图集、图集页),共用 ${stem}/,不再导一遍`
        counts['info'] = (counts['info'] ?? 0) + 1
        tally(issueTally, 'info', '与同名骨架逐字节相同,共用产物', file)
        console.log(`    ℹ ${message}`)
      }
      continue
    }
    if (stem !== base) {
      counts['info'] = (counts['info'] ?? 0) + 1
      tally(issueTally, 'info', '别的目录下有同名骨架、内容不同,产物改名', file)
      console.log(`    ℹ 别的目录下有同名骨架、内容不同,产物改名为 ${stem}(Unity 的 GUID 也随名字换,不和它们撞)`)
    }
    // 软引用要写 Assets/ 下的路径;输出目录不在工程里就只写文件名
    const assetFolder = projectRoot === null ? '' : relative(projectRoot, join(parsed.out, stem)).split(sep).join('/')

    try {
      const part = readSkeleton(file)
      if (part.failure !== null) {
        throw new Error(`动画 "${part.failure.name}" 解析失败:${part.failure.message}`)
      }

      const found = parsed.atlas === null ? findAtlas(file) : { path: parsed.atlas, guessed: false }
      if (found === null) {
        throw new Error(
          `找不到图集(试过 ${base}.atlas / .atlas.txt,以及去掉版本后缀)—— 用 --atlas 指定`,
        )
      }
      if (found.guessed) console.log(`    ℹ 图集不同名,用了 ${basename(found.path)}`)

      const { atlas, sources } = loadAtlas(found.path)

      const result = exportToUnity(part, atlas, sources, {
        name: stem,
        pixelsPerUnit: parsed.pixelsPerUnit,
        renderPipeline: pipeline,
        skinQuality: parsed.skinQuality,
        ...(qualityLevels === null ? {} : { qualityLevels }),
        ...(colorSpace === null ? {} : { colorSpace }),
        skins: parsed.skins,
        assetFolder,
        ...(parsed.skin === null ? {} : { skin: parsed.skin }),
        // 试运行不写文件,那就别费时间编码 PNG
        skipImages: parsed.dryRun,
      })

      const dir = join(parsed.out, stem)
      if (!parsed.dryRun) {
        mkdirSync(dir, { recursive: true })
        let rewritten = 0
        for (const out of result.files) {
          const target = join(dir, out.path)
          const content = typeof out.content === 'string' ? Buffer.from(out.content, 'utf8') : Buffer.from(out.content)
          // 内容没变就不碰文件 —— 输出目录常常就在别人正开着的 Unity 工程里,
          // 每次重写都会触发一轮重新导入,Animator 窗口开着时还会在重载时报 NRE
          if (existsSync(target) && readFileSync(target).equals(content)) continue
          writeFileSync(target, content)
          rewritten++
        }
        if (rewritten < result.files.length) {
          console.log(`    → ${result.files.length} 个文件,${rewritten} 个有变化已写入,其余内容相同未动`)
        }
        const missing = result.runtime.filter((r) => !installed.has(r))
        if (missing.length > 0) {
          console.log(`    ℹ ${missing.join('、')} 已放到 ${installRuntime(parsed.out, missing)}`)
          for (const r of missing) installed.add(r)
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
      failedFiles.add(file)
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
  const sharedNote = shared > 0 ? `(其中 ${shared} 个与同名骨架逐字节相同,共用产物)` : ''
  console.log(`\n完成:${files.length - failed}/${files.length}${sharedNote}${summary ? `,问题 ${summary}` : ''}`)
  if (failed > 0) process.exitCode = 1
}

main()
