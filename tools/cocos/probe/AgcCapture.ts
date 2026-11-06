import { _decorator, Animation, Camera, Component, RenderTexture, director, log } from 'cc'
import { JSB } from 'cc/env'

const { ccclass, property } = _decorator

/**
 * 探针用的采帧组件(挂在 Canvas 上,cocos_view.py 负责装进工程):场景里第一个 Animation 的每条剪辑按固定时刻定格,
 * 相机渲到 RenderTexture,读像素 POST 给 tools/cocos/collect.mjs 存成 PNG。
 *
 * Web 和原生(JSB)同一份代码 —— 原生没有 canvas.toDataURL,只能走 readPixels;原生的 XMLHttpRequest 能直接发 Uint8Array。
 * 跑完按 next 跳下一个场景,没有 next 就发一个 all_done 标记,外面轮询到它就收工。
 */
@ccclass('AgcCapture')
export class AgcCapture extends Component {
  @property tag = ''
  @property steps = 4
  @property next = ''
  @property server = 'http://127.0.0.1:8082'

  private _rt: RenderTexture | null = null
  private _anim: Animation | null = null
  private _jobs: { clip: string; t: number; idx: number }[] = []
  private _pending: { clip: string; t: number; idx: number } | null = null
  private _wait = 0
  private _done = false

  start(): void {
    const cam = this.getComponentInChildren(Camera)
    if (!cam) {
      console.error('AgcCapture:场景里没有相机')
      return
    }
    const rt = new RenderTexture()
    rt.reset({ width: 960, height: 640 })
    cam.targetTexture = rt
    this._rt = rt
    this._anim = this.getComponentInChildren(Animation)
    if (this._anim) {
      for (const clip of this._anim.clips) {
        if (!clip) continue
        for (let i = 0; i < this.steps; i++) this._jobs.push({ clip: clip.name, t: (clip.duration * i) / this.steps, idx: i })
      }
    }
    this._wait = 5
    log(`AgcCapture ${this.tag}:${this._jobs.length} 帧,${JSB ? '原生' : 'Web'}`)
  }

  update(): void {
    if (this._done || !this._rt) return
    if (this._wait > 0) {
      this._wait--
      return
    }
    const pending = this._pending
    if (pending) {
      // 定格后等了两帧,RenderTexture 里是上一帧画完的结果
      const px = this._rt.readPixels()
      if (px) this._send(`${this.tag}_${pending.clip}_${pending.idx}.png`, px, `w=960&h=640&plat=${JSB ? 'jsb' : 'web'}`)
      this._pending = null
    }
    const job = this._jobs.shift()
    if (!job || !this._anim) {
      this._finish()
      return
    }
    const st = this._anim.getState(job.clip)
    st.play()
    st.pause()
    st.time = job.t
    st.sample()
    this._pending = job
    this._wait = 2
  }

  private _finish(): void {
    this._done = true
    if (this.next) {
      director.loadScene(this.next)
    } else {
      this._send('all_done.txt', new Uint8Array([49]), 'raw=1')
    }
  }

  private _send(name: string, body: Uint8Array, extra: string): void {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${this.server}/save?name=${encodeURIComponent(name)}&${extra}`)
    xhr.onerror = (): void => console.error(`AgcCapture:发不出去 ${name}`)
    xhr.send(body)
  }
}
