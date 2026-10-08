/**
 * 加权网格的绑定:骨骼槽位 + Bone4 截断拟合。Unity 的 SkinnedMeshRenderer 和 Godot 的 Polygon2D 共用。
 *
 * 两个引擎都是「绑定矩阵按槽位存,所有顶点共用」,而 Spine 加权网格**每个影响各存一份骨骼局部坐标**。绑完又在别的
 * 姿势下拖过顶点的网格,同一顶点各影响在 setup 下对不齐,没有哪一组「每根骨骼一个」的绑定矩阵能同时解释它们。
 *
 * 解法:**同一根骨骼可以占多个槽位,各带一个绑定矩阵**。槽位的绑定矩阵 K 满足 K · 局部坐标 = 顶点,任何姿势下引擎与
 * Spine 逐影响相同,不用逐帧数据。
 *   - Unity:`m_Bones` 里重复同一根骨骼,各配一个 bindpose(2026-10-08 实测 BakeMesh 误差 0)
 *   - Godot:骨骼下挂辅助子骨骼,局部变换恒为单位、rest 各不同(docs/GODOT.md 第 3 节,实测误差 0)
 *
 * 两个引擎每顶点都只用权重最大的 4 根(Unity 渲染器写 Bone4;Godot 的 Polygon2D 源码里写死 4 个槽)。剩下几根的影响
 * 分不出去,但留下的 4 个影响各有自己的槽位,局部坐标可以重新挑 —— 按全部动画的姿势最小二乘,留哪 4 根也挑。
 *
 * 坐标系随调用方:局部坐标、基准矩阵、姿势都在引擎的坐标系里(Godot 翻了 Y),本模块只做线性代数。
 */
import { applyPoint, invert, multiply, IDENTITY, type Affine } from '../spine-eval/pose.ts'
import { applyFit, fitAffine, fitMatrix, fitSimilarity } from './unity/mesh.ts'

export type Point = { x: number; y: number }

/** Spine 的一个影响:骨骼(骨架下标)+ 局部坐标(引擎坐标系)+ 权重 */
export interface Influence {
  readonly bone: number
  readonly x: number
  readonly y: number
  readonly weight: number
}

/** 一个槽位:骨骼 + 绑定矩阵(骨骼局部 → 网格空间;引擎的 bindpose / rest 是它的逆)+ 相对基准的平移 */
export interface BindSlot {
  readonly bone: number
  readonly bind: Affine
  readonly offset: Point
}

/** 一个网格的绑定结果。slots 可以继续追加(截断拟合会新开槽位) */
export interface BoundMesh {
  /** 网格空间的顶点 */
  readonly v: readonly Point[]
  readonly slots: BindSlot[]
  /** 第 j 个顶点的第 i 个 Spine 影响落在哪个槽位 */
  readonly slotOf: readonly (readonly number[])[]
  /** 每根骨骼的基准绑定矩阵 */
  readonly base: (bone: number) => Affine
  /** 基准是按贴图拟合的(不是 setup) */
  readonly fitted: boolean
  /** setup 下同一顶点各影响位置的最大差(像素):绑完又改过顶点的程度 */
  readonly spread: number
  /** 基准槽位数(每根骨骼一个)和绑定完时的槽位数 —— 之后的是截断拟合新开的 */
  readonly baseCount: number
  readonly bindCount: number
}

/** 一个影响对不上基准、要另开槽位的门槛(像素)。在 setup 下绑的网格,float32 舍入也有 1e-3 像素级的差 */
export const BIND_TOLERANCE = 0.05

/** 引擎每顶点最多用几根骨骼 */
export const MAX_INFLUENCES = 4

/**
 * 顶点放哪 + 每个影响用哪个槽位。
 *
 * 每根骨骼先有一个「基准」槽位。顶点和基准两种候选,取多出来的槽位少的:
 * 1. setup:顶点 = 各影响在 setup 下的加权平均,基准 = 骨骼的 setup 矩阵。在 setup 下绑的网格一个不多
 * 2. 按贴图拟合:每根骨骼「局部坐标 → 图上位置」拟合一个仿射,顶点 = 图上位置(整体按相似变换摆到 setup 附近)。
 *    MX2_cat 的「第二套」网格是在别的姿势下照着图绑的,setup 下对不齐,按图拟合一个不多
 * 对不上基准的影响(差 > BIND_TOLERANCE)另开槽位:K = 平移(残差)· 基准,残差相近的共用一个。
 *
 * setup 有两份:`engine` 是引擎骨骼实际的 setup(Unity 没有 shear),`target` 是 Spine 的。基准写引擎的、残差按 Spine 的算 ——
 * K⁻¹ · 顶点 = engine⁻¹ · target · 局部坐标,setup 姿势下与 Spine 重合。
 */
export function bindSlots(
  influences: readonly (readonly Influence[])[],
  subset: readonly number[],
  setup: { readonly engine: (bone: number) => Affine; readonly target: (bone: number) => Affine },
  image: readonly Point[],
): BoundMesh {
  const assign = (v: readonly Point[], engineBase: (b: number) => Affine, targetBase: (b: number) => Affine) => {
    const slots: BindSlot[] = subset.map((b) => ({ bone: b, bind: engineBase(b), offset: { x: 0, y: 0 } }))
    const slotOf = influences.map((entry, j) =>
      entry.map((w) => {
        const p = applyPoint(targetBase(w.bone), w.x, w.y)
        return slotWithOffset(slots, engineBase, w.bone, { x: v[j]!.x - p.x, y: v[j]!.y - p.y })
      }),
    )
    return { v, slots, slotOf, base: engineBase }
  }

  const setupMean = influences.map((entry) => {
    let x = 0
    let y = 0
    for (const w of entry) {
      const p = applyPoint(setup.target(w.bone), w.x, w.y)
      x += w.weight * p.x
      y += w.weight * p.y
    }
    return { x, y }
  })
  let spread = 0
  influences.forEach((entry, j) => {
    for (const w of entry) {
      const p = applyPoint(setup.target(w.bone), w.x, w.y)
      spread = Math.max(spread, Math.hypot(p.x - setupMean[j]!.x, p.y - setupMean[j]!.y))
    }
  })
  const counts = (slots: readonly BindSlot[]) => ({ baseCount: subset.length, bindCount: slots.length })
  const atSetup = assign(setupMean, setup.engine, setup.target)
  if (atSetup.slots.length === subset.length) return { ...atSetup, fitted: false, spread, ...counts(atSetup.slots) }

  const byBone = new Map<number, { src: Point[]; dst: Point[] }>()
  influences.forEach((entry, j) => {
    for (const w of entry) {
      const g = byBone.get(w.bone) ?? { src: [], dst: [] }
      byBone.set(w.bone, g)
      g.src.push({ x: w.x, y: w.y })
      g.dst.push(image[j]!)
    }
  })
  const place = fitSimilarity(image, setupMean).fit
  const placeM = fitMatrix(place)
  const fittedBind = new Map<number, Affine>()
  for (const b of subset) {
    const g = byBone.get(b)!
    // 点太少或共线解不出仿射时退回相似变换
    let m: Affine | null = fitAffine(g.src, g.dst)
    if (m === null) {
      const { fit, determined } = fitSimilarity(g.src, g.dst)
      m = determined ? fitMatrix(fit) : { a: 1, b: 0, c: 0, d: 1, x: g.dst[0]!.x - g.src[0]!.x, y: g.dst[0]!.y - g.src[0]!.y }
    }
    fittedBind.set(b, multiply(placeM, m))
  }
  const byFit = (b: number) => fittedBind.get(b)!
  const fitted = assign(image.map((p) => applyFit(place, p.x, p.y)), byFit, byFit)
  return fitted.slots.length < atSetup.slots.length
    ? { ...fitted, fitted: true, spread, ...counts(fitted.slots) }
    : { ...atSetup, fitted: false, spread, ...counts(atSetup.slots) }
}

/**
 * 截断拟合会让一些槽位没人用了 —— 压掉(顺序不变)。返回留下的槽位、旧下标 → 新下标,
 * 以及其中「绑定不一致另开的」有几个(不算截断拟合新开的,那些另报)
 */
export function compactSlots(mesh: BoundMesh, used: Iterable<number>): { slots: BindSlot[]; renumber: Map<number, number>; extra: number } {
  const kept = [...new Set(used)].sort((a, b) => a - b)
  return {
    slots: kept.map((i) => mesh.slots[i]!),
    renumber: new Map(kept.map((old, i) => [old, i])),
    extra: kept.filter((i) => i >= mesh.baseCount && i < mesh.bindCount).length,
  }
}

/** 这根骨骼上、相对基准平移 offset 的槽位(没有就新开一个) */
function slotWithOffset(slots: BindSlot[], base: (b: number) => Affine, bone: number, offset: Point): number {
  const found = slots.findIndex((s) => s.bone === bone && Math.hypot(s.offset.x - offset.x, s.offset.y - offset.y) <= BIND_TOLERANCE)
  if (found >= 0) return found
  slots.push({ bone, bind: multiply({ a: 1, b: 0, c: 0, d: 1, x: offset.x, y: offset.y }, base(bone)), offset })
  return slots.length - 1
}

/** 这根骨骼上、局部坐标为 local 的影响落到哪个槽位(没有就新开一个) */
export function slotFor(mesh: BoundMesh, bone: number, local: Point, v: Point): number {
  const p = applyPoint(mesh.base(bone), local.x, local.y)
  return slotWithOffset(mesh.slots, mesh.base, bone, { x: v.x - p.x, y: v.y - p.y })
}

/** 姿势对:Spine 的(目标)和引擎骨骼实际的,都是骨骼世界矩阵 */
export interface PosePair {
  readonly target: readonly Affine[]
  readonly engine: readonly Affine[]
}

/**
 * 第 j 个顶点超过 MAX_INFLUENCES 根骨骼时:挑留哪几根、重新拟合它们的局部坐标和权重,返回新的槽位和权重(和为 1)。
 * 不一定留权重最大的 —— 权重小但在某些动画里摆得很开的骨骼,丢掉更伤(female_lead 的 nvzhu_st1:留权重最大的 4 根,
 * adjusted_hat 整段差 9 像素,挑过之后 1.1)。没超的返回 null。
 */
export function truncateVertex(
  mesh: BoundMesh,
  j: number,
  influences: readonly Influence[],
  poses: readonly PosePair[],
): { slots: number[]; weights: number[]; error: number } | null {
  const list = influences.map((w, i) => ({ slot: mesh.slotOf[j]![i]!, weight: w.weight })).filter((w) => w.weight > 0)
  if (list.length <= MAX_INFLUENCES) return null
  const sorted = [...list].sort((p, q) => q.weight - p.weight)
  const v = mesh.v[j]!
  let best: { pick: typeof sorted; fit: ReturnType<typeof fitTruncated> } | null = null
  for (const pick of combinations(sorted.slice(0, 8), MAX_INFLUENCES)) {
    const total = pick.reduce((n, w) => n + w.weight, 0)
    const fit = fitTruncated(
      influences,
      pick.map((k) => ({ bone: mesh.slots[k.slot]!.bone, weight: k.weight / total, local: applyPoint(invert(mesh.slots[k.slot]!.bind) ?? IDENTITY, v.x, v.y) })),
      poses,
    )
    if (best === null || fit.error < best.fit.error - 1e-9) best = { pick, fit }
  }
  const { pick, fit } = best!
  return {
    slots: pick.map((k, q) => slotFor(mesh, mesh.slots[k.slot]!.bone, fit.locals[q]!, v)),
    weights: fit.weights,
    error: fit.error,
  }
}

/**
 * 固定留下的几个影响,重新挑它们的局部坐标(引擎骨骼局部)和权重,让全部姿势上 Σ w'ₖ·Eₖ(P)·xₖ 与 Spine 的
 * Σ wᵢ·Tᵢ(P)·lᵢ 的平方差之和最小。
 *
 * 未知数取 yₖ = w'ₖ·xₖ 和 w'ₖ,位置 = Σ lin(Eₖ)·yₖ + Σ w'ₖ·平移(Eₖ),对它们是线性的;Σ w'ₖ = 1 消掉最后一个权重。
 * 解出来有权重 < 1% 的(引擎的权重不能为负,太小的除回 xₖ 会放大误差)就退回「权重固定、只挑坐标」,两种取最大误差小的。
 * 加一点向原值的岭项 —— 几根骨骼总是一起动时方程是奇异的,那时取离原值最近的解。
 */
export function fitTruncated(
  all: readonly Influence[],
  kept: readonly { bone: number; weight: number; local: Point }[],
  poses: readonly PosePair[],
): { locals: Point[]; weights: number[]; error: number } {
  const K = kept.length
  const targets = poses.map((pose) => {
    let x = 0
    let y = 0
    for (const w of all) {
      const p = applyPoint(pose.target[w.bone]!, w.x, w.y)
      x += w.weight * p.x
      y += w.weight * p.y
    }
    return { x, y }
  })
  const errorOf = (locals: readonly Point[], weights: readonly number[]) => {
    let error = 0
    poses.forEach((pose, i) => {
      let x = 0
      let y = 0
      kept.forEach((k, q) => {
        const p = applyPoint(pose.engine[k.bone]!, locals[q]!.x, locals[q]!.y)
        x += weights[q]! * p.x
        y += weights[q]! * p.y
      })
      error = Math.max(error, Math.hypot(x - targets[i]!.x, y - targets[i]!.y))
    })
    return error
  }

  /** 按行累加正规方程,加岭项后解 */
  const leastSquares = (n: number, rowsOf: (pose: PosePair, t: Point) => { r: number[]; b: number }[], prior: readonly number[]) => {
    const ata = Array.from({ length: n }, () => new Array<number>(n).fill(0))
    const atb = new Array<number>(n).fill(0)
    poses.forEach((pose, i) => {
      for (const { r, b } of rowsOf(pose, targets[i]!)) {
        for (let a = 0; a < n; a++) {
          if (r[a] === 0) continue
          for (let c = 0; c < n; c++) ata[a]![c]! += r[a]! * r[c]!
          atb[a]! += r[a]! * b
        }
      }
    })
    const ridge = 1e-6 * Math.max(1, ...ata.map((row, i) => row[i]!))
    for (let a = 0; a < n; a++) {
      ata[a]![a]! += ridge
      atb[a]! += ridge * prior[a]!
    }
    return solveLinear(ata, atb)
  }

  // 权重固定,只挑坐标
  const fixed = leastSquares(
    K * 2,
    (pose, t) => {
      const rx = new Array<number>(K * 2).fill(0)
      const ry = new Array<number>(K * 2).fill(0)
      let cx = 0
      let cy = 0
      kept.forEach((k, q) => {
        const m = pose.engine[k.bone]!
        rx[q * 2] = k.weight * m.a
        rx[q * 2 + 1] = k.weight * m.b
        ry[q * 2] = k.weight * m.c
        ry[q * 2 + 1] = k.weight * m.d
        cx += k.weight * m.x
        cy += k.weight * m.y
      })
      return [{ r: rx, b: t.x - cx }, { r: ry, b: t.y - cy }]
    },
    kept.flatMap((k) => [k.local.x, k.local.y]),
  )
  let best = {
    locals: fixed === null ? kept.map((k) => k.local) : kept.map((_, q) => ({ x: fixed[q * 2]!, y: fixed[q * 2 + 1]! })),
    weights: kept.map((k) => k.weight),
  }
  let bestError = errorOf(best.locals, best.weights)

  // 坐标和权重一起挑
  const n = K * 2 + K - 1
  const last = K - 1
  const free = leastSquares(
    n,
    (pose, t) => {
      const rx = new Array<number>(n).fill(0)
      const ry = new Array<number>(n).fill(0)
      const tl = pose.engine[kept[last]!.bone]!
      kept.forEach((k, q) => {
        const m = pose.engine[k.bone]!
        rx[q * 2] = m.a
        rx[q * 2 + 1] = m.b
        ry[q * 2] = m.c
        ry[q * 2 + 1] = m.d
        if (q < last) {
          rx[K * 2 + q] = m.x - tl.x
          ry[K * 2 + q] = m.y - tl.y
        }
      })
      return [{ r: rx, b: t.x - tl.x }, { r: ry, b: t.y - tl.y }]
    },
    [...kept.flatMap((k) => [k.weight * k.local.x, k.weight * k.local.y]), ...kept.slice(0, last).map((k) => k.weight)],
  )
  if (free !== null) {
    const weights = kept.map((_, q) => (q < last ? free[K * 2 + q]! : 0))
    weights[last] = 1 - weights.reduce((a, b) => a + b, 0)
    if (weights.every((w) => w >= 0.01)) {
      const locals = kept.map((_, q) => ({ x: free[q * 2]! / weights[q]!, y: free[q * 2 + 1]! / weights[q]! }))
      const error = errorOf(locals, weights)
      if (error < bestError) {
        best = { locals, weights }
        bestError = error
      }
    }
  }
  return { ...best, error: bestError }
}

/** 从 items 里取 k 个的全部组合(保持原顺序) */
function combinations<T>(items: readonly T[], k: number): T[][] {
  if (k === 0) return [[]]
  const out: T[][] = []
  items.forEach((item, i) => {
    for (const rest of combinations(items.slice(i + 1), k - 1)) out.push([item, ...rest])
  })
  return out
}

/** 高斯消元(部分选主元);奇异返回 null */
function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i]!])
  for (let c = 0; c < n; c++) {
    let pivot = c
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[pivot]![c]!)) pivot = r
    if (Math.abs(m[pivot]![c]!) < 1e-12) return null
    ;[m[c], m[pivot]] = [m[pivot]!, m[c]!]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = m[r]![c]! / m[c]![c]!
      if (f === 0) continue
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!
    }
  }
  return m.map((row, i) => row[n]! / row[i]!)
}
