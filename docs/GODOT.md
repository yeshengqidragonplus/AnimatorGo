# Godot 4 导出

目标:Godot 4.7 原生节点 + `AnimationPlayer`,**零运行时脚本**,在 Godot 里可编辑。
链路见 [PROGRESS.md](PROGRESS.md):先做「中转模型 → Godot」(顺带就是 Spine → Godot),
再接「Unity 产物 → 中转模型」,两段一接就是 Unity → Godot。

本文所有结论都来自 Godot 4.7.2 自己的实测,探针在 `tools/godot/`:

| 探针 | 跑法 | 管什么 |
|---|---|---|
| `AnimatorGoProbe.gd` | `--headless --script` | 用 Godot 的 API 搭样例存成 `.tscn` —— **文件格式以它写出的为准**;轨道插值语义 |
| `AnimatorGoProbeSkin.gd` | `--script`(**要渲染,不能 `--headless`**) | 渲染到 SubViewport 量质心:蒙皮公式、绑定姿势、deform 顺序 |

```bash
godot --headless --path <工程> --script res://AnimatorGoProbe.gd
godot --path <工程> --script res://AnimatorGoProbeSkin.gd
```

(本机:`E:/Tools/Godot_v4.7.2-stable_win64/Godot_v4.7.2-stable_win64_console.exe`,
`gl_compatibility` 渲染,RTX 4060 上 OpenGL 3.3 正常。)

## 1. 实测结论

| 问题 | 结论 |
|---|---|
| Polygon2D 蒙皮公式 | `v' = Σ wᵢ · Bᵢ(pose) · Bᵢ(rest)⁻¹ · v`,骨架空间(Skeleton2D 与 Polygon2D 都是单位变换时),质心误差 0 |
| 骨骼缩放 / 非等比缩放 | 参与蒙皮,误差 0 |
| **每个网格自己的绑定姿势** | 见第 3 节。辅助子骨骼的办法实测误差 0 |
| `polygon`(PackedVector2Array)能不能插值 | **能**,关键帧之间逐顶点线性 —— deform 直接打在它上面,不需要 Blend Shape |
| deform 与蒙皮的先后 | `polygon` 就是蒙皮前的顶点,天然「加完再蒙皮」,与 Spine 同序 |
| 贝塞尔轨道控制柄 | **相对关键帧的 (Δ时间, Δ取值)**,与按此假设算的值差 4e-5 —— Spine 的贝塞尔能精确表达 |
| `visible` / `z_index` 离散轨道 | ⚠️ 默认档位**往回拖不重新求值**(0.5 → 0.25 仍是 0.5 的值)。AnimationPlayer 设 **`callback_mode_discrete = 2`**(FORCE_CONTINUOUS)后前后乱拖都对 |
| `self_modulate` / `rotation` 值轨道 | 线性插值 |
| 同一时刻两个键 | ⚠️ **恰好在那一刻取第一个**(0 秒写 [setup, 第一帧] 两个键,`seek(0)` 时两张图一起亮,每次循环回到起点也是)。写出时同一时刻(7 位有效数字)只留最后一个键 |
| ⚠️ 每顶点最多几根骨骼 | **4 根**(`scene/2d/polygon_2d.cpp` 写死 4 个槽:按 `bones` 数组的顺序逐个插入,只留权重最大的 4 个,权重相同时先来的优先,再归一)。之前导出没管,一声不响地被截掉 —— 见第 6 节 |
| 节点名 | ⚠️ **不能含 `@`**(以及 `.` `:` `/` `"` `%`)—— 探针里 `a@mesh` 被改名,骨骼路径对不上,网格直接不画。Unity 导出那套 `@皮肤名` 命名不能照搬 |

## 2. `.tscn` 的写法(取自 Godot 自己写出的文件)

```
[gd_scene format=3]

[sub_resource type="Animation" id="Animation_sivs7"]
loop_mode = 1
tracks/0/type = "value"
tracks/0/path = NodePath("Skeleton2D/b0:rotation")
tracks/0/interp = 1
tracks/0/loop_wrap = true
tracks/0/keys = {
"times": PackedFloat32Array(0, 1),
"transitions": PackedFloat32Array(1, 1),
"update": 0,                                  # 0 连续 / 1 离散
"values": [0.0, 1.0]
}
tracks/2/type = "bezier"
tracks/2/path = NodePath("Skeleton2D/b0/b1:position:x")
tracks/2/keys = {
"handle_modes": PackedInt32Array(0, 0),
"points": PackedFloat32Array(50, 0, 0, 0.5, 0, 150, -0.1, 0, 0, 0),   # 每键:值, 入柄 x, y, 出柄 x, y
"times": PackedFloat32Array(0, 1)
}

[sub_resource type="AnimationLibrary" id="AnimationLibrary_xm0cu"]
_data = {
&"test": SubResource("Animation_sivs7")
}

[node name="b1" type="Bone2D" parent="Skeleton2D/b0"]
position = Vector2(50, 0)
rotation = 0.5235988
rest = Transform2D(0.8660254, 0.5, -0.5, 0.8660254, 50, 0)     # x 轴, y 轴, 原点

[node name="mesh" type="Polygon2D" parent="."]
skeleton = NodePath("../Skeleton2D")
polygon = PackedVector2Array(0, 0, 100, 0, 100, 50, 0, 50)
uv = PackedVector2Array(0, 0, 64, 0, 64, 32, 0, 32)          # 纹理像素坐标
polygons = [PackedInt32Array(0, 1, 2), PackedInt32Array(0, 2, 3)]
bones = ["b0", PackedFloat32Array(1, 0.5, 0, 0), "b0/b1", PackedFloat32Array(0, 0.5, 1, 1)]   # 路径相对 Skeleton2D,每根骨骼一组逐顶点权重

[node name="AnimationPlayer" type="AnimationPlayer" parent="."]
libraries/ = SubResource("AnimationLibrary_xm0cu")
```

4.7 写出的节点还带 `unique_id=…`,是编辑器跟踪用的,可以不写。

## 3. ⚠️ 绑定姿势是每根骨骼一个,全场景共用

Unity 的 SpriteSkin 每个 sprite 带自己的一套绑定姿势;**Godot 2D 的绑定姿势就是 `Bone2D.rest`,
每根骨骼只有一个,所有网格共用**。而 Spine 的加权网格可能是在别的姿势下绑的(Unity 那边实测
MX2_cat 15 个里 6 个,见 [UNITY-2D.md](UNITY-2D.md) 第 6 节)。

解法:给这类网格在每根影响它的骨骼下挂一个**辅助子骨骼**,

- 局部变换恒为单位 —— 永远和父骨骼重合,动画不用管它
- `rest = 父骨骼 rest⁻¹ · Bind`,Bind 是该网格在这根骨骼上的绑定姿势(世界空间)

于是 `B_helper(pose) · B_helper(rest)⁻¹ = B(pose) · Bind⁻¹`,正好是 Spine 的「骨骼当前姿势 × 绑定时的局部坐标」。
绑定姿势与 setup 一致的网格直接挂真骨骼,不加辅助骨骼。**一根骨骼下可以挂多根辅助骨骼**,每根一个绑定矩阵(第 6 节)。
辅助骨骼按「父骨骼 + 绑定矩阵」共用(序列帧的各帧、绑定相同的网格用同一根)—— ⚠️ 不能按附件名认:wave 有两个 slot
都挂着叫 `tiao` 的网格,绑定不同,按名字共用的话后一个差 21 像素。

## 4. 与 Unity 导出相比省掉的

- **不用重新烘焙图集**:Polygon2D 的 UV 是纹理像素坐标,旋转过的区域靠 UV 映射就行。
  旋转 90° 的区域,正立坐标 (x, y)(左上原点)对应页面 `(X + y, Y + w − x)`
- **不用反推图集缩放 k、不用 ppu**:顶点位置与 UV 各自独立,顶点直接用骨架单位(Godot 2D 就是像素)

## 5. 产物长什么样

```bash
pnpm godot <骨架文件或目录> [--out 目录] [--atlas 图集] [--skin 初始皮肤] [--dry-run]
```

每个骨架一个目录:`<名字>.tscn` + 图集页 PNG(预乘 alpha 已还原成直通)。输出目录在 Godot 工程里时
(往上能找到 `project.godot`)贴图按 `res://` 引用,否则按相对路径。**零运行时脚本。**

```
<名字>                       Node2D(场景根)
├─ Skeleton2D
│  └─ root / … / bone        Bone2D 层级,rest = setup 的局部变换,长度照 Spine 写(关掉自动推算)
│     ├─ <slot>__<键名>      Polygon2D:region / 不加权网格 / 只挂一根骨骼的加权网格,顶点在骨骼局部
│     └─ <骨骼>_bind_<网格>  辅助子骨骼(第 3、6 节),局部变换恒为单位;一根骨骼下可以有多根
├─ <slot>__<键名>            Polygon2D:真正混合的加权网格,skeleton = ../Skeleton2D,顶点在绑定空间
├─ <基名> (<皮肤>)           Node2D:皮肤开关(只有和皮肤有关的节点才包,见第 8 节)
│  └─ <基名>                 Polygon2D
├─ AnimationPlayer           全部动画 + RESET;deterministic = true,callback_mode_discrete = 2
└─ SkinPlayer                多皮肤时才有:每套皮肤一条静态动画
```

- **绘制顺序**:`z_index` = slot 下标(祖先骨骼的 z 都是 0,相对值即绝对值)
- **颜色**:slot 颜色 → `self_modulate`(可动画);attachment 自己的颜色 → Polygon2D 的 `color`
- **混合模式**:additive / multiply → `CanvasItemMaterial.blend_mode`;screen 没有,按 additive 报近似
- **坐标**:数据层面翻 Y(`y → −y`,旋转取反,`skew = shearX − shearY`),不给根节点挂 `scale.y = −1` ——
  那样用户往骨骼上挂的新东西全是倒的

## 6. 加权网格的绑定:同一根骨骼挂多根辅助子骨骼

Spine 加权网格**每个影响各存一份骨骼局部坐标**,而 Godot 的绑定是「每根骨骼一个 rest、所有顶点共用」。绑完又在别的姿势下
改过顶点的网格,同一顶点各影响在 setup 下对不齐,每根骨骼一个绑定矩阵解释不了。解法与 Unity 导出共用
(`src/spine-convert/skinSlots.ts`,UNITY-2D.md 11.6):**同一根骨骼可以占多个槽位,每个槽位一个绑定矩阵**,
在 Godot 里就是一根辅助子骨骼(第 3 节)。每个影响原样表达,任何姿势下都与 Spine 一致,在 Godot 里改骨骼动画也照样对。

1. 每根骨骼一个「基准」槽位。顶点和基准两种候选,取多出来的槽位少的:setup(顶点 = 各影响在 setup 下的加权平均);
   按贴图拟合(每根骨骼「局部坐标 → 图上位置」一个仿射,MX2_cat 的「第二套」网格就是这种)
2. 对不上基准的影响(差 > 0.05 像素)另开槽位,残差相近的共用一个。基准就是骨骼 rest 的槽位挂真骨骼,其余挂辅助骨骼

**每顶点超过 4 根骨骼**:Godot 的 Polygon2D 只用权重最大的 4 根(第 1 节)。剩下几根的影响分不出去,但留下的 4 个影响各有
自己的槽位,局部坐标可以重新挑 —— 按全部动画的姿势最小二乘,留哪 4 根也挑。这一条**之前一声不响**:导出没报,端到端测试的
参照求值也按完整权重算。MergeCooking2 里 90 个骨架有这种顶点,Godot 自己截断时 22 个超过 3 像素、最大 11.2;拟合后 211 个网格
最大 2.9 像素,超 0.5 像素的(70 个)报 approximated。

蒙皮网格的 deform 照旧:`polygon` 轨道按 30 fps 逐帧反解 M(P)·δ = Δ,Δ 取 Spine 的完整位置(全部影响 + 偏移)减去
Godot 不加形变时的位置 —— 截断误差在采样时刻也一并消掉。

⚠️ **之前(2026-09-28)的做法**是「两种绑定按实测取小的,还偏就每条动画逐帧加 polygon 修正轨道」。准是准,但在 Godot 里改
骨骼动画修正不跟着变;Unity 那边照搬时产物涨到 2~3 倍,才找到「同一根骨骼占多个槽位」这个正解,两边一起换了(2026-10-08)。

⚠️ 判断绑定好坏**必须看加权后的偏差**,不能看逐影响残差的最大值:权重很小的影响对不齐,对画面的贡献也小。第一版按逐影响
残差判,把 `whiteman_sit` 的 `B_body2`(Unity 里走 SpriteSkin、完全正常)推错了档,差 127 像素。

验证:端到端测试 8 个样本 56 个用例全过(参照求值已按 Godot 的 4 根规则);去掉「另开槽位」后 whiteman_sit 的 `B_body2`
差 124 像素,用例会挂。Godot 4.7 里:`AnimatorGoVerify.gd` 三个场景(whiteman_sit、female_lead、wave)全部通过;whiteman_sit 的
渲染和旧版(逐帧修正、已对过 Spine)逐像素比,没有一个像素差超过 64 级,只是边缘的亚像素差异。MergeCooking2 全部 535 个
骨架导出成功,66 个网格用到多根辅助骨骼(共 1071 根,单个网格最多 80 根)。

## 7. 动画

| Spine | Godot |
|---|---|
| 骨骼 rotate / translate / scale | 有贝塞尔:贝塞尔轨道,**精确**(控制柄是相对偏移,实测);全线性:值轨道。阶梯段用 1e-4 秒前补一个同值键 |
| shear | 同时影响 Godot 的 rotation 和 skew,与 rotate 的关键帧对不齐 —— 这根骨骼的 rotation / skew 按 30 fps 采样,报近似 |
| 换图 | 挂图节点 `visible` 阶梯轨道 |
| slot 颜色 | `self_modulate`;有贝塞尔时按 30 fps 采样(rgb + alpha 两条时间轴统一求值写一条) |
| 逐帧绘制顺序 | 挪过位的 slot 的挂图节点 `z_index` 阶梯轨道 |
| deform | `polygon` 关键帧。不蒙皮的线性段精确;**蒙皮网格逐帧反解**(30 fps):两帧之间 Godot 在绑定空间线性插值,Spine 是在各骨骼局部插值后再蒙皮,只在关键帧上解会在中间分开 |
| 第一帧之前 | Spine 用 setup 值,Godot 保持第一帧 —— 0 处补 setup 值再阶梯过去。第一帧就在 0 秒的,0 秒只留第一帧的值(见第 1 节「同一时刻两个键」) |
| 换动画回 setup | `deterministic = true` + RESET(每个被任何动画碰过的属性的 setup 值) |

动画一律循环(与 Unity 导出一致)。`autoplay` = 第一条动画。

## 8. 皮肤

与 Unity 导出同一个思路(见 [UNITY-2D.md](UNITY-2D.md) 第 13 节):所有皮肤的 attachment 都建节点,显隐拆成两个开关。

| 开关 | 在哪 | 谁控制 |
|---|---|---|
| 换图 | Polygon2D 的 `visible` | AnimationPlayer 的换图轨道;同一 slot 同键名的几套皮肤的节点共用一条轨道 |
| 皮肤 | 外面包一层 Node2D 的 `visible` | SkinPlayer:每套皮肤一条静态动画,只写包装节点 |

Godot 里父节点隐藏子节点就不画,两个开关天然是 AND。只有和皮肤有关的节点才包:具名皮肤里的,以及默认皮肤里
会被某套具名皮肤同 slot 同键名盖住的。包装节点叫 `<基名> (<皮肤>)`(不能用 `@`,第 1 节)。
切皮肤 = `$SkinPlayer.play("Pirate")`。SkinPlayer **不开** deterministic —— 它不该把主动画的属性拉回 RESET。
初始皮肤(`--skin`,不给时是默认皮肤,默认皮肤空着取第一套具名皮肤)直接写进节点的 `visible`,编辑器里一打开就是它。

deform 按「皮肤 + slot + 键名」认目标 —— 三套皮肤同键名的围巾各有各的 deform。

## 9. 4.1 序列帧

每帧一个节点(`<基名> #<帧号>`),显示 =「换图说这个键名亮着」且「sequence 时间轴说现在是这一帧」,两个阶梯合成
一条 `visible` 轨道。算法与 Unity 导出相同(`spine-eval/sequence.ts`)。时长为 0 的动画按一个周期写。

## 10. 自检与渲染

```bash
godot --headless --path <工程> --import                                        # 先让 Godot 导入贴图
godot --headless --path <工程> --script res://AnimatorGoVerify.gd -- res://a.tscn …
godot --path <工程> --script res://AnimatorGoRender.gd -- res://a.tscn [输出目录] [每条动画几帧] [皮肤]
```

`tools/godot/` 下的脚本要拷进工程根。`AnimatorGoVerify.gd` 查「只有 Godot 知道、而且不报错」的两类问题:轨道的
节点 / 属性指不到(Godot 直接忽略这条轨道)、蒙皮骨骼路径指不到(网格不画)。`AnimatorGoRender.gd` 走真正的
AnimationPlayer 逐帧渲成 PNG,不能加 `--headless`。

端到端测试 `src/spine-convert/godot/export.test.ts`:把写出的 `.tscn` 读回来,**按 Godot 的规则**(第 1 节的实测结论)
算每个顶点,和 Spine 的求值在 setup、每个关键帧和相邻关键帧的中点比。仓库里 MX2_cat 3.8 / 4.1 必跑,
MergeCooking2 的 7 个本地样本存在才跑(加权 deform、全靠 deform、linkedmesh、6 套皮肤、100 个 region、绑定不一致)。
「Godot 的规则」包括每顶点只留权重最大的 4 根再归一(第 1 节)—— 之前的参照求值按完整权重算,截断看不出来。

## 11. 转不过去的(都会报出来)

- IK / transform / path 约束 —— 没转,受约束的骨骼停在自己的关键帧上(与 Unity 导出一致)
- clipping 遮罩、Spine 事件、两色染色的暗色、非默认继承模式、screen 混合
- 每顶点超过 4 根骨骼:Godot 只用 4 根。挑留哪 4 根、拟合坐标后仍超 0.5 像素的报 approximated(第 6 节)
