import { useState } from 'react'
import type { NativeRuntimeTarget } from '@plugins/nativeExport.ts'
import { useEditorStore } from '@store/editorStore.ts'
import { exportNativePackage } from './nativeExport.ts'

const targets: readonly [NativeRuntimeTarget, string][] = [['godot', 'Godot'], ['unity', 'Unity'], ['cocos', 'Cocos']]

export function ExportPanel() {
  const [status, setStatus] = useState('')
  const projectDir = useEditorStore((state) => state.projectDir)
  const doc = useEditorStore((state) => state.doc)
  const exportTarget = async (target: NativeRuntimeTarget) => {
    if (projectDir === null) return
    try {
      await exportNativePackage(projectDir, doc, target)
      setStatus(`已导出到 export/${target}/`)
    } catch (error) {
      setStatus(`导出失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return (
    <section className="export-panel">
      <div className="panel-title">自有格式导出</div>
      <div className="export-targets">
        {targets.map(([target, label]) => <button key={target} disabled={projectDir === null} onClick={() => void exportTarget(target)}>导出 {label}</button>)}
      </div>
      <p className="export-note">输出统一 Runtime Package 与图集/原图资源；各引擎运行时将在下一阶段接入。</p>
      {status !== '' && <p className="export-status">{status}</p>}
    </section>
  )
}
