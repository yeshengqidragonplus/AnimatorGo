# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 命令

包管理器是 **pnpm**。这是 **Electron 桌面应用**,不是网页应用。

```bash
pnpm dev          # 启动桌面应用(Vite + esbuild 打包主进程 + 拉起 Electron)
pnpm build        # 类型检查 + 构建 dist/ 和 dist-electron/
pnpm build:win    # 打包 Windows 安装程序 → release/
pnpm build:mac    # 打包 macOS dmg → release/
pnpm typecheck
pnpm test         # vitest 单跑一次
pnpm test:watch
```

`pnpm dev:web` 只起 Vite(浏览器里打开会因为没有 `platform/` 而报错,仅用于调试渲染层)。

**关掉 Electron 窗口 = 结束 `pnpm dev`**,这是 [scripts/dev.mjs](scripts/dev.mjs) 里有意为之的。

远程桌面或虚拟机里 GPU 进程会崩,用 `ANIMATORGO_DISABLE_GPU=1 pnpm dev` 走软件渲染。

**没有用 `vite-plugin-electron`** —— 它当前版本按 rolldown 接口传参,和 Vite 6 对不上,
能构建但启动不了 Electron。主进程由 [scripts/electron-bundle.mjs](scripts/electron-bundle.mjs) 用 esbuild 单独打包。

跑单个测试文件:`pnpm exec vitest run src/core/math.test.ts`
跑单个用例:`pnpm exec vitest run -t "旋转差值走最短路径"`

## 当前进度

**骨骼、时间轴、图片部件、slot 编辑和图集打包的 MVP 已完成**：

- `core/` 变换数学、骨骼层级、动画求值(rotate/translate/scale/shear 四通道,线性/stepped/贝塞尔曲线)
- PixiJS 骨骼渲染层、原图预览层、撤销重做(不可变快照 + merge key 合并)
- 时间轴:播放、擦洗、按通道分行、打关键帧(K 固化全部已有通道)、删关键帧
- 完整 TRS 编辑:视口工具 R/T/S 拖拽 + 属性面板数值编辑
- Slot 编辑:绘制顺序、改名、解绑、颜色、混合模式(皮肤下标自动重排)
- 正式图集打包:MaxRects + 裁透明边 + 旋转,写 `atlases/*.png` + `.atlas`,带预览
- 项目打开/保存、图片导入、添加骨骼、图片绑定到骨骼
- `ProjectData` / JSON 文档转换、构建期 importer / exporter 插件注册表

编辑器有两个模式,**同样是拖骨骼,行为不同**:
`setup` 改绑定姿势,`animate` 在当前时刻打关键帧(值 = 绝对值 − 绑定值,scale 是 ÷)。

**图集区域名和 `attachment.path` 用图片文件名(`image.path`),不是 imageId** ——
imageId 的冒号会撞上 `.atlas` 文本语法;文件名两边一致,重新打包不用动任何绑定。

**尚未做:** 桌面应用视觉验证、动画管理 UI(新建/切换动画)、曲线编辑器 UI(贝塞尔在 `core/` 里已实现,但没有编辑界面)、Spine 导入/导出、Godot / Unity / Cocos 导出、IK、网格形变。

当前交接状态和下一步请先读 [docs/PROGRESS.md](docs/PROGRESS.md)。

**已知限制(刻意抛错而非静默忽略):**
`BoneData.inheritRotation / inheritScale` 的非默认值会在 `Skeleton` 构造时抛错。

## 先读这些

设计理由都在文档里,不要在本文件重复:

| 文档 | 内容 |
|---|---|
| [README.md](README.md) | 项目理念与范围 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构、`core`/`render` 分层、导出器职责、算法选型 |
| [docs/FORMAT.md](docs/FORMAT.md) | **格式规范** —— 所有运行时的共同契约 |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 已否决方案及理由 |

## 硬约束

### `core/` 不得依赖任何渲染 API

```
core/     纯数学。(数据文件, 时间) → (顶点数组, UV, draw order)
render/   薄适配层。PixiJS / Godot / Unity / Cocos 各一个
```

编辑器的动画预览就是第一个运行时,同一份 `core/`。**任何让渲染 API(PixiJS、WebGL、引擎类型)泄漏进 `core/` 的改动都要拒绝** —— 那会让每个引擎都得重新设计一遍,是本路线唯一真正会失控的地方。

### 格式约定不得随手更改

[docs/FORMAT.md](docs/FORMAT.md) 里的约定表(Y 轴、旋转方向、矩阵约定、关键帧语义、颜色空间)是四个运行时的共同契约。改动任何一条都要同步所有运行时和文档。

特别注意:**关键帧值是相对绑定姿势的偏移,不是绝对值。**

### 坐标系/色彩空间转换只在导出器里做

运行时拿到什么用什么,不做任何转换。

## 范围控制

单人项目,**范围控制优先于功能完整度**。不要提议「对标 Spine」式的功能扩张。

**正确性的标准是肉眼看不出问题**,不是像素级一致。不要主动引入跨引擎逐值比对、容差断言这类产品级基础设施 —— 已评估并推迟,见 [DECISIONS.md](docs/DECISIONS.md)。

## 不要重新提议

以下均已评估否决,理由见 [docs/DECISIONS.md](docs/DECISIONS.md)。不要因为「技术上可行」重提:

- 复制、移植或翻译 Spine Runtime 源码（兼容导入/导出必须自行实现）
- Live2D `.moc3` 导出
- DragonBones 格式作为中间格式
- 导出引擎原生动画格式(替代运行时路线)
- PolyRig 等第三方付费插件
- Rust + wgpu + egui 技术栈

## 实现顺序

1. 内部项目格式与 importer/exporter 插件 SDK
2. 项目管理、图片部件、图集、slot/attachment 可视化编辑
3. 骨骼绑定 + TRS 时间轴 + 实时预览 ← **首个可用闭环**
4. Spine JSON + atlas 导入插件
5. Godot / Unity / Cocos 自有格式导出插件与最小运行时
6. Spine 3.8 / 4.1 JSON + atlas 兼容导出插件
7. 网格形变、IK、动画融合

## 动手前必须知道的坑

- ⚠️ **撤销重做必须在写第一个编辑操作之前设计好**(命令模式或不可变状态快照)。事后 retrofit 等于重写编辑器核心
- **图集的 `rotate` 和 `offsets`** —— 少处理任何一个,所有切图锚点都会无规律偏移
- **动画融合的三个坑** —— 「没有关键帧」≠「值为 0」、离散属性无法插值、旋转走最短路径。详见 [FORMAT.md](docs/FORMAT.md#5-动画融合)
- **自动权重必须用测地距离**,不能用直线距离,否则两腿贴近时权重互相渗透
- 真正吃时间的是**时间轴/曲线编辑器的交互**和**权重刷的手感**,不是骨骼数学
