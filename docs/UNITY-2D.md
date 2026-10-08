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
| linkedmesh(共享网格) | 导出前展开成独立网格,继承的 deform 同一条时间轴驱动多个网格 | ✅ 可映射,见第 14 节 |
| 4.1 序列帧(sequence) | 每帧一个节点,m_Enabled =「attachment 亮着」且「是这一帧」的阶梯曲线 | ✅ 可映射,见第 15 节 |
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

跨度 < 64px 不看缩放 —— 小图的比值被整数裁剪框量化主导(11px 差 1px 就是 9%)。这不是漏洞:小图真有
缩放差时残差判据会露出来(blackrichwoman 缩放差 50% 的 `Valentines_flower` 残差 10~14px,早已分流),
全盘留在 SpriteSkin 的小网格与姿势无关的误差上界最大 1.4px。数据见 PROGRESS.md。

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
- **`m_BindPose`**:每个骨骼槽位一个 4×4(e00..e33 行主序),= 骨骼在绑定时刻**世界矩阵的逆**。
  ⚠️ **同一根骨骼可以占多个槽位、各带一个 bindpose**(m_Bones 里重复出现,实测 BakeMesh 误差 0),见 11.6。
  这里的世界矩阵按 Unity 的 TRS 层级算(忽略 Spine 的 shear 与非默认继承),因为 prefab
  里的骨骼节点就是那么摆的;顶点位置本身按 Spine 的真实 setup 算。两者在 shear = 0 时相同
- `m_BoneNameHashes` 可以为空,`m_RootBoneNameHash: 0`。`m_BonesAABB` 每根骨骼一个,
  取它影响的顶点(含所有形变目标增量)在骨骼空间的包围盒;`m_LocalAABB` 也含增量
- `.asset.meta` 是 `NativeFormatImporter`,`mainObjectFileID: 4300000`

### 11.2 prefab 里的 SkinnedMeshRenderer(classID 137)

- 节点放在骨架根下,**变换为单位** —— 网格空间就是骨架空间,绑定矩阵按此算
- `m_Bones` 的顺序必须与 Mesh 的 `m_BindPose` 一致;`m_RootBone` 取第一根
- **`m_Quality: 4`(Bone4)**。`--skin-quality auto` 给所有档位都设成 Unlimited 的工程用(能吃满 >4 根)。
  ⚠️ **渲染器的 `m_Quality` 只是请求,工程 Quality 的 Skin Weights 是上限**(2026-10-08 实测,BakeMesh):
  档位设成 2 根,Bone4 的渲染器照样只用 2 根;batchmode 默认档是 1 根,这些网格摊成刚性。
  之前这里写「外观不随档位变」是错的。真实工程的 Low/Medium/High 档是 2 根,所以**工程各档要设成 Four Bones**。
  导出时从输出目录往上找 `ProjectSettings/QualitySettings.asset`(`src/unity/qualitySettings.ts`),有档位会截到
  这些网格就报 approximated,列出是哪几档;不在工程里就提示一句。
  **SpriteSkin 不受这个设置影响**:2D Animation 的蒙皮是包自己做的(源码里没碰 QualitySettings),
  `female_lead` 只留 SpriteSkin 部件、1 根和 4 根各渲 8 帧,逐字节相同(工程 GPU Skinning 关着,走的是 CPU 路径)
- `m_Materials` 指向第 10 节说的带纹理材质;`m_BlendShapeWeights` 全 0;`m_DirtyAABB: 1` 让 Unity 自己算包围盒
- `m_SortingOrder` 与 SpriteRenderer 同一套(slot 下标),两种渲染器之间按它互通(实测,
  渲染到 RenderTexture 读像素);**同 order 时 Sprite 在上**,别打平

### 11.3 `.anim` 里的权重曲线

`m_FloatCurves` 条目,`attribute: blendShape.<名>`,`classID: 137`。每个形变目标一条:
相邻两帧处 0、本帧处 100,Spine 那一段的曲线搬到权重上(段 k→k+1 的进度 y 映射成
目标 k 的 100(1−y) 和目标 k+1 的 100y;3.8 的归一化控制点先按第 5 节换成绝对值)。
第一帧之前 Spine 没有形变,所以 0 处补 0 并阶梯过去(与骨骼曲线的 `withSetup` 同理)。
没有偏移的「零帧」不成为目标,只贡献相邻目标权重归零的时刻。

⚠️ **同一 attachment 的 deform 时间轴可以有两条**(3.8 常见,`.skel` 里同一组出现两次)。Spine 按顺序套用,
后一条整条盖掉前一条;而 **Blend Shape 是叠加的** —— 两条都转的话形变翻倍(实测 MC2 的 Juicer:`work`
里 5 个网格各有 `work_0` + `work_0_2` 同时满权重)。所以每条动画先按属性去重、只取最后一条
(`spine-format/duplicateTimelines.ts`,换图 / 颜色同理),前后内容不同时报 approximated。

⚠️ **一条曲线里不能有两个写出来时刻相同的键**(`.anim` 的时刻写 7 位有效数字)。Unity 不报错,两键之间的切线
除以近乎 0 的时长,实测权重曲线冲到 −3×10¹⁸,网格整个飞走。Spine 的关键帧时刻是 float32,和 30 fps 的采样网格
会差 1e-6 秒级 —— 逐帧修正(11.6)合并采样时刻时 1e-5 秒以内只留**后一个**(留前一个会把阶梯的跳变吃掉,实测 15 像素)。
`export.test.ts` 查所有 `.anim` 曲线没有重复时刻。

### 11.4 ⚠️ 增量怎么算:按关键帧时刻的姿势反解,不要抄 Spine 的逐影响偏移

Spine 加权网格的 deform 偏移是**每个影响一份、在各自骨骼的局部空间**里(实测 338/458 条
时间轴的下标范围超过顶点数×2,只能这么解释)。直觉是「把 dᵢ 换到网格空间取平均」——
**不行**:同一顶点各影响的偏移换到世界空间后并不一致,setup 姿势下 21.8% 的(顶点×帧)
分歧 > 0.5px,关键帧时刻的姿势下仍有 12%。多半是美术在某个姿势下拖了顶点、之后又改了骨骼。

正确做法:Unity 在姿势 P 下作用在增量 δ 上的矩阵是 `M(P) = Σ w'ᵢ Bᵢ(P) Bᵢ(S)⁻¹`
(w' 是 Unity 实际用的前 4 根归一权重,B 是骨骼世界矩阵的线性部分),Spine 在同一时刻的
世界偏移是 `Δ = Σ wᵢ Bᵢ(P) dᵢ`。令 **`M(Pₖ)·δ = Δₖ`**,关键帧时刻就严格一致(实测 2 个
骨架、上万个顶点×帧 < 0.5px)。关键帧之间两边各自 lerp,分歧导出时算出来 —— MC2 的 458 条里 431 条 < 0.5px,
最大 20px。> 0.5px 的那条动画改走逐帧修正(11.6),不再只报 approximated。

不加权网格简单得多:`δ = B(S)·d`(线性部分),任何姿势下都精确。

### 11.5 ⚠️ 增量是「加完再蒙皮」

实测(`AnimatorGoProbe.cs` Q3):骨骼转 90° 后增量跟着转,「加完再蒙皮」假设误差 0,
「蒙皮后再加」假设误差 1.41。与 Spine 同序,所以上面的公式成立。权重线性,50 = 半个增量。

### 11.6 ⚠️ 绑完又改过顶点的网格:同一根骨骼占多个槽位

Spine 加权网格**每个影响各存一份骨骼局部坐标**。美术绑完又在别的姿势下拖过顶点的话,同一顶点各影响在 setup 下算出的
位置不一致,没有哪一组「每根骨骼一个」的绑定矩阵能同时解释它们 —— 之前一律写 setup 的逆:setup 精确、一动就偏
(`female_lead` 的 `nvzhu_t_gb1` 77 像素、`Oldwoman_sit` 的 `B_body` 44 像素),而且没报。

**解法:Mesh 的 bindpose 是按「骨骼槽位」存的,同一根骨骼可以在 `m_Bones` 里出现多次、各带一个 bindpose**
(2026-10-08 实测 Unity 6000.3:一根骨骼占三个槽位、各配不同的平移 / 旋转缩放,三个姿势下 BakeMesh 与手算误差 0)。
所以每个影响都能原样表达:槽位的绑定矩阵 K 满足 K·局部坐标 = 顶点,**任何姿势下都与 Spine 逐影响相同**,不用逐帧数据,
在 Unity 里改骨骼动画也照样对。实现在 `src/spine-convert/skinSlots.ts`(Godot 导出共用,那边一个槽位是一根辅助子骨骼):

1. 每根骨骼一个「基准」槽位。顶点和基准两种候选,取多出来的槽位少的:
   - **setup**:顶点 = 各影响在 setup 下的加权平均,基准 = 骨骼的 setup 矩阵。setup 下绑的网格一个不多,产物与以前逐字节相同
   - **按贴图拟合**:每根骨骼拟合「局部坐标 → 图上位置(UV)」的仿射,顶点 = 图上位置(整体按相似变换摆到 setup 附近)。
     MX2_cat 的「第二套」网格是在别的姿势下照着图绑的,setup 下对不齐,按图拟合一个不多
2. 对不上基准的影响(差 > 0.05 像素)另开槽位:K = 平移(残差)· 基准,残差相近的共用一个。
   Unity 骨骼没有 shear,所以基准写 Unity 的 setup 矩阵、残差按 Spine 的算 —— setup 姿势下与 Spine 重合

**每顶点超过 4 根骨骼(Bone4 截断)**也借这个解:留下的 4 个影响各有自己的槽位,局部坐标可以重新挑。按全部动画的姿势
(含 setup)最小二乘,让 Σ w'ₖ·Bₖ(P)·xₖ 最贴近 Spine;**留哪 4 根也挑**(最多 8 根里的全部组合,取最大误差最小的)——
权重小、但在某些动画里摆得很开的骨骼,丢掉更伤。`female_lead` 的 `nvzhu_st1` 留权重最大的 4 根时 `adjusted_hat` 整段差
9 像素,挑过之后 1.1。全盘 16 个这类网格,截断误差最大从 10.9 降到 1.1 像素。Mesh 里这些顶点只写这 4 根(权重、坐标都是拟合过的)。

**有 deform 的网格**:关键帧之间 Blend Shape 线性插值与 Spine 的差 > 0.5 像素时(11.4),这条动画改走**逐帧修正**
(`correctionShapes`,MC2 的 `nvzhu_t_gb1` 原来 22 像素):每个采样时刻一个形变目标(`<动画>_fix<k>`),权重是「帐篷」——
本时刻 100、相邻时刻 0、之间线性;deform 一起解进去,这条动画的 deform 不再单独转。采样 = 关键帧 + 30 fps + 阶梯键前 1e-4 秒,
再按「帧间线性插值与 Spine 差 > 0.25 像素就在中点加一个」细分,最细 1/480 秒。细分到底还对不上的,是没标成阶梯的瞬间跳变
(同一时刻两个关键帧之类,Female staff 的 `paperB` 在 0.6 秒跳 118 像素)—— 和阶梯帧一样在它前面 1e-4 秒补一个采样,
否则 Unity 会把跳变抹成 1/480 秒长的斜坡。细分完还超 0.5 像素才报 approximated。

⚠️ **走过的弯路**:第一版(同日)照 Godot 的办法(GODOT.md 第 6 节)做的是「两种绑定按实测取小的,还偏就**每条动画逐帧**加修正
Blend Shape」。准是准,但产物膨胀:`female_lead` 从 11 MB 涨到 32 MB(5195 个形变目标),wave 32 MB;而且在 Unity 里改骨骼动画,
修正不会跟着变。改成重复槽位后 15.8 MB(剩下的是 deform 本身),逐帧修正只剩 deform 帧间分歧那几条动画。

实测:

| | 结果 |
|---|---|
| MergeCooking2 535 个骨架 | 全部导出成功。24 个骨架、47 个网格另配了绑定矩阵(共 1297 个槽位,单个网格最多 159 个),另有 23 个只靠按贴图拟合就精确;每顶点超过 4 根骨骼的 17 个网格,拟合后仍超 0.5 像素的 3 个(报 approximated) |
| 按 Unity 的规则求值,30 fps(`export.test.ts`) | 完整权重:最大 0.47 像素(wave,deform 帧间),其余 ≤ 0.04;Bone4:≤ 1.1 像素(截断) |
| 真 Unity BakeMesh(4 根,帧时刻 + 0.1 ms) | `Oldwoman_sit` 44 → **0.006** 像素;`female_lead` 75 → 最大 **2.2** 像素(deform 逐帧修正的两个网格在阶梯时刻,Unity 与参照求值本身就差这么多,修之前也一样),`nvzhu_st1` 1.0 |
| 产物大小(逐帧修正版 → 现在) | `female_lead` 32.2 → 15.8 MB,wave 31.9 → 18.5,`Oldwoman_sit` 2.0 → 0.7,checkerboard_cat 1.2 → 0.3 |

`export.test.ts` 的「绑定姿势不一致的网格」用例:4 个样本(female_lead、Oldwoman_sit、wave、checkerboard_cat)按 Unity 的规则逐帧
(30 fps + 阶梯前 1e-4 秒)读回,与 Spine 比 —— 完整权重 < 1 像素、Bone4 < 1.5 像素;去掉「另开槽位」用例会挂。
读回端(`readUnity.ts` / `unityEval.ts`)本来就按槽位下标取骨骼,重复骨骼不用改。

⚠️ **Unity 运行时按帧率重采样带权切线的曲线**(2026-10-08 实测):编辑器里 `AnimationCurve.Evaluate` 与运行时只在
帧时刻一致,帧之间运行时是按帧采样再插值的;不带权的切线在任何时刻都精确。Spine 的贝塞尔要转成带权切线(第 5 节),
所以帧之间会差几像素,长骨骼链上最明显。修的话是把贝塞尔按帧展开成不带权的密键 —— 精确,但在 Unity 里不好改。
**用户定:不改**(2026-10-08,见 DECISIONS.md)。

### 11.7 已知代价

- **slot 颜色动画**在这些网格上没有对应属性(SkinnedMeshRenderer 没有 `m_Color`),
  静态颜色烘进顶点色,动画部分报 loss
- 这些网格在 Sprite Editor 里不能再刷权重;骨骼和形变权重曲线在 Animation 窗口里照常能改
- deform 打在 `path` 上(路径约束用)不参与渲染,报 info 跳过 —— MC2 的 `wave` 有这种
- deform 帧间分歧走逐帧修正的那几条动画(11.6 末尾),修正形变目标是逐帧烘的:在 Unity 里改那条动画的骨骼,修正不会跟着变

### 11.8 自检

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

### 13.4 带脚本模式(`--skins script`):换装件按需加载

零脚本是默认。要「切到哪套才加载哪套」就得有软引用,软引用就得有代码 —— 这是一个转换选项,
产物依赖**一个**脚本 `AnimatorGoSkins`(源码 `tools/unity/runtime/`,CLI 拷到输出目录下
`AnimatorGoRuntime/` 一次,`.cs.meta` 带固定 GUID `4f1a4e2b9c3d4a5e8b7c6d5e4f3a2b10`,prefab 靠它认组件)。

与零脚本模式的差别只在皮肤:

| | 零脚本 | 带脚本 |
|---|---|---|
| 皮肤怎么切 | Animator 皮肤层 `animator.Play("Pirate", 1)` | 根节点的组件 `GetComponent<AnimatorGoSkins>().SetSkin("Pirate")` |
| 换装件的 sprite / 材质 | 硬引用 | prefab 里留空(`m_Sprite: {fileID: 0}` / `m_Materials: []`),组件里存路径 + GUID + sprite 名 |
| 贴图加载 | 实例化即全部加载 | 切到才加载,切走可卸(接了 `UnloadAsset` 才卸) |
| 皮肤 clip / controller 第二层 | 有 | 没有 |
| 换图时间轴、本体、初始亮灭 | 一样 | 一样 |

组件的数据(`nodes[]`:物体、所属皮肤、`spriteAsset`/`spriteGuid`/`spriteName`、`materialAsset`/`materialGuid`;
`skins[]`:每套皮肤要灭掉的默认皮肤件)由导出器算好写进 prefab,`SetSkin` 只是照表点亮、加载、灭掉。

**加载走委托,对资源系统零假设**(用户定的:打包后走自家的资源系统,编辑器里走 Addressables):

```csharp
// 游戏启动时接一次
AnimatorGoSkins.LoadAsset = (path, sub, type) => MyAssets.Load(path, sub, type);   // sub = sprite 名,贴图/材质为 null
AnimatorGoSkins.UnloadAsset = obj => MyAssets.Release(obj);                         // 可不接
// Addressables 一行:地址默认就是资产路径,子资产写成 路径[名字]
AnimatorGoSkins.LoadAsset = (path, sub, type) =>
    Addressables.LoadAssetAsync<UnityEngine.Object>(sub == null ? path : $"{path}[{sub}]").WaitForCompletion();
```

没接委托时:编辑器里走 `AssetDatabase`(按 GUID 找,文件夹挪了也不怕),预览与 Play 开箱能用;
打包后报一条明确的错。**不在脚本里直接调 Addressables**:asmdef 引用一个没装的包会让整个程序集
编译不出来,而这个脚本要在任何工程里都能进。

`SpriteSkin` 在运行时换 sprite 时会按新 sprite 的绑定矩阵重新校验(`CacheCurrentSprite`,
`autoRebind` 关着就沿用现有骨骼),骨骼顺序与导出时一致,所以直接赋 `sprite` 就行,实测正常。

## 14. linkedmesh(共享网格):导出前展开

Spine 运行时里 linkedmesh 就是「借父网格的顶点、三角形、UV、权重,用自己的图」—— 加载时
`setParentMesh` 把这些拷过来,UV 再按自己的 region 重算。Unity 没有「共享几何」的概念,但也不需要:
**导出前原地展开成普通 mesh**(`src/spine-convert/unity/linkedMesh.ts`),后面的 SpriteSkin /
SkinnedMeshRenderer 分流、Blend Shape 一行都不用改。

| 字段 | 取谁的 |
|---|---|
| `vertexCount` / `uvs` / `triangles` / `vertices` / `hullLength` / `edges` | 父网格 |
| `path`(用哪张图)、`color`、名字、`width` / `height` | linkedmesh 自己 |

UV 直接抄父网格没问题:Spine 的 mesh `uvs` 是**相对未裁剪原图归一化**的,烘焙时按各自的 region 映射。

### 14.1 父网格怎么找

与 Spine 一致:**同一个 slot**,在 linkedmesh 记的那套皮肤里(`skin` 为空 = 默认皮肤)按键名找。

⚠️ **父网格可以在另一套皮肤里** —— MC2 的 `chopping_board` 皮肤 `5` 的件全挂在皮肤 `4` 的网格上,
`Juicer` 皮肤 `6` / `7` 挂在 `5` 上。所以不能默认在同一套皮肤里找。

父链上遇到 linkedmesh 就继续往上追到真正的 mesh;找不到父网格、成环都报 loss,不静默。

### 14.2 继承的 deform

`inheritTimelines`(3.8 叫 `inheritDeform`)为真时,**打在父网格上的 deform 时间轴也驱动它**
(4.x 的 `timelineAttachment`、3.8 的 `applyDeform` 都只认**直接**父网格这一层)。展开后它就是个
普通 mesh,认不出这层关系,所以 `resolveLinkedMeshes` 另外返回一张「谁继承谁」的表:

- 分流时:父网格有 deform,linkedmesh 也走 SkinnedMeshRenderer(报「继承自父网格」)
- 转 deform 时:一条时间轴查出**多个**网格(父网格 + 继承它的 linkedmesh),每个各出一套形变目标与权重曲线

MC2 全量 118 处 linkedmesh(6 个骨架)都是 `inheritTimelines = true`、不带 sequence;
只有 `Female staff` 的 `head_ordinary` 的父网格真有 deform,它是端到端用例的样本。

## 15. 4.1 序列帧(sequence):每帧一个节点

Spine 4.1 的 region / mesh 可以带 `sequence`:一组编号连续的图(`path` + 帧号),由 sequence 时间轴按
`hold / once / loop / pingpong` 及三种倒放切换,每帧停 `delay` 秒。

### 15.1 为什么不用 sprite 曲线(`m_Sprite` PPtr)

Unity 原生的逐帧动画是给 SpriteRenderer 的 `m_Sprite` 打引用曲线。**没用它**,和第 1 节换图的理由一样:
mesh 各帧的顶点、pivot、绑定都跟着图走,换 sprite 换不动网格;SkinnedMeshRenderer 的 UV 在 Mesh 里,
换图得换 Mesh。换物体则什么都能表达,而且沿用的全是已验证的路径(SpriteSkin / SkinnedMeshRenderer /
皮肤层 / 绘制顺序 / 颜色),没有引入「SpriteSkin 在动画里换 sprite 会不会重新绑定」这类新的未知。

### 15.2 节点与曲线

- 每帧一个挂图节点,名字 `slot__键名#帧号`(帧号与图集区域的编号一致,如 `left-wing#03`);具名皮肤照旧带 `@皮肤`
- 初始只有 setup 那一帧的渲染器亮
- 每条碰了该 slot 换图时间轴或该 attachment sequence 时间轴的动画,给每帧节点写一条 `m_Enabled` 阶梯曲线:
  **亮 =「换图时间轴说这个键名亮着」且「sequence 时间轴说现在是这一帧」**。两者都是阶梯,合起来还是阶梯。
  普通换图的曲线跳过这些节点,免得两条曲线打架
- 两条都没碰的动画不写,和普通换图一样靠 Write Defaults 回到 setup

### 15.3 求值细节(`src/spine-eval/sequence.ts`)

- 第一个关键帧之前、以及没有时间轴时:setup 帧
- 非 hold 模式从关键帧的 index 起,`index + (t − time) / delay + 0.0001` 取整。那个 0.0001 让换帧**比
  time + j·delay 早 0.0001 个 delay**,阶梯的步点跟着它走 —— 否则正好采在步点上时和 Spine 差一帧
- 最后一个关键帧之后一直播到动画结束(动画时长 = 所有时间轴最后一个关键帧的时刻);末尾补一个键把剪辑撑到这个长度
- 动画时长为 0 时(Spine 里时间照走、序列帧一直播),按一个周期写出、让剪辑循环,报 info

### 15.4 代价与验证

- 节点数 × 帧数(icon_clock:9 个 attachment × 14 帧 = 126 个渲染器),同一时刻只亮一个
- 各帧原图的宽高比与网格不一致时,那些帧的网格按「绑定姿势非刚性」走 SkinnedMeshRenderer(boat_1 的 64 帧)。
  这是精确表达,不是近似
- 本地样本端到端用例(`export.test.ts`,4 个样本):读回 prefab 与 `.anim`,照 Unity 的规则算每个采样时刻亮哪一帧,
  与 Spine 逐点相等
- Unity 6000.3 batchmode(2026-09-23,6 个样本:马车轮 / 火车轮倒放 / 时钟光效 / 船 / 火焰 / 官方 dragon):自检全过;
  用 Animator 状态机渲染并读出每个采样时刻亮着的渲染器,**509 个采样里 507 个与 Spine 相等**。剩下 2 个正好采在
  换图关键帧的那一刻 —— `.anim` 的时间写 7 位小数,0.53333336 写成了 0.5333334(晚 4×10⁻⁸ 秒),肉眼不可见。
  ⚠️ 比对时采样时刻要按 C# 的 float 算(`clip.length * i / steps`),用 double 算会在关键帧边界上多出几个假的不一致

## 16. 读回:Unity 角色 → Spine / Godot(`src/spine-convert/unity-import/`)

用途:角色导到 Unity、**在 Unity 里改过之后**再转到 Godot(或 Spine JSON);也读别人在 Unity 里做的 2D 角色。
这不是往返编辑 —— 读回来的是 Unity 那一份,Spine 有而 Unity 没有的东西(约束、shear、两色染色……)导出时已经报过丢失,
读回来也不会有。

输入是一个目录:**正好一个 `.prefab`**,加上 `.anim`、controller(只用来定动画顺序)、贴图 / Mesh / 材质及其 `.meta`。
根物体是角色本身,它自己的变换是摆在场景里的位置,不算骨骼。`--ppu` 要与导出时一致。

输出 Spine 4.1 JSON,再过 `fromJson` 进中转模型 —— 字符串表、写法细节交给已经拿真实文件对过的读取器,顺带就有了 Unity → Spine。

### 16.0 结构:按 Unity 的规则读,我们的命名只是锦上添花

| Unity | Spine | 说明 |
|---|---|---|
| 不带渲染器的物体 | 骨骼 | |
| 带渲染器的物体,**下面挂着东西 / 被变换曲线驱动 / 被蒙皮引用** | 骨骼 + 挂在自己身上的 slot | ⚠️ 别人的角色常把图直接挂在骨骼上。第一版只把不带渲染器的当骨骼,挂在图下面的子骨骼找不到父骨骼,**静默**变成第二根根骨骼、位置全错 |
| 其余带 SpriteRenderer / SkinnedMeshRenderer 的物体 | 挂在父骨骼上的 slot | |
| 物体名 `<slot>[__键名][#帧][@皮肤]`(我们导出的) | 几个物体合成一个 slot、不同皮肤 | 合不起来的组 —— setup 时同时亮着两个以上,或(SkinnedMeshRenderer / SpriteSkin 之外)挂在不同骨骼上 —— 说明名字不是这个约定(别人的 `arm__L`),组里的物体各自成 slot。重名的(左右手都叫 Hand)加后缀 |
| 画不画 = 渲染器 `m_Enabled` 且自己和各级父物体 `m_IsActive` | 换图时间轴 | `m_IsActive` 曲线(classID 1)打在骨骼上,下面挂的图一起灭。我们导出的多皮肤角色里,挂图物体**自己的** `m_IsActive` 是皮肤那一维(具名皮肤的物体,和被初始皮肤同 slot 同键名盖住的默认皮肤物体),交给 Spine 的皮肤,不当显隐读 |
| `m_Sprite` 曲线(引用曲线,阶梯) | 每张图一个 attachment(按图名),换图时间轴 | 逐帧动画的标准写法。Single 模式的贴图(引用 fileID 固定 21300000,`.meta` 里没有顶点)用整个矩形 —— Unity 的紧凑网格只是裁掉透明像素,画出来一样 |
| 绘制顺序:Sorting Group → Sorting Layer → Order in Layer → z(远的先画)→ 层级先后 | slot 顺序 + drawOrder 时间轴 | 每层一组 `[层, 序, −z, 层级先后]`,由外到内依次比。`m_SortingOrder` 曲线(渲染器 212 / 137、Sorting Group 210)→ drawOrder |
| prefab 里亮着的那套具名皮肤 | `initialSkin` | `pnpm from-unity --to godot` 不给 `--skin` 就用它 |

sprite 引用的三种写法(真实文件里都见过,`src/unity/spriteMeta.ts`):Single 模式固定 21300000;Multiple 2019.3 之后是 sprite 的
`internalID`;更早是 21300000、21300002…… 经 `fileIDToRecycleName` 映射到 sprite 名。轴心:`alignment` 不是 9(Custom)时按预设算。

### 16.1 几何:全部转成 Spine 的 mesh,都是精确的

| Unity | Spine |
|---|---|
| SpriteRenderer(无 SpriteSkin) | 不加权 mesh:`骨骼局部 = 骨骼世界⁻¹ · 节点世界 · (顶点 − pivot)/ppu` |
| SpriteRenderer + SpriteSkin | 加权 mesh:sprite 骨骼按 Unity 的规则算绑定(**根骨骼减 pivot,子骨骼不减**;⚠️ 骨骼不一定父在前,按 parentId 递归),`lᵢ = bindᵢ⁻¹ · v`。SpriteSkin 节点自己的变换不参与(`SpriteSkinUtility.Deform` 先乘它的 worldToLocal、渲染再乘回,抵消) |
| SkinnedMeshRenderer | 加权 mesh:`lᵢ = bindposeᵢ · v` |

region 也读成四顶点 mesh。图集每个 sprite 一个区域(Unity 的矩形原点在左下,换成左上);SkinnedMeshRenderer 用整页做区域。

### 16.2 曲线:Hermite → 贝塞尔是精确的

- Unity 的一段 Hermite(含加权切线)本来就是一条三次贝塞尔:`cx1 = t₀ + w_out·Δt`,`cy1 = v₀ + outSlope·(cx1 − t₀)`,
  另一端对称;不加权时 w = 1/3。切线为 Infinity 就是阶梯
- Spine 4.x 一帧的几个分量(x / y、r / g / b / a)**共用一种曲线类型**,各有各的控制点;Unity 每个分量的关键帧时刻可以不同 →
  取并集,在新时刻用 de Casteljau 精确切开
- 全是直线 → 不写 curve;全是阶梯 → `stepped`;否则贝塞尔,直线分量写成弦的三等分点(仍精确);
  **只有阶梯与非阶梯混在同一帧**才近似,报 approximated
- ⚠️ **时间要吸附到 `m_SampleRate` 的帧格**:`.anim` 的时间只存 7 位有效数字(31/30 写成 1.0333334)。不吸附的话,
  不同曲线上「同一帧」差 1e-7 秒,对不上帧,阶梯跳变也会早晚一点
- **第一个键不在 0 秒**(在 Unity 里删了 0 秒那个键):Unity 在第一个键之前取它的值,Spine 取 setup —— 0 秒补一个同值的键
- **clip 比最后一个键长**(`m_StopTime`;逐帧动画最后一帧要停 1/12 秒):Spine 的时长 = 最后一个键,会把最后一帧吃掉、
  循环变快 —— 末尾补一个不改变任何东西的 drawOrder 帧把时长撑回来

### 16.3 Blend Shape → deform

每一刻 `δ = Σ (w/100)·Δ`,换成逐影响偏移 `dᵢ = lin(bindposeᵢ)·δ` —— Unity 是「加完再蒙皮」(11.4),任何姿势下都精确。
关键帧取所有目标关键帧时刻的并集。段内:导出时的写法是「相邻两个目标此消彼长、共用一条进度曲线」,Spine 的一段就是那条曲线,
精确;认不出这种写法(在 Unity 里改过权重曲线)就按 30 fps 采样成直线,报 approximated。

### 16.4 会报出来的

| 情况 | 级别 |
|---|---|
| prefab 里嵌套了别的 prefab 实例(没展开) | loss |
| 四元数旋转曲线 `m_RotationCurves`(动画窗口默认的「Euler Angles (Quaternion)」插值):角度 = 2·atan2(z, w) 不是三次曲线,按 clip 的帧率采样成折线,实测最大偏差 | approximated(偏差 > 0.01° 才报) |
| 根物体自己的变换 / 显隐动画(根物体的位置是摆在场景里的位置) | loss |
| `m_Sprite` 以外的引用曲线(SpriteResolver 换装等) | loss |
| 曲线指向的物体不存在,或属性不认识(`m_FlipX` 等) | loss |
| 引用的贴图 / sprite / Mesh 不在目录里 | loss |
| 绕 x / y 的旋转(只取绕 z 的部分) | approximated |
| z 坐标的动画(只影响同层同序谁先画,没转) | approximated |
| 同一时刻同一 slot 亮着几个挂图节点(Spine 一个 slot 只挂一个) | approximated |
| 几套具名皮肤的挂图物体同时亮着(取第一套当初始皮肤) | approximated |

**还读不了的**(都会在上表里报出来,不静默):SpriteLibrary + SpriteResolver 换装(`m_SpriteHash` 曲线);Unity 2D IK
(IK 目标通常在场景里,不在 prefab 里);`.anim` 里用 `m_Sprite` 引用 PSD Importer 角色里、名字表里没有的 sprite(见 16.6)。
Sorting Layer 的先后取渲染器里缓存的 `m_SortingLayer` 值 —— 真正的顺序在工程的 TagManager 里,不在角色目录里。

### 16.5 ⚠️ 验收的参照物是 Unity 的规则,不是原 Spine

第一版拿原 Spine 当标准答案,测出来的全是**导出器**的近似(shear、贝塞尔退化、Blend Shape 帧间分歧、>4 根骨骼),
读取器自己对不对反而看不出。改成 `unityEval.ts`:**独立**按 Unity 的规则求值(Hermite / 加权切线直接求值、正向蒙皮、
Blend Shape 加完再蒙皮),与读回来的 Spine 在同一时刻逐点比 —— setup、每条动画的关键帧、相邻关键帧的四分点和中点,0.05 像素;
slot 颜色 1/255。原 Spine 只做 setup 粗检,容差按导出自己的分流判据(第 11 节)。

除了顶点,还比**画了哪些、谁压着谁**:Spine 按 slot 挂的 attachment(当前皮肤 → 默认皮肤)和 drawOrder 铺出来,
换成 Unity 那边的(物体, 图),与 Unity 按 `m_Enabled` / `m_IsActive` / `m_Sprite` / 排序规则算出的序列相等。

用例:

| 组 | 内容 |
|---|---|
| 我们导出的 7 个样本 | 3.8 / 4.1、加权 deform、全靠 deform、linkedmesh、6 套皮肤、100 个 region 换图 |
| 在 Unity 里改过 | 改关键帧值、插一个 Unity 默认切线的新关键帧、挪 prefab 里骨骼的位置 |
| 别人的角色常见的写法(在 MX2_cat 上改) | 给挂图物体打旋转关键帧、把骨骼拖到挂图物体下面、`m_IsActive` 曲线关掉一根骨骼、prefab 里关掉一个 GameObject、`m_Sprite` 换图、删掉 0 秒的键、clip 比最后一个键长、改 Order in Layer、加 Sorting Group,以及全部一起改 |
| 真实的别人的角色 | 第三方插件 Easy Performant Outline 自带的 2D 演示角色:11 条动画全是 `m_Sprite` 逐帧换图,85 张 Single 模式贴图。另转成 Godot 场景,Godot 4.7 里自检通过、渲染逐帧正确 |

这些用例**故意把读取器改坏过**(不让挂图物体变骨骼、不补 0 秒的键、不看 `m_IsActive`、不看 `m_Sprite`、不撑时长),
每一处都有用例变红 —— 不是空转的绿。

⚠️ 排序里 Sorting Group / Sorting Layer / z 三条是照 Unity 文档写的,读取器和参照物用的是同一套理解,**没有在 Unity 里实测**
(样本里没有用到它们的角色)。显示规则(`m_Enabled` × 各级 `m_IsActive`)和 `m_Sprite` 逐帧换图有真实角色兜着。

### 16.6 PSD Importer 的角色(`.psb` / `.psd`)

Unity 官方 2D Animation 示例、很多正经做的 2D 角色都是这种:美术在 Photoshop 里每个部件一层,存 `.psb` 拖进 Unity,
2D PSD Importer 导入时**在内存里**拼大图、切 sprite、生成角色 prefab。磁盘上只有 Photoshop 文件和 `.meta`。

`expandPsd.ts` 把它展开成等价的普通 Unity 文件(prefab + 大图 + 大图的 `.meta`),交给读取器 —— 之后一切照旧。
规则照 PSD Importer 12.x 的源码(`PSDImporter.OnProducePrefab`、`ExtractLayerTask`,2D Common 的 `ImagePacker`):

| 东西 | 从哪来 |
|---|---|
| 骨骼、网格、权重、sprite 的 rect / pivot | `.meta` 的 `layeredSpriteImportData`(老 `.meta` 在 `rigSpriteImportData` / `mosaicSpriteImportData`) |
| 部件用哪几根骨骼 | `characterData.parts[].bones` —— ⚠️ int 数组在 YAML 里是**小端 uint32 的十六进制串**(和 `indices` 一样),按列表读就是空的 |
| 共享骨架(Skeleton Sharing,引用别的 `.psb` 的骨架) | 用 `sharedRigCharacterData`,不是 `characterData`(PSDImporter.characterData) |
| 物体 | 根 `<贴图名>_GO`;每个导入的图层一个物体(图层顺序);再挂骨骼(父骨骼先建)。**图层物体和骨骼共用一个重名表**,重名加 `_1`(Knight 的骨骼 `neck` 与同名图层撞了,Unity 里叫 `neck_1`,`.anim` 也这么写) |
| 位置 | 图层物体 =(spritePosition + pivot)/ ppu − 文档轴心;根骨骼 = 骨骼位置 / ppu − 文档轴心 |
| Order in Layer | 图层总数 − 图层序号(`psdLayers` 的顺序,含没导入的图层和图层组) |
| SpriteSkin | 部件有骨骼就挂,根骨骼是根物体,骨骼顺序 = parts[].bones |
| 像素 | Photoshop 文件只用来取像素:图层裁到画布、翻成左下原点,透明像素清零;大图 (X, Y) = 图层缓冲 (X − uvTransform.x, Y − uvTransform.y),摆回 `.meta` 里 rect 的位置 —— sprite 的 rect 原样可用 |
| sprite 的 fileID | `internalIDToNameTable` 里类型 213 的那些。名字表里没有的,Unity 按标识串哈希,算法不公开 —— 这里自己编号,`.anim` 用 `m_Sprite` 引用它会报找不到 |

Photoshop 文件自己读(`src/psd/readPsd.ts`):8 位 RGB / 灰度,原始 / RLE / ZIP 压缩;PSB 只是几处长度字段变 8 字节。
**Unity 不套用图层不透明度和混合模式**,这里也不套。图层蒙版样本里没有,现在没套用。

**验收:标准答案是 Unity 自己导入的结果。** `tools/unity/AnimatorGoDumpPsd.cs` 在 Unity 里导入后导出:生成的物体(路径、局部 TRS、
排序、蒙皮骨骼)、每个 sprite(rect、顶点、绑定矩阵、rect 内像素指纹)、每条动画 SampleAnimation 后各物体的世界矩阵 ——
存在 `res/unity-psd/`。官方 11 个样本(Fei、Knight / Witch / Wolf / Skeleton 共享骨架、dialog、Boris、Plunkah……):

- 物体层级、名字、位置、旋转、排序、蒙皮骨骼全部一致(1e-6 级)
- sprite 顶点一致;贴图不压缩时可见像素**逐字节相同**(137 个 sprite)。透明像素的 RGB 不比 —— Alpha Is Transparency 会往里渗颜色
- 动画取样的世界矩阵一致(1e-5 级),**包括四元数旋转曲线**(Plunkah)
- 读成 Spine 后与 Unity 的规则逐点一致(顶点 + 画了哪些、先后)
- 超过 Max Size 的大图 Unity 会连 rect / ppu 一起缩小(Attachment Points 那个 Fei 是 2048×4096 → 一半),按 Unity 单位算的几何不变,这里保留原分辨率

导出脚本要 Play 前先把样本的 `.meta` 改成不压缩、可读(`textureCompression: 0`、`isReadable: 1`)才能比像素;
`SampleAnimation` 不复原没碰的属性,**每条动画要一个新实例**,不然上一条的姿势会混进来 —— 两条都是踩过的。

## 17. 待确认

- `.anim` 里驱动 `SpriteResolver` 的曲线具体形态(尚无样本)。
  目前换 attachment 走的是**一个 attachment 一个物体 + `m_IsActive` 阶梯曲线**,
  不需要 SpriteLibrary,顺带解决了「网格换图 PPtr 表达不了」的问题
- `SpriteLibraryAsset` 的 `.asset` 序列化字段
- 多 sprite 共享骨架时,`SkeletonAsset` 与各 sprite `bones` 的配合方式
