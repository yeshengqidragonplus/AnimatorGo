# Spine `.skel` 二进制格式

**本文是自行整理的格式规范,不是任何源码的副本。**

Esoteric 从未公开发布 `.skel` 的格式规范(`.json` 只公开到 3.8)。本文的字节布局
通过阅读用户合法持有的 spine-csharp 运行时**整理得出**,记录的是格式事实
(字段顺序、数据类型、条件分支)—— 事实不受版权保护。

**实现必须照本文写,不得对照源码逐行翻译。** 见 [DECISIONS.md](DECISIONS.md)
「不得移植 Spine 运行时源码」。

参照的运行时版本:
- 3.8 —— spine-csharp,头部注释 "Last updated January 1, 2020"
- 4.1 —— spine-csharp,头部注释 "Last updated July 28, 2023"

验证样本:`res/spine/{3.8,4.1}/MX2_cat.skel.bytes`(同一骨架的两个版本导出)。

---

## 1. 基本数据类型

| 类型 | 编码 |
|---|---|
| `byte` | 1 字节 |
| `bool` | 1 字节,非 0 即真 |
| `int` | 4 字节,**大端** |
| `varint` | 变长整数,每字节低 7 位是数据、最高位表示"还有下一字节" |
| `float` | 4 字节 IEEE 754,**大端** |
| `string` | `varint` 长度 + UTF-8 字节。**长度值 = 实际字节数 + 1**;长度为 0 表示 null,为 1 表示空串 |
| `stringRef` | `varint` 索引,指向文件头的字符串表;0 表示 null,否则取表中第 `索引-1` 项 |

`varint` 有带符号和不带符号两种读法。计数、索引一律用不带符号的。

> ⚠️ **大端**。多数二进制格式用小端,这里不是。读错了所有数值都是垃圾。

---

## 2. 文件头

| 字段 | 3.8 | 4.1 |
|---|---|---|
| hash | **`string`** | **`long`(8 字节)** |
| version | `string` | `string` |
| x, y, width, height | 4 × `float` | 同 |
| nonessential | `bool` | 同 |
| ↳ fps | `float`(仅 nonessential) | 同 |
| ↳ imagesPath | `string`(仅 nonessential) | 同 |
| ↳ audioPath | `string`(仅 nonessential) | 同 |

**唯一差异是 hash 的编码。** 十六进制实测印证:

```
3.8:  1c "bcWyBdy4zVbobZ81b3oOpBz3eRI"  07 "3.8.95"
4.1:  18 1d 16 53 33 a1 82 1b            07 "4.1.23"
```

4.x 运行时靠 `version.Length > 13` 判断是不是旧的 3.8 文件并提前返回 ——
说明两版格式**无法互相识别**,必须由外部知道版本。

> 📌 **纠正一处 changelog 说法**:官方 4.0 changelog 说"新增了字符串表"。
> 实测 **3.8.95 已经有字符串表**,结构与 4.1 一致。不要据 changelog 认为这是差异。

### 字符串表

紧接文件头:`varint` 数量 + N × `string`。后续所有 `stringRef` 都索引这张表。

---

## 3. 骨骼

`varint` 数量,然后每根:

| 字段 | 类型 | 备注 |
|---|---|---|
| name | `string` | |
| parent | `varint` | 骨骼下标。**第 0 根(根骨骼)没有这个字段** |
| rotation | `float` | |
| x, y | `float` | 受 scale 缩放 |
| scaleX, scaleY | `float` | |
| shearX, shearY | `float` | |
| length | `float` | 受 scale 缩放 |
| transformMode | `varint` | 枚举下标 |
| skinRequired | `bool` | |
| color | `int` | **仅 nonessential**,运行时跳过不用;缺省 `9b9b9bff` |

**3.8 与 4.1 完全一致。**

⚠️ 骨骼颜色运行时不用,但**写回要原样还**。曾经读时丢弃、写时填 0,仓库里的两个样本恰好不带
nonessential 所以往返测试一直是绿的;对全盘 3296 个 4.x 骨架跑逐字节往返时 1445 个在这里挂掉。

---

## 4. Slot

`varint` 数量,然后每个:

| 字段 | 类型 | 备注 |
|---|---|---|
| name | `string` | |
| bone | `varint` | 骨骼下标 |
| color | `int` | `0xRRGGBBAA` |
| darkColor | `int` | `0x00RRGGBB`;**`-1` 表示没有暗色** |
| attachmentName | `stringRef` | |
| blendMode | `varint` | |

**3.8 与 4.1 完全一致。**

---

## 5. 约束

### IK 约束 —— 两版一致

`varint` 数量,每个:name `string`、order `varint`、skinRequired `bool`、
bones(`varint` 数量 + N × `varint` 骨骼下标)、target `varint`、
mix `float`、softness `float`(受 scale)、bendDirection `sbyte`、
compress `bool`、stretch `bool`、uniform `bool`。

### Transform 约束 —— ⚠️ **两版不同**

前半段一致:name、order、skinRequired、bones、target、local `bool`、relative `bool`、
offsetRotation、offsetX、offsetY、offsetScaleX、offsetScaleY、offsetShearY(6 × `float`)。

**mix 部分不同:**

| 3.8(4 个 float) | 4.1(6 个 float) |
|---|---|
| rotateMix | mixRotate |
| translateMix | **mixX** |
| ↳(同一个值管 X 和 Y) | **mixY** |
| scaleMix | **mixScaleX** |
| ↳(同一个值管 X 和 Y) | **mixScaleY** |
| shearMix | mixShearY |

**这不是改名,是拆分。转换规则:**

- **3.8 → 4.1**:`mixX = mixY = translateMix`,`mixScaleX = mixScaleY = scaleMix`。无损。
- **4.1 → 3.8**:`translateMix = mixX`,`scaleMix = mixScaleX`。
  **若 `mixX ≠ mixY` 或 `mixScaleX ≠ mixScaleY`,差值丢失,必须报 `loss`。**

### Path 约束

待整理。

---

## 6. 时间轴类型编号 —— ⚠️ **两版差异最大**

### 骨骼时间轴

| 编号 | 3.8 | 4.1 |
|---|---|---|
| 0 | ROTATE | ROTATE |
| 1 | TRANSLATE | TRANSLATE |
| 2 | SCALE | **TRANSLATEX** |
| 3 | SHEAR | **TRANSLATEY** |
| 4 | — | SCALE |
| 5 | — | **SCALEX** |
| 6 | — | **SCALEY** |
| 7 | — | SHEAR |
| 8 | — | **SHEARX** |
| 9 | — | **SHEARY** |

4.x 允许只对单轴打关键帧。**降级到 3.8 时,单轴时间轴没有对应物** ——
要么合成双轴(另一轴取绑定姿势值),要么丢弃并报告。

### Slot 时间轴

| 编号 | 3.8 | 4.1 |
|---|---|---|
| 0 | ATTACHMENT | ATTACHMENT |
| 1 | COLOR | **RGBA** |
| 2 | TWO_COLOR | **RGB** |
| 3 | — | **RGBA2** |
| 4 | — | **RGB2** |
| 5 | — | **ALPHA** |

3.8 的 COLOR 对应 4.x 的 RGBA;TWO_COLOR 对应 RGBA2。
4.x 新增的 RGB / RGB2 / ALPHA 是"只改部分通道"的优化,**降级时要合成回完整 RGBA**。

### Attachment 时间轴(4.x 新增子类型)

4.x 在 attachment 时间轴下分了 DEFORM(0)和 **SEQUENCE**(1)。
**sequence 是 4.1 新特性,3.8 没有对应物,降级必丢。** 帧布局见 7.9。

### 曲线类型 —— 两版一致

`LINEAR=0`、`STEPPED=1`、`BEZIER=2`。

---

## 7. 动画 —— 两版差异最多的一段

已用真实文件完整验证:两个版本都能读到文件最后一个字节,且时间轴结构逐项一致。

**全盘验收(2026-09-23)**:`E:/UnityProject` 下按内容去重后 **3295 个 4.1.23 + 4915 个 3.8** 骨架,
全部读到精确 EOF、写回逐字节相同。最后三处缺口是 7.2(时间轴总数)、7.6(同一 owner 分成两组)、
7.10(音频事件的 volume / balance)—— 仓库样本一处都没覆盖到,只有扫全盘才撞得到。

### 7.1 ⚠️ 帧与曲线的排列顺序不同(最容易踩的一处)

```
3.8:  t0 v0 曲线0 | t1 v1 曲线1 | t2 v2        每帧读自己的值,后面跟曲线
4.x:  t0 v0 | t1 v1 曲线0 | t2 v2 曲线1        曲线挪到了「下一帧的值之后」
```

4.x 要先把第一帧读出来,再错位循环。**用 4.x 的读法去读 3.8 会从头开始读乱码。**

### 7.2 每条动画的开头

4.x 多一个**时间轴总数** varint,3.8 没有。

⚠️ **这个数不一定等于后面实际写了几条。** 运行时只拿它当列表的初始容量,读多读少都不出错,
所以 Spine 自己写的值有时偏大:全盘 10567 条 4.1 动画里 81 条(分布在 48 个文件)比实际多,
多 1 的最常见,最多多 63;**从没见过偏小**。

偏大的来历是推断,但证据很一致:48 个文件里 47 个的字符串表有**谁也不引用的名字**(不相关的文件里这个比例约 29%)。
典型如 `Door.skel`:字符串表里有 `door_7`、slot `door_7` 也在,可是**没有任何皮肤装着叫 `door_7` 的 attachment**,
三条动画各多 1 —— 像是 Spine 先按工程里的时间轴计了数、登记了名字,写正文时又把「attachment 没进导出」
的 deform 时间轴跳过了(deform 必须在皮肤里找到 attachment,否则运行时直接抛错)。

**处理:** 读的时候存原值(`AnimationData.timelineCount`),写回原样还;3.8 / JSON 来的没有这个值,
写 4.x 时用实际条数 —— 这正是运行时真正会建出来的时间轴数。跨版本转换(`convert.ts`)重建了时间轴,
所以会丢掉原值、现算。

### 7.3 时间轴头

| | 3.8 | 4.x |
|---|---|---|
| 通用 | type, frameCount | type, frameCount, **bezierCount** |
| attachment / drawOrder / event | 同上 | **不写 bezierCount**(没有曲线) |

### 7.4 ⚠️⚠️ 两版的控制点**不是一个坐标系**

```
3.8:  [cx1, cy1, cx2, cy2] 全在 [0,1] —— 占这一段时间/取值的百分比
4.x:  [cx1, cy1, cx2, cy2] 是绝对的时间(秒)与取值
```

同一份动画的两个导出,实测控制点范围:

```
3.8   cx ∈ [0.243, 0.758]   cy ∈ [0.00, 1.00]
4.1   cx ∈ [0.058, 1.949]   cy ∈ [-139.58, 393.41]     ← 角度本身
```

依据是 Spine 4.x 自己的读取器 —— 四个 float 就是绝对的 cx1/cy1/cx2/cy2:

```csharp
// SkeletonBinary.SetBezier
timeline.SetBezier(bezier, frame, value, time1, value1,
                   ReadFloat(), ReadFloat() * scale, ReadFloat(), ReadFloat() * scale,
                   time2, value2);
```

**弄混了不会崩溃,只会让所有缓动悄悄变形** —— 动画照播,看着也像那么回事,
但节奏全不对。这是本项目里最难自己发现的一类错。换算(见 `src/spine-format/bezier.ts`):

```
绝对 = 起点 + 归一化 × (终点 - 起点)      对时间和取值各做一次
```

导出到别的引擎时,先化成绝对坐标再求切线:

```
outSlope = (cy1 - v0) / (cx1 - t0)
inSlope  = (v1 - cy2) / (t1 - cx2)
```

**两个例外**(两版一致,不需要换算):

- **deform** —— 4.x 调用时传 `value1 = 0, value2 = 1`,取值本来就是 0..1
- 注意 **slot 颜色**虽然要换算,但取值空间是 `字节 / 255`(0..1),不是 0..255

> 📌 两次踩坑都是靠「近似/有损的计数反常」发现的:
> 先是按归一化理解 4.x,54.5% 的曲线段被误判为「无法精确表达」;
> 改成绝对之后又忘了 3.8 是归一化的,轮到 3.8 有 46 条时间轴被误判。
> 两次都是**曲线本身错了看不出来,只有那个数字不对劲**。

### 7.5 多值通道的贝塞尔

3.8 无论几个分量都只存**一条**曲线;4.x **每个分量各一条**。

- translate:3.8 是 4 个 float,4.x 是 8 个
- RGBA:3.8 是 4 个,4.x 是 16 个

⚠️ **升级不是把那一条复制 N 份。** 3.8 那条是归一化的,对每个分量都成立;
换成绝对坐标时要用**各分量自己的取值范围**,所以算出来的 N 条一般互不相同。

**降级时若各分量曲线不同,只能保留一条 —— 必须报 loss。**
比较要在**归一化之后**做:各分量取值范围不同,绝对值几乎必然不等,
按绝对值比会把「形状其实一样」也报成有损(实测 MX2_cat 就是,修正后 4.1 → 3.8 的曲线零丢失)。
代表分量取**取值变化最大**的那个 —— 首尾取值相同的分量归一化后是全 0,
拿它当代表会把曲线丢成一条直线。

### 7.6 分段顺序

两版相同:slot → 骨骼 → IK → transform → path → deform → drawOrder → event。

4.x 把 deform 段改名为「attachment 时间轴」,并在每条时间轴前加了**子类型字节**
(0 = deform,1 = sequence)。

slot / 骨骼 / path 三段是「组数 → 每组:owner 下标 + 组内条数 + N 条时间轴」;deform 段多套两层
(skin → slot → attachment)。

⚠️ **同一个 owner 可以出现在两个不相邻的组里。** 全盘只有一例:`man.skel` 的 `work_3_fear`,
骨骼 2 先有一组 rotate / translate / scale,隔了骨骼 3 那一组,又来一组只有 rotate —— 同一根骨骼两条 rotate。
写回时要按**连续段**分组,不能按 owner 合并(合并后组数 39 → 38,文件短 2 字节)。
读取端按文件顺序平铺时间轴,连续段正好还原原分组;JSON 来的时间轴本来就按 owner 连续,两种分法结果一样。

📌 **组内重复**在 3.8 里很常见:99 个文件、共 4800 处(attachment 1557、color 2930、deform 313),
都是同一个 slot 的同类时间轴在同一组里出现两次。二进制往返原样保留;**JSON 表达不了**(同一个键只能有一个值),
`toJson` 留最后一条 —— 运行时按顺序套用,满权重时后一条整条盖掉前一条(它首帧之前的时段也会被拉回 setup),
所以正常播放看不出区别;动画间混合过渡时可能有细微差异。

全盘约 4500 处前后两条内容完全相同(丢了无损);内容不同的 297 处、52 个文件,`skel → json` 与 Unity 导出
各报一条 approximated。逻辑在 `src/spine-format/duplicateTimelines.ts`,两处共用。
⚠️ Unity 那边不去重是**看得见的** bug:两条 deform 各变成一组 Blend Shape,而 Blend Shape 是叠加的,形变翻倍。

### 7.7 deform 帧序

```
3.8:  时间 → 顶点 → 曲线            (每帧)
4.x:  先读一个时间,循环里是 顶点 → 下一帧时间 → 曲线
```

### 7.8 slot 颜色

3.8 打包成 `int`;4.x 分通道逐字节。类型也从 3 种扩到 6 种(见第 6 节)。

### 7.9 sequence 时间轴(4.1)

attachment 时间轴段里,子类型字节为 1 的一项:

| 字段 | 类型 | 说明 |
|---|---|---|
| frameCount | `varint` | **没有 bezierCount** —— 序列帧不插值 |
| 每帧 time | `float` | |
| 每帧 modeAndIndex | `int`(定长 4 字节,不是 varint) | 低 4 位是模式,其余位是起始帧号(`>> 4`) |
| 每帧 delay | `float` | 秒/帧 |

模式:`hold / once / loop / pingpong / onceReverse / loopReverse / pingpongReverse`(0~6)。
求值规则见 `src/spine-eval/sequence.ts`。attachment 上的 `sequence` 字段是 `count / start / digits / setupIndex`
四个 varint;帧 i 的图集区域名 = path + (start + i) 补零到 digits 位。

⚠️ **曾经把子类型字节读了就丢,一律按 deform 解析** —— 全盘 9 个带 sequence 的 4.1 骨架全部读不通
(报「读到文件尾之后」)。修好后 9 个都读到精确 EOF、写回逐字节相同,覆盖 hold / once / loop / loopReverse。

JSON 里是 `animations.*.attachments[皮肤][slot][attachment].sequence = [{time, mode, index, delay}]`,
**`delay` 缺省沿用上一帧的**(不是 0),`mode` 缺省 `hold`。见 `src/spine-format/json/realFormat.test.ts`。

### 7.10 事件 —— ⚠️ 帧的长度取决于**事件定义**

**两版一致。** 事件定义表紧跟皮肤、在动画之前:

| 字段 | 类型 | 说明 |
|---|---|---|
| name | `stringRef` | |
| int | `varint`(**zigzag**,可为负) | |
| float | `float` | |
| string | `string` | 可为 null |
| audioPath | `string` | null = 不带音频 |
| ↳ volume, balance | 2 × `float` | **仅 audioPath 非 null** |

动画末尾的事件时间轴:`varint` 帧数(0 = 没有这条时间轴),每帧:

| 字段 | 类型 | 说明 |
|---|---|---|
| time | `float` | |
| event | `varint` | 事件定义下标 |
| int | `varint`(zigzag) | |
| float | `float` | |
| hasString | `bool` | |
| ↳ string | `string` | 仅 hasString;没有时运行时沿用定义里的 string |
| ↳ volume, balance | 2 × `float` | ⚠️ **仅当该帧引用的事件定义带音频** |

**帧里没有任何标志位说明后面有没有 volume / balance** —— 只能拿 event 下标回查定义表。
所以读动画必须先读完事件定义(`readAnimations` 收 `events` 参数),写入端按同一个条件镜像。

曾经完全没读这 8 字节:全盘 6 个带音频事件的骨架(Cooking12 OrderGame 的 cheese / cucumber / onion / tomato / drink,
外加一个 3.8 的 `Pre_prop_scissors`),前 4 个读不通(报「读到文件尾之后」),drink 的音频帧恰好在最后一条动画里,
表现为停在 EOF 前 8 字节。修后 6 个都逐字节往返,共 38 个音频帧。

JSON 里帧的 `volume` / `balance` **缺省取事件定义的值**(Spine 读 JSON 就是这么补的),不是 1 / 0 ——
`toJson` 与定义相等就省略,`fromJson` 缺省补定义值,从 JSON 来的帧没有这两个字段时写入端也用定义值。
实测 38 个音频帧全等于定义值(1 / 0),所以「帧值 ≠ 定义值」这条分支只有合成用例覆盖
(`animationLayout.test.ts`)。

## 8. 转换验证结果

`src/spine-convert/skel/convert.ts` 已实现双向转换,并用**标准答案**验证 ——
同一骨架的 3.8 与 4.1 导出互为对照:

| 检验项 | 3.8 → 4.1 | 4.1 → 3.8 |
|---|---|---|
| 产物是合法文件、能完整重读 | ✅ | ✅ |
| 骨骼数值与真实导出一致 | ✅ 全等 | ✅ |
| 时间轴种类与数量 | ✅ 245 条全等 | ✅ 245 条全等 |
| 帧数值(1895 个) | ✅ | ✅ |
| **算出的 bezierCount** | ✅ **236 条全中** | —— |
| loss 报告 | 无(升级无损) | 12 条,精确到时间轴 |

`bezierCount` 全中特别说明问题:该字段 3.8 文件里**根本不存在**,是按
「各帧曲线所占分量数之和」推出来的,236 条全部命中 Spine 自己写的值。

### ⚠️ 浮点比对必须用相对容差

实测 Spine 自己的两份导出,同一个值会差 `7.63e-6` —— 正好是 float32 在
113 这个量级上的 **1 个 ULP**(2⁻¹⁷)。两次导出的舍入本来就不同,
不是转换出错。

float32 只有约 7 位有效数字,所以比对要用**相对容差 1e-6**,不能用绝对容差。
**也因此,转换产物与真实导出不可能逐字节相同** —— 结构 + 相对容差数值比对
才是正确的验收标准。(往返测试则要求逐字节相同,那是另一回事:同一份数据
读进来再写回去,不涉及跨版本舍入。)

## 9. 待整理

- path 约束的字段顺序:全盘 99 个带 path 约束的骨架(42 个 4.1 + 57 个 3.8)都逐字节往返,**字节布局**已确认;
  但往返查不出同类型字段互换(三个 mode 都是 varint,offsetRotation / position / spacing 都是 float),语义顺序仍待对照
- ~~事件时间轴中带音频事件的 volume / balance~~ 已用真实文件验证,见 7.10
