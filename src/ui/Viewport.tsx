import { useEffect, useMemo, useRef, useState } from 'react'
import { Application, Container, Graphics, Point } from 'pixi.js'
import { buildRenderCommands, RAD_TO_DEG, Skeleton } from '@core/index.ts'
import { applyAnimation } from '@core/animation.ts'
import type { RenderCommand } from '@core/types.ts'
import { createLooseImageAtlas } from '@project/index.ts'
import { SkeletonRenderer } from '@render/pixi/SkeletonRenderer.ts'
import { useEditorStore } from '@store/editorStore.ts'
import { pickBone } from './hitTest.ts'
import { ImageOverlay } from './ImageOverlay.tsx'

const BG_COLOR = 0x161a23
const GRID_COLOR = 0x232936
const AXIS_COLOR = 0x39435c
const GRID_STEP = 50
const GRID_EXTENT = 2000

function buildGrid(): Graphics {
  const g = new Graphics()
  for (let v = -GRID_EXTENT; v <= GRID_EXTENT; v += GRID_STEP) {
    g.moveTo(v, -GRID_EXTENT).lineTo(v, GRID_EXTENT)
    g.moveTo(-GRID_EXTENT, v).lineTo(GRID_EXTENT, v)
  }
  g.stroke({ width: 1, color: GRID_COLOR })

  // 原点轴线。注意 Y 向上 —— 坐标系约定见 docs/FORMAT.md
  g.moveTo(-GRID_EXTENT, 0).lineTo(GRID_EXTENT, 0)
  g.moveTo(0, -GRID_EXTENT).lineTo(0, GRID_EXTENT)
  g.stroke({ width: 1.5, color: AXIS_COLOR })
  return g
}

export function Viewport() {
  const hostRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<Application | null>(null)
  const worldRef = useRef<Container | null>(null)
  const rendererRef = useRef<SkeletonRenderer | null>(null)
  const [commands, setCommands] = useState<readonly RenderCommand[]>([])
  const [screen, setScreen] = useState<{ width: number; height: number } | null>(null)

  const doc = useEditorStore((s) => s.doc)
  const mode = useEditorStore((s) => s.mode)
  const time = useEditorStore((s) => s.time)
  const playing = useEditorStore((s) => s.playing)
  const currentAnimation = useEditorStore((s) => s.currentAnimation)
  const selectedBone = useEditorStore((s) => s.selectedBone)
  const projectDir = useEditorStore((s) => s.projectDir)
  const atlas = useMemo(() => createLooseImageAtlas(doc.images), [doc.images])

  // 骨架实例只在骨骼数据变化时重建;播放头移动只是重新摆姿势,不重建
  const skeleton = useMemo(() => new Skeleton(doc.skeleton), [doc.skeleton])
  const skeletonRef = useRef(skeleton)
  skeletonRef.current = skeleton

  // ── PixiJS 生命周期 ────────────────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return

    let disposed = false
    const app = new Application()

    void app
      .init({
        background: BG_COLOR,
        antialias: true,
        resolution: window.devicePixelRatio,
        autoDensity: true,
        resizeTo: host,
      })
      .then(() => {
        // StrictMode 下 effect 跑两次,第二次挂载前要丢弃第一次的实例
        if (disposed) {
          app.destroy(true, { children: true })
          return
        }

        const world = new Container()
        world.scale.set(1, -1) // Y 向上
        world.addChild(buildGrid())

        const renderer = new SkeletonRenderer()
        world.addChild(renderer.graphics)

        app.stage.addChild(world)
        host.appendChild(app.canvas)

        appRef.current = app
        worldRef.current = world
        rendererRef.current = renderer

        const centre = () => {
          world.position.set(app.screen.width / 2, app.screen.height * 0.72)
          setScreen({ width: app.screen.width, height: app.screen.height })
        }
        centre()
        app.renderer.on('resize', centre)
      })

    return () => {
      disposed = true
      if (appRef.current !== null) {
        appRef.current.destroy(true, { children: true })
        appRef.current = null
        worldRef.current = null
        rendererRef.current = null
      }
    }
  }, [])

  // ── 摆姿势 + 重画 ──────────────────────────────────────────────────────────
  useEffect(() => {
    const animation = doc.animations.get(currentAnimation)

    if (mode === 'animate' && animation !== undefined) {
      applyAnimation(skeleton, animation, time)
    } else {
      skeleton.setToSetupPose()
    }
    skeleton.updateWorldTransform()

    rendererRef.current?.draw(skeleton, selectedBone)
    setCommands(buildRenderCommands(skeleton, atlas))
  }, [skeleton, doc.animations, currentAnimation, mode, time, selectedBone, atlas])

  // ── 播放 ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!playing) return

    const animation = doc.animations.get(currentAnimation)
    const duration = animation?.duration ?? 0
    if (duration <= 0) return

    let raf = 0
    let last = performance.now()

    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      const { time: t, setTime } = useEditorStore.getState()
      setTime((t + dt) % duration) // 循环播放
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, doc.animations, currentAnimation])

  // ── 输入:点击选中,拖动旋转 ───────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return

    // 每次手势一个唯一 key —— 整段拖动合并成一条撤销记录,松手后失效
    let dragBone: string | null = null
    let dragKey = ''
    let gestureId = 0

    const toWorld = (e: PointerEvent): { x: number; y: number } | null => {
      const world = worldRef.current
      const app = appRef.current
      if (world === null || app === null) return null
      const rect = app.canvas.getBoundingClientRect()
      return world.toLocal(new Point(e.clientX - rect.left, e.clientY - rect.top))
    }

    const onPointerDown = (e: PointerEvent) => {
      const p = toWorld(e)
      if (p === null) return

      const hit = pickBone(skeletonRef.current, p.x, p.y)
      useEditorStore.getState().selectBone(hit)

      if (hit !== null) {
        dragBone = hit
        gestureId += 1
        dragKey = `rotate:${hit}:${gestureId}`
        useEditorStore.getState().setPlaying(false) // 开始编辑就停止播放
        // 指针已失效时会抛 NotFoundError,拖动本身不依赖捕获
        try {
          host.setPointerCapture(e.pointerId)
        } catch {
          /* noop */
        }
      }
    }

    const onPointerMove = (e: PointerEvent) => {
      if (dragBone === null) return
      const p = toWorld(e)
      if (p === null) return

      const bone = skeletonRef.current.getBone(dragBone)
      if (bone === undefined) return

      // 鼠标在世界空间,写回的是局部旋转 —— 换算到父空间再取角度
      const [mx, my] = bone.worldToParent(p.x, p.y)
      const rotation = Math.atan2(my - bone.y, mx - bone.x) * RAD_TO_DEG

      useEditorStore.getState().setBoneRotation(dragBone, rotation, dragKey)
    }

    const endDrag = (e: PointerEvent) => {
      if (dragBone === null) return
      dragBone = null
      if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId)
    }

    host.addEventListener('pointerdown', onPointerDown)
    host.addEventListener('pointermove', onPointerMove)
    host.addEventListener('pointerup', endDrag)
    host.addEventListener('pointercancel', endDrag)

    return () => {
      host.removeEventListener('pointerdown', onPointerDown)
      host.removeEventListener('pointermove', onPointerMove)
      host.removeEventListener('pointerup', endDrag)
      host.removeEventListener('pointercancel', endDrag)
    }
  }, [])

  return (
    <div className="viewport" ref={hostRef}>
      <ImageOverlay commands={commands} images={doc.images} projectDir={projectDir} screen={screen} />
    </div>
  )
}
