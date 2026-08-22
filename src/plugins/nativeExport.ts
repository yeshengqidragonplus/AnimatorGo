import { toProjectDocument } from '@project/types.ts'
import type { ExporterPlugin, ExportResult } from './types.ts'

/** 首批自有运行时目标。三者读取同一份 animatorgo.json，只是宿主运行时语言不同。 */
export type NativeRuntimeTarget = 'godot' | 'unity' | 'cocos'

export interface NativePackageManifest {
  readonly format: 'animatorgo-runtime'
  readonly version: 1
  readonly target: NativeRuntimeTarget
  readonly projectName: string
  /** 导出器应随资源包复制的项目内图集/图片相对路径。 */
  readonly assets: readonly string[]
}

function assetPaths(project: Parameters<ExporterPlugin['export']>[1]): string[] {
  const atlasPaths = project.atlases.flatMap((atlas) => [atlas.path, ...atlas.pages.map((page) => page.path)])
  // 未打图集时，运行时直接引用原图；已打图集时，图集页足够。
  return atlasPaths.length > 0 ? atlasPaths : project.images.map((image) => `images/${image.path}`)
}

/**
 * 生成各引擎共同读取的资源包。插件不自行读取文件系统：宿主根据 manifest.assets
 * 从项目目录复制二进制资源，保证插件只能产生 export/ 内的相对文件。
 */
export function createNativeExporter(target: NativeRuntimeTarget): ExporterPlugin {
  return {
    manifest: {
      id: `com.animatorgo.${target}-export`,
      version: '0.1.0',
      displayName: `${target === 'godot' ? 'Godot' : target === 'unity' ? 'Unity' : 'Cocos'} 自有格式导出`,
      apiVersion: 1,
      kind: 'exporter',
      targets: [target],
    },
    async export(context, project): Promise<ExportResult> {
      const manifest: NativePackageManifest = {
        format: 'animatorgo-runtime',
        version: 1,
        target,
        projectName: context.projectName,
        assets: assetPaths(project),
      }
      return {
        files: [
          { relativePath: 'animatorgo.json', data: JSON.stringify({ format: 'animatorgo-runtime', version: 1, project: toProjectDocument(project) }, null, 2) },
          { relativePath: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
        ],
        report: {
          source: 'animatorgo',
          target,
          issues: [{ level: 'info', path: '', message: '已生成 AnimatorGo Runtime Package；请同时复制 manifest.json 列出的资源文件。' }],
        },
      }
    },
  }
}

export const godotExporter = createNativeExporter('godot')
export const unityExporter = createNativeExporter('unity')
export const cocosExporter = createNativeExporter('cocos')
