import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { importUnity } from '../spine-convert/unity-import/readUnity.ts'
import { fromJson } from '../spine-format/json/fromJson.ts'
import { writeAtlas } from '../core/atlas.ts'
import { encodePng } from '../unity/png.ts'
import { exportToGodot } from '../spine-convert/godot/export.ts'
import type { ConversionIssue } from '../spine-convert/types.ts'
import { findGodotProject, godotResDir } from './godotProject.ts'
import { readUnityDir } from './unityDir.ts'

/**
 * Unity 产物 → Spine / Godot 的命令行入口。
 *
 * ```
 * pnpm from-unity <Unity 产物目录> --to godot|json [--out 目录] [--ppu 100] [--skin 初始皮肤]
 * ```
 *
 * 读一个 Unity 角色目录:正好一个 prefab(或一个 PSD Importer 导入的 `.psb` / `.psd`),加上 `.anim` + controller + 贴图 / Mesh / 材质及其 `.meta`。
 * 我们导出(`pnpm unity`)、又在 Unity 里改过的可以读;别人做的(骨骼上直接挂图、`m_IsActive` 显隐、
 * `m_Sprite` 逐帧换图)也可以读。`--ppu` 要与导出时一致;别人的角色就是想要的 Spine 像素 / Unity 单位。
 * `--skin` 不给就用 prefab 里亮着的那套皮肤。
 *
 * - `--to godot`:Godot 4 场景(`pnpm godot` 同一个写出器)
 * - `--to json`:Spine 4.1 JSON + `.atlas` + 贴图
 *
 * 链路是 Unity → Spine 4.1 JSON → 中转模型 → 目标;每步都有有损报告。**不会覆盖输入** —— 默认写到 `<输入目录>_<目标>`。
 */

interface Options {
  readonly input: string
  readonly to: 'godot' | 'json'
  readonly out: string
  readonly ppu: number
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
    const value = argv[++i]
    if (value === undefined) return `${arg} 缺少取值`
    flags.set(arg.slice(2), value)
  }
  const input = positional[0]
  if (input === undefined) return '缺少输入目录'
  if (!existsSync(input) || !statSync(input).isDirectory()) return `不是目录:${input}`
  const to = flags.get('to')
  if (to !== 'godot' && to !== 'json') return '--to 要是 godot 或 json'
  const ppu = Number(flags.get('ppu') ?? '100')
  if (!Number.isFinite(ppu) || ppu <= 0) return `--ppu 要是正数`
  const resolved = resolve(input)
  return { input: resolved, to, out: resolve(flags.get('out') ?? `${resolved}_${to}`), ppu, skin: flags.get('skin') ?? null }
}

const MARKS: Record<string, string> = { loss: '✗', approximated: '≈', info: 'ℹ' }
const describe = (issue: ConversionIssue) => `  ${MARKS[issue.level] ?? '·'} ${issue.path}:${issue.message}`

function main(): void {
  const parsed = parseArgs(process.argv.slice(2))
  if (typeof parsed === 'string') {
    console.error(`✗ ${parsed}\n\n用法:pnpm from-unity <Unity 产物目录> --to godot|json [--out 目录] [--ppu 100] [--skin 初始皮肤]`)
    process.exitCode = 1
    return
  }
  const files = readUnityDir(parsed.input)
  const imported = importUnity(files, { pixelsPerUnit: parsed.ppu })
  const name = imported.name
  // 自检:写出的 Spine JSON 要能被自己的读取器读通
  const part = fromJson(imported.json)
  console.log(`Unity → ${parsed.to === 'godot' ? 'Godot 4' : 'Spine 4.1 JSON'}:${basename(parsed.input)}`)
  console.log(`  骨骼 ${part.bones.length},slot ${part.slots.length},皮肤 ${part.skins.length},动画 ${part.animations.length}`)
  for (const issue of imported.issues) console.log(describe(issue))

  const dir = join(parsed.out, name)
  mkdirSync(dir, { recursive: true })
  if (parsed.to === 'json') {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(imported.json, null, 2))
    writeFileSync(join(dir, `${name}.atlas`), writeAtlas(imported.atlas))
    // 贴图从读取器拿:PSD Importer 的角色,大图是读取器按 .meta 重新拼的,目录里没有
    for (const page of imported.atlas.pages) {
      const image = imported.sources.get(page.name)
      if (image !== undefined) writeFileSync(join(dir, page.name), encodePng(image))
    }
  } else {
    const result = exportToGodot(part, imported.atlas, imported.sources, {
      name,
      resDir: godotResDir(findGodotProject(dir), dir),
      ...((parsed.skin ?? imported.initialSkin) === null ? {} : { skin: (parsed.skin ?? imported.initialSkin)! }),
    })
    for (const out of result.files) writeFileSync(join(dir, out.path), typeof out.content === 'string' ? out.content : Buffer.from(out.content))
    for (const issue of result.issues) console.log(describe(issue))
  }
  console.log(`→ ${dir}`)
}

main()
