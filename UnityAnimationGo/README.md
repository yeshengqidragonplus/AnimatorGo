# UnityAnimationGo

**验转换产物用的空 Unity 工程,只做本地测试。**

Unity 6000.3 + URP + `com.unity.2d.animation` 13.0.2 —— 版本和转换器照着写的样本一致。

仓库里只留骨架(`Packages/`、`ProjectSettings/`、本文件),
`Assets/` 整个忽略 —— 那里面是 `res/` 的授权素材转出来的图,和 `res/` 同性质。

## 用法

从仓库根目录生成资源进来:

```bash
pnpm unity res/spine/4.1 --out UnityAnimationGo/Assets/AnimatorGo
pnpm unity res/BBQ      --out UnityAnimationGo/Assets/AnimatorGo
```

自检脚本在 [tools/unity/AnimatorGoVerify.cs](../tools/unity/AnimatorGoVerify.cs)
(源码放那儿,因为这里的 `Assets/` 不进库),拷进来:

```bash
mkdir -p UnityAnimationGo/Assets/Editor
cp tools/unity/AnimatorGoVerify.cs UnityAnimationGo/Assets/Editor/
```

然后在 Unity 里:

| 菜单 | 干什么 |
|---|---|
| `Tools ▸ AnimatorGo ▸ 检查转换产物` | 跑自检,报告打到 Console |
| `Tools ▸ AnimatorGo ▸ 摆一个对比场景` | 角色横向排开、相机框好,存成 `Verify.unity` |

自检盯的是**两类只有 Unity 自己知道、而且都不报错**的问题:

1. **动画曲线的 `path` 指不到真实物体** —— Unity 直接忽略这条曲线,
   表现是「某个部件就是不动」,控制台一声不响
2. **SpriteSkin 校验不过** —— 网格摊成一团或干脆不显示

## 换肤怎么测(多皮肤骨架,如 MergeCooking2 的 blackrichwoman)

两种模式,产物只在皮肤上有差别,其余一字不差。**默认零脚本。**

**零脚本(默认)**:所有皮肤在一个 prefab 里,由 Animator 的第 1 层 `Skin` 控制。

```bash
pnpm unity <blackrichwoman.skel.bytes> --out UnityAnimationGo/Assets/AnimatorGo
```

- Play 模式里:`animator.Play("Pirate", 1)`;或者选中实例,Animator 窗口切到 `Skin` 层,
  右键某个 state → Set as Layer Default State 再 Play
- 不 Play:选中实例,Animation 窗口预览 `blackrichwoman@skin@Pirate` 这条 clip 就能看到该皮肤
- 期望:海盗帽 + 红腰带只在 Pirate 下出现,圣诞围巾只在 Christmas_day 下出现,`stand` 里表情不叠

**带脚本**(`--skins script`):根节点挂 `AnimatorGoSkins`,换装件切到才加载。

```bash
pnpm unity <blackrichwoman.skel.bytes> --out UnityAnimationGo/Assets/AnimatorGo --skins script
```

CLI 会把运行时脚本拷到 `Assets/AnimatorGo/AnimatorGoRuntime/`(一次)。

- 不 Play:选中实例,Inspector 里 `AnimatorGoSkins` 的 `editorPreviewSkin` 填 `Pirate`,立刻切换
  (编辑器里走 AssetDatabase 加载)
- Play 模式里:`GetComponent<AnimatorGoSkins>().SetSkin("Pirate")`;
  真机要先接 `AnimatorGoSkins.LoadAsset`(见 `AnimatorGoRuntime/AnimatorGoSkins.cs` 顶部注释)
- 期望:切到 Pirate 前 Profiler / Project 里海盗那张贴图未加载,切到后才加载;Hierarchy 里
  `Pirate_hat@Pirate` 等节点亮起,其余皮肤的节点灭

不想开编辑器也能看图:`tools/unity/AnimatorGoRender.cs` 加 `ANIMATORGO_RENDER_SKIN=Pirate`
把某套皮肤渲成 PNG(两种模式都支持)。**batchmode 的工程路径别用带 `~` 的 8.3 短名**,否则脚本挂不上类。

## 从零克隆之后

`Assets/` 是空的,URP 的管线资源也不在库里(它们在 `Assets/Settings/`)。
用 Unity Hub 以 **Universal 2D** 模板新建、或在 Project Settings 里重新指一个
URP 资源即可 —— 这工程本身没有要保留的内容。
