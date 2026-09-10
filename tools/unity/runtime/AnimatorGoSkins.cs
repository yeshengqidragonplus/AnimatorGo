using System;
using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// 运行时换皮肤(带脚本模式,`pnpm unity --skins script` 生成的 prefab 才挂它)。
///
/// 零脚本模式下皮肤是 Animator 的一层,所有皮肤的 sprite 都硬引用在 prefab 里,实例化即全部加载。
/// 这个组件把换装件的 sprite / 材质改成**软引用**(资产路径 + GUID + sprite 名),切到哪套才加载哪套,
/// 切走可以卸 —— 代价是产物多依赖这一个脚本。
///
/// 游戏启动时接一次加载器(参数:Assets/ 下的资产路径、子资产名(sprite 名;贴图/材质为 null)、类型):
///
///     AnimatorGoSkins.LoadAsset = (path, sub, type) => MyAssets.Load(path, sub, type);
///     AnimatorGoSkins.UnloadAsset = obj => MyAssets.Release(obj);   // 可不接
///
/// 用 Addressables 的话一行就够(地址默认就是资产路径,子资产用 `路径[名字]`):
///
///     AnimatorGoSkins.LoadAsset = (path, sub, type) =>
///         Addressables.LoadAssetAsync&lt;UnityEngine.Object&gt;(sub == null ? path : $"{path}[{sub}]").WaitForCompletion();
///
/// 编辑器里没接加载器时走 AssetDatabase(按 GUID 找,文件夹挪了也不怕),所以预览与 Play 开箱能用;
/// 打包后没接加载器会报一条明确的错,不静默。
///
/// 切皮肤:GetComponent&lt;AnimatorGoSkins&gt;().SetSkin("Pirate");
/// </summary>
[DisallowMultipleComponent]
public class AnimatorGoSkins : MonoBehaviour
{
    [Serializable]
    public class Node
    {
        public GameObject go;
        /// <summary>属于哪套皮肤;默认皮肤的件填默认皮肤名</summary>
        public string skin;
        public string spriteAsset;
        public string spriteGuid;
        /// <summary>SpriteRenderer 用:贴图里的 sprite 名。SkinnedMeshRenderer 的件留空</summary>
        public string spriteName;
        /// <summary>SkinnedMeshRenderer 用:带贴图的材质</summary>
        public string materialAsset;
        public string materialGuid;
    }

    [Serializable]
    public class Skin
    {
        public string name;
        /// <summary>这套皮肤生效时要灭掉的默认皮肤的件(同 slot 同键名被盖住,Spine 先查皮肤再查默认)</summary>
        public GameObject[] hidden;
    }

    public string defaultSkin;
    public string initialSkin;
    public Node[] nodes;
    public Skin[] skins;

#if UNITY_EDITOR
    /// <summary>编辑器里不用 Play:在 Inspector 里改这个字段就切皮肤看效果(走 AssetDatabase 加载)</summary>
    [Tooltip("编辑器预览:填皮肤名(空 = 默认皮肤),改完立刻切换")]
    public string editorPreviewSkin;
    string m_LastPreview;

    void OnValidate()
    {
        if (Application.isPlaying || editorPreviewSkin == m_LastPreview) return;
        m_LastPreview = editorPreviewSkin;
        if (nodes == null || nodes.Length == 0) return;
        // OnValidate 里不允许直接 SetActive / 改资产引用,推到下一帧
        UnityEditor.EditorApplication.delayCall += () =>
        {
            if (this != null) SetSkin(string.IsNullOrEmpty(editorPreviewSkin) ? defaultSkin : editorPreviewSkin);
        };
    }
#endif

    /// <summary>运行时加载器。参数:资产路径、子资产名(可为 null)、类型。游戏启动时接一次</summary>
    public static Func<string, string, Type, UnityEngine.Object> LoadAsset;
    /// <summary>切走一套皮肤时释放它加载过的资产;不接就不卸</summary>
    public static Action<UnityEngine.Object> UnloadAsset;

    public string CurrentSkin { get; private set; }

    readonly Dictionary<string, List<UnityEngine.Object>> m_Loaded = new Dictionary<string, List<UnityEngine.Object>>();
    static bool s_WarnedNoLoader;

    public IEnumerable<string> SkinNames
    {
        get
        {
            yield return defaultSkin;
            if (skins == null) yield break;
            foreach (Skin s in skins) if (s.name != defaultSkin) yield return s.name;
        }
    }

    void Awake()
    {
        CurrentSkin = defaultSkin;
        if (!string.IsNullOrEmpty(initialSkin) && initialSkin != defaultSkin) SetSkin(initialSkin);
    }

    /// <summary>切到某套皮肤。默认皮肤名 = 只留本体</summary>
    public void SetSkin(string name)
    {
        if (string.IsNullOrEmpty(name)) name = defaultSkin;
        Skin skin = FindSkin(name);
        if (skin == null && name != defaultSkin)
        {
            Debug.LogError($"[AnimatorGoSkins] {gameObject.name} 没有皮肤 \"{name}\",有:{string.Join("、", SkinNames)}", this);
            return;
        }

        string previous = CurrentSkin;
        foreach (Node node in nodes)
        {
            if (node.go == null) continue;
            bool on = node.skin == name || (node.skin == defaultSkin && !IsHidden(skin, node.go));
            if (on && node.skin != defaultSkin) EnsureLoaded(node);
            node.go.SetActive(on);
        }
        CurrentSkin = name;

        if (previous != name && previous != defaultSkin) Release(previous);
    }

    Skin FindSkin(string name)
    {
        if (skins == null) return null;
        foreach (Skin s in skins) if (s.name == name) return s;
        return null;
    }

    static bool IsHidden(Skin skin, GameObject go)
    {
        if (skin == null || skin.hidden == null) return false;
        foreach (GameObject h in skin.hidden) if (h == go) return true;
        return false;
    }

    void EnsureLoaded(Node node)
    {
        var sr = node.go.GetComponent<SpriteRenderer>();
        if (sr != null && sr.sprite == null && !string.IsNullOrEmpty(node.spriteAsset))
        {
            var sprite = Load(node.spriteAsset, node.spriteGuid, node.spriteName, typeof(Sprite)) as Sprite;
            if (sprite != null)
            {
                sr.sprite = sprite;
                Track(node.skin, sprite);
            }
        }
        var smr = node.go.GetComponent<SkinnedMeshRenderer>();
        if (smr != null && smr.sharedMaterial == null && !string.IsNullOrEmpty(node.materialAsset))
        {
            var material = Load(node.materialAsset, node.materialGuid, null, typeof(Material)) as Material;
            if (material != null)
            {
                smr.sharedMaterial = material;
                Track(node.skin, material);
            }
        }
    }

    void Track(string skin, UnityEngine.Object asset)
    {
        if (!m_Loaded.TryGetValue(skin, out List<UnityEngine.Object> list)) m_Loaded[skin] = list = new List<UnityEngine.Object>();
        list.Add(asset);
    }

    /// <summary>释放某套皮肤加载过的资产,并把引用清掉,下次切回来再加载</summary>
    void Release(string skin)
    {
        if (!m_Loaded.TryGetValue(skin, out List<UnityEngine.Object> list)) return;
        foreach (Node node in nodes)
        {
            if (node.skin != skin || node.go == null) continue;
            var sr = node.go.GetComponent<SpriteRenderer>();
            if (sr != null) sr.sprite = null;
            var smr = node.go.GetComponent<SkinnedMeshRenderer>();
            if (smr != null) smr.sharedMaterial = null;
        }
        if (UnloadAsset != null) foreach (UnityEngine.Object asset in list) UnloadAsset(asset);
        m_Loaded.Remove(skin);
    }

    UnityEngine.Object Load(string path, string guid, string sub, Type type)
    {
        if (LoadAsset != null)
        {
            UnityEngine.Object loaded = LoadAsset(path, sub, type);
            if (loaded == null) Debug.LogError($"[AnimatorGoSkins] 加载器没有返回 {type.Name}:{path}{(sub == null ? "" : "[" + sub + "]")}", this);
            return loaded;
        }
#if UNITY_EDITOR
        // 编辑器里没接加载器:走 AssetDatabase,按 GUID 找,文件夹挪了也不怕
        string assetPath = string.IsNullOrEmpty(guid) ? path : UnityEditor.AssetDatabase.GUIDToAssetPath(guid);
        if (string.IsNullOrEmpty(assetPath)) assetPath = path;
        if (sub == null) return UnityEditor.AssetDatabase.LoadAssetAtPath(assetPath, type);
        foreach (UnityEngine.Object rep in UnityEditor.AssetDatabase.LoadAllAssetRepresentationsAtPath(assetPath))
        {
            if (rep != null && rep.name == sub && type.IsInstanceOfType(rep)) return rep;
        }
        Debug.LogError($"[AnimatorGoSkins] {assetPath} 里没有叫 \"{sub}\" 的 {type.Name}", this);
        return null;
#else
        if (!s_WarnedNoLoader)
        {
            s_WarnedNoLoader = true;
            Debug.LogError("[AnimatorGoSkins] 没有接加载器:游戏启动时设置 AnimatorGoSkins.LoadAsset,换装件才加载得出来", this);
        }
        return null;
#endif
    }
}
