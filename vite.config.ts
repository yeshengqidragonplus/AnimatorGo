import { defineConfig } from 'vite'
import { configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

/**
 * 只负责渲染进程。主进程和 preload 由 esbuild 单独打包,
 * 见 scripts/dev.mjs 与 scripts/build-electron.mjs。
 *
 * 刻意不用 vite-plugin-electron —— 它当前版本按 rolldown 的接口传参,
 * 和 Vite 6 对不上,能构建但启动不了 Electron。手写这几十行反而可控。
 */
/**
 * vitest 读的也是这份配置。不能改用 vitest/config 的 defineConfig 来拿 `test` 的类型 ——
 * vitest 2 自带 vite 5 的类型,和工程的 vite 6 的 Plugin 类型对不上,typecheck 过不了。
 * 所以单独放一个对象再展开进去(展开的属性不做多余属性检查)。
 */
const vitest = {
  test: {
    // .claude/worktrees/ 下是整份仓库的拷贝(独立任务的工作区),别把它们的测试也跑一遍
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
}

export default defineConfig({
  ...vitest,
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
