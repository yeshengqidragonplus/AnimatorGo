import { existsSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { readSkeletonPart } from '../../spine-format/binary/readSkeleton.ts'
import type { AnimationData } from '../../spine-format/binary/readAnimations.ts'
import { parseAtlas } from '../../core/atlas.ts'
import { decodePng, type Image } from '../../unity/png.ts'
import { poseAt, setupPose } from '../../spine-eval/pose.ts'
import { attachmentVertices } from '../../spine-eval/vertices.ts'
import { drawOrderAt, slotAttachmentsAt } from '../../spine-eval/slots.ts'
import { slotColorAt, unpackRgba } from '../../spine-eval/color.ts'
import { lastPerProperty } from '../../spine-format/duplicateTimelines.ts'
import { evaluateRealCurve, realKeys, CUBIC, CONSTANT } from '../../cocos/curve.ts'
import { RUNTIME_SCRIPTS } from '../../cocos/ids.ts'
import { clipCovers, clipMesh, createClipBuffers, skinVertices, triangulate } from '../../../tools/cocos/runtime/AnimatorGoSkinning.ts'
import { exportToCocos, type AttachmentNode } from './export.ts'
import { loadCocosScene, parseClip } from './cocosEval.ts'

/**
 * Spine → Cocos 的**端到端校验**:把写出的 prefab 和 `.anim` 读回来,**按 Cocos 的规则**(cocosEval.ts)算出每个 Sprite
 * 画在哪、哪些亮着、先后、颜色,和 Spine 自己的求值比。产物「像 Cocos 文件」没有意义,要的是引擎按它的规则播出来和 Spine 一样。
 *
 * 图片部件、网格(AnimatorGoMesh,和运行时同一份蒙皮代码)、遮罩多边形都要精确(0.05 像素);谁被遮按 Spine 的绘制循环模拟出来比。
 */

const SKELETON = 'res/spine/4.1/MX2_cat.skel.bytes'
const ATLAS = 'res/spine/4.1/MX2_cat.atlas.txt'
const PAGE = 'res/spine/4.1/MX2_cat.png'
const hasAssets = [SKELETON, ATLAS, PAGE].every(existsSync)

const MC2 = 'E:/UnityProject/MergeCooking2/MergeCooking2/Assets/Export/Spine/NewSpine'
const SAMPLES: { label: string; skel: string; atlas: string }[] = [
  { label: 'MX2_cat 4.1', skel: SKELETON, atlas: ATLAS },
  { label: 'MX2_cat 3.8', skel: 'res/spine/3.8/MX2_cat.skel.bytes', atlas: 'res/spine/3.8/MX2_cat.atlas.txt' },
  { label: 'BBQ_grill(100 个 region、换图)', skel: `${MC2}/BBQ/BBQ_grill.skel.bytes`, atlas: `${MC2}/BBQ/BBQ_grill.atlas.txt` },
  { label: 'blackrichwoman(6 套皮肤)', skel: `${MC2}/Customer11/blackrichwoman.skel.bytes`, atlas: `${MC2}/Customer11/blackrichwoman.atlas.txt` },
  { label: 'customer_1(加权网格 deform)', skel: `${MC2}/Customer1/customer_1.skel.bytes`, atlas: `${MC2}/Customer1/customer_1.atlas.txt` },
  { label: 'Female staff(linkedmesh)', skel: `${MC2}/Customer12/Female staff.skel.bytes`, atlas: `${MC2}/Customer12/Female staff.atlas.txt` },
  { label: 'Easter_card(遮罩 + deform + 绘制顺序)', skel: `${MC2}/CardCollectMain/Easter_card.skel.bytes`, atlas: `${MC2}/CardCollectMain/Easter_card.atlas.txt` },
]

/** 关键帧时刻(含 deform / sequence 的帧)和相邻关键帧的中点 */
function sampleTimesOf(anim: AnimationData): number[] {
  const times = new Set<number>([0])
  for (const t of anim.timelines) {
    const frames = t.kind === 'deform' || t.kind === 'sequence' ? (t.frames[0] as { frames: Record<string, unknown>[] }).frames : t.frames
    for (const f of frames) times.add(Number(f['time'] ?? 0))
  }
  const sorted = [...times].sort((a, b) => a - b)
  return [...sorted, ...sorted.slice(1).map((x, i) => (x + sorted[i]!) / 2)]
}

/**
 * ⚠️ 样本一律在 beforeAll 里读,不能放在 describe 体里:skip 掉的 suite 收集用例时 describe 体照样执行,
 * 样本不在(res/ 是 gitignore 掉的;MergeCooking2 是本机的)就 ENOENT,整个文件「no tests」。
 */
function exportSample(sample: (typeof SAMPLES)[number]) {
  const part0 = readSkeletonPart(new Uint8Array(readFileSync(sample.skel)))
  const atlas = parseAtlas(readFileSync(sample.atlas, 'utf8'))
  const dir = sample.atlas.slice(0, sample.atlas.lastIndexOf('/'))
  const sources = new Map<string, Image>(atlas.pages.map((p) => [p.name, decodePng(new Uint8Array(readFileSync(`${dir}/${p.name}`)))]))
  const result = exportToCocos(part0, atlas, sources, { name: 'sample' })
  const files = new Map(result.files.map((f) => [f.path, f.content]))
  const scene = loadCocosScene(files, 'sample.prefab')
  // 求值用展开过 linkedmesh 的骨架(导出器内部也是)—— 这里只拿原骨架的动画和 slot,attachment 从导出结果取
  const part = part0
  const initialSkin = result.issues.find((i) => i.path === 'skin')?.message.match(/初始是 "([^"]+)"/)?.[1] ?? part.skins[0]!.name
  const is38 = part.header.major === '3.8'

  /** 某套皮肤下这个节点该不该亮(皮肤那一维) */
  const inSkin = (n: AttachmentNode, skin: string) => {
    if (n.skin === skin) return true
    if (n.skin !== part.skins[0]!.name) return false
    const named = part.skins.find((s) => s.name === skin)
    return named === undefined || !named.slots.some((e) => e.slot === n.slot && e.attachments.some((a) => a.key === n.key))
  }
  /**
   * 某一时刻:每个 attachment 节点按 Cocos 规则画出来的位置 vs Spine。region 比四角;网格 / 遮罩比每个顶点
   * (cocosEval 用运行时那份蒙皮代码按骨骼节点的世界矩阵算)。返回超出容差最多的那个
   */
  function worstAt(anim: AnimationData | null, t: number): { excess: number; where: string } {
    const kept = anim === null ? null : { ...anim, timelines: lastPerProperty(anim.timelines).kept }
    // Cocos 的节点没有斜切、只有完整继承,导出时忽略了(报近似);Spine 这边按同样的规则求值,别的地方必须精确
    const pose = kept === null ? setupPose(part, { unityCompatible: true }) : poseAt(part, kept, t, { unityCompatible: true })
    const clipName = anim?.name ?? null
    const world = scene.worldAt(clipName, t)
    const meshes = scene.meshesAt(clipName, t)
    const polygons = scene.clipPolygonsAt(clipName, t)
    let excess = -Infinity
    let where = ''
    for (const n of result.attachments) {
      if (n.frame !== undefined) continue
      // linkedmesh 跟着父网格的 deform 时间轴变形:Spine 这边按父网格的键名找时间轴
      const target = n.deformSource === null ? { a: n.attachment, skin: n.skin } : { a: { ...n.attachment, key: n.deformSource.key, name: n.deformSource.key }, skin: n.deformSource.skin }
      const spine = attachmentVertices(part, atlas, target.a, target.skin, n.slot, pose, kept, t)
      let cocos: { x: number; y: number }[]
      if (n.kind === 'sprite') {
        // Sprite 的矩形:UITransform 的大小和锚点(cocosEval.drawnAt 同一个算法,这里不管亮没亮)
        const m = world.get(n.path)!
        const tr = scene.nodes.find((x) => x.path === n.path)!.transform!
        const l = -tr.anchorX * tr.width, rr = (1 - tr.anchorX) * tr.width, b = -tr.anchorY * tr.height, tp = (1 - tr.anchorY) * tr.height
        cocos = [[l, b], [rr, b], [rr, tp], [l, tp]].map(([px, py]) => ({ x: m.a * px! + m.b * py! + m.x, y: m.c * px! + m.d * py! + m.y }))
      } else if (n.kind === 'mesh') {
        cocos = meshes.get(n.path)!.vertices
      } else {
        cocos = polygons.get(n.path)!
      }
      expect(cocos.length, n.attachment.name).toBe(spine.length)
      const allowed = 0.05
      spine.forEach((p, i) => {
        const d = Math.hypot(p.x - cocos[i]!.x, p.y - cocos[i]!.y) - allowed
        if (d > excess) { excess = d; where = `${n.kind} ${n.attachment.name} 第 ${i} 个顶点 @${anim?.name ?? 'setup'} ${t.toFixed(3)} 偏 ${(d + allowed).toFixed(2)} 像素(允许 ${allowed.toFixed(2)})` }
      })
    }
    return { excess, where }
  }

  return { part, atlas, result, files, scene, initialSkin, is38, inSkin, worstAt }
}

for (const sample of SAMPLES) {
describe.skipIf(!hasAssets || !existsSync(sample.skel) || !existsSync(sample.atlas))(`Spine → Cocos 端到端(${sample.label})`, () => {
  let exported: ReturnType<typeof exportSample>
  beforeAll(() => {
    exported = exportSample(sample)
  })

  it('每个画得出来的 attachment 都有节点(图片 Sprite / 网格 AnimatorGoMesh,都带 UITransform + Sorting2D;遮罩 AnimatorGoClip);根上挂着 Animation,每条动画一个 .anim', () => {
    const { part, result, scene, files } = exported
    const drawable = part.skins.flatMap((s) => s.slots.flatMap((e) => e.attachments.filter((a) => a.type === 'region' || a.type === 'mesh' || a.type === 'clipping')))
    expect(result.attachments.length).toBeGreaterThanOrEqual(drawable.length - result.issues.filter((i) => i.path.startsWith('region.')).length)
    const clipPaths = result.attachments.filter((n) => n.kind === 'clip').map((n) => n.path)
    for (const n of result.attachments) {
      const node = scene.nodes.find((x) => x.path === n.path)!
      expect(node, n.path).toBeDefined()
      if (n.kind === 'clip') {
        expect(node.clip, n.path).not.toBeNull()
        expect(node.clip!.counts.length).toBe(n.attachment.data['vertexCount'])
        continue
      }
      expect(node.transform, n.path).not.toBeNull()
      expect(node.sortingOrder, n.path).toBe(n.slot)
      if (n.kind === 'sprite') {
        expect(n.attachment.type).toBe('region')
        expect(node.sprite, n.path).not.toBeNull()
      } else {
        expect(node.mesh, n.path).not.toBeNull()
        const m = node.mesh!
        expect(m.counts.length).toBe(n.attachment.type === 'region' ? 4 : n.attachment.data['vertexCount'])
        expect(m.uvs.length).toBe(m.counts.length * 2)
        expect(m.indices.length % 3).toBe(0)
        expect(Math.max(...m.indices)).toBeLessThan(m.counts.length)
        expect(m.influences.length).toBe(m.counts.reduce((a, b) => a + b, 0) * 4)
        expect(m.shapeWeights.length * m.influences.length / 2).toBe(m.shapes.length)
        // 可能被遮的网格认识全部遮罩
        if (m.clips.length > 0) expect(m.clips).toEqual(clipPaths)
      }
    }
    for (const anim of part.animations) expect(scene.clips.has(anim.name), anim.name).toBe(true)
    expect([...files.keys()].filter((p) => p.endsWith('.anim')).length).toBe(part.animations.length)
    expect([...files.keys()].filter((p) => p.endsWith('.png')).length).toBe(result.images.size)
  })

  it('⭐ setup 姿势:按 Cocos 的规则算出的四角 / 顶点与 Spine 一致(0.05 像素)', () => {
    const { worstAt } = exported
    const { excess, where } = worstAt(null, 0)
    expect(excess, where).toBeLessThanOrEqual(0)
  })

  it('⭐ 每条动画的每个关键帧,以及相邻关键帧的中点:位置与 Spine 一致(贝塞尔走引擎的求值;加权网格、deform、遮罩多边形都算)', () => {
    const { part, worstAt } = exported
    let worst = { excess: -Infinity, where: '' }
    for (const anim of part.animations) {
      for (const t of sampleTimesOf(anim)) {
        const w = worstAt(anim, t)
        if (w.excess > worst.excess) worst = w
      }
    }
    expect(worst.excess, worst.where).toBeLessThanOrEqual(0)
  })

  it('⭐ 显隐与先后:每个时刻亮着的部件和 Spine 的 slot 换图一致,按 sortingOrder 排出来的顺序就是 Spine 的绘制顺序', () => {
    const { part, result, scene, initialSkin, inSkin } = exported
    const byPath = new Map(result.attachments.map((n) => [n.path, n]))
    const check = (anim: AnimationData | null, t: number) => {
      const kept = anim === null ? null : { ...anim, timelines: lastPerProperty(anim.timelines).kept }
      const expectedKey = slotAttachmentsAt(part, kept, t)
      const drawn = scene.drawnAt(anim?.name ?? null, t).map((d) => byPath.get(d.node.path)!).filter((n) => n !== undefined)
      // 亮着的都该亮:slot 现在就是这个键名,而且在初始皮肤里
      for (const n of drawn) {
        expect(expectedKey[n.slot], `${n.path} @${anim?.name ?? 'setup'} ${t.toFixed(3)} 亮着,Spine 的 slot 是 "${expectedKey[n.slot]}"`).toBe(n.key)
        expect(inSkin(n, initialSkin), `${n.path} 不在初始皮肤 ${initialSkin} 里却亮着`).toBe(true)
      }
      // 该亮的都亮了(序列帧只要求有且仅有一帧亮)
      const drawnSlots = new Map<number, AttachmentNode[]>()
      for (const n of drawn) drawnSlots.set(n.slot, [...(drawnSlots.get(n.slot) ?? []), n])
      result.attachments.forEach((n) => {
        if (n.kind === 'clip') return // 遮罩不画
        if (expectedKey[n.slot] !== n.key || !inSkin(n, initialSkin)) return
        const list = drawnSlots.get(n.slot) ?? []
        if (n.frame === undefined) expect(list.some((d) => d.path === n.path), `${n.path} @${anim?.name ?? 'setup'} ${t.toFixed(3)} 该亮没亮`).toBe(true)
        else expect(list.length, `${n.slot} 的序列帧 @${anim?.name ?? 'setup'} ${t.toFixed(3)} 亮着 ${list.length} 帧`).toBe(1)
      })
      // 先后
      const order = drawOrderAt(part, kept, t)
      const rank = new Map(order.map((slot, i) => [slot, i]))
      const ranks = drawn.map((n) => rank.get(n.slot)!)
      for (let i = 1; i < ranks.length; i++) expect(ranks[i]! >= ranks[i - 1]!, `@${anim?.name ?? 'setup'} ${t.toFixed(3)} 第 ${i} 个画的 ${drawn[i]!.path} 排在 ${drawn[i - 1]!.path} 后面,Spine 里相反`).toBe(true)
    }
    check(null, 0)
    for (const anim of part.animations) for (const t of sampleTimesOf(anim)) check(anim, t)
  })

  it('⭐ 遮罩:每个时刻谁被哪个遮罩裁,和 Spine 的绘制循环一致;被裁的都是 AnimatorGoMesh', () => {
    const { part, result, scene, initialSkin, inSkin } = exported
    const clipNodes = result.attachments.filter((n) => n.kind === 'clip')
    if (clipNodes.length === 0) return
    const byPath = new Map(result.attachments.map((n) => [n.path, n]))
    const check = (anim: AnimationData | null, t: number) => {
      const kept = anim === null ? null : { ...anim, timelines: lastPerProperty(anim.timelines).kept }
      const keys = slotAttachmentsAt(part, kept, t)
      const order = drawOrderAt(part, kept, t)
      // Spine 的绘制循环(SkeletonClipping):画到挂着遮罩的 slot 开始裁(已经在裁就忽略),之后每个 slot 都裁,画完 endSlot 结束
      const expected = new Map<number, number>()
      let clipping: number | null = null
      let end = -1
      for (const s of order) {
        const clipNode = clipNodes.find((n) => n.slot === s && n.key === keys[s] && inSkin(n, initialSkin))
        if (clipNode !== undefined) {
          if (clipping === null) {
            clipping = s
            end = clipNode.attachment.data['endSlot'] as number
          }
          continue
        }
        if (clipping !== null) {
          expected.set(s, clipping)
          if (end === s) clipping = null
        }
      }
      for (const d of scene.drawnAt(anim?.name ?? null, t)) {
        const n = byPath.get(d.node.path)
        if (n === undefined) continue
        const want = expected.get(n.slot)
        const got = d.clippedBy === null ? undefined : byPath.get(d.clippedBy.path)!.slot
        expect(got, `${n.path} @${anim?.name ?? 'setup'} ${t.toFixed(3)} 该被 slot ${want} 的遮罩裁,实际 ${got}`).toBe(want)
        if (want !== undefined) expect(d.kind, `${n.path} 被遮却不是网格`).toBe('mesh')
      }
    }
    check(null, 0)
    for (const anim of part.animations) for (const t of sampleTimesOf(anim)) check(anim, t)
  })

  it('⭐ 颜色:每个亮着的部件 = slot 颜色 × attachment 颜色(1.5/255 以内)', () => {
    const { part, result, scene, is38 } = exported
    const byPath = new Map(result.attachments.map((n) => [n.path, n]))
    const check = (anim: AnimationData | null, t: number) => {
      const kept = anim === null ? [] : lastPerProperty(anim.timelines).kept
      for (const d of scene.drawnAt(anim?.name ?? null, t)) {
        const n = byPath.get(d.node.path)
        if (n === undefined) continue
        const slot = part.slots[n.slot]!
        const tls = kept.filter((tl) => tl.owner === n.slot && (tl.kind === 'color' || tl.kind === 'twoColor' || tl.kind.startsWith('slotColor')))
        const c = slotColorAt(tls, unpackRgba(slot.color), t, is38)
        const own = unpackRgba(n.attachment.data['color'] as number)
        for (let k = 0; k < 4; k++) expect(Math.abs(d.color[k]! - c[k]! * own[k]! * 255), `${n.path} @${anim?.name ?? 'setup'} ${t.toFixed(3)} 通道 ${k}`).toBeLessThan(1.5)
      }
    }
    check(null, 0)
    for (const anim of part.animations) for (const t of sampleTimesOf(anim)) check(anim, t)
  })

  it('每条轨道都指向 prefab 里真实存在的节点 / 组件(指不到的 Cocos 直接忽略,不报错)', () => {
    const { scene } = exported
    for (const clip of scene.clips.values()) for (const tr of clip.tracks) expect(scene.resolveTrack(tr), `${clip.name}: ${tr.nodePath} ${tr.component ?? ''} ${tr.property}`).not.toBeNull()
  })

  it('没有一条曲线在同一时刻(引擎按 1e-6 认)有两个键', () => {
    const { files } = exported
    for (const [p, content] of files) {
      if (!p.endsWith('.anim')) continue
      const clip = parseClip(content as string)
      for (const tr of clip.tracks) {
        const lists = tr.kind === 'object' ? [tr.objectTimes] : tr.channels.map((c) => c.map((k) => k.time))
        for (const times of lists) for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!, `${p} ${tr.nodePath}.${tr.property}`).toBeGreaterThan(1e-6)
      }
    }
  })

  it('有损的地方都报出来了:约束一条 loss;网格 / 遮罩走脚本组件只报 info(runtime),不再是 loss;图片部件没有 loss', () => {
    const { part, result } = exported
    const kinds = new Set(result.issues.map((i) => `${i.level}:${i.path.split('.')[0]}`))
    const hasMesh = part.skins.some((s) => s.slots.some((e) => e.attachments.some((a) => a.type === 'mesh' || a.type === 'linkedmesh' || a.type === 'clipping')))
    expect(result.runtime).toBe(hasMesh)
    expect(kinds.has('info:runtime')).toBe(hasMesh)
    expect(result.issues.filter((i) => i.level === 'loss' && /^(mesh|deform|clipping)\./.test(i.path))).toEqual([])
    if (part.ik.length > 0) expect(kinds.has('loss:ik')).toBe(true)
    expect(result.issues.filter((i) => i.level === 'loss' && i.path.startsWith('region.'))).toEqual([])
  })

  it('图:prefab 和动画引用的每个 spriteFrame 都有对应的 PNG,尺寸与 meta 一致', () => {
    const { result, scene, files } = exported
    const frames = new Set(result.images.size > 0 ? [...result.images.values()].map((i) => `${i.uuid}@f9941`) : [])
    for (const n of scene.nodes) {
      if (n.sprite !== null) expect(frames.has(n.sprite.spriteFrame), n.path).toBe(true)
      if (n.mesh !== null) expect(frames.has(n.mesh.spriteFrame), n.path).toBe(true)
    }
    for (const img of result.images.values()) {
      const meta = JSON.parse(files.get(`${img.path}.meta`) as string) as { subMetas: Record<string, { userData: { width: number; height: number } }> }
      expect(meta.subMetas['f9941']!.userData.width).toBe(img.width)
      expect(meta.subMetas['f9941']!.userData.height).toBe(img.height)
      const png = decodePng(files.get(img.path) as Uint8Array)
      expect([png.width, png.height]).toEqual([img.width, img.height])
    }
  })

  it('皮肤:具名皮肤的节点包在一层按皮肤开关的节点里,初始皮肤的亮、别的灭', () => {
    const { part, result, scene, initialSkin, inSkin } = exported
    const named = part.skins.filter((s, i) => i > 0 && s.slots.length > 0)
    if (named.length === 0) return
    for (const n of result.attachments) {
      const node = scene.nodes.find((x) => x.path === n.path)!
      const wrapper = node.parent!
      const skinDependent = n.skin !== part.skins[0]!.name || named.some((s) => s.slots.some((e) => e.slot === n.slot && e.attachments.some((a) => a.key === n.key)))
      if (!skinDependent) continue
      expect(wrapper.name, n.path).toContain(`(${n.skin})`)
      expect(wrapper.active, `${n.path} 的皮肤开关`).toBe(inSkin(n, initialSkin))
    }
  })
})
}

// ─── 曲线换算 ────────────────────────────────────────────────────────────────

describe('Spine 贝塞尔 → Cocos 加权切线(按引擎的求值公式)', () => {
  it('⭐ 控制点逐点还原:任意时刻与直接算贝塞尔一致', () => {
    // 一段 0→2 秒、值 10→50 的贝塞尔,控制点 (0.3, 40) (1.2, 12)
    const keys = realKeys([0, 2], [10, 50], [{ curve: 'bezier', c: [0.3, 40, 1.2, 12] }])
    expect(keys[0]!.mode).toBe(CUBIC)
    const bezier = (t: number) => {
      // 按 x 解参数再求 y,和 Spine / Cocos 都一样
      const px = [0, 0.3, 1.2, 2], py = [10, 40, 12, 50]
      let lo = 0, hi = 1
      for (let i = 0; i < 60; i++) {
        const m = (lo + hi) / 2
        const u = 1 - m
        const x = u * u * u * px[0]! + 3 * u * u * m * px[1]! + 3 * u * m * m * px[2]! + m * m * m * px[3]!
        if (x < t) lo = m; else hi = m
      }
      const m = (lo + hi) / 2, u = 1 - m
      return u * u * u * py[0]! + 3 * u * u * m * py[1]! + 3 * u * m * m * py[2]! + m * m * m * py[3]!
    }
    for (let t = 0; t <= 2; t += 0.05) expect(Math.abs(evaluateRealCurve(keys, t) - bezier(t))).toBeLessThan(1e-6)
  })

  it('控制点贴在端点上也精确(权重 0);阶梯保持前值;第一键之前 / 最后一键之后保持端值', () => {
    const stuck = realKeys([0, 1], [0, 8], [{ curve: 'bezier', c: [0, 0, 1, 8] }])
    expect(Math.abs(evaluateRealCurve(stuck, 0.5) - 4)).toBeLessThan(1e-9)
    const stepped = realKeys([0, 1], [3, 7], [{ curve: 'stepped' }])
    expect(stepped[0]!.mode).toBe(CONSTANT)
    expect(evaluateRealCurve(stepped, 0.999)).toBe(3)
    expect(evaluateRealCurve(stepped, 1)).toBe(7)
    expect(evaluateRealCurve(stepped, -1)).toBe(3)
    expect(evaluateRealCurve(stepped, 5)).toBe(7)
  })
})

// ─── 运行时的纯数学 ──────────────────────────────────────────────────────────

/** 三角形列表的总面积(绝对值) */
function trianglesArea(pos: ArrayLike<number>, idx: ArrayLike<number>, count: number): number {
  let area = 0
  for (let t = 0; t + 2 < count; t += 3) {
    const [a, b, c] = [idx[t]!, idx[t + 1]!, idx[t + 2]!]
    area += Math.abs((pos[b * 2]! - pos[a * 2]!) * (pos[c * 2 + 1]! - pos[a * 2 + 1]!) - (pos[b * 2 + 1]! - pos[a * 2 + 1]!) * (pos[c * 2]! - pos[a * 2]!)) / 2
  }
  return area
}

describe('Cocos 运行时的纯数学(tools/cocos/runtime/AnimatorGoSkinning.ts,引擎里跑的就是这份)', () => {
  it('蒙皮:两根骨骼各一半权重落在两者之间;deform 先加偏移再蒙皮(Spine 同序)', () => {
    // 骨骼 0 恒等;骨骼 1 平移 (10, 0) 再转 90°:x' = −y + 10,y' = x
    const mats = [1, 0, 0, 1, 0, 0, 0, -1, 1, 0, 10, 0]
    const counts = [2]
    const influences = [0, 2, 0, 0.5, 1, 2, 0, 0.5]
    const out = new Float32Array(2)
    skinVertices(counts, influences, mats, null, out)
    expect([...out]).toEqual([6, 1])
    // 偏移逐影响:骨骼 0 的影响 +(1, 0),骨骼 1 的 +(0, 1)
    skinVertices(counts, influences, mats, [1, 0, 0, 1], out)
    expect(out[0]).toBeCloseTo((3 + 9) / 2, 6)
    expect(out[1]).toBeCloseTo((0 + 2) / 2, 6)
  })

  it('裁剪:正方形按三角形遮罩裁,面积等于交集,裁出来的点的 uv 按位置插值', () => {
    const pos = [0, 0, 10, 0, 10, 10, 0, 10]
    const uv = [0, 1, 1, 1, 1, 0, 0, 0]
    const idx = [0, 1, 2, 0, 2, 3]
    const poly = [0, 0, 10, 0, 0, 10]
    const tris: number[] = []
    triangulate(poly, 3, tris)
    const out = createClipBuffers()
    clipMesh(pos, uv, idx, 6, poly, tris, out)
    expect(out.truncated).toBe(false)
    expect(trianglesArea(out.pos, out.idx, out.indexCount)).toBeCloseTo(50, 6)
    for (let i = 0; i < out.vertexCount; i++) {
      expect(out.uv[i * 2]).toBeCloseTo(out.pos[i * 2]! / 10, 6)
      expect(out.uv[i * 2 + 1]).toBeCloseTo(1 - out.pos[i * 2 + 1]! / 10, 6)
      // 都在遮罩里
      expect(out.pos[i * 2]! + out.pos[i * 2 + 1]!).toBeLessThanOrEqual(10 + 1e-6)
    }
    // 遮罩顺时针给也一样
    clipMesh(pos, uv, idx, 6, [0, 0, 0, 10, 10, 0], [0, 1, 2], out)
    expect(trianglesArea(out.pos, out.idx, out.indexCount)).toBeCloseTo(50, 6)
    // 完全在外面:什么都不剩
    clipMesh(pos, uv, idx, 6, [20, 20, 30, 20, 20, 30], [0, 1, 2], out)
    expect(out.indexCount).toBe(0)
  })

  it('三角化:凹多边形(L 形)切成的三角形面积加起来等于多边形', () => {
    const L = [0, 0, 10, 0, 10, 4, 4, 4, 4, 10, 0, 10]
    const tris: number[] = []
    triangulate(L, 6, tris)
    expect(tris.length).toBe(4 * 3)
    expect(trianglesArea(L, tris, tris.length)).toBeCloseTo(10 * 4 + 4 * 6, 6)
  })

  it('遮罩范围:遮罩之后到 endSlot 为止;endSlot 不在后面(或就是自己)就到最后', () => {
    expect(clipCovers(3, 6, 4)).toBe(true)
    expect(clipCovers(3, 6, 6)).toBe(true)
    expect(clipCovers(3, 6, 7)).toBe(false)
    expect(clipCovers(3, 6, 3)).toBe(false)
    expect(clipCovers(3, 6, 2)).toBe(false)
    expect(clipCovers(3, 1, 99)).toBe(true)
    expect(clipCovers(3, 3, 99)).toBe(true)
  })

  it('运行时脚本的 .meta 里的 uuid 和 ids.ts 的常量一致(prefab 里的组件靠它认类)', () => {
    for (const [name, uuid] of Object.entries(RUNTIME_SCRIPTS)) {
      const meta = JSON.parse(readFileSync(`tools/cocos/runtime/${name}.ts.meta`, 'utf8')) as { uuid: string; importer: string }
      expect(meta.uuid, name).toBe(uuid)
      expect(meta.importer).toBe('typescript')
    }
  })
})
