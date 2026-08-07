import { useEffect } from 'react'
import { selectCanRedo, selectCanUndo, useEditorStore } from '@store/editorStore.ts'
import { Viewport } from './Viewport.tsx'
import { BoneTree } from './BoneTree.tsx'
import { Timeline } from './Timeline.tsx'

function useShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const s = useEditorStore.getState()

      if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase()
        if (key === 'z' && !e.shiftKey) {
          e.preventDefault()
          s.undo()
        } else if ((key === 'z' && e.shiftKey) || key === 'y') {
          e.preventDefault()
          s.redo()
        }
        return
      }

      if (e.key === ' ') {
        // 必须 preventDefault:否则焦点在按钮上时空格会触发点击
        e.preventDefault()
        if (s.mode === 'animate') s.setPlaying(!s.playing)
      } else if (e.key.toLowerCase() === 'k' && s.selectedBone !== null && s.mode === 'animate') {
        e.preventDefault()
        s.keyBoneAtTime(s.selectedBone)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

export function App() {
  useShortcuts()

  const canUndo = useEditorStore(selectCanUndo)
  const canRedo = useEditorStore(selectCanRedo)
  const undo = useEditorStore((s) => s.undo)
  const redo = useEditorStore((s) => s.redo)
  const historyDepth = useEditorStore((s) => s.past.length)
  const mode = useEditorStore((s) => s.mode)
  const setMode = useEditorStore((s) => s.setMode)
  const selectedBone = useEditorStore((s) => s.selectedBone)
  const keyBoneAtTime = useEditorStore((s) => s.keyBoneAtTime)

  return (
    <div className="app">
      <header className="toolbar">
        <span className="brand">AnimatorGo</span>

        <div className="mode-switch">
          <button
            className={mode === 'setup' ? 'is-active' : ''}
            onClick={() => setMode('setup')}
            title="编辑绑定姿势"
          >
            绑定姿势
          </button>
          <button
            className={mode === 'animate' ? 'is-active' : ''}
            onClick={() => setMode('animate')}
            title="编辑关键帧"
          >
            动画
          </button>
        </div>

        <button onClick={undo} disabled={!canUndo} title="Ctrl+Z">
          撤销
        </button>
        <button onClick={redo} disabled={!canRedo} title="Ctrl+Shift+Z">
          重做
        </button>
        <button
          onClick={() => selectedBone !== null && keyBoneAtTime(selectedBone)}
          disabled={selectedBone === null || mode !== 'animate'}
          title="K"
        >
          打关键帧
        </button>

        <span className="history-depth">历史 {historyDepth}</span>
        <span className="hint">
          {mode === 'animate'
            ? '空格播放 · 拖动骨骼在当前时刻打帧 · 右键关键帧删除'
            : '拖动骨骼修改绑定姿势'}
        </span>
      </header>

      <main className="workspace">
        <aside className="sidebar">
          <BoneTree />
        </aside>
        <Viewport />
      </main>

      <Timeline />
    </div>
  )
}
