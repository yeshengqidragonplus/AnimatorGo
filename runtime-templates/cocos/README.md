# Cocos Creator 模板

复制 `AnimatorGoPlayer.ts` 到 `assets/AnimatorGo/`，并导入 `export/cocos/` 的 JSON 和纹理资源。把 `animatorgo.json` 指给组件的 `packageJson` 属性。

完整播放器会使用自定义渲染组件/assembler；不能依赖 Cocos 的原生骨骼动画格式，因为它无法覆盖 AnimatorGo 后续的网格和 slot 行为。
