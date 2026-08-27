import { useMemo } from 'react'
import { sampleRotation } from '@core/animation.ts'
import type { BoneData } from '@core/types.ts'
import { useEditorStore } from '@store/editorStore.ts'
import { useT } from '@i18n/index.ts'

interface Row {
  bone: BoneData
  depth: number
  /** 当前显示的角度:绑定姿势模式下是绑定值,动画模式下是当前时刻的姿势 */
  rotation: number
  /** 动画模式下该骨骼在当前时刻有偏移(用于高亮) */
  animated: boolean
}

/** bones 保证父在子之前,所以深度可以单遍算出来 */
function depthsOf(bones: readonly BoneData[]): number[] {
  const depths: number[] = []
  for (const bone of bones) {
    depths.push(bone.parent < 0 ? 0 : (depths[bone.parent] ?? 0) + 1)
  }
  return depths
}

export function BoneTree() {
  const t = useT()
  const bones = useEditorStore((s) => s.doc.skeleton.bones)
  const animations = useEditorStore((s) => s.doc.animations)
  const currentAnimation = useEditorStore((s) => s.currentAnimation)
  const mode = useEditorStore((s) => s.mode)
  const time = useEditorStore((s) => s.time)
  const selectedBone = useEditorStore((s) => s.selectedBone)
  const selectBone = useEditorStore((s) => s.selectBone)
  const addBone = useEditorStore((s) => s.addBone)

  const rows: Row[] = useMemo(() => {
    const depths = depthsOf(bones)
    const animation = mode === 'animate' ? animations.get(currentAnimation) : undefined

    return bones.map((bone, i) => {
      const offset = animation === undefined ? 0 : sampleRotation(animation, bone.name, time)
      return {
        bone,
        depth: depths[i] ?? 0,
        rotation: bone.rotation + offset,
        animated: offset !== 0,
      }
    })
  }, [bones, animations, currentAnimation, mode, time])

  return (
    <div className="panel">
      <div className="panel-title panel-title-actions">
        <span>{t(mode === 'animate' ? 'bones.currentPose' : 'bones.setupPose')}</span>
        <button
          title={selectedBone === null ? t('bones.addRoot') : t('bones.addChild', { name: selectedBone })}
          onClick={() => selectBone(addBone(selectedBone))}
        >
          +
        </button>
      </div>
      <div className="bone-list">
        {rows.map(({ bone, depth, rotation, animated }) => (
          <button
            key={bone.name}
            className={`bone-row${bone.name === selectedBone ? ' is-selected' : ''}`}
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => selectBone(bone.name)}
          >
            <span className="bone-name">{bone.name}</span>
            <span className={`bone-rot${animated ? ' is-animated' : ''}`}>
              {rotation.toFixed(1)}°
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
