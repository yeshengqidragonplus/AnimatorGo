import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Electron 主进程。
 *
 * 渲染进程**不开** nodeIntegration —— 所有文件访问必须经过这里的 IPC。
 * 对应的类型化封装在 src/platform/,渲染层只认那个接口。
 */

const DIR = path.dirname(fileURLToPath(import.meta.url))
const DEV_URL = process.env['VITE_DEV_SERVER_URL']

/**
 * 远程桌面、虚拟机、无显卡的服务器上,GPU 进程会崩("GPU state invalid"),
 * 整个应用跟着退出。这种环境下用 ANIMATORGO_DISABLE_GPU=1 走软件渲染。
 *
 * 默认**不关**硬件加速 —— PixiJS 在真机上需要它。
 */
if (process.env['ANIMATORGO_DISABLE_GPU'] === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
}

// GPU 崩溃时给出可操作的提示,而不是让应用无声无息地消失
app.on('child-process-gone', (_e, details) => {
  if (details.type === 'GPU') {
    console.error(
      `[GPU] 渲染进程异常退出(${details.reason})。` +
        `若在远程桌面或虚拟机中运行,请用 ANIMATORGO_DISABLE_GPU=1 启动。`,
    )
  }
})

/** 项目目录约定。见 docs/DECISIONS.md「工程存储」 */
const IMAGES_DIR = 'images'
const PROJECT_FILE = 'project.json'
const EXPORT_DIR = 'export'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0f1218',
    show: false,
    webPreferences: {
      preload: path.join(DIR, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // 白屏一闪很难看,等首帧准备好再显示
  mainWindow.once('ready-to-show', () => mainWindow?.show())

  if (DEV_URL !== undefined) {
    void mainWindow.loadURL(DEV_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    void mainWindow.loadFile(path.join(DIR, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ─── 文件 IPC ────────────────────────────────────────────────────────────────
//
// 所有路径都在主进程侧用 projectDir 拼接,渲染进程只传相对文件名 ——
// 避免渲染进程能读取项目目录之外的任何东西。

/** 把用户提供的文件名限制在项目目录内,挡掉 ../ 之类的路径穿越 */
function resolveInside(projectDir: string, ...segments: string[]): string {
  const full = path.resolve(projectDir, ...segments)
  const root = path.resolve(projectDir)
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(`路径越界:${segments.join('/')}`)
  }
  return full
}

ipcMain.handle('project:open', async (): Promise<string | null> => {
  if (mainWindow === null) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择项目目录',
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? null : (result.filePaths[0] ?? null)
})

/** 建立目录骨架。已存在的目录不动,可以对着已有项目重复调用。 */
ipcMain.handle('project:scaffold', async (_e, projectDir: string): Promise<void> => {
  await fs.mkdir(resolveInside(projectDir, IMAGES_DIR), { recursive: true })
  await fs.mkdir(resolveInside(projectDir, EXPORT_DIR), { recursive: true })
})

ipcMain.handle('project:read', async (_e, projectDir: string): Promise<string | null> => {
  try {
    return await fs.readFile(resolveInside(projectDir, PROJECT_FILE), 'utf-8')
  } catch (err) {
    // 新项目还没有 project.json,这不是错误
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
})

ipcMain.handle('project:write', async (_e, projectDir: string, json: string): Promise<void> => {
  // 先写临时文件再改名 —— 保存到一半崩溃不会毁掉已有工程
  const target = resolveInside(projectDir, PROJECT_FILE)
  const tmp = `${target}.tmp`
  await fs.writeFile(tmp, json, 'utf-8')
  await fs.rename(tmp, target)
})

ipcMain.handle('images:list', async (_e, projectDir: string): Promise<string[]> => {
  const dir = resolveInside(projectDir, IMAGES_DIR)
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && IMAGE_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
      .map((e) => e.name)
      .sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
})

/** 由用户挑选的源图片复制进项目 images/；同名文件自动加序号，绝不覆盖已有素材。 */
ipcMain.handle('images:import', async (_e, projectDir: string): Promise<string[]> => {
  if (mainWindow === null) return []
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入图片部件',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: [...IMAGE_EXTENSIONS].map((extension) => extension.slice(1)) }],
  })
  if (result.canceled) return []

  const imagesDir = resolveInside(projectDir, IMAGES_DIR)
  await fs.mkdir(imagesDir, { recursive: true })
  const imported: string[] = []

  for (const source of result.filePaths) {
    const parsed = path.parse(source)
    if (!IMAGE_EXTENSIONS.has(parsed.ext.toLowerCase())) continue

    let name = parsed.base
    let suffix = 2
    while (true) {
      try {
        await fs.access(resolveInside(projectDir, IMAGES_DIR, name))
        name = `${parsed.name}-${suffix}${parsed.ext}`
        suffix += 1
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
        throw error
      }
    }
    await fs.copyFile(source, resolveInside(projectDir, IMAGES_DIR, name))
    imported.push(name)
  }
  return imported
})

ipcMain.handle('images:read', async (_e, projectDir: string, name: string): Promise<Uint8Array> => {
  const buf = await fs.readFile(resolveInside(projectDir, IMAGES_DIR, name))
  return new Uint8Array(buf)
})

ipcMain.handle(
  'export:write',
  async (_e, projectDir: string, relativePath: string, data: string | Uint8Array): Promise<void> => {
    const target = resolveInside(projectDir, EXPORT_DIR, relativePath)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, data)
  },
)

// ─── 应用生命周期 ────────────────────────────────────────────────────────────

void app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  // macOS 的惯例是关掉窗口后应用仍驻留在 Dock
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
