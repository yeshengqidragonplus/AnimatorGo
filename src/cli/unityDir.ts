import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { parseColorSpace, type ColorSpace } from '../unity/colorSpace.ts'

/**
 * 一个 Unity 角色目录里的所有文件,键是相对路径(正斜杠)。图片和 Photoshop 文件按字节读,其余按 UTF-8 文本读 ——
 * Unity 读取器(`importUnity`)吃的就是这个。
 */
export function readUnityDir(root: string): Map<string, string | Uint8Array> {
  const out = new Map<string, string | Uint8Array>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        const rel = relative(root, full).split('\\').join('/')
        const bytes = readFileSync(full)
        out.set(rel, /\.(png|jpg|jpeg|psd|psb)$/i.test(rel) ? new Uint8Array(bytes) : bytes.toString('utf8'))
      }
    }
  }
  walk(root)
  return out
}

/**
 * 某个目录所在 Unity 工程的色彩空间(往上找 `ProjectSettings/ProjectSettings.asset` 的 `m_ActiveColorSpace`);
 * 不在工程里或读不出返回 null。只影响 SkinnedMeshRenderer 的顶点色 —— Unity 不对顶点色做 sRGB 换算(见 colorSpace.ts)
 */
export function detectColorSpace(dir: string): { space: ColorSpace; from: string } | null {
  let current = resolve(dir)
  for (let up = 0; up < 12; up++) {
    const file = join(current, 'ProjectSettings', 'ProjectSettings.asset')
    if (existsSync(file)) {
      const space = parseColorSpace(readFileSync(file, 'utf8'))
      return space === null ? null : { space, from: file }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}
