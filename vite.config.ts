import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

/**
 * 只负责渲染进程。主进程和 preload 由 esbuild 单独打包,
 * 见 scripts/dev.mjs 与 scripts/build-electron.mjs。
 *
 * 刻意不用 vite-plugin-electron —— 它当前版本按 rolldown 的接口传参,
 * 和 Vite 6 对不上,能构建但启动不了 Electron。手写这几十行反而可控。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@render': fileURLToPath(new URL('./src/render', import.meta.url)),
      '@store': fileURLToPath(new URL('./src/store', import.meta.url)),
      '@ui': fileURLToPath(new URL('./src/ui', import.meta.url)),
      '@platform': fileURLToPath(new URL('./src/platform', import.meta.url)),
      '@project': fileURLToPath(new URL('./src/project', import.meta.url)),
      '@i18n': fileURLToPath(new URL('./src/i18n', import.meta.url)),
      '@plugins': fileURLToPath(new URL('./src/plugins', import.meta.url)),
    },
  },
  // Electron 生产环境用 file:// 加载,必须是相对路径
  base: './',
  build: {
    // 不压缩。Electron 从本地磁盘加载,压缩省下的体积在 150MB 运行时面前
    // 毫无意义;不压缩还能让打包后的报错堆栈可读。
    // 另外 esbuild 压缩这个包(含 PixiJS)时会在自己的进程里 OOM。
    minify: false,
    // 打包体积已经很大,再塞 sourcemap 没必要;要调试时临时打开
    sourcemap: false,
  },
  server: { port: 5173, strictPort: true },
})
