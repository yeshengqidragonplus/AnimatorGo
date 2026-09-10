/**
 * Spine 的逐帧绘制顺序(drawOrder 时间轴)。
 *
 * 一帧只存「哪些 slot 挪了、挪几位」:`offsets: [{ slot, offset }]`,按 slot 下标升序。
 * 完整顺序要按 Spine 的规则铺出来(见 docs/SPINE-BINARY.md):
 *
 * 1. 挪了的 slot 放到 `原下标 + offset` 的位置
 * 2. 没挪的 slot 按原顺序,依次填进剩下的空位
 *
 * 空 offsets 表示回到 setup 顺序。
 */

export interface DrawOrderOffset {
  readonly slot: number
  readonly offset: number
}

/**
 * 铺出一帧的完整绘制顺序:返回数组的第 i 项是画在第 i 层的 slot 下标(0 最底)。
 */
export function drawOrderOf(slotCount: number, offsets: readonly DrawOrderOffset[]): number[] {
  const order = new Array<number>(slotCount).fill(-1)
  const unchanged: number[] = []
  let original = 0
  const sorted = [...offsets].sort((a, b) => a.slot - b.slot)
  for (const { slot, offset } of sorted) {
    // slot 之前没提到的都是没挪的
    while (original < slot && original < slotCount) unchanged.push(original++)
    const target = slot + offset
    if (slot < 0 || slot >= slotCount || target < 0 || target >= slotCount) {
      throw new Error(`drawOrder 越界:slot ${slot} 挪 ${offset} 位(共 ${slotCount} 个 slot)`)
    }
    if (order[target] !== -1) throw new Error(`drawOrder 冲突:第 ${target} 层已被 slot ${order[target]} 占用,slot ${slot} 也要放这里`)
    order[target] = slot
    original = slot + 1
  }
  while (original < slotCount) unchanged.push(original++)
  // 没挪的从后往前填空位 —— 与 Spine 一致
  let u = unchanged.length
  for (let i = slotCount - 1; i >= 0; i--) {
    if (order[i] === -1) order[i] = unchanged[--u]!
  }
  return order
}

/** 反过来:每个 slot 画在第几层 */
export function layerOfSlot(order: readonly number[]): number[] {
  const layer = new Array<number>(order.length).fill(0)
  order.forEach((slot, i) => (layer[slot] = i))
  return layer
}
