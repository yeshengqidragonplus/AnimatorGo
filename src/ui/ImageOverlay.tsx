import { useEffect, useMemo, useState } from 'react'
import { platform } from '@platform/index.ts'
import type { RenderCommand } from '@core/types.ts'
import type { ImageAsset } from '@project/types.ts'

interface ScreenSize {
  readonly width: number
  readonly height: number
}

interface Props {
  readonly commands: readonly RenderCommand[]
  readonly images: readonly ImageAsset[]
  readonly projectDir: string | null
  readonly screen: ScreenSize | null
}

/**
 * 编辑期原图预览。原图尚未打包，因此每个 RenderCommand 都对应一张完整图片；
 * 未来切换为 Pixi Mesh 图集渲染时，仍复用同一份 core RenderCommand。
 */
export function ImageOverlay({ commands, images, projectDir, screen }: Props) {
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map())

  useEffect(() => {
    if (projectDir === null || images.length === 0) {
      setUrls(new Map())
      return
    }
    let disposed = false
    const created: string[] = []

    void Promise.all(images.map(async (image) => {
      const bytes = await platform().readImage(projectDir, image.path)
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      const url = URL.createObjectURL(new Blob([buffer]))
      created.push(url)
      return [image.id, url] as const
    })).then((entries) => {
      if (disposed) {
        for (const [, url] of entries) URL.revokeObjectURL(url)
        return
      }
      setUrls(new Map(entries))
    }).catch(() => {
      // 文件可能被用户在项目目录外部删除；资源面板仍在，等用户重新导入即可。
      if (!disposed) setUrls(new Map())
    })

    return () => {
      disposed = true
      for (const url of created) URL.revokeObjectURL(url)
    }
  }, [images, projectDir])

  const imageById = useMemo(() => new Map(images.map((image) => [image.id, image])), [images])
  if (screen === null) return null

  const originX = screen.width / 2
  const originY = screen.height * 0.72
  return (
    <div className="image-overlay">
      {commands.map((command) => {
        const image = imageById.get(command.path)
        const url = urls.get(command.path)
        if (image === undefined || url === undefined) return null
        return (
          <img
            key={command.slotName}
            className="attachment-image"
            src={url}
            draggable={false}
            style={{
              width: image.width,
              height: image.height,
              opacity: command.color.a,
              transform: toScreenMatrix(command.vertices, image.width, image.height, originX, originY),
            }}
          />
        )
      })}
    </div>
  )
}

/** 把 core 的 Y 向上四角转换成 CSS 的 Y 向下仿射矩阵，图片局部原点是左上。 */
function toScreenMatrix(
  vertices: Float32Array,
  width: number,
  height: number,
  originX: number,
  originY: number,
): string {
  const leftBottomX = vertices[0]!
  const leftBottomY = vertices[1]!
  const rightTopX = vertices[4]!
  const rightTopY = vertices[5]!
  const leftTopX = vertices[6]!
  const leftTopY = vertices[7]!

  const a = (rightTopX - leftTopX) / width
  const b = (-rightTopY + leftTopY) / width
  const c = (leftBottomX - leftTopX) / height
  const d = (-leftBottomY + leftTopY) / height
  const e = leftTopX + originX
  const f = -leftTopY + originY
  return `matrix(${a}, ${b}, ${c}, ${d}, ${e}, ${f})`
}
