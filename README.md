# AnimatorGo

个人自用的、类似 Spine 的 2D 动画编辑器。它以图片部件、图层、骨骼、网格和时间轴为核心，骨骼动画是核心能力之一，而不是产品的全部。

**当前状态：编辑器 MVP 开发中。** 已具备项目打开/保存、图片导入、骨骼层级、图片绑定、旋转动画、时间轴、撤销重做与图片预览；完整 TRS、slot 编辑、正式图集和格式插件尚未完成。详见 [docs/PROGRESS.md](docs/PROGRESS.md)。

---

## 这是什么

一个类似 Spine 的 2D 动画工具：

- 导入切图,自动打包图集
- 搭骨骼层级,绑定切图
- 时间轴打关键帧
- 网格形变(自动三角化 + 自动权重 + 权重刷)
- IK
- 动画融合(混合、分层)
- 通过插件导入外部资产；首批支持 Spine JSON + atlas
- 通过插件导出自有格式到 Godot / Unity / Cocos Creator，各引擎有对应运行时负责播放
- 通过兼容导出插件生成 Spine 3.8 / 4.1 的 JSON + atlas 资产

## 核心理念

这四条决定了本项目的所有取舍,优先级高于任何单个功能。

### 1. 范围控制优先于功能完整度

单人项目。Spine 打磨了十几年,不以「追平」为目标。每个功能都要问「不做会怎样」,而不是「做了会更好吗」。

### 2. 正确性的标准是肉眼

这是个人自用工具。**用户肉眼看不出问题 = 没问题。** 不追求跨引擎像素级一致,不前置搭建容差断言、逐值比对这类产品级基础设施。等真的遇到问题再说。

### 3. 自建格式 + 每引擎一个运行时

编辑器输出自有格式(图集 + 数据文件),每个目标引擎有一个运行时负责解析和播放。这是 Spine 的架构。

代价是永久维护 N 个运行时,**已知晓并接受**。换来的是网格形变、IK、动画融合在所有引擎上行为一致——这些特性在引擎原生动画格式里没有对应物。

### 4. `core/` 与 `render/` 严格分层

```
core/     纯数学,零渲染 API 依赖
render/   薄适配层,每引擎一个
```

这是**硬约束**。渲染 API 一旦泄漏进 `core/`,每个引擎就得重新设计一遍,是这条路线唯一真正会失控的地方。

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 明确不做的事

不要重新提议以下方案,它们已被评估并否决,理由见 [docs/DECISIONS.md](docs/DECISIONS.md):

| 方案 | 原因 |
|---|---|
| Spine Runtime 源码移植或复制 | 版权与许可证不兼容；兼容导出插件可自行实现格式写入 |
| Live2D `.moc3` 导出 | 闭源二进制,SDK 授权禁止逆向,且模型不同构 |
| DragonBones 格式 | 生态多年无人维护 |
| 导出引擎原生动画格式 | 有损,只能承载特性交集 |
| 第三方付费插件(PolyRig 等) | 所需算法均为公开算法,自己实现 |

## 文档

| 文档 | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构、分层、导出职责、各引擎能力矩阵 |
| [docs/FORMAT.md](docs/FORMAT.md) | **格式规范** —— 坐标系约定、数据模型、图集格式。这是所有运行时的共同契约 |
| [docs/PLUGINS.md](docs/PLUGINS.md) | importer / exporter 插件边界、SDK 契约与首批插件 |
| [docs/PROGRESS.md](docs/PROGRESS.md) | 当前实现、未完成项、验证状态与交接说明 |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 已否决方案及理由 |
| [CLAUDE.md](CLAUDE.md) | 给 Claude Code 的操作性约束 |

## 技术栈

**Electron + TypeScript + React + PixiJS** —— 桌面应用,Windows / macOS 双平台。

文件读写隔离在 `platform/` 一层,将来若换 Tauri 只动那一层。

**否决 Tauri 的关键理由:它无法从 Windows 交叉编译到 macOS**,那意味着必须有台 Mac 才能出 Mac 版。

## 实现顺序

1. 内部项目格式与 importer/exporter 插件 SDK
2. 项目管理、图片部件、切图/图集、slot/attachment 可视化编辑
3. 骨骼绑定 + TRS 时间轴 + 实时预览 ← **首个可用闭环**
4. Spine JSON + atlas 导入插件
5. Godot / Unity / Cocos 自有格式导出插件与最小运行时
6. Spine 3.8 / 4.1 JSON + atlas 兼容导出插件
7. 网格形变(CDT + Lloyd Relaxation + Geodesic IDW + 权重刷)、IK、动画融合

## License

MIT
