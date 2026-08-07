import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useEditorStore } from '@store/editorStore.ts'

/** 刻度线的候选间隔,按 duration 选一个不至于太密的 */
const TICK_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5]

function pickTickStep(duration: number): number {
  return TICK_STEPS.find((s) => duration / s <= 12) ?? TICK_STEPS[TICK_STEPS.length - 1]!
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

  /** 有关键帧的骨骼,加上当前选中的(即使它还没有帧,也要能看到自己在哪一行) */
  const rows = useMemo(() => {
    const names = new Set(animation?.bones.keys() ?? [])
    if (selectedBone !== null) names.add(selectedBone)
    // 按骨架顺序排,和左侧骨骼树一致
    return doc.skeleton.bones.map((b) => b.name).filter((n) => names.has(n))
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
        <span className="anim-name">{currentAnimation}</span>
        {mode !== 'animate' && <span className="timeline-note">绑定姿势模式 —— 切到「动画」才能播放</span>}
      </div>

      <div className="timeline-body">
        <div className="track-labels">
          <div className="track-label ruler-spacer" />
          {rows.map((name) => (
            <button
              key={name}
              className={`track-label${name === selectedBone ? ' is-selected' : ''}`}
              onClick={() => selectBone(name)}
            >
              {name}
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

          {rows.map((name) => (
            <div key={name} className={`track${name === selectedBone ? ' is-selected' : ''}`}>
              {(animation?.bones.get(name)?.rotate ?? []).map((k) => (
                <button
                  key={k.time}
                  className="keyframe"
                  style={{ left: pct(k.time) }}
                  title={`${name} @ ${k.time}s = ${k.value.toFixed(1)}°  (右键删除)`}
                  onClick={() => {
                    setPlaying(false)
                    setTime(k.time)
                    selectBone(name)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    deleteKeyframe(name, k.time)
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
