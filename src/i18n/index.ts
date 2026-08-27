import { create } from 'zustand'
import { en, type TranslationKey, type Translations } from './locales/en.ts'
import { zh } from './locales/zh.ts'
import { es } from './locales/es.ts'
import { fr } from './locales/fr.ts'
import { de } from './locales/de.ts'

/**
 * 多语言。
 *
 * 刻意不引 react-i18next —— 那套东西的命名空间、复数规则、异步加载
 * 对一个单人桌面工具是纯负担。这里 60 行够用。
 *
 * **漏翻译由类型系统挡:** `en.ts` 是 key 的唯一真源,其余语言声明成
 * `Record<TranslationKey, string>`,少一个 key 就编译不过。
 */

export const LOCALES = {
  en: { label: 'English', translations: en as Translations },
  zh: { label: '中文', translations: zh },
  es: { label: 'Español', translations: es },
  fr: { label: 'Français', translations: fr },
  de: { label: 'Deutsch', translations: de },
} as const

export type Locale = keyof typeof LOCALES

const STORAGE_KEY = 'animatorgo.locale'

function isLocale(value: string): value is Locale {
  return value in LOCALES
}

/**
 * 选初始语言:上次的选择 → 系统语言 → 英语。
 *
 * `navigator.language` 形如 `zh-CN` / `fr-FR`,只取前缀。
 * 不做地区细分(zh-TW 也会落到 zh)—— 需要繁体时再单独加一个 locale。
 */
function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved !== null && isLocale(saved)) return saved
  } catch {
    // 隐私模式下 localStorage 会抛错,忽略即可
  }

  const prefix = navigator.language.split('-')[0]?.toLowerCase() ?? ''
  return isLocale(prefix) ? prefix : 'en'
}

interface I18nState {
  locale: Locale
  setLocale: (locale: Locale) => void
}

export const useI18nStore = create<I18nState>()((set) => ({
  locale: detectLocale(),
  setLocale: (locale) => {
    try {
      localStorage.setItem(STORAGE_KEY, locale)
    } catch {
      // 存不下就算了,本次会话内仍然生效
    }
    set({ locale })
  },
}))

/** `{name}` 占位符替换。缺少的参数原样保留,便于发现漏传。 */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  )
}

export function translate(
  locale: Locale,
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  // 理论上不会缺 —— 类型已经保证了 —— 但热更新期间可能短暂不一致
  const text = LOCALES[locale].translations[key] ?? en[key]
  return interpolate(text, params)
}

/**
 * 组件外用(工具函数、事件回调、抛异常)。
 *
 * 直接读当前 locale,不订阅 —— 所以**不要在组件渲染里用**,
 * 那样切换语言时不会重渲染。组件里用 useT()。
 */
export function tt(key: TranslationKey, params?: Record<string, string | number>): string {
  return translate(useI18nStore.getState().locale, key, params)
}

/**
 * 组件里用:`const t = useT()` 然后 `t('toolbar.save')`。
 *
 * 订阅了 locale,切换语言时组件会自动重渲染。
 */
export function useT(): (key: TranslationKey, params?: Record<string, string | number>) => string {
  const locale = useI18nStore((s) => s.locale)
  return (key, params) => translate(locale, key, params)
}

export type { TranslationKey } from './locales/en.ts'
