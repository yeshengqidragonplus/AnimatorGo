/**
 * AnimatorGo 的 Cocos 运行时 —— 纯数学部分(CPU 蒙皮、deform、遮罩裁剪),不依赖 `cc`。
 *
 * `AnimatorGoMesh` / `AnimatorGoClip` 每帧调它;端到端测试(`src/spine-convert/cocos/cocosEval.ts`)也 import 同一份文件
 * 按引擎跑的那套代码算顶点 —— 导出器写出的数据在这里算出来和 Spine 一样,引擎里画出来就一样。
 *
 * 顶点的表达照 Spine 原样:每个顶点若干个「影响」(骨骼、骨骼局部坐标、权重),世界坐标 = Σ 权重 · 骨骼世界矩阵 · (局部 + deform 偏移)。
 * deform 是「先加偏移再蒙皮」,偏移逐影响存(和 Spine 的 deform 时间轴同一个布局)。
 *
 * ⚠️ 这个文件会被拷进 Cocos 工程(`AnimatorGoRuntime/`),只能写 Cocos 的 TypeScript 编译器也认的东西:
 * 不 import 任何东西、不用 `.ts` 后缀的 import、不用 node 的 API。下标后面的 `!` 是给本仓库的 noUncheckedIndexedAccess 看的。
 */

/** 每根骨骼的 2D 仿射平铺成 6 个数:x' = a·x + b·y + tx,y' = c·x + d·y + ty */
export const MAT_STRIDE = 6

/** 每个影响 4 个数:[骨骼下标(局部 bones 数组), x, y, 权重] */
export const INFLUENCE_STRIDE = 4

/** 一个 2D 批次里一个渲染器最多占的顶点 / 索引(StaticVBAccessor 一块缓冲的上限,超了引擎报 9004 不画) */
export const MAX_VERTICES = 4096
export const MAX_INDICES = 16384

/**
 * 把各个 shape 按权重叠加成一份偏移(平铺,逐影响 x,y)。返回有没有非零权重 —— 全零时 out 不保证被清零,调用方跳过偏移。
 */
export function combineShapes(shapes: ArrayLike<number>, flatLength: number, weights: ArrayLike<number>, out: Float32Array): boolean {
  if (flatLength <= 0) return false
  const count = Math.min(Math.floor(shapes.length / flatLength), weights.length)
  let any = false
  for (let s = 0; s < count; s++) {
    const w = weights[s]!
    if (!w) continue
    if (!any) out.fill(0, 0, flatLength)
    any = true
    const base = s * flatLength
    for (let i = 0; i < flatLength; i++) out[i]! += w * shapes[base + i]!
  }
  return any
}

/**
 * 蒙皮:`counts[v]` 是第 v 个顶点的影响数,`influences` 按顶点顺序平铺,`mats` 每根骨骼 6 个数(MAT_STRIDE),
 * `offsets` 为 null 表示没有 deform。结果写进 `out`(x,y 交替)。
 */
export function skinVertices(
  counts: ArrayLike<number>,
  influences: ArrayLike<number>,
  mats: ArrayLike<number>,
  offsets: ArrayLike<number> | null,
  out: Float32Array,
): void {
  let k = 0
  let o = 0
  for (let v = 0; v < counts.length; v++) {
    const n = counts[v]!
    let x = 0
    let y = 0
    for (let j = 0; j < n; j++, k++) {
      const i = k * INFLUENCE_STRIDE
      const m = influences[i]! * MAT_STRIDE
      let px = influences[i + 1]!
      let py = influences[i + 2]!
      if (offsets !== null) {
        px += offsets[k * 2]!
        py += offsets[k * 2 + 1]!
      }
      const w = influences[i + 3]!
      x += (mats[m]! * px + mats[m + 1]! * py + mats[m + 4]!) * w
      y += (mats[m + 2]! * px + mats[m + 3]! * py + mats[m + 5]!) * w
    }
    out[o++] = x
    out[o++] = y
  }
}

/** 影响总数(= counts 之和);deform 偏移的平铺长度是它的 2 倍 */
export function influenceCount(counts: ArrayLike<number>): number {
  let n = 0
  for (let i = 0; i < counts.length; i++) n += counts[i]!
  return n
}

/**
 * 区域相对的 (s, t)(s 向右、t 向下,0..1 是裁剪后的区域)→ 贴图 uv。`frameUvs` 是 SpriteFrame.uv:
 * 四个角按 左下、右下、左上、右上 各两个数,图集里转了 90° 的区域也已经转好 —— 在四个角之间仿射插值就是了。
 */
export function frameUv(s: number, t: number, frameUvs: ArrayLike<number>, out: Float32Array, o: number): void {
  const lx = frameUvs[4]!
  const ly = frameUvs[5]!
  out[o] = lx + s * (frameUvs[6]! - lx) + t * (frameUvs[0]! - lx)
  out[o + 1] = ly + s * (frameUvs[7]! - ly) + t * (frameUvs[1]! - ly)
}

/**
 * 简单多边形的三角化(耳切法),写出顶点下标三元组。`xy` 平铺、`n` 个点。顺逆时针都行;
 * 切不下去(自相交 / 退化)时剩下的退回扇形。遮罩多边形只有十几个点,每帧做一次无所谓。
 */
export function triangulate(xy: ArrayLike<number>, n: number, out: number[]): void {
  out.length = 0
  if (n < 3) return
  let area = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    area += xy[i * 2]! * xy[j * 2 + 1]! - xy[j * 2]! * xy[i * 2 + 1]!
  }
  const sign = area >= 0 ? 1 : -1
  const cross = (a: number, b: number, c: number): number =>
    ((xy[b * 2]! - xy[a * 2]!) * (xy[c * 2 + 1]! - xy[a * 2 + 1]!) - (xy[b * 2 + 1]! - xy[a * 2 + 1]!) * (xy[c * 2]! - xy[a * 2]!)) * sign
  const inside = (p: number, a: number, b: number, c: number): boolean => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0
  const idx: number[] = []
  for (let i = 0; i < n; i++) idx.push(i)
  while (idx.length > 3) {
    let cut = -1
    for (let i = 0; i < idx.length && cut < 0; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length]!
      const ib = idx[i]!
      const ic = idx[(i + 1) % idx.length]!
      if (cross(ia, ib, ic) <= 1e-12) continue
      let ear = true
      for (let j = 0; j < idx.length && ear; j++) {
        const p = idx[j]!
        if (p !== ia && p !== ib && p !== ic && inside(p, ia, ib, ic)) ear = false
      }
      if (!ear) continue
      out.push(ia, ib, ic)
      cut = i
    }
    if (cut < 0) break
    idx.splice(cut, 1)
  }
  for (let i = 1; i + 1 < idx.length; i++) out.push(idx[0]!, idx[i]!, idx[i + 1]!)
}

/** 裁剪的输出缓冲:位置(x,y)、区域相对 uv(s,t)、索引。只长不缩,跨帧复用 */
export interface ClipBuffers {
  pos: Float32Array
  uv: Float32Array
  idx: Uint16Array
  vertexCount: number
  indexCount: number
  /** 这一帧的输出撞到了 MAX_VERTICES / MAX_INDICES,后面的三角形丢了 */
  truncated: boolean
}

export function createClipBuffers(): ClipBuffers {
  return { pos: new Float32Array(64), uv: new Float32Array(64), idx: new Uint16Array(96), vertexCount: 0, indexCount: 0, truncated: false }
}

function grow(out: ClipBuffers, vertices: number, indices: number): void {
  if (vertices * 2 > out.pos.length) {
    const n = Math.max(vertices * 2, out.pos.length * 2)
    const pos = new Float32Array(n)
    pos.set(out.pos)
    out.pos = pos
    const uv = new Float32Array(n)
    uv.set(out.uv)
    out.uv = uv
  }
  if (indices > out.idx.length) {
    const idx = new Uint16Array(Math.max(indices, out.idx.length * 2))
    idx.set(out.idx)
    out.idx = idx
  }
}

// 两块轮换的多边形暂存:[x, y, s, t] × 顶点
let polyA: number[] = []
let polyB: number[] = []

/**
 * 网格的三角形按遮罩多边形裁(Sutherland–Hodgman,和 Spine 的 SkeletonClipping 同一个算法):
 * 遮罩先三角化(`polyTris`),每个网格三角形对每个遮罩三角形裁,裁出来的凸多边形扇形展开。
 * 遮罩的三角形互不重叠,所以裁出来的片也互不重叠。`pos` / `uv` 是网格顶点(平铺),`idx` 取前 `indexCount` 个。
 */
export function clipMesh(
  pos: ArrayLike<number>,
  uv: ArrayLike<number>,
  idx: ArrayLike<number>,
  indexCount: number,
  poly: ArrayLike<number>,
  polyTris: ArrayLike<number>,
  out: ClipBuffers,
): void {
  out.vertexCount = 0
  out.indexCount = 0
  out.truncated = false
  for (let c = 0; c + 2 < polyTris.length; c += 3) {
    const ax = poly[polyTris[c]! * 2]!, ay = poly[polyTris[c]! * 2 + 1]!
    const bx = poly[polyTris[c + 1]! * 2]!, by = poly[polyTris[c + 1]! * 2 + 1]!
    const cx = poly[polyTris[c + 2]! * 2]!, cy = poly[polyTris[c + 2]! * 2 + 1]!
    const orient = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (Math.abs(orient) < 1e-12) continue
    const sign = orient > 0 ? 1 : -1
    const cminX = Math.min(ax, bx, cx), cmaxX = Math.max(ax, bx, cx)
    const cminY = Math.min(ay, by, cy), cmaxY = Math.max(ay, by, cy)
    for (let t = 0; t + 2 < indexCount; t += 3) {
      const i0 = idx[t]!, i1 = idx[t + 1]!, i2 = idx[t + 2]!
      const x0 = pos[i0 * 2]!, y0 = pos[i0 * 2 + 1]!
      const x1 = pos[i1 * 2]!, y1 = pos[i1 * 2 + 1]!
      const x2 = pos[i2 * 2]!, y2 = pos[i2 * 2 + 1]!
      if (Math.max(x0, x1, x2) < cminX || Math.min(x0, x1, x2) > cmaxX || Math.max(y0, y1, y2) < cminY || Math.min(y0, y1, y2) > cmaxY) continue
      let a = polyA
      let b = polyB
      a.length = 0
      a.push(x0, y0, uv[i0 * 2]!, uv[i0 * 2 + 1]!, x1, y1, uv[i1 * 2]!, uv[i1 * 2 + 1]!, x2, y2, uv[i2 * 2]!, uv[i2 * 2 + 1]!)
      let na = 3
      for (let e = 0; e < 3 && na >= 3; e++) {
        const ex0 = e === 0 ? ax : e === 1 ? bx : cx
        const ey0 = e === 0 ? ay : e === 1 ? by : cy
        const ex1 = e === 0 ? bx : e === 1 ? cx : ax
        const ey1 = e === 0 ? by : e === 1 ? cy : ay
        const dx = ex1 - ex0
        const dy = ey1 - ey0
        b.length = 0
        let prev = (na - 1) * 4
        let sp = sign * (dx * (a[prev + 1]! - ey0) - dy * (a[prev]! - ex0))
        for (let i = 0; i < na; i++) {
          const cur = i * 4
          const sc = sign * (dx * (a[cur + 1]! - ey0) - dy * (a[cur]! - ex0))
          const curIn = sc >= 0
          const prevIn = sp >= 0
          if (curIn !== prevIn) {
            const k = sp / (sp - sc)
            b.push(a[prev]! + (a[cur]! - a[prev]!) * k, a[prev + 1]! + (a[cur + 1]! - a[prev + 1]!) * k, a[prev + 2]! + (a[cur + 2]! - a[prev + 2]!) * k, a[prev + 3]! + (a[cur + 3]! - a[prev + 3]!) * k)
          }
          if (curIn) b.push(a[cur]!, a[cur + 1]!, a[cur + 2]!, a[cur + 3]!)
          prev = cur
          sp = sc
        }
        const swap = a
        a = b
        b = swap
        na = a.length / 4
      }
      polyA = a
      polyB = b
      if (na < 3) continue
      const base = out.vertexCount
      if (base + na > MAX_VERTICES || out.indexCount + (na - 2) * 3 > MAX_INDICES) {
        out.truncated = true
        return
      }
      grow(out, base + na, out.indexCount + (na - 2) * 3)
      for (let i = 0; i < na; i++) {
        out.pos[(base + i) * 2] = a[i * 4]!
        out.pos[(base + i) * 2 + 1] = a[i * 4 + 1]!
        out.uv[(base + i) * 2] = a[i * 4 + 2]!
        out.uv[(base + i) * 2 + 1] = a[i * 4 + 3]!
      }
      out.vertexCount += na
      for (let i = 1; i + 1 < na; i++) {
        out.idx[out.indexCount++] = base
        out.idx[out.indexCount++] = base + i
        out.idx[out.indexCount++] = base + i + 1
      }
    }
  }
}

/**
 * 遮罩生效的范围(Spine 的规则):画到遮罩 slot 之后开始裁,画完 endSlot 结束;endSlot 不在它后面(或就是它自己)就裁到最后。
 * `order` / `endOrder` / `mine` 都是绘制顺序里的位置(sortingOrder)。
 */
export function clipCovers(order: number, endOrder: number, mine: number): boolean {
  return mine > order && (endOrder <= order || mine <= endOrder)
}
