import { useRef, useState } from 'react'
import { samplePose } from '@core/animation.ts'
import { useEditorStore } from '@store/editorStore.ts'

/**
 * 选中骨骼的 TRS 数值编辑。
 *
 * 显示值随模式变化:setup 是绑定姿势,animate 是当前时刻的最终姿势。
 * 写入走 store 的 setBoneXxx —— 传绝对局部值,偏移换算由 store 统一处理。
 */

interface NumFieldProps {
  readonly label: string
  readonly value: number
  readonly step?: number
  readonly disabled?: boolean
  readonly title?: string | undefined
  /** mergeTag 在一次连续输入(聚焦期间)内保持不变,让整段输入合并成一条撤销 */
  readonly onCommit: (value: number, mergeTag: string) => void
}

let fieldSerial = 0

function NumField({ label, value, step = 1, disabled = false, title, onCommit }: NumFieldProps) {
  // 编辑中显示本地文本(允许出现 "-"、"1." 这类中间态),失焦后回到外部值
  const [text, setText] = useState<string | null>(null)
  const gesture = useRef('')

  const shown = text ?? String(Number(value.toFixed(2)))

  return (
    <label className="prop-field" title={title}>
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={shown}
        disabled={disabled}
        onFocus={() => {
          fieldSerial += 1
          gesture.current = `prop:${fieldSerial}`
        }}
        onChange={(e) => {
          setText(e.target.value)
          const parsed = Number(e.target.value)
          if (Number.isFinite(parsed) && e.target.value.trim() !== '') onCommit(parsed, gesture.current)
        }}
        onBlur={() => setText(null)}
      />
    </label>
  )
}

export function BonePanel() {
  const doc = useEditorStore((s) => s.doc)
  const mode = useEditorStore((s) => s.mode)
  const time = useEditorStore((s) => s.time)
  const currentAnimation = useEditorStore((s) => s.currentAnimation)
  const selectedBone = useEditorStore((s) => s.selectedBone)

  const setBoneTranslation = useEditorStore((s) => s.setBoneTranslation)
  const setBoneRotation = useEditorStore((s) => s.setBoneRotation)
  const setBoneScale = useEditorStore((s) => s.setBoneScale)
  const setBoneShear = useEditorStore((s) => s.setBoneShear)
  const setBoneLength = useEditorStore((s) => s.setBoneLength)

  const bone = doc.skeleton.bones.find((b) => b.name === selectedBone)
  if (bone === undefined) return null

  const anim = mode === 'animate' ? doc.animations.get(currentAnimation) : undefined
  const offset = anim === undefined ? null : samplePose(anim, bone.name, time)

  // animate 模式显示最终姿势 = 绑定 + 偏移(scale 是 ×)
  const v = offset === null
    ? bone
    : {
        x: bone.x + offset.x,
        y: bone.y + offset.y,
        rotation: bone.rotation + offset.rotation,
        scaleX: bone.scaleX * offset.scaleX,
        scaleY: bone.scaleY * offset.scaleY,
        shearX: bone.shearX + offset.shearX,
        shearY: bone.shearY + offset.shearY,
      }

  const name = bone.name
  return (
    <div className="panel bone-panel">
      <div className="panel-title">
        {name} · {mode === 'animate' ? '当前姿势(编辑打关键帧)' : '绑定姿势'}
      </div>
      <div className="prop-grid">
        <NumField label="X" value={v.x} onCommit={(x, tag) => setBoneTranslation(name, x, v.y, `${tag}:x`)} />
        <NumField label="Y" value={v.y} onCommit={(y, tag) => setBoneTranslation(name, v.x, y, `${tag}:y`)} />
        <NumField label="旋转" value={v.rotation} onCommit={(r, tag) => setBoneRotation(name, r, `${tag}:rot`)} />
        <NumField label="长度" value={bone.length} disabled={mode === 'animate'}
          title={mode === 'animate' ? '长度只是编辑器显示用,不可动画' : undefined}
          onCommit={(l, tag) => setBoneLength(name, l, `${tag}:len`)} />
        <NumField label="缩放X" value={v.scaleX} step={0.1}
          onCommit={(sx, tag) => setBoneScale(name, sx, v.scaleY, `${tag}:sx`)} />
        <NumField label="缩放Y" value={v.scaleY} step={0.1}
          onCommit={(sy, tag) => setBoneScale(name, v.scaleX, sy, `${tag}:sy`)} />
        <NumField label="斜切X" value={v.shearX} onCommit={(x, tag) => setBoneShear(name, x, v.shearY, `${tag}:shx`)} />
        <NumField label="斜切Y" value={v.shearY} onCommit={(y, tag) => setBoneShear(name, v.shearX, y, `${tag}:shy`)} />
      </div>
    </div>
  )
}
