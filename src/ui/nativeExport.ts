import { cocosExporter, godotExporter, unityExporter, type NativeRuntimeTarget } from '@plugins/nativeExport.ts'
import { platform } from '@platform/index.ts'
import type { ProjectData } from '@project/types.ts'

const exporters = { godot: godotExporter, unity: unityExporter, cocos: cocosExporter } as const

/** 将插件返回的数据文件和项目资产写到 `export/<target>/`。 */
export async function exportNativePackage(projectDir: string, project: ProjectData, target: NativeRuntimeTarget): Promise<void> {
  const result = await exporters[target].export({ projectName: project.name }, project, undefined)
  for (const file of result.files) await platform().writeExport(projectDir, `${target}/${file.relativePath}`, file.data)

  if (project.atlases.length > 0) {
    for (const atlas of project.atlases) {
      await copyAtlasFile(projectDir, target, atlas.path)
      for (const page of atlas.pages) await copyAtlasFile(projectDir, target, page.path)
    }
  } else {
    for (const image of project.images) {
      await platform().writeExport(projectDir, `${target}/images/${image.path}`, await platform().readImage(projectDir, image.path))
    }
  }
}

async function copyAtlasFile(projectDir: string, target: NativeRuntimeTarget, path: string): Promise<void> {
  const prefix = 'atlases/'
  if (!path.startsWith(prefix)) throw new Error(`无效的图集项目路径: ${path}`)
  const name = path.slice(prefix.length)
  await platform().writeExport(projectDir, `${target}/${path}`, await platform().readAtlasFile(projectDir, name))
}
