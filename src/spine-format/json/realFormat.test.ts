import { describe, expect, it } from 'vitest'
import { fromJsonText } from './fromJson.ts'
import { toJson } from './toJson.ts'
import { readSkeletonPart } from '../binary/readSkeleton.ts'
import { writeSkeleton } from '../binary/writeSkeleton.ts'
import { convertSkeleton } from '../../spine-convert/skel/convert.ts'

/**
 * 真实 Spine 导出的 JSON 写法 —— 片段的形状取自真实文件,不是凭文档写的:
 *
 * - 4.1 的 attachment 时间轴、曲线、序列帧:Spine 官方示例 goblins.json / dragon.json(spine-unity 自带)
 * - 4.1 的约束 mix、path 时间轴、隐藏帧、事件:官方示例 spineboy-pro / spineboy-unity / mix-and-match-pro / goblins
 * - 3.8 的曲线:BloomMatch1 里的 3.8.99 导出(`"curve":0.25,"c3":0.75`)
 * - 3.8 的约束 mix、path 时间轴、隐藏帧:手头的 3.8 导出里没有,按 spine-csharp 3.8 SkeletonJson 的读法写
 *
 * 此前的 JSON 测试只做「我们写 → 我们读」的自洽往返,三处写法错误(4.x 少一层 deform、
 * 4.x 曲线、3.8 曲线)全都过得去 —— 这里的每条都要求**与真实文件逐项相等**。
 */

const skeleton4 = (animations: Record<string, unknown>) =>
  JSON.stringify({
    skeleton: { hash: 'x', spine: '4.1.23', x: 0, y: 0, width: 10, height: 10 },
    bones: [{ name: 'root' }],
    slots: [
      { name: 'wing', bone: 'root', attachment: 'wing' },
      { name: 'cape', bone: 'root', attachment: 'cape' },
    ],
    skins: [
      {
        name: 'default',
        attachments: {
          wing: { wing: { width: 264, height: 589, sequence: { count: 9, digits: 2 } } },
          cape: { cape: { type: 'mesh', uvs: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2], vertices: [0, 0, 10, 0, 0, 10], hull: 3 } },
        },
      },
    ],
    animations,
  })

describe('4.1 JSON', () => {
  // dragon.json 的 flying:第二帧省略了 delay(沿用 0.0667)和 mode(hold)
  const flying = {
    attachments: {
      default: {
        wing: {
          wing: {
            sequence: [
              { mode: 'loop', delay: 0.0667 },
              { time: 0.6 },
              { time: 0.7333, mode: 'loop', index: 1 },
              { time: 0.8, mode: 'loop', index: 2, delay: 0.0333 },
              { time: 0.9667, index: 7 },
            ],
          },
        },
        // goblins.json 的 dagger:deform 在 attachment 下面还有一层 "deform"
        cape: { cape: { deform: [{ offset: 2, vertices: [1, 2], curve: [0.125, 0, 0.375, 1] }, { time: 0.5 }] } },
      },
    },
    bones: { root: { rotate: [{ value: 10, curve: [0.25, 10, 0.75, 20] }, { time: 1, value: 20 }] } },
  }

  it('sequence 的 delay 缺省沿用上一帧,mode 缺省 hold', () => {
    const part = fromJsonText(skeleton4({ flying }))
    const t = part.animations[0]!.timelines.find((x) => x.kind === 'sequence')!
    const keys = (t.frames[0] as { frames: Record<string, unknown>[] }).frames
    expect(keys.map((k) => k['delay'])).toEqual([0.0667, 0.0667, 0.0667, 0.0333, 0.0333])
    expect(keys.map((k) => k['mode'])).toEqual(['loop', 'hold', 'loop', 'loop', 'hold'])
    expect(part.skins[0]!.slots.find((e) => e.slot === 0)!.attachments[0]!.sequence).toEqual({ count: 9, start: 1, digits: 2, setupIndex: 0 })
  })

  it('曲线是 "curve": [cx1, cy1, cx2, cy2],每个分量 4 个', () => {
    const part = fromJsonText(skeleton4({ flying }))
    const rotate = part.animations[0]!.timelines.find((x) => x.kind === 'rotate')!
    expect(rotate.frames[0]).toMatchObject({ curve: 'bezier', beziers: [[0.25, 10, 0.75, 20]] })
  })

  it('⭐ 写回的 animations 与原文件逐项相等(attachments 多一层 deform / sequence、曲线数组、省略缺省值)', () => {
    const out = toJson(fromJsonText(skeleton4({ flying }))) as { animations: Record<string, unknown> }
    expect(out.animations['flying']).toEqual(flying)
  })

  it('sequence 时间轴能写进 .skel 再读回来(二进制:模式与帧号打包在一个 int 里)', () => {
    const part = fromJsonText(skeleton4({ flying }))
    const back = readSkeletonPart(writeSkeleton(part))
    expect(back.failure).toBeNull()
    const keysOf = (p: typeof part) =>
      (p.animations[0]!.timelines.find((x) => x.kind === 'sequence')!.frames[0] as { frames: Record<string, unknown>[] }).frames
    const a = keysOf(part)
    const b = keysOf(back)
    expect(b.map((k) => [k['mode'], k['index']])).toEqual(a.map((k) => [k['mode'], k['index']]))
    b.forEach((k, i) => {
      expect(k['time']).toBeCloseTo(a[i]!['time'] as number, 5) // .skel 里是 float32
      expect(k['delay']).toBeCloseTo(a[i]!['delay'] as number, 5)
    })
  })

  it('降级到 3.8:sequence 时间轴丢弃并报 loss,attachment 改用 setup 那一帧的图', () => {
    const part = readSkeletonPart(writeSkeleton(fromJsonText(skeleton4({ flying }))))
    const { part: down, issues } = convertSkeleton(part, '3.8')
    expect(down.animations[0]!.timelines.some((t) => t.kind === 'sequence')).toBe(false)
    expect(issues.some((i) => i.level === 'loss' && i.path.includes('sequence'))).toBe(true)

    // 写成 3.8 再读回来,区域名是 wing01 —— 不然 3.8 运行时找不到 "wing" 区域,直接加载失败
    const back = readSkeletonPart(writeSkeleton(down))
    const wing = back.skins[0]!.slots.find((e) => e.slot === 0)!.attachments[0]!
    expect(wing.sequence).toBeNull()
    expect(wing.data['path']).toBe('wing01')
  })
})

describe('4.1 JSON:约束 mix 的连锁缺省、path 时间轴、隐藏帧、事件', () => {
  // spineboy-pro 的约束定义:写了 "mixX": 0,没写 mixY —— 4.1 里 mixY 缺省 = mixX
  const transformDef = {
    name: 'aim-front-arm-transform', order: 10, bones: ['front-upper-arm'], target: 'aim-constraint-target',
    rotation: -180, mixRotate: 0, mixX: 0, mixScaleX: 0, mixShearY: 0,
  }
  // spineboy-unity 的 path 约束
  const pathDef = {
    name: 'spinning guns', order: 2, bones: ['gun'], target: 'gunspath',
    spacingMode: 'percent', spacing: 0.335, mixRotate: 0, mixX: 0,
  }
  const animations = {
    // spineboy-pro 的 aim
    aim: { transform: { 'aim-front-arm-transform': [{ mixRotate: 0.784, mixX: 0, mixScaleX: 0, mixShearY: 0 }] } },
    // mix-and-match-pro 的 dress-up(leg-down-down):大部分帧 mixX/mixY 取缺省 1,个别帧写 mixX
    'dress-up': {
      transform: {
        'aim-front-arm-transform': [
          { mixScaleX: 0, mixShearY: 0 },
          { time: 0.0667, mixX: 0, mixScaleX: 0, mixShearY: 0 },
          { time: 0.3333, mixScaleX: 0, mixShearY: 0, curve: 'stepped' },
          { time: 1.3667, mixX: 0.774, mixScaleX: 0, mixShearY: 0 },
        ],
      },
    },
    // spineboy-unity 的 gun toss:position 的值叫 value;mix 缺 mixY
    'gun toss': {
      path: {
        'spinning guns': {
          position: [{ time: 0.6667 }, { time: 1.6667, value: 2.034 }],
          mix: [
            { time: 0.6667, mixRotate: 0, mixX: 0 },
            { time: 0.7333, curve: 'stepped' },
            { time: 1.5667 },
            { time: 1.6667, mixRotate: 0, mixX: 0 },
          ],
        },
      },
    },
    // goblins 的 walk:隐藏帧不写 name
    walk: { slots: { eyes: { attachment: [{ time: 0.7, name: 'eyes-closed' }, { time: 0.8 }] } } },
    // spineboy-pro 的 run:time 为 0 的事件不写 time
    run: { events: [{ name: 'footstep' }, { time: 0.3667, name: 'footstep' }] },
  }
  const text = JSON.stringify({
    skeleton: { hash: 'x', spine: '4.1.23', x: 0, y: 0, width: 10, height: 10 },
    bones: [
      { name: 'root' },
      { name: 'front-upper-arm', parent: 'root' },
      { name: 'aim-constraint-target', parent: 'root' },
      { name: 'gun', parent: 'root' },
    ],
    slots: [{ name: 'eyes', bone: 'root' }, { name: 'gunspath', bone: 'root' }],
    transform: [transformDef],
    path: [pathDef],
    skins: [{ name: 'default', attachments: {} }],
    events: { footstep: {} },
    animations,
  })
  type Frames = Record<string, unknown>[]
  const timeline = (part: ReturnType<typeof fromJsonText>, anim: string, kind: string) =>
    part.animations.find((a) => a.name === anim)!.timelines.find((t) => t.kind === kind)!.frames as Frames

  it('transform 时间轴:mixY 缺省 = mixX,mixScaleY 缺省 = mixScaleX,其余缺省 1', () => {
    const part = fromJsonText(text)
    expect(timeline(part, 'aim', 'transform')[0]).toMatchObject({
      mixRotate: 0.784, mixX: 0, mixY: 0, mixScaleX: 0, mixScaleY: 0, mixShearY: 0,
    })
    const dress = timeline(part, 'dress-up', 'transform')
    expect(dress.map((f) => [f['mixRotate'], f['mixX'], f['mixY']])).toEqual([[1, 1, 1], [1, 0, 0], [1, 1, 1], [1, 0.774, 0.774]])
    expect(dress.every((f) => f['mixScaleY'] === 0)).toBe(true)
  })

  it('path 时间轴:mix 的 mixY 缺省 = mixX;position / spacing 的值叫 value', () => {
    const part = fromJsonText(text)
    const mix = timeline(part, 'gun toss', 'path2')
    expect(mix.map((f) => [f['mixRotate'], f['mixX'], f['mixY']])).toEqual([[0, 0, 0], [1, 1, 1], [1, 1, 1], [0, 0, 0]])
    expect(timeline(part, 'gun toss', 'path0').map((f) => f['value'])).toEqual([0, 2.034])
  })

  it('约束本身的 mix 同样连锁缺省', () => {
    const part = fromJsonText(text)
    expect(part.transform[0]).toMatchObject({ mixRotate: 0, mixX: 0, mixY: 0, mixScaleX: 0, mixScaleY: 0, mixShearY: 0 })
    expect(part.path[0]).toMatchObject({ mixRotate: 0, mixX: 0, mixY: 0 })
  })

  it('⭐ 写回的 animations 与约束定义都与原文件逐项相等', () => {
    const out = toJson(fromJsonText(text)) as Record<string, unknown>
    expect(out['animations']).toEqual(animations)
    expect(out['transform']).toEqual([transformDef])
    expect(out['path']).toEqual([pathDef])
  })

  it('连锁缺省补出来的 0 写进 .skel 再读回来还是 0', () => {
    const back = readSkeletonPart(writeSkeleton(fromJsonText(text)))
    expect(back.failure).toBeNull()
    expect(back.transform[0]).toMatchObject({ mixY: 0, mixScaleY: 0 })
    expect(back.path[0]).toMatchObject({ mixY: 0 })
    expect(timeline(back, 'aim', 'transform')[0]).toMatchObject({ mixY: 0, mixScaleY: 0 })
  })

  it('本工具早期给 4.x path 写过 `"position": 值`,读的时候仍认', () => {
    const old = JSON.parse(text)
    old.animations = { a: { path: { 'spinning guns': { position: [{ time: 1, position: 5 }] } } } }
    expect(timeline(fromJsonText(JSON.stringify(old)), 'a', 'path0')[0]!['value']).toBe(5)
  })
})

describe('3.8 JSON', () => {
  const skeleton38 = (animations: Record<string, unknown>) =>
    JSON.stringify({
      skeleton: { hash: 'x', spine: '3.8.99', width: 10, height: 10 },
      bones: [{ name: 'root' }, { name: 'a', parent: 'root' }],
      slots: [{ name: 'eyes', bone: 'root' }, { name: 'track', bone: 'root' }],
      transform: [{ name: 't', bones: ['a'], target: 'root', rotateMix: 0, translateMix: 0.5 }],
      path: [{ name: 'p', bones: ['a'], target: 'track', translateMix: 0 }],
      events: { hit: {} },
      animations,
    })

  it('约束 mix 缺省都是 1、没有连锁;path 的值键名就是时间轴名;隐藏帧照写 "name": null', () => {
    const anim = {
      slots: { eyes: { attachment: [{ time: 0.5, name: null }] } },
      transform: { t: [{ rotateMix: 0, translateMix: 0.5 }, { time: 1, scaleMix: 0 }] },
      path: { p: { position: [{ position: 3 }, { time: 1 }], mix: [{ rotateMix: 0, translateMix: 0 }, { time: 1 }] } },
      events: [{ name: 'hit' }],
    }
    const part = fromJsonText(skeleton38({ a: anim }))
    const frames = (kind: string) => part.animations[0]!.timelines.find((t) => t.kind === kind)!.frames as Record<string, unknown>[]
    expect(frames('transform').map((f) => [f['mixRotate'], f['mixTranslate'], f['mixScale'], f['mixShear']]))
      .toEqual([[0, 0.5, 1, 1], [1, 1, 0, 1]])
    expect(frames('path0').map((f) => f['value'])).toEqual([3, 0])
    expect(frames('path2').map((f) => [f['mixRotate'], f['mixTranslate']])).toEqual([[0, 0], [1, 1]])
    expect(part.transform[0]).toMatchObject({ mixRotate: 0, mixX: 0.5, mixY: 0.5, mixScaleX: 1, mixScaleY: 1 })

    // 3.8 运行时是 `valueMap["name"]` 硬取 —— 省略 name 会让 3.8 加载时抛异常
    expect((toJson(part) as { animations: Record<string, unknown> }).animations['a']).toEqual(anim)
  })

  it('曲线是 "curve": cx1, "c2": cy1, "c3": cx2, "c4": cy2,缺省 c2=0 c3=1 c4=1', () => {
    // BloomMatch1 的真实写法:{"curve":0.25,"c3":0.75}
    const anim = { bones: { root: { rotate: [{ angle: 5, curve: 0.25, c3: 0.75 }, { time: 1, angle: 9 }] } } }
    const part = fromJsonText(skeleton38({ a: anim }))
    const rotate = part.animations[0]!.timelines.find((x) => x.kind === 'rotate')!
    expect(rotate.frames[0]).toMatchObject({ curve: 'bezier', beziers: [[0.25, 0, 0.75, 1]] })
    expect((toJson(part) as { animations: Record<string, unknown> }).animations['a']).toEqual(anim)
  })
})
