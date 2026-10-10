import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { planConvertNames, planOutputNames, skeletonContentKey } from './outputNames.ts'

const root = join(tmpdir(), 'in')
const at = (...parts: string[]) => join(root, ...parts)

/** 内容摘要按表查;没列的当成各不相同 */
const keys = (table: Record<string, string>) => (file: string) => table[file] ?? file

describe('批量导出的产物名', () => {
  it('不撞名的照旧用文件名,也不去读内容', () => {
    const files = [at('a', 'hero.skel.bytes'), at('b', 'cat.json'), at('c', 'dog.skel')]
    const plan = planOutputNames(files, root, () => { throw new Error('不撞名不该读内容') })
    expect(plan.map((p) => p.name)).toEqual(['hero', 'cat', 'dog'])
    expect(plan.every((p) => p.sameAs === null && p.clashes.length === 0)).toBe(true)
  })

  it('同名且逐字节相同:只导第一个,其余共用它的产物(MC2 的 rukou_pet × 4)', () => {
    const files = ['CircusMerge', 'DreamMerge', 'MuseumMerge', 'PetMerge'].map((d) => at('Export', 'Activity', d, 'Spine', 'rukou_pet.skel.bytes'))
    const plan = planOutputNames(files, root, () => 'same')
    expect(plan.map((p) => p.name)).toEqual(['rukou_pet', 'rukou_pet', 'rukou_pet', 'rukou_pet'])
    expect(plan.map((p) => p.sameAs)).toEqual([null, files[0], files[0], files[0]])
    expect(plan[0]!.clashes).toHaveLength(3)
  })

  it('同名但内容不同:全部改名,取区分它们的那段目录(MC2 的 Map2 / Map3)', () => {
    const files = [at('World', 'Map2', 'Spine', '13000.skel.bytes'), at('World', 'Map3', 'Spine', '13000.skel.bytes')]
    const plan = planOutputNames(files, root, keys({}))
    expect(plan.map((p) => p.name)).toEqual(['13000__Map2', '13000__Map3'])
    expect(plan.map((p) => p.sameAs)).toEqual([null, null])
  })

  it('有相同有不同:相同的跟着它那份走', () => {
    const files = [at('A', 'x.skel'), at('B', 'x.skel'), at('C', 'x.skel')]
    const plan = planOutputNames(files, root, keys({ [files[0]!]: '1', [files[1]!]: '2', [files[2]!]: '1' }))
    expect(plan.map((p) => p.name)).toEqual(['x__A', 'x__B', 'x__A'])
    expect(plan.map((p) => p.sameAs)).toEqual([null, null, files[0]])
  })

  it('同一目录下只差后缀的,靠后缀分开', () => {
    const plan = planOutputNames([at('d', 'hero.json'), at('d', 'hero.skel.bytes')], root, keys({}))
    expect(plan.map((p) => p.name)).toEqual(['hero__json', 'hero__skel_bytes'])
  })

  it('深浅不一:浅的那个没有可区分的目录,留原名', () => {
    const plan = planOutputNames([at('A', 'x.skel'), at('A', 'B', 'x.skel')], root, keys({}))
    expect(plan.map((p) => p.name)).toEqual(['x', 'x__B'])
  })

  it('只差大小写也算撞名 —— Windows / macOS 上是同一个目录', () => {
    const plan = planOutputNames([at('a', 'Hero.skel'), at('b', 'hero.skel')], root, keys({}))
    expect(plan.map((p) => p.name)).toEqual(['Hero__a', 'hero__b'])
  })

  it('改出来的名字撞上真有的骨架,加序号;真有的那个不动', () => {
    const files = [at('Map2', 'x.skel'), at('Map3', 'x.skel'), at('z', 'x__Map2.skel')]
    const plan = planOutputNames(files, root, keys({}))
    expect(plan.map((p) => p.name)).toEqual(['x__Map2_2', 'x__Map3', 'x__Map2'])
  })
})

describe('同名骨架的内容摘要', () => {
  const ATLAS = 'page.png\nsize: 2,2\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\nr\n  rotate: false\n  xy: 0, 0\n  size: 1, 1\n  orig: 1, 1\n  offset: 0, 0\n  index: -1\n'
  let dir = ''
  afterEach(() => { if (dir !== '') rmSync(dir, { recursive: true, force: true }) })

  const put = (sub: string, page: string) => {
    mkdirSync(join(dir, sub))
    writeFileSync(join(dir, sub, 'x.skel.bytes'), 'skeleton')
    writeFileSync(join(dir, sub, 'x.atlas.txt'), ATLAS)
    writeFileSync(join(dir, sub, 'page.png'), page)
    return join(dir, sub, 'x.skel.bytes')
  }

  it('骨架、图集、图集页都一样才算同一份;骨架一样、贴图不一样(换肤)不算', () => {
    dir = mkdtempSync(join(tmpdir(), 'animatorgo-names-'))
    const a = put('a', 'pixels')
    const b = put('b', 'pixels')
    const c = put('c', 'other pixels')
    expect(skeletonContentKey(a, null)).toBe(skeletonContentKey(b, null))
    expect(skeletonContentKey(a, null)).not.toBe(skeletonContentKey(c, null))
  })
})

describe('pnpm convert 的产物文件名', () => {
  const toJson = () => true

  it('不撞名的照旧:格式没变留原名,换了格式换后缀', () => {
    const names = planConvertNames([at('a', 'hero.skel'), at('b', 'hero.json')], toJson)
    expect([...names.values()]).toEqual([{ name: 'hero.json', note: null }, { name: 'hero.json', note: null }])
  })

  it('同一目录下换完后缀撞名:格式没变的留原名,换了格式的改名并说明', () => {
    const files = [at('d', 'hero.json'), at('d', 'hero.skel')]
    const names = planConvertNames(files, toJson)
    expect(names.get(files[0]!)).toEqual({ name: 'hero.json', note: null })
    expect(names.get(files[1]!)!.name).toBe('hero__skel.json')
    expect(names.get(files[1]!)!.note).toContain('hero.json')
  })

  it('都换了格式的,都改名', () => {
    const files = [at('d', 'hero.skel'), at('d', 'hero.skel.bytes')]
    const names = planConvertNames(files, toJson)
    expect([...names.values()].map((n) => n.name)).toEqual(['hero__skel.json', 'hero__skel_bytes.json'])
  })

  it('转成二进制时同理', () => {
    const files = [at('d', 'hero.json'), at('d', 'hero.skel.bytes')]
    const names = planConvertNames(files, () => false)
    expect([...names.values()].map((n) => n.name)).toEqual(['hero__json.skel.bytes', 'hero.skel.bytes'])
  })
})
