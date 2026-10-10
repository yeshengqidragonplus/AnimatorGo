// AnimatorGo:Spine 的 additive / multiply / screen 混合。URP(2D Renderer、Universal Renderer 都能用),
// SpriteRenderer 和 SkinnedMeshRenderer 共用。内置管线用 AnimatorGoBlendBuiltin.shader。
//
// 照 URP 的 Sprite-Unlit-Default 只改两处(docs/UNITY-2D.md 第 18 节):
//   1. 混合因子是材质属性 _SrcBlend / _DstBlend,取 Spine 自己的(预乘颜色):
//        additive  One       One
//        multiply  DstColor  OneMinusSrcAlpha    → dst · lerp(1, src.rgb, src.a)
//        screen    One       OneMinusSrcColor
//      alpha 一律 One / _DstBlend(Spine 也是)
//   2. 输出预乘颜色(rgb × a)—— 上面的因子都是按预乘写的。图集导出时已还原成直通 alpha,这里再乘回去
// 其余照旧:兼容 SRP Batcher(SpriteRenderer 的颜色 / 翻转靠它,SkinnedMeshRenderer 不走合批时那些量是 0)、
// SpriteSkin 的 GPU 蒙皮(SKINNED_SPRITE)
Shader "AnimatorGo/Sprite-Unlit-Blend"
{
    Properties
    {
        _MainTex ("Sprite Texture", 2D) = "white" {}
        [Enum(UnityEngine.Rendering.BlendMode)] _SrcBlend ("Src Blend", Float) = 1
        [Enum(UnityEngine.Rendering.BlendMode)] _DstBlend ("Dst Blend", Float) = 10

        // Legacy properties(与 Sprite-Unlit-Default 相同)
        [HideInInspector] _Color ("Tint", Color) = (1,1,1,1)
        [HideInInspector] PixelSnap ("Pixel snap", Float) = 0
        [HideInInspector] _RendererColor ("RendererColor", Color) = (1,1,1,1)
        [HideInInspector] _AlphaTex ("External Alpha", 2D) = "white" {}
        [HideInInspector] _EnableExternalAlpha ("Enable External Alpha", Float) = 0
    }

    SubShader
    {
        Tags {"Queue" = "Transparent" "RenderType" = "Transparent" "RenderPipeline" = "UniversalPipeline" }

        Blend [_SrcBlend] [_DstBlend], One [_DstBlend]
        Cull Off
        ZWrite Off

        Pass
        {
            HLSLPROGRAM
            #include "Packages/com.unity.render-pipelines.universal/Shaders/2D/Include/Core2D.hlsl"

            #pragma vertex UnlitVertex
            #pragma fragment UnlitFragment

            struct Attributes
            {
                COMMON_2D_INPUTS
                half4 color : COLOR;
                UNITY_SKINNED_VERTEX_INPUTS
            };

            struct Varyings
            {
                COMMON_2D_OUTPUTS
                half4 color : COLOR;
            };

            #include "Packages/com.unity.render-pipelines.universal/Shaders/2D/Include/2DCommon.hlsl"

            #pragma multi_compile_instancing
            #pragma multi_compile _ DEBUG_DISPLAY SKINNED_SPRITE

            // 混合因子只进渲染状态、不进代码,不用放进 UnityPerMaterial(SRP Batcher 照样兼容)
            CBUFFER_START(UnityPerMaterial)
                half4 _Color;
            CBUFFER_END

            Varyings UnlitVertex(Attributes input)
            {
                UNITY_SKINNED_VERTEX_COMPUTE(input);
                SetUpSpriteInstanceProperties();
                input.positionOS = UnityFlipSprite(input.positionOS, unity_SpriteProps.xy);

                Varyings o = CommonUnlitVertex(input);
                o.color = input.color * _Color * unity_SpriteColor;
                return o;
            }

            half4 UnlitFragment(Varyings input) : SV_Target
            {
                half4 c = CommonUnlitFragment(input, input.color);
                return half4(c.rgb * c.a, c.a);
            }
            ENDHLSL
        }
    }
}
