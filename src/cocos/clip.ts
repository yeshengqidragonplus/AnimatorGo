import { Doc, r, type Json } from './json.ts'
import { realCurveJson, type RealKey } from './curve.ts'

/**
 * `cc.AnimationClip`(3.x 的 `_tracks` 写法)。
 *
 * 轨道的目标用 `TrackPath` 描述:`HierarchyPath` 从挂 `cc.Animation` 的节点往下找子节点(路径用 `/`),
 * `ComponentPath` 取节点上的组件,最后一段字符串是属性名。节点自己的 `position` / `eulerAngles` / `scale`
 * 用 VectorTrack(四个分量各一条 RealCurve,没动的分量留空,引擎会保留原值);`active` 这种离散的
 * 用 ObjectTrack(值序列,保持到下一键);`cc.Sorting2D.sortingOrder` 这种数值用 RealTrack;
 * `cc.Sprite.color` 用 ColorTrack(r g b a 四条,0..255);脚本组件的 `number[]` 属性(deform 的 shape 权重)用 RealArrayTrack。
 *
 * 都是实测过的(2026-11-03 的探针工程):位移 / 旋转 / 缩放、换图(spriteFrame)、active、
 * sortingOrder 阶梯、不透明度,全部能被 `.anim` 驱动。
 */

export type PathStep = { readonly node: string } | { readonly component: string } | string

export type Track =
  | { readonly kind: 'vector'; readonly path: readonly PathStep[]; readonly components: 2 | 3; readonly channels: readonly (readonly RealKey[] | null)[] }
  | { readonly kind: 'real'; readonly path: readonly PathStep[]; readonly keys: readonly RealKey[] }
  | { readonly kind: 'object'; readonly path: readonly PathStep[]; readonly times: readonly number[]; readonly values: readonly unknown[] }
  | { readonly kind: 'color'; readonly path: readonly PathStep[]; readonly channels: readonly (readonly RealKey[])[] }
  /** 数值数组属性(AnimatorGoMesh.shapeWeights):每个元素一条 RealCurve,求值结果是一个 number[] 整个赋给属性 */
  | { readonly kind: 'realArray'; readonly path: readonly PathStep[]; readonly channels: readonly (readonly RealKey[])[] }

/** AnimationClip.WrapMode */
export const WRAP_NORMAL = 1
export const WRAP_LOOP = 2

export interface ClipSpec {
  readonly name: string
  readonly duration: number
  readonly loop: boolean
  readonly tracks: readonly Track[]
}

function binding(path: readonly PathStep[], proxy: Json | null = null): Json {
  const paths = path.map((p) => {
    if (typeof p === 'string') return p
    if ('node' in p) return { __type__: 'cc.animation.HierarchyPath', path: p.node }
    return { __type__: 'cc.animation.ComponentPath', component: p.component }
  })
  return { __type__: 'cc.animation.TrackBinding', path: { __type__: 'cc.animation.TrackPath', _paths: paths }, proxy }
}

const channel = (keys: readonly RealKey[] | null): Json => ({ __type__: 'cc.animation.Channel', _curve: realCurveJson(keys ?? []) })

function trackJson(t: Track): Json {
  switch (t.kind) {
    case 'vector':
      return {
        __type__: 'cc.animation.VectorTrack',
        _binding: binding(t.path),
        _channels: [0, 1, 2, 3].map((i) => channel(t.channels[i] ?? null)),
        _nComponents: t.components,
      }
    case 'real':
      return { __type__: 'cc.animation.RealTrack', _binding: binding(t.path), _channel: channel(t.keys) }
    case 'object':
      return {
        __type__: 'cc.animation.ObjectTrack',
        _binding: binding(t.path),
        _channel: { __type__: 'cc.animation.Channel', _curve: { __type__: 'cc.ObjectCurve', _times: t.times.map(r), _values: [...t.values] } },
      }
    case 'color':
      return { __type__: 'cc.animation.ColorTrack', _binding: binding(t.path), _channels: t.channels.map((c) => channel(c)) }
    case 'realArray':
      return { __type__: 'cc.animation.RealArrayTrack', _binding: binding(t.path), _channels: t.channels.map((c) => channel(c)) }
  }
}

export function clipJson(spec: ClipSpec): string {
  const doc = new Doc()
  const root = doc.add({
    __type__: 'cc.AnimationClip',
    _name: spec.name,
    _objFlags: 0,
    __editorExtras__: {},
    _native: '',
    sample: 60,
    speed: 1,
    wrapMode: spec.loop ? WRAP_LOOP : WRAP_NORMAL,
    enableTrsBlending: false,
    _duration: r(spec.duration),
    _hash: 0,
    _tracks: [] as Json[],
    _exoticAnimation: null,
    _events: [],
    _embeddedPlayers: [],
    _additiveSettings: null,
    _auxiliaryCurveEntries: [],
  })
  for (const t of spec.tracks) (doc.objects[root]!['_tracks'] as Json[]).push(doc.ref(doc.add(trackJson(t))))
  doc.objects[root]!['_additiveSettings'] = doc.ref(doc.add({ __type__: 'cc.AnimationClipAdditiveSettings', enabled: false, refClip: null }))
  return doc.text()
}

/** 路径的字符串形式(测试、报告用):`bone/child:cc.Sprite.color` */
export function describePath(path: readonly PathStep[]): string {
  return path.map((p) => (typeof p === 'string' ? p : 'node' in p ? p.node : p.component)).join('.')
}
