import { spawn } from 'node:child_process'
import electronPath from 'electron'
import { createServer } from 'vite'
import { createContext } from './electron-bundle.mjs'

/**
 * 开发启动:Vite 开发服务器 + 打包主进程 + 拉起 Electron。
 *
 * 改 src/ 走 Vite 的热更新(不重启);改 electron/ 会重新打包并重启 Electron。
 */

const server = await createServer()
await server.listen()
server.printUrls()

const url = server.resolvedUrls?.local?.[0]
if (url === undefined) {
  console.error('拿不到 Vite 服务器地址')
  process.exit(1)
}

const ctx = await createContext()
await ctx.rebuild()

let electron = null
let restarting = false

function launch() {
  electron = spawn(electronPath, ['.'], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: url, NODE_ENV: 'development' },
  })

  electron.on('exit', (code) => {
    electron = null
    // 重启导致的退出不算结束;用户关窗口才算
    if (restarting) return
    void shutdown(code ?? 0)
  })
}

async function shutdown(code) {
  await server.close()
  await ctx.dispose()
  process.exit(code)
}

// 监视主进程源码,改了就重新打包 + 重启窗口
ctx.watch?.()
server.watcher.add('electron')
server.watcher.on('change', async (file) => {
  if (!file.replace(/\\/g, '/').includes('/electron/')) return

  console.log('\n[electron] 主进程代码变化,重启...')
  restarting = true
  await ctx.rebuild()
  electron?.kill()
  // 等旧进程退干净再拉新的,否则会抢同一个单实例锁
  setTimeout(() => {
    restarting = false
    launch()
  }, 300)
})

process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))

launch()
