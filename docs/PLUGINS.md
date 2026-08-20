# 插件 SDK（首版契约）

插件承担外部格式与目标引擎的边界转换。编辑器、`core/` 和项目格式不应出现 Spine、Godot、Unity 或 Cocos 的专用数据类型。

## 目标与非目标

首版提供**随应用发布的本地 importer/exporter 插件**。它们是仓库内的 TypeScript 模块，在构建期打包；这足以实现 Spine 互通和三种引擎导出。

首版不执行用户下载的任意 JavaScript 插件。Electron 中运行第三方代码会带来文件访问、依赖供应链和崩溃隔离问题，需要单独的 sandbox 进程和签名机制，不能混入格式导出 MVP。

## Manifest

每个插件都包含一份静态 manifest：

```ts
interface PluginManifest {
  readonly id: string                 // 例：com.animatorgo.spine-import
  readonly version: string
  readonly displayName: string
  readonly apiVersion: 1
  readonly kind: 'importer' | 'exporter'
  readonly targets: readonly string[] // 例：['spine-4.1'] 或 ['godot']
}
```

插件注册表只根据 `id`、`apiVersion` 和 `kind` 启用插件。未知 API 版本拒绝加载，不能猜测兼容。

## 导入接口

```ts
interface ImporterPlugin<Options> {
  readonly manifest: PluginManifest
  import(context: ImportContext, options: Options): Promise<ImportResult>
}

interface ImportResult {
  readonly project: ProjectData
  readonly assets: readonly ImportedAsset[]
  readonly report: CompatibilityReport
}
```

导入插件读取用户选择的源文件，创建统一 `ProjectData` 与待复制进项目目录的资源。它不能写 Zustand store；UI 审核结果后才由应用一次性提交为可撤销的编辑操作。

## 导出接口

```ts
interface ExporterPlugin<Options> {
  readonly manifest: PluginManifest
  export(context: ExportContext, project: ProjectData, options: Options): Promise<ExportResult>
}

interface ExportResult {
  readonly files: readonly ExportedFile[]
  readonly report: CompatibilityReport
}
```

导出插件只接收不可变项目快照，返回相对 `export/` 的文件列表。应用通过 `platform/` 统一落盘，防止插件随意写入项目外路径。

## 兼容性报告

```ts
type CompatibilityLevel = 'loss' | 'approximated' | 'info'

interface CompatibilityIssue {
  readonly level: CompatibilityLevel
  readonly path: string
  readonly message: string
}

interface CompatibilityReport {
  readonly source: string
  readonly target: string
  readonly issues: readonly CompatibilityIssue[]
}
```

`loss` 表示目标格式无法表达，用户应能在导出前取消操作；`approximated` 表示视觉或行为可能不同；`info` 用于结构等价的调整。任何支持不足都必须至少产生一条报告项。

## 首批插件

| 插件 ID | 方向 | 目标 |
|---|---|---|
| `com.animatorgo.spine-import` | 导入 | Spine 3.8 / 4.1 JSON + atlas |
| `com.animatorgo.godot-export` | 导出 | 自有 Godot 资产 + 运行时 |
| `com.animatorgo.unity-export` | 导出 | 自有 Unity 资产 + 运行时 |
| `com.animatorgo.cocos-export` | 导出 | 自有 Cocos 资产 + 运行时 |
| `com.animatorgo.spine-3.8-export` | 导出 | Spine 3.8 JSON + atlas |
| `com.animatorgo.spine-4.1-export` | 导出 | Spine 4.1 JSON + atlas |
