import { contextBridge, ipcRenderer } from 'electron'

/**
 * 渲染进程能看到的唯一原生能力入口。
 *
 * 刻意只暴露这几个窄接口,不暴露 ipcRenderer 本身 —— 否则等于把整个主进程
 * 敞开给渲染层,contextIsolation 就白设了。
 *
 * 类型定义在 src/platform/types.ts,两边必须对齐。
 */
contextBridge.exposeInMainWorld('animatorGo', {
  openProjectDir: (): Promise<string | null> => ipcRenderer.invoke('project:open'),

  scaffoldProject: (dir: string): Promise<void> => ipcRenderer.invoke('project:scaffold', dir),

  readProject: (dir: string): Promise<string | null> => ipcRenderer.invoke('project:read', dir),

  writeProject: (dir: string, json: string): Promise<void> =>
    ipcRenderer.invoke('project:write', dir, json),

  listImages: (dir: string): Promise<string[]> => ipcRenderer.invoke('images:list', dir),

  importImages: (dir: string): Promise<string[]> => ipcRenderer.invoke('images:import', dir),

  readImage: (dir: string, name: string): Promise<Uint8Array> =>
    ipcRenderer.invoke('images:read', dir, name),

  writeExport: (dir: string, relativePath: string, data: string | Uint8Array): Promise<void> =>
    ipcRenderer.invoke('export:write', dir, relativePath, data),

  writeAtlasFile: (dir: string, name: string, data: string | Uint8Array): Promise<void> =>
    ipcRenderer.invoke('atlas:write', dir, name, data),

  readAtlasFile: (dir: string, name: string): Promise<Uint8Array> =>
    ipcRenderer.invoke('atlas:read', dir, name),
})
