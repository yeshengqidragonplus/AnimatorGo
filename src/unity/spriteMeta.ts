import { list, map, num, str, type YamlMap, type YamlValue } from './yaml.ts'

/**
 * 从贴图 `.meta` 的 TextureImporter 里找出一个 sprite 引用(`{fileID, guid}` 的 fileID)对应的那张 sprite。
 *
 * Unity 有三种写法,真实文件里都见过:
 *
 * | 写法 | 引用的 fileID | sprite 在哪 |
 * |---|---|---|
 * | Single(`spriteMode: 1`) | 固定 21300000 | 整张图;顶点 / 骨骼 / 权重在 `spriteSheet` 顶层 |
 * | Multiple,2019.3 之后 | sprite 的 `internalID` | `spriteSheet.sprites[]` |
 * | Multiple,更早 | 21300000、21300002…… | `fileIDToRecycleName` 把 fileID 映射到 sprite 名 |
 *
 * 轴心:`alignment` 不是 9(Custom)时按预设算,`pivot` 字段只在 Custom 时作数。
 * `.meta` 里没有顶点(Unity 导入时才生成紧凑网格)就用整个矩形 —— 紧凑网格只是裁掉透明像素,画出来一样。
 */

export interface SpriteRecord {
  readonly name: string
  /** 图里的矩形,像素,原点在左下(Unity 的约定) */
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  /** 轴心,相对矩形左下角的像素 */
  readonly pivot: { readonly x: number; readonly y: number }
  /** 顶点,相对矩形左下角的像素 */
  readonly vertices: readonly { readonly x: number; readonly y: number }[]
  readonly indices: readonly number[]
  readonly bones: readonly YamlMap[]
  readonly weights: readonly YamlMap[]
}

const SINGLE_SPRITE_FILE_ID = '21300000'
const ALIGNMENT_CUSTOM = 9
/** SpriteAlignment 的预设:Center、TopLeft、Top、TopRight、Left、Right、BottomLeft、Bottom、BottomRight */
const ALIGNMENTS: readonly (readonly [number, number])[] = [[0.5, 0.5], [0, 1], [0.5, 1], [1, 1], [0, 0.5], [1, 0.5], [0, 0], [0.5, 0], [1, 0]]

/** 小端 uint32 的十六进制串 → 三角形下标 */
export function decodeIndices(hex: string): number[] {
  const out: number[] = []
  for (let i = 0; i + 8 <= hex.length; i += 8) {
    const b = hex.slice(i, i + 8)
    out.push(parseInt(b.slice(6, 8) + b.slice(4, 6) + b.slice(2, 4) + b.slice(0, 2), 16))
  }
  return out
}

/**
 * @param importer `.meta` 里的 `TextureImporter`
 * @param textureName 贴图文件名去掉扩展名(Single 模式的 sprite 就叫这个)
 */
export function spriteRecord(importer: YamlMap, fileID: string, textureName: string, texture: { readonly width: number; readonly height: number }): SpriteRecord | null {
  const sheet = map(importer['spriteSheet'])
  if (num(importer['spriteMode'], 1) !== 2) {
    if (fileID !== SINGLE_SPRITE_FILE_ID) return null
    const rect = { x: 0, y: 0, width: texture.width, height: texture.height }
    return build(textureName, rect, importer['alignment'], importer['spritePivot'], sheet)
  }
  const sprites = list(sheet['sprites']).map(map)
  let sprite = sprites.find((s) => str(s['internalID']) === fileID)
  if (sprite === undefined) {
    const name = nameOfFileID(importer, fileID)
    sprite = name === null ? undefined : sprites.find((s) => str(s['name']) === name)
  }
  if (sprite === undefined) return null
  const r = map(sprite['rect'])
  const rect = { x: num(r['x']), y: num(r['y']), width: num(r['width']), height: num(r['height']) }
  return build(str(sprite['name']), rect, sprite['alignment'], sprite['pivot'], sprite)
}

function build(name: string, rect: SpriteRecord['rect'], alignment: YamlValue | undefined, pivotValue: YamlValue | undefined, geo: YamlMap): SpriteRecord {
  const a = num(alignment, 0)
  const p = map(pivotValue)
  const [px, py] = a === ALIGNMENT_CUSTOM ? [num(p['x'], 0.5), num(p['y'], 0.5)] : (ALIGNMENTS[a] ?? [0.5, 0.5])
  let vertices = list(geo['vertices']).map((v) => ({ x: num(map(v)['x']), y: num(map(v)['y']) }))
  let indices = decodeIndices(str(geo['indices']))
  if (vertices.length === 0) {
    vertices = [{ x: 0, y: 0 }, { x: rect.width, y: 0 }, { x: rect.width, y: rect.height }, { x: 0, y: rect.height }]
    indices = [0, 1, 2, 0, 2, 3]
  }
  return {
    name, rect, pivot: { x: px! * rect.width, y: py! * rect.height }, vertices, indices,
    bones: list(geo['bones']).map(map), weights: list(geo['weights']).map(map),
  }
}

/** 旧写法 `fileIDToRecycleName: {21300002: name}`,新写法 `internalIDToNameTable: [{first: {213: id}, second: name}]` */
function nameOfFileID(importer: YamlMap, fileID: string): string | null {
  const recycled = str(map(importer['fileIDToRecycleName'])[fileID])
  if (recycled !== '') return recycled
  for (const e of list(importer['internalIDToNameTable']).map(map)) {
    if (str(map(e['first'])['213']) === fileID) return str(e['second']) || null
  }
  return null
}
