using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Unity.Collections;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;

/// <summary>
/// 排查「deform → SkinnedMeshRenderer + Blend Shape」路线里几个只有 Unity 自己知道的事实。
/// 用 Unity 自己的 API 造出资产,回读并做数值验证,报告写到 Assets/AnimatorGoProbe/report.txt。
///
///  Q1 Mesh .asset 的 YAML 长什么样(顶点流、权重、绑定矩阵、形变目标)—— 看产物文件
///  Q2 每顶点 >4 根骨骼能否存进资产并真的参与蒙皮
///  Q3 Blend Shape 增量是「加完再蒙皮」还是「蒙皮后再加」
///  Q4 m_SortingOrder 能否被动画曲线驱动(SpriteRenderer / SkinnedMeshRenderer)
///  Q5 blendShape 权重曲线能否驱动、在 .anim 里怎么写
///  Q6 绑定矩阵里的非等比缩放会不会被吃掉
///  Q7 SkinnedMeshRenderer 用 Sprite 材质渲染,与 SpriteRenderer 之间 sortingOrder 是否互通
///  Q8 SkinnedMeshRenderer 在 prefab 里怎么写 —— 看产物文件
///
/// 批处理:Unity.exe -batchmode -quit -projectPath 工程 -executeMethod AnimatorGoProbe.Probe -logFile 日志
/// (Q7 要渲染,不能加 -nographics)
/// </summary>
public static class AnimatorGoProbe
{
    const string Dir = "Assets/AnimatorGoProbe";
    const float Tol = 1e-3f;

    [MenuItem("Tools/AnimatorGo/排查 Blend Shape 路线")]
    public static void Probe()
    {
        var report = new StringBuilder();
        int problems = 0;

        try { Structural(report, ref problems); }
        catch (Exception e) { report.AppendLine("✗ 结构排查异常:" + e); problems++; }

        try { Sorting(report, ref problems); }
        catch (Exception e) { report.AppendLine("✗ 排序排查异常:" + e); problems++; }

        string text = report.ToString();
        Debug.Log(text);
        Directory.CreateDirectory(Dir);
        File.WriteAllText(Dir + "/report.txt", text);
        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();
        if (Application.isBatchMode) EditorApplication.Exit(problems == 0 ? 0 : 1);
    }

    // ────────────────────────────────────────────────────────────────────────
    //  Q1 – Q6, Q8
    // ────────────────────────────────────────────────────────────────────────
    static void Structural(StringBuilder r, ref int problems)
    {
        EditorSettings.serializationMode = SerializationMode.ForceText;
        QualitySettings.skinWeights = SkinWeights.Unlimited;
        if (!AssetDatabase.IsValidFolder(Dir)) AssetDatabase.CreateFolder("Assets", "AnimatorGoProbe");
        EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

        r.AppendLine($"Unity {Application.unityVersion}");
        r.AppendLine();

        // ── 骨架:root 下 6 根骨骼,b1 带非等比缩放(考 Q6) ──
        var root = new GameObject("probe");
        var bones = new Transform[6];
        for (int i = 0; i < bones.Length; i++)
        {
            var b = new GameObject("b" + i).transform;
            b.SetParent(root.transform, false);
            b.localPosition = new Vector3(i * 0.25f, i * 0.5f, 0);
            b.localRotation = Quaternion.Euler(0, 0, i * 10f);
            b.localScale = i == 1 ? new Vector3(2f, 0.5f, 1f) : Vector3.one;
            bones[i] = b;
        }

        // ── Mesh:一条竖着的带子,6 顶点 4 三角 ──
        var mesh = new Mesh { name = "probe_mesh" };
        var verts = new[]
        {
            new Vector3(-0.5f, 0, 0), new Vector3(0.5f, 0, 0),
            new Vector3(-0.5f, 1, 0), new Vector3(0.5f, 1, 0),
            new Vector3(-0.5f, 2, 0), new Vector3(0.5f, 2, 0),
        };
        mesh.vertices = verts;
        mesh.uv = verts.Select(v => new Vector2(v.x + 0.5f, v.y * 0.5f)).ToArray();
        mesh.colors32 = Enumerable.Repeat(new Color32(255, 255, 255, 255), verts.Length).ToArray();
        mesh.triangles = new[] { 0, 2, 1, 1, 2, 3, 2, 4, 3, 3, 4, 5 };
        mesh.bindposes = bones.Select(b => b.worldToLocalMatrix * root.transform.localToWorldMatrix).ToArray();

        // 权重:v0,v1 → b0;v2,v3 → b1(考 Q6);v4 → b2(考 Q3);v5 → 6 根骨骼(考 Q2)
        var perVertex = new List<byte>();
        var weights = new List<BoneWeight1>();
        void Bind(params (int bone, float w)[] ws)
        {
            perVertex.Add((byte)ws.Length);
            foreach (var (bone, w) in ws.OrderByDescending(x => x.w))
                weights.Add(new BoneWeight1 { boneIndex = bone, weight = w });
        }
        Bind((0, 1f));
        Bind((0, 1f));
        Bind((1, 1f));
        Bind((1, 1f));
        Bind((2, 1f));
        Bind((0, 0.30f), (1, 0.25f), (2, 0.20f), (3, 0.10f), (4, 0.09f), (5, 0.06f));
        using (var pv = new NativeArray<byte>(perVertex.ToArray(), Allocator.Temp))
        using (var bw = new NativeArray<BoneWeight1>(weights.ToArray(), Allocator.Temp))
            mesh.SetBoneWeights(pv, bw);

        // 两个形变目标:shape0 把 v4,v5 往 +x 推 1;shape1 把 v0 往 -y 推 1
        var d0 = new Vector3[verts.Length];
        d0[4] = new Vector3(1, 0, 0);
        d0[5] = new Vector3(1, 0, 0);
        var d1 = new Vector3[verts.Length];
        d1[0] = new Vector3(0, -1, 0);
        mesh.AddBlendShapeFrame("shape0", 100f, d0, null, null);
        mesh.AddBlendShapeFrame("shape1", 100f, d1, null, null);
        mesh.RecalculateBounds();

        string meshPath = Dir + "/probe_mesh.asset";
        AssetDatabase.DeleteAsset(meshPath);
        AssetDatabase.CreateAsset(mesh, meshPath);
        AssetDatabase.SaveAssets();

        // ── SkinnedMeshRenderer ──
        var skinGo = new GameObject("skin");
        skinGo.transform.SetParent(root.transform, false);
        var smr = skinGo.AddComponent<SkinnedMeshRenderer>();
        smr.sharedMesh = mesh;
        smr.bones = bones;
        smr.rootBone = bones[0];
        smr.quality = SkinQuality.Auto;

        var baked = new Mesh();

        // Q6:绑定姿势下蒙皮 = 原顶点。b1 的绑定含 2×0.5 的非等比缩放,若 Unity 把缩放吃掉,v2/v3 会错
        smr.BakeMesh(baked);
        float e6 = MaxErr(baked.vertices, verts);
        Line(r, ref problems, e6 < Tol,
            $"Q6 绑定矩阵含非等比缩放(2×0.5)时,绑定姿势下蒙皮结果等于原顶点:最大误差 {e6:F5}");

        // Q2:v5 绑了 6 根骨骼。把权重最小的 b5(0.06)挪 10,若只用 4 根,v5 少挪 0.6
        bones[5].localPosition += new Vector3(10, 0, 0);
        smr.BakeMesh(baked);
        var expected = Skin(mesh, bones, root.transform, verts);
        float e2 = MaxErr(baked.vertices, expected);
        Line(r, ref problems, e2 < Tol,
            $"Q2 每顶点 6 根骨骼,第 5、6 根真的参与蒙皮(skinWeights=Unlimited):误差 {e2:F5},v5 = {F(baked.vertices[5])}");
        QualitySettings.skinWeights = SkinWeights.FourBones;
        smr.BakeMesh(baked);
        float e2b = MaxErr(baked.vertices, expected);
        r.AppendLine($"    参考:skinWeights=FourBones 时误差 {e2b:F5}(>0 说明工程 Quality 必须设 Unlimited 才生效)");
        QualitySettings.skinWeights = SkinWeights.Unlimited;
        bones[5].localPosition -= new Vector3(10, 0, 0);

        // Q3:b2 转 90°,shape0 权重 100。「加完再蒙皮」时增量会跟着骨骼转
        bones[2].localRotation = bones[2].localRotation * Quaternion.Euler(0, 0, 90f);
        smr.SetBlendShapeWeight(0, 100f);
        smr.BakeMesh(baked);
        var withDelta = verts.Select((v, i) => v + d0[i]).ToArray();
        float eAddThenSkin = MaxErr(baked.vertices, Skin(mesh, bones, root.transform, withDelta));
        float eSkinThenAdd = MaxErr(baked.vertices, Skin(mesh, bones, root.transform, verts).Select((v, i) => v + d0[i]).ToArray());
        Line(r, ref problems, eAddThenSkin < Tol,
            $"Q3 Blend Shape 增量「加完再蒙皮」(与 Spine 同序):该假设误差 {eAddThenSkin:F5};「蒙皮后再加」假设误差 {eSkinThenAdd:F5}");

        // Q3b:权重 50 = 半个增量(线性)
        smr.SetBlendShapeWeight(0, 50f);
        smr.BakeMesh(baked);
        var half = verts.Select((v, i) => v + 0.5f * d0[i]).ToArray();
        float eHalf = MaxErr(baked.vertices, Skin(mesh, bones, root.transform, half));
        Line(r, ref problems, eHalf < Tol, $"Q3b 权重 50 → 半个增量(线性):误差 {eHalf:F5}");
        smr.SetBlendShapeWeight(0, 0f);
        bones[2].localRotation = bones[2].localRotation * Quaternion.Euler(0, 0, -90f);

        // Q4 / Q5:曲线能不能驱动 m_SortingOrder 和 blendShape 权重
        var sprGo = new GameObject("spr");
        sprGo.transform.SetParent(root.transform, false);
        var spr = sprGo.AddComponent<SpriteRenderer>();

        var clip = new AnimationClip { name = "probe_clip" };
        AnimationUtility.SetEditorCurve(clip,
            EditorCurveBinding.FloatCurve("spr", typeof(SpriteRenderer), "m_SortingOrder"), AnimationCurve.Linear(0, 0, 1, 5));
        AnimationUtility.SetEditorCurve(clip,
            EditorCurveBinding.FloatCurve("skin", typeof(SkinnedMeshRenderer), "m_SortingOrder"), AnimationCurve.Linear(0, 0, 1, 7));
        AnimationUtility.SetEditorCurve(clip,
            EditorCurveBinding.FloatCurve("skin", typeof(SkinnedMeshRenderer), "blendShape.shape0"), AnimationCurve.Linear(0, 0, 1, 100));

        clip.SampleAnimation(root, 1f);
        Line(r, ref problems, spr.sortingOrder == 5,
            $"Q4 SpriteRenderer.m_SortingOrder 可被曲线驱动:t=1 → {spr.sortingOrder}(期望 5)");
        Line(r, ref problems, smr.sortingOrder == 7,
            $"Q4 SkinnedMeshRenderer.m_SortingOrder 可被曲线驱动:t=1 → {smr.sortingOrder}(期望 7)");
        Line(r, ref problems, Mathf.Abs(smr.GetBlendShapeWeight(0) - 100f) < Tol,
            $"Q5 blendShape.shape0 曲线驱动权重:t=1 → {smr.GetBlendShapeWeight(0)}(期望 100)");
        clip.SampleAnimation(root, 0.5f);
        r.AppendLine($"    参考:t=0.5 时 SpriteRenderer.sortingOrder = {spr.sortingOrder}(float 2.5 → int 的取整方式)");

        var animatable = AnimationUtility.GetAnimatableBindings(sprGo, root)
            .Where(b => b.propertyName.Contains("Sorting"))
            .Select(b => b.type.Name + "." + b.propertyName)
            .ToArray();
        r.AppendLine($"    Animation 窗口可选的 Sorting 相关属性:{(animatable.Length == 0 ? "(没有 —— 曲线能驱动但窗口里选不到)" : string.Join(", ", animatable))}");

        // 存资产,拿 YAML(Q1 / Q5 / Q8)
        string clipPath = Dir + "/probe_clip.anim";
        string prefabPath = Dir + "/probe.prefab";
        AssetDatabase.DeleteAsset(clipPath);
        AssetDatabase.DeleteAsset(prefabPath);
        AssetDatabase.CreateAsset(clip, clipPath);
        PrefabUtility.SaveAsPrefabAsset(root, prefabPath);
        AssetDatabase.SaveAssets();

        // Q1:mesh 资产顶层有哪些段
        string yaml = File.ReadAllText(meshPath);
        var sections = Regex.Matches(yaml, @"^  (m_\w+):", RegexOptions.Multiline).Cast<Match>().Select(m => m.Groups[1].Value).ToArray();
        r.AppendLine();
        r.AppendLine($"Q1 {meshPath}:{new FileInfo(meshPath).Length} 字节,顶层段:{string.Join(" ", sections)}");
        var reloaded = AssetDatabase.LoadAssetAtPath<Mesh>(meshPath);
        var per = reloaded.GetBonesPerVertex();
        r.AppendLine($"    回读:顶点 {reloaded.vertexCount},形变目标 {reloaded.blendShapeCount},绑定矩阵 {reloaded.bindposes.Length},v5 骨骼数 {per[5]}");
        r.AppendLine($"    产物:{clipPath}、{prefabPath}");
    }

    /// <summary>按 Unity 的公式手算蒙皮:Σ wᵢ · (骨骼ᵢ localToWorld · 绑定ᵢ) · v,结果在 root 空间</summary>
    static Vector3[] Skin(Mesh mesh, Transform[] bones, Transform root, Vector3[] baseVerts)
    {
        var per = mesh.GetBonesPerVertex();
        var all = mesh.GetAllBoneWeights();
        var bind = mesh.bindposes;
        var outv = new Vector3[baseVerts.Length];
        int k = 0;
        for (int v = 0; v < baseVerts.Length; v++)
        {
            Vector3 acc = Vector3.zero;
            for (int j = 0; j < per[v]; j++, k++)
            {
                var w = all[k];
                var m = root.worldToLocalMatrix * bones[w.boneIndex].localToWorldMatrix * bind[w.boneIndex];
                acc += w.weight * m.MultiplyPoint3x4(baseVerts[v]);
            }
            outv[v] = acc;
        }
        return outv;
    }

    // ────────────────────────────────────────────────────────────────────────
    //  Q7:渲染出来看排序
    // ────────────────────────────────────────────────────────────────────────
    static void Sorting(StringBuilder r, ref int problems)
    {
        r.AppendLine();
        var rp = GraphicsSettings.currentRenderPipeline;
        r.AppendLine($"Q7 当前渲染管线:{(rp == null ? "内置(Built-in)" : rp.name + " / " + rp.GetType().Name)}");

        EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

        // 材质:URP 的 Sprite-Unlit-Default;找不到就用内置 Sprites/Default
        var mat = AssetDatabase.LoadAssetAtPath<Material>("Packages/com.unity.render-pipelines.universal/Runtime/Materials/Sprite-Unlit-Default.mat");
        if (mat == null) mat = new Material(Shader.Find("Sprites/Default"));
        r.AppendLine($"    材质:{mat.name} / {mat.shader.name}");

        var white = new Texture2D(8, 8, TextureFormat.RGBA32, false);
        white.SetPixels(Enumerable.Repeat(Color.white, 64).ToArray());
        white.Apply();

        // A:SpriteRenderer,红,sortingOrder 1
        var sprite = Sprite.Create(white, new Rect(0, 0, 8, 8), new Vector2(0.5f, 0.5f), 4f); // 2×2 单位
        var a = new GameObject("A").AddComponent<SpriteRenderer>();
        a.sprite = sprite;
        a.color = Color.red;
        a.sharedMaterial = mat;
        a.sortingOrder = 1;

        // B:SkinnedMeshRenderer,绿,一个 2×2 的四边形,1 根骨骼
        var quad = new Mesh { name = "quad" };
        quad.vertices = new[] { new Vector3(-1, -1, 0), new Vector3(1, -1, 0), new Vector3(-1, 1, 0), new Vector3(1, 1, 0) };
        quad.uv = new[] { new Vector2(0, 0), new Vector2(1, 0), new Vector2(0, 1), new Vector2(1, 1) };
        quad.colors32 = Enumerable.Repeat(new Color32(0, 255, 0, 255), 4).ToArray();
        quad.triangles = new[] { 0, 2, 1, 1, 2, 3 };
        quad.boneWeights = Enumerable.Repeat(new BoneWeight { boneIndex0 = 0, weight0 = 1f }, 4).ToArray();
        quad.bindposes = new[] { Matrix4x4.identity };
        quad.RecalculateBounds();
        var bGo = new GameObject("B");
        var bone = new GameObject("bone").transform;
        bone.SetParent(bGo.transform, false);
        var b = bGo.AddComponent<SkinnedMeshRenderer>();
        b.sharedMesh = quad;
        b.bones = new[] { bone };
        b.rootBone = bone;
        b.sharedMaterial = mat;
        b.sortingOrder = 0;

        // 相机 → RenderTexture
        var camGo = new GameObject("cam");
        var cam = camGo.AddComponent<Camera>();
        cam.orthographic = true;
        cam.orthographicSize = 2;
        cam.transform.position = new Vector3(0, 0, -10);
        cam.clearFlags = CameraClearFlags.SolidColor;
        cam.backgroundColor = Color.black;
        var rt = new RenderTexture(32, 32, 24, RenderTextureFormat.ARGB32);
        cam.targetTexture = rt;

        Color Center()
        {
            cam.Render();
            var prev = RenderTexture.active;
            RenderTexture.active = rt;
            var tex = new Texture2D(32, 32, TextureFormat.RGBA32, false);
            tex.ReadPixels(new Rect(0, 0, 32, 32), 0, 0);
            tex.Apply();
            RenderTexture.active = prev;
            return tex.GetPixel(16, 16);
        }

        Color c1 = Center();
        Line(r, ref problems, c1.r > 0.5f && c1.g < 0.5f,
            $"Q7a Sprite(order 1)在 SkinnedMesh(order 0)之上:中心像素 {F(c1)}(期望红)");

        b.sortingOrder = 2;
        Color c2 = Center();
        Line(r, ref problems, c2.g > 0.5f && c2.r < 0.5f,
            $"Q7b SkinnedMesh 改 order 2 后压过 Sprite:中心像素 {F(c2)}(期望绿)");

        // 同 order 时按什么排?把两者 z 相同、order 相同,看谁赢(只记录不判定)
        b.sortingOrder = 1;
        Color c3 = Center();
        r.AppendLine($"    参考:同 order 1 时中心像素 {F(c3)}");

        cam.targetTexture = null;
        rt.Release();
    }

    // ────────────────────────────────────────────────────────────────────────
    static void Line(StringBuilder r, ref int problems, bool ok, string text)
    {
        r.AppendLine((ok ? "✅ " : "✗ ") + text);
        if (!ok) problems++;
    }

    static float MaxErr(Vector3[] a, Vector3[] b)
    {
        float m = 0;
        for (int i = 0; i < a.Length; i++) m = Mathf.Max(m, (a[i] - b[i]).magnitude);
        return m;
    }

    static string F(Vector3 v) => $"({v.x:F3}, {v.y:F3}, {v.z:F3})";
    static string F(Color c) => $"({c.r:F2}, {c.g:F2}, {c.b:F2})";
}
