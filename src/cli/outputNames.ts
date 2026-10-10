import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { parseAtlas } from '../core/atlas.ts'
import { findAtlas, stemOf } from './skeletonInputs.ts'

/**
 * 批量导出(`pnpm unity` / `pnpm godot`)时每个骨架的产物名。
 *
 * 每个骨架写到 `<--out>/<名字>/`,名字取骨架文件名。**不同目录下的同名骨架会写进同一个目录、互相覆盖**,
 * 命令行还报全部成功 —— MergeCooking2 的 535 个骨架只剩 513 份产物。
 *
 * - **不撞名的照旧**,已经导进 Unity 的路径和 GUID 都不变。所以不改成「--out 下照搬源目录结构」——
 *   那会让每个产物都换路径、换 GUID
 * - **同名且逐字节相同**(骨架、图集、图集页都一样):只导一份,其余共用。MC2 里 4 组 11 个,是同一套资源拷到了各活动目录
 * - **同名但内容不同**:全部改名 `<名字>__<区分它们的那段目录>`,一个都不留原名(留哪个只是看排序)。
 *   MC2 的 `World/Map2/Spine/13000` 和 `World/Map3/Spine/13000` → `13000__Map2` / `13000__Map3`
 *
 * ⚠️ 不能只换目录、名字不变:Unity 的 GUID 由名字算(`unity/ids.ts`),两份同名产物进同一个工程 GUID 就撞上,
 * Unity 会悄悄改掉一个,prefab 引用的贴图串到另一份上。
 */
export interface OutputName {
  readonly file: string
  /** 产物名:输出目录名,也是导出器的 `name`(文件名、根节点名、Unity GUID 都由它来) */
  readonly name: string
  /** 同名且逐字节相同、由它导出的那个骨架;null = 自己导出 */
  readonly sameAs: string | null
  /** 文件名相同的其他骨架;没撞名是空的 */
  readonly clashes: readonly string[]
}

/**
 * @param files 骨架文件,按 `collectSkeletons` 的顺序(排过序)—— 决定每组谁来导出、改名撞上时谁加序号
 * @param root 输入目录,改名取的是相对它的那段路径
 * @param contentKey 内容相同的骨架返回同样的值;只对撞名的骨架调用
 */
export function planOutputNames(
  files: readonly string[],
  root: string,
  contentKey: (file: string) => string,
): OutputName[] {
  // Windows / macOS 的文件系统不分大小写,`Hero` 和 `hero` 也写进同一个目录
  const groups = new Map<string, string[]>()
  for (const file of files) {
    const key = stemOf(file).toLowerCase()
    groups.set(key, [...(groups.get(key) ?? []), file])
  }

  const planned = new Map<string, OutputName>()
  // 改名的放到最后再定:先让不改名的占住名字,改出来的名字万一又撞上(真有个骨架叫 `13000__Map2`)就加序号
  const renamed: { file: string; wanted: string; members: string[]; group: string[] }[] = []
  for (const group of groups.values()) {
    const repOf = new Map<string, string>()
    const reps = new Map<string, string>()
    for (const file of group) {
      const key = group.length === 1 ? '' : contentKey(file)
      if (!reps.has(key)) reps.set(key, file)
      repOf.set(file, reps.get(key)!)
    }
    const distinct = [...reps.values()]
    const names = distinct.length === 1 ? new Map([[distinct[0]!, stemOf(distinct[0]!)]]) : distinguish(distinct, root)
    for (const rep of distinct) {
      const members = group.filter((f) => repOf.get(f) === rep)
      if (distinct.length === 1) {
        for (const file of members) {
          planned.set(file, { file, name: names.get(rep)!, sameAs: file === rep ? null : rep, clashes: group.filter((f) => f !== file) })
        }
      } else {
        renamed.push({ file: rep, wanted: names.get(rep)!, members, group })
      }
    }
  }

  const taken = new Set([...planned.values()].map((p) => p.name.toLowerCase()))
  for (const { file: rep, wanted, members, group } of renamed) {
    let name = wanted
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${wanted}_${n}`
    taken.add(name.toLowerCase())
    for (const file of members) {
      planned.set(file, { file, name, sameAs: file === rep ? null : rep, clashes: group.filter((f) => f !== file) })
    }
  }
  return files.map((f) => planned.get(f)!)
}

/**
 * 内容不同的同名骨架,各取一段能区分它们的路径:去掉大家共有的开头和结尾,剩下中间那段。
 * 后缀也算一段 —— 同一目录下的 `hero.skel` 和 `hero.json` 靠它分开。
 */
function distinguish(files: readonly string[], root: string): Map<string, string> {
  const parts = files.map((f) => [
    ...relative(root, dirname(f)).split(/[\\/]/).filter((p) => p !== '' && p !== '.'),
    basename(f).slice(stemOf(f).length).replace(/^\./, '').replace(/\./g, '_'),
  ])
  const same = (at: (p: string[]) => string | undefined) => parts.every((p) => at(p)?.toLowerCase() === at(parts[0]!)?.toLowerCase())
  const shortest = Math.min(...parts.map((p) => p.length))
  let head = 0
  while (head < shortest && same((p) => p[head])) head++
  let tail = 0
  while (tail < shortest - head && same((p) => p[p.length - 1 - tail])) tail++
  return new Map(files.map((f, i) => {
    const middle = parts[i]!.slice(head, parts[i]!.length - tail)
    return [f, middle.length === 0 ? stemOf(f) : `${stemOf(f)}__${middle.join('_')}`]
  }))
}

/**
 * 判「同名骨架是不是同一份」用的内容摘要:骨架、图集、图集页逐字节。导出只看这三样(其余都是命令行参数,对所有骨架一样),
 * 三样都相同产物就相同。只骨架相同不够 —— 同一套骨骼配不同贴图(换肤)是常见做法。
 */
export function skeletonContentKey(file: string, atlasOverride: string | null): string {
  const hash = createHash('sha1')
  const add = (label: string, bytes: Uint8Array | string) => {
    hash.update(`${label}:${bytes.length}:`)
    hash.update(bytes)
  }
  try {
    add('skeleton', readFileSync(file))
    const atlas = atlasOverride ?? findAtlas(file)?.path ?? null
    if (atlas === null) return hash.digest('hex')
    const text = readFileSync(atlas)
    add('atlas', text)
    for (const page of parseAtlas(text.toString('utf8')).pages) {
      const path = join(dirname(atlas), page.name)
      add(`page ${page.name}`, existsSync(path) ? readFileSync(path) : 'missing')
    }
    return hash.digest('hex')
  } catch {
    // 读不了 / 解析不了的,导出时自会报错;这里当成和谁都不同
    return `unreadable ${file}`
  }
}

/**
 * 开头交代一次撞名的情况,每组一行。改名的组如果 `--out` 下还留着原名目录,那是之前互相覆盖剩下的,提醒可以删。
 */
export function describeClashes(plan: readonly OutputName[], root: string, out: string): string[] {
  const groups = new Map<string, OutputName[]>()
  for (const p of plan) {
    if (p.clashes.length === 0) continue
    const key = stemOf(p.file).toLowerCase()
    groups.set(key, [...(groups.get(key) ?? []), p])
  }
  if (groups.size === 0) return []
  const rel = (file: string) => relative(root, file).split('\\').join('/')
  const lines = [`⚠️ ${groups.size} 组同名骨架(不同目录下文件名相同 —— 以前会写进同一个目录互相覆盖):`]
  for (const members of groups.values()) {
    const stem = stemOf(members[0]!.file)
    const names = [...new Set(members.map((m) => m.name))]
    const dupes = members.filter((m) => m.sameAs !== null).length
    if (names.length === 1) {
      lines.push(`  ${stem} × ${members.length}:逐字节相同,只导一份 → ${names[0]}/`)
      continue
    }
    const shared = dupes > 0 ? `(其中 ${dupes} 个与别的逐字节相同,共用产物)` : ''
    lines.push(`  ${stem} × ${members.length}:内容不同,分别改名${shared}`)
    for (const m of members) if (m.sameAs === null) lines.push(`    ${rel(m.file)} → ${m.name}/`)
    if (!names.some((n) => n.toLowerCase() === stem.toLowerCase()) && existsSync(join(out, stem))) {
      lines.push(`    ℹ ${join(out, stem)} 不再更新(以前这几个都写在这里,互相覆盖过),确认没用了可以删掉`)
    }
  }
  return lines
}

/**
 * `pnpm convert` 的产物文件名。
 *
 * 它在 `--out` 下照搬源目录结构,不同目录不会撞;只有同一目录下 `--format` 改了后缀才会:`hero.skel` 和 `hero.json`
 * 转成 JSON 都叫 `hero.json`。格式没变的留原名(和不撞的时候一样),换了格式的一律改名 `hero__skel.json` ——
 * 不管格式没变的那个这次是不是因为「已经是目标版本」被跳过,名字只看文件,不看内容。
 *
 * @returns 每个文件的产物文件名(不含目录),和撞名时的说明(没撞是 null)
 */
export function planConvertNames(
  files: readonly string[],
  toJson: (file: string) => boolean,
): Map<string, { name: string; note: string | null }> {
  const isJson = (f: string) => f.toLowerCase().endsWith('.json')
  const wanted = new Map(files.map((f) => {
    const changed = toJson(f) !== isJson(f)
    return [f, { changed, name: changed ? stemOf(f) + (toJson(f) ? '.json' : '.skel.bytes') : basename(f) }]
  }))
  const groups = new Map<string, string[]>()
  for (const [f, w] of wanted) {
    const key = join(dirname(f), w.name).toLowerCase()
    groups.set(key, [...(groups.get(key) ?? []), f])
  }
  const out = new Map<string, { name: string; note: string | null }>()
  for (const group of groups.values()) {
    for (const f of group) {
      const w = wanted.get(f)!
      if (group.length === 1 || !w.changed) {
        out.set(f, { name: w.name, note: null })
        continue
      }
      const tag = basename(f).slice(stemOf(f).length).replace(/^\./, '').replace(/\./g, '_')
      const name = `${stemOf(f)}__${tag}${toJson(f) ? '.json' : '.skel.bytes'}`
      const others = group.filter((o) => o !== f).map((o) => basename(o)).join('、')
      out.set(f, { name, note: `与同目录的 ${others} 产物同名(${w.name}),改写成 ${name}` })
    }
  }
  return out
}
