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
| slot 换图 / 皮肤 | `SpriteLibrary` 的 Category + Label,`SpriteResolver` 解析 | ✅ 可映射,且可打进动画 |
| 骨骼 TRS 动画 | `.anim` 的 Position / Euler / Scale 曲线 | ✅ 可映射 |
| IK | 包内 `IK/` 模块 | ✅ 有 |
| **deform 顶点关键帧** | —— | ❌ **没有对应物** |
| **path / transform 约束** | —— | ❌ 没有 |
| **两色染色(dark)** | —— | ❌ 没有 |

> 📌 **纠正一处早期判断**:曾认为「Unity 没有 slot / skin 的对应物」。
> 实际有 —— `SpriteLibrary` + `SpriteResolver` 就是换装与换图机制。
> 真正缺的只有上表最后三行。

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
| 位置 | 相对父骨骼 | 相对父骨骼(一致) |
| **旋转** | **角度(度)** | **四元数** |
| 长度 | `length` | `length`(一致) |
| 单位 | Spine 单位 | **像素**(受 `pixelsPerUnit` 影响) |

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

两者都是三次曲线,数学上可互转 —— 贝塞尔控制点到端点的连线方向就是切线:

```
outSlope(k0) = (v1 - v0) * cy1 / ((t1 - t0) * cx1)
inSlope (k1) = (v1 - v0) * (1 - cy2) / ((t1 - t0) * (1 - cx2))
```

**但 Spine 的控制点 x 可以任意放,Unity 非加权曲线做不到。**
要精确还原必须设 `weightedMode: 3`(两端都加权)并写 `inWeight` / `outWeight`;
否则只能近似,须报 `approximated`。

---

## 6. 待确认

- `.anim` 里驱动 `SpriteResolver` 的曲线具体形态(应该在 `m_PPtrCurves` 或
  `m_FloatCurves` 上,尚无样本)
- `SpriteLibraryAsset` 的 `.asset` 序列化字段
- 多 sprite 共享骨架时,`SkeletonAsset` 与各 sprite `bones` 的配合方式
