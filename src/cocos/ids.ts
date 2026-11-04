import { createHash } from 'node:crypto'

/**
 * Cocos Creator 资源标识符的确定性生成。
 *
 * 和 Unity 一样(unity/ids.ts):**每次导出必须得到同样的 ID**。Cocos 靠 uuid 认资源(`.meta` 里的 `uuid`,
 * 引用写成 `{"__uuid__": "<uuid>"}`),prefab 里每个节点 / 组件各有一个 `fileId`。重新导出换一批的话,
 * 场景里对 prefab 的引用、动画对 spriteFrame 的引用全断,Inspector 里只是一行 Missing。
 *
 * 所以一律「名字 → 哈希」。Cocos 自己的 uuid 是随机 v4,格式上只要是 8-4-4-4-12 的十六进制就认
 * (实测:sha1 拼出来的 uuid 导入、构建、运行都正常)。
 */

/** 36 位的 uuid,sha1(种子)截前 32 个十六进制 */
export function cocosUuid(seed: string): string {
  const h = createHash('sha1').update(`animatorgo:${seed}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/**
 * prefab 里节点 / 组件的 `fileId`:22 个字符,字母表 A-Za-z0-9+/(Cocos 自己写的也是这样,
 * 例如 `a0C8RfybZDJbzD2rhAA/j8`)。只当键用,不参与别的计算。
 */
export function fileId(seed: string): string {
  return createHash('sha1').update(`animatorgo-file:${seed}`).digest('base64').slice(0, 22)
}

/** 子资源:图片的 texture / spriteFrame 两个子资源 id 是固定的(所有工程都一样,实测) */
export const TEXTURE_SUB_ID = '6c48a'
export const SPRITE_FRAME_SUB_ID = 'f9941'

export const spriteFrameUuid = (imageUuid: string): string => `${imageUuid}@${SPRITE_FRAME_SUB_ID}`
export const textureUuid = (imageUuid: string): string => `${imageUuid}@${TEXTURE_SUB_ID}`
