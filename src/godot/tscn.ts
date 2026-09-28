/**
 * Godot 4 文本场景(`.tscn`)的写入与读回。
 *
 * 写法全部取自 Godot 4.7 自己写出的文件(`tools/godot/AnimatorGoProbe.gd` 的产物),见 docs/GODOT.md 第 2 节。
 * 读回只为测试服务:把我们写出的场景重新解析,按 Godot 的规则算一遍顶点,再和 Spine 的求值比 ——
 * 与 Unity 那边「把写出的 .meta / prefab 读回来验」同一个思路,顺带把写入器也验了。
 */

// ─── 值 ──────────────────────────────────────────────────────────────────────

export type GodotValue =
  | number
  | boolean
  | string
  | null
  | GodotFloat
  | GodotTyped
  | readonly GodotValue[]
  | { readonly [key: string]: GodotValue }

/**
 * Variant 里的浮点数要带小数点 —— `1` 会被读成 int。数组 `"values": [0.0, 1.0]` 这类地方,
 * 写成 int 的话 rotation 轨道的取值类型就成了 int。Packed 数组里没这个问题,整数照写。
 */
export interface GodotFloat {
  readonly $: 'float'
  readonly value: number
}

export type GodotTyped =
  | { readonly $: 'Vector2'; readonly x: number; readonly y: number }
  | { readonly $: 'Transform2D'; readonly a: number; readonly b: number; readonly c: number; readonly d: number; readonly x: number; readonly y: number }
  | { readonly $: 'Color'; readonly r: number; readonly g: number; readonly b: number; readonly a: number }
  | { readonly $: 'NodePath'; readonly path: string }
  | { readonly $: 'StringName'; readonly name: string }
  | { readonly $: 'PackedFloat32Array'; readonly values: readonly number[] }
  | { readonly $: 'PackedInt32Array'; readonly values: readonly number[] }
  | { readonly $: 'PackedVector2Array'; readonly values: readonly number[] }
  | { readonly $: 'SubResource'; readonly id: string }
  | { readonly $: 'ExtResource'; readonly id: string }

export const float = (value: number): GodotFloat => ({ $: 'float', value })
export const vec2 = (x: number, y: number): GodotTyped => ({ $: 'Vector2', x, y })
/** Godot 的 Transform2D 写成 `(x 轴, y 轴, 原点)`,与 Spine 的 `a c / b d` 列排法相同 */
export const transform2d = (m: { a: number; b: number; c: number; d: number; x: number; y: number }): GodotTyped => ({
  $: 'Transform2D', a: m.a, b: m.c, c: m.b, d: m.d, x: m.x, y: m.y,
})
export const color = (r: number, g: number, b: number, a: number): GodotTyped => ({ $: 'Color', r, g, b, a })
export const nodePath = (path: string): GodotTyped => ({ $: 'NodePath', path })
export const stringName = (name: string): GodotTyped => ({ $: 'StringName', name })
export const packedFloat32 = (values: readonly number[]): GodotTyped => ({ $: 'PackedFloat32Array', values })
export const packedInt32 = (values: readonly number[]): GodotTyped => ({ $: 'PackedInt32Array', values })
/** 平铺的 x, y, x, y… */
export const packedVector2 = (values: readonly number[]): GodotTyped => ({ $: 'PackedVector2Array', values })
export const subResource = (id: string): GodotTyped => ({ $: 'SubResource', id })
export const extResource = (id: string): GodotTyped => ({ $: 'ExtResource', id })

/**
 * 数字的写法。-0 写成 0;极小的残差(1e-12 这种)抹成 0,免得文件里满是 `1.2e-13`。
 * 保留 7 位有效数字:Godot 的 real_t 是 float32,再多也存不住,而且与它自己写出的精度一致。
 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`Godot 场景里不能写 ${n}`)
  if (Math.abs(n) < 1e-9) return '0'
  const s = Number(n.toPrecision(7)).toString()
  return s
}

function formatFloat(n: number): string {
  const s = formatNumber(n)
  return /[.e]/.test(s) ? s : `${s}.0`
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

const list = (values: readonly number[]) => values.map(formatNumber).join(', ')

export function formatValue(v: GodotValue): string {
  if (v === null) return 'null'
  if (typeof v === 'number') return formatNumber(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'string') return quote(v)
  if (Array.isArray(v)) return `[${v.map(formatValue).join(', ')}]`
  const t = v as GodotTyped | GodotFloat | { readonly [key: string]: GodotValue }
  if ('$' in t && typeof t.$ === 'string') {
    const typed = t as GodotTyped | GodotFloat
    switch (typed.$) {
      case 'float': return formatFloat(typed.value)
      case 'Vector2': return `Vector2(${list([typed.x, typed.y])})`
      case 'Transform2D': return `Transform2D(${list([typed.a, typed.b, typed.c, typed.d, typed.x, typed.y])})`
      case 'Color': return `Color(${list([typed.r, typed.g, typed.b, typed.a])})`
      case 'NodePath': return `NodePath(${quote(typed.path)})`
      case 'StringName': return `&${quote(typed.name)}`
      case 'PackedFloat32Array': return `PackedFloat32Array(${list(typed.values)})`
      case 'PackedInt32Array': return `PackedInt32Array(${list(typed.values)})`
      case 'PackedVector2Array': return `PackedVector2Array(${list(typed.values)})`
      case 'SubResource': return `SubResource(${quote(typed.id)})`
      case 'ExtResource': return `ExtResource(${quote(typed.id)})`
    }
  }
  // 字典:键一律按字符串写(StringName 键在调用方用 &"…" 形式的键名传入)
  const entries = Object.entries(t as { readonly [key: string]: GodotValue })
  if (entries.length === 0) return '{}'
  return `{\n${entries.map(([k, val]) => `${k.startsWith('&"') ? k : quote(k)}: ${formatValue(val)}`).join(',\n')}\n}`
}

// ─── 场景 ────────────────────────────────────────────────────────────────────

export interface ExtResourceDecl {
  readonly id: string
  readonly type: string
  /** `res://` 路径 */
  readonly path: string
}

export interface SubResourceDecl {
  readonly id: string
  readonly type: string
  /** 按顺序写出;键可以带斜杠(`tracks/0/path`) */
  readonly properties: readonly (readonly [string, GodotValue])[]
}

export interface NodeDecl {
  readonly name: string
  readonly type: string
  /** 相对根节点的父路径:根节点为 null,根的直接子节点为 `.` */
  readonly parent: string | null
  readonly properties: readonly (readonly [string, GodotValue])[]
}

export interface GodotScene {
  readonly extResources: readonly ExtResourceDecl[]
  readonly subResources: readonly SubResourceDecl[]
  readonly nodes: readonly NodeDecl[]
}

function writeProperties(properties: readonly (readonly [string, GodotValue])[]): string[] {
  return properties.map(([k, v]) => `${k} = ${formatValue(v)}`)
}

export function writeScene(scene: GodotScene): string {
  const out: string[] = ['[gd_scene format=3]', '']
  for (const r of scene.extResources) {
    out.push(`[ext_resource type=${quote(r.type)} path=${quote(r.path)} id=${quote(r.id)}]`)
  }
  if (scene.extResources.length > 0) out.push('')
  for (const r of scene.subResources) {
    out.push(`[sub_resource type=${quote(r.type)} id=${quote(r.id)}]`, ...writeProperties(r.properties), '')
  }
  for (const n of scene.nodes) {
    const parent = n.parent === null ? '' : ` parent=${quote(n.parent)}`
    out.push(`[node name=${quote(n.name)} type=${quote(n.type)}${parent}]`, ...writeProperties(n.properties), '')
  }
  return out.join('\n')
}

// ─── 读回(只解析我们自己会写出的那部分语法)────────────────────────────────

export type ParsedValue =
  | number
  | boolean
  | string
  | null
  | ParsedValue[]
  | { [key: string]: ParsedValue }
  | { $: string; args: ParsedValue[] }

export interface ParsedSection {
  readonly kind: string
  readonly attrs: Record<string, string>
  readonly props: Map<string, ParsedValue>
}

class Reader {
  private i = 0
  private readonly s: string
  // 不用构造参数属性 —— node 的 --experimental-strip-types 不支持
  constructor(s: string) {
    this.s = s
  }

  private ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++
  }

  value(): ParsedValue {
    this.ws()
    const c = this.s[this.i]!
    if (c === '"') return this.str()
    if (c === '&') {
      this.i++
      return { $: 'StringName', args: [this.str()] }
    }
    if (c === '[') return this.array()
    if (c === '{') return this.dict()
    if (/[-\d.]/.test(c)) {
      const m = /^-?[\d.]+(e[-+]?\d+)?/i.exec(this.s.slice(this.i))!
      this.i += m[0].length
      return Number(m[0])
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.i))!
    this.i += m[0].length
    const word = m[0]
    if (word === 'true') return true
    if (word === 'false') return false
    if (word === 'null') return null
    this.ws()
    if (this.s[this.i] !== '(') throw new Error(`不认识的值 ${word}`)
    this.i++
    const args: ParsedValue[] = []
    this.ws()
    while (this.s[this.i] !== ')') {
      args.push(this.value())
      this.ws()
      if (this.s[this.i] === ',') this.i++
      this.ws()
    }
    this.i++
    return { $: word, args }
  }

  private str(): string {
    this.i++
    let out = ''
    while (this.s[this.i] !== '"') {
      if (this.s[this.i] === '\\') {
        this.i++
        const e = this.s[this.i]!
        out += e === 'n' ? '\n' : e
      } else out += this.s[this.i]
      this.i++
    }
    this.i++
    return out
  }

  private array(): ParsedValue[] {
    this.i++
    const out: ParsedValue[] = []
    this.ws()
    while (this.s[this.i] !== ']') {
      out.push(this.value())
      this.ws()
      if (this.s[this.i] === ',') this.i++
      this.ws()
    }
    this.i++
    return out
  }

  private dict(): { [key: string]: ParsedValue } {
    this.i++
    const out: { [key: string]: ParsedValue } = {}
    this.ws()
    while (this.s[this.i] !== '}') {
      const k = this.value()
      const key = typeof k === 'string' ? k : (k as { args: ParsedValue[] }).args[0] as string
      this.ws()
      this.i++ // ':'
      out[key] = this.value()
      this.ws()
      if (this.s[this.i] === ',') this.i++
      this.ws()
    }
    this.i++
    return out
  }

  get done(): number {
    return this.i
  }
}

/** 解析一个完整的值(可以跨行) */
export function parseValue(text: string): ParsedValue {
  return new Reader(text).value()
}

export function parseScene(text: string): ParsedSection[] {
  const sections: ParsedSection[] = []
  let current: ParsedSection | null = null
  let i = 0
  while (i < text.length) {
    const lineEnd = text.indexOf('\n', i) < 0 ? text.length : text.indexOf('\n', i)
    const line = text.slice(i, lineEnd)
    if (line.startsWith('[')) {
      const m = /^\[(\w+)(.*)\]$/.exec(line.trim())!
      const attrs: Record<string, string> = {}
      for (const a of m[2]!.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g)) {
        attrs[a[1]!] = a[2]!.startsWith('"') ? (parseValue(a[2]!) as string) : a[2]!
      }
      current = { kind: m[1]!, attrs, props: new Map() }
      sections.push(current)
      i = lineEnd + 1
      continue
    }
    const eq = line.indexOf(' = ')
    if (current !== null && eq > 0) {
      const key = line.slice(0, eq)
      const reader = new Reader(text.slice(i + eq + 3))
      current.props.set(key, reader.value())
      i = i + eq + 3 + reader.done
      const next = text.indexOf('\n', i)
      i = next < 0 ? text.length : next + 1
      continue
    }
    i = lineEnd + 1
  }
  return sections
}
