/**
 * Unity 序列化 YAML 的读取器 —— prefab / `.anim` / controller / Mesh `.asset` / `.meta` 都是这种格式。
 *
 * 只覆盖 Unity 实际会写出的那一小块 YAML 语法,不是通用 YAML 解析器:
 *
 * - 每个对象一个文档:`--- !u!<classID> &<fileID>`(prefab 实例里还会有 ` stripped` 后缀)
 * - 块映射按 2 空格缩进;**序列项 `- ` 与它的父键同缩进**(Unity 的写法,标准 YAML 也允许)
 * - 行内映射 `{fileID: 0, guid: …, type: 3}`、`{x: 0, y: 0, z: 0}`,行内序列 `[]`
 * - 标量:不加引号的字符串(可以带空格)、单 / 双引号字符串、数字。**数字一律按字符串存**,
 *   调用方用 `num()` 取 —— Unity 的名字可以是纯数字(动画叫 "2"),统一转数就分不清了
 *
 * `.meta` 文件没有 `--- !u!` 头,用 `parseYamlDocument` 整篇解析。
 */

export type YamlValue = string | YamlValue[] | { [key: string]: YamlValue }
export type YamlMap = { [key: string]: YamlValue }

export interface UnityObject {
  readonly classID: number
  readonly fileID: string
  /** 顶层键,就是类名:GameObject / Transform / SpriteRenderer / MonoBehaviour / AnimationClip … */
  readonly type: string
  readonly stripped: boolean
  readonly data: YamlMap
}

interface Line {
  readonly indent: number
  readonly text: string
}

function toLines(text: string): Line[] {
  const out: Line[] = []
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.startsWith('%')) continue
    const indent = raw.length - raw.trimStart().length
    out.push({ indent, text: raw.slice(indent) })
  }
  return out
}

// ─── 行内值 ──────────────────────────────────────────────────────────────────

class Flow {
  private i = 0
  private readonly s: string
  constructor(s: string) {
    this.s = s
  }

  private ws(): void {
    while (this.i < this.s.length && this.s[this.i] === ' ') this.i++
  }

  value(stop: string): YamlValue {
    this.ws()
    const c = this.s[this.i]
    if (c === '{') return this.map()
    if (c === '[') return this.seq()
    if (c === '"' || c === "'") return this.quoted()
    const start = this.i
    while (this.i < this.s.length && !stop.includes(this.s[this.i]!)) this.i++
    return this.s.slice(start, this.i).trim()
  }

  private quoted(): string {
    const q = this.s[this.i]!
    this.i++
    let out = ''
    while (this.i < this.s.length) {
      const c = this.s[this.i]!
      if (c === q) {
        // 单引号里 '' 是转义的单引号
        if (q === "'" && this.s[this.i + 1] === "'") {
          out += "'"
          this.i += 2
          continue
        }
        this.i++
        break
      }
      if (q === '"' && c === '\\') {
        const e = this.s[this.i + 1]!
        out += e === 'n' ? '\n' : e === 't' ? '\t' : e
        this.i += 2
        continue
      }
      out += c
      this.i++
    }
    return out
  }

  /** 读到了字符串末尾还没闭合 —— 不是行内结构(UI 文本里常有 `{0}` 这种格式串) */
  private end(): never {
    throw new NotFlow()
  }

  private map(): YamlMap {
    this.i++
    const out: YamlMap = {}
    for (;;) {
      this.ws()
      if (this.i >= this.s.length) this.end()
      if (this.s[this.i] === '}') {
        this.i++
        return out
      }
      const start = this.i
      while (this.i < this.s.length && this.s[this.i] !== ':') this.i++
      if (this.i >= this.s.length) this.end()
      const key = unquoteKey(this.s.slice(start, this.i))
      this.i++
      out[key] = this.value(',}')
      this.ws()
      if (this.s[this.i] === ',') this.i++
    }
  }

  private seq(): YamlValue[] {
    this.i++
    const out: YamlValue[] = []
    for (;;) {
      this.ws()
      if (this.i >= this.s.length) this.end()
      if (this.s[this.i] === ']') {
        this.i++
        return out
      }
      out.push(this.value(',]'))
      this.ws()
      if (this.s[this.i] === ',') this.i++
    }
  }
}

class NotFlow extends Error {}

/** 带引号的键去掉引号:`.meta` 里权重写成 `'weight[0]': 1` */
function unquoteKey(key: string): string {
  const k = key.trim()
  if (k.length >= 2 && ((k.startsWith("'") && k.endsWith("'")) || (k.startsWith('"') && k.endsWith('"')))) {
    return k.slice(1, -1).replace(/''/g, "'")
  }
  return k
}

function scalar(text: string): YamlValue {
  const t = text.trim()
  if (t.startsWith('{') || t.startsWith('[') || t.startsWith('"') || t.startsWith("'")) {
    try {
      return new Flow(t).value('')
    } catch (e) {
      if (e instanceof NotFlow) return t
      throw e
    }
  }
  return t
}

/** `key: value` 的冒号位置(不算引号和行内映射里的) */
function keyColon(text: string): number {
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote !== null) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth--
    else if (c === ':' && depth === 0 && (i + 1 === text.length || text[i + 1] === ' ')) return i
  }
  return -1
}

// ─── 块结构 ──────────────────────────────────────────────────────────────────

class Block {
  private i = 0
  /** 可改:`- key: value` 的序列项会把当前行原地换成「缩进 +2 的 key: value」再按映射读 */
  private readonly lines: Line[]
  constructor(lines: readonly Line[]) {
    this.lines = [...lines]
  }

  get done(): boolean {
    return this.i >= this.lines.length
  }

  /** 解析缩进 = indent 的一个块映射 */
  map(indent: number): YamlMap {
    const out: YamlMap = {}
    while (this.i < this.lines.length) {
      const line = this.lines[this.i]!
      if (line.indent < indent || (line.indent === indent && line.text.startsWith('- '))) break
      if (line.indent > indent) {
        // 不该出现:上一个值的续行。拼到上一个标量后面(Unity 偶尔把很长的字符串折行)
        this.i++
        continue
      }
      const colon = keyColon(line.text)
      if (colon < 0) {
        this.i++
        continue
      }
      const key = unquoteKey(line.text.slice(0, colon))
      const rest = line.text.slice(colon + 1).trim()
      this.i++
      if (rest !== '') {
        let value = rest
        // 折行的长标量:后面缩进更深、又不是键值对的行拼起来
        while (this.i < this.lines.length && this.lines[this.i]!.indent > indent && keyColon(this.lines[this.i]!.text) < 0 && !this.lines[this.i]!.text.startsWith('- ')) {
          value += ' ' + this.lines[this.i]!.text
          this.i++
        }
        out[key] = scalar(value)
        continue
      }
      out[key] = this.child(indent)
    }
    return out
  }

  /** 键后面没写值:下面是更深缩进的映射,或同缩进 / 更深缩进的序列;都没有就是空串 */
  private child(indent: number): YamlValue {
    const next = this.lines[this.i]
    if (next === undefined) return ''
    if (next.text.startsWith('- ') || next.text === '-') {
      if (next.indent >= indent) return this.seq(next.indent)
      return ''
    }
    if (next.indent > indent) return this.map(next.indent)
    return ''
  }

  /** 缩进 = indent 的块序列 */
  seq(indent: number): YamlValue[] {
    const out: YamlValue[] = []
    while (this.i < this.lines.length) {
      const line = this.lines[this.i]!
      if (line.indent !== indent || !(line.text.startsWith('- ') || line.text === '-')) break
      const body = line.text === '-' ? '' : line.text.slice(2)
      const itemIndent = indent + 2
      const colon = keyColon(body)
      if (body === '') {
        this.i++
        out.push(this.child(indent))
      } else if (colon >= 0 && !body.startsWith('{')) {
        // `- key: value` 开头的映射项:把这一行原地换成缩进 itemIndent 的第一行,接着读完整个映射
        this.lines[this.i] = { indent: itemIndent, text: body }
        out.push(this.map(itemIndent))
      } else {
        this.i++
        out.push(scalar(body))
      }
    }
    return out
  }

}

/** 解析一篇没有 `--- !u!` 头的 YAML(`.meta`) */
export function parseYamlDocument(text: string): YamlMap {
  const lines = toLines(text)
  const block = new Block(lines)
  return block.map(lines[0]?.indent ?? 0)
}

/** 解析 Unity 的多文档序列化文件:prefab / `.anim` / `.controller` / Mesh `.asset` */
export function parseUnityYaml(text: string): UnityObject[] {
  const out: UnityObject[] = []
  const chunks = text.split(/^--- /m)
  for (const chunk of chunks.slice(1)) {
    const newline = chunk.indexOf('\n')
    const head = chunk.slice(0, newline < 0 ? chunk.length : newline).trim()
    const m = /^!u!(\d+) &(-?\d+)( stripped)?/.exec(head)
    if (m === null) continue
    const body = parseYamlDocument(newline < 0 ? '' : chunk.slice(newline + 1))
    const type = Object.keys(body)[0] ?? ''
    const data = (body[type] as YamlMap | undefined) ?? {}
    out.push({ classID: Number(m[1]), fileID: m[2]!, type, stripped: m[3] !== undefined, data: typeof data === 'object' && !Array.isArray(data) ? data : {} })
  }
  return out
}

// ─── 取值 ────────────────────────────────────────────────────────────────────

export function num(v: YamlValue | undefined, fallback = 0): number {
  if (typeof v !== 'string' || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export function str(v: YamlValue | undefined): string {
  return typeof v === 'string' ? v : ''
}

export function map(v: YamlValue | undefined): YamlMap {
  return v !== undefined && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

export function list(v: YamlValue | undefined): YamlValue[] {
  return Array.isArray(v) ? v : []
}

/** `{fileID: …, guid: …, type: …}` 引用 */
export interface UnityRef {
  readonly fileID: string
  readonly guid: string | null
}

export function ref(v: YamlValue | undefined): UnityRef {
  const m = map(v)
  return { fileID: str(m['fileID']) || '0', guid: str(m['guid']) || null }
}

export function vec(v: YamlValue | undefined): { x: number; y: number; z: number; w: number } {
  const m = map(v)
  return { x: num(m['x']), y: num(m['y']), z: num(m['z']), w: num(m['w'], 1) }
}
