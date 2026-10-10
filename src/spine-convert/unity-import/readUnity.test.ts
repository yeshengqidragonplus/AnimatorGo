import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { readSkeletonPart, type SkeletonPart } from '../../spine-format/binary/readSkeleton.ts'
import type { AnimationData } from '../../spine-format/binary/readAnimations.ts'
import { fromJson } from '../../spine-format/json/fromJson.ts'
import { parseAtlas } from '../../core/atlas.ts'
import { decodePng, type Image } from '../../unity/png.ts'
import { poseAt, setupPose } from '../../spine-eval/pose.ts'
import { attachmentVertices } from '../../spine-eval/vertices.ts'
import { slotColorAt, unpackRgba } from '../../spine-eval/color.ts'
import { drawOrderAt, slotAttachmentsAt } from '../../spine-eval/slots.ts'
import { exportToUnity } from '../unity/export.ts'
import { importUnity } from './readUnity.ts'
import { loadUnityScene } from './unityEval.ts'
import { list, map, num, parseUnityYaml, parseYamlDocument, ref, str, vec } from '../../unity/yaml.ts'
import { spriteRecord } from '../../unity/spriteMeta.ts'
import { expandPsdImports } from './expandPsd.ts'
import { readUnityDir } from '../../cli/unityDir.ts'

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
 * 把 Unity 产物读成 Spine,按 Spine 的规则求值,与 Unity 的规则(unityEval)在同一时刻比:
 * setup、每条动画的关键帧、相邻关键帧的四分点和中点。比两样 ——
 *
 * 1. 每个挂图物体当时用的那张图的顶点(逐点,0.05 像素)
 * 2. 画了哪些、画的先后:Spine 按 slot 挂的 attachment(当前皮肤 → 默认皮肤)和 drawOrder 铺出来,
 *    换成 Unity 那边的 (物体, 图),与 Unity 按 m_Enabled / m_IsActive / m_Sprite / 排序规则算出的序列相等
 *
 * 返回比过的「物体 × 时刻」数。
 */
function compareWithUnity(files: ReadonlyMap<string, string | Uint8Array>): number {
  const imported = importUnity(files, { pixelsPerUnit: PPU })
  const back = fromJson(imported.json)
  const scene = loadUnityScene(files)
  const attachmentOf = (skin: string, slot: string, key: string) =>
    back.skins.find((s) => s.name === skin)?.slots.find((e) => e.slot === slotIndex(back, slot))?.attachments.find((a) => a.key === key)
  /** 读取器报过「段内采样成直线」的 deform:它们在段内只近似 */
  const sampled = new Set(imported.issues.filter((i) => i.message.includes('段内按 30 fps 采样')).map((i) => /deform\[(.+)\]$/.exec(i.path)?.[1]))
  const entryOf = (slot: string, key: string) =>
    imported.nodes.find((n) => n.slot === slot && n.key === key && n.skin === imported.initialSkin) ??
    imported.nodes.find((n) => n.slot === slot && n.key === key && n.skin === 'default')
  const spineDrawn = (anim: AnimationData | null, t: number) => {
    const names = slotAttachmentsAt(back, anim, t)
    return drawOrderAt(back, anim, t).flatMap((si) => {
      const key = names[si]
      const hit = key === null || key === undefined ? undefined : entryOf(back.slots[si]!.name, key)
      return hit === undefined ? [] : [`${hit.path} | ${hit.sprite}`]
    })
  }
  let checked = 0
  const clips: (string | null)[] = [null, ...scene.clips.filter((c) => !c.includes('@skin@'))]
  for (const clip of clips) {
    const anim = clip === null ? null : back.animations.find((a) => a.name === clip || clip.endsWith(`@${a.name}`))!
    const label = anim?.name ?? 'setup'
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
        const expected = unityVerts.get(n.path)
        if (expected === undefined || expected.sprite !== n.sprite) continue
        const att = attachmentOf(n.skin, n.slot, n.key)!
        const got = attachmentVertices(back, imported.atlas, att, n.skin, slotIndex(back, n.slot), pose, anim, t)
        expect(got.length, n.path).toBe(expected.points.length)
        const tolerance = sampled.has(n.key) ? 2 : 0.05
        expected.points.forEach((q, i) => {
          const d = Math.hypot(q.x * PPU - got[i]!.x, q.y * PPU - got[i]!.y)
          expect(d, `${n.path} 第 ${i} 个顶点 @${label} ${t.toFixed(4)}`).toBeLessThan(tolerance)
        })
        checked++
      }
      const unityDrawn = scene.drawnAt(clip, t).map((d) => `${d.path} | ${d.sprite}`)
      expect(spineDrawn(anim, t), `画了哪些、先后 @${label} ${t.toFixed(4)}`).toEqual(unityDrawn)
    }
  }
  return checked
}

/**
 * 每个挂图物体的颜色:Unity 的规则(unityEval:SpriteRenderer 的 m_Color 曲线、SkinnedMeshRenderer 的顶点色换回 sRGB)
 * 与读回的 Spine(slot 颜色按颜色时间轴求值 × 物体那些 attachment 的颜色)在 setup 和每条动画的关键帧上比。
 * 读取器报了「不成比例」的 slot 跳过(那是 Spine 表达不了的,报出来就是对的)。返回比过的「物体 × 时刻」数
 */
function compareColorsWithUnity(files: ReadonlyMap<string, string | Uint8Array>): number {
  const imported = importUnity(files, { pixelsPerUnit: PPU })
  const back = fromJson(imported.json)
  const scene = loadUnityScene(files)
  const prefix = `${imported.name}@`
  const skipped = new Set(imported.issues.flatMap((i) => (i.level === 'approximated' ? [/(?:^|\.)color\[(.+)\]$/.exec(i.path)?.[1]] : [])).filter((x) => x !== undefined))
  const attachmentOf = (skin: string, slot: string, key: string) =>
    back.skins.find((s) => s.name === skin)?.slots.find((e) => e.slot === slotIndex(back, slot))?.attachments.find((a) => a.key === key)
  let checked = 0
  for (const clip of [null, ...scene.clips.filter((c) => !c.includes('@skin@'))]) {
    const anim = clip === null ? null : back.animations.find((a) => a.name === (clip.startsWith(prefix) ? clip.slice(prefix.length) : clip))!
    const times = [0, ...(anim?.timelines.flatMap((tl) => tl.frames.map((f) => Number(f['time'] ?? 0))) ?? [])]
    for (const t of [...new Set(times)]) {
      const colors = scene.colorAt(clip, t)
      for (const n of imported.nodes) {
        const expected = colors.get(n.path)
        if (expected === undefined || skipped.has(n.slot)) continue
        const si = slotIndex(back, n.slot)
        const tls = anim === null ? [] : anim.timelines.filter((tl) => tl.owner === si && tl.kind.startsWith('slotColor'))
        const slotColor = slotColorAt(tls, unpackRgba(back.slots[si]!.color), t, false)
        const own = unpackRgba((attachmentOf(n.skin, n.slot, n.key)!.data['color'] as number | undefined) ?? -1)
        // slot 颜色与 attachment 颜色各自按字节写,乘起来最多差 1/255
        expected.forEach((v, k) => expect(Math.abs(v - slotColor[k]! * own[k]!), `${n.path}@${clip ?? 'setup'} ${t.toFixed(3)} 通道 ${k}`).toBeLessThan(1.01 / 255))
        checked++
      }
    }
  }
  return checked
}

/**
 * 把一个 Spine 样本导到 Unity:原骨架、图集、产物(路径 → 内容)。
 *
 * ⚠️ 样本一律在 beforeAll 里读,不能放在 describe 体里:skip 掉的 suite 收集用例时 describe 体照样执行,
 * 样本不在(res/ 是 gitignore 掉的,worktree 里没有;MergeCooking2 等是本机的)就 ENOENT,整个文件「no tests」,
 * 别的用例全被盖住。跳过的 suite 不跑 beforeAll。
 */
function exportSample(skel: string, atlasPath: string) {
  const part = readSkeletonPart(new Uint8Array(readFileSync(skel)))
  const atlas = parseAtlas(readFileSync(atlasPath, 'utf8'))
  const dir = atlasPath.slice(0, atlasPath.lastIndexOf('/'))
  const sources = new Map<string, Image>(atlas.pages.map((p) => [p.name, decodePng(new Uint8Array(readFileSync(`${dir}/${p.name}`)))]))
  const unity = exportToUnity(part, atlas, sources, { name: 'x', pixelsPerUnit: PPU, renderPipeline: 'urp' })
  return { part, atlas, files: new Map(unity.files.map((f) => [f.path, f.content])) }
}

/** 导到 Unity 再读回来 */
function exportAndReadBack(skel: string, atlasPath: string) {
  const { part, atlas, files } = exportSample(skel, atlasPath)
  const imported = importUnity(files, { pixelsPerUnit: PPU })
  const back = fromJson(imported.json)

  const attachmentOf = (skin: string, slot: string, key: string) =>
    back.skins.find((s) => s.name === skin)?.slots.find((e) => e.slot === slotIndex(back, slot))?.attachments.find((a) => a.key === key)
  return { part, atlas, files, imported, back, attachmentOf }
}

for (const sample of SAMPLES) {
  describe.skipIf(!existsSync(sample.skel) || !existsSync(sample.atlas))(`Unity 产物 → Spine(${sample.label})`, () => {
    let rt: ReturnType<typeof exportAndReadBack>
    beforeAll(() => {
      rt = exportAndReadBack(sample.skel, sample.atlas)
    })

    it('结构:每个挂图节点都读成了 attachment;动画一条不少;没有「丢失」', () => {
      const { part, imported, back, attachmentOf } = rt
      for (const n of imported.nodes) expect(attachmentOf(n.skin, n.slot, n.key), n.path).toBeDefined()
      expect(back.animations.map((a) => a.name).sort()).toEqual(part.animations.map((a) => a.name).sort())
      expect(imported.issues.filter((i) => i.level === 'loss')).toEqual([])
    })

    it('⭐ 与 Unity 的规则逐点一致:setup、每条动画的关键帧、中点、四分点(0.05 像素)', () => {
      const { files } = rt
      expect(compareWithUnity(files)).toBeGreaterThan(20)
    })

    it('⭐ 每个挂图物体的颜色与 Unity 的规则一致(slot 颜色 × attachment 颜色)', () => {
      expect(compareColorsWithUnity(rt.files)).toBeGreaterThan(0)
    })

    it('粗检:setup 与原 Spine 一致(容差按 Unity 导出自己的判据)', () => {
      const { part, atlas, imported, back, attachmentOf } = rt
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


/** MX2_cat 的 slot 轮流改成四种混合模式 */
function loadBlendedCat() {
  const part = readSkeletonPart(new Uint8Array(readFileSync('res/spine/4.1/MX2_cat.skel.bytes')))
  const atlas = parseAtlas(readFileSync('res/spine/4.1/MX2_cat.atlas.txt', 'utf8'))
  const sources = new Map<string, Image>(atlas.pages.map((p) => [p.name, decodePng(new Uint8Array(readFileSync(`res/spine/4.1/${p.name}`)))]))
  return { atlas, sources, blended: { ...part, slots: part.slots.map((s, i) => ({ ...s, blendMode: i % 4 })) } }
}

describe.skipIf(!existsSync('res/spine/4.1/MX2_cat.skel.bytes'))('混合模式读回来(MX2_cat 4.1,slot 轮流改成四种模式)', () => {
  let cat: ReturnType<typeof loadBlendedCat>
  beforeAll(() => {
    cat = loadBlendedCat()
  })

  for (const rp of ['urp', 'builtin'] as const) {
    it(`⭐ ${rp}:我们导出的混合材质读回成 slot 的 blend,与原来逐个相同(SpriteRenderer、SkinnedMeshRenderer 都有)`, () => {
      const { blended, atlas, sources } = cat
      const unity = exportToUnity(blended, atlas, sources, { name: 'x', pixelsPerUnit: PPU, renderPipeline: rp })
      const back = fromJson(importUnity(new Map(unity.files.map((f) => [f.path, f.content])), { pixelsPerUnit: PPU }).json)
      expect(back.slots.length).toBeGreaterThan(10)
      const modes = new Set<number>()
      for (const s of back.slots) {
        const original = blended.slots.find((o) => o.name === s.name)
        expect(original, s.name).toBeDefined()
        expect(s.blendMode, s.name).toBe(original!.blendMode)
        modes.add(s.blendMode)
      }
      expect([...modes].sort()).toEqual([0, 1, 2, 3])
    })
  }
})

/**
 * 读取器存在的理由:角色导到 Unity、**在 Unity 里改过之后**再转出去。改动按 Unity 编辑器真实写出的样子
 * 直接改文本(改关键帧取值、插一个默认切线的新关键帧、挪 prefab 里骨骼的位置),
 * 读回来要逐点符合 Unity 的规则,而且改动要落在对应的骨骼 / 时间轴上。
 */
function editCat() {
  const original = exportSample('res/spine/4.1/MX2_cat.skel.bytes', 'res/spine/4.1/MX2_cat.atlas.txt').files

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
  return { edited, before, after, boneIndex, rotateFrames }
}

describe.skipIf(!existsSync('res/spine/4.1/MX2_cat.skel.bytes'))('Unity 产物在 Unity 里改过之后 → Spine(MX2_cat 4.1)', () => {
  let cat: ReturnType<typeof editCat>
  beforeAll(() => {
    cat = editCat()
  })

  it('改关键帧的值、插关键帧:落在 body2 的旋转时间轴上,别的帧不动', () => {
    const { before, after, rotateFrames } = cat
    const b = rotateFrames(before), a = rotateFrames(after)
    expect(a.map((f) => f['time'] ?? 0)).toEqual([0, 0.5, 1, 2])
    expect(Number(a[2]!['value']) - Number(b[1]!['value'])).toBeCloseTo(30, 4)
    expect(Number(a[1]!['value']) - Number(b[0]!['value'])).toBeCloseTo(140 - 127.4761734, 4)
    expect(a[0]!['value']).toBeCloseTo(Number(b[0]!['value']), 6)
    expect(a[3]!['value']).toBeCloseTo(Number(b[2]!['value']), 6)
  })

  it('挪骨骼:setup 位置跟着变(单位 × ppu)', () => {
    const { before, after, boneIndex } = cat
    const i = boneIndex('body')
    expect(Number(after.bones[i]!.x) - Number(before.bones[i]!.x)).toBeCloseTo(30, 4)
    expect(after.bones[i]!.y).toBeCloseTo(Number(before.bones[i]!.y), 6)
  })

  it('⭐ 改过的产物与 Unity 的规则逐点一致', () => {
    const { edited } = cat
    expect(compareWithUnity(edited)).toBeGreaterThan(20)
  })
})

/**
 * 别人的角色 / 在 Unity 里动过结构的角色:我们导出时不会出现、但 Unity 里很常见的写法。
 * 每一条都直接改文本(写法照 Unity 自己写出的),读回来逐点、逐「画了哪些、先后」符合 Unity 的规则。
 */
function exportCat() {
  const original = exportSample('res/spine/4.1/MX2_cat.skel.bytes', 'res/spine/4.1/MX2_cat.atlas.txt').files
  const originalNodes = importUnity(original, { pixelsPerUnit: PPU }).nodes
  const spriteOf = (path: string) => originalNodes.find((n) => n.path === path)!.sprite!
  return { original, spriteOf }
}

describe.skipIf(!existsSync('res/spine/4.1/MX2_cat.skel.bytes'))('Unity 里常见、我们导出时不会出现的写法(MX2_cat 4.1 上改)', () => {
  let cat: ReturnType<typeof exportCat>
  beforeAll(() => {
    cat = exportCat()
  })

  type Files = Map<string, string | Uint8Array>
  const textOf = (files: Files, path: string) => files.get(path) as string
  /** prefab 里按路径找物体(和 Unity 绑曲线一样,从根物体按名字一级级往下) */
  const nodeAt = (files: Files, path: string) => {
    const objs = parseUnityYaml(textOf(files, 'x.prefab'))
    const byId = new Map(objs.map((o) => [o.fileID, o]))
    let t = objs.find((o) => o.type === 'Transform' && ref(o.data['m_Father']).fileID === '0')!
    for (const seg of path === '' ? [] : path.split('/')) {
      t = list(t.data['m_Children']).map((c) => byId.get(ref(c).fileID)!).find((c) => str(byId.get(ref(c.data['m_GameObject']).fileID)!.data['m_Name']) === seg)!
    }
    const go = byId.get(ref(t.data['m_GameObject']).fileID)!
    return { t, go, comp: (type: string) => objs.find((o) => o.type === type && ref(o.data['m_GameObject']).fileID === go.fileID)! }
  }
  /** 改 prefab 里的一个对象(按 fileID 找到它那一段) */
  const editObject = (files: Files, fileID: string, fn: (doc: string) => string) => {
    const docs = textOf(files, 'x.prefab').split(/(?=^--- !u!)/m)
    const i = docs.findIndex((d) => new RegExp(`^--- !u!\\d+ &${fileID}\\b`).test(d))
    expect(i, `prefab 里找不到 &${fileID}`).toBeGreaterThan(-1)
    const changed = fn(docs[i]!)
    expect(changed, `&${fileID} 没改动`).not.toBe(docs[i])
    docs[i] = changed
    files.set('x.prefab', docs.join(''))
  }
  const editText = (files: Files, path: string, from: string, to: string) => {
    const before = textOf(files, path)
    expect(before.includes(from), `${path} 里没找到 ${from.slice(0, 40)}`).toBe(true)
    files.set(path, before.replace(from, to))
  }
  const vecKey = (time: number, z: number) =>
    `      - serializedVersion: 3\n        time: ${time}\n        value: {x: 0, y: 0, z: ${z}}\n        inSlope: {x: 0, y: 0, z: 0}\n        outSlope: {x: 0, y: 0, z: 0}\n` +
    '        tangentMode: 0\n        weightedMode: 0\n        inWeight: {x: 0.33333334, y: 0.33333334, z: 0.33333334}\n        outWeight: {x: 0.33333334, y: 0.33333334, z: 0.33333334}\n'
  const stepKey = (time: number, value: number) =>
    `      - serializedVersion: 3\n        time: ${time}\n        value: ${value}\n        inSlope: Infinity\n        outSlope: Infinity\n` +
    '        tangentMode: 103\n        weightedMode: 0\n        inWeight: 0.33333334\n        outWeight: 0.33333334\n'
  const curveTail = '      m_PreInfinity: 2\n      m_PostInfinity: 2\n      m_RotationOrder: 4\n'
  const read = (files: Files) => {
    const imported = importUnity(files, { pixelsPerUnit: PPU })
    return { imported, back: fromJson(imported.json) }
  }
  const idle = (back: SkeletonPart) => back.animations.find((a) => a.name === 'idle')!
  const losses = (r: ReturnType<typeof read>) => r.imported.issues.filter((i) => i.level === 'loss')

  const EDITS: { label: string; apply: (files: Files) => void; check: (r: ReturnType<typeof read>) => void }[] = [
    {
      label: '给挂图物体自己打旋转关键帧(Animation 窗口里直接转图片)→ 它变成骨骼',
      apply: (files) => editText(files, 'x@idle.anim', '  m_EulerCurves:\n', `  m_EulerCurves:\n  - curve:\n      serializedVersion: 2\n      m_Curve:\n${vecKey(0, 0)}${vecKey(1, 40)}${curveTail}    path: root/bubble/bubble\n`),
      check: (r) => {
        expect(losses(r)).toEqual([])
        const bone = r.back.bones.findIndex((b) => b.name === 'bubble_2')
        expect(r.back.slots.find((s) => s.name === 'bubble')!.bone).toBe(bone)
        expect(idle(r.back).timelines.some((t) => t.kind === 'rotate' && t.owner === bone)).toBe(true)
      },
    },
    {
      label: '把骨骼拖到挂图物体下面 → 子骨骼的父骨骼是这个物体,不会变成第二根根骨骼',
      apply: (files) => {
        const child = nodeAt(files, 'root/bubble2').t.fileID
        const oldParent = nodeAt(files, 'root').t.fileID
        const newParent = nodeAt(files, 'root/bubble/bubble').t.fileID
        editObject(files, child, (d) => d.replace(/m_Father: \{fileID: \d+\}/, `m_Father: {fileID: ${newParent}}`))
        editObject(files, oldParent, (d) => d.replace(`  - {fileID: ${child}}\n`, ''))
        editObject(files, newParent, (d) => d.replace('m_Children: []', `m_Children:\n  - {fileID: ${child}}`))
        for (const [path, content] of files) {
          if (!path.endsWith('.anim')) continue
          files.set(path, (content as string).replaceAll('path: root/bubble2\n', 'path: root/bubble/bubble/bubble2\n').replaceAll('path: root/bubble2/', 'path: root/bubble/bubble/bubble2/'))
        }
      },
      check: (r) => {
        expect(losses(r)).toEqual([])
        expect(r.back.bones.filter((b) => b.parent === -1)).toHaveLength(1)
        const holder = r.back.bones.findIndex((b) => b.name === 'bubble_2')
        expect(r.back.bones.find((b) => b.name === 'bubble2')!.parent).toBe(holder)
      },
    },
    {
      label: 'm_IsActive 曲线关掉一根骨骼(连同下面挂的图)',
      apply: (files) => editText(files, 'x@idle.anim', '  m_FloatCurves:\n', `  m_FloatCurves:\n  - serializedVersion: 2\n    curve:\n      serializedVersion: 2\n      m_Curve:\n${stepKey(0, 1)}${stepKey(0.5, 0)}${stepKey(1.5, 1)}${curveTail}    attribute: m_IsActive\n    path: root/bubble3\n    classID: 1\n    script: {fileID: 0}\n    flags: 0\n`),
      check: (r) => {
        expect(losses(r)).toEqual([])
        const slot = r.back.slots.findIndex((s) => s.name === 'bubble3')
        expect(slotAttachmentsAt(r.back, idle(r.back), 0.75)[slot]).toBeNull()
        expect(slotAttachmentsAt(r.back, idle(r.back), 1.6)[slot]).toBe('bubble')
      },
    },
    {
      label: 'prefab 里把一根骨骼的 GameObject 关掉 → setup 不画它下面的图',
      apply: (files) => editObject(files, nodeAt(files, 'root/bubble').go.fileID, (d) => d.replace('m_IsActive: 1', 'm_IsActive: 0')),
      check: (r) => expect(r.back.slots.find((s) => s.name === 'bubble')!.attachmentName).toBeNull(),
    },
    {
      label: 'm_Sprite 曲线换图(逐帧换 sprite)→ 每张图一个 attachment,换图时间轴',
      apply: (files) => {
        const [g1, f1] = cat.spriteOf('root/bubble2/bubble2__bubble').split(':')
        const [g2, f2] = cat.spriteOf('head').split(':')
        const k = (time: number, g: string, f: string) => `    - time: ${time}\n      value: {fileID: ${f}, guid: ${g}, type: 3}\n`
        editText(files, 'x@idle.anim', 'm_PPtrCurves: []', `m_PPtrCurves:\n  - curve:\n${k(0, g1!, f1!)}${k(0.5, g2!, f2!)}${k(1, g1!, f1!)}    attribute: m_Sprite\n    path: root/bubble2/bubble2__bubble\n    classID: 212\n    script: {fileID: 0}\n    flags: 2`)
      },
      check: (r) => {
        expect(losses(r)).toEqual([])
        const slot = r.back.slots.findIndex((s) => s.name === 'bubble2')
        const at = (t: number) => r.imported.nodes.find((n) => n.slot === 'bubble2' && n.key === slotAttachmentsAt(r.back, idle(r.back), t)[slot])?.sprite
        expect(at(0.6)).toBe(cat.spriteOf('head'))
        expect(at(1.1)).toBe(cat.spriteOf('root/bubble2/bubble2__bubble'))
      },
    },
    {
      label: '删掉 0 秒的关键帧 → 0 秒补一个同值的键(Unity 在第一个键之前取它的值,Spine 取 setup)',
      apply: (files) => {
        // swim 里第一条在变的旋转曲线,删掉它 0 秒那个键
        const text = textOf(files, 'x@swim.anim')
        const euler = text.slice(text.indexOf('  m_EulerCurves:\n'), text.indexOf('  m_PositionCurves:'))
        const entries = euler.split(/(?=^ {2}- curve:\n)/m).slice(1)
        const entry = entries.find((e) => new Set([...e.matchAll(/value: \{x: 0, y: 0, z: (\S+)\}/g)].map((m) => m[1])).size > 1)!
        const firstKey = /^ {6}- serializedVersion: 3\n {8}time: 0\n[\s\S]*?(?=^ {6}- serializedVersion: 3\n)/m.exec(entry)![0]
        editText(files, 'x@swim.anim', entry, entry.replace(firstKey, ''))
      },
      check: (r) => expect(losses(r)).toEqual([]),
    },
    {
      label: 'clip 比最后一个关键帧长(m_StopTime)→ Spine 的时长跟着撑长',
      apply: (files) => editText(files, 'x@idle.anim', 'm_StopTime: 2\n', 'm_StopTime: 2.5\n'),
      check: (r) => {
        const end = Math.max(...idle(r.back).timelines.flatMap((t) => t.frames.map((f) => Number(f['time'] ?? 0))))
        expect(end).toBeCloseTo(2.5, 6)
      },
    },
    {
      label: '改 Order in Layer(prefab 里把 glass 提到最上面)',
      apply: (files) => editObject(files, nodeAt(files, 'glass').comp('SpriteRenderer').fileID, (d) => d.replace(/m_SortingOrder: -?\d+/, 'm_SortingOrder: 100')),
      check: (r) => expect(r.back.slots[r.back.slots.length - 1]!.name).toBe('glass'),
    },
    {
      label: '给一根骨骼加 Sorting Group(Order 50)→ 它下面的图整组按 50 排',
      apply: (files) => {
        const go = nodeAt(files, 'root/bubble3').go.fileID
        editObject(files, go, (d) => d.replace('  m_Component:\n', '  m_Component:\n  - component: {fileID: 990001}\n'))
        files.set('x.prefab', `${textOf(files, 'x.prefab')}--- !u!210 &990001\nSortingGroup:\n  m_ObjectHideFlags: 0\n  m_CorrespondingSourceObject: {fileID: 0}\n  m_PrefabInstance: {fileID: 0}\n  m_PrefabAsset: {fileID: 0}\n  m_GameObject: {fileID: ${go}}\n  m_Enabled: 1\n  m_SortingLayerID: 0\n  m_SortingLayer: 0\n  m_SortingOrder: 50\n  m_SortAtRoot: 0\n`)
      },
      check: (r) => expect(r.back.slots[r.back.slots.length - 1]!.name).toBe('bubble3'),
    },
  ]

  for (const e of EDITS) {
    it(`⭐ ${e.label}`, () => {
      const files = new Map(cat.original)
      e.apply(files)
      expect(compareWithUnity(files)).toBeGreaterThan(20)
      e.check(read(files))
    })
  }

  it('⭐ 以上全部一起改', () => {
    const files = new Map(cat.original)
    for (const e of EDITS) e.apply(files)
    expect(compareWithUnity(files)).toBeGreaterThan(20)
  })
})

/**
 * 真实的「别人的角色」:第三方插件(Easy Performant Outline)自带的 2D 演示角色。根物体上一个 SpriteRenderer,
 * 11 条动画全是 `m_Sprite` 逐帧换图,每帧一张单独的贴图(Single 模式,`.meta` 里没有顶点)。
 */
const PLAYER = 'E:/UnityProject/BlockTile1/BlockTile1/Assets/ThirdParty/Easy performant outline/Demo/Models for Demo scene/Free 2D Demo Character sprite sheet'
function readPlayer() {
  const files = readUnityDir(PLAYER)
  const imported = importUnity(files, { pixelsPerUnit: PPU })
  const back = fromJson(imported.json)
  return { files, imported, back }
}

describe.skipIf(!existsSync(PLAYER))('别人做的角色:逐帧换 sprite(Free 2D Demo Character)', () => {
  let player: ReturnType<typeof readPlayer>
  beforeAll(() => {
    player = readPlayer()
  })

  it('结构:一个 slot、每张图一个 attachment、动画一条不少、没有丢失', () => {
    const { files, imported, back } = player
    expect(imported.issues.filter((i) => i.level === 'loss')).toEqual([])
    expect(back.slots.map((s) => s.name)).toEqual(['Player'])
    const sprites = new Set<string>()
    for (const [path, content] of files) {
      if (!path.endsWith('.anim') && !path.endsWith('.prefab')) continue
      for (const m of (content as string).matchAll(/m_Sprite: \{fileID: (\d+), guid: (\w+), type: 3\}/g)) sprites.add(`${m[2]}:${m[1]}`)
      for (const m of (content as string).matchAll(/value: \{fileID: (\d+), guid: (\w+), type: 3\}/g)) sprites.add(`${m[2]}:${m[1]}`)
    }
    expect(new Set(imported.nodes.map((n) => n.sprite))).toEqual(sprites)
    expect(back.skins[0]!.slots[0]!.attachments).toHaveLength(sprites.size)
    expect(back.animations).toHaveLength([...files.keys()].filter((p) => p.endsWith('.anim')).length)
  })

  it('⭐ 时长 = clip 的 m_StopTime(最后一帧要停一会儿,不能被吃掉)', () => {
    const { files, back } = player
    for (const [path, content] of files) {
      if (!path.endsWith('.anim')) continue
      const clip = parseUnityYaml(content as string).find((o) => o.type === 'AnimationClip')!
      const stop = Number(str(map(clip.data['m_AnimationClipSettings'])['m_StopTime']))
      const anim = back.animations.find((a) => a.name === str(clip.data['m_Name']))!
      const end = Math.max(...anim.timelines.flatMap((t) => t.frames.map((f) => Number(f['time'] ?? 0))))
      expect(end, anim.name).toBeCloseTo(stop, 5)
    }
  })

  it('⭐ 与 Unity 的规则一致:每一刻画哪张图、顶点在哪', () => {
    const { files } = player
    expect(compareWithUnity(files)).toBeGreaterThan(100)
  })
})

/**
 * PSD Importer 的角色(.psb / .psd):Unity 官方 2D Animation 示例,全是 Unity 里做的、不是我们导出的。
 *
 * 标准答案是 **Unity 自己导入的结果**(tools/unity/AnimatorGoDumpPsd.cs 导出,存在 res/unity-psd/):
 * 生成的 prefab 每个物体的路径 / 局部 TRS / 排序 / 蒙皮骨骼,每个 sprite 的 rect / 顶点,rect 内像素的指纹,
 * 以及每条动画在 0、¼、½、¾、1 处 SampleAnimation 后各物体的世界矩阵。
 */
const PSD_SAMPLES = 'UnityAnimationGo/Library/PackageCache/com.unity.2d.animation@3c53dae92956/Samples~/AnimationSamples'
const PSD_TRUTH = 'res/unity-psd'
interface PsdTruth {
  asset: string
  texture: { width: number; height: number; format: string }
  nodes: { path: string; pos: number[]; rot: number[]; renderer?: { sprite: string; order: number }; skin?: { root: string; bones: string[] } }[]
  sprites: { key: string; name: string; rect: number[]; pivot: number[]; ppu: number; vertices: number[]; pixels: number | null }[]
  clips: { name: string; samples: { t: number; world: Record<string, number[]> }[] }[]
}
/** 读一个 PSD 示例:角色目录里这个 .psb 和能绑上它的 .anim,按 Unity 导入的规则展开 */
function loadPsdSample(sampleDir: string, psbName: string, truth: PsdTruth) {
  const all = readUnityDir(`${PSD_SAMPLES}/${sampleDir}`)
  const files = new Map<string, string | Uint8Array>()
  for (const [p, c] of all) {
    if (p.endsWith(`/${psbName}`) || p.endsWith(`/${psbName}.meta`)) files.set(p, c)
    if (p.endsWith('.anim') && typeof c === 'string') {
      const name = str(parseUnityYaml(c).find((o) => o.type === 'AnimationClip')?.data['m_Name'])
      if (truth.clips.some((k) => k.name === name)) {
        files.set(p, c)
        files.set(`${p}.meta`, all.get(`${p}.meta`)!)
      }
    }
  }
  const ex = expandPsdImports(files).files
  const prefabPath = [...ex.keys()].find((p) => p.endsWith('.prefab'))!
  const objects = parseUnityYaml(ex.get(prefabPath) as string)
  const byId = new Map(objects.map((o) => [o.fileID, o]))
  const transforms = objects.filter((o) => o.type === 'Transform')
  type T = (typeof transforms)[number]
  const nameOf = (t: T) => str(byId.get(ref(t.data['m_GameObject']).fileID)!.data['m_Name'])
  const pathOf = (t: T): string => {
    const father = ref(t.data['m_Father']).fileID
    if (father === '0') return ''
    const parent = pathOf(byId.get(father)!)
    return parent === '' ? nameOf(t) : `${parent}/${nameOf(t)}`
  }
  const order: T[] = []
  const walk = (t: T) => {
    order.push(t)
    for (const c of list(t.data['m_Children'])) walk(byId.get(ref(c).fileID)!)
  }
  walk(transforms.find((t) => ref(t.data['m_Father']).fileID === '0')!)
  const componentsOf = (t: T) => list(byId.get(ref(t.data['m_GameObject']).fileID)!.data['m_Component']).map((c) => byId.get(ref(map(c)['component']).fileID)!)
  const metaPath = [...ex.keys()].find((p) => p.endsWith('.png.meta'))!
  const importer = map(parseYamlDocument(ex.get(metaPath) as string)['TextureImporter'])
  const atlasImage = decodePng(ex.get(metaPath.slice(0, -'.meta'.length)) as Uint8Array)
  return { ex, byId, order, pathOf, componentsOf, importer, atlasImage }
}

const truths = existsSync(PSD_TRUTH) ? readdirSync(PSD_TRUTH).filter((f) => f.endsWith('.json')) : []
for (const file of truths) {
  const truth = JSON.parse(readFileSync(`${PSD_TRUTH}/${file}`, 'utf8')) as PsdTruth
  const rel = truth.asset.slice('Assets/PsdSamples/'.length)
  const sampleDir = rel.slice(0, rel.indexOf('/Sprites/'))
  const psbName = rel.slice(rel.lastIndexOf('/') + 1)
  describe.skipIf(!existsSync(`${PSD_SAMPLES}/${rel}`))(`PSD Importer 的角色 → Spine(${rel})`, () => {
    // 样本必须在 beforeAll 里读:skip 掉的 suite 收集用例时 describe 体照样执行,示例在 UnityAnimationGo/Library 里
    // (gitignore 掉的,worktree 里没有),在 describe 体里读会 ENOENT,整个文件「no tests」,别的用例全被盖住
    let psd: ReturnType<typeof loadPsdSample>
    beforeAll(() => {
      psd = loadPsdSample(sampleDir, psbName, truth)
    })

    it('⭐ 生成的物体与 Unity 一致:层级顺序、名字、局部位置 / 旋转、排序、蒙皮骨骼', () => {
      const { byId, order, pathOf, componentsOf } = psd
      expect(order.map(pathOf)).toEqual(truth.nodes.map((n) => n.path))
      order.forEach((t, i) => {
        const n = truth.nodes[i]!
        const p = vec(t.data['m_LocalPosition'])
        const q = vec(t.data['m_LocalRotation'])
        expect(Math.hypot(p.x - n.pos[0]!, p.y - n.pos[1]!), `${n.path} 位置`).toBeLessThan(1e-4)
        expect(Math.abs(q.z - n.rot[2]!) + Math.abs(q.w - n.rot[3]!), `${n.path} 旋转`).toBeLessThan(1e-5)
        const comps = componentsOf(t)
        const renderer = comps.find((c) => c.type === 'SpriteRenderer')
        expect(renderer !== undefined, `${n.path} 有没有 SpriteRenderer`).toBe(n.renderer !== undefined)
        if (n.renderer !== undefined) expect(num(renderer!.data['m_SortingOrder']), `${n.path} 排序`).toBe(n.renderer.order)
        const skin = comps.find((c) => c.type === 'MonoBehaviour')
        expect(skin !== undefined, `${n.path} 有没有 SpriteSkin`).toBe(n.skin !== undefined)
        if (n.skin !== undefined) expect(list(skin!.data['m_BoneTransforms']).map((b) => pathOf(byId.get(ref(b).fileID)!)), `${n.path} 蒙皮骨骼`).toEqual(n.skin.bones)
      })
    })

    it('⭐ sprite 与 Unity 一致:rect、顶点(Unity 单位,相对轴心);rect 内可见像素逐字节相同', () => {
      const { importer, atlasImage } = psd
      const sheet = list(map(importer['spriteSheet'])['sprites']).map(map)
      const ppu = num(importer['spritePixelsToUnits'])
      for (const s of truth.sprites) {
        // 名字表里有的,fileID 与 Unity 一致;没有的(Unity 按标识串哈希,算法不公开)按名字认
        const record = spriteRecord(importer, s.key.split(':')[1]!, '', atlasImage)
          ?? spriteRecord(importer, str(sheet.find((x) => str(x['name']) === s.name)?.['internalID']), '', atlasImage)
        expect(record, s.name).not.toBeNull()
        // Unity 把超过 Max Size 的贴图连 rect / ppu 一起缩小
        const k = s.ppu / ppu
        expect([record!.rect.x, record!.rect.y, record!.rect.width, record!.rect.height].map((v) => v * k), `${s.name} rect`).toEqual(s.rect)
        // 没画网格的 sprite,Unity 导入时生成紧凑网格(裁掉透明像素),这里用整个矩形 —— 画出来一样,不比顶点
        if (record!.vertices.length * 2 === s.vertices.length) {
          record!.vertices.forEach((v, i) => {
            const d = Math.hypot((v.x - record!.pivot.x) / ppu - s.vertices[i * 2]!, (v.y - record!.pivot.y) / ppu - s.vertices[i * 2 + 1]!)
            expect(d, `${s.name} 第 ${i} 个顶点`).toBeLessThan(1e-4)
          })
        }
        if (s.pixels === null || truth.texture.format !== 'RGBA32' || k !== 1) continue
        let h = 2166136261
        for (let y = record!.rect.y; y < record!.rect.y + record!.rect.height; y++) {
          for (let x = record!.rect.x; x < record!.rect.x + record!.rect.width; x++) {
            const o = ((atlasImage.height - 1 - y) * atlasImage.width + x) * 4
            const transparent = atlasImage.data[o + 3] === 0
            for (let c = 0; c < 4; c++) h = Math.imul(h ^ (transparent ? 0 : atlasImage.data[o + c]!), 16777619) >>> 0
          }
        }
        expect(h, `${s.name} 像素指纹`).toBe(s.pixels)
      }
    })

    it('⭐ 动画取样与 Unity 的 SampleAnimation 一致(各物体相对根物体的世界矩阵)', () => {
      const scene = loadUnityScene(psd.ex)
      let checked = 0
      for (const clip of truth.clips) {
        for (const sample of clip.samples) {
          const world = scene.worldAt(clip.name, sample.t)
          for (const [path, m] of Object.entries(sample.world)) {
            const o = world.get(path)!
            const e = Math.max(...[o.a, o.b, o.c, o.d, o.x, o.y].map((v, i) => Math.abs(v - m[i]!)))
            expect(e, `${clip.name}@${sample.t} ${path}`).toBeLessThan(1e-4)
            checked++
          }
        }
      }
      expect(checked).toBe(truth.clips.reduce((n, c) => n + c.samples.reduce((m, s) => m + Object.keys(s.world).length, 0), 0))
    })

    it('⭐ 读成 Spine 后与 Unity 的规则逐点一致(顶点 + 画了哪些、先后)', () => {
      // IK 示例的动画驱动的是场景里的 IK 目标(不在 prefab 里),Unity 也绑不上 —— 只比 setup
      expect(compareWithUnity(psd.ex)).toBeGreaterThan(truth.clips.length > 0 ? 10 : 0)
    })
  })
}

/**
 * attachment 自己的颜色:导出时乘进每个挂图物体的颜色(曲线按它缩放),同一 slot 下的物体颜色因此各不相同。
 * 读回要把每个物体的颜色拆成 slot 颜色 × attachment 颜色;Unity 里单独改过某一件、与同 slot 的不成比例的,报近似。
 */
describe('attachment 颜色读回:同一 slot 下颜色不同的物体 → slot 颜色 × attachment 颜色', () => {
  const json = {
    skeleton: { hash: 'x', spine: '4.1.23', x: 0, y: 0, width: 64, height: 64 },
    bones: [{ name: 'root' }],
    slots: [
      { name: 'shadow', bone: 'root', attachment: 'shadow' },
      { name: 'swap', bone: 'root', attachment: 'a', color: 'ff8080ff' },
    ],
    skins: [{
      name: 'default',
      attachments: {
        shadow: { shadow: { color: '00000049', width: 16, height: 16 } },
        swap: { a: { color: 'ff000080', width: 16, height: 16 }, b: { color: '40c0ffff', x: 20, width: 16, height: 16 } },
      },
    }],
    animations: {
      blink: {
        slots: {
          shadow: { rgba: [{ color: 'ffffffff', curve: [0.1, 1, 0.3, 1, 0.1, 1, 0.3, 1, 0.1, 1, 0.3, 1, 0.1, 0.9, 0.2, 0] }, { time: 0.5, color: 'ffffff00' }] },
          swap: {
            attachment: [{ time: 0.5, name: 'b' }],
            rgb: [{ time: 0.25, color: 'ffffff', curve: [0.3, 1, 0.4, 0.5, 0.3, 1, 0.4, 0.6, 0.3, 1, 0.4, 0.2] }, { time: 0.75, color: '20ff80' }],
          },
        },
      },
    },
  }
  const part = fromJson(json)
  const atlas = parseAtlas(['p.png', 'size: 64, 64', 'shadow', '  bounds: 0, 0, 16, 16', 'a', '  bounds: 16, 0, 16, 16', 'b', '  bounds: 32, 0, 16, 16', ''].join('\n'))
  const sources = new Map<string, Image>([['p.png', { width: 64, height: 64, data: new Uint8Array(64 * 64 * 4).fill(255) }]])
  const unity = exportToUnity(part, atlas, sources, { name: 'x', pixelsPerUnit: PPU, renderPipeline: 'urp' })
  const files = new Map(unity.files.map((f) => [f.path, f.content]))

  it('⭐ 逐物体、逐时刻与 Unity 的规则一致,不报近似;颜色不同的两件各带自己的 attachment 颜色', () => {
    const imported = importUnity(files, { pixelsPerUnit: PPU })
    expect(imported.issues.filter((i) => i.path.includes('color['))).toEqual([])
    expect(compareColorsWithUnity(files)).toBeGreaterThan(0)
    const swap = ((imported.json['skins'] as Record<string, unknown>[])[0]!['attachments'] as Record<string, Record<string, Record<string, unknown>>>)['swap']!
    // 每个通道取最亮的一件当参照:r 是 a(ff),g / b / a 是 b —— 两件都不是白的
    expect(swap['a']!['color']).toBeDefined()
    expect(swap['b']!['color']).toBeDefined()
  })

  it('在 Unity 里单独改了一件的颜色(与同 slot 的另一件不成比例)→ 报 approximated,不静默取第一个', () => {
    // swap__b 的 m_Color.r 原本 = slot 的 r × 0x40/255,改成 0.9 —— 动画里它的 r 曲线没跟着变
    const edited = new Map(files)
    const docs = (edited.get('x.prefab') as string).split(/^(?=--- )/m)
    const go = docs.find((d) => /^--- !u!1 &/.test(d) && /m_Name: swap__b$/m.test(d))!
    const id = /^--- !u!1 &(\d+)/.exec(go)![1]!
    const i = docs.findIndex((d) => /^--- !u!212 &/.test(d) && d.includes(`m_GameObject: {fileID: ${id}}`))
    docs[i] = docs[i]!.replace(/m_Color: \{r: [^,]+,/, 'm_Color: {r: 0.9,')
    edited.set('x.prefab', docs.join(''))
    const imported = importUnity(edited, { pixelsPerUnit: PPU })
    expect(imported.issues.some((x) => x.level === 'approximated' && /(^|\.)color\[swap\]$/.test(x.path))).toBe(true)
  })
})

describe('SkinnedMeshRenderer 的顶点色读回:按工程色彩空间换回 sRGB', () => {
  // cloth 有 deform → SkinnedMeshRenderer,颜色(slot × attachment)烘在顶点色里
  const json = {
    skeleton: { hash: 'x', spine: '4.1.23', x: 0, y: 0, width: 64, height: 64 },
    bones: [{ name: 'root' }],
    slots: [{ name: 'cloth', bone: 'root', attachment: 'cloth', color: 'c0c0c0ff' }],
    skins: [{
      name: 'default',
      attachments: { cloth: { cloth: { type: 'mesh', color: 'd1c1a4ff', uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3], vertices: [0, 0, 16, 0, 16, 16, 0, 16], hull: 4, width: 16, height: 16 } } },
    }],
    animations: { wave: { attachments: { default: { cloth: { cloth: { deform: [{}, { time: 0.5, vertices: [3, 0] }, { time: 1 }] } } } } } },
  }
  const part = fromJson(json)
  const atlas = parseAtlas(['p.png', 'size: 32, 32', 'cloth', '  bounds: 0, 0, 16, 16', ''].join('\n'))
  const sources = new Map<string, Image>([['p.png', { width: 32, height: 32, data: new Uint8Array(32 * 32 * 4).fill(255) }]])
  const filesOf = (colorSpace: 'linear' | 'gamma') =>
    new Map(exportToUnity(part, atlas, sources, { name: 'x', pixelsPerUnit: PPU, renderPipeline: 'urp', colorSpace }).files.map((f) => [f.path, f.content]))
  const want = [0xc0 * 0xd1, 0xc0 * 0xc1, 0xc0 * 0xa4].map((v) => v / 255 / 255)

  for (const colorSpace of ['linear', 'gamma'] as const) {
    it(`⭐ ${colorSpace}:导出时怎么写的就怎么读回,颜色与原来相同,不报近似`, () => {
      const imported = importUnity(filesOf(colorSpace), { pixelsPerUnit: PPU, colorSpace })
      expect(imported.issues.filter((i) => i.path === 'SkinnedMeshRenderer')).toEqual([])
      const back = fromJson(imported.json)
      const slot = unpackRgba(back.slots[0]!.color)
      const own = unpackRgba((back.skins[0]!.slots[0]!.attachments[0]!.data['color'] as number | undefined) ?? -1)
      want.forEach((v, k) => expect(Math.abs(slot[k]! * own[k]! - v), `通道 ${k}`).toBeLessThan(1.01 / 255))
    })
  }

  it('不知道工程的色彩空间:按 Linear 读,报 approximated(写明是哪个物体)', () => {
    const imported = importUnity(filesOf('linear'), { pixelsPerUnit: PPU })
    const issue = imported.issues.find((i) => i.path === 'SkinnedMeshRenderer')
    expect(issue?.level).toBe('approximated')
    expect(issue!.message).toContain('cloth')
  })
})
