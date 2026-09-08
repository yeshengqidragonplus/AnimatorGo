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
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
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
            SpriteSkinState state = skin.SetBoneTransforms(skin.boneTransforms);
            if (state != SpriteSkinState.Ready) bad.Add($"{skin.name} → {state}");
        }

        report.AppendLine($"  SpriteSkin {skins.Length} 个,校验不过 {bad.Count} 个");
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
                if (AnimationUtility.GetAnimatedObject(root, b) == null)
                {
                    missing.Add($"{b.path} :: {b.propertyName} ({b.type.Name})");
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

    /// sprite 导入结果:网格 sprite 必须真的带上顶点和三角形
    static int CheckSprites(StringBuilder report)
    {
        string[] texGuids = AssetDatabase.FindAssets("t:Texture2D", new[] { AssetRoot });
        int problems = 0;

        foreach (string guid in texGuids)
        {
            string path = AssetDatabase.GUIDToAssetPath(guid);
            Sprite[] sprites = AssetDatabase.LoadAllAssetsAtPath(path).OfType<Sprite>().ToArray();
            // 默认矩形是 2 个三角形 = 6 个下标,多于 6 说明自定义网格生效了
            int meshed = sprites.Count(s => s.triangles.Length > 6);
            var empty = sprites.Where(s => s.vertices.Length == 0).Select(s => s.name).ToList();

            report.AppendLine(
                $"── {System.IO.Path.GetFileName(path)} ── sprite {sprites.Length} 个,"
                + $"带自定义网格的 {meshed} 个,顶点为空的 {empty.Count} 个");
            foreach (string name in empty) report.AppendLine($"    ✗ {name} 没有顶点");
            problems += empty.Count;
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
