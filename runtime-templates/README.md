# AnimatorGo 引擎运行时模板

导出器会在 `export/<target>/` 生成：

```text
animatorgo.json   骨骼、slot、attachment、动画数据
manifest.json     包版本与需要复制的资源路径
atlases/ 或 images/ 图集页或原图
```

本目录给每个目标引擎提供可直接复制进项目的运行时模板。它们的职责是读取统一数据包、采样动画、计算骨骼世界变换，并按 slot 顺序绘制 attachment。

当前模板完成资源定位、数据加载和 API 外观；骨骼求值与渲染循环会在“各引擎运行时”阶段补齐。不要让引擎专用类型进入 `src/core/`；公式应从 AnimatorGo core 翻译到对应语言。

**已定：不建设 C++ 共用库。** Godot、Unity、Cocos 仍需各自处理渲染、资源加载和平台打包，
引入 GDExtension / Native Plugin / JSB 桥接只会增加当前阶段的复杂度。仅当三套原生运行时
验证完且纯数学计算确实成为性能瓶颈时，才重新评估抽取 C++ 算法库。

| 目录 | 语言 | 放置位置 |
|---|---|---|
| `godot/` | GDScript | Godot 项目 `res://` |
| `unity/` | C# | Unity 项目 `Assets/AnimatorGo/` |
| `cocos/` | TypeScript | Cocos Creator 项目 `assets/AnimatorGo/` |
