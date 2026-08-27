import { useState } from 'react'
import type { BlendMode, Color } from '@core/types.ts'
import { useEditorStore } from '@store/editorStore.ts'
import { useT } from '@i18n/index.ts'

/**
 * slot 列表:绘制顺序、改名、颜色、混合模式、解除绑定。
 *
 * 显示顺序与数组相反 —— 列表顶部是最上层(画得最晚)的 slot,
 * 和美术软件的图层面板一致。
 */

/** 只存值,显示文本在渲染时翻译 —— 常量数组求值早于任何语言选择 */
const BLEND_OPTIONS: readonly BlendMode[] = ['normal', 'additive', 'multiply', 'screen']

function colorToHex({ r, g, b }: Color): string {
  const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')
  return `#${byte(r)}${byte(g)}${byte(b)}`
}

function hexToColor(hex: string, a: number): Color {
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
    a,
  }
}

export function SlotPanel() {
  const t = useT()
  const skeleton = useEditorStore((s) => s.doc.skeleton)
  const renameSlot = useEditorStore((s) => s.renameSlot)
  const removeSlot = useEditorStore((s) => s.removeSlot)
  const moveSlot = useEditorStore((s) => s.moveSlot)
  const setSlotColor = useEditorStore((s) => s.setSlotColor)
  const setSlotBlend = useEditorStore((s) => s.setSlotBlend)

  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const commitRename = (name: string) => {
    const trimmed = draft.trim()
    setEditing(null)
    if (trimmed === '' || trimmed === name) return
    if (skeleton.slots.some((slot) => slot.name === trimmed)) return // 重名,放弃
    renameSlot(name, trimmed)
  }

  // 顶部 = 最上层 = 数组末尾
  const rows = skeleton.slots.map((slot, index) => ({ slot, index })).reverse()

  return (
    <section className="slot-panel">
      <div className="panel-title">{t('slots.title')}</div>
      {rows.length === 0 ? (
        <p className="asset-empty">{t('slots.empty')}</p>
      ) : (
        <div className="slot-list">
          {rows.map(({ slot, index }) => (
            <div className="slot-row" key={slot.name}>
              <div className="slot-row-main">
                {editing === slot.name ? (
                  <input
                    className="slot-rename"
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commitRename(slot.name)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(slot.name)
                      if (e.key === 'Escape') setEditing(null)
                    }}
                  />
                ) : (
                  <button
                    className="slot-name"
                    title={t('slots.doubleClickRename')}
                    onDoubleClick={() => {
                      setEditing(slot.name)
                      setDraft(slot.name)
                    }}
                  >
                    {slot.name}
                  </button>
                )}
                <small className="slot-bone">{skeleton.bones[slot.bone]?.name ?? '?'}</small>
              </div>
              <div className="slot-row-controls">
                <input
                  type="color"
                  value={colorToHex(slot.color)}
                  title={t('slots.color')}
                  onChange={(e) => setSlotColor(slot.name, hexToColor(e.target.value, slot.color.a), `color:${slot.name}`)}
                />
                <input
                  type="number"
                  className="slot-alpha"
                  min={0}
                  max={1}
                  step={0.05}
                  value={Number(slot.color.a.toFixed(2))}
                  title={t('slots.opacity')}
                  onChange={(e) => {
                    const a = Number(e.target.value)
                    if (Number.isFinite(a)) setSlotColor(slot.name, { ...slot.color, a: Math.min(1, Math.max(0, a)) }, `alpha:${slot.name}`)
                  }}
                />
                <select
                  value={slot.blend}
                  title={t('slots.blend')}
                  onChange={(e) => setSlotBlend(slot.name, e.target.value as BlendMode)}
                >
                  {BLEND_OPTIONS.map((option) => (
                    <option key={option} value={option}>{t(`blend.${option}`)}</option>
                  ))}
                </select>
                <button
                  title={t('slots.moveUpper')}
                  disabled={index === skeleton.slots.length - 1}
                  onClick={() => moveSlot(slot.name, 1)}
                >
                  ↑
                </button>
                <button
                  title={t('slots.moveLower')}
                  disabled={index === 0}
                  onClick={() => moveSlot(slot.name, -1)}
                >
                  ↓
                </button>
                <button title={t('slots.removeSlot')} onClick={() => removeSlot(slot.name)}>
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
