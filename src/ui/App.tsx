import { useEffect } from 'react'
import { selectCanRedo, selectCanUndo, useEditorStore } from '@store/editorStore.ts'
import { Viewport } from './Viewport.tsx'
import { BoneTree } from './BoneTree.tsx'

function useUndoShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      const key = e.key.toLowerCase()

      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        useEditorStore.getState().undo()
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        useEditorStore.getState().redo()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

export function App() {
  useUndoShortcuts()

  const canUndo = useEditorStore(selectCanUndo)
  const canRedo = useEditorStore(selectCanRedo)
  const undo = useEditorStore((s) => s.undo)
  const redo = useEditorStore((s) => s.redo)
  const historyDepth = useEditorStore((s) => s.past.length)

  return (
    <div className="app">
      <header className="toolbar">
        <span className="brand">AnimatorGo</span>
        <button onClick={undo} disabled={!canUndo} title="Ctrl+Z">
          撤销
        </button>
        <button onClick={redo} disabled={!canRedo} title="Ctrl+Shift+Z">
          重做
        </button>
        <span className="history-depth">历史 {historyDepth}</span>
        <span className="hint">点击选中骨骼,拖动旋转</span>
      </header>

      <main className="workspace">
        <aside className="sidebar">
          <BoneTree />
        </aside>
        <Viewport />
      </main>
    </div>
  )
}
