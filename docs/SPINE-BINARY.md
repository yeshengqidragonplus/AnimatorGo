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
| color | `int` | **仅 nonessential**,运行时跳过不用 |

**3.8 与 4.1 完全一致。**

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
**sequence 是 4.1 新特性,3.8 没有对应物,降级必丢。**

### 曲线类型 —— 两版一致

`LINEAR=0`、`STEPPED=1`、`BEZIER=2`。

---

## 7. 动画 —— 两版差异最多的一段

已用真实文件完整验证:两个版本都能读到文件最后一个字节,且时间轴结构逐项一致。

### 7.1 ⚠️ 帧与曲线的排列顺序不同(最容易踩的一处)

```
3.8:  t0 v0 曲线0 | t1 v1 曲线1 | t2 v2        每帧读自己的值,后面跟曲线
4.x:  t0 v0 | t1 v1 曲线0 | t2 v2 曲线1        曲线挪到了「下一帧的值之后」
```

4.x 要先把第一帧读出来,再错位循环。**用 4.x 的读法去读 3.8 会从头开始读乱码。**

### 7.2 每条动画的开头

4.x 多一个**时间轴总数** varint,3.8 没有。

### 7.3 时间轴头

| | 3.8 | 4.x |
|---|---|---|
| 通用 | type, frameCount | type, frameCount, **bezierCount** |
| attachment / drawOrder / event | 同上 | **不写 bezierCount**(没有曲线) |

### 7.4 多值通道的贝塞尔

3.8 无论几个分量都只存**一条**曲线;4.x **每个分量各一条**。

- translate:3.8 是 4 个 float,4.x 是 8 个
- RGBA:3.8 是 4 个,4.x 是 16 个

**降级时若各分量曲线不同,只能保留一条 —— 必须报 loss。**

### 7.5 分段顺序

两版相同:slot → 骨骼 → IK → transform → path → deform → drawOrder → event。

4.x 把 deform 段改名为「attachment 时间轴」,并在每条时间轴前加了**子类型字节**
(0 = deform,1 = sequence)。

### 7.6 deform 帧序

```
3.8:  时间 → 顶点 → 曲线            (每帧)
4.x:  先读一个时间,循环里是 顶点 → 下一帧时间 → 曲线
```

### 7.7 slot 颜色

3.8 打包成 `int`;4.x 分通道逐字节。类型也从 3 种扩到 6 种(见第 6 节)。

## 8. 待整理

- path 约束的字段顺序(测试骨架里没有 path 约束,未经真实数据验证)
- 事件时间轴中带音频事件的 volume / balance(测试骨架无事件)
