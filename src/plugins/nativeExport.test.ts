import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '@project/types.ts'
import { cocosExporter, godotExporter, unityExporter } from './nativeExport.ts'

describe('自有运行时导出插件', () => {
  it.each([godotExporter, unityExporter, cocosExporter])('输出目标引擎可识别的统一资源包: $manifest.id', async (exporter) => {
    const result = await exporter.export({ projectName: 'hero' }, createEmptyProject('hero'), undefined)
    expect(result.files.map((file) => file.relativePath)).toEqual(['animatorgo.json', 'manifest.json'])
    expect(JSON.parse(result.files[1]!.data as string)).toMatchObject({ format: 'animatorgo-runtime', target: exporter.manifest.targets[0] })
    expect(result.report.issues[0]?.level).toBe('info')
  })

  it('优先声明图集资产；没有图集时声明原图', async () => {
    const project = { ...createEmptyProject('hero'), images: [{ id: 'body', path: 'body.png', width: 32, height: 32 }] }
    const result = await godotExporter.export({ projectName: 'hero' }, project, undefined)
    const manifest = JSON.parse(result.files[1]!.data as string)
    expect(manifest.assets).toEqual(['images/body.png'])
  })
})
