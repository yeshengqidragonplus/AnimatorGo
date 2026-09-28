import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { readSkeletonPart, type SkeletonPart } from '../spine-format/binary/readSkeleton.ts'
import { fromJsonText } from '../spine-format/json/fromJson.ts'
import { parseAtlas, type Atlas } from '../core/atlas.ts'
import { decodePng, type Image } from '../unity/png.ts'

/**
 * 导出类命令行(`pnpm unity`、`pnpm godot`)共用的输入处理:找骨架、读骨架、找图集、读图集页。
 */

const SKEL_SUFFIXES = ['.skel', '.skel.bytes']
const JSON_SUFFIX = '.json'
const ATLAS_SUFFIXES = ['.atlas', '.atlas.txt']

/** 骨架文件名去掉后缀 —— `.skel.bytes` 要去两层 */
export function stemOf(file: string): string {
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
export function isSkeleton(file: string): boolean {
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

export function collectSkeletons(input: string): string[] {
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

export function readSkeleton(file: string): SkeletonPart {
  const bytes = readFileSync(file)
  if (file.toLowerCase().endsWith(JSON_SUFFIX)) return fromJsonText(bytes.toString('utf8'))
  return readSkeletonPart(new Uint8Array(bytes))
}

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
export function findAtlas(skeleton: string): { path: string; guessed: boolean } | null {
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

/** 读图集和它的每一页;缺页直接抛错 */
export function loadAtlas(atlasPath: string): { atlas: Atlas; sources: Map<string, Image> } {
  const atlas = parseAtlas(readFileSync(atlasPath, 'utf8'))
  const sources = new Map<string, Image>()
  for (const page of atlas.pages) {
    const pagePath = join(dirname(atlasPath), page.name)
    if (!existsSync(pagePath)) throw new Error(`图集页缺失:${page.name}`)
    sources.set(page.name, decodePng(new Uint8Array(readFileSync(pagePath))))
  }
  return { atlas, sources }
}
