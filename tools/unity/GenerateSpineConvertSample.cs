// 放到 Unity 工程的 Assets/Editor/ 下,然后点菜单:Tools ▸ 生成 Spine 转换参考样本
//
// 它会在 Assets/Res/test/_sample/ 下生成一套资源,用来把「Unity 到底怎么序列化
// 换图动画」这件事定死 —— 我们的转换器要照着写出同样的文件。
//
// 生成两种换图机制各一份,因为不确定你们会用哪种:
//   1. 直接换 SpriteRenderer.m_Sprite(经典做法,走 PPtr 曲线)
//   2. 换 SpriteResolver 的 Category/Label(2D Animation 的做法,走 SpriteLibrary)
//
// 生成完把整个 _sample 目录发回来即可。用完可以直接删掉。

using System.IO;
using UnityEditor;
using UnityEngine;

#if UNITY_2D_ANIMATION
using UnityEngine.U2D.Animation;
#endif

public static class GenerateSpineConvertSample
{
    const string SourceTexture = "Assets/Res/test/test.png";
    const string OutputDir = "Assets/Res/test/_sample";

    [MenuItem("Tools/生成 Spine 转换参考样本")]
    public static void Generate()
    {
        var sprites = LoadSprites();
        if (sprites.Length < 2)
        {
            EditorUtility.DisplayDialog(
                "找不到素材",
                $"{SourceTexture} 里至少要有 2 个 sprite。\n" +
                "请确认该图是 Multiple 模式且已切好。",
                "知道了");
            return;
        }

        Directory.CreateDirectory(OutputDir);

        var go = new GameObject("SampleCharacter");
        var renderer = go.AddComponent<SpriteRenderer>();
        renderer.sprite = sprites[0];

        // 建两根子骨骼,验证 Transform 动画曲线的路径写法
        var boneA = new GameObject("bone_1").transform;
        boneA.SetParent(go.transform, false);
        boneA.localPosition = new Vector3(0.5f, 0.25f, 0f);
        var boneB = new GameObject("bone_2").transform;
        boneB.SetParent(boneA, false);
        boneB.localPosition = new Vector3(0.3f, 0f, 0f);
        boneB.localRotation = Quaternion.Euler(0f, 0f, 30f);

        BuildSpriteRendererSwapClip(go, sprites);
        BuildLibrarySwapClip(go, sprites);

        var prefabPath = $"{OutputDir}/SampleCharacter.prefab";
        PrefabUtility.SaveAsPrefabAsset(go, prefabPath);
        Object.DestroyImmediate(go);

        AssetDatabase.SaveAssets();
        AssetDatabase.Refresh();

        EditorUtility.DisplayDialog(
            "生成完毕",
            $"资源已写到 {OutputDir}\n\n把整个 _sample 目录发回去即可。",
            "好");
        EditorUtility.RevealInFinder(Path.GetFullPath(OutputDir));
    }

    static Sprite[] LoadSprites()
    {
        var all = AssetDatabase.LoadAllAssetsAtPath(SourceTexture);
        var list = new System.Collections.Generic.List<Sprite>();
        foreach (var o in all)
        {
            if (o is Sprite s) list.Add(s);
        }
        return list.ToArray();
    }

    /// 机制 1:直接给 SpriteRenderer.m_Sprite 打 PPtr 关键帧
    static void BuildSpriteRendererSwapClip(GameObject root, Sprite[] sprites)
    {
        var clip = new AnimationClip { frameRate = 30f };

        // 换图:PPtr 曲线
        var binding = new EditorCurveBinding
        {
            path = "",
            type = typeof(SpriteRenderer),
            propertyName = "m_Sprite",
        };
        var keys = new[]
        {
            new ObjectReferenceKeyframe { time = 0f, value = sprites[0] },
            new ObjectReferenceKeyframe { time = 0.5f, value = sprites[1 % sprites.Length] },
        };
        AnimationUtility.SetObjectReferenceCurve(clip, binding, keys);

        // 骨骼动画:位置 + 旋转 + 缩放,顺便验证曲线切线的写法
        var move = new AnimationCurve(
            new Keyframe(0f, 0f),
            new Keyframe(0.5f, 1.5f, 2f, 2f),   // 带切线,用来对照 Spine 的贝塞尔
            new Keyframe(1f, 0f));
        clip.SetCurve("bone_1", typeof(Transform), "m_LocalPosition.x", move);
        clip.SetCurve("bone_1", typeof(Transform), "localEulerAnglesRaw.z",
            AnimationCurve.Linear(0f, 0f, 1f, 90f));
        clip.SetCurve("bone_1/bone_2", typeof(Transform), "m_LocalScale.x",
            AnimationCurve.EaseInOut(0f, 1f, 1f, 2f));

        AssetDatabase.CreateAsset(clip, $"{OutputDir}/Swap_SpriteRenderer.anim");
    }

    /// 机制 2:SpriteLibrary + SpriteResolver 换图
    static void BuildLibrarySwapClip(GameObject root, Sprite[] sprites)
    {
#if UNITY_2D_ANIMATION
        var library = ScriptableObject.CreateInstance<SpriteLibraryAsset>();
        library.AddCategoryLabel(sprites[0], "body", "a");
        library.AddCategoryLabel(sprites[1 % sprites.Length], "body", "b");
        AssetDatabase.CreateAsset(library, $"{OutputDir}/SampleLibrary.asset");

        var lib = root.AddComponent<SpriteLibrary>();
        lib.spriteLibraryAsset = library;
        var resolver = root.AddComponent<SpriteResolver>();
        resolver.SetCategoryAndLabel("body", "a");

        var clip = new AnimationClip { frameRate = 30f };
        // SpriteResolver 的换图是靠一个内部 hash 字段驱动的,这里录两帧,
        // 让 Unity 自己决定写成什么形式 —— 那正是我们要看的东西
        var bindings = AnimationUtility.GetAnimatableBindings(root, root);
        foreach (var b in bindings)
        {
            if (b.type != typeof(SpriteResolver)) continue;
            AnimationUtility.SetEditorCurve(clip, b, new AnimationCurve(
                new Keyframe(0f, 0f), new Keyframe(0.5f, 1f)));
        }
        AssetDatabase.CreateAsset(clip, $"{OutputDir}/Swap_SpriteResolver.anim");
#else
        Debug.LogWarning(
            "未检测到 2D Animation 包的宏,跳过 SpriteLibrary 部分。" +
            "若确实装了该包,可忽略——SpriteRenderer 那份样本已足够开工。");
#endif
    }
}
