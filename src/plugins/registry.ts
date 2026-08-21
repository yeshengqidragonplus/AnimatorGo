import { PLUGIN_API_VERSION, type ExporterPlugin, type ImporterPlugin, type Plugin } from './types.ts'

/**
 * 构建期插件注册表。重复 ID 或 API 不匹配立即报错，避免导入/导出时才发现用错实现。
 */
export class PluginRegistry {
  private readonly plugins = new Map<string, Plugin>()

  register(plugin: Plugin): void {
    const { manifest } = plugin
    if (manifest.apiVersion !== PLUGIN_API_VERSION) {
      throw new Error(`插件 ${manifest.id} 的 API 版本 ${manifest.apiVersion} 不受支持`)
    }
    if (this.plugins.has(manifest.id)) throw new Error(`插件 ID 重复: ${manifest.id}`)
    this.plugins.set(manifest.id, plugin)
  }

  // 用方法存在性收窄联合类型 —— manifest.kind 嵌在一层里,TS 无法据此收窄外层
  getImporter(id: string): ImporterPlugin<unknown> | undefined {
    const plugin = this.plugins.get(id)
    return plugin !== undefined && 'import' in plugin ? plugin : undefined
  }

  getExporter(id: string): ExporterPlugin<unknown> | undefined {
    const plugin = this.plugins.get(id)
    return plugin !== undefined && 'export' in plugin ? plugin : undefined
  }

  list(): readonly Plugin[] {
    return [...this.plugins.values()]
  }
}
