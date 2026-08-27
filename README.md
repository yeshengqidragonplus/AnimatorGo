# AnimatorGo

**2D 骨骼动画的格式转换器。** 让 Spine、Unity、Godot、Cocos Creator 之间的动画资产可以互相转换,
以及 Spine 自身的版本互转(3.8 ⇄ 4.1)。

**当前状态:转向中。** 此前按「做一个动画编辑器」推进,已有编辑器 MVP;
现已明确核心是**转换**,编辑器降级为可选的查看/临时编辑视图。见 [docs/DECISIONS.md](docs/DECISIONS.md)。

---

## 为什么是转换而不是编辑器

Unity 有 2D Animation,Spine 有自己的编辑器,它们都比我们做得好。**缺的不是编辑器,是它们之间的通路。**

两个真实痛点:

1. **Spine 版本互转** —— 团队频繁需要 3.8 ⇄ 4.1,目前靠美术手工操作,一次一整天
2. **拿现成动画当模板** —— 换图、改动画,而不是从零做

## 架构:中转模型,不是两两互转

5 个格式两两双向 = 20 个转换器,加一个格式变 30 个。走中转则**每个格式只写「进」和「出」**,
5 个格式 10 个转换器,加一个格式只加 2 个。

```
Unity ─┐                    ┌─ Unity
Godot ─┼─→  中转模型  ─→────┼─ Godot
Cocos ─┤   (Spine 形状)     ├─ Cocos
Spine ─┘                    └─ Spine
```

### 中转模型用 Spine 的数据模型

**中转模型必须是所有格式的超集,否则它自己就是损耗点。** Spine 的模型在这五个里最丰富
(slot、skin、IK / transform / path 约束、deform 顶点时间轴),所以选它。

指的是**数据模型的形状**,不是 Spine 的代码 —— 解析和序列化按公开规范自行编写,
见 [DECISIONS.md](docs/DECISIONS.md)「不得移植 Spine 运行时源码」。

**⚠️ 绝对不能用本项目编辑器的格式当中转** —— 它比 Spine 穷得多,
Spine 资产过一遍就会**静默**丢掉约束、皮肤、网格形变。

### 有损是常态,必须报告

| 方向 | 损耗 |
|---|---|
| Unity / Godot / Cocos → 中转 | 无损(它们的能力都是 Spine 的子集) |
| Spine ⇄ 中转 | 无损 |
| 中转 → Godot | 较少(Godot 原生支持网格形变) |
| 中转 → Unity / Cocos | **较多且不可避免** —— 它们没有 slot、skin、path 约束的对应物 |

**「Spine → Unity → 改 → 转回 Spine」这种往返做不到**,不要朝这个方向投入。

## 实现顺序

顺序不是偏好,是依赖关系逼出来的:**10 条转换路径没有一条不经过「读写 Spine JSON」。**

1. **Spine JSON 读写 + 3.8 ⇄ 4.1 版本互转** ← 地基,且是唯一有标准答案可逐字段对照的
2. 中转模型定型
3. Unity 出 + Unity 进(最重的一块,见下)
4. Godot / Cocos
5. 编辑器(可选,届时再决定)

第 1 步同时是唯一一个**现在每周都在烧时间**的痛点。

### Unity 那一对为什么最重

不只是写动画曲线:

- `.anim`(AnimationClip,Unity 风味 YAML)—— 这部分不难
- **Sprite 的骨骼与顶点权重要写进 `.meta`** —— 2D Animation 包把 `SpriteBone` 和权重塞在
  Sprite 的 meta 里,是 Unity 自己的序列化格式,**且随 Unity 版本变**
- **`.meta` 的 GUID 必须稳定** —— 否则每次转换 Unity 都当成新资源,引用全断
- Unity → Spine 还要把以上全部反着读回来

## 版本迁移不走中转模型

Spine 3.8 ⇄ 4.1 两边**数据模型相同**,只是序列化写法变了,所以可以无损。

它**直接在 JSON 树上做变换,不经过中转模型** —— 走一遍中转反而可能丢东西。
架构是链式相邻迁移(`3.8 ⇄ 4.0 ⇄ 4.1 ⇄ 4.2`),加新版本只写一个迁移。
见 `src/spine-convert/`。

## 明确不做的事

见 [docs/DECISIONS.md](docs/DECISIONS.md):

| 方案 | 原因 |
|---|---|
| 移植 Spine 运行时源码 | 本仓库公开且 MIT,那等于把他们的版权代码挂 MIT 发布 |
| Live2D `.moc3` | 闭源二进制,SDK 授权禁止逆向,且模型不同构 |
| 跨工具往返编辑 | 数据模型不同构,必然有损,往返无意义 |
| 用编辑器格式当中转 | 它是子集,会静默丢特性 |

## 文档

| 文档 | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分层、算法选型 |
| [docs/FORMAT.md](docs/FORMAT.md) | 格式规范 —— 坐标系约定、数据模型、图集格式 |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 已定与已否决的方案及理由 |
| [CLAUDE.md](CLAUDE.md) | 给 Claude Code 的操作性约束 |

## 技术栈

Electron + TypeScript + React + PixiJS,Windows / macOS 双平台。

⚠️ 打包绑平台:`.dmg` 必须在 macOS 上构建,electron-builder 不能交叉编译。

## License

MIT
