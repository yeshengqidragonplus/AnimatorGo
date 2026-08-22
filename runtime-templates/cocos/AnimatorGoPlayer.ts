import { _decorator, Component, JsonAsset } from 'cc';

const { ccclass, property } = _decorator;

/**
 * 复制到 assets/AnimatorGo/，把 packageJson 指向导出的 animatorgo.json。
 * 完整运行时会在此采样 TRS、计算骨骼世界矩阵，并由自定义 assembler 绘制 attachment。
 */
@ccclass('AnimatorGoPlayer')
export class AnimatorGoPlayer extends Component {
  @property(JsonAsset)
  packageJson: JsonAsset | null = null;

  @property
  animationName = '';

  @property
  playing = true;

  private time = 0;

  onLoad(): void {
    const document = this.packageJson?.json as { format?: string; project?: unknown } | undefined;
    if (document?.format !== 'animatorgo-runtime') {
      console.error('AnimatorGo: 请指定有效的 animatorgo.json');
      return;
    }
    // TODO: 将 document.project 映射为运行时数据结构。
  }

  update(deltaTime: number): void {
    if (!this.playing) return;
    // TODO: 翻译 AnimatorGo core 的动画采样与世界变换公式。
    this.time += deltaTime;
  }

  play(name: string): void {
    this.animationName = name;
    this.time = 0;
  }
}
