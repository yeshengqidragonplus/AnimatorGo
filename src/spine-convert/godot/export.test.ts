import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readSkeletonPart } from '../../spine-format/binary/readSkeleton.ts'
import type { AnimationData } from '../../spine-format/binary/readAnimations.ts'
import { parseAtlas } from '../../core/atlas.ts'
import { decodePng, type Image } from '../../unity/png.ts'
import { poseAt, setupPose, type Affine } from '../../spine-eval/pose.ts'
import { attachmentVertices } from '../../spine-eval/vertices.ts'
import { lastPerProperty } from '../../spine-format/duplicateTimelines.ts'
import { parseScene, type ParsedSection, type ParsedValue } from '../../godot/tscn.ts'
import { exportToGodot } from './export.ts'

/**
 * Spine → Godot 的**端到端校验**。
 *
 * 把写出的 `.tscn` 读回来,**按 Godot 自己的规则**算每个顶点的位置,和 Spine 的骨架求值比:
 *
 * ```
 * 轨道求值:值轨道 update=0 线性、update=1 取不晚于 t 的最后一键;贝塞尔轨道控制柄是相对偏移(实测)
 * 没有轨道的属性:取 RESET(deterministic,实测)
 * 骨骼世界矩阵:Node2D 的 (position, rotation, skew, scale) 逐级相乘
 * 蒙皮:v' = Σ wᵢ · Bᵢ(pose) · Bᵢ(rest)⁻¹ · v(实测)
 * ```
 *
 * 规则全部来自 tools/godot/ 探针在 Godot 4.7 上的实测(docs/GODOT.md)。读回而不是用内存里的中间结果,
 * 顺带把 .tscn 写入器也验了。两边都不含 IK / 约束(Godot 这边没转,Spine 求值器也不解)。
 */

const SKELETON = 'res/spine/4.1/MX2_cat.skel.bytes'
const ATLAS = 'res/spine/4.1/MX2_cat.atlas.txt'
const PAGE = 'res/spine/4.1/MX2_cat.png'
const hasAssets = [SKELETON, ATLAS, PAGE].every(existsSync)

// ─── 按 Godot 的规则求值 ─────────────────────────────────────────────────────

interface Node {
  readonly name: string
  readonly type: string
  readonly path: string
  readonly parent: string | null
  readonly props: Map<string, ParsedValue>
}

const args = (v: ParsedValue | undefined): number[] => ((v as { args: ParsedValue[] } | undefined)?.args ?? []) as number[]
const num = (v: ParsedValue | undefined, fallback: number) => (typeof v === 'number' ? v : fallback)

function mul(p: Affine, q: Affine): Affine {
  return {
    a: p.a * q.a + p.b * q.c, b: p.a * q.b + p.b * q.d,
    c: p.c * q.a + p.d * q.c, d: p.c * q.b + p.d * q.d,
    x: p.a * q.x + p.b * q.y + p.x, y: p.c * q.x + p.d * q.y + p.y,
  }
}
function inverse(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c
  const a = m.d / det, b = -m.b / det, c = -m.c / det, d = m.a / det
  return { a, b, c, d, x: -(a * m.x + b * m.y), y: -(c * m.x + d * m.y) }
}
const apply = (m: Affine, x: number, y: number) => ({ x: m.a * x + m.b * y + m.x, y: m.c * x + m.d * y + m.y })
const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 }

/** Godot 的 Transform2D(x 轴, y 轴, 原点) */
function transform2d(v: ParsedValue | undefined): Affine {
  if (v === undefined) return IDENTITY
  const [xx, xy, yx, yy, ox, oy] = args(v)
  return { a: xx!, c: xy!, b: yx!, d: yy!, x: ox!, y: oy! }
}

class GodotScene {
  readonly nodes = new Map<string, Node>()
  readonly animations = new Map<string, ParsedSection>()

  constructor(text: string) {
    for (const s of parseScene(text)) {
      if (s.kind === 'node') {
        const parent = s.attrs['parent'] ?? null
        const name = s.attrs['name']!
        const path = parent === null ? '' : parent === '.' ? name : `${parent}/${name}`
        this.nodes.set(path, { name, type: s.attrs['type']!, path, parent, props: s.props })
      } else if (s.kind === 'sub_resource' && s.attrs['type'] === 'Animation') {
        this.animations.set(s.props.get('resource_name') as string, s)
      }
    }
  }

  /** 动画在 t 时刻的属性值:`节点路径:属性` → 值。没轨道的属性取 RESET */
  evaluate(animName: string | null, t: number): Map<string, ParsedValue> {
    const out = new Map<string, ParsedValue>()
    for (const name of ['RESET', ...(animName === null ? [] : [animName])]) {
      const anim = this.animations.get(name)!
      for (let i = 0; anim.props.has(`tracks/${i}/type`); i++) {
        const path = args(anim.props.get(`tracks/${i}/path`))[0] as unknown as string
        const keys = anim.props.get(`tracks/${i}/keys`) as Record<string, ParsedValue>
        out.set(path, evalTrack(anim.props.get(`tracks/${i}/type`) as string, keys, name === 'RESET' ? 0 : t))
      }
    }
    return out
  }

  local(node: Node, values: Map<string, ParsedValue>): Affine {
    const p = (prop: string) => values.get(`${node.path}:${prop}`)
    const pos = args(node.props.get('position'))
    const scl = node.props.has('scale') ? args(node.props.get('scale')) : [1, 1]
    const x = num(p('position:x'), pos[0] ?? 0)
    const y = num(p('position:y'), pos[1] ?? 0)
    const r = num(p('rotation'), num(node.props.get('rotation'), 0))
    const k = num(p('skew'), num(node.props.get('skew'), 0))
    const sx = num(p('scale:x'), scl[0]!)
    const sy = num(p('scale:y'), scl[1]!)
    return { a: Math.cos(r) * sx, c: Math.sin(r) * sx, b: -Math.sin(r + k) * sy, d: Math.cos(r + k) * sy, x, y }
  }

  world(path: string, values: Map<string, ParsedValue>): Affine {
    if (path === '') return IDENTITY
    const node = this.nodes.get(path)!
    const parent = node.parent === '.' ? '' : node.parent!
    return mul(this.world(parent, values), this.local(node, values))
  }

  /** Bone2D 的 rest 世界矩阵:从 Skeleton2D(单位)起逐级相乘 rest */
  restWorld(path: string): Affine {
    const node = this.nodes.get(path)!
    if (node.type !== 'Bone2D') return IDENTITY
    return mul(this.restWorld(node.parent!), transform2d(node.props.get('rest')))
  }

  /** Polygon2D 在 t 时刻的顶点(场景根空间,Godot 坐标) */
  vertices(node: Node, values: Map<string, ParsedValue>): { x: number; y: number }[] {
    const polygon = args(values.get(`${node.path}:polygon`) ?? node.props.get('polygon'))
    const out: { x: number; y: number }[] = []
    const bones = node.props.get('bones') as ParsedValue[] | undefined
    if (bones === undefined) {
      const w = this.world(node.path, values)
      for (let i = 0; i < polygon.length; i += 2) out.push(apply(w, polygon[i]!, polygon[i + 1]!))
      return out
    }
    const skin: { m: Affine; w: number[] }[] = []
    for (let k = 0; k < bones.length; k += 2) {
      const bonePath = `Skeleton2D/${bones[k] as string}`
      skin.push({ m: mul(this.world(bonePath, values), inverse(this.restWorld(bonePath))), w: args(bones[k + 1]) })
    }
    for (let i = 0; i < polygon.length / 2; i++) {
      let x = 0
      let y = 0
      for (const s of skin) {
        const p = apply(s.m, polygon[i * 2]!, polygon[i * 2 + 1]!)
        x += p.x * s.w[i]!
        y += p.y * s.w[i]!
      }
      out.push({ x, y })
    }
    return out
  }
}

function evalTrack(type: string, keys: Record<string, ParsedValue>, t: number): ParsedValue {
  const times = args(keys['times'])
  let i = 0
  while (i + 1 < times.length && times[i + 1]! <= t) i++
  if (type === 'bezier') {
    const pts = args(keys['points'])
    const key = (k: number) => ({ t: times[k]!, v: pts[k * 5]!, ix: pts[k * 5 + 1]!, iy: pts[k * 5 + 2]!, ox: pts[k * 5 + 3]!, oy: pts[k * 5 + 4]! })
    if (t <= times[0]! || i + 1 >= times.length) return key(Math.min(i, times.length - 1)).v
    const a = key(i)
    const b = key(i + 1)
    const x = [a.t, a.t + a.ox, b.t + b.ix, b.t]
    const y = [a.v, a.v + a.oy, b.v + b.iy, b.v]
    const cubic = (s: number, p: number[]) => { const u = 1 - s; return u * u * u * p[0]! + 3 * u * u * s * p[1]! + 3 * u * s * s * p[2]! + s * s * s * p[3]! }
    let lo = 0
    let hi = 1
    for (let n = 0; n < 50; n++) { const m = (lo + hi) / 2; if (cubic(m, x) < t) lo = m; else hi = m }
    return cubic((lo + hi) / 2, y)
  }
  const values = keys['values'] as ParsedValue[]
  if (keys['update'] === 1 || t <= times[0]! || i + 1 >= times.length) return values[Math.min(i, values.length - 1)]!
  const f = (t - times[i]!) / (times[i + 1]! - times[i]!)
  const a = values[i]!
  const b = values[i + 1]!
  if (typeof a === 'number') return a + ((b as number) - a) * f
  const aa = args(a)
  const bb = args(b)
  return { $: (a as { $: string }).$, args: aa.map((v, k) => v + (bb[k]! - v) * f) }
}

// ─── 用例 ────────────────────────────────────────────────────────────────────

const MC2 = 'E:/UnityProject/MergeCooking2/MergeCooking2/Assets/Export/Spine/NewSpine'
/**
 * 仓库里的两份必跑(3.8 那份的贝塞尔控制点是归一化的,正好覆盖两版换算);
 * MergeCooking2 的本地样本存在才跑:加权网格 deform、大幅 deform、linkedmesh
 */
const SAMPLES: { label: string; skel: string; atlas: string }[] = [
  { label: 'MX2_cat 4.1', skel: SKELETON, atlas: ATLAS },
  { label: 'MX2_cat 3.8', skel: 'res/spine/3.8/MX2_cat.skel.bytes', atlas: 'res/spine/3.8/MX2_cat.atlas.txt' },
  { label: 'customer_1(加权网格 deform)', skel: `${MC2}/Customer1/customer_1.skel.bytes`, atlas: `${MC2}/Customer1/customer_1.atlas.txt` },
  { label: 'wave(全靠 deform)', skel: `${MC2}/wave/wave.skel.bytes`, atlas: `${MC2}/wave/wave.atlas.txt` },
  { label: 'Female staff(linkedmesh)', skel: `${MC2}/Customer12/Female staff.skel.bytes`, atlas: `${MC2}/Customer12/Female staff.atlas.txt` },
  { label: 'blackrichwoman(6 套皮肤)', skel: `${MC2}/Customer11/blackrichwoman.skel.bytes`, atlas: `${MC2}/Customer11/blackrichwoman.atlas.txt` },
  { label: 'BBQ_grill(100 个 region、换图)', skel: `${MC2}/BBQ/BBQ_grill.skel.bytes`, atlas: `${MC2}/BBQ/BBQ_grill.atlas.txt` },
  // B_body2 的绑定姿势各顶点不一致、按图也拟合不上:不逐帧修正的话动画里差 127 像素
  { label: 'whiteman_sit(绑定不一致,靠逐帧修正)', skel: `${MC2}/MapCharacters/whiteman_sit/whiteman_sit.skel.bytes`, atlas: `${MC2}/MapCharacters/whiteman_sit/whiteman_sit.atlas.txt` },
]

for (const sample of SAMPLES) {
describe.skipIf(!hasAssets || !existsSync(sample.skel) || !existsSync(sample.atlas))(`Spine → Godot 端到端(${sample.label})`, () => {
  const part = readSkeletonPart(new Uint8Array(readFileSync(sample.skel)))
  const atlas = parseAtlas(readFileSync(sample.atlas, 'utf8'))
  const dir = sample.atlas.slice(0, sample.atlas.lastIndexOf('/'))
  const sources = new Map<string, Image>(atlas.pages.map((p) => [p.name, decodePng(new Uint8Array(readFileSync(`${dir}/${p.name}`)))]))
  const result = exportToGodot(part, atlas, sources, { name: 'sample', resDir: 'res://sample' })
  const text = result.files.find((f) => f.path === 'sample.tscn')!.content as string
  const scene = new GodotScene(text)

  /**
   * 每套皮肤里每个画得出来的 attachment,和它在 Godot 里的 Polygon2D。
   * 和皮肤有关的节点外面包着 `<基名> (<皮肤>)`,同名的 Polygon2D 会出现在几套皮肤里,按包装节点认。
   * 序列帧(每帧一个节点)不在这里比 —— 几何与普通 attachment 相同,只是换了区域
   */
  const polygons = [...scene.nodes.values()].filter((n) => n.type === 'Polygon2D')
  const pairs = part.skins.flatMap((skin) => skin.slots.flatMap((entry) => entry.attachments
    .filter((a) => (a.type === 'region' || a.type === 'mesh') && a.sequence === null)
    .map((a) => {
      const slot = part.slots[entry.slot]!
      const name = a.key === slot.name ? slot.name : `${slot.name}__${a.key}`
      const wrapped = polygons.find((n) => n.name === name && n.parent?.endsWith(`/${name} (${skin.name})`) === true)
        ?? polygons.find((n) => n.name === name && n.parent === `${name} (${skin.name})`)
      const plain = polygons.find((n) => n.name === name && !/\)$/.test(n.parent ?? ''))
      return { a, skin: skin.name, slot: entry.slot, node: (wrapped ?? plain)! }
    })))

  /**
   * 绑定姿势各影响不一致、又按图拟合不上的网格(bindWeighted 第 3 档):导出器自己逐帧实测了动画里最多偏多少并报出来。
   * 这里核对「报出来的数兜得住实际偏差」—— 允许 20% 的余量,因为这里的取样时刻(关键帧 + 中点)与导出器的(30 fps)不同
   */
  const reported = new Map<string, number>()
  for (const i of result.issues) {
    const m = /最多偏 ([\d.]+) 像素/.exec(i.message)
    if (m !== null && i.path.startsWith('mesh.')) reported.set(i.path.slice('mesh.'.length), Number(m[1]))
  }

  /** 超出允许偏差的最大值(≤ 0 就是全部在容差内) */
  function worstAt(anim: AnimationData | null, t: number, tolerance: number): { excess: number; where: string } {
    const pose = anim === null ? setupPose(part) : poseAt(part, { ...anim, timelines: lastPerProperty(anim.timelines).kept }, t)
    const values = scene.evaluate(anim?.name ?? null, t)
    let excess = -Infinity
    let where = ''
    for (const { a, skin, slot, node } of pairs) {
      // Spine 的顶点(Y 朝上)翻成 Godot 坐标
      const spine = attachmentVertices(part, atlas, a, skin, slot, pose, anim, t).map((p) => ({ x: p.x, y: -p.y }))
      const godot = scene.vertices(node, values)
      expect(godot.length, a.name).toBe(spine.length)
      const allowed = anim === null ? tolerance : Math.max(tolerance, (reported.get(a.name) ?? 0) * 1.2 + 0.1)
      spine.forEach((p, i) => {
        const d = Math.hypot(p.x - godot[i]!.x, p.y - godot[i]!.y) - allowed
        if (d > excess) { excess = d; where = `${a.name} 第 ${i} 个顶点 @${anim?.name ?? 'setup'} ${t.toFixed(3)} 偏 ${(d + allowed).toFixed(2)} 像素(允许 ${allowed.toFixed(2)})` }
      })
    }
    return { excess, where }
  }

  it('每个 attachment 都有 Polygon2D;根下有 Skeleton2D 和 AnimationPlayer', () => {
    for (const p of pairs) expect(p.node, p.a.name).toBeDefined()
    expect(scene.nodes.get('Skeleton2D')?.type).toBe('Skeleton2D')
    expect(scene.nodes.get('AnimationPlayer')?.props.get('deterministic')).toBe(true)
    expect(scene.nodes.get('AnimationPlayer')?.props.get('callback_mode_discrete')).toBe(2)
  })

  it('⭐ setup 姿势:按 Godot 的规则算出的顶点与 Spine 一致(含「第二套」网格的辅助骨骼)', () => {
    const { excess, where } = worstAt(null, 0, 0.05)
    expect(excess, where).toBeLessThan(0)
  })

  it('⭐ 每条动画的每个关键帧,以及相邻关键帧的中点:顶点与 Spine 一致', () => {
    let checked = 0
    for (const anim of part.animations) {
      const times = new Set<number>()
      for (const tl of anim.timelines) {
        const frames = tl.kind === 'deform' ? (tl.frames[0] as { frames: Record<string, unknown>[] }).frames : tl.frames
        for (const f of frames) if (typeof f['time'] === 'number') times.add(f['time'] as number)
      }
      const sorted = [...times].sort((x, y) => x - y)
      const probes = [...sorted, ...sorted.slice(1).map((t, i) => (t + sorted[i]!) / 2)]
      for (const t of probes) {
        const { excess, where } = worstAt(anim, t, 0.5)
        expect(excess, where).toBeLessThan(0)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(20)
  })

  it('每条轨道都指向场景里真实存在的节点', () => {
    for (const [name, anim] of scene.animations) {
      for (let i = 0; anim.props.has(`tracks/${i}/type`); i++) {
        const path = args(anim.props.get(`tracks/${i}/path`))[0] as unknown as string
        const node = path.slice(0, path.indexOf(':'))
        expect(scene.nodes.has(node), `${name}:${path}`).toBe(true)
      }
    }
  })

  it('⭐ 没有一条轨道在同一时刻有两个键(Godot 在那一刻取第一个,和这里的求值不一样 —— 实测开头一帧两张图一起亮)', () => {
    for (const [name, anim] of scene.animations) {
      for (let i = 0; anim.props.has(`tracks/${i}/type`); i++) {
        const keys = anim.props.get(`tracks/${i}/keys`) as Record<string, ParsedValue>
        const times = args(keys['times'])
        times.forEach((t, k) => { if (k > 0) expect(t, `${name}:${args(anim.props.get(`tracks/${i}/path`))[0]} 第 ${k} 个键`).toBeGreaterThan(times[k - 1]!) })
      }
    }
  })

  it('皮肤:每套一条 SkinPlayer 动画;初始按默认皮肤,具名皮肤的节点灭、被它盖住的默认节点在它的动画里灭', () => {
    const named = part.skins.filter((s, i) => i > 0 && s.slots.length > 0)
    if (named.length === 0) {
      expect(scene.nodes.has('SkinPlayer')).toBe(false)
      return
    }
    const player = scene.nodes.get('SkinPlayer')!
    expect(player.type).toBe('AnimationPlayer')
    const skinAnims = [...scene.animations.keys()].filter((n) => part.skins.some((s) => s.name === n))
    expect(skinAnims.sort()).toEqual(part.skins.filter((s, i) => i === 0 || s.slots.length > 0).map((s) => s.name).sort())
    const initial = player.props.get('autoplay') as string
    for (const { a, node } of pairs) {
      const wrapper = node.parent !== null && node.parent.endsWith(')') ? scene.nodes.get(node.parent) : undefined
      if (wrapper === undefined) continue
      const skin = /\(([^()]*)\)$/.exec(wrapper.name)![1]!
      // 初始可见性写在节点上(编辑器里一打开就是初始皮肤)
      const shownInitially = wrapper.props.get('visible') !== false
      if (skin !== part.skins[0]!.name) expect(shownInitially, `${a.name}@${skin}`).toBe(skin === initial)
      // 该皮肤自己的动画里一定亮
      const own = scene.evaluate(skin === part.skins[0]!.name ? initial : skin, 0).get(`${wrapper.path}:visible`)
      if (skin !== part.skins[0]!.name) expect(own, `${a.name}@${skin}`).toBe(true)
    }
  })

  it('有损的地方都报出来了(IK / transform 约束)', () => {
    const kinds = result.issues.map((i) => `${i.level}:${i.path}`)
    expect(kinds.filter((k) => k.startsWith('loss:ik.')).length).toBe(part.ik.length)
    expect(kinds.filter((k) => k.startsWith('loss:transform.')).length).toBe(part.transform.length)
  })
})
}
