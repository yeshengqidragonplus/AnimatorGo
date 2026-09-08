# 开发进度与交接(2026-09-08)

## 产品定位

**2D 骨骼动画的格式转换器,不是编辑器。** 详见 [DECISIONS.md](DECISIONS.md) 开头。

两个具体需求驱动:

1. **Spine 3.8 ⇄ 4.1 批量互转** —— 团队经常要做,以前靠美术手工重导一天
2. **Spine → Unity 2D Animation** —— 目标是**彻底不装 spine-unity 运行时**,
   用 Unity 自带的运行时播;顺带让没有 Spine 授权的人也能改动画、能在 Unity 里做后期

仓库里的编辑器 MVP 是转向之前做的,**代码保留、停止投入**。

## 已完成

### Spine `.skel` 二进制读写(`src/spine-format/binary/`)

- 3.8 与 4.1 都能**读到最后一个字节**(35344/35344、36328/36328)
- 写回**逐字节相同**
- 格式规范是自己整理的:[SPINE-BINARY.md](SPINE-BINARY.md)

⚠️ **字符串表里有重复项**(`"bubble"` 出现 3 次),所以模型里存的是**原始下标**,
不能用 `indexOf` 反查 —— 会写出另一个下标,文件结构合法但内容错位。

### Spine JSON 读写(`src/spine-format/json/`)

`.skel` 与 `.json` 互为编码,两种都能读能写。把 `.skel` 转成 `.json` 是最快的排查手段。

⚠️ **JSON 里没有字符串表**,所以 `skel → json → skel` 只保证结构与数值一致,
不保证逐字节相同。逐字节只适用于 `skel → skel`。

### 版本转换(`src/spine-convert/skel/`)+ 命令行

```bash
pnpm convert <输入路径> --to 4.1 [--out 目录] [--format skel|json] [--dry-run]
```

不覆盖输入,每个产物写出前自动回读自检,同名 `.atlas` / `.png` 一并复制。

### Spine → Unity 2D Animation(`src/spine-convert/unity/`、`src/unity/`)

```bash
pnpm unity <骨架文件或目录> [--out 目录] [--ppu 100] [--dry-run]
```

产出一整套可以直接拖进 `Assets/` 就播的资源:

| 产物 | 内容 |
|---|---|
| `<名字>.png` + `.meta` | **重新烘焙的正立图集**,`.meta` 里带 sprite 矩形、pivot、网格顶点、三角形、骨骼、权重 |
| `<名字>.prefab` + `.meta` | 骨骼 Transform 层级 + 每个 attachment 一个挂图节点 + `SpriteSkin` + `Animator` |
| `<名字>@<动画>.anim` + `.meta` | 每条动画一个,位置/旋转/缩放/显隐/颜色曲线 |
| `<名字>.controller` + `.meta` | 每条动画一个 state,第一条为默认 |

自带 PNG 编解码(`src/unity/png.ts`,只用 Node 的 zlib,没有引第三方图片库)。

**端到端校验**(`export.test.ts`):把产出的 `.meta` 和 prefab **重新读回来**,
照 Unity 的 `SpritePostProcess` + `SpriteSkin` 算一遍,和 Spine 自己的骨架求值比对。
14 个加权网格的顶点最大偏差 **0.75 像素**;不加权网格和 region 四角也各有一条。

两份真实素材的转换结果:

| 素材 | 形状 | 结果 |
|---|---|---|
| MX2_cat | 38 骨骼 / 13 slot / **15 网格** + 3 region / 2 动画 | 近似 1(`head` 有顶点绑了 5 根骨骼,Unity 上限 4)、有损 3(2 条 deform + 1 条逐帧绘制顺序) |
| BBQ_grill | 8 骨骼 / 8 slot / **100 region**、0 网格 / 2 动画 | **零问题** |

两份形状正好互补 —— 一份全是蒙皮网格,一份全是换图。

### ✅ 已在 Unity 里跑通(2026-09-08)

Unity 6000.3 + URP + 2D Animation 13.0.2,`UnityAnimationGo/` 里实测:

```
SpriteSkin 14 个,校验不过 0 个
每个 sprite 的顶点数与写入值逐个吻合(head 70 顶点 / 101 三角,eyelid 56 / 75)
骨骼下标全部在范围内,指不到物体的动画曲线 0 条
```

**画面确认无误** —— 蒙皮网格变形、换图、绘制顺序都对。

### Unity 侧的自检循环

`tools/unity/AnimatorGoVerify.cs` + `pnpm check:unity`。
另外可以用 **Unity batchmode 在本地跑完自检**,不必人工开 Unity:

```bash
Unity.exe -batchmode -quit -nographics -projectPath <工程>           -executeMethod AnimatorGoVerify.Verify -logFile <日志>
```

⚠️ **这一步别省。** Unity 侧有一类问题「只有 Unity 自己知道、而且都不报错」——
曲线 path 指不到物体、`.meta` 里一个空数组让加载器抛异常中断整个循环。
靠人工开 Unity 反馈,一个 bug 要来回三四轮。

### ✅ 535 个真实骨架批量摸底(MergeCooking2)

**535/535 全部转换成功。** 版本分布:`3.8.95 × 534`、`3.8.72 × 1` —— **全是 3.8**,
所以「3.8 的贝塞尔控制点是归一化的」那个修复对这批素材是决定性的,
不修的话 535 个骨架的缓动**全部**是错的。

规模暴露出的问题(都已修):

| 问题 | 表现 |
|---|---|
| 把任意 `.json` 当骨架 | 216 个「失败」里绝大多数是 `areas.json` 这类配置文件,把真失败埋了 |
| **缩放当成全局常数** | `26301` 的 `house` 网格残差 **372 像素**。见 [UNITY-2D.md](UNITY-2D.md) 第 8 节 |

### 还转不过去的东西(按涉及骨架数排,535 个里)

| 骨架数 | 问题 | 性质 |
|---|---|---|
| 170 (32%) | **deform 顶点动画** | Unity 无对应物。理论上可以「每个顶点一根骨骼」硬编,代价很大 |
| 95 | 每顶点 >4 根骨骼 | Unity 的 `BoneWeight` 硬限制 |
| 38 | 网格在绑定姿势下就非刚性 | 顶点位置与 UV 绑死,表达不了(多半是刻意做的透视) |
| 29 | 加权网格之间缩放不一致 | 一张纹理只有一个 `pixelsPerUnit` |
| 22 | clipping 遮罩 | 无对应物 |
| 20 | 贝塞尔控制点贴端点 | 退化为线性 |
| 16 | 逐帧绘制顺序 | `sortingOrder` 是静态的 |
| 9 | `transformMode` 非默认继承 | 无对应物 |
| **7** | **linkedmesh(共享网格)** | ⭐ **唯一一个纯功能缺口,做得了** |
| 3 | IK / transform / path 约束 | 位置已烘进曲线,外观一致但不可再调 |

## 未完成

按依赖顺序:

1. **linkedmesh** —— 上表里唯一「能做但没做」的。7 个骨架 / 138 处
2. **Unity → Spine**(反方向)
3. **Godot / Cocos 导出**
4. `.skel` 里没有样本覆盖的区域:path 约束的字段顺序、音频事件的 `volume` / `balance`

烘焙不许旋转,打包效率会降 —— BBQ_grill 原图集 1024×512,烘焙后是 1024×1024。
目前固定 POT,需要的话可以加个 `--npot` 省显存。

### 已知转不过去的东西(都会报出来,不静默)

- **deform 顶点关键帧** —— Unity 的 SpriteSkin 只做骨骼蒙皮
- **逐帧绘制顺序** —— `sortingOrder` 是静态的
- **path / transform 约束** —— 没有对应物
- **两色染色(dark color)** —— 没有对应物
- **IK** —— 骨骼最终位置已经烘进曲线,外观一致但不可再调
- 每顶点超过 4 根骨骼 —— 取权重最大的四根重新归一化

## 编辑器 MVP(冻结)

骨骼、时间轴、图片部件、slot 编辑、图集打包都能用,Electron 壳 + 五国语言。
`pnpm dev` 可以跑起来。**不要继续往这边堆功能** —— 它现在的定位是可选的查看/临时编辑视图。

细节见 git 历史与 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 方法论(这条最值钱)

**每次只凭文档实现都是错的。** 四次实例:

| 事情 | 只看文档的结果 | 拿真实数据一比 |
|---|---|---|
| 图集 `size` / `bounds` 语义 | 51 个区域里 31 个违例 | 换一种理解后 0 违例 |
| 贝塞尔控制点是否归一化 | 49 条时间轴报「近似」 | 改成绝对坐标后 0 |
| 加权网格的绑定姿势 | 15 个网格里 6 个残差 45~206 像素 | 改成逐骨骼反解后全部 < 0.4 像素 |
| 贝塞尔控制点两版是否同一坐标系 | 3.8 有 46 条时间轴被误判成线性 | 3.8 归一化 / 4.x 绝对,修正后 0 条 |

固定套路:**拿到真实样本 → 反推格式 → 实现 → 与标准答案比对**。
验收要有一条硬指标(读到精确 EOF、逐字节往返、亚像素偏差),
而不是「看起来对」。**近似/有损的计数异常本身就是最好的报警器** ——
上面四条里有三条是靠「这个数字不该这么大」发现的。
