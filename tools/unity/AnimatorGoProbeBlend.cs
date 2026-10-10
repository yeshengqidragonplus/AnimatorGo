using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;

/// <summary>
/// 混合模式探针:Spine 的 additive / multiply / screen 用自带的着色器(tools/unity/runtime/ 的 AnimatorGoBlend.shader、
/// AnimatorGoBlendBuiltin.shader、AnimatorGoMaskedMesh.shader)画出来,是不是 Spine 的公式(docs/UNITY-2D.md 第 18 节)。
///
/// 背景(相机清屏色)已知,每格画一个 texel(直通 alpha:不透明 / 半透明 / 全透明 / 1/4 透明),渲染到 RenderTexture 读格子中心,
/// 和公式比。s = texel.rgb × 渲染器颜色.rgb,a = texel.a × 渲染器颜色.a,d = 背景:
///   normal    s·a + d·(1 − a)
///   additive  s·a + d
///   multiply  d · lerp(1, s, a)        ← 全透明的格子必须还是 d(CanvasItemMaterial MUL 在 Godot 里就是在这儿涂黑的)
///   screen    s·a + d·(1 − s·a)
/// 每种模式 × {SpriteRenderer, 被遮的 SpriteRenderer, SkinnedMeshRenderer, 被遮的 SkinnedMeshRenderer(只有 URP)} × 两种渲染器颜色。
/// normal 一行用的是同一个着色器、normal 的因子(被遮的 SkinnedMeshRenderer 不设因子,用着色器的默认值 —— 旧材质就是这样),
/// 外加管线默认 sprite 材质画的一行作参照。
///
/// Linear 色彩空间的工程,混合在线性空间做(sRGB 目标先解码再混合),渲染器颜色(m_Color)也换成线性,**顶点色不换**
/// (SkinnedMeshRenderer 的 slot 颜色烘在顶点色里);公式照此算。Gamma 工程直接按读到的值算。两种公式的误差都报出来。
///
/// 着色器要先在工程里(pnpm unity 会拷进输出目录的 AnimatorGoRuntime/,或者手动拷 tools/unity/runtime/ 下的连同 .meta)。
/// 批处理:Unity.exe -batchmode -projectPath 工程 -executeMethod AnimatorGoProbeBlend.Probe -logFile 日志(要渲染,不能加 -nographics)
/// 报告写到工程目录下 Renders/probe-blend.txt,图 Renders/probe-blend.png(Assets 外,不会被导入)
/// </summary>
public static class AnimatorGoProbeBlend
{
    // 与 src/unity/writeMaterial.ts 的 BLEND_FACTORS 相同,改了要一起改
    static readonly (string name, BlendMode src, BlendMode dst)[] Modes =
    {
        ("normal", BlendMode.One, BlendMode.OneMinusSrcAlpha),
        ("additive", BlendMode.One, BlendMode.One),
        ("multiply", BlendMode.DstColor, BlendMode.OneMinusSrcAlpha),
        ("screen", BlendMode.One, BlendMode.OneMinusSrcColor),
    };
    static readonly Color Dst = new Color(0.8f, 0.5f, 0.2f, 1f);
    static readonly Color[] Texels = { new Color(0.2f, 0.6f, 1f, 1f), new Color(1f, 0.2f, 0.4f, 0.5f), new Color(0f, 0f, 0f, 0f), new Color(0.5f, 1f, 0.25f, 0.25f) };
    static readonly Color[] Tints = { Color.white, new Color(1f, 0.5f, 0.8f, 0.6f) };
    const int Cell = 8;
    /** 允许的误差(0..1):8 位量化 + half 精度,两次舍入 */
    const float Tolerance = 2.5f / 255f;

    enum Kind { Sprite, SpriteMasked, Mesh, MeshMasked, DefaultSprite }

    struct Row
    {
        public string mode;
        public Kind kind;
        public Color tint;
        public Material material;
    }

    [MenuItem("Tools/AnimatorGo/探针:混合模式")]
    public static void Probe()
    {
        var report = new StringBuilder();
        int problems = 0;
        Directory.CreateDirectory("Renders");
        try { Run(report, ref problems); }
        catch (Exception e) { report.AppendLine("✗ 异常:" + e); problems++; }
        string text = report.ToString();
        Debug.Log(text);
        File.WriteAllText("Renders/probe-blend.txt", text);
        if (Application.isBatchMode) EditorApplication.Exit(problems == 0 ? 0 : 1);
    }

    static void Run(StringBuilder r, ref int problems)
    {
        bool urp = GraphicsSettings.currentRenderPipeline != null;
        bool linear = QualitySettings.activeColorSpace == ColorSpace.Linear;
        r.AppendLine($"Unity {Application.unityVersion},{(urp ? "URP " + GraphicsSettings.currentRenderPipeline.GetType().Name : "内置管线")},{QualitySettings.activeColorSpace} 色彩空间");

        Shader blend = Shader.Find(urp ? "AnimatorGo/Sprite-Unlit-Blend" : "AnimatorGo/Sprite-Blend (Built-in)");
        Shader masked = urp ? Shader.Find("AnimatorGo/Sprite-Unlit-Masked") : null;
        foreach (var (label, s) in new[] { ("blend", blend), ("masked", masked) })
        {
            if (label == "masked" && !urp) continue;
            if (s == null) { r.AppendLine($"✗ 找不到 {label} 着色器(先把 tools/unity/runtime/ 的着色器拷进工程)"); problems++; return; }
            bool error = ShaderUtil.ShaderHasError(s);
            r.AppendLine($"{(error ? "✗" : "✓")} {s.name}:{(error ? "编译出错" : "编译通过")},isSupported = {s.isSupported}");
            if (error || !s.isSupported) { problems++; return; }
        }
        Material defaultSprite = urp
            ? AssetDatabase.LoadAssetAtPath<Material>("Packages/com.unity.render-pipelines.universal/Runtime/Materials/Sprite-Unlit-Default.mat")
            // 导出的 SpriteRenderer 引用的就是它(fileID 10754)。⚠️ 别用 new Material(Shader.Find("Sprites/Default")):内置管线的批处理里画出来是品红(实测)
            : AssetDatabase.GetBuiltinExtraResource<Material>("Sprites-Default.mat");

        EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

        // 4 个 texel 的图:点采样、直通 alpha;sRGB 与工程色彩空间一致(和导出的图集一样按颜色图导入)
        var tex = new Texture2D(Texels.Length, 1, TextureFormat.RGBA32, false, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp };
        tex.SetPixels(Texels);
        tex.Apply();
        var white = new Texture2D(4, 4, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point };
        white.SetPixels(Enumerable.Repeat(Color.white, 16).ToArray());
        white.Apply();

        var rows = new List<Row>();
        foreach (var (name, src, dst) in Modes)
        {
            var kinds = new List<Kind> { Kind.Sprite, Kind.SpriteMasked, Kind.Mesh };
            if (urp) kinds.Add(Kind.MeshMasked);
            foreach (Kind kind in kinds)
            {
                foreach (Color tint in Tints)
                {
                    Material m;
                    if (kind == Kind.MeshMasked)
                    {
                        m = new Material(masked);
                        // normal:不设因子,走着色器默认值(改之前写出的被遮材质就没有这两个属性)
                        if (name != "normal") { m.SetFloat("_SrcBlend", (float)src); m.SetFloat("_DstBlend", (float)dst); }
                    }
                    else
                    {
                        m = new Material(blend);
                        m.SetFloat("_SrcBlend", (float)src);
                        m.SetFloat("_DstBlend", (float)dst);
                    }
                    if (kind == Kind.Mesh || kind == Kind.MeshMasked) m.mainTexture = tex; // SpriteRenderer 自己塞,不设
                    rows.Add(new Row { mode = name, kind = kind, tint = tint, material = m });
                }
            }
        }
        foreach (Color tint in Tints) rows.Add(new Row { mode = "normal", kind = Kind.DefaultSprite, tint = tint, material = defaultSprite });

        int cols = Texels.Length;
        var renderers = new List<Renderer>();
        var bone = new GameObject("bone").transform;
        for (int row = 0; row < rows.Count; row++)
        {
            Row spec = rows[row];
            for (int c = 0; c < cols; c++)
            {
                var go = new GameObject($"{spec.mode}/{spec.kind}/{row}/{c}");
                go.transform.position = new Vector3(c + 0.5f, row + 0.5f, 0);
                bool isMasked = spec.kind == Kind.SpriteMasked || spec.kind == Kind.MeshMasked;
                if (spec.kind == Kind.Mesh || spec.kind == Kind.MeshMasked)
                {
                    // 一格一个蒙皮四边形,骨骼在原点、绑定单位阵 —— 与导出的 SkinnedMeshRenderer 同一条路;UV 全取 texel 中心
                    var mesh = new Mesh();
                    Vector3 o = go.transform.position;
                    mesh.vertices = new[] { o + new Vector3(-0.5f, -0.5f), o + new Vector3(0.5f, -0.5f), o + new Vector3(0.5f, 0.5f), o + new Vector3(-0.5f, 0.5f) };
                    var uv = new Vector2((c + 0.5f) / cols, 0.5f);
                    mesh.uv = new[] { uv, uv, uv, uv };
                    mesh.colors32 = Enumerable.Repeat((Color32)spec.tint, 4).ToArray();
                    mesh.triangles = new[] { 0, 2, 1, 0, 3, 2 };
                    mesh.boneWeights = Enumerable.Repeat(new BoneWeight { boneIndex0 = 0, weight0 = 1 }, 4).ToArray();
                    mesh.bindposes = new[] { Matrix4x4.identity };
                    mesh.RecalculateBounds();
                    go.transform.position = Vector3.zero;
                    var smr = go.AddComponent<SkinnedMeshRenderer>();
                    smr.sharedMesh = mesh;
                    smr.bones = new[] { bone };
                    smr.rootBone = bone;
                    smr.sharedMaterial = spec.material;
                    smr.quality = SkinQuality.Bone1;
                    smr.updateWhenOffscreen = true;
                    // 批处理里同一帧多次 Render() 也重算蒙皮矩阵(CLAUDE.md:不开的话进程里第一次渲染整个不画)
                    smr.forceMatrixRecalculationPerRender = true;
                    // SkinnedMeshRenderer 没有 maskInteraction 的 C# 属性,只有序列化字段(导出写的就是它)
                    var so = new SerializedObject(smr);
                    so.FindProperty("m_MaskInteraction").intValue = isMasked ? (int)SpriteMaskInteraction.VisibleInsideMask : 0;
                    so.ApplyModifiedPropertiesWithoutUndo();
                    renderers.Add(smr);
                }
                else
                {
                    var sr = go.AddComponent<SpriteRenderer>();
                    // FullRect:全透明的 texel 也要真的画出来(Tight 会把它裁掉,multiply 就白测了)
                    sr.sprite = Sprite.Create(tex, new Rect(c, 0, 1, 1), new Vector2(0.5f, 0.5f), 1f, 0, SpriteMeshType.FullRect);
                    sr.color = spec.tint;
                    sr.sharedMaterial = spec.material;
                    sr.maskInteraction = isMasked ? SpriteMaskInteraction.VisibleInsideMask : SpriteMaskInteraction.None;
                    renderers.Add(sr);
                }
            }
        }
        // 盖住整张图的 SpriteMask,范围与导出的一样用自定义范围
        var maskGo = new GameObject("mask");
        maskGo.transform.position = new Vector3(cols / 2f, rows.Count / 2f, 0);
        maskGo.transform.localScale = new Vector3(cols + 2, rows.Count + 2, 1);
        var mask = maskGo.AddComponent<SpriteMask>();
        mask.sprite = Sprite.Create(white, new Rect(0, 0, 4, 4), new Vector2(0.5f, 0.5f), 4f, 0, SpriteMeshType.FullRect);
        mask.isCustomRangeActive = true;
        mask.frontSortingOrder = 10;
        mask.backSortingOrder = -10;

        var camGo = new GameObject("cam");
        var cam = camGo.AddComponent<Camera>();
        cam.orthographic = true;
        cam.orthographicSize = rows.Count / 2f;
        cam.transform.position = new Vector3(cols / 2f, rows.Count / 2f, -10);
        cam.clearFlags = CameraClearFlags.SolidColor;
        cam.backgroundColor = Dst;
        int w = cols * Cell, h = rows.Count * Cell;
        var rt = new RenderTexture(w, h, 24, RenderTextureFormat.ARGB32);
        cam.targetTexture = rt;
        cam.aspect = (float)w / h;
        // 渲两次:第一次让 SkinnedMeshRenderer 的蒙皮矩阵就位
        cam.Render();
        cam.Render();

        var prev = RenderTexture.active;
        RenderTexture.active = rt;
        var read = new Texture2D(w, h, TextureFormat.RGBA32, false);
        read.ReadPixels(new Rect(0, 0, w, h), 0, 0);
        read.Apply();
        RenderTexture.active = prev;
        File.WriteAllBytes("Renders/probe-blend.png", read.EncodeToPNG());

        // ── 逐格比 ──
        var worst = new Dictionary<string, (float linear, float gamma)>();
        r.AppendLine();
        r.AppendLine("每格:读到的 rgb / 公式(工程色彩空间)/ 误差 —— 只列误差超过容差的格子");
        for (int row = 0; row < rows.Count; row++)
        {
            Row spec = rows[row];
            string key = $"{spec.mode,-8} {spec.kind,-13}";
            for (int c = 0; c < cols; c++)
            {
                Color got = read.GetPixel(c * Cell + Cell / 2, row * Cell + Cell / 2);
                bool vertexTint = spec.kind == Kind.Mesh || spec.kind == Kind.MeshMasked;
                Color lin = Expected(spec.mode, Texels[c], spec.tint, linearSpace: true, vertexTint);
                Color gam = Expected(spec.mode, Texels[c], spec.tint, linearSpace: false, vertexTint);
                float eLin = MaxDiff(got, lin), eGam = MaxDiff(got, gam);
                worst.TryGetValue(key, out var acc);
                worst[key] = (Math.Max(acc.linear, eLin), Math.Max(acc.gamma, eGam));
                float e = linear ? eLin : eGam;
                if (e > Tolerance)
                {
                    problems++;
                    r.AppendLine($"  ✗ {key} 颜色 {Fmt(spec.tint)} texel {Fmt(Texels[c])}:读到 {Fmt(got)},公式 {Fmt(linear ? lin : gam)},差 {e * 255:F1}/255");
                }
            }
        }
        r.AppendLine();
        r.AppendLine($"每种「模式 × 渲染器」的最大误差(/255),容差 {Tolerance * 255:F1}:按线性空间公式 | 按 gamma 空间公式");
        foreach (var kv in worst)
        {
            float e = linear ? kv.Value.linear : kv.Value.gamma;
            r.AppendLine($"  {(e <= Tolerance ? "✓" : "✗")} {kv.Key}  {kv.Value.linear * 255,6:F1} | {kv.Value.gamma * 255,6:F1}");
        }
        r.AppendLine(problems == 0 ? "\n✓ 全部与 Spine 的公式一致" : $"\n✗ {problems} 格对不上");
    }

    /** Spine 的公式。linearSpace:按 Unity Linear 工程的实际管线算 —— 贴图、背景、m_Color 先解码成线性再混合,结果编码回 sRGB;顶点色不解码 */
    static Color Expected(string mode, Color texel, Color tint, bool linearSpace, bool vertexTint)
    {
        Func<float, float> dec = v => linearSpace ? Mathf.GammaToLinearSpace(v) : v;
        Func<float, float> enc = v => linearSpace ? Mathf.LinearToGammaSpace(v) : v;
        float a = texel.a * tint.a;
        var o = new Color(0, 0, 0, 1);
        for (int i = 0; i < 3; i++)
        {
            float t = vertexTint ? tint[i] : dec(tint[i]);
            float s = dec(texel[i]) * t;
            float d = dec(Dst[i]);
            float v = mode switch
            {
                "normal" => s * a + d * (1 - a),
                "additive" => s * a + d,
                "multiply" => d * Mathf.Lerp(1, s, a),
                "screen" => s * a + d * (1 - s * a),
                _ => throw new ArgumentException(mode),
            };
            o[i] = enc(Mathf.Clamp01(v));
        }
        return o;
    }

    static float MaxDiff(Color x, Color y) => Mathf.Max(Mathf.Abs(x.r - y.r), Mathf.Abs(x.g - y.g), Mathf.Abs(x.b - y.b));
    static string Fmt(Color c) => $"({c.r:F3}, {c.g:F3}, {c.b:F3}, {c.a:F2})";
}
