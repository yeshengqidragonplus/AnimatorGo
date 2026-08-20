import type { ProjectData } from '@project/types.ts'

export const PLUGIN_API_VERSION = 1 as const

export type PluginKind = 'importer' | 'exporter'
export type CompatibilityLevel = 'loss' | 'approximated' | 'info'

export interface PluginManifest {
  readonly id: string
  readonly version: string
  readonly displayName: string
  readonly apiVersion: typeof PLUGIN_API_VERSION
  readonly kind: PluginKind
  readonly targets: readonly string[]
}

export interface CompatibilityIssue {
  readonly level: CompatibilityLevel
  readonly path: string
  readonly message: string
}

export interface CompatibilityReport {
  readonly source: string
  readonly target: string
  readonly issues: readonly CompatibilityIssue[]
}

/** 相对项目 images/ 的目标路径以及待写入字节。 */
export interface ImportedAsset {
  readonly relativePath: string
  readonly data: Uint8Array
}

/** 相对项目 export/ 的目标路径以及待写入内容。 */
export interface ExportedFile {
  readonly relativePath: string
  readonly data: string | Uint8Array
}

/** 文件访问由宿主注入，插件没有绝对路径或 Node 文件系统访问权。 */
export interface ImportContext {
  readSource(relativePath: string): Promise<Uint8Array>
}

export interface ExportContext {
  readonly projectName: string
}

export interface ImportResult {
  readonly project: ProjectData
  readonly assets: readonly ImportedAsset[]
  readonly report: CompatibilityReport
}

export interface ExportResult {
  readonly files: readonly ExportedFile[]
  readonly report: CompatibilityReport
}

export interface ImporterPlugin<Options = undefined> {
  readonly manifest: PluginManifest & { readonly kind: 'importer' }
  import(context: ImportContext, options: Options): Promise<ImportResult>
}

export interface ExporterPlugin<Options = undefined> {
  readonly manifest: PluginManifest & { readonly kind: 'exporter' }
  export(context: ExportContext, project: ProjectData, options: Options): Promise<ExportResult>
}

export type Plugin = ImporterPlugin<unknown> | ExporterPlugin<unknown>
