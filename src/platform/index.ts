import type { Platform } from './types.ts'

export type { Platform } from './types.ts'

/**
 * 取平台实现。不在 Electron 里运行时(比如单测、或直接用浏览器打开 vite 页面)
 * 会抛错而不是返回一个假的空实现 —— 静默降级只会让人以为保存成功了。
 */
export function platform(): Platform {
  const impl = window.animatorGo
  if (impl === undefined) {
    throw new Error(
      '平台层不可用:本应用需要在 Electron 中运行。' +
        '若是直接用浏览器打开了 vite 页面,请改用 pnpm dev 启动桌面应用。',
    )
  }
  return impl
}

/** 用于 UI 判断要不要显示「需要桌面版」的提示,不抛错 */
export function isDesktop(): boolean {
  return window.animatorGo !== undefined
}
