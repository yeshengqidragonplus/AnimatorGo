using System;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;
using UnityEngine;

/// <summary>
/// 排查「同一个实例运行时换皮肤」的方案:两个互相独立的显隐开关 + Animator 分层,零运行时脚本。
///
///   渲染器 m_Enabled   ← 基础层:换图时间轴的阶梯曲线(对应 Spine 按键名亮灭)
///   GameObject m_IsActive ← 皮肤层(override,权重 1):每套皮肤一个状态,一条静态 clip
///                             把所有皮肤节点按该皮肤该亮的设好(对应 Spine 的 SetSkin)
///   切皮肤 = animator.Play("皮肤名", 1)
///
/// 要验的事实:
///  Q1 SpriteRenderer / SkinnedMeshRenderer 的 m_Enabled 能被曲线驱动,且 Animation 窗口里选得到
///  Q2 皮肤层能只管 m_IsActive、不干扰基础层;切状态后立即生效;切回去也对
///  Q3 被皮肤层灭掉的物体,基础层对它渲染器 m_Enabled 的曲线在重新点亮后仍然生效
///  Q4 渲染结果与预期一致(渲染到 RenderTexture 读像素)
///
/// 批处理:Unity.exe -batchmode -quit -projectPath 工程 -executeMethod AnimatorGoProbeSkin.Probe -logFile 日志
/// (要渲染,不能加 -nographics)
/// </summary>
public static class AnimatorGoProbeSkin
{
    const string Dir = "Assets/AnimatorGoProbe/Skin";

    [MenuItem("Tools/AnimatorGo/排查 运行时换皮肤")]
    public static void Probe()
    {
        var report = new StringBuilder();
        int problems = 0;
        try { Run(report, ref problems); }
        catch (Exception e) { report.AppendLine("✗ 异常:" + e); problems++; }

        string text = report.ToString();
        Debug.Log(text);
        Directory.CreateDirectory("Assets/AnimatorGoProbe");
        File.WriteAllText("Assets/AnimatorGoProbe/skin-report.txt", text);
        AssetDatabase.SaveAssets();
        if (Application.isBatchMode) EditorApplication.Exit(problems == 0 ? 0 : 1);
    }

    static void Run(StringBuilder r, ref int problems)
    {
        if (!AssetDatabase.IsValidFolder("Assets/AnimatorGoProbe")) AssetDatabase.CreateFolder("Assets", "AnimatorGoProbe");
        if (!AssetDatabase.IsValidFolder(Dir)) AssetDatabase.CreateFolder("Assets/AnimatorGoProbe", "Skin");
        EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        r.AppendLine($"Unity {Application.unityVersion}");

        // ── 材质与图 ──
        var mat = AssetDatabase.LoadAssetAtPath<Material>("Packages/com.unity.render-pipelines.universal/Runtime/Materials/Sprite-Unlit-Default.mat");
        if (mat == null) mat = new Material(Shader.Find("Sprites/Default"));
        var white = new Texture2D(8, 8, TextureFormat.RGBA32, false);
        white.SetPixels(Enumerable.Repeat(Color.white, 64).ToArray());
        white.Apply();
        var sprite = Sprite.Create(white, new Rect(0, 0, 8, 8), new Vector2(0.5f, 0.5f), 4f); // 2×2 单位

        // ── 层级:root(Animator)下四个挂图节点,横向排开 ──
        //   base:默认皮肤的部件,基础层用 m_Enabled 亮灭它(模拟换图时间轴)
        //   skinned:同上,但是 SkinnedMeshRenderer
        //   A / B:两套皮肤各一件,皮肤层用 m_IsActive 选
        var root = new GameObject("probe");
        var animator = root.AddComponent<Animator>();
        animator.cullingMode = AnimatorCullingMode.AlwaysAnimate;

        SpriteRenderer MakeSprite(string name, float x, Color color)
        {
            var go = new GameObject(name);
            go.transform.SetParent(root.transform, false);
            go.transform.localPosition = new Vector3(x, 0, 0);
            var sr = go.AddComponent<SpriteRenderer>();
            sr.sprite = sprite;
            sr.color = color;
            sr.sharedMaterial = mat;
            return sr;
        }
        var baseSr = MakeSprite("base", -4.5f, Color.red);
        var a = MakeSprite("A", 1.5f, Color.green);
        var b = MakeSprite("B", 4.5f, Color.blue);
        b.gameObject.SetActive(false); // 初始皮肤是 A

        var quad = new Mesh { name = "quad" };
        quad.vertices = new[] { new Vector3(-1, -1, 0), new Vector3(1, -1, 0), new Vector3(-1, 1, 0), new Vector3(1, 1, 0) };
        quad.uv = new[] { new Vector2(0, 0), new Vector2(1, 0), new Vector2(0, 1), new Vector2(1, 1) };
        quad.colors32 = Enumerable.Repeat(new Color32(255, 0, 255, 255), 4).ToArray();
        quad.triangles = new[] { 0, 2, 1, 1, 2, 3 };
        quad.boneWeights = Enumerable.Repeat(new BoneWeight { boneIndex0 = 0, weight0 = 1f }, 4).ToArray();
        quad.bindposes = new[] { Matrix4x4.identity };
        quad.RecalculateBounds();
        var skinnedGo = new GameObject("skinned");
        skinnedGo.transform.SetParent(root.transform, false);
        skinnedGo.transform.localPosition = new Vector3(-1.5f, 0, 0);
        var bone = new GameObject("bone").transform;
        bone.SetParent(skinnedGo.transform, false);
        var smr = skinnedGo.AddComponent<SkinnedMeshRenderer>();
        smr.sharedMesh = quad;
        smr.bones = new[] { bone };
        smr.rootBone = bone;
        smr.sharedMaterial = mat;
        var texMat = new Material(mat) { mainTexture = white };
        smr.sharedMaterial = texMat;

        // ── Q1:m_Enabled 在 Animation 窗口里选得到吗 ──
        var bindings = AnimationUtility.GetAnimatableBindings(baseSr.gameObject, root)
            .Concat(AnimationUtility.GetAnimatableBindings(skinnedGo, root))
            .Where(bd => bd.propertyName == "m_Enabled")
            .Select(bd => bd.type.Name)
            .Distinct()
            .ToArray();
        Line(r, ref problems, bindings.Contains("SpriteRenderer") && bindings.Contains("SkinnedMeshRenderer"),
            $"Q1 Animation 窗口可选 m_Enabled 的渲染器:{string.Join(", ", bindings)}(期望含 SpriteRenderer 与 SkinnedMeshRenderer)");

        // ── 剪辑 ──
        // 基础层:base 与 skinned 的 m_Enabled 阶梯曲线 1 → 0 → 1(0 / 0.5 / 1.0 秒),长 1.5 秒
        var swap = new AnimationClip { name = "base_swap" };
        // 最后补一个 1.5s 的键撑长度。⚠️ 别用 Transform 的单分量曲线来撑 —— Animator 会把没写的分量
        // 当 0 写进去,把物体挪到原点(第一版探针就是这么把 A 采空的)
        var stepped = new AnimationCurve(new Keyframe(0, 1), new Keyframe(0.5f, 0), new Keyframe(1.0f, 1), new Keyframe(1.5f, 1));
        for (int i = 0; i < stepped.length; i++)
        {
            AnimationUtility.SetKeyLeftTangentMode(stepped, i, AnimationUtility.TangentMode.Constant);
            AnimationUtility.SetKeyRightTangentMode(stepped, i, AnimationUtility.TangentMode.Constant);
        }
        AnimationUtility.SetEditorCurve(swap, EditorCurveBinding.FloatCurve("base", typeof(SpriteRenderer), "m_Enabled"), stepped);
        AnimationUtility.SetEditorCurve(swap, EditorCurveBinding.FloatCurve("skinned", typeof(SkinnedMeshRenderer), "m_Enabled"), stepped);
        var swapSettings = AnimationUtility.GetAnimationClipSettings(swap);
        swapSettings.loopTime = true;
        AnimationUtility.SetAnimationClipSettings(swap, swapSettings);

        // 皮肤层:每套皮肤一条静态 clip,只写 m_IsActive
        AnimationClip SkinClip(string name, bool aOn, bool bOn)
        {
            var clip = new AnimationClip { name = name };
            AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve("A", typeof(GameObject), "m_IsActive"), AnimationCurve.Constant(0, 1f / 60, aOn ? 1 : 0));
            AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve("B", typeof(GameObject), "m_IsActive"), AnimationCurve.Constant(0, 1f / 60, bOn ? 1 : 0));
            return clip;
        }
        var skinA = SkinClip("skin_A", true, false);
        var skinB = SkinClip("skin_B", false, true);

        // ── AnimatorController:基础层 + 皮肤层(override,权重 1)──
        string ctrlPath = Dir + "/probe_skin.controller";
        AssetDatabase.DeleteAsset(ctrlPath);
        var controller = AnimatorController.CreateAnimatorControllerAtPath(ctrlPath);
        AssetDatabase.AddObjectToAsset(swap, controller);
        AssetDatabase.AddObjectToAsset(skinA, controller);
        AssetDatabase.AddObjectToAsset(skinB, controller);
        var baseState = controller.layers[0].stateMachine.AddState("base_swap");
        baseState.motion = swap;
        controller.AddLayer("Skin");
        var layers = controller.layers;
        layers[1].defaultWeight = 1f;
        layers[1].blendingMode = AnimatorLayerBlendingMode.Override;
        controller.layers = layers;
        var skinSm = controller.layers[1].stateMachine;
        var stateA = skinSm.AddState("A");
        stateA.motion = skinA;
        var stateB = skinSm.AddState("B");
        stateB.motion = skinB;
        skinSm.defaultState = stateA;
        AssetDatabase.SaveAssets();
        animator.runtimeAnimatorController = controller;

        // ── 相机 → RenderTexture,读四个节点中心的像素 ──
        var cam = new GameObject("cam").AddComponent<Camera>();
        cam.orthographic = true;
        cam.orthographicSize = 2; // 半高 2;RT 128×32 → 半宽 8,x 范围 [-8, 8]
        cam.transform.position = new Vector3(0, 0, -10);
        cam.clearFlags = CameraClearFlags.SolidColor;
        cam.backgroundColor = Color.black;
        var rt = new RenderTexture(128, 32, 24, RenderTextureFormat.ARGB32);
        cam.targetTexture = rt;
        var tex = new Texture2D(128, 32, TextureFormat.RGBA32, false);
        Color At(float x)
        {
            int px = Mathf.RoundToInt((x + 8f) / 16f * 128f);
            return tex.GetPixel(px, 16);
        }
        (Color baseC, Color skinnedC, Color aC, Color bC) Snapshot()
        {
            cam.Render();
            var prev = RenderTexture.active;
            RenderTexture.active = rt;
            tex.ReadPixels(new Rect(0, 0, 128, 32), 0, 0);
            tex.Apply();
            RenderTexture.active = prev;
            // 按物体当前的实际位置采样,免得被动画挪走后采空
            return (At(baseSr.transform.position.x), At(skinnedGo.transform.position.x), At(a.transform.position.x), At(b.transform.position.x));
        }
        bool IsOn(Color c) => c.maxColorComponent > 0.5f;
        string F(Color c) => $"({c.r:F1},{c.g:F1},{c.b:F1})";

        // ── 播放:Animator 在编辑器里手动推进 ──
        animator.Rebind();
        animator.Update(0f);
        animator.Update(0.25f); // 基础层 t=0.25:base/skinned 亮;皮肤层默认 A
        var s1 = Snapshot();
        Line(r, ref problems, IsOn(s1.baseC) && IsOn(s1.skinnedC) && IsOn(s1.aC) && !IsOn(s1.bC),
            $"Q2a t=0.25 皮肤 A:base {F(s1.baseC)} skinned {F(s1.skinnedC)} A {F(s1.aC)} B {F(s1.bC)}(期望 亮 亮 亮 灭)");

        animator.Update(0.5f); // t=0.75:基础层把 base/skinned 灭掉,皮肤不变
        var s2 = Snapshot();
        Line(r, ref problems, !IsOn(s2.baseC) && !IsOn(s2.skinnedC) && IsOn(s2.aC) && !IsOn(s2.bC),
            $"Q2b t=0.75 皮肤 A:base {F(s2.baseC)} skinned {F(s2.skinnedC)} A {F(s2.aC)} B {F(s2.bC)}(期望 灭 灭 亮 灭)—— 两个渲染器的 m_Enabled 都被曲线驱动");

        animator.Play("B", 1); // 切皮肤:皮肤层跳到 B
        animator.Update(0f);
        var s3 = Snapshot();
        Line(r, ref problems, !IsOn(s3.aC) && IsOn(s3.bC) && !IsOn(s3.baseC),
            $"Q2c 切到皮肤 B(t 仍 0.75):A {F(s3.aC)} B {F(s3.bC)} base {F(s3.baseC)}(期望 灭 亮 灭)—— 皮肤层不干扰基础层");
        Line(r, ref problems, !a.gameObject.activeSelf && b.gameObject.activeSelf,
            $"Q2d 切皮肤后 GameObject.activeSelf:A={a.gameObject.activeSelf} B={b.gameObject.activeSelf}(期望 false true)");

        animator.Update(0.5f); // t=1.25:基础层重新点亮 base/skinned
        var s4 = Snapshot();
        Line(r, ref problems, IsOn(s4.baseC) && IsOn(s4.skinnedC) && !IsOn(s4.aC) && IsOn(s4.bC),
            $"Q3  t=1.25 皮肤 B:base {F(s4.baseC)} skinned {F(s4.skinnedC)} A {F(s4.aC)} B {F(s4.bC)}(期望 亮 亮 灭 亮)");

        animator.Play("A", 1); // 切回 A
        animator.Update(0f);
        var s5 = Snapshot();
        Line(r, ref problems, IsOn(s5.aC) && !IsOn(s5.bC) && IsOn(s5.baseC),
            $"Q2e 切回皮肤 A:A {F(s5.aC)} B {F(s5.bC)} base {F(s5.baseC)}(期望 亮 灭 亮)");

        // 皮肤节点自己的渲染器 m_Enabled 若也被基础层动画(皮肤件参与换图时间轴),
        // 灭着的时候写进去、点亮后应该还在 —— 用 B 试:B 灭着时把它 enabled 设 0,再切到 B 看
        b.enabled = false;
        animator.Play("B", 1);
        animator.Update(0f);
        var s6 = Snapshot();
        Line(r, ref problems, !IsOn(s6.bC) && b.gameObject.activeSelf,
            $"Q3b 皮肤开着但渲染器 m_Enabled=0:B {F(s6.bC)} activeSelf={b.gameObject.activeSelf}(期望 灭 true)—— 两个开关确实是 AND");

        cam.targetTexture = null;
        rt.Release();
        r.AppendLine($"产物:{ctrlPath}(两层 controller 的 YAML 样本)");
    }

    static void Line(StringBuilder r, ref int problems, bool ok, string text)
    {
        r.AppendLine((ok ? "✅ " : "✗ ") + text);
        if (!ok) problems++;
    }
}
