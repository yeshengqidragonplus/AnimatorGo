import { useEffect, useState } from 'react'
import { useEditorStore } from '@store/editorStore.ts'
import { packProjectAtlas, type PackedProjectAtlas } from './atlasCompose.ts'

/**
 * 正式图集:打包按钮 + 打包结果预览。
 *
 * 画布上的实时预览仍走原图(looseAtlas)—— 打包产物给导出器和引擎用,
 * 这里的预览是给人检查排布和裁剪对不对的。
 */
export function AtlasPanel() {
  const doc = useEditorStore((s) => s.doc)
  const projectDir = useEditorStore((s) => s.projectDir)
  const setAtlas = useEditorStore((s) => s.setAtlas)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<PackedProjectAtlas | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [pageUrls, setPageUrls] = useState<readonly string[]>([])

  // 打包结果的页 PNG → object URL,给预览 <img> 用
  useEffect(() => {
    if (result === null) {
      setPageUrls([])
      return
    }
    const urls = result.pageBlobs.map((blob) => URL.createObjectURL(blob))
    setPageUrls(urls)
    return () => {
      for (const url of urls) URL.revokeObjectURL(url)
    }
  }, [result])

  const pack = async () => {
    if (projectDir === null || busy) return
    setBusy(true)
    setError('')
    try {
      const packed = await packProjectAtlas(projectDir, doc.images, doc.name)
      setAtlas(packed.asset)
      setResult(packed)
      setShowPreview(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const atlas = doc.atlases[0]
  return (
    <section className="atlas-panel">
      <div className="panel-title panel-title-actions">
        <span>图集</span>
        <button
          className="atlas-pack-btn"
          disabled={projectDir === null || doc.images.length === 0 || busy}
          title={projectDir === null ? '先打开项目目录' : doc.images.length === 0 ? '先导入图片' : '按 MaxRects 打包全部图片'}
          onClick={() => void pack()}
        >
          {busy ? '打包中…' : '打包'}
        </button>
      </div>

      {error !== '' && <p className="atlas-error">{error}</p>}

      {atlas === undefined ? (
        <p className="asset-empty">尚未打包。打包会裁掉透明边并生成 atlases/ 下的页 PNG 与 .atlas 文本。</p>
      ) : (
        <div className="atlas-info">
          <span title={atlas.path}>{atlas.path}</span>
          <small>{atlas.pages.length} 页</small>
          {result !== null && (
            <button onClick={() => setShowPreview(true)}>预览</button>
          )}
        </div>
      )}

      {showPreview && result !== null && (
        <div className="atlas-preview-backdrop" onClick={() => setShowPreview(false)}>
          <div className="atlas-preview" onClick={(e) => e.stopPropagation()}>
            <div className="atlas-preview-head">
              <span>
                图集预览 · {result.layout.regions.length} 个区域 · {result.layout.pages.length} 页
              </span>
              <button onClick={() => setShowPreview(false)}>关闭</button>
            </div>
            <div className="atlas-preview-pages">
              {result.layout.pages.map((page, pageIndex) => (
                <figure key={pageIndex} className="atlas-page">
                  <figcaption>
                    {result.asset.pages[pageIndex]?.name} · {page.width}×{page.height}
                  </figcaption>
                  <div className="atlas-page-canvas" style={{ aspectRatio: `${page.width} / ${page.height}` }}>
                    {pageUrls[pageIndex] !== undefined && (
                      <img src={pageUrls[pageIndex]} alt="" draggable={false} />
                    )}
                    {result.layout.regions
                      .filter((region) => region.page === pageIndex)
                      .map((region) => {
                        const w = region.rotated ? region.input.trim.height : region.input.trim.width
                        const h = region.rotated ? region.input.trim.width : region.input.trim.height
                        return (
                          <div
                            key={region.name}
                            className="atlas-region-box"
                            title={`${region.name}${region.rotated ? ' (旋转 90°)' : ''}`}
                            style={{
                              left: `${(region.x / page.width) * 100}%`,
                              top: `${(region.y / page.height) * 100}%`,
                              width: `${(w / page.width) * 100}%`,
                              height: `${(h / page.height) * 100}%`,
                            }}
                          />
                        )
                      })}
                  </div>
                </figure>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
