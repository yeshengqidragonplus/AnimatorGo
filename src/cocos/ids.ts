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

/**
 * 压缩的 uuid(23 个字符):prefab 里脚本组件的 `__type__` 就是脚本资源 uuid 的这种写法 —— 构建出来的代码里
 * `_RF.push({}, "f5ec8w5dYx6dOIk+Mm7CxJm", "AnimatorGoMesh")`,引擎用 `js._setClassId` 把它登记成类 id,反序列化按它找类。
 * 算法(实测对照构建产物):前 5 个十六进制原样,其余 27 个每 3 个(12 位)→ 2 个 base64 字符,和引擎 `decodeUuid`
 * 认的 22 字符形式(前 2 个原样)不是同一种 —— 类 id 只要和构建产物一致就行,不经过 decodeUuid。
 */
export function compressUuid(uuid: string): string {
  const hex = uuid.replace(/-/g, '')
  if (hex.length !== 32) throw new Error(`不是 uuid:${uuid}`)
  let out = hex.slice(0, 5)
  for (let i = 5; i < 32; i += 3) {
    const v = parseInt(hex.slice(i, i + 3), 16)
    out += BASE64_KEYS[v >> 6]! + BASE64_KEYS[v & 63]!
  }
  return out
}

const BASE64_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * 运行时脚本(tools/cocos/runtime/)的 uuid,固定:`.meta` 里写的就是它,prefab 里的组件靠压缩形式认类。
 * 改了这里一定要同步 `.meta`(有测试盯着)。
 */
export const RUNTIME_SCRIPTS = {
  AnimatorGoSkinning: cocosUuid('animatorgo/runtime/AnimatorGoSkinning'),
  AnimatorGoClip: cocosUuid('animatorgo/runtime/AnimatorGoClip'),
  AnimatorGoMesh: cocosUuid('animatorgo/runtime/AnimatorGoMesh'),
} as const

/** 目录 AnimatorGoRuntime/ 的 uuid */
export const RUNTIME_DIR_UUID = cocosUuid('animatorgo/runtime')

/** prefab 里 AnimatorGoMesh / AnimatorGoClip 组件的 `__type__` */
export const MESH_TYPE = compressUuid(RUNTIME_SCRIPTS.AnimatorGoMesh)
export const CLIP_TYPE = compressUuid(RUNTIME_SCRIPTS.AnimatorGoClip)

/** `.anim` 里 ComponentPath 用的类名(getComponent 按 ccclass 的名字找) */
export const MESH_CLASS = 'AnimatorGoMesh'
export const CLIP_CLASS = 'AnimatorGoClip'
