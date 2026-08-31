# Unity 2D Animation 资源格式

**本文是自行整理的格式规范。** 字节/字段布局取自 Unity 实际产出的 `.meta`
(`res` 之外的真实样本:`HotpotScrew3D2/Assets/Res/test/test.png.meta`,
在 Skinning Editor 里画了 4 根骨骼 + Auto Geometry + Auto Weights),
以及 `com.unity.2d.animation` 包的公开序列化字段。

参照版本:`com.unity.2d.animation@13.x`(ColorBean3 / HotpotScrew3D2)。

---

## 1. 能力对照:Spine → Unity

| Spine | Unity 2D Animation | 结论 |
|---|---|---|
| 骨骼层级 | `bones[]`(在 sprite 的 `.meta` 里)+ 场景 Transform | ✅ 可映射 |
| 网格 + 顶点权重 | `vertices` / `indices` / `weights` | ⚠️ **每顶点最多 4 根骨骼** |
| slot 换图 / 皮肤 | 一个 attachment 一个物体 + `m_IsActive` 曲线 | ✅ 可映射(不必用 SpriteLibrary) |
| 骨骼 TRS 动画 | `.anim` 的 Position / Euler / Scale 曲线 | ✅ 可映射 |
| IK | 包内 `IK/` 模块 | ✅ 有 |
| **deform 顶点关键帧** | —— | ❌ **没有对应物** |
| **path / transform 约束** | —— | ❌ 没有 |
| **两色染色(dark)** | —— | ❌ 没有 |

> 📌 **纠正一处早期判断**:曾认为「Unity 没有 slot / skin 的对应物」。
> 实际有 —— `SpriteLibrary` + `SpriteResolver` 就是换装与换图机制。
> 真正缺的只有上表最后三行。
>
> 不过**实现上没用 SpriteLibrary**:改成一个 attachment 一个 GameObject、
> 用 `m_IsActive` 阶梯曲线互斥地开关。原因是网格 attachment 各有各的顶点和 pivot,
> 换 sprite 换不动网格,而换物体可以。顺带也不需要额外的 `.asset`。

---

## 2. 骨骼:写在纹理的 `.meta` 里

路径:`TextureImporter.spriteSheet.sprites[i].bones`

```yaml
bones:
- name: bone_1
  guid: dd9586a93597b084c91d67f05c10ad7d   # 32 位十六进制,每根骨骼唯一
  position: {x: 80.18796, y: 69.827286, z: 0}
  rotation: {x: 0, y: 0, z: 0.9366846, w: 0.3501742}
  length: 94.57553
  parentId: -1                              # 根为 -1,否则是本数组下标
  color:
    serializedVersion: 2
    rgba: 4278190335                        # 编辑器里显示用
```

### 与 Spine 的对应

| | Spine | Unity |
|---|---|---|
| 父引用 | 下标,根骨骼**无此字段** | `parentId`,根为 **-1** |
| 位置 | 相对父骨骼 | **根**相对矩形左下角、**子**相对父骨骼 |
| **旋转** | **角度(度)** | **四元数**,相对父骨骼 |
| 长度 | `length` | `length`(一致) |
| 单位 | Spine 单位 | **像素**,导入时除 `pixelsPerUnit` |

导入时的换算写死在包里的 `Editor/SpritePostProcess.cs`:

```csharp
// 根骨骼要减 pivot,子骨骼不减
position = isRoot ? (bone.position - rect.size * rect.pivot) : bone.position;
position = position * definitionScale / pixelsPerUnit;
```

⚠️ **绑定姿势只有旋转和平移,没有缩放**(`Matrix4x4.SetTRInverse`)。
⚠️ `definitionScale` = 实际纹理尺寸 ÷ 导入后尺寸,所以 `maxTextureSize`
**必须 ≥ 图片实际尺寸**,否则算好的像素坐标会被整体缩放。

**旋转要换算。** Spine 的旋转只绕 Z 轴,所以:

```
Unity 四元数 = (0, 0, sin(角度/2), cos(角度/2))
Spine 角度   = 2 * atan2(z, w),转成度
```

### ⚠️ 每个 sprite 各带一份骨骼表

Unity 是**每个 sprite 自带 `bones`**;Spine 是**一副骨架供所有 attachment 共用**。

转换时:场景里建一套共享的 Transform 层级,每个 sprite 的 `bones` 写它**实际用到的
那个子集**,再由 `SpriteSkin.m_BoneTransforms` 把下标映射到共享 Transform。
名字必须一致,否则绑不上。

---

## 3. 网格与权重

同在 `sprites[i]` 下:

```yaml
vertices:
- {x: 101.826004, y: 2.0429993}     # 像素坐标,原点在 sprite 左下
- {x: 124.655, y: 2.4400024}
indices: 000000000300000001000000...  # ⚠️ 十六进制字符串,不是 YAML 列表
edges:
- {x: 0, y: 1}                       # 轮廓边,编辑器显示用
weights:
- 'weight[0]': 1
  'weight[1]': 0
  'weight[2]': 0
  'weight[3]': 0
  'boneIndex[0]': 0
  'boneIndex[1]': 0
  'boneIndex[2]': 0
  'boneIndex[3]': 0
```

### `indices` 的编码

十六进制字符串,每 8 个字符是一个 **小端 uint32**,三个一组构成一个三角形。

```
00000000 03000000 01000000  →  三角形 (0, 3, 1)
00000000 04000000 03000000  →  三角形 (0, 4, 3)
```

> ⚠️ **小端**。Spine 的 `.skel` 是**大端**,两者相反,别搞混。

### ⚠️ 每顶点最多 4 根骨骼

`weights` 是 Unity 的 `BoneWeight`,固定四个槽位。
**Spine 允许每顶点绑任意多根骨骼。**

超过 4 根时:取权重最大的 4 根,重新归一化,**并报 `approximated`**。
权重不足 4 个时用 `weight: 0, boneIndex: 0` 补齐(样本里就是这样)。

---

## 4. `SpriteSkin` 组件(prefab 侧)

序列化字段很少:

```
m_RootBone        Transform 引用
m_BoneTransforms  Transform[] —— 下标与 sprite 的 bones 一一对应
m_Bounds
m_AlwaysUpdate    默认 true
m_AutoRebind      默认 false
```

---

## 5. `.anim`(AnimationClip)

```yaml
%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!74 &7400000
AnimationClip:
  m_Name: ...
  m_ScaleCurves:
  - curve:
      m_Curve:
      - serializedVersion: 3
        time: 0
        value: {x: 0.6, y: 0.6, z: 0.6}
        inSlope: {x: 0, y: 0, z: 0}
        outSlope: {x: 0, y: 0, z: 0}
        tangentMode: 0
        weightedMode: 0
        inWeight: {x: 0.33333334, …}
        outWeight: {x: 0.33333334, …}
      m_PreInfinity: 2
      m_PostInfinity: 2
    path: 某个/子物体/路径
```

曲线分组:`m_RotationCurves`(四元数)、`m_EulerCurves`、`m_PositionCurves`、
`m_ScaleCurves`、`m_FloatCurves`、`m_PPtrCurves`(对象引用,换图用)。

### ⚠️ 曲线模型不同:Hermite 切线 vs 贝塞尔控制点

```
Spine:  [cx1, cy1, cx2, cy2]   两帧之间的归一化贝塞尔控制点
Unity:  inSlope / outSlope     每帧一个切线斜率
```

⚠️ **Spine 的控制点是绝对的「时间 / 值」,不是归一化到 [0,1] 的。**
实测数据里出现过 `cx1 = 1.1083`(该段是 1.0→2.0 秒)和 `cy1 = 333.98`(旋转角度)。
按归一化理解会让**所有缓动悄悄变形** —— 不崩溃、能播,就是不对。换算是:

```
outSlope(k0)  = (cy1 - v0) / (cx1 - t0)
inSlope (k1)  = (v1 - cy2) / (t1 - cx2)
outWeight(k0) = (cx1 - t0) / (t1 - t0)
inWeight (k1) = (t1 - cx2) / (t1 - t0)
```

**Spine 的控制点 x 可以任意放,Unity 非加权曲线做不到**,所以必须同时设
`weightedMode`(1=in,2=out,3=两端)并写 `inWeight` / `outWeight`。
只有控制点正好贴在端点上(斜率 0/0)时才退化成线性并报 `approximated`。

### 其它曲线分组的写法

`m_FloatCurves` 的条目比 `m_PositionCurves` 多一层 `serializedVersion: 2`:

```yaml
  m_FloatCurves:
  - serializedVersion: 2      # ← 向量曲线没有这一行
    curve:
      serializedVersion: 2
      m_Curve: [...]
    attribute: m_IsActive
    path: 某个/子物体
    classID: 1                # 1 = GameObject,212 = SpriteRenderer
    script: {fileID: 0}
    flags: 0
```

阶梯曲线(布尔量必须用)写 `inSlope: Infinity, outSlope: Infinity, inWeight: 0, outWeight: 0`。

---

## 6. ⚠️ 加权网格的绑定姿势**不是** setup pose

直觉上,加权网格的顶点摆在骨架的 setup pose 下就该正好贴在图上。
**MX2_cat 的 15 个网格里有 6 个不是这样**(残差 45~206 像素)——
那几个是「换装用的第二套」,画的时候骨架摆的是动画中的某个姿势。
拿 `body2` 去搜遍两条动画,在 `swim` 的第 2.0 秒残差只有 **0.01 像素**。

所以绑定姿势要**从网格自己的数据里解**:Spine 每个顶点存的是
`(骨骼, x, y, 权重)`,其中 `(x, y)` 就是绑定时刻该顶点在那根骨骼局部空间里的坐标。
于是对每根骨骼,「骨骼局部坐标 → 图片上的位置」这个刚体变换可以**单独**最小二乘解出来,
各骨骼互不耦合。实测 14 个加权网格全部重建到 0.4 像素以内。

顺带一个简化:既然绑定姿势是逐骨骼独立解的,`.meta` 里的 `parentId` 就可以**全填 -1**
(每根各记自己的世界变换)。`SpriteSkin` 只校验数量对得上、引用非空
(见包里的 `SpriteSkinUtility.Validate`),不要求层级。

## 7. ⚠️ 顶点位置和 UV 在 Unity 里是绑死的

Unity 的 sprite 网格**只存顶点位置**,UV 由「顶点在矩形里的位置」推出来。
所以顶点坐标不能随便挪 —— 挪了取图位置就跟着变。
顶点只能由 Spine 的 UV 反算:

```
顶点.x = u * originalWidth  - offsetX
顶点.y = originalHeight * (1 - v) - offsetY
```

(Spine 的 `uvs` 是相对**未裁剪原图**的归一化坐标,原点在左上、y 向下;
Unity 的顶点原点在矩形左下、y 向上。由 spine-csharp 的
`MeshAttachment.UpdateRegion` 反解得到。)

导入时顶点和**根骨骼**都会减 `pivot × 矩形尺寸` 再除 `pixelsPerUnit`
(子骨骼不减,它是相对父骨骼的),所以 pivot 在加权网格里会被约掉,随便取。

## 8. ⚠️ 图集缩放:Spine 可以按比例导出图集

Spine 导出图集时可以带缩放(实测这份素材是 **0.5**),`.atlas` 里**没有记这个数**。
表现是骨架单位是图集像素的 k 倍。只能从数据反推:

- region attachment:`width / originalWidth`
- 网格:逐骨骼相似变换拟合出的缩放

⚠️ **必须按尺寸加权取中位数。** 裁剪框是整数像素,小图被量化误差主导 ——
11×11 的气泡算出来是 1.909,400 像素宽的身体算出来是 1.9998。

反推出的 k **不改任何坐标**,只用来定纹理的 `spritePixelsToUnits = pixelsPerUnit / k`。
这样 sprite 像素和场景世界单位就对上了,而且**不用重采样图片**。

## 9. ⚠️ 旋转的图集区域必须重新烘焙

Spine 图集里的区域可以躺着放(`rotate: true`,省空间),
**Unity 的 sprite 矩形不能带旋转**。MX2_cat 的 16 个区域里有 8 个是旋转的。

理论上也可以「矩形按躺着的样子划,再给节点补 ∓90° 转回来」,但那样旋转、pivot、
网格顶点、蒙皮骨骼四套坐标约定要同时对上,错一个符号就是某些图莫名其妙偏了或倒了。
烘焙则只有一处方向约定,而且**打开产出的 PNG 一眼就能看出对不对**。

映射关系(设区域摆正后 w×h,在图集里占 (X, Y) 起、h×w 大):

```
摆正图的 (tx, ty)  ←  图集里的 (X + ty, Y + w - 1 - tx)
```

即图集里存的是**逆时针转了 90°** 的样子。

## 10. 材质

生成的 `SpriteRenderer` 引用 Unity 内置的 Sprites-Default:

```yaml
  m_Materials:
  - {fileID: 10754, guid: 0000000000000000f000000000000000, type: 0}
```

URP 工程里可能要换成 `Sprite-Unlit-Default`。这属于一眼能看出来(粉红)、
一键能改掉的问题,不像几何错误那样会悄悄错。

## 11. 待确认

- `.anim` 里驱动 `SpriteResolver` 的曲线具体形态(尚无样本)。
  目前换 attachment 走的是**一个 attachment 一个物体 + `m_IsActive` 阶梯曲线**,
  不需要 SpriteLibrary,顺带解决了「网格换图 PPtr 表达不了」的问题
- `SpriteLibraryAsset` 的 `.asset` 序列化字段
- 多 sprite 共享骨架时,`SkeletonAsset` 与各 sprite `bones` 的配合方式
