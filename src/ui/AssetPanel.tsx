import { useEditorStore } from '@store/editorStore.ts'

/** 已导入的原图清单。绑定 slot/attachment 的交互将在这块面板上继续扩展。 */
export function AssetPanel() {
  const images = useEditorStore((state) => state.doc.images)
  const selectedBone = useEditorStore((state) => state.selectedBone)
  const bindImageToBone = useEditorStore((state) => state.bindImageToBone)
  return (
    <section className="asset-panel">
      <div className="panel-title">图片部件 · {images.length}</div>
      {images.length === 0 ? (
        <p className="asset-empty">先打开项目目录，再从工具栏导入 PNG、JPG 或 WebP。</p>
      ) : (
        <div className="asset-list">
          {images.map((image) => (
            <div className="asset-row" key={image.id} title={image.path}>
              <span>{image.path}</span>
              <small>{image.width} × {image.height}</small>
              <button
                disabled={selectedBone === null}
                title={selectedBone === null ? '请先在骨骼列表或画布选中骨骼' : `绑定到 ${selectedBone}`}
                onClick={() => selectedBone !== null && bindImageToBone(image.id, selectedBone)}
              >
                绑定
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
