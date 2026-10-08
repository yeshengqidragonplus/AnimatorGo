import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readSkeletonPart, type SkeletonPart } from '../../spine-format/binary/readSkeleton.ts'
import { fromJson } from '../../spine-format/json/fromJson.ts'
import { parseAtlas } from '../../core/atlas.ts'
import { decodePng, type Image } from '../../unity/png.ts'
import { poseAt, setupPose } from '../../spine-eval/pose.ts'
import { attachmentVertices } from '../../spine-eval/vertices.ts'
import { slotColorAt, unpackRgba } from '../../spine-eval/color.ts'
import { exportToUnity } from '../unity/export.ts'
import { importUnity } from './readUnity.ts'
import { loadUnityScene } from './unityEval.ts'

/**
 * Unity 读取器的验收。
 *
 * **精确比较的参照物是 Unity 自己的规则**(unityEval.ts:曲线用 Hermite 直接求值、顶点正向蒙皮),
 * 不是原 Spine —— 原 Spine 与 Unity 产物之间隔着 Unity 导出的各种近似(shear、非默认继承、贝塞尔退化、
 * Blend Shape 的帧间分歧、>4 根骨骼……),拿它比测的是导出器,不是读取器。读取器输出的 Spine JSON 走 fromJson
 * 进中转模型,按 Spine 的规则求值,必须与 Unity 规则算出的同一时刻逐点一致。
 *
 * 另有一条粗检:与原 Spine 比 setup,容差按 Unity 导出自己的判据 —— 挡住「读回来整个错位」这种大错。
 */

const MC2 = 'E:/UnityProject/MergeCooking2/MergeCooking2/Assets/Export/Spine/NewSpine'
const SAMPLES = [
  { label: 'MX2_cat 4.1', skel: 'res/spine/4.1/MX2_cat.skel.bytes', atlas: 'res/spine/4.1/MX2_cat.atlas.txt' },
  { label: 'MX2_cat 3.8', skel: 'res/spine/3.8/MX2_cat.skel.bytes', atlas: 'res/spine/3.8/MX2_cat.atlas.txt' },
  { label: 'customer_1(加权网格 deform)', skel: `${MC2}/Customer1/customer_1.skel.bytes`, atlas: `${MC2}/Customer1/customer_1.atlas.txt` },
  { label: 'blackrichwoman(6 套皮肤)', skel: `${MC2}/Customer11/blackrichwoman.skel.bytes`, atlas: `${MC2}/Customer11/blackrichwoman.atlas.txt` },
  { label: 'Female staff(linkedmesh)', skel: `${MC2}/Customer12/Female staff.skel.bytes`, atlas: `${MC2}/Customer12/Female staff.atlas.txt` },
  { label: 'wave(全靠 deform)', skel: `${MC2}/wave/wave.skel.bytes`, atlas: `${MC2}/wave/wave.atlas.txt` },
  { label: 'BBQ_grill(100 个 region、换图)', skel: `${MC2}/BBQ/BBQ_grill.skel.bytes`, atlas: `${MC2}/BBQ/BBQ_grill.atlas.txt` },
]
const PPU = 100

const slotIndex = (p: SkeletonPart, name: string) => p.slots.findIndex((s) => s.name === name)

/**
 * 把 Unity 产物读成 Spine,按 Spine 的规则求值,与 Unity 的规则(unityEval)在同一时刻逐点比:
 * setup、每条动画的关键帧、相邻关键帧的四分点和中点。返回比过的「节点 × 时刻」数。
 */
function compareWithUnity(files: ReadonlyMap<string, string | Uint8Array>): number {
  const imported = importUnity(files, { pixelsPerUnit: PPU })
  const back = fromJson(imported.json)
  const scene = loadUnityScene(files)
  const attachmentOf = (skin: string, slot: string, key: string) =>
    back.skins.find((s) => s.name === skin)?.slots.find((e) => e.slot === slotIndex(back, slot))?.attachments.find((a) => a.key === key)
  /** 读取器报过「段内采样成直线」的 deform:它们在段内只近似 */
  const sampled = new Set(imported.issues.filter((i) => i.message.includes('段内按 30 fps 采样')).map((i) => /deform\[(.+)\]$/.exec(i.path)?.[1]))
  let checked = 0
  const clips: (string | null)[] = [null, ...scene.clips.filter((c) => !c.includes('@skin@'))]
  for (const clip of clips) {
    const animName = clip === null ? null : clip.slice(clip.indexOf('@') + 1)
    const anim = animName === null ? null : back.animations.find((a) => a.name === animName)!
    const times = new Set<number>([0])
    if (anim !== null) {
      for (const tl of anim.timelines) {
        const frames = tl.kind === 'deform' ? (tl.frames[0] as { frames: Record<string, unknown>[] }).frames : tl.frames
        for (const f of frames) if (typeof f['time'] === 'number') times.add(f['time'] as number)
      }
    }
    const sorted = [...times].sort((a, b) => a - b)
    // 关键帧处取「刚过去 0.1 毫秒」:Unity 把时刻只存 7 位有效数字(1.0333334),读取器吸附回帧格(31/30),
    // 恰好在阶梯跳变那一瞬采样的话,两边差的那 1e-7 秒决定跳没跳 —— 那是采样点选得不好,不是谁错了
    const all = [...sorted.map((t) => t + 1e-4), ...sorted.slice(1).flatMap((t, i) => [0.25, 0.5, 0.75].map((k) => sorted[i]! + (t - sorted[i]!) * k))].sort((x, y) => x - y)
    // 关键帧多的骨架(Female staff 184 根骨骼)采样点上千个,均匀抽 80 个就够看出问题
    const step = Math.max(1, Math.ceil(all.length / 80))
    const probes = all.filter((_, i) => i % step === 0)
    for (const t of probes) {
      const unityVerts = scene.verticesAt(clip, t)
      const pose = anim === null ? setupPose(back) : poseAt(back, anim, t)
      for (const n of imported.nodes) {
        const att = attachmentOf(n.skin, n.slot, n.key)!
        const expected = unityVerts.get(n.path)
        if (expected === undefined) continue
        const got = attachmentVertices(back, imported.atlas, att, n.skin, slotIndex(back, n.slot), pose, anim, t)
        expect(got.length, n.path).toBe(expected.length)
        const tolerance = sampled.has(n.key) ? 2 : 0.05
        expected.forEach((q, i) => {
          const d = Math.hypot(q.x * PPU - got[i]!.x, q.y * PPU - got[i]!.y)
          expect(d, `${n.path} 第 ${i} 个顶点 @${animName ?? 'setup'} ${t.toFixed(4)}`).toBeLessThan(tolerance)
        })
        checked++
      }
    }
  }
  return checked
}

for (const sample of SAMPLES) {
  describe.skipIf(!existsSync(sample.skel) || !existsSync(sample.atlas))(`Unity 产物 → Spine(${sample.label})`, () => {
    const part = readSkeletonPart(new Uint8Array(readFileSync(sample.skel)))
    const atlas = parseAtlas(readFileSync(sample.atlas, 'utf8'))
    const dir = sample.atlas.slice(0, sample.atlas.lastIndexOf('/'))
    const sources = new Map<string, Image>(atlas.pages.map((p) => [p.name, decodePng(new Uint8Array(readFileSync(`${dir}/${p.name}`)))]))
    const unity = exportToUnity(part, atlas, sources, { name: 'x', pixelsPerUnit: PPU, renderPipeline: 'urp' })
    const files = new Map(unity.files.map((f) => [f.path, f.content]))
    const imported = importUnity(files, { pixelsPerUnit: PPU })
    const back = fromJson(imported.json)
    const scene = loadUnityScene(files)

    const attachmentOf = (skin: string, slot: string, key: string) =>
      back.skins.find((s) => s.name === skin)?.slots.find((e) => e.slot === slotIndex(back, slot))?.attachments.find((a) => a.key === key)

    it('结构:每个挂图节点都读成了 attachment;动画一条不少;没有「丢失」', () => {
      for (const n of imported.nodes) expect(attachmentOf(n.skin, n.slot, n.key), n.path).toBeDefined()
      expect(back.animations.map((a) => a.name).sort()).toEqual(part.animations.map((a) => a.name).sort())
      expect(imported.issues.filter((i) => i.level === 'loss')).toEqual([])
    })

    it('⭐ 与 Unity 的规则逐点一致:setup、每条动画的关键帧、中点、四分点(0.05 像素)', () => {
      expect(compareWithUnity(files)).toBeGreaterThan(20)
    })

    it('⭐ slot 颜色与 Unity 的规则一致(取每个 slot 在 prefab 里的第一个节点)', () => {
      const firstNode = new Map<string, string>()
      for (const n of imported.nodes) if (!firstNode.has(n.slot)) firstNode.set(n.slot, n.path)
      for (const clip of [null, ...scene.clips.filter((c) => !c.includes('@skin@'))]) {
        const anim = clip === null ? null : back.animations.find((a) => a.name === clip.slice('x@'.length))!
        const times = [0, ...(anim?.timelines.flatMap((tl) => tl.frames.map((f) => Number(f['time'] ?? 0))) ?? [])]
        for (const t of [...new Set(times)]) {
          const colors = scene.colorAt(clip, t)
          for (const [slot, path] of firstNode) {
            const expected = colors.get(path)
            if (expected === undefined) continue
            const si = slotIndex(back, slot)
            const tls = anim === null ? [] : anim.timelines.filter((tl) => tl.owner === si && tl.kind.startsWith('slotColor'))
            const got = slotColorAt(tls, unpackRgba(back.slots[si]!.color), t, false)
            expected.forEach((v, k) => expect(Math.abs(v - got[k]!), `${slot}@${clip ?? 'setup'} ${t.toFixed(3)} 通道 ${k}`).toBeLessThan(1.01 / 255))
          }
        }
      }
    })

    it('粗检:setup 与原 Spine 一致(容差按 Unity 导出自己的判据)', () => {
      const pose = setupPose(part, { unityCompatible: true })
      const poseB = setupPose(back)
      for (const skin of part.skins) {
        for (const entry of skin.slots) {
          for (const a of entry.attachments) {
            if ((a.type !== 'region' && a.type !== 'mesh') || a.sequence !== null) continue
            const slotName = part.slots[entry.slot]!.name
            const b = attachmentOf(skin.name, slotName, a.key)
            if (b === undefined) continue
            const orig = attachmentVertices(part, atlas, a, skin.name, entry.slot, pose, null, 0)
            const got = attachmentVertices(back, imported.atlas, b, skin.name, slotIndex(back, slotName), poseB, null, 0)
            const xs = orig.map((q) => q.x), ys = orig.map((q) => q.y)
            // SpriteSkin 的逐骨骼拟合残差 ≤ max(1 像素, 跨度 2%) 才留在 SpriteSkin(Unity 导出的分流判据)
            const allowed = Math.max(1, Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 0.02)
            orig.forEach((q, i) => expect(Math.hypot(q.x - got[i]!.x, q.y - got[i]!.y), `${skin.name}/${a.name} 第 ${i} 个顶点`).toBeLessThan(allowed))
          }
        }
      }
    })
  })
}


/**
 * 读取器存在的理由:角色导到 Unity、**在 Unity 里改过之后**再转出去。改动按 Unity 编辑器真实写出的样子
 * 直接改文本(改关键帧取值、插一个默认切线的新关键帧、挪 prefab 里骨骼的位置),
 * 读回来要逐点符合 Unity 的规则,而且改动要落在对应的骨骼 / 时间轴上。
 */
describe.skipIf(!existsSync('res/spine/4.1/MX2_cat.skel.bytes'))('Unity 产物在 Unity 里改过之后 → Spine(MX2_cat 4.1)', () => {
  const part = readSkeletonPart(new Uint8Array(readFileSync('res/spine/4.1/MX2_cat.skel.bytes')))
  const atlas = parseAtlas(readFileSync('res/spine/4.1/MX2_cat.atlas.txt', 'utf8'))
  const sources = new Map<string, Image>(atlas.pages.map((p) => [p.name, decodePng(new Uint8Array(readFileSync(`res/spine/4.1/${p.name}`)))]))
  const unity = exportToUnity(part, atlas, sources, { name: 'x', pixelsPerUnit: PPU, renderPipeline: 'urp' })
  const original = new Map(unity.files.map((f) => [f.path, f.content]))

  /** 把某个文件里唯一出现的一段文本换掉(出现不止一次说明改错了地方) */
  const edit = (files: Map<string, string | Uint8Array>, path: string, from: string, to: string) => {
    const text = files.get(path) as string
    expect(text.split(from).length - 1, `${path} 里「${from.trim()}」应当恰好一处`).toBe(1)
    files.set(path, text.replace(from, to))
  }
  const edited = new Map(original)
  // body2 在 idle 第 1 秒的旋转关键帧 +30°(Animation 窗口里改值)
  edit(edited, 'x@idle.anim', 'z: 129.6213226}', 'z: 159.6213226}')
  // 同一条曲线在 0.5 秒插一个新关键帧(Unity 默认:平切线、不加权)
  const key = (time: number, z: number) => [
    '      - serializedVersion: 3', `        time: ${time}`, `        value: {x: 0, y: 0, z: ${z}}`,
    '        inSlope: {x: 0, y: 0, z: 0}', '        outSlope: {x: 0, y: 0, z: 0}', '        tangentMode: 0', '        weightedMode: 0',
    '        inWeight: {x: 0, y: 0, z: 0.3333333}', '        outWeight: {x: 0, y: 0, z: 0.3333333}', '',
  ].join('\n')
  edit(edited, 'x@idle.anim', '      - serializedVersion: 3\n        time: 1\n        value: {x: 0, y: 0, z: 159.6213226}', `${key(0.5, 140)}      - serializedVersion: 3\n        time: 1\n        value: {x: 0, y: 0, z: 159.6213226}`)
  // Scene 里把 body 往右挪 0.3 个单位(setup 姿势)
  edit(edited, 'x.prefab', 'm_LocalPosition: {x: -0.807036, y: 2.839671, z: 0}', 'm_LocalPosition: {x: -0.507036, y: 2.839671, z: 0}')

  const before = fromJson(importUnity(original, { pixelsPerUnit: PPU }).json)
  const after = fromJson(importUnity(edited, { pixelsPerUnit: PPU }).json)
  const boneIndex = (name: string) => after.bones.findIndex((b) => b.name === name)
  const rotateFrames = (p: typeof after) =>
    p.animations.find((a) => a.name === 'idle')!.timelines.find((tl) => tl.kind === 'rotate' && tl.owner === boneIndex('body2'))!.frames

  it('改关键帧的值、插关键帧:落在 body2 的旋转时间轴上,别的帧不动', () => {
    const b = rotateFrames(before), a = rotateFrames(after)
    expect(a.map((f) => f['time'] ?? 0)).toEqual([0, 0.5, 1, 2])
    expect(Number(a[2]!['value']) - Number(b[1]!['value'])).toBeCloseTo(30, 4)
    expect(Number(a[1]!['value']) - Number(b[0]!['value'])).toBeCloseTo(140 - 127.4761734, 4)
    expect(a[0]!['value']).toBeCloseTo(Number(b[0]!['value']), 6)
    expect(a[3]!['value']).toBeCloseTo(Number(b[2]!['value']), 6)
  })

  it('挪骨骼:setup 位置跟着变(单位 × ppu)', () => {
    const i = boneIndex('body')
    expect(Number(after.bones[i]!.x) - Number(before.bones[i]!.x)).toBeCloseTo(30, 4)
    expect(after.bones[i]!.y).toBeCloseTo(Number(before.bones[i]!.y), 6)
  })

  it('⭐ 改过的产物与 Unity 的规则逐点一致', () => {
    expect(compareWithUnity(edited)).toBeGreaterThan(20)
  })
})
