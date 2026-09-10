using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.U2D.Animation;

/// <summary>
/// 把转换产物的动画在编辑器里逐帧渲染成 PNG —— 不进 Play 模式、不靠人眼盯着编辑器。
///
/// 用 <c>AnimationClip.SampleAnimation</c> 把某一时刻的曲线值写进层级,再手动推一下 SpriteSkin
/// 的蒙皮(它平时在 LateUpdate 里做,批处理没有帧循环),然后相机渲到 RenderTexture 存盘。
///
/// 环境变量:
///   ANIMATORGO_RENDER_PREFABS  逗号分隔的 prefab 名;空 = 全部
///   ANIMATORGO_RENDER_CLIPS    逗号分隔的动画名(@ 后面那段);空 = 全部
///   ANIMATORGO_RENDER_STEPS    每条动画采样几帧,默认 4
/// 输出到工程目录下 Renders/(在 Assets 外,不会被导入)。
///
/// 批处理:Unity.exe -batchmode -quit -projectPath 工程 -executeMethod AnimatorGoRender.Render -logFile 日志
/// (要渲染,不能加 -nographics)
/// </summary>
public static class AnimatorGoRender
{
    const string AssetRoot = "Assets/AnimatorGo";
    const int Width = 480;
    const int Height = 720;

    [MenuItem("Tools/AnimatorGo/渲染动画帧到 Renders")]
    public static void Render()
    {
        string[] prefabFilter = Split(Environment.GetEnvironmentVariable("ANIMATORGO_RENDER_PREFABS"));
        string[] clipFilter = Split(Environment.GetEnvironmentVariable("ANIMATORGO_RENDER_CLIPS"));
        int steps = int.TryParse(Environment.GetEnvironmentVariable("ANIMATORGO_RENDER_STEPS"), out int parsed) ? parsed : 4;
        bool debug = Environment.GetEnvironmentVariable("ANIMATORGO_RENDER_DEBUG") == "1";
        // sample = AnimationClip.SampleAnimation 直接写属性(默认);
        // animator = 走真正的 Animator 状态机(Play + Update(0)),连 Write Defaults 一起,更接近运行时
        bool viaAnimator = Environment.GetEnvironmentVariable("ANIMATORGO_RENDER_MODE") == "animator";
        // 排查用:只框住某个渲染器(按物体名)放大看;把某些渲染器关掉对比
        string focus = Environment.GetEnvironmentVariable("ANIMATORGO_RENDER_FOCUS");
        // 多皮肤骨架看哪套皮肤(皮肤层的 state 名);空 = prefab 里的初始皮肤
        string skinState = Environment.GetEnvironmentVariable("ANIMATORGO_RENDER_SKIN");
        string[] hide = Split(Environment.GetEnvironmentVariable("ANIMATORGO_RENDER_HIDE"));
        string outDir = Path.Combine(Directory.GetCurrentDirectory(), "Renders");
        Directory.CreateDirectory(outDir);

        EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        var camGo = new GameObject("cam");
        var cam = camGo.AddComponent<Camera>();
        cam.orthographic = true;
        cam.clearFlags = CameraClearFlags.SolidColor;
        cam.backgroundColor = new Color(0.2f, 0.2f, 0.22f, 1f);
        var rt = new RenderTexture(Width, Height, 24, RenderTextureFormat.ARGB32);
        cam.targetTexture = rt;

        int written = 0;
        foreach (string guid in AssetDatabase.FindAssets("t:Prefab", new[] { AssetRoot }))
        {
            string path = AssetDatabase.GUIDToAssetPath(guid);
            string prefabName = Path.GetFileNameWithoutExtension(path);
            if (prefabFilter.Length > 0 && !prefabFilter.Contains(prefabName)) continue;

            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            int cut = path.LastIndexOf('/');
            string folder = cut < 0 ? AssetRoot : path.Substring(0, cut);
            foreach (string clipGuid in AssetDatabase.FindAssets("t:AnimationClip", new[] { folder }))
            {
                var clip = AssetDatabase.LoadAssetAtPath<AnimationClip>(AssetDatabase.GUIDToAssetPath(clipGuid));
                // 皮肤层的静态 clip(<骨架>@skin@<皮肤>)不是动画,跳过;想看某套皮肤用 ANIMATORGO_RENDER_SKIN
                if (clip.name.Contains("@skin@")) continue;
                // 剪辑名是 <骨架>@<动画>,取最后一个 @ 后面那段
                int at = clip.name.LastIndexOf('@');
                string clipName = at < 0 ? clip.name : clip.name.Substring(at + 1);
                if (clipFilter.Length > 0 && !clipFilter.Contains(clipName)) continue;

                // 每条动画换一个干净的实例 —— SampleAnimation 不会把上一条动画动过、这一条没动的属性
                // 还原(Animator 的 Write Defaults 会),复用实例会把上一条的表情带进来
                var root = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
                try
                {
                    Animator animator = root.GetComponent<Animator>();
                    if (viaAnimator && animator != null)
                    {
                        animator.Rebind(); // 记下默认值(Write Defaults 用的就是这一份)
                        // 多皮肤骨架:皮肤层(第 1 层)切到指定 state,就是运行时 animator.Play("皮肤名", 1) 那一行
                        if (!string.IsNullOrEmpty(skinState) && animator.GetLayerIndex("Skin") >= 0)
                        {
                            animator.Play(skinState, animator.GetLayerIndex("Skin"));
                            animator.Update(0f);
                        }
                    }
                    else if (!string.IsNullOrEmpty(skinState))
                    {
                        // 不走 Animator 时,把皮肤 clip 采一下 —— 它只写 m_IsActive,和动画 clip 不打架
                        foreach (string skinGuid in AssetDatabase.FindAssets("t:AnimationClip", new[] { folder }))
                        {
                            var skinClip = AssetDatabase.LoadAssetAtPath<AnimationClip>(AssetDatabase.GUIDToAssetPath(skinGuid));
                            if (skinClip.name.EndsWith("@skin@" + skinState)) skinClip.SampleAnimation(root, 0f);
                        }
                    }
                    for (int i = 0; i < steps; i++)
                    {
                        float t = clip.length * i / steps;
                        if (viaAnimator && animator != null)
                        {
                            // 状态名 = 剪辑名。Play 到指定进度后 Update(0) 求值,不推进时间
                            animator.Play(clip.name, 0, clip.length > 0 ? t / clip.length : 0f);
                            animator.Update(0f);
                        }
                        else
                        {
                            clip.SampleAnimation(root, t);
                        }
                        // SpriteSkin 的蒙皮在 LateUpdate 里做,批处理没有帧循环 —— 手动推一下。
                        // 公开的 OnPreviewUpdate 只在 GUI 事件循环里才干活(Event.current != null),
                        // 批处理里拿不到事件,所以直接调它里面那个私有的 DeformForPreviewUpdate。
                        // 灭着的物体不渲染,也不用推
                        foreach (SpriteSkin skin in root.GetComponentsInChildren<SpriteSkin>(false))
                        {
                            skin.alwaysUpdate = true;
                            DeformNow(skin);
                        }
                        foreach (Renderer r in root.GetComponentsInChildren<Renderer>(true))
                        {
                            if (hide.Contains(r.name)) r.enabled = false;
                        }
                        Frame(cam, root, focus);
                        cam.Render();
                        string suffix = (viaAnimator ? "_animator" : "") + (string.IsNullOrEmpty(skinState) ? "" : $"_skin-{skinState}") + (string.IsNullOrEmpty(focus) ? "" : $"_focus-{focus}") + (hide.Length > 0 ? "_hide" : "");
                        string stem = Path.Combine(outDir, $"{prefabName}_{clipName}_{i}_{t:0.00}s{suffix}");
                        File.WriteAllBytes(stem + ".png", ReadPng(rt));
                        if (debug) File.WriteAllText(stem + ".txt", Describe(cam, root));
                        written++;
                    }
                }
                finally
                {
                    UnityEngine.Object.DestroyImmediate(root);
                }
            }
        }

        cam.targetTexture = null;
        rt.Release();
        Debug.Log($"AnimatorGo 渲染:写了 {written} 张到 {outDir}");
        if (Application.isBatchMode) EditorApplication.Exit(0);
    }

    static readonly System.Reflection.MethodInfo DeformMethod = typeof(SpriteSkin).GetMethod(
        "DeformForPreviewUpdate",
        System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);

    static void DeformNow(SpriteSkin skin)
    {
        if (DeformMethod != null) DeformMethod.Invoke(skin, null);
        else skin.OnPreviewUpdate(); // 包版本变了找不到私有方法时退回公开口子(批处理里可能不生效)
    }

    static string[] Split(string value)
    {
        if (string.IsNullOrEmpty(value)) return new string[0];
        return value.Split(',').Select(x => x.Trim()).Where(x => x.Length > 0).ToArray();
    }

    /// 相机框住所有亮着的渲染器;给了 focus 就只框那个物体(放大看局部)
    static void Frame(Camera cam, GameObject root, string focus = null)
    {
        Renderer[] renderers = root.GetComponentsInChildren<Renderer>(false)
            .Where(r => r.enabled && r.gameObject.activeInHierarchy)
            .Where(r => string.IsNullOrEmpty(focus) || r.name == focus)
            .ToArray();
        if (renderers.Length == 0) return;

        Bounds bounds = renderers[0].bounds;
        foreach (Renderer r in renderers) bounds.Encapsulate(r.bounds);
        float aspect = (float)Width / Height;
        float half = Mathf.Max(bounds.extents.y, bounds.extents.x / aspect) * 1.08f;
        cam.orthographicSize = Mathf.Max(half, 0.01f);
        cam.transform.position = new Vector3(bounds.center.x, bounds.center.y, -10f);
    }

    /// 调试:这一帧亮着的渲染器各自占图上哪块(像素,原点左上),按绘制顺序排 —— 用来认图上的某块是谁
    static string Describe(Camera cam, GameObject root)
    {
        var sb = new System.Text.StringBuilder();
        Renderer[] renderers = root.GetComponentsInChildren<Renderer>(false)
            .Where(r => r.enabled && r.gameObject.activeInHierarchy)
            .OrderBy(r => r.sortingOrder)
            .ToArray();
        if (renderers.Length > 0)
        {
            // 这一帧整体在世界里占多大 —— 摆多个 prefab 对比时,用它判断会不会互相甩到对方身上
            Bounds all = renderers[0].bounds;
            foreach (Renderer r in renderers) all.Encapsulate(r.bounds);
            sb.AppendLine($"# world bounds (relative to root {root.transform.position.x:0.##},{root.transform.position.y:0.##}): "
                + $"x {all.min.x - root.transform.position.x:0.##} .. {all.max.x - root.transform.position.x:0.##}, "
                + $"y {all.min.y - root.transform.position.y:0.##} .. {all.max.y - root.transform.position.y:0.##}");
        }
        sb.AppendLine($"# camera ortho size {cam.orthographicSize:0.###} at {cam.transform.position.x:0.##},{cam.transform.position.y:0.##}");
        sb.AppendLine("name\tsortingOrder\tkind\txMin\tyMin\txMax\tyMax\tworldMin\tworldMax\tcolor");
        foreach (Renderer r in renderers)
        {
            Bounds b = r.bounds;
            Vector3 min = cam.WorldToScreenPoint(b.min);
            Vector3 max = cam.WorldToScreenPoint(b.max);
            // Spine 常用 alpha=0 藏部件(眼白、眼睫),所以把 SpriteRenderer 的颜色也列出来
            string color = r is SpriteRenderer sr ? $"rgba({sr.color.r:0.##},{sr.color.g:0.##},{sr.color.b:0.##},{sr.color.a:0.##})" : "-";
            // 屏幕坐标原点在左下,翻成图片的左上原点;world 两列用来核对包围盒本身对不对
            sb.AppendLine(
                $"{r.name}\t{r.sortingOrder}\t{r.GetType().Name}\t{min.x:0}\t{Height - max.y:0}\t{max.x:0}\t{Height - min.y:0}"
                + $"\t({b.min.x:0.##},{b.min.y:0.##})\t({b.max.x:0.##},{b.max.y:0.##})\t{color}");
        }
        return sb.ToString();
    }

    static byte[] ReadPng(RenderTexture rt)
    {
        RenderTexture prev = RenderTexture.active;
        RenderTexture.active = rt;
        var tex = new Texture2D(rt.width, rt.height, TextureFormat.RGBA32, false);
        tex.ReadPixels(new Rect(0, 0, rt.width, rt.height), 0, 0);
        tex.Apply();
        RenderTexture.active = prev;
        byte[] png = tex.EncodeToPNG();
        UnityEngine.Object.DestroyImmediate(tex);
        return png;
    }
}
