import { evaluateRealCurve, parseRealCurve, type RealKey } from '../../cocos/curve.ts'
import type { Affine } from '../../spine-eval/pose.ts'

/**
 * 按 **Cocos 的规则**读回导出的 prefab 和 `.anim`,算出某一时刻每个 Sprite 画在哪(世界坐标的四角)、
 * 哪些亮着、先后、颜色。端到端测试拿它和 Spine 的求值比。
 *
 * 规则(都取自引擎源码 / 探针实测):
 * - 节点局部矩阵 = 平移 · 绕 Z 旋转(eulerAngles.z,逆时针为正)· 缩放;世界 = 父 · 局部
 * - Sprite(sizeMode CUSTOM、trim 关)的矩形:UITransform 的 contentSize 和 anchorPoint,
 *   [−ax·w, (1−ax)·w] × [−ay·h, (1−ay)·h],角的顺序左下、右下、右上、左上
 * - 显示 = 自己和所有祖先的 active
 * - 先后 = Sorting2D 的 sortingOrder 升序,相同的按节点树顺序
 * - 动画:VectorTrack 各分量各一条 RealCurve,没键的分量保留原值;ObjectTrack 保持前值;RealCurve 的求值
 *   照引擎移植(curve.ts),第一键之前 / 最后一键之后保持端值
 */

type Json = Record<string, unknown>
type Ref = { __id__: number }
const isRef = (v: unknown): v is Ref => typeof v === 'object' && v !== null && '__id__' in v

export interface CocosNode {
  readonly name: string
  readonly path: string
  readonly parent: CocosNode | null
  readonly children: CocosNode[]
  readonly active: boolean
  readonly position: { x: number; y: number }
  readonly rotation: number
  readonly scale: { x: number; y: number }
  readonly sprite: { spriteFrame: string; color: [number, number, number, number]; srcBlend: number; dstBlend: number } | null
  readonly transform: { width: number; height: number; anchorX: number; anchorY: number } | null
  readonly sortingOrder: number | null
  /** 树顺序(深度优先) */
  readonly order: number
}

interface ClipTrack {
  readonly nodePath: string
  readonly component: string | null
  readonly property: string
  readonly kind: 'vector' | 'real' | 'object' | 'color'
  readonly channels: readonly (readonly RealKey[])[]
  readonly objectTimes: readonly number[]
  readonly objectValues: readonly unknown[]
}

export interface CocosClip {
  readonly name: string
  readonly duration: number
  readonly tracks: readonly ClipTrack[]
}

export interface DrawnSprite {
  readonly node: CocosNode
  /** 世界坐标的四角:左下、右下、右上、左上 */
  readonly corners: { x: number; y: number }[]
  readonly spriteFrame: string
  readonly color: [number, number, number, number]
  readonly sortingOrder: number
}

export interface CocosScene {
  readonly root: CocosNode
  readonly nodes: readonly CocosNode[]
  readonly clips: ReadonlyMap<string, CocosClip>
  /** 该时刻画出来的 Sprite,按先后 */
  drawnAt(clip: string | null, t: number): DrawnSprite[]
  /** 节点路径 → 世界矩阵 */
  worldAt(clip: string | null, t: number): Map<string, Affine>
  /** 一条轨道指向的节点 / 组件存不存在 */
  resolveTrack(track: ClipTrack): CocosNode | null
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' ? v : fallback
}

export function parsePrefab(text: string): { root: CocosNode; nodes: CocosNode[] } {
  const objects = JSON.parse(text) as Json[]
  const prefab = objects[0]!
  if (prefab['__type__'] !== 'cc.Prefab') throw new Error('不是 prefab')
  const nodes: CocosNode[] = []
  let order = 0
  const build = (index: number, parent: CocosNode | null): CocosNode => {
    const o = objects[index]!
    if (o['__type__'] !== 'cc.Node') throw new Error(`第 ${index} 项不是节点`)
    const name = String(o['_name'])
    const path = parent === null ? '' : parent.path === '' ? name : `${parent.path}/${name}`
    const lpos = o['_lpos'] as Json
    const euler = o['_euler'] as Json
    const lscale = o['_lscale'] as Json
    let sprite: CocosNode['sprite'] = null
    let transform: CocosNode['transform'] = null
    let sortingOrder: number | null = null
    for (const ref of o['_components'] as Ref[]) {
      const c = objects[ref.__id__]!
      switch (c['__type__']) {
        case 'cc.Sprite': {
          const color = c['_color'] as Json
          sprite = { spriteFrame: String((c['_spriteFrame'] as { __uuid__: string })['__uuid__']), color: [num(color['r']), num(color['g']), num(color['b']), num(color['a'], 255)], srcBlend: num(c['_srcBlendFactor']), dstBlend: num(c['_dstBlendFactor']) }
          break
        }
        case 'cc.UITransform': {
          const size = c['_contentSize'] as Json
          const anchor = c['_anchorPoint'] as Json
          transform = { width: num(size['width']), height: num(size['height']), anchorX: num(anchor['x']), anchorY: num(anchor['y']) }
          break
        }
        case 'cc.Sorting2D':
          sortingOrder = num(c['_sortingOrder'])
          break
      }
    }
    const node: CocosNode = {
      name, path, parent, children: [], active: o['_active'] !== false,
      position: { x: num(lpos['x']), y: num(lpos['y']) }, rotation: num(euler['z']), scale: { x: num(lscale['x'], 1), y: num(lscale['y'], 1) },
      sprite, transform, sortingOrder, order: order++,
    }
    nodes.push(node)
    for (const ref of o['_children'] as Ref[]) node.children.push(build(ref.__id__, node))
    return node
  }
  const root = build((prefab['data'] as Ref).__id__, null)
  return { root, nodes }
}

export function parseClip(text: string): CocosClip {
  const objects = JSON.parse(text) as Json[]
  const clip = objects[0]!
  if (clip['__type__'] !== 'cc.AnimationClip') throw new Error('不是 AnimationClip')
  const resolve = (v: unknown): Json => (isRef(v) ? objects[v.__id__]! : (v as Json))
  const tracks: ClipTrack[] = []
  for (const ref of clip['_tracks'] as Ref[]) {
    const t = resolve(ref)
    const binding = resolve(t['_binding'])
    const paths = (resolve(binding['path'])['_paths'] as unknown[]).map(resolve)
    let nodePath = ''
    let component: string | null = null
    let property = ''
    for (const p of paths) {
      if (typeof p === 'string') property = p
      else if ((p as Json)['__type__'] === 'cc.animation.HierarchyPath') nodePath = String((p as Json)['path'])
      else if ((p as Json)['__type__'] === 'cc.animation.ComponentPath') component = String((p as Json)['component'])
    }
    const curveOf = (ch: unknown) => parseRealCurve(resolve(resolve(ch)['_curve']))
    const type = String(t['__type__'])
    if (type === 'cc.animation.VectorTrack' || type === 'cc.animation.ColorTrack') {
      tracks.push({ nodePath, component, property, kind: type === 'cc.animation.VectorTrack' ? 'vector' : 'color', channels: (t['_channels'] as unknown[]).map(curveOf), objectTimes: [], objectValues: [] })
    } else if (type === 'cc.animation.RealTrack') {
      tracks.push({ nodePath, component, property, kind: 'real', channels: [curveOf(t['_channel'])], objectTimes: [], objectValues: [] })
    } else if (type === 'cc.animation.ObjectTrack') {
      const curve = resolve(resolve(t['_channel'])['_curve'])
      tracks.push({ nodePath, component, property, kind: 'object', channels: [], objectTimes: curve['_times'] as number[], objectValues: curve['_values'] as unknown[] })
    } else throw new Error(`不认识的轨道类型 ${type}`)
  }
  return { name: String(clip['_name']), duration: num(clip['_duration']), tracks }
}

/** ObjectCurve:保持前值;第一键之前取第一键 */
function objectAt(times: readonly number[], values: readonly unknown[], t: number): unknown {
  let v = values[0]
  for (let i = 0; i < times.length; i++) {
    if (times[i]! > t + 1e-6) break
    v = values[i]
  }
  return v
}

const DEG = Math.PI / 180

export function loadCocosScene(files: ReadonlyMap<string, string | Uint8Array>, prefabPath: string): CocosScene {
  const text = (p: string) => { const c = files.get(p); if (c === undefined) throw new Error(`没有 ${p}`); return typeof c === 'string' ? c : new TextDecoder().decode(c) }
  const { root, nodes } = parsePrefab(text(prefabPath))
  const byPath = new Map(nodes.map((n) => [n.path, n]))
  const clips = new Map<string, CocosClip>()
  for (const [p] of files) if (p.endsWith('.anim')) { const c = parseClip(text(p)); clips.set(c.name, c) }

  interface Override { position?: { x?: number; y?: number }; rotation?: number; scale?: { x?: number; y?: number }; active?: boolean; sortingOrder?: number; color?: [number, number, number, number]; spriteFrame?: string }
  const overrides = (clipName: string | null, t: number): Map<string, Override> => {
    const out = new Map<string, Override>()
    if (clipName === null) return out
    const clip = clips.get(clipName)
    if (clip === undefined) throw new Error(`没有动画 ${clipName}`)
    for (const tr of clip.tracks) {
      const node = byPath.get(tr.nodePath)
      if (node === undefined) continue
      const o = out.get(node.path) ?? {}
      out.set(node.path, o)
      const ch = (i: number) => (tr.channels[i]!.length === 0 ? undefined : evaluateRealCurve(tr.channels[i]!, t))
      if (tr.kind === 'vector' && tr.component === null) {
        if (tr.property === 'position') o.position = { ...(ch(0) === undefined ? {} : { x: ch(0)! }), ...(ch(1) === undefined ? {} : { y: ch(1)! }) }
        else if (tr.property === 'scale') o.scale = { ...(ch(0) === undefined ? {} : { x: ch(0)! }), ...(ch(1) === undefined ? {} : { y: ch(1)! }) }
        else if (tr.property === 'eulerAngles') { const z = ch(2); if (z !== undefined) o.rotation = z }
      } else if (tr.kind === 'object' && tr.component === null && tr.property === 'active') {
        o.active = objectAt(tr.objectTimes, tr.objectValues, t) as boolean
      } else if (tr.kind === 'object' && tr.component === 'cc.Sprite' && tr.property === 'spriteFrame') {
        o.spriteFrame = String((objectAt(tr.objectTimes, tr.objectValues, t) as { __uuid__: string })['__uuid__'])
      } else if (tr.kind === 'real' && tr.component === 'cc.Sorting2D' && tr.property === 'sortingOrder') {
        o.sortingOrder = evaluateRealCurve(tr.channels[0]!, t)
      } else if (tr.kind === 'color' && tr.component === 'cc.Sprite' && tr.property === 'color') {
        const base = node.sprite?.color ?? [255, 255, 255, 255]
        o.color = [ch(0) ?? base[0], ch(1) ?? base[1], ch(2) ?? base[2], ch(3) ?? base[3]]
      }
    }
    return out
  }

  const worldAt = (clip: string | null, t: number): Map<string, Affine> => {
    const ov = overrides(clip, t)
    const world = new Map<string, Affine>()
    const visit = (n: CocosNode, parent: Affine | null) => {
      const o = ov.get(n.path)
      const x = o?.position?.x ?? n.position.x
      const y = o?.position?.y ?? n.position.y
      const rot = o?.rotation ?? n.rotation
      const sx = o?.scale?.x ?? n.scale.x
      const sy = o?.scale?.y ?? n.scale.y
      const cos = Math.cos(DEG * rot)
      const sin = Math.sin(DEG * rot)
      const local: Affine = { a: cos * sx, b: -sin * sy, c: sin * sx, d: cos * sy, x, y }
      const m: Affine = parent === null ? local : {
        a: parent.a * local.a + parent.b * local.c, b: parent.a * local.b + parent.b * local.d,
        c: parent.c * local.a + parent.d * local.c, d: parent.c * local.b + parent.d * local.d,
        x: parent.a * local.x + parent.b * local.y + parent.x, y: parent.c * local.x + parent.d * local.y + parent.y,
      }
      world.set(n.path, m)
      for (const c of n.children) visit(c, m)
    }
    visit(root, null)
    return world
  }

  const drawnAt = (clip: string | null, t: number): DrawnSprite[] => {
    const ov = overrides(clip, t)
    const world = worldAt(clip, t)
    const out: DrawnSprite[] = []
    const visit = (n: CocosNode) => {
      const active = ov.get(n.path)?.active ?? n.active
      if (!active) return
      if (n.sprite !== null && n.transform !== null) {
        const m = world.get(n.path)!
        const { width: w, height: h, anchorX: ax, anchorY: ay } = n.transform
        const l = -ax * w, r = (1 - ax) * w, b = -ay * h, tp = (1 - ay) * h
        const o = ov.get(n.path)
        out.push({
          node: n,
          corners: [[l, b], [r, b], [r, tp], [l, tp]].map(([px, py]) => ({ x: m.a * px! + m.b * py! + m.x, y: m.c * px! + m.d * py! + m.y })),
          spriteFrame: o?.spriteFrame ?? n.sprite.spriteFrame,
          color: o?.color ?? n.sprite.color,
          sortingOrder: o?.sortingOrder ?? n.sortingOrder ?? 0,
        })
      }
      for (const c of n.children) visit(c)
    }
    visit(root)
    return out.sort((p, q) => p.sortingOrder - q.sortingOrder || p.node.order - q.node.order)
  }

  const resolveTrack = (track: ClipTrack): CocosNode | null => {
    const n = byPath.get(track.nodePath)
    if (n === undefined) return null
    if (track.component === 'cc.Sprite' && n.sprite === null) return null
    if (track.component === 'cc.Sorting2D' && n.sortingOrder === null) return null
    return n
  }

  return { root, nodes, clips, drawnAt, worldAt, resolveTrack }
}
