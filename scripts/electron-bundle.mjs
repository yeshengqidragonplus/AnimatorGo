import esbuild from 'esbuild'

/**
 * 主进程和 preload 的打包配置。dev 和生产构建共用。
 *
 * 输出 .mjs:package.json 是 "type": "module",Electron 28+ 支持 ESM 主进程。
 * ESM preload 要求 sandbox: false —— 已在 electron/main.ts 里设好。
 */
export const bundleOptions = {
  entryPoints: ['electron/main.ts', 'electron/preload.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outdir: 'dist-electron',
  outExtension: { '.js': '.mjs' },
  // electron 由运行时提供,不能打进包里
  external: ['electron'],
  logLevel: 'info',
}

export function createContext() {
  return esbuild.context(bundleOptions)
}

export function buildOnce() {
  return esbuild.build(bundleOptions)
}
