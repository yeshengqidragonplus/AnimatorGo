import { useEditorStore } from '@store/editorStore.ts'
import { useT } from '@i18n/index.ts'

/** 已导入的原图清单。绑定 slot/attachment 的交互将在这块面板上继续扩展。 */
export function AssetPanel() {
  const t = useT()
  const images = useEditorStore((state) => state.doc.images)
  const selectedBone = useEditorStore((state) => state.selectedBone)
  const bindImageToBone = useEditorStore((state) => state.bindImageToBone)
  return (
    <section className="asset-panel">
      <div className="panel-title">{t('assets.titleCount', { n: images.length })}</div>
      {images.length === 0 ? (
        <p className="asset-empty">{t('assets.empty')}</p>
      ) : (
        <div className="asset-list">
          {images.map((image) => (
            <div className="asset-row" key={image.id} title={image.path}>
              <span>{image.path}</span>
              <small>{image.width} × {image.height}</small>
              <button
                disabled={selectedBone === null}
                title={selectedBone === null ? t('bonePanel.noSelection') : t('assets.bindTo', { name: selectedBone })}
                onClick={() => selectedBone !== null && bindImageToBone(image.id, selectedBone)}
              >
                {t('assets.bind')}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
