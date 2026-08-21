# 开发进度与交接（2026-08-21）

## 产品定位

AnimatorGo 是一个类似 Spine 的桌面 2D 动画编辑器。用户编辑图片部件、骨骼、slot、时间轴和后续网格；骨骼动画是核心能力，不是产品全部。

内部项目模型是唯一真相来源。外部格式和引擎能力都通过 importer / exporter 插件接入：首批目标是 Spine JSON + atlas 导入、自有 Godot / Unity / Cocos 导出，以及 Spine 3.8 / 4.1 JSON + atlas 兼容导出。

## 已完成

### 基础架构

- `core/` 保持纯数学：骨骼层级、世界矩阵、动画采样（rotate / translate / scale / shear 四通道）、线性/stepped/Bezier 曲线、时间轴关键帧、`samplePose` 完整姿势采样。
- `ProjectData` 统一项目快照，包含图片、图集、骨架、皮肤、slot 和动画；`ProjectDocument` 负责可读 JSON 与运行时 `Map` 结构之间的往返转换。
- 构建期插件 SDK 与 `PluginRegistry` 已建立，含 manifest、API 版本校验、导入/导出结果和兼容性报告类型。详见 [PLUGINS.md](PLUGINS.md)。
- Electron 平台层经 IPC 提供项目目录、原子保存、图片读写、图片导入和 `atlases/` 打包产物读写；渲染进程没有 Node 文件系统权限。

### 当前可操作的编辑器能力

1. 打开或创建项目目录（自动建立 `images/`、`export/`、`atlases/`）。
2. 导入 PNG / JPG / WebP；原文件会复制进 `images/`，同名文件自动加序号，绝不覆盖。
3. 新项目可添加根骨骼，选中骨骼后可添加子骨骼。
4. 选中骨骼后，可在"图片部件"面板将图片绑定为 region attachment；重复绑定同一图片会改绑而非新建重叠 slot，且保留已改的颜色和混合模式。
5. **完整 TRS 编辑**：视口工具切换（旋转 R / 平移 T / 缩放 S 拖拽），属性面板数值编辑 x / y / rotation / scaleX / scaleY / shearX / shearY / length。setup 模式写绑定姿势，animate 模式在当前时刻打关键帧（偏移语义由 store 统一换算）。
6. **时间轴按通道分行**：每根骨骼的 rotate / translate / scale / shear 各一行；K 键固化所有已有通道在当前时刻的插值结果；右键按通道删帧。
7. **Slot 编辑面板**：绘制顺序上下移、双击改名、解除绑定、染色 + 不透明度、混合模式（normal / additive / multiply / screen）。删除和换序时皮肤的 slot 下标自动重排。
8. **正式图集打包**：一键 MaxRects 打包（`maxrects-packer`，POT 页、允许旋转、裁透明边），写出 `atlases/<项目名>.png` + `.atlas`（Spine 4.x 文本格式，`parseAtlas` 可读回），带区域框预览弹窗。
9. 编辑期预览支持混合模式近似（additive → CSS plus-lighter）和 slot alpha。
10. 撤销重做覆盖以上全部文档编辑；数值输入和拖拽手势按 merge key 合并成单条历史。

### 关键实现细节

- `src/core/renderCommands.ts` 从 `Skeleton + Atlas` 生成纯 `RenderCommand`（世界顶点、UV、颜色和混合模式）。
- **图集区域名 = `image.path`（images/ 内的文件名），不是 imageId**。imageId 带 `image:` 前缀，冒号会撞上 `.atlas` 文本的 `key: value` 语法。`attachment.path` 记的也是文件名，所以 looseAtlas 和正式打包的区域名一致，**重新打包只换布局，attachment / slot 全都不用动**（有测试锁定）。
- 编辑期画布预览仍走 `src/project/looseAtlas.ts`（每张原图一页）+ `src/ui/ImageOverlay.tsx` 原图叠加；正式打包产物给导出器和引擎用。图集布局纯逻辑在 `src/project/atlasLayout.ts`（可单测），像素合成（裁边扫描、页画布、旋转放置）在 `src/ui/atlasCompose.ts`。
- region 顶点计算已经处理图集 `offsetX/offsetY` 与原始尺寸，不能删掉；否则裁透明边的图片锚点会漂移。
- 皮肤按 slot 下标索引；`editorStore` 里所有 slot 删除/换序操作都要经 `remapSkins` 重排下标，直接改 slots 数组必错。
- 旋转放置约定：打包时逆时针转 90°（`ctx.setTransform(0,-1,1,0,…)`），渲染时 `regionUVs` 转回来。两边互逆,改任何一边必须同步另一边。

## 未完成

### 当前 MVP 缺口（下一优先级）

1. **视觉验证**：运行桌面应用（`pnpm dev`），用真实 PNG 验证：三种拖拽工具手感、TRS 关键帧回放、slot 染色/混合模式叠加效果、图集打包产物（旋转区域是否摆正、裁边锚点是否漂移）、不同 DPI 与窗口 resize。
2. 曲线编辑器 UI（贝塞尔在 `core/` 已实现,关键帧上还没有编辑入口）。
3. 动画管理:目前只有单个动画（sample walk / 项目文件里的第一个）,缺新建/改名/切换动画的 UI。
4. 图集打包参数（页上限、padding、是否旋转）目前是代码常量 `DEFAULT_PACK_OPTIONS`,未做 UI。

### 后续大功能

- Spine 3.8 / 4.1 JSON + atlas importer，并生成兼容性报告。
- Godot、Unity、Cocos 自有格式 exporter 与最小运行时。
- Spine 3.8 / 4.1 JSON + atlas exporter（不承诺 `.skel` 二进制）。
- 网格、权重、IK、约束、动画混合。

## 验证状态

- `pnpm typecheck` ✅（曾有 2 处 `PluginRegistry` 联合类型收窄错误，已用 `in` 判别修复）
- `pnpm test` ✅ 118/118（含新增：TRS 编辑语义、slot 重排/改名/颜色、shear 求值、samplePose、图集布局不重叠/POT/超限报错、`.atlas` 序列化经 `parseAtlas` 往返一致、重打包引用稳定）
- `pnpm build` ✅
- **桌面应用未做视觉验证**（用户要求暂缓）。

## 兼容性注意

`attachment.path` 语义从 imageId 改成了图片文件名（见上）。项目格式版本仍是 1 —— 这个阶段没有真实存量项目，未写迁移；若有旧的 project.json，重新绑定图片即可。`AtlasPageAsset` 形状也从 `{name, imageId}` 改为 `{name, path}`。

## 给后续开发者的约束

- 不要让 PixiJS、Electron、Spine 或引擎 API 进入 `src/core/`。
- 不要复制、翻译或移植 Spine Runtime 源码；兼容解析/序列化必须自行实现。
- Spine 兼容导出必须返回 `loss` / `approximated` / `info` 报告，禁止静默省略特性。
- 项目文件要保持文本 JSON 可 diff；所有文件 I/O 通过 `platform/`。
- 用户当前要求优先完成可用的图片部件骨骼动画编辑器，不要先扩展网格、IK 或跨引擎功能。
