import { useMemo } from 'react'
import type { BoneData } from '@core/types.ts'
import { useEditorStore } from '@store/editorStore.ts'

interface Row {
  bone: BoneData
  depth: number
}

/** bones 保证父在子之前,所以深度可以单遍算出来 */
function flatten(bones: readonly BoneData[]): Row[] {
  const depths: number[] = []
  return bones.map((bone) => {
    const depth = bone.parent < 0 ? 0 : (depths[bone.parent] ?? 0) + 1
    depths.push(depth)
    return { bone, depth }
  })
}

export function BoneTree() {
  const bones = useEditorStore((s) => s.doc.skeleton.bones)
  const selectedBone = useEditorStore((s) => s.selectedBone)
  const selectBone = useEditorStore((s) => s.selectBone)

  const rows = useMemo(() => flatten(bones), [bones])

  return (
    <div className="panel">
      <div className="panel-title">骨骼</div>
      <div className="bone-list">
        {rows.map(({ bone, depth }) => (
          <button
            key={bone.name}
            className={`bone-row${bone.name === selectedBone ? ' is-selected' : ''}`}
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => selectBone(bone.name)}
          >
            <span className="bone-name">{bone.name}</span>
            <span className="bone-rot">{bone.rotation.toFixed(1)}°</span>
          </button>
        ))}
      </div>
    </div>
  )
}
