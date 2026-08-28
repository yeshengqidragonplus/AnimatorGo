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

## 7. 待整理

- Path 约束的字段顺序
- 皮肤与各类 attachment(region / mesh / linkedmesh / boundingbox / path / point / clipping)
- 事件
- **动画时间轴的关键帧与曲线编码** —— changelog 明确说 4.0"改了曲线格式并增加了省略默认值的假设",
  这是剩余工作里最大的一块
