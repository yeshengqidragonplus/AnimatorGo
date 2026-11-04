# Spine → Cocos Creator 3.8

中转模型(Spine 的数据模型)→ Cocos Creator 3.8 的**原生节点 + `cc.Animation` + `.anim`**。目标和 Unity / Godot 导出一样:
不装任何运行时(Spine 组件也不用),拖进工程就能播,骨骼和动画在 Cocos 的动画编辑器里能改。

```bash
pnpm cocos <骨架文件或目录> [--out 目录] [--atlas 图集] [--skin 初始皮肤] [--dry-run]
```

本机 Cocos Creator 在 `C:/ProgramData/cocos/editors/Creator/3.8.8/`(Cocos Dashboard 装的),引擎源码在它的
`resources/resources/3d/engine/`—— **所有写法都照源码和实测**,文档只写结论。

## 0. 方案:图片部件原生,加权网格走脚本组件(2026-11-04 用户定)

Cocos 2D **没有蒙皮**。`cc.Sprite` 只画矩形;3D 的 `SkinnedMeshRenderer` 能通过 `UIMeshRenderer` 放进 UI(实测能画、能动、
morph 也能动),但它不是 `UIRenderer`,**不参与 `Sorting2D` 排序** —— 场景里一有 `Sorting2D`,这些网格的先后就不受控
(旧管线全压在最上面,新管线碰巧跟节点顺序)。而挂在骨骼下的 Sprite 又必须靠 `Sorting2D` 才能按 Spine 的绘制顺序画。
两样拼不到一起。

三条路比过(运行时性能 / 效果 / 编辑器里能改什么 / 现成工具),用户定了:

1. **图片部件走原生**(本文档):Sprite + Sorting2D + `.anim`。零脚本。—— ✅ 已做
2. **加权网格和 deform 走一个脚本组件**:`UIRenderer` 子类 + 自定义 assembler,CPU 蒙皮,和 Sprite 一起批处理、一起被 Sorting2D 排序;
   deform 按 Spine 原公式「先加偏移再蒙皮」,每顶点骨骼数不限。架构和 Cocos 自带的 Spine 组件相同。—— ⏳ 下一步

否决的:全部当 3D 模型(每个部件一个 draw call、绘制顺序动画做不了、glTF 子资源 id 的哈希规则没找到);只做图片部件(一半角色明显不对)。

## 1. 实测结论(2026-11-03 探针工程,Cocos Creator 3.8.8)

| 事 | 结论 |
|---|---|
| 坐标 / 单位 | Spine 的像素 = Cocos UI 的单位,Y 朝上、角度逆时针为正 —— **不用换算** |
| 按 Spine 绘制顺序画 | 部件挂在骨骼下时只能靠 `cc.Sorting2D`(`sortingOrder` 大的后画),不然按层级顺序。**工程要开 sorting-2d 功能**(3.8 新建的 2D 工程默认开;`settings/v2/packages/engine.json` 的 `includeModules` 里有 `sorting-2d`) |
| `.anim` 能驱动的 | 节点 `position` / `eulerAngles` / `scale`(VectorTrack)、节点 `active`(ObjectTrack)、`cc.Sprite.spriteFrame`(ObjectTrack)、`cc.Sprite.color`(ColorTrack)、`cc.Sorting2D.sortingOrder`(RealTrack 阶梯)、`cc.UIOpacity.opacity` —— 全部实测过 |
| 曲线 | `cc.RealCurve` 每帧一个插值模式(直线 / 阶梯 / 三次),三次段开了权重后**控制点是绝对的**,Spine 的贝塞尔逐点还原(第 4 节) |
| 混合 | `cc.Sprite` 自己有 `_srcBlendFactor` / `_dstBlendFactor`,不用自定义材质 |
| 图片的子资源 id | 一张图导成 sprite-frame 后两个子资源 id **固定**:贴图 `@6c48a`、spriteFrame `@f9941`(所有工程一样)。glTF 等别的子资源的 id 是按名字算的 5 位哈希,asset-db 是加密的,试了 20 多种哈希没对上 —— 所以不走 glTF |
| `.meta` | 写 `imported: false` + 自己的 `uuid` + `userData`,资源库第一次打开时补全,uuid 和导入设置都保留 |
| 图片裁边 | sprite-frame 的 `trimType` 默认 `auto`(资源库把透明边裁掉再改 rect / offset),要写 `none` —— 我们的锚点是按整张图算的 |
| 命令行构建 | `CocosCreator.exe --project <工程> --build "configPath=<json>"`,json 里 `platform` / `scenes` / `startScene` / `includeModules` 等;退出码 36 但产物正常 |
| 浏览器面板 | 面板藏着时页面的渲染循环被节流到约 0.3 秒一帧,截图全黑 —— 先 `tabs_select` 把标签页置前 |

## 2. 产物长什么样

```
<名字>/                          ← 整个目录拷进工程的 assets/(.meta 一起拷,uuid 才不变)
  <名字>.prefab (+.meta)         ← 根节点挂 cc.Animation(playOnLoad 播第一条)
  <动画>.anim (+.meta)           ← 每条动画一个剪辑,循环。⚠️ 剪辑在 Cocos 里的名字是文件名(资源库按文件名起,`_name` 不算数,
                                   实测),所以文件就叫动画名,`getComponent(Animation).play('idle')` 才对得上
  images/                        ← 每个图集区域一张 PNG(摆正、裁好、直通 alpha),+ AutoAtlas.pac 构建时打成图集
<名字>.meta
```

节点树:

```
<名字>                         cc.UITransform、cc.Animation
  <骨骼>                       普通节点:position / eulerAngles.z / scale = Spine 的 setup 值
    <骨骼>…
      <slot>[__<键名>][ #帧]    cc.UITransform + cc.Sprite + cc.Sorting2D(sortingOrder = slot 下标)
      <slot>__<键名> (<皮肤>)   具名皮肤的部件外面包一层,皮肤开关打在它的 active 上(第 6 节)
        <slot>__<键名>
```

写法照 3.8.8 编辑器自己写出的文件(`editor/assets/default_prefab/ui/Canvas.prefab`、`Button.prefab`):对象数组,
`__type__` 是类名,`{"__id__": n}` 引用数组下标,`{"__uuid__": "…"}` 引用资源;每个节点带 `cc.PrefabInfo`、每个组件带
`cc.CompPrefabInfo`(`fileId` 22 个字符,我们按路径哈希)。uuid 一律按名字哈希(`src/cocos/ids.ts`),重新导出不变。

## 3. 部件怎么摆

**region attachment**:Spine 画的是 `width × height`(再乘 scaleX/Y)的矩形,中心在 (x, y),绕 rotation 转;图集里存的是裁掉透明边
的那一块(`offsetX / offsetY` = 裁剪矩形在原图里的左下角)。节点取 attachment 自己的变换,Sprite 画裁剪矩形:

```
contentSize = (region.width · width/originalWidth,  region.height · height/originalHeight)
anchor      = ((originalWidth/2 − offsetX) / region.width,  (originalHeight/2 − offsetY) / region.height)
```

`_sizeMode` 写 CUSTOM(0)、`_isTrimmedMode` false:矩形由 UITransform 定,Sprite 的 simple assembler 画的就是
`[−ax·w, (1−ax)·w] × [−ay·h, (1−ay)·h]`(源码 `assembler/sprite/simple.ts`)。端到端测试里 region 四角和 Spine 差 < 0.05 像素。

**网格(先按矩形画,等脚本组件)**:图上的点 →(最小二乘仿射)→ 骨骼局部,仿射拆成旋转 + 缩放给节点,斜切丢掉;只用到图的一部分
的网格按 uv 包围盒裁图(共用一张图的 linkedmesh 常见)。残差(每个顶点按这个矩形画出来和 Spine 的差)报出来:≤ 0.5 像素 info,
否则 approximated;加权网格(两根以上骨骼)按权重最大的那根画,报 loss;deform 报 loss。端到端测试核对报出来的残差兜得住
(动画里允许 20% 余量 —— 骨骼一缩放误差也跟着缩放)。

**斜切 / 继承模式**:Cocos 的节点没有斜切、只有完整继承,和 Unity 一样忽略(报近似)。端到端测试按同样忽略的 Spine 求值
(`unityCompatible`)比,别的地方必须精确。

## 4. 动画

`cc.AnimationClip` 3.x 的 `_tracks` 写法(`src/cocos/clip.ts`)。轨道目标是 `TrackPath`:`HierarchyPath`(从挂 `cc.Animation` 的
根往下的节点路径,`/` 分隔 —— 所以节点名里的 `/` 要换掉)→ `ComponentPath`(可选)→ 属性名。

| Spine | Cocos |
|---|---|
| 骨骼 rotate / translate / scale | `eulerAngles` / `position` / `scale` 的 VectorTrack,各分量一条 `cc.RealCurve`,没动的分量留空(引擎保留原值)。值 = setup + 关键帧(scale 是乘) |
| 换图(attachment 时间轴) | 该 slot 每个部件节点一条 `active` ObjectTrack(阶梯)。4.1 序列帧每帧一个节点,亮 =「键名亮着」且「现在是这一帧」 |
| slot 颜色 | 每个节点一条 `cc.Sprite.color` ColorTrack(r g b a 四条,0..255),= slot 颜色 × attachment 颜色;有贝塞尔的按 30 fps 采样(报近似) |
| 逐帧绘制顺序 | 挪过位的 slot,其节点一条 `cc.Sorting2D.sortingOrder` 阶梯轨道 |
| 事件 | 没转(Cocos 的动画事件要有脚本里的方法接),报 loss |

**曲线**(`src/cocos/curve.ts`):`RealKeyframeValue` 的 `interpolationMode` 管这一帧到下一帧那段 —— LINEAR / CONSTANT(阶梯)/ CUBIC。
三次段由本帧的 `rightTangent` + `rightTangentWeight` 和下一帧的 `leftTangent` + `leftTangentWeight` 决定,
开了 `tangentWeightMode` 之后(引擎 `evalBetweenTwoKeyFrames`):

```
控制点 = (time + cos(atan(tangent)) · weight,  value + sin(atan(tangent)) · weight)
```

tangent 定方向、weight 定离端点多远(时间 / 值平面的欧氏距离)。Spine 的控制点是绝对的时间 / 值,正好逐点还原:
`tangent = dy/dx, weight = √(dx²+dy²)`;控制点贴在端点上 weight 写 0 就是。求值时引擎在时间轴上解三次方程取参数再算值,
和 Spine 是同一条曲线。端到端测试把引擎的求值移植过来(`evaluateRealCurve`)逐点比。

⚠️ 第一帧之前 Spine 用 setup 值,Cocos 保持第一帧的值 —— 第一帧不在 0 时在 0 补一个 setup 值的阶梯键。
⚠️ 引擎找关键帧按 **1e-6 秒**认同一时刻(`binarySearchEpsilon`):关键帧 1.1666667 和采样网格的 1.166667 是两个 double,
写进曲线就是同一时刻的两个键 —— 靠得太近的只留一个(`distinctTimes`)。

## 5. 图

每个用到的图集区域一张 PNG:从图集页上摆正着抠出来(旋转 90° 的区域按 bakeAtlas 同一个映射转回),预乘 alpha 的还原成直通。
`.meta` 写成 sprite-frame 类型,子资源 `@6c48a`(texture)+ `@f9941`(spriteFrame),`trimType: none`、`packable: true`
(运行时动态合图)。目录里放一个 `AutoAtlas.pac`(内容照 `default_file_content/auto-atlas`),构建时打成一张图集、不带原图。

没有用一张烘焙页 + plist 图集:texture-packer 导入的每个 spriteFrame 子资源 id 也是按名字算的哈希,引用不到。

## 6. 皮肤

所有皮肤的部件都建节点(和 Unity / Godot 同一个思路,docs/UNITY-2D.md 第 13 节)。显隐两个开关:部件节点的 `active` 管换图(动画驱动),
外面包一层节点的 `active` 管皮肤。只有和皮肤有关的节点才包:具名皮肤里的,以及默认皮肤里会被某套具名皮肤同 slot 同键名盖住的。
初始皮肤由 `--skin` 定(默认皮肤空着就取第一套具名皮肤)。切皮肤 = 把名字带 `(<皮肤>)` 的包装节点 `active` 切一下 ——
`cc.Animation` 一次只播一个 state,没有像 Unity 那样的皮肤层;以后脚本组件做好了可以带一个 `setSkin`。

## 7. 混合模式

Sprite 自己的混合因子(`gfx.BlendFactor`),贴图直通 alpha、着色器输出 color × texture(不预乘):

| Spine | src / dst | 贴图 |
|---|---|---|
| normal | SRC_ALPHA / ONE_MINUS_SRC_ALPHA | 直通 |
| additive | SRC_ALPHA / ONE | 直通,精确 |
| multiply | DST_COLOR / ONE_MINUS_SRC_ALPHA | **预乘过的副本**(`<名字>@pma.png`)—— 要等于 Spine 的 dst·(src·a + 1 − a),src 得是 rgb·a |
| screen | ONE / ONE_MINUS_SRC_COLOR | 预乘过的副本 |

multiply / screen 的 slot 上 alpha 动画只是近似(颜色里的 a 乘不到 rgb),报 info。像素级验证还没做(第 9 节)。

## 8. 端到端测试(`src/spine-convert/cocos/export.test.ts`)

把写出的 prefab 和 `.anim` 读回来,**按 Cocos 的规则**(`cocosEval.ts`:节点矩阵、UITransform 矩形、active 链、Sorting2D 先后、
轨道求值)算每个 Sprite 画在哪、哪些亮着、先后、颜色,和 Spine 的求值比。样本:MX2_cat 4.1 / 3.8(两版贝塞尔)+ MC2 的
BBQ_grill(100 个 region、换图)、blackrichwoman(6 套皮肤)、customer_1(加权网格 deform)、Female staff(linkedmesh)、
Easter_card(遮罩 + deform + 绘制顺序)。查:setup 和每个关键帧 / 中点的四角,显隐,先后,颜色,轨道指向的节点存在,
曲线没有同一时刻的两个键,有损的都报了,皮肤开关,图和 meta 一致。

## 9. 在引擎里验

探针工程 `C:/Users/zhe.huang/AppData/Local/Temp/agc/probe`(生成脚本在 scratchpad 的 `cocos_probe.py` / `cocos_view.py`):
导出结果拷进 `assets/export/`,`cocos_view.py <名字>` 把 prefab 的节点树嵌进一个带 Canvas 的场景(不走 PrefabInstance,角色缩到
0.3 倍),`CocosCreator.exe --project … --build "configPath=…/build.json"` 构建 web-desktop,`.claude/launch.json` 的 `cocos-probe`
起静态服务、`cocos-collect`(`tools/cocos/collect.mjs`)在 8082 收帧。页面里:

```js
setInterval(() => cc.director.tick(1 / 30), 33)        // ⚠️ 面板藏着时 rAF 几乎不走,场景都加载不出来,自己驱动
cc.director.loadScene('view_<名字>')
const st = node.getComponent(cc.Animation).getState('<动画>'); st.play(); st.pause(); st.time = t; st.sample()   // 定格
cc.director.once(cc.Director.EVENT_AFTER_DRAW, () => canvas.toDataURL())   // 画完那一刻读像素(之后缓冲就没了)
fetch('http://127.0.0.1:8082/save?name=x.png', { method: 'POST', body })
```

2026-11-04 看过:MX2_cat、Easter_card、BBQ_grill、blackrichwoman 四个样本各两条动画四个时刻,位置 / 换图 / 先后都对;
Profiler 里每个角色 1 个 draw call(2D 批处理生效)。像素级和 Unity 的渲染工具逐帧比还没做(采集端有了,渲染工具还没写)。

## 10. 转不过去的(都会报出来)

- **加权网格、deform、clipping 遮罩** —— 等脚本组件(第 0 节)。现在加权网格按权重最大的骨骼画、deform 不动、遮罩不裁,都报 loss
- IK / transform / path 约束 —— 没有对应物
- 两色染色 —— 只保留亮色
- 斜切、非默认继承模式 —— 节点没有,报近似
- 事件 —— 报 loss

⚠️ 多个角色重叠时:`Sorting2D` 在同一个 sorting layer 里全局排序,两个角色的部件会按 slot 下标交错(Unity 的 sortingOrder 同理)。
要隔开得用不同的 sorting layer,或者给角色根节点加一个 `cc.Mask`(mask 边界会冲掉排序队列,实测待做)。
