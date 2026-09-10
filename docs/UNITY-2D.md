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
| slot 换图 | 一个 attachment 一个物体 + 渲染器 `m_Enabled` 阶梯曲线;初始显隐按 setup pose(同一 slot 只亮 `attachmentName` 那个) | ✅ 可映射(不必用 SpriteLibrary) |
| 皮肤 | 没有查表;用 GameObject `m_IsActive` + Animator 第二层「每套皮肤一个 state」 | ✅ **一个 prefab 装全部皮肤**,`animator.Play("皮肤名", 1)` 切,见第 13 节 |
| 骨骼 TRS 动画 | `.anim` 的 Position / Euler / Scale 曲线 | ✅ 可映射 |
| IK | 包内 `IK/` 模块 | ⚠️ 有,但**未转换也未烘进曲线**,受 IK 驱动的骨骼停在自己的关键帧上 |
| **deform 顶点关键帧** | 2D 包里没有;用 **`SkinnedMeshRenderer` 的 Blend Shape** | ✅ **走另一条网格路径**,见第 11 节 |
| 逐帧绘制顺序 | 挪过位的 slot 每条动画一条 `m_SortingOrder` 阶梯曲线 | ✅ 可映射,见第 12 节 |
| **path / transform 约束** | —— | ❌ 没有 |
| **两色染色(dark)** | —— | ❌ 没有 |
| **clipping 遮罩** | —— | ❌ 没有 |

> 📌 **纠正一处早期判断**:曾认为「Unity 没有 slot / skin 的对应物」。
> 实际有 —— `SpriteLibrary` + `SpriteResolver` 就是换装与换图机制。
>
> 📌 **再纠正一处**:曾认为「deform 没有对应物」。2D Animation 包里确实没有,
> 但 Unity 的 3D 那半边有 —— `SkinnedMeshRenderer` 的 Blend Shape 做的正是
> 「每个顶点一组增量、按权重叠加、加完再蒙皮」,和 Spine 的 deform 是同一种数学。
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

## 6.5 ⚠️⚠️ 有顶点就必须有等量的 `weights`,哪怕这个 sprite 没有骨骼

Unity 的加载器(`com.unity.2d.sprite` 的
`SpriteMeshDataTransfer.LoadVertex2DMetaData`)只要 `m_Vertices` 非空,
就**无条件**去读 `m_Weights[0]`:

```csharp
var vertices = new Vertex2DMetaData[verticesSP.arraySize];
if (verticesSP.arraySize > 0)
{
    var weightsSP = so.FindPropertyRelative("m_Weights");
    var wsp = weightsSP.GetArrayElementAtIndex(0);        // ← 空数组 → null
    ... wsp.FindPropertyRelative("weight[0]")             // ← NullReferenceException
```

**抛出来的异常会中断 `SpritePostProcess` 的整个 sprite 循环**,于是
**排在它后面的 sprite 全部拿不到自定义网格和权重** —— Unity 改用 alpha 轮廓
重新生成,连带一片 SpriteSkin 报 `InvalidBoneWeights`。异常只在控制台一闪而过。

实测(MX2_cat,16 个 sprite):不加权网格 `eyelid` 排第 4,它一抛,#4~#16 全废:

| 位置 | sprite | 我们写的顶点 | Unity 实际 |
|---|---|---|---|
| 1 | body | 34 | **34** ✅ |
| 2 | body2 | 48 | **48** ✅ |
| 3 | bubble | 4 | **4** ✅ |
| 4 | eyelid | 56 | 7 ✗ ← 有顶点、`weights: []` |
| 5 | glass | 34 | 8 ✗ |
| 6 | head | 70 | 10 ✗ |

真实样本里那条 `bones: []` 的 sprite **也是带 weights 的**(`weight[0]: 1`,
`boneIndex` 全 0),照抄时漏了这一点。没有骨骼的 sprite 不挂 `SpriteSkin`,
所以这些数值不参与任何计算,纯粹是喂给加载器的占位。

**两条硬规则:**

1. **`weights` 的条数必须等于 `vertices` 的条数**,没有骨骼时用
   `weight[0]: 1` + `boneIndex` 全 0 占位
2. **每个 sprite 都写显式网格,一个都不留空** —— region attachment 用一个
   铺满矩形的四顶点网格。顺带好处是 Unity 的 alpha 轮廓生成完全不参与,
   产物变成确定的,不会因为图片边缘的一点 alpha 差异而改变网格

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

## 8. ⚠️⚠️ 缩放不是全局的 —— 只有加权网格约束纹理的 `pixelsPerUnit`

一开始我把 k 当成「整张图集的导出缩放」,一个常数。**那是错的。**

Spine 里**一个网格可以被画成图片的任意倍数**,那个倍数藏在顶点里,与图集无关。
实测 MergeCooking2 的 `26301`:67 个 region 都要 k=1.0,唯一那个 `house` 网格
要 k=2.0 —— 按中位数选 1.0,house 的残差是 **372 像素**。

正确的分解是问「谁没有别的地方放缩放」:

| 类型 | 自己的缩放放哪 |
|---|---|
| **加权网格** | 没地方放 —— 绑定姿势只有旋转和平移(`Matrix4x4.SetTRInverse`),只能靠纹理的 `spritePixelsToUnits`。**只有它约束 k** |
| 不加权网格 | 有自己的节点 Transform,`localScale` 扛得住 |
| region | 同上,按 `width / (originalWidth × k)` 算节点缩放 |

一个加权网格都没有时,k 完全不受约束,取 1。

不加权网格的节点变换(f 是拟合出的缩放,输入已除过 k):

```
metaVertex  = f·R(θ)·(骨骼局部 / k) + t
sprite 局部 = (metaVertex − pivot) / (ppu / k),pivot 取 t
            = f·R(θ)·骨骼局部 / ppu
⇒ 节点:旋转 −θ,缩放 1/f          ← 不要再乘一次 k,拟合输入里已经含了
```

### 加权网格之间也可能不一致

那才是真的无法表达 —— 只能取中位数并报 `approximated`。

### 反推 k 的办法

只能从数据反推(`.atlas` 里没有记):

**加权网格**逐骨骼做相似变换拟合,取拟合出的缩放。

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

⚠️ **`SkinnedMeshRenderer` 不会像 `SpriteRenderer` 那样自动把 sprite 的纹理塞给材质** ——
挂默认材质渲染出来是纯白(实测)。所以走第 11 节那条路的网格,每张图集页要写一个自己的
`.mat`(classID 21,`_MainTex` 指向图集页的 Texture2D,fileID 2800000)。URP 的 shader
guid `13c02b14c4d048fa9653293d54f6e0e1` 取自包内样本;内置管线用 `Sprites/Default`
(内置 shader fileID 10753)—— **这条没实测**,验证工程是 URP 的。

### ⚠️ 图集是预乘 alpha 的,Unity 的 sprite 材质不是

Spine 导给 spine-unity 的图集**默认预乘 alpha**(spine-unity 的 shader 按 PMA 采样)。
实测 MergeCooking2 全部图集和 MX2_cat 都是:半透明像素里没有一个通道大于 alpha。
Unity 自带的 sprite 材质按直通 alpha 混合,拿 PMA 图喂它等于 rgb 被乘了两次 alpha ——
**半透明越多的部件越发黑**。实心图只在边缘有一圈暗边看不出来;blackrichwoman 的 `face4`
(生气时的红晕,几乎全是半透明笔触)直接变成脸上一块深色的「叠加物」,用户在 Play 里一眼看到。

处理:烘焙前把源图还原成直通 alpha(`rgb × 255 / a`,见 `alpha.ts`),报一条 info。
3.8 的 `.atlas` 没有 pma 字段,只能按像素判断;4.x 有 `pma: true` 直接信。

## 11. SkinnedMeshRenderer 路径:deform / 非刚性 / 缩放不一致的网格

`SpriteRenderer + SpriteSkin` 是默认路径,已验证的效果不动。**只有三类 SpriteSkin
结构上表达不了的网格**改走 `SkinnedMeshRenderer` + Mesh 资产(决策见 DECISIONS.md,
排查数据见 PROGRESS.md):

| 为什么 SpriteSkin 不行 | Mesh 资产为什么行 |
|---|---|
| 有 deform 顶点动画 —— SpriteSkin 只做骨骼蒙皮 | Blend Shape:每个 deform 关键帧一个形变目标,权重由 `Animator` 驱动 |
| 绑定姿势非刚性 —— SpriteSkin 的绑定只有旋转平移(第 6 节) | `m_BindPose` 是任意 4×4 |
| 与其他加权网格缩放不一致 —— sprite 的顶点和 UV 绑死(第 7、8 节) | Mesh 的位置和 UV 各自独立,不再需要全局 k |

判据与 `export.ts` 一致:有 deform 时间轴指向它;或绑定残差 > max(1px, 跨度 2%);
或(真正混合的加权网格)自己反推的图集缩放与全局中位数差 > 2% 且跨度 ≥ 64px。

### 11.1 Mesh `.asset` 的 YAML(classID 43,fileID 4300000)

结构取自 Unity 6000.3 自己 `CreateAsset` 出来的网格(`tools/unity/AnimatorGoProbe.cs`,
用 `SetBoneWeights(NativeArray)` + `AddBlendShapeFrame` 造的),`serializedVersion: 12`:

- **`m_VertexData`**(serializedVersion 3):14 个通道槽位固定顺序 Position / Normal / Tangent /
  Color / TexCoord0..7 / BlendWeight / BlendIndices,每个 `{stream, offset, format, dimension}`,
  没用到的全 0。三个 stream,每个起点对齐 16 字节:

  | stream | 内容 | 格式(format 码) | 每顶点 |
  |---|---|---|---|
  | 0 | Position | Float32 × 3(0) | 12 B |
  | 1 | Color, TexCoord0 | UNorm8 × 4(2),Float32 × 2(0) | 12 B |
  | 2 | BlendWeight, BlendIndices | UNorm16 × 4(4),UInt16 × 4(8) | 16 B |

  6 顶点 → 72→80,72→80,96,共 256 字节,与样本逐字节对得上。
- **顶点流里只放权重最大的 4 根**,重新归一到总和正好 65535(舍入差记到最大那根上)。
  **超过 4 根的完整权重另存 `m_VariableBoneCountWeights.m_Data`**:先是每顶点一个 uint32
  「起始字偏移」,再一个 uint32 总字数,然后是 (骨骼 u16, 权重 UNorm16) 列表。
  Unity 只在 Quality 为 Unlimited 且渲染器 `m_Quality` 为 Auto 时用它
- **`m_Shapes`** 稀疏存:`vertices` 只列有增量的顶点(`vertex` + `index`,normal/tangent 全 0),
  `shapes` 记每个目标的 `firstVertex/vertexCount`,`channels` 记 `name`、`nameHash`、
  `frameIndex`、`frameCount: 1`,`fullWeights` 每个 100。**`nameHash` 是 CRC32**
  (`shape0` → 2081338680),与 `.anim` 里 `m_ClipBindingConstant` 的哈希是同一个函数
- **`m_BindPose`**:每根骨骼一个 4×4(e00..e33 行主序),= 骨骼在绑定时刻**世界矩阵的逆**。
  这里的世界矩阵按 Unity 的 TRS 层级算(忽略 Spine 的 shear 与非默认继承),因为 prefab
  里的骨骼节点就是那么摆的;顶点位置本身按 Spine 的真实 setup 算。两者在 shear = 0 时相同
- `m_BoneNameHashes` 可以为空,`m_RootBoneNameHash: 0`。`m_BonesAABB` 每根骨骼一个,
  取它影响的顶点(含所有形变目标增量)在骨骼空间的包围盒;`m_LocalAABB` 也含增量
- `.asset.meta` 是 `NativeFormatImporter`,`mainObjectFileID: 4300000`

### 11.2 prefab 里的 SkinnedMeshRenderer(classID 137)

- 节点放在骨架根下,**变换为单位** —— 网格空间就是骨架空间,绑定矩阵按此算
- `m_Bones` 的顺序必须与 Mesh 的 `m_BindPose` 一致;`m_RootBone` 取第一根
- **`m_Quality: 4`(Bone4)写死**。理由学 Spine:外观不随工程 Quality 档位变。实测真实工程的
  Low/Medium/High 档 `skinWeights` 是 2 根,Auto 会比 SpriteSkin 还差。`--skin-quality auto`
  给所有档位都设成 Unlimited 的工程用(能吃满 >4 根)
- `m_Materials` 指向第 10 节说的带纹理材质;`m_BlendShapeWeights` 全 0;`m_DirtyAABB: 1` 让 Unity 自己算包围盒
- `m_SortingOrder` 与 SpriteRenderer 同一套(slot 下标),两种渲染器之间按它互通(实测,
  渲染到 RenderTexture 读像素);**同 order 时 Sprite 在上**,别打平

### 11.3 `.anim` 里的权重曲线

`m_FloatCurves` 条目,`attribute: blendShape.<名>`,`classID: 137`。每个形变目标一条:
相邻两帧处 0、本帧处 100,Spine 那一段的曲线搬到权重上(段 k→k+1 的进度 y 映射成
目标 k 的 100(1−y) 和目标 k+1 的 100y;3.8 的归一化控制点先按第 5 节换成绝对值)。
第一帧之前 Spine 没有形变,所以 0 处补 0 并阶梯过去(与骨骼曲线的 `withSetup` 同理)。
没有偏移的「零帧」不成为目标,只贡献相邻目标权重归零的时刻。

### 11.4 ⚠️ 增量怎么算:按关键帧时刻的姿势反解,不要抄 Spine 的逐影响偏移

Spine 加权网格的 deform 偏移是**每个影响一份、在各自骨骼的局部空间**里(实测 338/458 条
时间轴的下标范围超过顶点数×2,只能这么解释)。直觉是「把 dᵢ 换到网格空间取平均」——
**不行**:同一顶点各影响的偏移换到世界空间后并不一致,setup 姿势下 21.8% 的(顶点×帧)
分歧 > 0.5px,关键帧时刻的姿势下仍有 12%。多半是美术在某个姿势下拖了顶点、之后又改了骨骼。

正确做法:Unity 在姿势 P 下作用在增量 δ 上的矩阵是 `M(P) = Σ w'ᵢ Bᵢ(P) Bᵢ(S)⁻¹`
(w' 是 Unity 实际用的前 4 根归一权重,B 是骨骼世界矩阵的线性部分),Spine 在同一时刻的
世界偏移是 `Δ = Σ wᵢ Bᵢ(P) dᵢ`。令 **`M(Pₖ)·δ = Δₖ`**,关键帧时刻就严格一致(实测 2 个
骨架、上万个顶点×帧 < 0.5px)。关键帧之间两边各自 lerp,分歧导出时算出来,> 0.5px 报
approximated —— MC2 的 458 条里 431 条 < 0.5px,最大 20px。

不加权网格简单得多:`δ = B(S)·d`(线性部分),任何姿势下都精确。

### 11.5 ⚠️ 增量是「加完再蒙皮」

实测(`AnimatorGoProbe.cs` Q3):骨骼转 90° 后增量跟着转,「加完再蒙皮」假设误差 0,
「蒙皮后再加」假设误差 1.41。与 Spine 同序,所以上面的公式成立。权重线性,50 = 半个增量。

### 11.6 已知代价

- **slot 颜色动画**在这些网格上没有对应属性(SkinnedMeshRenderer 没有 `m_Color`),
  静态颜色烘进顶点色,动画部分报 loss
- 这些网格在 Sprite Editor 里不能再刷权重;骨骼和形变权重曲线在 Animation 窗口里照常能改
- deform 打在 `path` 上(路径约束用)不参与渲染,报 info 跳过 —— MC2 的 `wave` 有这种

### 11.7 自检

`AnimatorGoVerify.cs` 的 `CheckSkinnedMeshes`:Mesh 在不在、骨骼数 = 绑定矩阵数、材质带纹理、
形变目标数;`CheckClips` 对 `blendShape.<名>` 曲线额外查 Mesh 里真有这个目标 ——
没有的话 Unity 同样一声不响。6 个样本(MX2_cat、customer_1、blackrichwoman、wave、17701、13901)
共 59 个 SkinnedMeshRenderer、373 个形变目标,batchmode 全部通过。

## 12. 逐帧绘制顺序 → `m_SortingOrder` 阶梯曲线

Spine 的 drawOrder 一帧只存「哪些 slot 挪了几位」(`offsets: [{slot, offset}]`,按 slot 升序),
完整顺序按它的规则铺:挪了的放到 `原下标 + offset`,没挪的按原顺序依次填空位(从后往前填)。
实现在 `src/spine-eval/drawOrder.ts`。空 offsets = 回到 setup 顺序。

层号就是 `sortingOrder`(静态时 = slot 下标,同一套刻度)。曲线怎么写:

- **只给在任何动画里挪过位的 slot 写**,但要在**每条**动画里都写 —— 没挪的动画写一个 setup 值。
  否则 A 动画把手提到脸前,切到没有 drawOrder 的 B 动画时手留在前面。Spine 换动画时会把
  上一条动画动过的属性还原回 setup,这样做才和它一致,也不依赖 Animator 的 Write Defaults
- 阶梯曲线,0 处一定有键(setup 顺序),每个 drawOrder 帧一个键
- SpriteRenderer(classID 212)和 SkinnedMeshRenderer(classID 137)的 `m_SortingOrder` 都能被
  曲线驱动(`AnimatorGoProbe.cs` 实测);float → int 的取整是四舍五入,阶梯整数不受影响
- 同一 slot 下的多个 attachment 节点共用同一条曲线

实测 blackrichwoman:6 条动画把右手、右前臂提 28 层到脸前(摸脸),左前臂左手提 10 层。
静态顺序下 `angry` 的手表整个消失在左臂后面 —— setup 姿势手臂不交叉所以场景里看不出,
一播就错。这是用户第一个撞上的播放问题。

## 13. 皮肤:两个显隐开关 + Animator 皮肤层

Spine 的皮肤是运行时查表:换图时间轴写的是**键名**,播放时拿键名先查当前皮肤、查不到再查默认皮肤。
Unity 没有这张表。我们把表拆掉了(一个 attachment 一个物体),于是一个挂图节点要同时满足两个条件才该显示:

1. 换图时间轴说这个键名此刻是亮的(动画驱动,逐帧变)
2. 这个节点属于当前皮肤(运行时状态,切皮肤才变)

Unity 的渲染器恰好自带两个互相独立的开关,渲染要两个都开(AND,实测):

| 开关 | 谁控制 | 对应 Spine |
|---|---|---|
| 渲染器 `m_Enabled`(SpriteRenderer classID 212 / SkinnedMeshRenderer 137) | 基础层:换图时间轴的阶梯曲线;setup pose 的初始值也写在这 | 时间轴按键名亮灭 |
| GameObject `m_IsActive`(classID 1) | 皮肤层 `Skin`(override,权重 1):每套皮肤一个 state,state 里是一条静态 clip `<骨架>@skin@<皮肤>` | `SetSkin()` |

**切皮肤 = `animator.Play("皮肤名", 1)`。** 零脚本。

### 13.1 节点与 clip 怎么写

- 所有皮肤的 attachment 都建节点。具名皮肤的节点名带 `@皮肤名`(`WestCowboy_scarf@Christmas_day`),
  免得同一 slot 同键名的三条围巾撞名;默认皮肤的节点名不变
- 换图时间轴对某个键名的曲线,打在**所有**同 slot 同键名的节点上(三条围巾共用一条曲线),
  谁真的显示由皮肤层决定
- 皮肤 clip 里每个挂图节点一条 `m_IsActive` 常量曲线:属于该皮肤的 1;默认皮肤的件,被该皮肤里
  同 slot 同键名的一件盖住就 0(Spine「先查皮肤再查默认」),否则 1;其余皮肤的 0。
  两个键(0 与 1/60 秒)撑一点长度
- prefab 里的初始值:`m_IsActive` = 属于初始皮肤(`--skin`,默认是默认皮肤;默认皮肤空着就取第一套
  具名皮肤);渲染器 `m_Enabled` = 键名等于 slot 的 `attachmentName`
- controller 第 1 层 `Skin`:`m_BlendingMode: 0`(override)、`m_DefaultWeight: 1`,默认 state = 初始皮肤。
  单皮肤骨架没有这一层,也没有皮肤 clip

### 13.2 实测(`tools/unity/AnimatorGoProbeSkin.cs`,Unity 6000.3,渲染到 RenderTexture 读像素)

- SpriteRenderer / SkinnedMeshRenderer 的 `m_Enabled` 都能被曲线驱动,Animation 窗口里选得到
- 皮肤层切 state 立即生效、切回也对,不干扰基础层的换图节奏
- 被皮肤层灭掉的物体,基础层对它渲染器 `m_Enabled` 的曲线在重新点亮后仍然生效
- 两个开关确实是 AND:皮肤开着但渲染器关着就是不显示

⚠️ 探针里踩的坑:**别用 Transform 的单分量曲线**(如 `m_LocalPosition.z`)撑 clip 长度 ——
Animator 会把没写的分量当 0 写进去,把物体挪到原点。

### 13.3 贴图按皮肤拆

学 Spine「每皮肤一页」的打包方式:默认皮肤的图烘成 `<骨架>.png`,每套具名皮肤的图各烘成
`<骨架>@skin@<皮肤>.png`(超过最大尺寸再分页加 `_i`)。两套具名皮肤共用的图归默认那张 ——
它反正总在。每张贴图各有自己的 `.meta`(sprite 表)和材质(给 SkinnedMeshRenderer 用)。

⚠️ **这不会让运行时少加载贴图。** prefab 里所有皮肤的节点都硬引用着自己的 sprite,实例化时
Unity 会把每张贴图都加载进来 —— 灭着的 GameObject 也一样。要做到「只加载当前皮肤的贴图」,
得把换装件的 sprite 换成软引用(Addressables)、切皮肤时再赋值,那是游戏侧的脚本,不在这条零脚本
路线里。拆贴图的收益是归档清楚、按皮肤打包资源方便、本体那张不会被十套换装撑爆。

## 14. 待确认

- `.anim` 里驱动 `SpriteResolver` 的曲线具体形态(尚无样本)。
  目前换 attachment 走的是**一个 attachment 一个物体 + `m_IsActive` 阶梯曲线**,
  不需要 SpriteLibrary,顺带解决了「网格换图 PPtr 表达不了」的问题
- `SpriteLibraryAsset` 的 `.asset` 序列化字段
- 多 sprite 共享骨架时,`SkeletonAsset` 与各 sprite `bones` 的配合方式
