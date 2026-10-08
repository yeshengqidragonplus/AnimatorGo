using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.U2D;
using UnityEngine.U2D.Animation;

/// <summary>
/// 把工程里每个 .psb / .psd(2D PSD Importer 导入的角色)**Unity 自己生成的结果**导出成 JSON ——
/// AnimatorGo 的 PSB 读取器(src/spine-convert/unity-import/expandPsd.ts)拿它当标准答案。
///
///   Unity -batchmode -quit -projectPath <工程> -executeMethod AnimatorGoDumpPsd.Dump
///
/// 输出到工程目录下 PsdDump/<文件名>.json(环境变量 ANIMATORGO_PSD_OUT 可改;ANIMATORGO_PSD_PNG=1 顺带存贴图),每个文件包含:
///
/// - nodes:生成的 prefab 里每个物体(相对根物体的路径、局部 TRS、激活、SpriteRenderer、SpriteSkin)
/// - sprites:每个 sprite 的 rect / pivot / ppu / 顶点 / 三角形 / 绑定矩阵 / 权重,以及 rect 内像素的 FNV-1a 指纹
///   (要比像素,贴图得是不压缩、可读的 —— 拷进工程前把 .meta 的 textureCompression 改 0、isReadable 改 1)
/// - clips:同目录树下能绑上这个 prefab 的每条 .anim,在 0、¼、½、¾、1 处 SampleAnimation 后各物体相对根物体的 2D 仿射
/// </summary>
public static class AnimatorGoDumpPsd
{
    [MenuItem("Tools/AnimatorGo/导出 PSD 导入结果")]
    public static void Dump()
    {
        string outDir = OutDir();
        Directory.CreateDirectory(outDir);

        string[] paths = Directory.GetFiles("Assets", "*.*", SearchOption.AllDirectories)
            .Where(p => p.EndsWith(".psb", StringComparison.OrdinalIgnoreCase) || p.EndsWith(".psd", StringComparison.OrdinalIgnoreCase))
            .Select(p => p.Replace('\\', '/'))
            .ToArray();
        int written = 0;
        foreach (string path in paths)
        {
            GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (prefab == null)
            {
                Debug.LogWarning($"AnimatorGo PSD:{path} 没有生成 prefab,跳过");
                continue;
            }
            string json = DumpOne(path, prefab);
            string name = path.Substring("Assets/".Length).Replace('/', '_');
            File.WriteAllText(Path.Combine(outDir, name + ".json"), json, new UTF8Encoding(false));
            written++;
        }
        Debug.Log($"AnimatorGo PSD 导出:{written} 个 → {outDir}");
    }

    static string DumpOne(string path, GameObject prefab)
    {
        StringBuilder sb = new StringBuilder();
        sb.Append("{\n");
        sb.Append($"  \"asset\": {Str(path)},\n");
        sb.Append($"  \"guid\": {Str(AssetDatabase.AssetPathToGUID(path))},\n");

        UnityEngine.Object[] all = AssetDatabase.LoadAllAssetsAtPath(path);
        Texture2D texture = all.OfType<Texture2D>().FirstOrDefault();
        Color32[] pixels = null;
        if (texture != null)
        {
            sb.Append($"  \"texture\": {{ \"name\": {Str(texture.name)}, \"width\": {texture.width}, \"height\": {texture.height}, \"format\": {Str(texture.format.ToString())}, \"readable\": {(texture.isReadable ? "true" : "false")} }},\n");
            if (texture.isReadable)
            {
                pixels = texture.GetPixels32();
                // 排查像素差异用:原样存一张 PNG(贴图得是不压缩的 RGBA32)
                if (Environment.GetEnvironmentVariable("ANIMATORGO_PSD_PNG") == "1")
                {
                    // 导入出来的贴图直接 EncodeToPNG 会返回 null,拷进一张新的 RGBA32 再存
                    Texture2D copy = new Texture2D(texture.width, texture.height, TextureFormat.RGBA32, false);
                    copy.SetPixels32(pixels);
                    File.WriteAllBytes(Path.Combine(OutDir(), path.Substring("Assets/".Length).Replace('/', '_') + ".png"), copy.EncodeToPNG());
                    UnityEngine.Object.DestroyImmediate(copy);
                }
            }
        }

        // ── prefab 里的物体 ──
        List<Transform> order = new List<Transform>();
        Walk(prefab.transform, order);
        sb.Append("  \"nodes\": [\n");
        for (int i = 0; i < order.Count; i++)
        {
            Transform t = order[i];
            sb.Append("    { ");
            sb.Append($"\"path\": {Str(PathOf(prefab.transform, t))}, \"name\": {Str(t.name)}, \"active\": {(t.gameObject.activeSelf ? "true" : "false")}, ");
            sb.Append($"\"pos\": {Vec(t.localPosition)}, \"rot\": [{F(t.localRotation.x)}, {F(t.localRotation.y)}, {F(t.localRotation.z)}, {F(t.localRotation.w)}], \"scale\": {Vec(t.localScale)}");
            SpriteRenderer sr = t.GetComponent<SpriteRenderer>();
            if (sr != null)
            {
                sb.Append($", \"renderer\": {{ \"sprite\": {Str(sr.sprite != null ? SpriteKey(sr.sprite) : "")}, \"order\": {sr.sortingOrder}, \"layer\": {sr.sortingLayerID}, \"enabled\": {(sr.enabled ? "true" : "false")}, \"color\": [{F(sr.color.r)}, {F(sr.color.g)}, {F(sr.color.b)}, {F(sr.color.a)}] }}");
            }
            SpriteSkin skin = t.GetComponent<SpriteSkin>();
            if (skin != null)
            {
                string bones = string.Join(", ", (skin.boneTransforms ?? new Transform[0]).Select(b => Str(b != null ? PathOf(prefab.transform, b) : "")));
                sb.Append($", \"skin\": {{ \"root\": {Str(skin.rootBone != null ? PathOf(prefab.transform, skin.rootBone) : "")}, \"bones\": [{bones}] }}");
            }
            sb.Append(i + 1 < order.Count ? " },\n" : " }\n");
        }
        sb.Append("  ],\n");

        // ── sprite ──
        Sprite[] sprites = all.OfType<Sprite>().OrderBy(s => s.name, StringComparer.Ordinal).ToArray();
        sb.Append("  \"sprites\": [\n");
        for (int i = 0; i < sprites.Length; i++)
        {
            Sprite s = sprites[i];
            Rect r = s.rect;
            sb.Append("    { ");
            sb.Append($"\"key\": {Str(SpriteKey(s))}, \"name\": {Str(s.name)}, \"rect\": [{F(r.x)}, {F(r.y)}, {F(r.width)}, {F(r.height)}], \"pivot\": [{F(s.pivot.x)}, {F(s.pivot.y)}], \"ppu\": {F(s.pixelsPerUnit)}, ");
            sb.Append($"\"vertices\": [{string.Join(", ", s.vertices.Select(v => $"{F(v.x)}, {F(v.y)}"))}], ");
            sb.Append($"\"triangles\": [{string.Join(", ", s.triangles.Select(x => x.ToString(CultureInfo.InvariantCulture)))}], ");
            var bind = s.GetBindPoses();
            sb.Append($"\"bindposes\": [{string.Join(", ", Enumerable.Range(0, bind.Length).Select(k => Mat(bind[k])))}], ");
            if (s.HasVertexAttribute(VertexAttribute.BlendWeight))
            {
                var w = s.GetVertexAttribute<BoneWeight>(VertexAttribute.BlendWeight);
                sb.Append($"\"weights\": [{string.Join(", ", Enumerable.Range(0, w.Length).Select(k => $"[{w[k].boneIndex0}, {F(w[k].weight0)}, {w[k].boneIndex1}, {F(w[k].weight1)}, {w[k].boneIndex2}, {F(w[k].weight2)}, {w[k].boneIndex3}, {F(w[k].weight3)}]"))}], ");
            }
            sb.Append($"\"pixels\": {(pixels != null ? Fingerprint(pixels, texture.width, r).ToString(CultureInfo.InvariantCulture) : "null")}");
            sb.Append(i + 1 < sprites.Length ? " },\n" : " }\n");
        }
        sb.Append("  ],\n");

        // ── 动画取样 ──
        sb.Append("  \"clips\": [\n");
        GameObject probe = UnityEngine.Object.Instantiate(prefab);
        string root = Path.GetDirectoryName(Path.GetDirectoryName(path)) ?? "Assets";
        List<AnimationClip> clips = Directory.GetFiles(root, "*.anim", SearchOption.AllDirectories)
            .Select(p => AssetDatabase.LoadAssetAtPath<AnimationClip>(p.Replace('\\', '/')))
            .Where(c => c != null && Binds(c, probe))
            .ToList();
        UnityEngine.Object.DestroyImmediate(probe);
        for (int c = 0; c < clips.Count; c++)
        {
            AnimationClip clip = clips[c];
            // 每条动画一个新实例:SampleAnimation 不会把这条动画没碰的属性复原,上一条留下的姿势会混进来
            GameObject instance = UnityEngine.Object.Instantiate(prefab);
            instance.transform.position = Vector3.zero;
            instance.transform.rotation = Quaternion.identity;
            instance.transform.localScale = Vector3.one;
            List<Transform> instOrder = new List<Transform>();
            Walk(instance.transform, instOrder);
            sb.Append($"    {{ \"name\": {Str(clip.name)}, \"length\": {F(clip.length)}, \"samples\": [\n");
            for (int k = 0; k <= 4; k++)
            {
                float time = clip.length * k / 4f;
                clip.SampleAnimation(instance, time);
                Matrix4x4 rootInv = instance.transform.worldToLocalMatrix;
                sb.Append($"      {{ \"t\": {F(time)}, \"world\": {{ ");
                sb.Append(string.Join(", ", instOrder.Select(t =>
                {
                    Matrix4x4 m = rootInv * t.localToWorldMatrix;
                    return $"{Str(PathOf(instance.transform, t))}: [{F(m.m00)}, {F(m.m01)}, {F(m.m10)}, {F(m.m11)}, {F(m.m03)}, {F(m.m13)}]";
                })));
                sb.Append(k < 4 ? " } },\n" : " } }\n");
            }
            sb.Append(c + 1 < clips.Count ? "    ] },\n" : "    ] }\n");
            UnityEngine.Object.DestroyImmediate(instance);
        }
        sb.Append("  ]\n}\n");
        return sb.ToString();
    }

    static string OutDir()
    {
        string outDir = Environment.GetEnvironmentVariable("ANIMATORGO_PSD_OUT");
        return string.IsNullOrEmpty(outDir) ? Path.Combine(Directory.GetCurrentDirectory(), "PsdDump") : outDir;
    }

    /// <summary>clip 的曲线大半能绑上这个物体,才算它的动画</summary>
    static bool Binds(AnimationClip clip, GameObject go)
    {
        EditorCurveBinding[] bindings = AnimationUtility.GetCurveBindings(clip);
        if (bindings.Length == 0)
            return false;
        int hit = bindings.Count(b => AnimationUtility.GetAnimatedObject(go, b) != null);
        return hit * 2 > bindings.Length;
    }

    static void Walk(Transform t, List<Transform> order)
    {
        order.Add(t);
        for (int i = 0; i < t.childCount; i++)
            Walk(t.GetChild(i), order);
    }

    static string PathOf(Transform root, Transform t)
    {
        if (t == root)
            return "";
        List<string> parts = new List<string>();
        for (Transform x = t; x != null && x != root; x = x.parent)
            parts.Add(x.name);
        parts.Reverse();
        return string.Join("/", parts);
    }

    /// <summary>sprite 在资产里的 fileID —— .anim / 场景引用它用的就是这个</summary>
    static string SpriteKey(Sprite s)
    {
        return AssetDatabase.TryGetGUIDAndLocalFileIdentifier(s, out string guid, out long id) ? $"{guid}:{id}" : s.name;
    }

    /// <summary>
    /// rect 内像素的 FNV-1a(32 位),逐行从下到上、每行从左到右,每像素 RGBA 四个字节。
    /// 完全透明的像素按 (0,0,0,0) 算 —— 贴图导入的 Alpha Is Transparency 会往透明像素里渗颜色,看不见,不算差异
    /// </summary>
    static uint Fingerprint(Color32[] pixels, int width, Rect r)
    {
        uint h = 2166136261;
        for (int y = (int)r.y; y < (int)(r.y + r.height); y++)
        {
            for (int x = (int)r.x; x < (int)(r.x + r.width); x++)
            {
                Color32 c = pixels[y * width + x];
                if (c.a == 0)
                    c = new Color32(0, 0, 0, 0);
                h = (h ^ c.r) * 16777619;
                h = (h ^ c.g) * 16777619;
                h = (h ^ c.b) * 16777619;
                h = (h ^ c.a) * 16777619;
            }
        }
        return h;
    }

    static string Mat(Matrix4x4 m)
    {
        return $"[{F(m.m00)}, {F(m.m01)}, {F(m.m02)}, {F(m.m03)}, {F(m.m10)}, {F(m.m11)}, {F(m.m12)}, {F(m.m13)}, {F(m.m20)}, {F(m.m21)}, {F(m.m22)}, {F(m.m23)}]";
    }

    static string Vec(Vector3 v) => $"[{F(v.x)}, {F(v.y)}, {F(v.z)}]";

    static string F(float v) => v.ToString("R", CultureInfo.InvariantCulture);

    static string Str(string s)
    {
        StringBuilder sb = new StringBuilder("\"");
        foreach (char ch in s)
        {
            if (ch == '"' || ch == '\\')
                sb.Append('\\').Append(ch);
            else if (ch < 0x20)
                sb.Append($"\\u{(int)ch:x4}");
            else
                sb.Append(ch);
        }
        return sb.Append('"').ToString();
    }
}
