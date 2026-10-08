import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * 一个 Unity 角色目录里的所有文件,键是相对路径(正斜杠)。图片按字节读,其余按 UTF-8 文本读 ——
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
        out.set(rel, /\.(png|jpg|jpeg)$/i.test(rel) ? new Uint8Array(bytes) : bytes.toString('utf8'))
      }
    }
  }
  walk(root)
  return out
}
