// AnimatorGo:被 Spine 的 clipping 遮罩(导成 SpriteMask)遮住的 SkinnedMeshRenderer 用。URP 2D。
//
// 照 URP 的 Sprite-Unlit-Default 改了两处(2026-10-10 实测,docs/UNITY-2D.md 第 17 节):
//   1. 打断 SRP Batcher(_White 不放进 UnityPerMaterial):MeshRenderer / SkinnedMeshRenderer 的 Sprite Mask 交互
//      在 SRP Batcher 下不生效 —— URP 自带的 Mesh2D 着色器也是这么绕的(见它 _White 那行注释)
//   2. 去掉 sprite 专用的翻转和颜色(unity_SpriteProps / unity_SpriteColor):不走合批时它们是 0,顶点塌成一点、颜色全黑
// 不直接用 Mesh2D-Unlit-Default:它背面剔除(Spine 的三角形朝向不固定,骨骼一翻转就没了)、写深度(透明的地方也会挡住
// 后画的、更远的 sprite)、不乘顶点色(slot 的静态颜色烘在顶点色里)—— 三条都实测过
Shader "AnimatorGo/Sprite-Unlit-Masked"
{
    Properties
    {
        _MainTex ("Sprite Texture", 2D) = "white" {}
        [HideInInspector] _Color ("Tint", Color) = (1,1,1,1)
        [HideInInspector] _White ("Breaks SRP batching", Color) = (1,1,1,1)
    }

    SubShader
    {
        Tags {"Queue" = "Transparent" "RenderType" = "Transparent" "RenderPipeline" = "UniversalPipeline" }

        Blend SrcAlpha OneMinusSrcAlpha, One OneMinusSrcAlpha
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

            CBUFFER_START(UnityPerMaterial)
                half4 _Color;
            CBUFFER_END
            // 故意不在 UnityPerMaterial 里:着色器因此不兼容 SRP Batcher,遮罩才生效(见文件头)
            float4 _White;

            Varyings UnlitVertex(Attributes input)
            {
                Varyings o = CommonUnlitVertex(input);
                // step(...) 恒为 1,只是让 _White 不被编译器优化掉
                o.color = input.color * _Color * step(-1e30, _White.a);
                return o;
            }

            half4 UnlitFragment(Varyings input) : SV_Target
            {
                return CommonUnlitFragment(input, input.color);
            }
            ENDHLSL
        }
    }
}
