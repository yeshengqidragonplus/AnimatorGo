# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 当前状态

**尚无代码、构建系统或依赖。** 搭好脚手架后回来补充「构建与测试命令」一节。

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

- Spine 格式导出
- Live2D `.moc3` 导出
- DragonBones 格式作为中间格式
- 导出引擎原生动画格式(替代运行时路线)
- PolyRig 等第三方付费插件
- Rust + wgpu + egui 技术栈

## 实现顺序

1. `core/` 骨架 + 格式定义
2. 渲染 + 切图导入 + 图集打包 + 骨骼层级(静态角色)
3. 时间轴 + TRS 关键帧 ← **到这里就是可用工具**
4. Godot 运行时(第一个,映射最干净)
5. 网格形变(CDT + Lloyd Relaxation + Geodesic IDW + 权重刷)
6. IK
7. 动画融合
8. Unity / Cocos Creator 运行时

## 动手前必须知道的坑

- ⚠️ **撤销重做必须在写第一个编辑操作之前设计好**(命令模式或不可变状态快照)。事后 retrofit 等于重写编辑器核心
- **图集的 `rotate` 和 `offsets`** —— 少处理任何一个,所有切图锚点都会无规律偏移
- **动画融合的三个坑** —— 「没有关键帧」≠「值为 0」、离散属性无法插值、旋转走最短路径。详见 [FORMAT.md](docs/FORMAT.md#5-动画融合)
- **自动权重必须用测地距离**,不能用直线距离,否则两腿贴近时权重互相渗透
- 真正吃时间的是**时间轴/曲线编辑器的交互**和**权重刷的手感**,不是骨骼数学
