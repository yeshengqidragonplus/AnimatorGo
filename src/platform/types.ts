/**
 * 平台层接口 —— `core/` / `render/` / `ui/` 访问文件系统的唯一途径。
 *
 * 当前由 Electron 主进程实现(electron/preload.ts)。将来若换 Tauri,
 * 只需要提供一个同样形状的实现,上层代码不动。见 docs/ARCHITECTURE.md「平台层」。
 *
 * 所有方法都只收**项目目录 + 相对文件名**,不收绝对路径 ——
 * 路径拼接和越界检查在主进程侧做。
 */
export interface Platform {
  /** 弹出目录选择框。用户取消返回 null。 */
  openProjectDir(): Promise<string | null>

  /** 建立 images/ 和 export/ 目录。已存在时是空操作,可重复调用。 */
  scaffoldProject(dir: string): Promise<void>

  /** 读 project.json。新项目还没有这个文件时返回 null,不是错误。 */
  readProject(dir: string): Promise<string | null>

  /** 写 project.json。实现侧用「临时文件 + 改名」保证不会写坏已有工程。 */
  writeProject(dir: string, json: string): Promise<void>

  /** 列出 images/ 下的图片文件名(已排序) */
  listImages(dir: string): Promise<string[]>

  /** 用户选择外部图片后复制进 images/，同名素材自动改名；返回项目内文件名。 */
  importImages(dir: string): Promise<string[]>

  readImage(dir: string, name: string): Promise<Uint8Array>

  /** 写入 export/ 下的文件,父目录自动创建 */
  writeExport(dir: string, relativePath: string, data: string | Uint8Array): Promise<void>

  /** 读写 atlases/ 下的打包产物(页 PNG 与 .atlas 文本) */
  writeAtlasFile(dir: string, name: string, data: string | Uint8Array): Promise<void>
  readAtlasFile(dir: string, name: string): Promise<Uint8Array>
}

declare global {
  interface Window {
    animatorGo?: Platform
  }
}
