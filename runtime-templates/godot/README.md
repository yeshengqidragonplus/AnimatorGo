# Godot 模板

将 `AnimatorGoPlayer.gd` 和导出的 `export/godot/` 资源复制到 Godot 工程。创建 `Node2D` 并挂载脚本，再设置 `exported_package`。

后续运行时实现使用 GDScript，坐标转换在导出器中完成：Godot 运行时不应再翻转 Y 轴。
