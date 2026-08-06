import { useEffect, useMemo, useRef } from 'react'
import { Application, Container, Graphics, Point } from 'pixi.js'
import { RAD_TO_DEG, Skeleton } from '@core/index.ts'
import { SkeletonRenderer } from '@render/pixi/SkeletonRenderer.ts'
import { useEditorStore } from '@store/editorStore.ts'
import { pickBone } from './hitTest.ts'

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

  // 原点轴线。注意 Y 向上 —— 世界坐标系约定见 docs/FORMAT.md
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

  const doc = useEditorStore((s) => s.doc)
  const selectedBone = useEditorStore((s) => s.selectedBone)

  const skeleton = useMemo(() => {
    const s = new Skeleton(doc.skeleton)
    s.updateWorldTransform()
    return s
  }, [doc.skeleton])

  // 事件回调里要用到最新的骨架和选中项,用 ref 避免重新绑定监听器
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
        // StrictMode 下 effect 会跑两次,第二次挂载前要确保第一次的实例被丢弃
        if (disposed) {
          app.destroy(true, { children: true })
          return
        }

        const world = new Container()
        // Y 向上:翻转 Y 轴,并把原点放到视口中心
        world.scale.set(1, -1)
        world.addChild(buildGrid())

        const renderer = new SkeletonRenderer()
        world.addChild(renderer.graphics)

        app.stage.addChild(world)
        host.appendChild(app.canvas)

        appRef.current = app
        worldRef.current = world
        rendererRef.current = renderer

        const centre = () => world.position.set(app.screen.width / 2, app.screen.height * 0.72)
        centre()
        app.renderer.on('resize', centre)

        renderer.draw(skeletonRef.current, useEditorStore.getState().selectedBone)
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

  // ── 骨架或选中项变化时重画 ─────────────────────────────────────────────────
  useEffect(() => {
    rendererRef.current?.draw(skeleton, selectedBone)
  }, [skeleton, selectedBone])

  // ── 输入:点击选中,拖动旋转 ───────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return

    // 每次手势一个唯一 key —— 整个拖动合并成一条撤销记录,松手后失效。
    // 见 editorStore.ts 的 merge key 说明。
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
        // 指针已经失效时会抛 NotFoundError,拖动本身不依赖捕获,忽略即可
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

      // 鼠标在世界空间,但要写回的是局部旋转 —— 换算到父空间再取角度
      const [mx, my] = bone.worldToParent(p.x, p.y)
      const rotation = Math.atan2(my - bone.y, mx - bone.x) * RAD_TO_DEG

      useEditorStore.getState().setBonePose(dragBone, { rotation }, dragKey)
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

  return <div className="viewport" ref={hostRef} />
}
