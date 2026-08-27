/**
 * 英语 —— **key 的唯一真源**。
 *
 * 其他语言都声明成 `Record<TranslationKey, string>`,少一个 key 就编译不过。
 * 加新文案时先加到这里,TypeScript 会立刻在另外四个语言文件上报错。
 */
export const en = {
  // ── 工具栏 ────────────────────────────────────────────────────────────────
  'toolbar.openProject': 'Open Project',
  'toolbar.save': 'Save',
  'toolbar.importImages': 'Import Images',
  'toolbar.undo': 'Undo',
  'toolbar.redo': 'Redo',
  'toolbar.key': 'Key',
  'toolbar.keyTitle': 'Key the selected bone at the current time (K)',
  'toolbar.history': 'History {n}',
  'toolbar.language': 'Language',

  'mode.setup': 'Setup Pose',
  'mode.animate': 'Animate',
  'mode.setupTitle': 'Edit the bind pose',
  'mode.animateTitle': 'Edit keyframes',

  'tool.rotate': 'Rotate',
  'tool.translate': 'Translate',
  'tool.scale': 'Scale',
  'tool.rotateTitle': 'Drag a bone to rotate (R)',
  'tool.translateTitle': 'Drag a bone to move (T)',
  'tool.scaleTitle': 'Drag a bone to scale (S)',

  'hint.animate': 'Space to play · drag a bone to key it at the current time · right-click a key to delete · R/T/S to switch tool',
  'hint.setup': 'Drag bones to edit the bind pose · R/T/S to switch tool',

  // ── 状态提示 ──────────────────────────────────────────────────────────────
  'status.projectOpened': 'Project opened',
  'status.projectCreated': 'New project directory created',
  'status.saved': 'Saved',
  'status.imagesImported': 'Imported {n} image(s)',
  'status.openFailed': 'Open failed: {error}',
  'status.saveFailed': 'Save failed: {error}',
  'status.importFailed': 'Import failed: {error}',
  'status.packFailed': 'Packing failed: {error}',

  // ── 骨骼面板 ──────────────────────────────────────────────────────────────
  'bones.title': 'Bones',
  'bones.currentPose': 'Bones · current pose',
  'bones.setupPose': 'Bones · setup pose',
  'bones.addRoot': 'Add a root bone',
  'bones.addChild': 'Add a child of {name}',

  'bonePanel.title': 'Bone',
  'bonePanel.noSelection': 'Select a bone in the list or on the canvas first',
  'bonePanel.rotation': 'Rotation',
  'bonePanel.translation': 'Position',
  'bonePanel.scale': 'Scale',
  'bonePanel.shear': 'Shear',
  'bonePanel.length': 'Length',
  'bonePanel.lengthNote': 'Length only affects how the bone is drawn in the editor — it cannot be animated',

  // ── 时间轴 ────────────────────────────────────────────────────────────────
  'timeline.play': 'Play (Space)',
  'timeline.pause': 'Pause (Space)',
  'timeline.toStart': 'Back to start',
  'timeline.setupModeNote': 'Setup pose mode — switch to Animate to play',
  'timeline.selectAnimation': '(select an animation)',
  'timeline.noAnimations': 'No animations — click + to create one',
  'timeline.newAnimation': 'New animation',
  'timeline.keyTooltip': '{bone} · {channel} @ {time}s = {value}  (right-click to delete)',
  'timeline.trackLabel': '{bone} · {channel}',

  'channel.rotate': 'Rotate',
  'channel.translate': 'Translate',
  'channel.scale': 'Scale',
  'channel.shear': 'Shear',

  // ── 资源面板 ──────────────────────────────────────────────────────────────
  'assets.title': 'Images',
  'assets.empty': 'Open a project directory first, then import PNG, JPG or WebP from the toolbar.',
  'assets.bindTo': 'Bind to {name}',
  'assets.selectBoneFirst': 'Select a bone first',

  // ── Slot 面板 ─────────────────────────────────────────────────────────────
  'slots.title': 'Slots · draw order (topmost is drawn last)',
  'slots.empty': 'Slots appear here once you bind an image to a bone.',
  'slots.rename': 'Rename',
  'slots.unbind': 'Unbind',
  'slots.color': 'Tint',
  'slots.blend': 'Blend',
  'slots.moveUp': 'Move up',
  'slots.moveDown': 'Move down',

  'blend.normal': 'Normal',
  'blend.additive': 'Additive',
  'blend.multiply': 'Multiply',
  'blend.screen': 'Screen',

  // ── 图集面板 ──────────────────────────────────────────────────────────────
  'atlas.title': 'Atlas',
  'atlas.pack': 'Pack',
  'atlas.packing': 'Packing…',
  'atlas.packTitle': 'Pack all images with MaxRects',
  'atlas.notPacked': 'Not packed yet. Packing trims transparent edges and writes page PNGs plus a .atlas text file under atlases/.',
  'atlas.importImagesFirst': 'Import images first',
  'atlas.openProjectFirst': 'Open a project directory first',
  'atlas.preview': 'Preview',
  'atlas.close': 'Close',
  'atlas.regionRotated': '{name} (rotated 90°)',

  // ── 错误 ──────────────────────────────────────────────────────────────────
  'error.imageSize': 'Could not read the image dimensions',

  // ── 追加 ──────────────────────────────────────────────────────────────────
  'bonePanel.scaleX': 'Scale X',
  'bonePanel.scaleY': 'Scale Y',
  'bonePanel.shearX': 'Shear X',
  'bonePanel.shearY': 'Shear Y',
  'bonePanel.headerAnimate': 'current pose (edits create keys)',
  'bonePanel.headerSetup': 'setup pose',
  'timeline.spaceKey': 'Space',
  'timeline.switchAnimation': 'Switch animation',
  'assets.titleCount': 'Images · {n}',
  'assets.bind': 'Bind',
  'slots.doubleClickRename': 'Double-click to rename',
  'slots.opacity': 'Opacity',
  'slots.moveUpper': 'Move up a layer',
  'slots.moveLower': 'Move down a layer',
  'slots.removeSlot': 'Unbind (delete slot)',
  'atlas.pages': '{n} page(s)',
  'atlas.previewTitle': 'Atlas preview · {regions} region(s) · {pages} page(s)',
} as const

export type TranslationKey = keyof typeof en

/** 其他语言必须完整覆盖 en 的 key —— 少一个就编译不过 */
export type Translations = Record<TranslationKey, string>
