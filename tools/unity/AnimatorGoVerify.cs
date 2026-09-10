// AnimatorGo 转换产物的 Unity 侧自检。
//
// 转换器那边已经把数学验到亚像素了,但有两类问题**只有 Unity 自己知道**,
// 而且都是不报错的:
//
//   1. 动画曲线的 path 指不到真实物体 —— Unity 直接**忽略这条曲线**,
//      表现是「某个部件就是不动」,控制台一声不响。
//   2. SpriteSkin 校验不过(骨骼数不对、引用为空、权重和不为 1)——
//      表现是网格摊成一团或干脆不显示。
//
// 所以这里把两样都点一遍,数字摆出来。菜单:Tools ▸ AnimatorGo ▸ 检查转换产物
//
// 源码放在仓库的 tools/unity/,用之前拷进 Assets/Editor/ ——
// UnityAnimationGo/Assets/ 整个是 gitignore 掉的。

using System.Collections.Generic;
using System.Linq;
using System.Text;
using Unity.Collections;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.U2D;
using UnityEngine.U2D.Animation;

public static class AnimatorGoVerify
{
    const string AssetRoot = "Assets/AnimatorGo";
    const string ScenePath = "Assets/AnimatorGoVerify.unity";

    [MenuItem("Tools/AnimatorGo/检查转换产物")]
    public static void Verify()
    {
        string[] prefabGuids = FindPrefabs();
        if (prefabGuids == null) return;

        var report = new StringBuilder();
        int problems = 0;

        foreach (string guid in prefabGuids)
        {
            string path = AssetDatabase.GUIDToAssetPath(guid);

            // 用 LoadPrefabContents 而不是往当前场景里 Instantiate ——
            // 后者会把用户正在编辑的场景弄脏
            GameObject root = PrefabUtility.LoadPrefabContents(path);
            try
            {
                report.AppendLine($"── {System.IO.Path.GetFileName(path)} ──");
                problems += CheckSkins(root, report);
                problems += CheckSkinnedMeshes(root, report);
                problems += CheckClips(root, path, report);
                report.AppendLine();
            }
            finally
            {
                PrefabUtility.UnloadPrefabContents(root);
            }
        }

        problems += CheckSprites(report);

        Debug.Log(report.ToString());
        if (problems == 0) Debug.Log("AnimatorGo 自检:全部通过 ✅");
        else Debug.LogError($"AnimatorGo 自检:{problems} 处有问题,详见上面的报告");
    }

    static string[] FindPrefabs()
    {
        if (!AssetDatabase.IsValidFolder(AssetRoot))
        {
            Debug.LogWarning($"没有 {AssetRoot} —— 先跑:pnpm unity res/spine/4.1 --out {AssetRoot}");
            return null;
        }

        string[] guids = AssetDatabase.FindAssets("t:Prefab", new[] { AssetRoot });
        if (guids.Length == 0)
        {
            Debug.LogWarning($"{AssetRoot} 下没有 prefab —— 先跑 pnpm unity 生成");
            return null;
        }
        return guids;
    }

    /// SpriteSkin 的校验状态。SetBoneTransforms 传回它自己现有的数组,
    /// 什么都不改,只为了拿到返回的 SpriteSkinState。
    static int CheckSkins(GameObject root, StringBuilder report)
    {
        SpriteSkin[] skins = root.GetComponentsInChildren<SpriteSkin>(true);
        var bad = new List<string>();

        foreach (SpriteSkin skin in skins)
        {
            // 表情变体、换装件按 setup pose 初始是灭的(m_IsActive 0)。灭着的物体 Awake 没跑过,
            // SpriteSkin 还没拿到自己的 SpriteRenderer,校验会一律报 SpriteNotFound —— 那不是产物的问题。
            // 这是 LoadPrefabContents 出来的临时实例,临时点亮再校验,不影响资产。
            bool wasActive = skin.gameObject.activeSelf;
            if (!wasActive) skin.gameObject.SetActive(true);
            SpriteSkinState state = skin.SetBoneTransforms(skin.boneTransforms);
            if (!wasActive) skin.gameObject.SetActive(false);
            if (state != SpriteSkinState.Ready) bad.Add($"{skin.name} → {state}");
        }

        report.AppendLine($"  SpriteSkin {skins.Length} 个,校验不过 {bad.Count} 个");
        foreach (string line in bad) report.AppendLine($"    ✗ {line}");
        return bad.Count;
    }

    /// 走 SkinnedMeshRenderer 的网格(有 deform / 绑定非刚性 / 缩放不一致的那些)。
    /// Mesh 在不在、骨骼数是否等于绑定矩阵数、材质是否带纹理(不带就是纯白)、形变目标数。
    static int CheckSkinnedMeshes(GameObject root, StringBuilder report)
    {
        SkinnedMeshRenderer[] renderers = root.GetComponentsInChildren<SkinnedMeshRenderer>(true);
        if (renderers.Length == 0) return 0;

        var bad = new List<string>();
        int shapes = 0;
        foreach (SkinnedMeshRenderer r in renderers)
        {
            Mesh mesh = r.sharedMesh;
            if (mesh == null)
            {
                bad.Add($"{r.name}:没有 Mesh");
                continue;
            }
            int boneCount = r.bones == null ? 0 : r.bones.Length;
            if (boneCount != mesh.bindposes.Length) bad.Add($"{r.name}:骨骼 {boneCount} 根 ≠ 绑定矩阵 {mesh.bindposes.Length} 个");
            else if (r.bones.Any(b => b == null)) bad.Add($"{r.name}:有骨骼引用为空");
            if (r.sharedMaterial == null || r.sharedMaterial.mainTexture == null) bad.Add($"{r.name}:材质没有纹理,渲染出来是纯白");

            shapes += mesh.blendShapeCount;
            var per = mesh.GetBonesPerVertex();
            int maxBones = 0;
            for (int i = 0; i < per.Length; i++) maxBones = Mathf.Max(maxBones, per[i]);
            report.AppendLine(
                $"    {r.name}:顶点 {mesh.vertexCount},三角形 {mesh.triangles.Length / 3},骨骼 {mesh.bindposes.Length},"
                + $"每顶点最多 {maxBones} 根,形变目标 {mesh.blendShapeCount},m_Quality {r.quality}"
                + (r.quality == SkinQuality.Auto ? "(跟随工程 Quality 档位)" : ""));
        }

        report.AppendLine($"  SkinnedMeshRenderer {renderers.Length} 个,形变目标共 {shapes} 个,有问题 {bad.Count} 个");
        foreach (string line in bad) report.AppendLine($"    ✗ {line}");
        return bad.Count;
    }

    /// 曲线的 path 能不能指到真实物体。指不到的曲线 Unity 会**静默忽略**。
    static int CheckClips(GameObject root, string prefabPath, StringBuilder report)
    {
        // ⚠️ 不要用 Path.GetDirectoryName —— 它在 Windows 上给反斜杠,而 AssetDatabase
        // 只认正斜杠。资源路径本来就一律是正斜杠,自己切一刀最省事。
        int cut = prefabPath.LastIndexOf('/');
        string folder = cut < 0 ? AssetRoot : prefabPath.Substring(0, cut);
        string[] clipGuids = AssetDatabase.FindAssets("t:AnimationClip", new[] { folder });
        int unresolved = 0;

        foreach (string guid in clipGuids)
        {
            var clip = AssetDatabase.LoadAssetAtPath<AnimationClip>(AssetDatabase.GUIDToAssetPath(guid));
            EditorCurveBinding[] bindings = AnimationUtility.GetCurveBindings(clip);
            EditorCurveBinding[] pptr = AnimationUtility.GetObjectReferenceCurveBindings(clip);

            var missing = new List<string>();
            foreach (EditorCurveBinding b in bindings.Concat(pptr))
            {
                UnityEngine.Object target = AnimationUtility.GetAnimatedObject(root, b);
                if (target == null)
                {
                    missing.Add($"{b.path} :: {b.propertyName} ({b.type.Name})");
                    continue;
                }
                // blendShape.<名> 指到了物体还不够,Mesh 里得真有这个形变目标 —— 没有的话 Unity 同样一声不响
                const string prefix = "blendShape.";
                if (b.propertyName.StartsWith(prefix) && target is SkinnedMeshRenderer smr)
                {
                    string shape = b.propertyName.Substring(prefix.Length);
                    if (smr.sharedMesh == null || smr.sharedMesh.GetBlendShapeIndex(shape) < 0)
                        missing.Add($"{b.path} :: {b.propertyName} —— Mesh 里没有这个形变目标");
                }
            }

            report.AppendLine(
                $"  {clip.name}: {bindings.Length + pptr.Length} 条曲线,时长 {clip.length:0.###}s,"
                + $"指不到物体的 {missing.Count} 条");
            // 同一个 path 错了会牵连一片,只列前几条免得刷屏
            foreach (string line in missing.Take(8)) report.AppendLine($"    ✗ {line}");
            if (missing.Count > 8) report.AppendLine($"    … 另外 {missing.Count - 8} 条");
            unresolved += missing.Count;
        }

        return unresolved;
    }

    /// sprite 的导入结果 —— 逐个把数字摆出来。
    ///
    /// 只说「InvalidBoneWeights」没法定位,因为 Unity 的判据是
    /// **四个 boneIndex 槽位全都要 < bindPose 数**(见 BurstedSpriteSkinUtilities
    /// .ValidateBoneWeights),而且**不看权重是否为 0**。所以这里把
    /// 顶点数 / 三角形数 / 骨骼数 / bindPose 数 / 权重条数 / 最大骨骼下标
    /// 一并列出,一眼能看出是哪一项对不上。
    static int CheckSprites(StringBuilder report)
    {
        string[] texGuids = AssetDatabase.FindAssets("t:Texture2D", new[] { AssetRoot });
        int problems = 0;

        foreach (string guid in texGuids)
        {
            string path = AssetDatabase.GUIDToAssetPath(guid);
            Sprite[] sprites = AssetDatabase.LoadAllAssetsAtPath(path).OfType<Sprite>().ToArray();

            report.AppendLine($"── {System.IO.Path.GetFileName(path)} ── sprite {sprites.Length} 个");
            report.AppendLine("    名字        顶点  三角  骨骼  bindPose  权重  最大下标");

            foreach (Sprite sprite in sprites.OrderBy(s => s.name))
            {
                int vertexCount = sprite.GetVertexCount();
                // 默认矩形是 2 个三角形 = 6 个下标,多于 6 说明自定义网格生效了
                int triangles = sprite.triangles.Length / 3;
                int boneCount = sprite.GetBones().Length;
                int bindPoses = sprite.GetBindPoses().Length;

                int weightCount = 0;
                int maxIndex = -1;
                // ⚠️ 没有骨骼的 sprite 没有 BlendWeight 通道,硬读会拿到别的顶点流
                // (表现是「最大下标」变成十亿级的数 —— 那是浮点位模式被当成整数)
                try
                {
                    if (boneCount == 0) throw new System.InvalidOperationException();
                    NativeSlice<BoneWeight> weights =
                        sprite.GetVertexAttribute<BoneWeight>(VertexAttribute.BlendWeight);
                    weightCount = weights.Length;
                    for (int i = 0; i < weights.Length; i++)
                    {
                        BoneWeight w = weights[i];
                        maxIndex = Mathf.Max(maxIndex,
                            Mathf.Max(w.boneIndex0, w.boneIndex1),
                            Mathf.Max(w.boneIndex2, w.boneIndex3));
                    }
                }
                catch (System.Exception)
                {
                    // 没有 BlendWeight 通道 —— 不加权的 sprite 本来就没有
                }

                var flags = new List<string>();
                if (vertexCount == 0) flags.Add("没有顶点");
                if (boneCount > 0 && bindPoses != boneCount) flags.Add($"bindPose 数与骨骼数不符");
                if (boneCount > 0 && weightCount != vertexCount) flags.Add("权重条数与顶点数不符");
                if (bindPoses > 0 && maxIndex >= bindPoses) flags.Add($"骨骼下标越界({maxIndex} ≥ {bindPoses})");

                report.AppendLine(
                    $"    {sprite.name,-10} {vertexCount,5} {triangles,5} {boneCount,5} "
                    + $"{bindPoses,9} {weightCount,5} {maxIndex,9}"
                    + (flags.Count == 0 ? "" : "   ✗ " + string.Join("、", flags)));
                problems += flags.Count > 0 ? 1 : 0;
            }
        }

        return problems;
    }

    [MenuItem("Tools/AnimatorGo/摆一个对比场景")]
    public static void BuildScene()
    {
        string[] prefabGuids = FindPrefabs();
        if (prefabGuids == null) return;

        // 会新建场景,先给用户机会保存手头的
        if (!EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo()) return;

        var scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);

        // 每个角色横向排开,免得叠在一起看不出谁是谁
        float x = 0f;
        foreach (string guid in prefabGuids)
        {
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(AssetDatabase.GUIDToAssetPath(guid));
            var instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            instance.transform.position = new Vector3(x, 0f, 0f);
            x += 12f;
        }

        Camera camera = Camera.main;
        if (camera != null)
        {
            camera.orthographic = true;
            camera.orthographicSize = 8f;
            camera.transform.position = new Vector3((x - 12f) / 2f, 0f, -10f);
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(0.22f, 0.24f, 0.27f);
        }

        EditorSceneManager.SaveScene(scene, ScenePath);
        Debug.Log($"场景已存到 {ScenePath} —— 直接播就能看");
    }
}
