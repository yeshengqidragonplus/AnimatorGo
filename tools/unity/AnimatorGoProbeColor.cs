using System;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

/// <summary>
/// 排查「颜色写在哪、Unity 怎么解释」:SpriteRenderer 的 <c>m_Color</c> 与 Mesh 的顶点色,在线性色彩空间的工程里
/// 是不是同一个意思。Spine 的颜色是 sRGB(gamma)空间的 —— 走 SkinnedMeshRenderer 的网格把颜色烘进顶点色,
/// 如果 Unity 不把顶点色当 sRGB 换算,同一个颜色两条路径画出来深浅不同。
///
/// 白图上各摆一块:SpriteRenderer 着色 / SkinnedMeshRenderer 顶点色原样 / 顶点色 rgb 先换成线性值,同一组颜色(含 MC2 wave 的 d1c1a4、
/// race_haibao 的 00000049 半透明黑),渲到 RenderTexture 读像素对照。
///
/// 批处理:Unity.exe -batchmode -quit -projectPath 工程 -executeMethod AnimatorGoProbeColor.Probe -logFile 日志
/// (要渲染,不能加 -nographics)。结果写工程目录下 probe-color.txt
/// </summary>
public static class AnimatorGoProbeColor
{
    [MenuItem("Tools/AnimatorGo/排查 颜色空间")]
    public static void Probe()
    {
        var report = new StringBuilder();
        try { Run(report); }
        catch (Exception e) { report.AppendLine("✗ 异常:" + e); }
        string text = report.ToString();
        Debug.Log(text);
        File.WriteAllText("probe-color.txt", text);
        if (Application.isBatchMode) EditorApplication.Exit(0);
    }

    static void Run(StringBuilder r)
    {
        EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        r.AppendLine($"Unity {Application.unityVersion},色彩空间 {PlayerSettings.colorSpace}");

        var mat = AssetDatabase.LoadAssetAtPath<Material>("Packages/com.unity.render-pipelines.universal/Runtime/Materials/Sprite-Unlit-Default.mat");
        if (mat == null) mat = new Material(Shader.Find("Sprites/Default"));
        var white = new Texture2D(8, 8, TextureFormat.RGBA32, false);
        white.SetPixels(Enumerable.Repeat(Color.white, 64).ToArray());
        white.Apply();
        var sprite = Sprite.Create(white, new Rect(0, 0, 8, 8), new Vector2(0.5f, 0.5f), 8f); // 1×1 单位
        var texMat = new Material(mat) { mainTexture = white };

        Color32[] colors =
        {
            new Color32(128, 128, 128, 255),
            new Color32(209, 193, 164, 255), // wave 的 shadow
            new Color32(0, 0, 0, 0x49),      // race_haibao 的 AAyizi
            new Color32(0xeb, 0xe3, 0xbe, 0x80),
        };

        // 背景白:半透明黑叠在白上看得出 alpha 怎么混
        var bg = new GameObject("bg").AddComponent<SpriteRenderer>();
        bg.sprite = sprite;
        bg.sharedMaterial = mat;
        bg.sortingOrder = -10;
        bg.transform.localScale = new Vector3(20, 6, 1);

        void Skinned(string name, Color32 color, Vector3 at)
        {
            var quad = new Mesh { name = name };
            quad.vertices = new[] { new Vector3(-0.5f, -0.5f, 0), new Vector3(0.5f, -0.5f, 0), new Vector3(-0.5f, 0.5f, 0), new Vector3(0.5f, 0.5f, 0) };
            quad.uv = new[] { new Vector2(0, 0), new Vector2(1, 0), new Vector2(0, 1), new Vector2(1, 1) };
            quad.colors32 = Enumerable.Repeat(color, 4).ToArray();
            quad.triangles = new[] { 0, 2, 1, 1, 2, 3 };
            quad.boneWeights = Enumerable.Repeat(new BoneWeight { boneIndex0 = 0, weight0 = 1f }, 4).ToArray();
            quad.bindposes = new[] { Matrix4x4.identity };
            quad.RecalculateBounds();
            var go = new GameObject(name);
            go.transform.position = at;
            var bone = new GameObject("bone").transform;
            bone.SetParent(go.transform, false);
            var smr = go.AddComponent<SkinnedMeshRenderer>();
            smr.sharedMesh = quad;
            smr.bones = new[] { bone };
            smr.rootBone = bone;
            smr.sharedMaterial = texMat;
            smr.forceMatrixRecalculationPerRender = true;
        }

        // 三行:SpriteRenderer 着色 / 顶点色原样 / 顶点色 rgb 先换成线性值(导出器在线性工程里的写法)
        for (int i = 0; i < colors.Length; i++)
        {
            var sr = new GameObject("sprite" + i).AddComponent<SpriteRenderer>();
            sr.sprite = sprite;
            sr.sharedMaterial = mat;
            sr.color = colors[i];
            sr.transform.position = new Vector3(-6 + i * 4, 2, 0);
            Skinned("raw" + i, colors[i], new Vector3(-6 + i * 4, 0, 0));
            Color c = colors[i];
            Skinned("linear" + i, (Color32)new Color(Mathf.GammaToLinearSpace(c.r), Mathf.GammaToLinearSpace(c.g), Mathf.GammaToLinearSpace(c.b), c.a), new Vector3(-6 + i * 4, -2, 0));
        }

        var cam = new GameObject("cam").AddComponent<Camera>();
        cam.orthographic = true;
        cam.orthographicSize = 3;
        cam.transform.position = new Vector3(0, 0, -10);
        cam.clearFlags = CameraClearFlags.SolidColor;
        cam.backgroundColor = Color.black;
        var rt = new RenderTexture(200, 60, 24, RenderTextureFormat.ARGB32); // 每单位 10 像素
        cam.targetTexture = rt;
        cam.Render();
        var tex = new Texture2D(200, 60, TextureFormat.RGBA32, false);
        var prev = RenderTexture.active;
        RenderTexture.active = rt;
        tex.ReadPixels(new Rect(0, 0, 200, 60), 0, 0);
        tex.Apply();
        RenderTexture.active = prev;
        File.WriteAllBytes("probe-color.png", tex.EncodeToPNG());

        Color32 At(float x, float y) => tex.GetPixel(Mathf.RoundToInt((x + 10f) * 10f), Mathf.RoundToInt((y + 3f) * 10f));
        string F(Color32 c) => $"{c.r:x2}{c.g:x2}{c.b:x2}";
        r.AppendLine($"RenderTexture sRGB 读写:{rt.sRGB}");
        for (int i = 0; i < colors.Length; i++)
        {
            float x = -6 + i * 4;
            r.AppendLine($"颜色 {F(colors[i])}{colors[i].a:x2}:SpriteRenderer → {F(At(x, 2))}   顶点色原样 → {F(At(x, 0))}   顶点色换成线性值 → {F(At(x, -2))}");
        }
    }
}
