import { useEffect, useState } from 'react'
import { createEmptyProject, fromProjectDocument, toProjectDocument } from '@project/types.ts'
import { platform } from '@platform/index.ts'
import { tt, useT } from '@i18n/index.ts'
import { LanguageSwitch } from './LanguageSwitch.tsx'
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
      reject(new Error(tt('error.imageSize')))
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
  const t = useT()
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
        setStatus(t('status.projectCreated'))
      } else {
        replaceProject(fromProjectDocument(JSON.parse(text)))
        setStatus(t('status.projectOpened'))
      }
      setProjectDir(dir)
    } catch (error) {
      setStatus(t('status.openFailed', { error: error instanceof Error ? error.message : String(error) }))
    }
  }

  const saveProject = async () => {
    if (projectDir === null) return
    try {
      await platform().writeProject(projectDir, JSON.stringify(toProjectDocument(doc), null, 2))
      setStatus(t('status.saved'))
    } catch (error) {
      setStatus(t('status.saveFailed', { error: error instanceof Error ? error.message : String(error) }))
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
      setStatus(images.length === 0 ? '' : t('status.imagesImported', { n: images.length }))
    } catch (error) {
      setStatus(t('status.importFailed', { error: error instanceof Error ? error.message : String(error) }))
    }
  }

  return (
    <div className="app">
      <header className="toolbar">
        <span className="brand">AnimatorGo</span>

        <button onClick={() => void openProject()}>{t('toolbar.openProject')}</button>
        <button onClick={() => void saveProject()} disabled={projectDir === null}>{t('toolbar.save')}</button>
        <button onClick={() => void importImages()} disabled={projectDir === null}>{t('toolbar.importImages')}</button>

        <div className="mode-switch">
          <button
            className={mode === 'setup' ? 'is-active' : ''}
            onClick={() => setMode('setup')}
            title={t('mode.setupTitle')}
          >
            {t('mode.setup')}
          </button>
          <button
            className={mode === 'animate' ? 'is-active' : ''}
            onClick={() => setMode('animate')}
            title={t('mode.animateTitle')}
          >
            {t('mode.animate')}
          </button>
        </div>

        <div className="mode-switch">
          <button
            className={tool === 'rotate' ? 'is-active' : ''}
            onClick={() => setTool('rotate')}
            title={t('tool.rotateTitle')}
          >
            {t('tool.rotate')}
          </button>
          <button
            className={tool === 'translate' ? 'is-active' : ''}
            onClick={() => setTool('translate')}
            title={t('tool.translateTitle')}
          >
            {t('tool.translate')}
          </button>
          <button
            className={tool === 'scale' ? 'is-active' : ''}
            onClick={() => setTool('scale')}
            title={t('tool.scaleTitle')}
          >
            {t('tool.scale')}
          </button>
        </div>

        <button onClick={undo} disabled={!canUndo} title="Ctrl+Z">
          {t('toolbar.undo')}
        </button>
        <button onClick={redo} disabled={!canRedo} title="Ctrl+Shift+Z">
          {t('toolbar.redo')}
        </button>
        <button
          onClick={() => selectedBone !== null && keyBoneAtTime(selectedBone)}
          disabled={selectedBone === null || mode !== 'animate'}
          title={t('toolbar.keyTitle')}
        >
          {t('toolbar.key')}
        </button>

        <span className="history-depth">{t('toolbar.history', { n: historyDepth })}</span>
        {status !== '' && <span className="project-status">{status}</span>}
        <LanguageSwitch />
        <span className="hint">{t(mode === 'animate' ? 'hint.animate' : 'hint.setup')}</span>
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
