# Unity 模板

复制 `AnimatorGoPlayer.cs` 到 `Assets/AnimatorGo/`，并将 `export/unity/` 的资源一同拷入 Assets。把 `animatorgo.json` 作为 `TextAsset` 指给组件。

完整播放器会自己维护 Mesh / Material，不依赖 Unity Animator，以保留 AnimatorGo 的 slot 与后续网格语义。
