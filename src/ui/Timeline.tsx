import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { RotateKey, Vec2Key } from '@core/animation.ts'
import { useEditorStore, type BoneChannel } from '@store/editorStore.ts'

/** 刻度线的候选间隔,按 duration 选一个不至于太密的 */
const TICK_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5]

function pickTickStep(duration: number): number {
  return TICK_STEPS.find((s) => duration / s <= 12) ?? TICK_STEPS[TICK_STEPS.length - 1]!
}

const CHANNEL_ORDER: readonly BoneChannel[] = ['rotate', 'translate', 'scale', 'shear']
const CHANNEL_LABEL: Record<BoneChannel, string> = {
  rotate: '旋转',
  translate: '平移',
  scale: '缩放',
  shear: '斜切',
}

interface TrackRow {
  readonly bone: string
  readonly channel: BoneChannel
  readonly keys: readonly (RotateKey | Vec2Key)[]
}

function keyTooltip(row: TrackRow, key: RotateKey | Vec2Key): string {
  const value =
    'value' in key ? `${key.value.toFixed(1)}°` : `(${key.x.toFixed(1)}, ${key.y.toFixed(1)})`
  return `${row.bone} · ${CHANNEL_LABEL[row.channel]} @ ${key.time}s = ${value}  (右键删除)`
}

export function Timeline() {
  const trackAreaRef = useRef<HTMLDivElement>(null)

  const doc = useEditorStore((s) => s.doc)
  const mode = useEditorStore((s) => s.mode)
  const currentAnimation = useEditorStore((s) => s.currentAnimation)
  const time = useEditorStore((s) => s.time)
  const playing = useEditorStore((s) => s.playing)
  const selectedBone = useEditorStore((s) => s.selectedBone)

  const animation = doc.animations.get(currentAnimation)
  const duration = animation?.duration ?? 1

  /**
   * 每根骨骼的每条有关键帧的通道一行。当前选中的骨骼即使一帧都没有,
   * 也给一个空的旋转行 —— 让用户看到自己会打在哪一行。
   */
  const rows: TrackRow[] = useMemo(() => {
    const out: TrackRow[] = []
    // 按骨架顺序排,和左侧骨骼树一致
    for (const bone of doc.skeleton.bones) {
      const timelines = animation?.bones.get(bone.name)
      let any = false
      for (const channel of CHANNEL_ORDER) {
        const keys = timelines?.[channel]
        if (keys !== undefined && keys.length > 0) {
          out.push({ bone: bone.name, channel, keys })
          any = true
        }
      }
      if (!any && bone.name === selectedBone) out.push({ bone: bone.name, channel: 'rotate', keys: [] })
    }
    return out
  }, [animation, selectedBone, doc.skeleton.bones])

  const ticks = useMemo(() => {
    const step = pickTickStep(duration)
    const out: number[] = []
    for (let t = 0; t <= duration + 1e-9; t += step) out.push(Number(t.toFixed(4)))
    return out
  }, [duration])

  const pct = useCallback((t: number) => `${(t / duration) * 100}%`, [duration])

  // ── 拖动刻度区域擦洗播放头 ─────────────────────────────────────────────────
  useEffect(() => {
    const el = trackAreaRef.current
    if (el === null) return

    let scrubbing = false

    const seek = (clientX: number) => {
      const rect = el.getBoundingClientRect()
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      useEditorStore.getState().setTime(ratio * duration)
    }

    const onDown = (e: PointerEvent) => {
      // 点在关键帧上时交给关键帧自己处理
      if ((e.target as HTMLElement).closest('.keyframe') !== null) return
      scrubbing = true
      useEditorStore.getState().setPlaying(false)
      seek(e.clientX)
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        /* noop */
      }
    }
    const onMove = (e: PointerEvent) => {
      if (scrubbing) seek(e.clientX)
    }
    const onUp = (e: PointerEvent) => {
      scrubbing = false
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    }

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
    }
  }, [duration])

  const setPlaying = useEditorStore((s) => s.setPlaying)
  const setTime = useEditorStore((s) => s.setTime)
  const selectBone = useEditorStore((s) => s.selectBone)
  const deleteKeyframe = useEditorStore((s) => s.deleteKeyframe)
  const selectAnimation = useEditorStore((s) => s.selectAnimation)
  const addAnimation = useEditorStore((s) => s.addAnimation)

  const animationNames = [...doc.animations.keys()]

  return (
    <div className="timeline">
      <div className="timeline-controls">
        <button
          className="play-btn"
          onClick={() => setPlaying(!playing)}
          disabled={mode !== 'animate'}
          title="空格"
        >
          {playing ? '⏸' : '▶'}
        </button>
        <button onClick={() => setTime(0)} title="回到开头">
          ⏮
        </button>
        <span className="time-readout">
          {time.toFixed(2)} / {duration.toFixed(2)}s
        </span>
        {animationNames.length > 0 ? (
          <select
            className="anim-select"
            value={animation !== undefined ? currentAnimation : ''}
            onChange={(e) => selectAnimation(e.target.value)}
            title="切换动画"
          >
            {animation === undefined && <option value="">(选择动画)</option>}
            {animationNames.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        ) : (
          <span className="timeline-note">没有动画 —— 点 + 新建</span>
        )}
        <button className="anim-add" title="新建动画" onClick={() => addAnimation()}>
          +
        </button>
        {mode !== 'animate' && <span className="timeline-note">绑定姿势模式 —— 切到「动画」才能播放</span>}
      </div>

      <div className="timeline-body">
        <div className="track-labels">
          <div className="track-label ruler-spacer" />
          {rows.map((row) => (
            <button
              key={`${row.bone}:${row.channel}`}
              className={`track-label${row.bone === selectedBone ? ' is-selected' : ''}`}
              onClick={() => selectBone(row.bone)}
              title={`${row.bone} · ${CHANNEL_LABEL[row.channel]}`}
            >
              {row.bone} <small>{CHANNEL_LABEL[row.channel]}</small>
            </button>
          ))}
        </div>

        <div className="track-area" ref={trackAreaRef}>
          <div className="ruler">
            {ticks.map((t) => (
              <div key={t} className="tick" style={{ left: pct(t) }}>
                <span>{t}</span>
              </div>
            ))}
          </div>

          {rows.map((row) => (
            <div
              key={`${row.bone}:${row.channel}`}
              className={`track${row.bone === selectedBone ? ' is-selected' : ''}`}
            >
              {row.keys.map((k) => (
                <button
                  key={k.time}
                  className="keyframe"
                  style={{ left: pct(k.time) }}
                  title={keyTooltip(row, k)}
                  onClick={() => {
                    setPlaying(false)
                    setTime(k.time)
                    selectBone(row.bone)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    deleteKeyframe(row.bone, row.channel, k.time)
                  }}
                />
              ))}
            </div>
          ))}

          <div className="playhead" style={{ left: pct(time) }} />
        </div>
      </div>
    </div>
  )
}
