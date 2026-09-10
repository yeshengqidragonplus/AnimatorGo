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
| ~~170 (32%)~~ | ~~**deform 顶点动画**~~ | ✅ **已解**(2026-09-09):走 `SkinnedMeshRenderer` + Blend Shape,见下文与 [UNITY-2D.md](UNITY-2D.md) 第 11 节 |
| 95 | 每顶点 >4 根骨骼 | Unity 的 `BoneWeight` 硬限制 |
| ~~38~~ | ~~网格在绑定姿势下就非刚性~~ | ✅ **已解**:这类网格也走 SkinnedMeshRenderer,Mesh 的绑定矩阵是任意 4×4 |
| ~~29~~ | ~~加权网格之间缩放不一致~~ | ✅ **已解**:同上,Mesh 的顶点与 UV 各自独立 |
| 22 | clipping 遮罩 | 无对应物 |
| 20 | 贝塞尔控制点贴端点 | 退化为线性 |
| ~~16~~ | ~~逐帧绘制顺序~~ | ✅ **已解**(2026-09-10):挪过位的 slot 每条动画一条 `m_SortingOrder` 阶梯曲线,见 [UNITY-2D.md](UNITY-2D.md) 第 12 节 |
| 9 | `transformMode` 非默认继承 | 无对应物 |
| **7** | **linkedmesh(共享网格)** | 纯功能缺口,做得了 |
| 3 | IK / transform / path 约束 | 无对应物,**也没有烘进曲线**(之前「已烘进曲线」的说法不对,代码里没有求解器)—— 受约束驱动的骨骼停在自己的关键帧上 |

### deform 到底动多大(2026-09-08 摸底,1118 条时间轴)

「deform 只是微小的呼吸起伏,丢了看不出」—— **这个猜测被数据否了。**
把每条 deform 时间轴的最大顶点偏移算出来:

| 最大偏移 | 时间轴 | 骨架 |
|---|---|---|
| < 1 px | 38 | 23 |
| 1 – 5 px | 51 | 27 |
| 5 – 20 px | 355 | 94 |
| 20 – 50 px | 312 | 88 |
| **≥ 50 px** | **362** | **75** |

170 个骨架里 **128 个**的最大偏移 ≥ 20 px,只有 1 个在 5 px 以下。
极端的如 `Map3/17701` 的 `first_confirm`:1817 px 宽的网格,顶点偏移 1793 px ——
整个建筑「出现」的动作全靠 deform。`NewSpine/wave` 14 条动画全是 deform 做的波浪,
转过去就是一张静止图。

**「整块变换」能不能用一根辅助骨骼精确还原?** 对每帧拟合平移 / 相似 / 仿射变换(容差 0.5 px):

| 性质 | 时间轴 | 骨架 |
|---|---|---|
| 整块平移 / 旋转缩放 / 仿射 | 177 | — |
| **真·自由形变(顶点各走各的)** | **515** | **137** |
| 多骨骼加权网格上的 deform(未分析) | 402 | 51 |

全部 deform 都是整块变换、一根辅助骨骼就能精确还原的骨架只有 **10 个**。
所以「只处理刚性情形」这条捷径几乎没有覆盖面;要做就得做真·逐顶点。

已挑 5 个转进 `UnityAnimationGo/Assets/AnimatorGo/` 供肉眼对比:
`wave`(全靠 deform)、`blackrichwoman`(骨骼 + 63 条加权网格 deform 的典型角色)、
`17701` / `13901`(地图建筑,非加权大幅 deform)、`customer_1`(≤ 14 px,轻度)。

### Blend Shape 路线的排查结论(2026-09-09)

排查脚本 [tools/unity/AnimatorGoProbe.cs](../tools/unity/AnimatorGoProbe.cs):用 Unity 自己的 API
造出带蒙皮 + 形变目标的 Mesh、SkinnedMeshRenderer、动画曲线,存成资产拿 YAML,并做数值验证。
编辑器占着 UnityAnimationGo 时,把 `Packages/` `ProjectSettings/` `Assets/Settings/` 拷到临时目录
另起一个工程跑 batchmode(**Q7 要渲染,不能加 `-nographics`**)。Unity 6000.3.2f1,全部通过:

| 问题 | 结论 |
|---|---|
| Blend Shape 增量与蒙皮的顺序 | **加完再蒙皮**,与 Spine 同序(反向假设误差 1.41,正向 0) |
| 权重是否线性 | 是,50 = 半个增量 |
| 每顶点 >4 根骨骼 | 6 根全部参与蒙皮,误差 0。**但工程 Quality 的 `skinWeights` 必须是 Unlimited**,默认 4 根时误差 0.6 |
| ⚠️ 真实工程的 Quality 设置 | UnityAnimationGo 六档里 Low/Medium/High 是 **2 根**,Very High 4 根,只有 Ultra 是 Unlimited;MergeCooking2 三档是 2 / 4 / 2 根。SkinnedMeshRenderer 按 `m_Quality: 0`(Auto)走会被**降到 2 根**,比 SpriteSkin 还差。导出时必须写 `m_Quality: 4`(Bone4,每渲染器上限就是 4),>4 根只有在工程 Quality 为 Unlimited 时才成立 —— 要像认渲染管线那样从 `ProjectSettings/QualitySettings.asset` 读出来再决定报不报 approximated |
| 绑定矩阵里的非等比缩放 | 保留,误差 0(SpriteSkin 的「只有 TR」限制是 2D 包自己的,不是 Unity 的) |
| `m_SortingOrder` 能否打关键帧 | **能**,SpriteRenderer 和 SkinnedMeshRenderer 都能;Animation 窗口里列出 SpriteRenderer 的;2.5 取整成 3 |
| `blendShape.<名>` 曲线 | 能驱动权重;`.anim` 里 `attribute: blendShape.shape0`,`classID: 137` |
| SkinnedMeshRenderer 用 URP `Sprite-Unlit-Default`,与 SpriteRenderer 按 `sortingOrder` 互通 | **是**(渲染到 RenderTexture 读像素验证)。同 order 时 Sprite 在上 —— 别打平 |
| Mesh `.asset` 的 YAML | 拿到样本。顶点流 3 个 stream:位置 float32×3;颜色 UNorm8×4 + UV float32×2;权重 UNorm16×4 + 骨骼下标 UInt16×4(只放归一化后的前 4 根)。**>4 根的完整权重另存 `m_VariableBoneCountWeights`**(每顶点起始字偏移表 + 总字数 + (骨骼 u16, 权重 UNorm16) 列表)。形变目标稀疏存在 `m_Shapes`(只存非零顶点 + 下标)。`nameHash` 和曲线绑定哈希都是 **CRC32**。`m_BoneNameHashes` 可以为空 |

MC2 数据侧(458 条加权网格上的 deform,脚本在会话 scratchpad):

- 偏移确实是**每影响一份、在各自骨骼的局部空间**(338 条的下标范围超过顶点数×2,只能这么解释)
- 同一顶点各影响的偏移换到世界空间**并不一致**:setup 姿势下 21.8% 的(顶点×帧)分歧 >0.5 px,
  关键帧时刻的姿势下仍有 12%。所以 Blend Shape 的「单一绑定空间增量」**不能直接抄某个 dᵢ**
- 正确做法是**按关键帧时刻的姿势反解**:M(Pₖ)·δ = Δₖ,其中 M = Σ wᵢ Bᵢ(Pₖ) Bᵢ(S)⁻¹,Δₖ 是 Spine 在
  该时刻的世界偏移。关键帧时刻由此精确;**关键帧之间**与 Spine 的分歧:中位 0、90 分位 0.18 px、
  99 分位 1.5 px,458 条里 431 条 <0.5 px,最大 20 px(`female_lead` 一条)。这就是该方案要报的
  approximated 量级
- 规模:有 deform 的网格 624 个,形变目标合计 5695;433 个网格 ≤5 个目标,9 个 >100
  (`race_haibao` 几个 4 顶点小网格逐帧打了 200–400 个键)
- 反解 δ 需要一个**姿势求值器**(时间 → 每根骨骼的世界矩阵)。排查脚本里写了个不含约束、
  不含非默认继承模式的版本;正式实现应进 `core/`,VAT 以后也吃它

顺带发现两处**此前的说法不对**,已改:IK 的提示说「位置已烘进曲线」,但代码里没有 IK 求解;
逐帧绘制顺序判为「做不到」,实测能做。

### ✅ deform → SkinnedMeshRenderer + Blend Shape 已实现(2026-09-09)

排查完用户把子决策交给我定(见 [DECISIONS.md](DECISIONS.md)),当天做完。四块:

| 模块 | 文件 | 验证 |
|---|---|---|
| 姿势求值器 | `src/spine-eval/pose.ts` | 单测:父子链、继承模式、3.8/4.x 两种贝塞尔、第一帧之前用 setup |
| Mesh `.asset` 写入器 | `src/unity/writeMesh.ts`(+ `crc32.ts`) | 与 Unity 样本同构的网格写出再回读,顶点流 / 可变根数权重 / 形变目标 / 绑定矩阵逐个对上;6 顶点 256 字节与样本一致 |
| 材质、prefab 里的 SkinnedMeshRenderer | `src/unity/writeMaterial.ts`、`writePrefab.ts` | Unity batchmode 加载 |
| 分流 + 反解增量 + 权重曲线 | `src/spine-convert/unity/export.ts` | ⭐ 两条端到端用例:把写出的 Mesh / prefab / `.anim` 读回来,按 Unity 的规则(前 4 根归一、加完再蒙皮)算顶点,与 Spine 的 deform 求值比,关键帧时刻 <0.5px —— MX2_cat 的不加权 eyelid,和 MC2 `customer_1` 的加权网格(本地样本,存在才跑) |

Unity 6000.3 batchmode 自检(临时工程,`AnimatorGoVerify.cs` 新增 `CheckSkinnedMeshes`,
并对 `blendShape.<名>` 曲线查 Mesh 里真有这个目标):

```
MX2_cat / customer_1 / blackrichwoman / wave / 17701 / 13901
SpriteSkin 41 个全部 Ready;SkinnedMeshRenderer 59 个、形变目标 373 个,有问题 0;
所有曲线都指到物体;AnimatorGo 自检:全部通过 ✅
```

这六个也已转进 `UnityAnimationGo/Assets/AnimatorGo/`。

**用户肉眼对比 blackrichwoman(2026-09-10)抓出两个与 deform 无关的老 bug,已修:**

| 现象 | 原因 | 修法 |
|---|---|---|
| 海盗帽上叠着生日帽和圣诞围巾 | **所有皮肤的 attachment 全部导出**。Spine 一次只有一套皮肤生效,Unity 没有皮肤概念 | 一次只导一套:默认皮肤 + `--skin` 选的那套(默认皮肤空着就自动选第一套);产物名带 `@皮肤名`;未导出的皮肤报 info |
| `stand` 里五套眼睛、四张嘴叠在一起 | 所有挂图节点 `m_IsActive: 1`,只靠 attachment 时间轴关;没有该时间轴的动画里就全亮 | 初始显隐按 setup pose:同一 slot 只亮 `attachmentName` 那一个 |

同时确认了 blackrichwoman 的 6 条动画都用 drawOrder 把右手提到脸前面(+28 层),静态顺序下
手会被脸挡住、`angry` 里手表消失 —— **这就是用户说的「场景里好的,运行起来不对」**:setup 姿势
手臂不交叉,一动就交叉、层级就错。当天做掉:`src/spine-eval/drawOrder.ts` 按 Spine 规则铺出完整
顺序,挪过位的 slot 在**每条**动画里都写 `m_SortingOrder` 阶梯曲线(没挪的动画写 setup 值,
不依赖 Write Defaults 还原)。SpriteRenderer(212)与 SkinnedMeshRenderer(137)都能被驱动(排查过)。

**对比场景的间距是写死的 12 单位,这对真实素材远远不够。** 用渲染工具量了各 prefab 播完所有动画
实际占到的范围(Unity 单位,ppu 100):blackrichwoman 宽 17.4、高 30.4(图集缩放 k=7.7,骨架单位
本来就是像素的 7.7 倍);17701 宽 22.5;wave 宽 17.9。12 单位间距一播就互相甩到对方身上 ——
用户「运行起来脸上有叠加的东西」很可能就是隔壁 prefab 的部件。`摆一个对比场景` 改成先逐条动画采样、
按实际范围排,相机也按总范围框。**摆多个 prefab 对比时别再手写间距。**

**Animator 窗口开着时,进 Play / 重编译都会让 `UnityEditor.Graphs.Edge.WakeUp` 报一次 NRE** ——
编辑器自身的老毛病,与产物无关(controller 结构与能正常用的版本一致)。关掉 Animator 窗口就没了。

**新工具 `tools/unity/AnimatorGoRender.cs`**:把产物的动画在编辑器里逐帧渲成 PNG(`SampleAnimation`
+ 手动推 SpriteSkin 蒙皮 + 相机渲到 RenderTexture),我自己能看,不用等人截图。
环境变量选 prefab / 动画 / 采样数;`ANIMATORGO_RENDER_DEBUG=1` 顺带写每帧亮着的渲染器占图上哪块,
用来认「图上这块是谁」。⚠️ 每条动画要换一个干净的实例 —— `SampleAnimation` 不会把上一条动画动过、
这一条没动的属性还原(Animator 的 Write Defaults 会),复用实例会把上一条的表情带进来,
第一版就这么误判了一次「多出一只手」。

另一个边界:跨度 < 64px 的加权网格不参与缩放分流,`Valentines_flower1/2`、`WestCowboy-sign`
这几个小件缩放差 50% 却留在 SpriteSkin 路径(该骨架默认皮肤看不到它们)。待修。

### 运行时换皮肤:方案已在 Unity 里验过,未实现(2026-09-10)

现在是「一套皮肤一份 prefab」,换皮肤 = 换 prefab 实例。同一个实例运行时切皮肤需要另一种结构,
难点是 Spine 的皮肤是运行时查表(键名 → 当前皮肤 → 默认皮肤),Unity 没有这张表,
一个节点要同时满足「换图时间轴说这个键名亮着」和「属于当前皮肤」两个条件。

方案:**两个互相独立的显隐开关 + Animator 分层,零运行时脚本**

| 开关 | 谁控制 | 对应 Spine |
|---|---|---|
| 渲染器 `m_Enabled` | 基础层:换图时间轴的阶梯曲线(从现在的 `m_IsActive` 挪过去) | 时间轴按键名亮灭 |
| GameObject `m_IsActive` | 皮肤层(override,权重 1):每套皮肤一个状态,一条静态 clip 把所有皮肤节点设好 | `SetSkin()` |

切皮肤 = `animator.Play("皮肤名", 1)`。被新皮肤覆盖的默认皮肤节点由皮肤 clip 一并关掉。

探针 `tools/unity/AnimatorGoProbeSkin.cs`(Unity 6000.3,渲染到 RenderTexture 读像素)8 项全过:
SpriteRenderer / SkinnedMeshRenderer 的 `m_Enabled` 都能被曲线驱动且 Animation 窗口里选得到;
皮肤层只管 `m_IsActive`,切状态立即生效、切回也对、不干扰基础层;被皮肤层灭掉的物体,
基础层对它渲染器的曲线在重新点亮后仍生效;两个开关确实是 AND。

⚠️ 探针里踩的坑:**别用 Transform 的单分量曲线**(如 `m_LocalPosition.z`)撑 clip 长度 ——
Animator 会把没写的分量当 0 写进去,把物体挪到原点。

产物形态会变:一个 prefab 装全部皮肤(节点名带 `@皮肤名`),一张图集含所有皮肤的图,动画一套,
controller 两层。**只对多皮肤骨架启用**,单皮肤骨架产物不变。等确认游戏里真有运行时切皮肤的需求再做。

顺带解掉的:绑定姿势非刚性(38 个骨架)、加权网格缩放不一致(29 个)—— 同样的网格路径。
顺带发现的:`wave` 的 deform 打在 `path` attachment 上(路径约束用),不参与渲染,报 info 跳过。

代价(都报出来):这些网格上的 slot 颜色动画丢弃(SkinnedMeshRenderer 没有 `m_Color`);
每顶点 >4 根仍截到 4(渲染器写死 Bone4);关键帧之间与 Spine 的分歧 >0.5px 时报 approximated
(`wave` 最大 1.3px)。

## 未完成

路线已定(2026-09-09,见 [DECISIONS.md](DECISIONS.md)):**Spine → Unity 先做正常动画,
VAT(GPU 顶点动画贴图)是终局、以后做。** 下面按依赖顺序:

1. **deform 的 Unity 肉眼确认** —— 六个样本已在 `UnityAnimationGo/Assets/AnimatorGo/`,等用户看
2. **linkedmesh** —— 7 个骨架 / 138 处
3. **跨度 < 64px 的加权网格不参与缩放分流**的边界(`Valentines_flower1/2`、`WestCowboy-sign` 缩放差 50% 留在 SpriteSkin)
4. **Unity → Spine**(反方向)
5. **Godot / Cocos 导出**
6. `.skel` 里没有样本覆盖的区域:path 约束的字段顺序、音频事件的 `volume` / `balance`
7. **VAT 出口** —— 极限性能时才需要。来源有两个:Spine 直出,以及 Unity 正常动画烘焙。
   求值器按「(数据, 时间) → 顶点数组」设计,让两边共用

烘焙不许旋转,打包效率会降 —— BBQ_grill 原图集 1024×512,烘焙后是 1024×1024。
目前固定 POT,需要的话可以加个 `--npot` 省显存。

### 已知转不过去的东西(都会报出来,不静默)

- ~~deform 顶点关键帧~~ —— 已转成 SkinnedMeshRenderer 的 Blend Shape;打在 `path` 上的 deform 不参与渲染,跳过
- **走 SkinnedMeshRenderer 的网格上的 slot 颜色动画** —— 没有 `m_Color`,静态颜色烘进顶点色,动画部分丢弃
- ~~逐帧绘制顺序~~ —— 已转成 `m_SortingOrder` 阶梯曲线
- **path / transform 约束** —— 没有对应物
- **两色染色(dark color)** —— 没有对应物
- **IK** —— 没有对应物,也没有烘进曲线;受 IK 驱动的骨骼会停在自己的关键帧上
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
