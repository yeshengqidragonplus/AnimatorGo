# Spine → Cocos Creator 3.8

中转模型(Spine 的数据模型)→ Cocos Creator 3.8 的**原生节点 + `cc.Animation` + `.anim`**。目标和 Unity / Godot 导出一样:
不装 Spine 运行时,拖进工程就能播,骨骼和动画在 Cocos 的动画编辑器里能改。图片部件零脚本;网格 / deform / 遮罩走两个
自带的脚本组件(`AnimatorGoMesh` / `AnimatorGoClip`,第 11 节),CLI 拷到输出目录 `AnimatorGoRuntime/`,和产物一起进工程。

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
2. **网格(加权、deform)和遮罩走脚本组件**:`UIRenderer` 子类 + 自定义 assembler,CPU 蒙皮,和 Sprite 一起批处理、一起被 Sorting2D 排序;
   deform 按 Spine 原公式「先加偏移再蒙皮」,每顶点骨骼数不限;遮罩在渲染器里裁三角形。架构和 Cocos 自带的 Spine 组件相同。—— ✅ 已做(2026-11-06,第 11 节)

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
| 浏览器面板 | 面板藏着时页面的 rAF 根本不走:引擎初始化就卡在等第一帧(`game.inited` 一直 false,主包都不加载)。在页面脚本之前把 `requestAnimationFrame` 换成 `setTimeout`(第 9 节的 `probe.html`)就一切正常;初始化完之后再 `director.tick` 自己驱动也行,初始化之前调它会把初始化弄坏 |
| 脚本组件 | prefab 里的 `__type__` = 脚本资源 uuid 的**压缩形式(23 个字符)**:前 5 个十六进制原样、其余每 3 个 → 2 个 base64 字符(`src/cocos/ids.ts` 的 `compressUuid`,对照构建产物里的 `_RF.push({}, "f5ec8w5dYx6dOIk+Mm7CxJm", "AnimatorGoMesh")`);`.anim` 里 ComponentPath 用 ccclass 的**名字**(`getComponent` 按名字找)。`.ts.meta` 是 `importer: typescript`。**一个文件只能有一个 Component**(同一文件里第二个会把第一个的类 id 顶掉) |

## 2. 产物长什么样

```
AnimatorGoRuntime/              ← 有网格 / 遮罩的骨架才需要,输出目录下只拷一份:AnimatorGoMesh.ts、AnimatorGoClip.ts、
                                   AnimatorGoSkinning.ts(+.meta,uuid 固定),和产物一起拷进 assets/
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
      <slot>[__<键名>][ #帧]    图片部件:cc.UITransform + cc.Sprite + cc.Sorting2D(sortingOrder = slot 下标)
      <slot>[__<键名>]          网格(含遮罩范围里的图片部件):cc.UITransform + AnimatorGoMesh + cc.Sorting2D,节点恒等,顶点自己带骨骼
      <slot>[__<键名>]          遮罩:AnimatorGoClip
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

**网格**:`AnimatorGoMesh`,顶点照 Spine 原样存(第 11 节),精确;**遮罩范围里的图片部件**也走它(Sprite 裁不了),四角按
Spine 的 UpdateRegion 算到 slot 骨骼局部,单影响。

**斜切 / 继承模式**:Cocos 的节点没有斜切、只有完整继承,和 Unity 一样忽略(报近似)。端到端测试按同样忽略的 Spine 求值
(`unityCompatible`)比,别的地方必须精确。

## 4. 动画

`cc.AnimationClip` 3.x 的 `_tracks` 写法(`src/cocos/clip.ts`)。轨道目标是 `TrackPath`:`HierarchyPath`(从挂 `cc.Animation` 的
根往下的节点路径,`/` 分隔 —— 所以节点名里的 `/` 要换掉)→ `ComponentPath`(可选)→ 属性名。

| Spine | Cocos |
|---|---|
| 骨骼 rotate / translate / scale | `eulerAngles` / `position` / `scale` 的 VectorTrack,各分量一条 `cc.RealCurve`,没动的分量留空(引擎保留原值)。值 = setup + 关键帧(scale 是乘) |
| 换图(attachment 时间轴) | 该 slot 每个部件节点一条 `active` ObjectTrack(阶梯)。4.1 序列帧每帧一个节点,亮 =「键名亮着」且「现在是这一帧」 |
| slot 颜色 | 每个节点一条 `cc.Sprite.color` / `AnimatorGoMesh.color` ColorTrack(r g b a 四条,0..255),= slot 颜色 × attachment 颜色;有贝塞尔的按 30 fps 采样(报近似) |
| 逐帧绘制顺序 | 挪过位的 slot,其节点一条 `cc.Sorting2D.sortingOrder` 阶梯轨道;遮罩的 `AnimatorGoClip.order` / `endOrder` 同样跟着走 |
| deform | 网格 / 遮罩的 `shapeWeights` 一条 RealArrayTrack:每个 shape 一条 RealCurve,打到它的帧上 1、别的帧 0,帧间走 Spine 这帧的曲线(第 11 节) |
| 事件 | 没转(Cocos 的动画事件要有脚本里的方法接),报 loss |

⚠️ **切动画不回 setup**:`cc.Animation` 换剪辑时,新剪辑没键的属性保持上一条剪辑留下的值(Spine 的 AnimationState 混出时会回 setup)。
换图 / 绘制顺序 / 颜色的轨道只在有时间轴的动画里写,和 Spine 导出到 Unity 的行为一致;deform 的 shape 权重每条动画都写
(没有 deform 的写一条全 0),不然上一条动画留下的变形会粘在网格上 —— 这是最显眼的一种。

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
轨道求值)算每个 Sprite 画在哪、每个网格 / 遮罩的顶点在哪(**import 运行时那份蒙皮代码** `tools/cocos/runtime/AnimatorGoSkinning.ts`
按骨骼节点的世界矩阵算)、谁被哪个遮罩裁,哪些亮着、先后、颜色,和 Spine 的求值比。样本:MX2_cat 4.1 / 3.8(两版贝塞尔)+ MC2 的
BBQ_grill(100 个 region、换图)、blackrichwoman(6 套皮肤)、customer_1(加权网格 deform)、Female staff(linkedmesh)、
Easter_card(遮罩 + deform + 绘制顺序)。查:setup 和每个关键帧 / 中点的四角 / 顶点(0.05 像素),显隐,先后,谁被裁(按 Spine 的
绘制循环模拟:遇到挂着遮罩的 slot 开始、画完 endSlot 结束、已经在裁的忽略后来的),颜色,轨道指向的节点 / 组件存在(shape 数也要对),
曲线没有同一时刻的两个键,有损的都报了,皮肤开关,图和 meta 一致。另有运行时纯数学的单元测试(蒙皮 / deform 顺序、裁剪面积与 uv、
三角化、遮罩范围)和「运行时脚本 `.meta` 的 uuid 与 `ids.ts` 一致」。

## 9. 在引擎里验

探针工程 `C:/Users/zhe.huang/AppData/Local/Temp/agc/probe`(生成脚本在 `tools/cocos/probe/`:`cocos_probe.py` 建工程和基础探针场景,
`cocos_view.py <名字>…` 把 `assets/export/<名字>/` 的 prefab 节点树嵌进一个带 Canvas 的场景 `view_<名字>`(不走 PrefabInstance,
角色缩到 0.3 倍)并登记到 build.json,`sheet.py` 把收到的帧拼成对照图):`pnpm cocos … --out <probe>/assets/export`,
`CocosCreator.exe --project … --build "configPath=…/build.json"` 构建 web-desktop(约 25 秒),`.claude/launch.json` 的 `cocos-probe`
起静态服务、`cocos-collect`(`tools/cocos/collect.mjs`)在 8082 收帧。

⚠️ **浏览器面板藏着时 rAF 不走,引擎初始化卡在等第一帧**,主包都不加载。构建完在 `build/web-desktop/` 旁边生成一个 `probe.html`:
`index.html` 的第一个 `<script>` 之前插一段把 `requestAnimationFrame` 换成 `setTimeout(…, 33)` 的脚本,打开它就一切正常
(`tabs_select` 置前不够,Claude 的窗口本身不在前面也一样)。⚠️ 探针场景的相机要 `_clearFlags=7`(SOLID_COLOR):默认只清深度,
面板藏着时没有合成、绘制缓冲不清,上一帧的东西全留着,截图里全是鬼影(2026-11-06 被它骗了一小时)。页面里:

```js
cc.director.loadScene('view_<名字>')
const st = node.getComponent(cc.Animation).getState('<动画>'); st.play(); st.pause(); st.time = t; st.sample()   // 定格
cc.director.once(cc.Director.EVENT_AFTER_DRAW, () => canvas.toDataURL())   // 画完那一刻读像素(之后缓冲就没了)
fetch('http://127.0.0.1:8082/save?name=x.png', { method: 'POST', body })
```

2026-11-04 看过:MX2_cat、Easter_card、BBQ_grill、blackrichwoman 四个样本各两条动画四个时刻,位置 / 换图 / 先后都对;
2026-11-06 脚本组件:Easter_card(41 个网格 + 14 个被遮的图片部件 + 1 个遮罩)、customer_1(加权网格 deform,闭眼看得见)、
MX2_cat 各两条动画四个时刻,网格、deform、遮罩都对;组件关掉再开、节点 active 切一下再截,几何不坏;每个角色 1 个 draw call
(multiply 混合的 slot 要单独一批,Easter_card 是 3 个)。像素级和 Unity 的渲染工具逐帧比还没做(采集端有了,渲染工具还没写)。

## 10. 转不过去的(都会报出来)

- IK / transform / path 约束 —— 没有对应物
- 两色染色 —— 只保留亮色
- 斜切、非默认继承模式 —— 节点没有,报近似
- 事件 —— 报 loss

⚠️ 多个角色重叠时:`Sorting2D` 在同一个 sorting layer 里全局排序,两个角色的部件会按 slot 下标交错(Unity 的 sortingOrder 同理)。
要隔开得用不同的 sorting layer,或者给角色根节点加一个 `cc.Mask`(mask 边界会冲掉排序队列,实测待做)。

## 11. 网格、deform、遮罩:`AnimatorGoMesh` / `AnimatorGoClip`(2026-11-06)

源码在 `tools/cocos/runtime/`(三个 `.ts` + `.meta`,uuid 固定在 `src/cocos/ids.ts` 的 `RUNTIME_SCRIPTS`,有测试盯着两边一致),
CLI 拷到输出目录 `AnimatorGoRuntime/` 一份。

**顶点的表达照 Spine 原样**(`AnimatorGoSkinning.ts`):每个顶点若干个「影响」`[骨骼局部下标, x, y, 权重]`,
`bones` 是骨骼**节点**的引用,世界坐标 = Σ 权重 · 骨骼节点的 worldMatrix · (局部 + deform 偏移)。没加权的网格 / 被遮的图片部件
就是单影响、全挂在 slot 的骨骼上。不用反解绑定姿势、不用截骨骼数 —— Unity / Godot 那两套麻烦(docs/UNITY-2D.md 第 6、11 节)在这里
都不存在,因为蒙皮是我们自己算的。deform:每个关键帧的偏移(逐影响平铺,和 Spine 的 deform 时间轴同一个布局)去重成一个 shape,
`shapeWeights` 按权重叠加后**先加偏移再蒙皮**;动画给每个 shape 一条曲线,打到它的帧上 1、别的帧 0,相邻两条一升一降走同一条
Spine 曲线,混出来 `(1−p)·δₖ + p·δₖ₊₁` 正是 Spine 的插值。uv 存成区域相对的 `(s 向右, t 向下)`,每帧按 `spriteFrame.uv` 的四个角
(左下、右下、左上、右上)仿射换算 —— 自动图集、动态合图、图集里转了 90° 的区域都不用管。

**渲染器**(`AnimatorGoMesh.ts`,`UIRenderer` 子类 + 自己的 assembler):

- 每帧 `lateUpdate` 标脏(骨骼动画在 lateUpdate 之前更新完;引擎只重算标了脏的渲染器),引擎在 `updateAllDirtyRenderers` 里调
  assembler 的 `updateRenderData` → 蒙皮、(被遮就)裁剪、按需扩 chunk;批处理 `walk` 时 `fillBuffers` 把顶点写进 chunk 的
  顶点缓冲(x y z u v r g b a,世界坐标,和 Sprite 一样)、索引用 `chunk.vertexAccessor.appendIndices` 追加
- 材质就是内置的 `ui-sprite-material`,`color` 和混合因子从 UIRenderer 继承,prefab 里的字段和 Sprite 同名(`_color`、`_srcBlendFactor`…)
  —— 所以和 Sprite **同一批**:同一张图集的图片部件和网格一个 draw call
- ⚠️ **容量按 chunk 自己算,不能记在组件上**:组件关掉再开,`destroyRenderData → createData` 会换成 4 个顶点的新 chunk,
  记在组件上的容量就对不上了 —— 写出去的顶点越界丢掉、索引指到别的网格的顶点,一屏尖刺(2026-11-06 实测中招)
- ⚠️ 只在 Web / 小游戏这类 JS 管线上验证过。原生平台的 2D 批处理在 C++ 里,不调 JS 的 `fillBuffers`,还没适配

**遮罩**(`AnimatorGoClip.ts`,普通 Component):多边形同样的顶点表达(加权、deform 都行),每帧算成世界坐标再耳切三角化;
`order` / `endOrder` 是遮罩 slot 和 endSlot 在绘制顺序里的位置(绘制顺序动画给它们写阶梯轨道),生效 = 节点激活(换图时间轴驱动)。
被遮的 `AnimatorGoMesh` 带着全部遮罩的引用(`clips`),每帧按 Spine 的规则(`clipCovers`:自己的 sortingOrder 在遮罩之后、endSlot
之前或 endSlot 不在遮罩后面)挑正盖着自己的那个(几个都盖着取先画的),用 Sutherland–Hodgman 把每个三角形对遮罩的每个三角形裁
—— 和 Spine 的 SkeletonClipping 同一个算法。谁可能被遮是导出时按 setup 和所有绘制顺序关键帧算的,这些 slot 的图片部件也改走
AnimatorGoMesh(Sprite 裁不了)。没用 `cc.Mask`:它的边界会冲掉 Sorting2D 的排序队列,范围也没法按绘制顺序动画走。
