# 开发进度与交接（2026-08-21）

## 产品定位

AnimatorGo 是一个类似 Spine 的桌面 2D 动画编辑器。用户编辑图片部件、骨骼、slot、时间轴和后续网格；骨骼动画是核心能力，不是产品全部。

内部项目模型是唯一真相来源。外部格式和引擎能力都通过 importer / exporter 插件接入：首批目标是 Spine JSON + atlas 导入、自有 Godot / Unity / Cocos 导出，以及 Spine 3.8 / 4.1 JSON + atlas 兼容导出。

## 已完成

### 基础架构

- `core/` 保持纯数学：骨骼层级、世界矩阵、动画旋转采样、线性/stepped/Bezier 曲线、时间轴关键帧。
- `ProjectData` 统一项目快照，包含图片、图集、骨架、皮肤、slot 和动画；`ProjectDocument` 负责可读 JSON 与运行时 `Map` 结构之间的往返转换。
- 构建期插件 SDK 与 `PluginRegistry` 已建立，含 manifest、API 版本校验、导入/导出结果和兼容性报告类型。详见 [PLUGINS.md](PLUGINS.md)。
- Electron 平台层经 IPC 提供项目目录、原子保存、图片读写和图片导入；渲染进程没有 Node 文件系统权限。

### 当前可操作的编辑器能力

1. 打开或创建项目目录（自动建立 `images/`、`export/`）。
2. 导入 PNG / JPG / WebP；原文件会复制进 `images/`，同名文件自动加序号，绝不覆盖。
3. 新项目可添加根骨骼，选中骨骼后可添加子骨骼。
4. 选中骨骼后，可在“图片部件”面板将图片绑定为 region attachment；重复绑定同一图片会改绑而非新建重叠 slot。
5. 已绑定图片会显示在画布中，并跟随现有骨骼姿势、旋转关键帧和播放头更新。
6. 撤销重做覆盖骨骼、关键帧、图片资源和绑定操作。

### 关键实现细节

- `src/core/renderCommands.ts` 从 `Skeleton + Atlas` 生成纯 `RenderCommand`（世界顶点、UV、颜色和混合模式）。
- 编辑期未做正式打包：`src/project/looseAtlas.ts` 把每张原图临时当作独立图集页，使导入后立即可预览。正式 MaxRects 打包应在导出前或资源整理阶段替换它。
- region 顶点计算已经处理图集 `offsetX/offsetY` 与原始尺寸，不能删掉；否则裁透明边的图片锚点会漂移。
- 预览期原图由 `src/ui/ImageOverlay.tsx` 叠加到 Pixi 画布上。未来改为 Pixi Mesh 图集渲染时，继续复用 `RenderCommand`，不要把 Pixi 类型带入 `core/`。

## 未完成

### 当前 MVP 缺口（下一优先级）

1. **完整 TRS 编辑**：现有 UI 只支持旋转；要补 translate、scale、shear 的拖拽/数值编辑与各自时间轴。
2. **Slot 编辑**：目前绑定操作自动创建 slot；需要 slot 列表、改名、解除绑定、绘制顺序、颜色和 blend mode 编辑。
3. **正式图集工作流**：MaxRects 打包、裁透明边、图集预览、重新打包时 attachment 与引用保持稳定。
4. **视觉验证**：依赖恢复后运行桌面应用，用真实 PNG 验证图片叠加的缩放、旋转、不同 DPI 与窗口 resize。

### 后续大功能

- Spine 3.8 / 4.1 JSON + atlas importer，并生成兼容性报告。
- Godot、Unity、Cocos 自有格式 exporter 与最小运行时。
- Spine 3.8 / 4.1 JSON + atlas exporter（不承诺 `.skel` 二进制）。
- 网格、权重、IK、约束、曲线编辑、动画混合。

## 验证状态

- `git diff --check` 已通过。
- 已新增 Vitest 覆盖：项目格式往返、插件注册、原图图集、RenderCommand、裁剪 offset、图片绑定、骨骼新增。
- **未能运行 `pnpm test` / `pnpm typecheck`**：本工作区没有 `node_modules`，而 `corepack` 尝试联网取得 pnpm 时网络被拒绝。恢复依赖后应优先执行：

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm dev
```

如果远程桌面或虚拟机中 Electron GPU 出错，使用：

```bash
ANIMATORGO_DISABLE_GPU=1 pnpm dev
```

## 给后续开发者的约束

- 不要让 PixiJS、Electron、Spine 或引擎 API 进入 `src/core/`。
- 不要复制、翻译或移植 Spine Runtime 源码；兼容解析/序列化必须自行实现。
- Spine 兼容导出必须返回 `loss` / `approximated` / `info` 报告，禁止静默省略特性。
- 项目文件要保持文本 JSON 可 diff；所有文件 I/O 通过 `platform/`。
- 用户当前要求优先完成可用的图片部件骨骼动画编辑器，不要先扩展网格、IK 或跨引擎功能。
