import type { Skeleton } from '@core/index.ts'

/**
 * 编辑器的拾取逻辑。刻意放在 ui/ 而不是 core/ ——
 * core/ 只装运行时需要的东西,拾取是编辑器独有的。
 */

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - ax, py - ay)

  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/**
 * 找出离 (x, y) 最近的骨骼,世界坐标。超出 threshold 返回 null。
 *
 * 无长度的骨骼(如 root)按关节点算距离。
 */
export function pickBone(skeleton: Skeleton, x: number, y: number, threshold = 12): string | null {
  let best: string | null = null
  let bestDist = threshold

  for (const bone of skeleton.bones) {
    const [tipX, tipY] = bone.tipWorld()
    const dist =
      bone.data.length <= 0
        ? Math.hypot(x - bone.worldX, y - bone.worldY)
        : distanceToSegment(x, y, bone.worldX, bone.worldY, tipX, tipY)

    if (dist < bestDist) {
      bestDist = dist
      best = bone.data.name
    }
  }

  return best
}
