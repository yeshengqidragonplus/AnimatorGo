using System;
using UnityEngine;

namespace AnimatorGo
{
    /// <summary>
    /// 复制到 Assets/AnimatorGo/。将 packageJson 指向导出的 animatorgo.json。
    /// 完整运行时会在此采样 TRS、更新骨骼矩阵并按 slot 顺序绘制 attachment。
    /// </summary>
    public sealed class AnimatorGoPlayer : MonoBehaviour
    {
        [SerializeField] private TextAsset packageJson;
        [SerializeField] private string animationName;
        [SerializeField] private bool playing = true;

        private float time;

        private void Awake()
        {
            if (packageJson == null)
            {
                Debug.LogError("AnimatorGo: 请指定 animatorgo.json", this);
                return;
            }

            // TODO: 用 JsonUtility 或引入的 JSON 适配层反序列化 AnimatorGo Runtime Package。
            // 不使用 Unity Animator：它无法表达后续 mesh deform / slot draw order 语义。
        }

        private void Update()
        {
            if (!playing) return;
            // TODO: 翻译 AnimatorGo core 的动画采样与世界变换公式。
            time += Time.deltaTime;
        }

        public void Play(string nextAnimation)
        {
            animationName = nextAnimation;
            time = 0f;
        }
    }
}
