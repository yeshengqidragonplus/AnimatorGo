import { useEffect, useState } from 'react'
import { createEmptyProject, fromProjectDocument, toProjectDocument } from '@project/types.ts'
import { platform } from '@platform/index.ts'
import type { ImageAsset } from '@project/types.ts'
import { selectCanRedo, selectCanUndo, useEditorStore } from '@store/editorStore.ts'
import { Viewport } from './Viewport.tsx'
import { BoneTree } from './BoneTree.tsx'
import { BonePanel } from './BonePanel.tsx'
import { Timeline } from './Timeline.tsx'
import { AssetPanel } from './AssetPanel.tsx'
import { SlotPanel } from './SlotPanel.tsx'
import { AtlasPanel } from './AtlasPanel.tsx'

function projectNameFromDir(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Untitled'
}

function imageSize(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const url = URL.createObjectURL(new Blob([buffer]))
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ width: image.naturalWidth, height: image.naturalHeight })
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('无法读取图片尺寸'))
    }
    image.src = url
  })
}

function useShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // 焦点在输入框里时不要抢按键 —— 属性面板输入数字不能触发快捷键
      const target = e.target as HTMLElement | null
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
        return
      }

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

      const key = e.key.toLowerCase()
      if (e.key === ' ') {
        // 必须 preventDefault:否则焦点在按钮上时空格会触发点击
        e.preventDefault()
        if (s.mode === 'animate') s.setPlaying(!s.playing)
      } else if (key === 'k' && s.selectedBone !== null && s.mode === 'animate') {
        e.preventDefault()
        s.keyBoneAtTime(s.selectedBone)
      } else if (key === 'r') {
        s.setTool('rotate')
      } else if (key === 't') {
        s.setTool('translate')
      } else if (key === 's') {
        s.setTool('scale')
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

export function App() {
  useShortcuts()
  const [status, setStatus] = useState('')

  const canUndo = useEditorStore(selectCanUndo)
  const canRedo = useEditorStore(selectCanRedo)
  const undo = useEditorStore((s) => s.undo)
  const redo = useEditorStore((s) => s.redo)
  const historyDepth = useEditorStore((s) => s.past.length)
  const mode = useEditorStore((s) => s.mode)
  const setMode = useEditorStore((s) => s.setMode)
  const tool = useEditorStore((s) => s.tool)
  const setTool = useEditorStore((s) => s.setTool)
  const selectedBone = useEditorStore((s) => s.selectedBone)
  const keyBoneAtTime = useEditorStore((s) => s.keyBoneAtTime)
  const projectDir = useEditorStore((s) => s.projectDir)
  const doc = useEditorStore((s) => s.doc)
  const setProjectDir = useEditorStore((s) => s.setProjectDir)
  const replaceProject = useEditorStore((s) => s.replaceProject)
  const addImages = useEditorStore((s) => s.addImages)

  const openProject = async () => {
    try {
      const dir = await platform().openProjectDir()
      if (dir === null) return
      await platform().scaffoldProject(dir)
      const text = await platform().readProject(dir)
      if (text === null) {
        replaceProject(createEmptyProject(projectNameFromDir(dir)))
        setStatus('已创建新项目目录')
      } else {
        replaceProject(fromProjectDocument(JSON.parse(text)))
        setStatus('项目已打开')
      }
      setProjectDir(dir)
    } catch (error) {
      setStatus(`打开失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const saveProject = async () => {
    if (projectDir === null) return
    try {
      await platform().writeProject(projectDir, JSON.stringify(toProjectDocument(doc), null, 2))
      setStatus('已保存')
    } catch (error) {
      setStatus(`保存失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const importImages = async () => {
    if (projectDir === null) return
    try {
      const names = await platform().importImages(projectDir)
      const images: ImageAsset[] = await Promise.all(names.map(async (name) => {
        const size = await imageSize(await platform().readImage(projectDir, name))
        return { id: `image:${name}`, path: name, ...size }
      }))
      addImages(images)
      setStatus(images.length === 0 ? '' : `已导入 ${images.length} 张图片`)
    } catch (error) {
      setStatus(`导入失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return (
    <div className="app">
      <header className="toolbar">
        <span className="brand">AnimatorGo</span>

        <button onClick={() => void openProject()}>打开项目</button>
        <button onClick={() => void saveProject()} disabled={projectDir === null}>保存</button>
        <button onClick={() => void importImages()} disabled={projectDir === null}>导入图片</button>

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

        <div className="mode-switch">
          <button
            className={tool === 'rotate' ? 'is-active' : ''}
            onClick={() => setTool('rotate')}
            title="拖动骨骼旋转 (R)"
          >
            旋转
          </button>
          <button
            className={tool === 'translate' ? 'is-active' : ''}
            onClick={() => setTool('translate')}
            title="拖动骨骼平移 (T)"
          >
            平移
          </button>
          <button
            className={tool === 'scale' ? 'is-active' : ''}
            onClick={() => setTool('scale')}
            title="拖动骨骼缩放 (S)"
          >
            缩放
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
        {status !== '' && <span className="project-status">{status}</span>}
        <span className="hint">
          {mode === 'animate'
            ? '空格播放 · 拖动骨骼在当前时刻打帧 · 右键关键帧删除 · R/T/S 换工具'
            : '拖动骨骼修改绑定姿势 · R/T/S 换工具'}
        </span>
      </header>

      <main className="workspace">
        <aside className="sidebar">
          <BoneTree />
          <BonePanel />
          <SlotPanel />
          <AssetPanel />
          <AtlasPanel />
        </aside>
        <Viewport />
      </main>

      <Timeline />
    </div>
  )
}
