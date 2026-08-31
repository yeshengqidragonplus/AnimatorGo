import type { Attachment } from '../../spine-format/binary/readSkins.ts'
import type { AtlasRegion } from '../../core/atlas.ts'

/**
 * 网格 attachment → Unity sprite 的几何与绑定姿势。
 *
 * ## 为什么绑定姿势不能用绑定姿势(setup pose)算
 *
 * 直觉上,加权网格的顶点摆在骨架的 setup pose 下就应该正好贴在图上。
 * **实测 15 个网格里有 6 个不是这样**(残差 45~206 像素)——
 * 那几个是「换装用的第二套」,画的时候骨架摆的是**动画中的某个姿势**。
 * 拿 `body2` 去搜遍两条动画,在 `swim` 的第 2.0 秒残差只有 **0.01 像素**,
 * 证实了这一点。
 *
 * 所以绑定姿势要**从网格自己的数据里解**,不要去问骨架当前是什么姿势:
 * Spine 每个顶点存的是 `(骨骼, x, y, 权重)`,其中 `(x, y)` 就是**绑定时刻**
 * 该顶点在那根骨骼局部空间里的坐标。于是对每根骨骼,
 * 「骨骼局部坐标 → 图片上的位置」这个刚体变换可以单独最小二乘解出来,
 * 各骨骼互不耦合。实测 14 个加权网格全部重建到 **0.4 像素以内**。
 *
 * ## 图集缩放
 *
 * Spine 导出图集时可以带缩放(这份素材是 0.5)。图集里的像素尺寸因此是
 * 骨架单位的 1/k。`.atlas` 里**没有记这个数**,只能从数据反推:
 * region attachment 的 `width / originalWidth`,以及网格的整体拟合缩放。
 *
 * 反推出来的 k 不改任何坐标,只用来定纹理的 `spritePixelsToUnits`
 * (= `pixelsPerUnit / k`)—— 这样 sprite 的像素和场景的世界单位就对上了,
 * 而且**不用重采样图片**。
 */

/** 二维刚体变换(可带统一缩放)。角度是度。 */
export interface Fit {
  readonly rotation: number
  readonly scale: number
  readonly x: number
  readonly y: number
}

const DEG = Math.PI / 180

export function applyFit(fit: Fit, x: number, y: number): { x: number; y: number } {
  const c = Math.cos(DEG * fit.rotation) * fit.scale
  const s = Math.sin(DEG * fit.rotation) * fit.scale
  return { x: c * x - s * y + fit.x, y: s * x + c * y + fit.y }
}

/**
 * 最小二乘拟合 `dst ≈ scale · R(θ) · src + t`。
 *
 * `fixedScale` 给定时只解旋转和平移(旋转的解与缩放无关,所以可以分开)。
 * 点不足或退化(全部重合)时旋转无定义,返回 `determined: false`。
 */
export function fitSimilarity(
  src: readonly { x: number; y: number }[],
  dst: readonly { x: number; y: number }[],
  fixedScale?: number,
): { fit: Fit; determined: boolean } {
  const n = src.length
  let sx = 0
  let sy = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    sx += src[i]!.x / n
    sy += src[i]!.y / n
    dx += dst[i]!.x / n
    dy += dst[i]!.y / n
  }

  let a = 0
  let b = 0
  let norm = 0
  for (let i = 0; i < n; i++) {
    const px = src[i]!.x - sx
    const py = src[i]!.y - sy
    const qx = dst[i]!.x - dx
    const qy = dst[i]!.y - dy
    a += px * qx + py * qy
    b += px * qy - py * qx
    norm += px * px + py * py
  }

  const magnitude = Math.hypot(a, b)
  const determined = norm > 1e-9 && magnitude > 1e-9
  const rotation = determined ? Math.atan2(b, a) / DEG : 0
  const scale = fixedScale ?? (determined ? magnitude / norm : 1)

  const c = Math.cos(DEG * rotation) * scale
  const s = Math.sin(DEG * rotation) * scale
  return {
    fit: { rotation, scale, x: dx - (c * sx - s * sy), y: dy - (s * sx + c * sy) },
    determined,
  }
}

/**
 * 由 Spine 的 UV 反算顶点在 sprite 矩形里的像素位置。
 *
 * Spine 的 `uvs` 是**相对未裁剪原图**的归一化坐标,原点在**左上**、y 向下
 * (由 spine-csharp 的 `MeshAttachment.UpdateRegion` 反解得到)。
 * Unity 的顶点原点在矩形**左下**、y 向上,所以 y 要翻。
 */
export function uvToRect(u: number, v: number, region: AtlasRegion): { x: number; y: number } {
  return {
    x: u * region.originalWidth - region.offsetX,
    y: region.originalHeight * (1 - v) - region.offsetY,
  }
}

interface SpineVertices {
  readonly weighted: boolean
  readonly positions: readonly number[]
  readonly weights: readonly (readonly { bone: number; x: number; y: number; weight: number }[])[]
}

/** 从 attachment 里取顶点在 sprite 矩形空间的位置 */
export function meshVertices(attachment: Attachment, region: AtlasRegion): { x: number; y: number }[] {
  const uvs = attachment.data['uvs'] as number[]
  const count = attachment.data['vertexCount'] as number
  const out: { x: number; y: number }[] = []
  for (let i = 0; i < count; i++) out.push(uvToRect(uvs[i * 2]!, uvs[i * 2 + 1]!, region))
  return out
}

/**
 * 估算图集缩放 k(骨架单位 ÷ 图集像素)。
 *
 * 网格用「整体相似变换」的缩放,只在拟合站得住脚时才采信;
 * region attachment 直接用 `width / originalWidth`。
 *
 * ⚠️ **必须按尺寸加权。** 图集里的裁剪框是整数像素,小图的比值被量化误差主导 ——
 * 11×11 的气泡算出来是 1.909,而 400 像素宽的身体算出来是 1.9998。
 * 不加权的话小图会把中位数拽偏,还会误报「缩放不一致」。
 */
export function estimateAtlasScale(
  samples: readonly { attachment: Attachment; region: AtlasRegion }[],
): { scale: number; spread: number; count: number } {
  /** 每条样本带一个「参与的像素跨度」,跨度越大越可信 */
  const values: { value: number; weight: number }[] = []

  for (const { attachment, region } of samples) {
    if (attachment.type === 'region') {
      if (region.originalWidth > 0) {
        values.push({ value: (attachment.data['width'] as number) / region.originalWidth, weight: region.originalWidth })
      }
      if (region.originalHeight > 0) {
        values.push({ value: (attachment.data['height'] as number) / region.originalHeight, weight: region.originalHeight })
      }
      continue
    }

    const verts = attachment.data['vertices'] as SpineVertices
    const target = meshVertices(attachment, region)
    if (!verts.weighted) {
      const src: { x: number; y: number }[] = []
      for (let i = 0; i < target.length; i++) {
        src.push({ x: verts.positions[i * 2]!, y: verts.positions[i * 2 + 1]! })
      }
      // 未加权网格整块是刚性的,拟合出的缩放可以直接采信
      const { fit, determined } = fitSimilarity(src, target)
      if (determined && fit.scale > 1e-6) values.push({ value: 1 / fit.scale, weight: extentOf(target) })
      continue
    }

    // 加权网格逐骨骼拟合 —— 不依赖骨架当前姿势,所以「第二套」网格也算得准
    for (const [, pairs] of groupByBone(verts, target)) {
      if (pairs.src.length < 2) continue
      const { fit, determined } = fitSimilarity(pairs.src, pairs.dst)
      if (determined && fit.scale > 1e-6) values.push({ value: 1 / fit.scale, weight: extentOf(pairs.dst) })
    }
  }

  if (values.length === 0) return { scale: 1, spread: 0, count: 0 }

  values.sort((a, b) => a.value - b.value)
  const total = values.reduce((n, v) => n + v.weight, 0)
  let seen = 0
  let scale = values[values.length >> 1]!.value
  for (const v of values) {
    seen += v.weight
    if (seen >= total / 2) {
      scale = v.value
      break
    }
  }

  // 只拿足够大的样本判断一致性 —— 小图的量化误差不算「不一致」
  let spread = 0
  for (const v of values) {
    if (v.weight >= 64) spread = Math.max(spread, Math.abs(v.value / scale - 1))
  }
  return { scale, spread, count: values.length }
}

/** 一组点的对角跨度,用作可信度权重 */
function extentOf(points: readonly { x: number; y: number }[]): number {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return Math.hypot(maxX - minX, maxY - minY)
}

function groupByBone(
  verts: SpineVertices,
  target: readonly { x: number; y: number }[],
): Map<number, { src: { x: number; y: number }[]; dst: { x: number; y: number }[] }> {
  const byBone = new Map<number, { src: { x: number; y: number }[]; dst: { x: number; y: number }[] }>()
  verts.weights.forEach((entry, i) => {
    for (const w of entry) {
      let pairs = byBone.get(w.bone)
      if (pairs === undefined) {
        pairs = { src: [], dst: [] }
        byBone.set(w.bone, pairs)
      }
      pairs.src.push({ x: w.x, y: w.y })
      pairs.dst.push(target[i]!)
    }
  })
  return byBone
}

export interface MeshBinding {
  /** sprite 矩形空间的顶点(像素,原点左下) */
  readonly vertices: readonly { x: number; y: number }[]
  readonly triangles: readonly number[]
  /** 加权网格:骨架下标 → 该骨骼在 sprite 像素空间里的绑定姿势 */
  readonly bindPose: ReadonlyMap<number, Fit> | null
  /** 未加权网格:整块的刚体变换(骨骼局部 → sprite 像素) */
  readonly rigid: Fit | null
  /** 每顶点的骨骼影响,加权时才有内容 */
  readonly influences: readonly (readonly { bone: number; weight: number }[])[]
  /** 用拟合结果重建顶点的最大误差(sprite 像素) */
  readonly residual: number
  /** 旋转解不出来的骨骼(只影响一个顶点),已用同网格其余骨骼的中位角度顶上 */
  readonly undetermined: readonly number[]
}

/**
 * 解出网格的绑定姿势。
 *
 * `atlasScale` 是骨架单位 ÷ 图集像素;骨骼局部坐标先除以它换算到图集像素,
 * 这样拟合出来的变换就是纯刚体(没有缩放),正好对上 Unity 只存旋转和平移的绑定姿势。
 */
export function bindMesh(
  attachment: Attachment,
  region: AtlasRegion,
  slotBone: number,
  atlasScale: number,
): MeshBinding {
  const verts = attachment.data['vertices'] as SpineVertices
  const triangles = attachment.data['triangles'] as number[]
  const vertices = meshVertices(attachment, region)

  if (!verts.weighted) {
    const src: { x: number; y: number }[] = []
    for (let i = 0; i < vertices.length; i++) {
      src.push({ x: verts.positions[i * 2]! / atlasScale, y: verts.positions[i * 2 + 1]! / atlasScale })
    }
    const { fit } = fitSimilarity(src, vertices, 1)
    let residual = 0
    for (let i = 0; i < src.length; i++) {
      const p = applyFit(fit, src[i]!.x, src[i]!.y)
      residual = Math.max(residual, Math.hypot(p.x - vertices[i]!.x, p.y - vertices[i]!.y))
    }
    return {
      vertices,
      triangles,
      bindPose: null,
      rigid: fit,
      influences: vertices.map(() => [{ bone: slotBone, weight: 1 }]),
      residual,
      undetermined: [],
    }
  }

  const scaled: SpineVertices = {
    weighted: true,
    positions: [],
    weights: verts.weights.map((entry) =>
      entry.map((w) => ({ bone: w.bone, x: w.x / atlasScale, y: w.y / atlasScale, weight: w.weight })),
    ),
  }

  const grouped = groupByBone(scaled, vertices)
  const bindPose = new Map<number, Fit>()
  const undetermined: number[] = []
  const angles: number[] = []

  for (const [bone, pairs] of grouped) {
    const { fit, determined } = fitSimilarity(pairs.src, pairs.dst, 1)
    bindPose.set(bone, fit)
    if (determined) angles.push(fit.rotation)
    else undetermined.push(bone)
  }

  // 只影响一个顶点的骨骼定不出旋转 —— 借同网格其余骨骼的中位角度,
  // 平移按那个角度重算,保证该顶点仍然落在原位
  if (undetermined.length > 0 && angles.length > 0) {
    const sorted = [...angles].sort((a, b) => a - b)
    const median = sorted[sorted.length >> 1]!
    const c = Math.cos(DEG * median)
    const s = Math.sin(DEG * median)
    for (const bone of undetermined) {
      const pairs = grouped.get(bone)!
      bindPose.set(bone, {
        rotation: median,
        scale: 1,
        x: pairs.dst[0]!.x - (c * pairs.src[0]!.x - s * pairs.src[0]!.y),
        y: pairs.dst[0]!.y - (s * pairs.src[0]!.x + c * pairs.src[0]!.y),
      })
    }
  }

  let residual = 0
  scaled.weights.forEach((entry, i) => {
    let x = 0
    let y = 0
    for (const w of entry) {
      const p = applyFit(bindPose.get(w.bone)!, w.x, w.y)
      x += p.x * w.weight
      y += p.y * w.weight
    }
    residual = Math.max(residual, Math.hypot(x - vertices[i]!.x, y - vertices[i]!.y))
  })

  return {
    vertices,
    triangles,
    bindPose,
    rigid: null,
    influences: verts.weights.map((entry) => entry.map((w) => ({ bone: w.bone, weight: w.weight }))),
    residual,
    undetermined,
  }
}
