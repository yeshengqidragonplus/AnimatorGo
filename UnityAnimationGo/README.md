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

## 从零克隆之后

`Assets/` 是空的,URP 的管线资源也不在库里(它们在 `Assets/Settings/`)。
用 Unity Hub 以 **Universal 2D** 模板新建、或在 Project Settings 里重新指一个
URP 资源即可 —— 这工程本身没有要保留的内容。
