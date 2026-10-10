// AnimatorGo:Spine 的 additive / multiply / screen 混合。内置管线,SpriteRenderer 和 SkinnedMeshRenderer 共用。
// URP 用 AnimatorGoBlend.shader。
//
// 照内置的 Sprites/Default 只改混合因子:改成材质属性 _SrcBlend / _DstBlend,取 Spine 自己的(预乘颜色):
//   additive  One       One
//   multiply  DstColor  OneMinusSrcAlpha    → dst · lerp(1, src.rgb, src.a)
//   screen    One       OneMinusSrcColor
// alpha 一律 One / _DstBlend(Spine 也是)。UnitySprites.cginc 的 SpriteFrag 本来就输出预乘颜色(rgb × a),不用改
Shader "AnimatorGo/Sprite-Blend (Built-in)"
{
    Properties
    {
        _MainTex ("Sprite Texture", 2D) = "white" {}
        [Enum(UnityEngine.Rendering.BlendMode)] _SrcBlend ("Src Blend", Float) = 1
        [Enum(UnityEngine.Rendering.BlendMode)] _DstBlend ("Dst Blend", Float) = 10
        _Color ("Tint", Color) = (1,1,1,1)
        [MaterialToggle] PixelSnap ("Pixel snap", Float) = 0
        [HideInInspector] _RendererColor ("RendererColor", Color) = (1,1,1,1)
        [HideInInspector] _Flip ("Flip", Vector) = (1,1,1,1)
        [PerRendererData] _AlphaTex ("External Alpha", 2D) = "white" {}
        [PerRendererData] _EnableExternalAlpha ("Enable External Alpha", Float) = 0
    }

    SubShader
    {
        Tags
        {
            "Queue"="Transparent"
            "IgnoreProjector"="True"
            "RenderType"="Transparent"
            "PreviewType"="Plane"
            "CanUseSpriteAtlas"="True"
        }

        Cull Off
        Lighting Off
        ZWrite Off
        Blend [_SrcBlend] [_DstBlend], One [_DstBlend]

        Pass
        {
        CGPROGRAM
            #pragma vertex SpriteVert
            #pragma fragment SpriteFrag
            #pragma target 2.0
            #pragma multi_compile_instancing
            #pragma multi_compile_local _ PIXELSNAP_ON
            #pragma multi_compile _ ETC1_EXTERNAL_ALPHA
            #include "UnitySprites.cginc"
        ENDCG
        }
    }
}
