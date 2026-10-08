import { parseMesh } from '../../unity/writeMesh.ts'
import { SPRITE_SKIN_SCRIPT_GUID } from '../../unity/writePrefab.ts'
import { list, map, num, parseUnityYaml, parseYamlDocument, ref, str, vec, type UnityObject, type YamlMap, type YamlValue } from '../../unity/yaml.ts'

/**
 * **按 Unity 的规则**算我们导出的 Unity 产物在某一时刻的顶点 —— Unity 读取器验收用的独立参照物。
 *
 * 与读取器(readUnity.ts)走不同的路:曲线用标准三次 Hermite 直接求值(读取器是转成贝塞尔);
 * 顶点正向蒙皮(读取器是反解到骨骼局部)。两边按各自的规则算出同一个点,读取器才算对。
 *
 * ```
 * 节点世界矩阵 = 父 · T · R(z) · S          ← prefab 的 TRS,被 .anim 的曲线覆盖
 * SpriteRenderer:  世界 · (顶点 − pivot·尺寸) / ppu
 * SpriteSkin:      Σ w · 骨骼世界 · 绑定⁻¹ · (顶点 − pivot·尺寸) / ppu     (根骨骼减 pivot,子骨骼不减)
 * SkinnedMesh:     Σ w · 骨骼世界 · bindpose · (顶点 + Σ 权重/100 · Δ)     (加完再蒙皮)
 * ```
 *
 * 只认带权切线为 0 的曲线(我们导出的都是);坐标是 Unity 单位、相对根物体。
 */

type Affine = { a: number; b: number; c: number; d: number; x: number; y: number }
const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 }
const DEG = Math.PI / 180
const mul = (p: Affine, q: Affine): Affine => ({
  a: p.a * q.a + p.b * q.c, b: p.a * q.b + p.b * q.d,
  c: p.c * q.a + p.d * q.c, d: p.c * q.b + p.d * q.d,
  x: p.a * q.x + p.b * q.y + p.x, y: p.c * q.x + p.d * q.y + p.y,
})
const inverse = (m: Affine): Affine => {
  const det = m.a * m.d - m.b * m.c
  const a = m.d / det, b = -m.b / det, c = -m.c / det, d = m.a / det
  return { a, b, c, d, x: -(a * m.x + b * m.y), y: -(c * m.x + d * m.y) }
}
const apply = (m: Affine, x: number, y: number) => ({ x: m.a * x + m.b * y + m.x, y: m.c * x + m.d * y + m.y })
const trs = (x: number, y: number, deg: number, sx: number, sy: number): Affine => {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG)
  return { a: c * sx, b: -s * sy, c: s * sx, d: c * sy, x, y }
}
const zDeg = (q: { z: number; w: number }) => (2 * Math.atan2(q.z, q.w)) / DEG
const numInf = (v: YamlValue | undefined) => { const n = Number(str(v)); return Number.isNaN(n) ? 0 : n }

interface Key { t: number; v: number; in: number; out: number; mode: number; wIn: number; wOut: number }

function keys(curve: YamlValue | undefined, component?: 'x' | 'y' | 'z'): Key[] {
  return list(map(curve)['m_Curve']).map((k) => {
    const m = map(k)
    const pick = (v: YamlValue | undefined) => (component === undefined ? numInf(v) : numInf(map(v)[component]))
    const weight = (v: YamlValue | undefined) => {
      const raw = component === undefined ? str(v) : str(map(v)[component])
      return raw === '' ? 1 / 3 : numInf(raw)
    }
    return { t: numInf(m['time']), v: pick(m['value']), in: pick(m['inSlope']), out: pick(m['outSlope']), mode: numInf(m['weightedMode']), wIn: weight(m['inWeight']), wOut: weight(m['outWeight']) }
  })
}

/**
 * Unity 的曲线求值。两端都不带权:标准三次 Hermite;带权(weightedMode 位 1 = 入、位 2 = 出):
 * 一段贝塞尔,控制点 (t0 + w_out·Δt, v0 + m0·w_out·Δt)、(t1 − w_in·Δt, v1 − m1·w_in·Δt),解 x(s) = t。
 * 斜率无穷大是阶梯;两端之外保持端点值。
 */
export function hermiteAt(ks: readonly Key[], t: number): number {
  if (ks.length === 0) return 0
  if (t <= ks[0]!.t) return ks[0]!.v
  for (let i = 0; i + 1 < ks.length; i++) {
    const a = ks[i]!, b = ks[i + 1]!
    if (t >= b.t) continue
    if (!Number.isFinite(a.out) || !Number.isFinite(b.in)) return a.v
    const dt = b.t - a.t
    const outW = (a.mode & 2) !== 0, inW = (b.mode & 1) !== 0
    if (!outW && !inW) {
      const s = (t - a.t) / dt
      const s2 = s * s, s3 = s2 * s
      return (2 * s3 - 3 * s2 + 1) * a.v + (s3 - 2 * s2 + s) * dt * a.out + (-2 * s3 + 3 * s2) * b.v + (s3 - s2) * dt * b.in
    }
    const w1 = outW ? a.wOut : 1 / 3
    const w2 = inW ? b.wIn : 1 / 3
    const x = [a.t, a.t + w1 * dt, b.t - w2 * dt, b.t]
    const y = [a.v, a.v + a.out * w1 * dt, b.v - b.in * w2 * dt, b.v]
    const bez = (p: number[], u: number) => { const q = 1 - u; return q * q * q * p[0]! + 3 * q * q * u * p[1]! + 3 * q * u * u * p[2]! + u * u * u * p[3]! }
    let lo = 0, hi = 1
    for (let n = 0; n < 60; n++) { const mid = (lo + hi) / 2; if (bez(x, mid) < t) lo = mid; else hi = mid }
    return bez(y, (lo + hi) / 2)
  }
  return ks[ks.length - 1]!.v
}

interface Node { id: string; name: string; parent: string | null; go: UnityObject; t: UnityObject; comps: UnityObject[]; path: string }

export interface UnityScene {
  /** 节点路径(相对根物体)→ 该时刻的顶点(Unity 单位,相对根物体) */
  verticesAt(clip: string | null, t: number): Map<string, { x: number; y: number }[]>
  /** 节点路径 → 该时刻的 m_Color(没有颜色曲线就是 prefab 里的) */
  colorAt(clip: string | null, t: number): Map<string, [number, number, number, number]>
  readonly clips: readonly string[]
}

export function loadUnityScene(files: ReadonlyMap<string, string | Uint8Array>): UnityScene {
  const text = (p: string) => { const c = files.get(p)!; return typeof c === 'string' ? c : new TextDecoder().decode(c) }
  const pathOfGuid = new Map<string, string>()
  for (const [p] of files) if (p.endsWith('.meta')) pathOfGuid.set(str(parseYamlDocument(text(p))['guid']), p.slice(0, -5))
  // 解析结果按文件缓存:每个时刻、每个节点都要用
  const metaCache = new Map<string, YamlMap>()
  const metaOf = (path: string) => { let m = metaCache.get(path); if (m === undefined) { m = map(parseYamlDocument(text(`${path}.meta`))['TextureImporter']); metaCache.set(path, m) } return m }
  const meshCache = new Map<string, ReturnType<typeof parseMesh>>()
  const meshOf = (path: string) => { let m = meshCache.get(path); if (m === undefined) { m = parseMesh(text(path)); meshCache.set(path, m) } return m }
  const objects = parseUnityYaml(text([...files.keys()].find((p) => p.endsWith('.prefab'))!))
  const byId = new Map(objects.map((o) => [o.fileID, o]))
  const nodes = new Map<string, Node>()
  for (const o of objects) {
    if (o.type !== 'Transform') continue
    const go = byId.get(ref(o.data['m_GameObject']).fileID)!
    const f = ref(o.data['m_Father']).fileID
    nodes.set(o.fileID, { id: o.fileID, name: str(go.data['m_Name']), parent: f === '0' ? null : f, go, t: o, comps: list(go.data['m_Component']).map((c) => byId.get(ref(map(c)['component']).fileID)!).filter(Boolean), path: '' })
  }
  const root = [...nodes.values()].find((n) => n.parent === null)!
  const setPath = (n: Node, p: string) => {
    n.path = p
    for (const c of list(n.t.data['m_Children'])) { const ch = nodes.get(ref(c).fileID); if (ch) setPath(ch, p === '' ? ch.name : `${p}/${ch.name}`) }
  }
  setPath(root, '')

  const clips = new Map<string, YamlMap>()
  for (const [p] of files) {
    if (!p.endsWith('.anim')) continue
    const clip = parseUnityYaml(text(p)).find((o) => o.type === 'AnimationClip')
    if (clip !== undefined) clips.set(str(clip.data['m_Name']), clip.data)
  }

  /** 每个 clip 的曲线预先拆成关键帧数组:(路径, 属性, 关键帧) */
  const parsedClips = new Map<string, { path: string; attr: string; keys: Key[] }[]>()
  const curvesOf = (clip: string) => {
    const hit = parsedClips.get(clip)
    if (hit !== undefined) return hit
    const data = clips.get(clip)!
    const out: { path: string; attr: string; keys: Key[] }[] = []
    for (const [field, attr] of [['m_PositionCurves', 'pos'], ['m_EulerCurves', 'euler'], ['m_ScaleCurves', 'scale']] as const) {
      for (const e of list(data[field]).map(map)) {
        for (const c of ['x', 'y', 'z'] as const) out.push({ path: str(e['path']), attr: `${attr}.${c}`, keys: keys(e['curve'], c) })
      }
    }
    for (const e of list(data['m_FloatCurves']).map(map)) out.push({ path: str(e['path']), attr: str(e['attribute']), keys: keys(e['curve']) })
    parsedClips.set(clip, out)
    return out
  }

  /** 该时刻各节点被曲线覆盖的属性:路径 → 属性 → 值 */
  const override = (clip: string | null, t: number): Map<string, Map<string, number>> => {
    const out = new Map<string, Map<string, number>>()
    if (clip === null) return out
    for (const c of curvesOf(clip)) {
      const m = out.get(c.path) ?? new Map<string, number>()
      out.set(c.path, m)
      m.set(c.attr, hermiteAt(c.keys, t))
    }
    return out
  }

  const worldAt = (ov: Map<string, Map<string, number>>) => {
    const cache = new Map<string, Affine>()
    const world = (n: Node): Affine => {
      if (n === root) return IDENTITY
      const hit = cache.get(n.id)
      if (hit) return hit
      const o = ov.get(n.path)
      const p = vec(n.t.data['m_LocalPosition']), s = vec(n.t.data['m_LocalScale'])
      const q = vec(n.t.data['m_LocalRotation'])
      const local = trs(o?.get('pos.x') ?? p.x, o?.get('pos.y') ?? p.y, o?.get('euler.z') ?? zDeg(q), o?.get('scale.x') ?? s.x, o?.get('scale.y') ?? s.y)
      const w = mul(world(nodes.get(n.parent!)!), local)
      cache.set(n.id, w)
      return w
    }
    return world
  }

  const verticesAt = (clip: string | null, t: number) => {
    const ov = override(clip, t)
    const world = worldAt(ov)
    const out = new Map<string, { x: number; y: number }[]>()
    for (const n of nodes.values()) {
      const sr = n.comps.find((c) => c.type === 'SpriteRenderer')
      const smr = n.comps.find((c) => c.type === 'SkinnedMeshRenderer')
      if (sr !== undefined) {
        const sref = ref(sr.data['m_Sprite'])
        const texPath = pathOfGuid.get(sref.guid ?? '')
        if (texPath === undefined) continue
        const meta = metaOf(texPath)
        const ppu = num(meta['spritePixelsToUnits'], 100)
        const sprite = list(map(meta['spriteSheet'])['sprites']).map(map).find((s) => str(s['internalID']) === sref.fileID)!
        const rect = map(sprite['rect']), pivot = map(sprite['pivot'])
        const px = num(pivot['x']) * num(rect['width']), py = num(pivot['y']) * num(rect['height'])
        const local = list(sprite['vertices']).map((v) => ({ x: (num(map(v)['x']) - px) / ppu, y: (num(map(v)['y']) - py) / ppu }))
        const skin = n.comps.find((c) => c.type === 'MonoBehaviour' && ref(c.data['m_Script']).guid === SPRITE_SKIN_SCRIPT_GUID)
        if (skin === undefined) {
          const w = world(n)
          out.set(n.path, local.map((v) => apply(w, v.x, v.y)))
          continue
        }
        const binds: Affine[] = []
        list(sprite['bones']).map(map).forEach((b, i) => {
          const pos = map(b['position'])
          const parent = num(b['parentId'], -1)
          const isRoot = parent < 0
          const m = trs((num(pos['x']) - (isRoot ? px : 0)) / ppu, (num(pos['y']) - (isRoot ? py : 0)) / ppu, zDeg(vec(b['rotation'])), 1, 1)
          binds[i] = isRoot ? m : mul(binds[parent]!, m)
        })
        const bones = list(skin.data['m_BoneTransforms']).map((b) => nodes.get(ref(b).fileID)!)
        const weights = list(sprite['weights']).map(map)
        out.set(n.path, local.map((v, i) => {
          let x = 0, y = 0
          for (let k = 0; k < 4; k++) {
            const w = num(weights[i]![`weight[${k}]`])
            if (w <= 0) continue
            const bi = num(weights[i]![`boneIndex[${k}]`])
            const p = apply(mul(world(bones[bi]!), inverse(binds[bi]!)), v.x, v.y)
            x += p.x * w
            y += p.y * w
          }
          return { x, y }
        }))
      } else if (smr !== undefined) {
        const mesh = meshOf(pathOfGuid.get(ref(smr.data['m_Mesh']).guid ?? '')!)
        const bones = list(smr.data['m_Bones']).map((b) => nodes.get(ref(b).fileID)!)
        const o = ov.get(n.path)
        const delta = mesh.positions.map(() => ({ x: 0, y: 0 }))
        for (const s of mesh.blendShapes) {
          const w = (o?.get(`blendShape.${s.name}`) ?? 0) / 100
          for (const d of s.deltas) { delta[d.index]!.x += d.x * w; delta[d.index]!.y += d.y * w }
        }
        const weights = mesh.fullWeights.length === mesh.vertexCount ? mesh.fullWeights : mesh.streamWeights
        out.set(n.path, mesh.positions.map((p, i) => {
          let x = 0, y = 0
          for (const w of weights[i]!) {
            if (w.weight <= 0) continue
            const q = apply(mul(world(bones[w.bone]!), mesh.bindposes[w.bone]!), p.x + delta[i]!.x, p.y + delta[i]!.y)
            x += q.x * w.weight
            y += q.y * w.weight
          }
          return { x, y }
        }))
      }
    }
    return out
  }

  const colorAt = (clip: string | null, t: number) => {
    const ov = override(clip, t)
    const out = new Map<string, [number, number, number, number]>()
    for (const n of nodes.values()) {
      const sr = n.comps.find((c) => c.type === 'SpriteRenderer')
      if (sr === undefined) continue
      const c = map(sr.data['m_Color'])
      const o = ov.get(n.path)
      out.set(n.path, [o?.get('m_Color.r') ?? num(c['r'], 1), o?.get('m_Color.g') ?? num(c['g'], 1), o?.get('m_Color.b') ?? num(c['b'], 1), o?.get('m_Color.a') ?? num(c['a'], 1)])
    }
    return out
  }

  return { verticesAt, colorAt, clips: [...clips.keys()] }
}
