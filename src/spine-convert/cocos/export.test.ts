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
import { exportToCocos, meshVertexLocal, type AttachmentNode } from './export.ts'
import { loadCocosScene, parseClip } from './cocosEval.ts'

/**
 * Spine → Cocos 的**端到端校验**:把写出的 prefab 和 `.anim` 读回来,**按 Cocos 的规则**(cocosEval.ts)算出每个 Sprite
 * 画在哪、哪些亮着、先后、颜色,和 Spine 自己的求值比。产物「像 Cocos 文件」没有意义,要的是引擎按它的规则播出来和 Spine 一样。
 *
 * 图片部件要精确(0.05 像素);网格现在按矩形 Sprite 画,导出器报了残差,这里核对报出来的数兜得住。
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
  /** 这条动画里有没有 deform 打在这个网格上(linkedmesh 跟着父网格变形,父网格可以在别的 slot 里) */
  const skinName = (s: number | string) => (typeof s === 'number' ? (part.skins[s]?.name ?? String(s)) : s)
  const deformed = (n: AttachmentNode, anim: AnimationData) => anim.timelines.some((t) => {
    if (t.kind !== 'deform') return false
    const d = t.frames[0] as { skin: number | string; attachment: string }
    if (t.owner === n.slot && (d.attachment === n.key || d.attachment === n.attachment.name)) return true
    return n.deformSource !== null && d.attachment === n.deformSource.key && skinName(d.skin) === n.deformSource.skin
  })

  /**
   * 某一时刻:每个 attachment 节点按 Cocos 规则画出来的位置 vs Spine。region 比四角;网格把每个顶点按
   * 「图上的位置 → 节点局部 → 世界」算出来比(矩形近似,导出器报了残差)。返回超出容差最多的那个
   */
  function worstAt(anim: AnimationData | null, t: number): { excess: number; where: string } {
    const kept = anim === null ? null : { ...anim, timelines: lastPerProperty(anim.timelines).kept }
    // Cocos 的节点没有斜切、只有完整继承,导出时忽略了(报近似);Spine 这边按同样的规则求值,别的地方必须精确
    const pose = kept === null ? setupPose(part, { unityCompatible: true }) : poseAt(part, kept, t, { unityCompatible: true })
    const world = scene.worldAt(anim?.name ?? null, t)
    let excess = -Infinity
    let where = ''
    for (const n of result.attachments) {
      if (n.frame !== undefined) continue
      if (n.weightedOn !== null && anim !== null) continue
      if (kept !== null && deformed(n, kept)) continue
      const spine = attachmentVertices(part, atlas, n.attachment, n.skin, n.slot, pose, kept, t)
      const m = world.get(n.path)!
      const region = atlas.regions.get((n.attachment.data['path'] as string | null) ?? n.attachment.name)!
      let cocos: { x: number; y: number }[]
      if (n.attachment.type === 'region') {
        // Sprite 的矩形:UITransform 的大小和锚点(cocosEval.drawnAt 同一个算法,这里不管亮没亮)
        const tr = scene.nodes.find((x) => x.path === n.path)!.transform!
        const l = -tr.anchorX * tr.width, rr = (1 - tr.anchorX) * tr.width, b = -tr.anchorY * tr.height, tp = (1 - tr.anchorY) * tr.height
        cocos = [[l, b], [rr, b], [rr, tp], [l, tp]].map(([px, py]) => ({ x: m.a * px! + m.b * py! + m.x, y: m.c * px! + m.d * py! + m.y }))
      } else {
        const uvs = n.attachment.data['uvs'] as number[]
        cocos = spine.map((_, i) => {
          const l = meshVertexLocal(n, region, uvs[i * 2]!, uvs[i * 2 + 1]!)
          return { x: m.a * l.x + m.b * l.y + m.x, y: m.c * l.x + m.d * l.y + m.y }
        })
      }
      expect(cocos.length, n.attachment.name).toBe(spine.length)
      // 网格是矩形近似,导出器在 setup 下量的残差;动画里骨骼一缩放,误差也跟着缩放 —— 允许 20% 的余量
      const allowed = n.attachment.type === 'region' ? 0.05 : n.residual * 1.2 + 0.1
      spine.forEach((p, i) => {
        const d = Math.hypot(p.x - cocos[i]!.x, p.y - cocos[i]!.y) - allowed
        if (d > excess) { excess = d; where = `${n.attachment.name} 第 ${i} 个顶点 @${anim?.name ?? 'setup'} ${t.toFixed(3)} 偏 ${(d + allowed).toFixed(2)} 像素(允许 ${allowed.toFixed(2)})` }
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

  it('每个画得出来的 attachment 都有节点(Sprite + UITransform + Sorting2D);根上挂着 Animation,每条动画一个 .anim', () => {
    const { part, result, scene, files } = exported
    const drawable = part.skins.flatMap((s) => s.slots.flatMap((e) => e.attachments.filter((a) => a.type === 'region' || a.type === 'mesh')))
    expect(result.attachments.length).toBeGreaterThanOrEqual(drawable.length - result.issues.filter((i) => i.path.startsWith('region.')).length)
    for (const n of result.attachments) {
      const node = scene.nodes.find((x) => x.path === n.path)!
      expect(node, n.path).toBeDefined()
      expect(node.sprite, n.path).not.toBeNull()
      expect(node.transform, n.path).not.toBeNull()
      expect(node.sortingOrder, n.path).toBe(n.slot)
    }
    for (const anim of part.animations) expect(scene.clips.has(anim.name), anim.name).toBe(true)
    expect([...files.keys()].filter((p) => p.endsWith('.anim')).length).toBe(part.animations.length)
    expect([...files.keys()].filter((p) => p.endsWith('.png')).length).toBe(result.images.size)
  })

  it('⭐ setup 姿势:按 Cocos 的规则算出的四角与 Spine 一致(图片部件 0.05 像素,网格在报出来的残差内)', () => {
    const { worstAt } = exported
    const { excess, where } = worstAt(null, 0)
    expect(excess, where).toBeLessThanOrEqual(0)
  })

  it('⭐ 每条动画的每个关键帧,以及相邻关键帧的中点:位置与 Spine 一致(贝塞尔走引擎的求值,精确)', () => {
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

  it('有损的地方都报出来了:加权网格 / deform / 遮罩 / 约束各一条 loss,图片部件没有 loss', () => {
    const { part, result } = exported
    const kinds = new Set(result.issues.map((i) => `${i.level}:${i.path.split('.')[0]}`))
    const hasWeighted = part.skins.some((s) => s.slots.some((e) => e.attachments.some((a) => a.type === 'mesh' && (a.data['vertices'] as { weighted: boolean }).weighted && new Set((a.data['vertices'] as { weights: { bone: number }[][] }).weights.flatMap((w) => w.map((x) => x.bone))).size > 1)))
    const hasDeform = part.animations.some((a) => a.timelines.some((t) => t.kind === 'deform'))
    const hasClipping = part.skins.some((s) => s.slots.some((e) => e.attachments.some((a) => a.type === 'clipping')))
    if (hasWeighted) expect(kinds.has('loss:mesh')).toBe(true)
    if (hasDeform) expect([...result.issues].some((i) => i.level === 'loss' && /deform\./.test(i.path))).toBe(true)
    if (hasClipping) expect([...result.issues].some((i) => i.level === 'loss' && /clipping\./.test(i.path))).toBe(true)
    if (part.ik.length > 0) expect(kinds.has('loss:ik')).toBe(true)
    expect(result.issues.filter((i) => i.level === 'loss' && i.path.startsWith('region.'))).toEqual([])
  })

  it('图:prefab 和动画引用的每个 spriteFrame 都有对应的 PNG,尺寸与 meta 一致', () => {
    const { result, scene, files } = exported
    const frames = new Set(result.images.size > 0 ? [...result.images.values()].map((i) => `${i.uuid}@f9941`) : [])
    for (const n of scene.nodes) if (n.sprite !== null) expect(frames.has(n.sprite.spriteFrame), n.path).toBe(true)
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
