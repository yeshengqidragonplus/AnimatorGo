import { describe, expect, it } from 'vitest'
import { PluginRegistry } from './registry.ts'
import type { ExporterPlugin, ImporterPlugin } from './types.ts'

const importer: ImporterPlugin = {
  manifest: {
    id: 'com.animatorgo.test-import', version: '1.0.0', displayName: 'Test import', apiVersion: 1,
    kind: 'importer', targets: ['test'],
  },
  async import() {
    throw new Error('test fixture should not be executed')
  },
}

const exporter: ExporterPlugin = {
  manifest: {
    id: 'com.animatorgo.test-export', version: '1.0.0', displayName: 'Test export', apiVersion: 1,
    kind: 'exporter', targets: ['test'],
  },
  async export() {
    throw new Error('test fixture should not be executed')
  },
}

describe('插件注册表', () => {
  it('按能力取回 importer 与 exporter', () => {
    const registry = new PluginRegistry()
    registry.register(importer)
    registry.register(exporter)

    expect(registry.getImporter(importer.manifest.id)).toBe(importer)
    expect(registry.getExporter(importer.manifest.id)).toBeUndefined()
    expect(registry.getExporter(exporter.manifest.id)).toBe(exporter)
  })

  it('拒绝重复插件 ID', () => {
    const registry = new PluginRegistry()
    registry.register(importer)
    expect(() => registry.register(importer)).toThrow('插件 ID 重复')
  })
})
