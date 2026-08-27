import { describe, expect, it } from 'vitest'
import { LOCALES, translate, type Locale } from './index.ts'
import { en } from './locales/en.ts'

const locales = Object.keys(LOCALES) as Locale[]
const englishKeys = Object.keys(en).sort()

describe('语言包完整性', () => {
  it.each(locales)('%s 的 key 集合与英语完全一致', (locale) => {
    // 类型系统已经挡住缺 key,但挡不住多余的 key,也挡不住热更新期间的不一致
    expect(Object.keys(LOCALES[locale].translations).sort()).toEqual(englishKeys)
  })

  it.each(locales)('%s 没有空字符串', (locale) => {
    const empty = Object.entries(LOCALES[locale].translations)
      .filter(([, value]) => value.trim() === '')
      .map(([key]) => key)
    expect(empty).toEqual([])
  })

  it.each(locales)('%s 的占位符和英语一致', (locale) => {
    const placeholders = (text: string) => (text.match(/\{(\w+)\}/g) ?? []).sort()

    for (const [key, english] of Object.entries(en)) {
      const translated = LOCALES[locale].translations[key as keyof typeof en]
      // 占位符名字写错会让界面显示出 {name} 这种字面量,而不是报错
      expect(placeholders(translated), `${locale} / ${key}`).toEqual(placeholders(english))
    }
  })

  it.each(locales)('%s 未原样照搬英文(抽查几条正文)', (locale) => {
    if (locale === 'en') return
    // 品牌名和 Atlas 这类术语允许一致,这里挑几条一定会翻译的
    const mustDiffer = ['toolbar.save', 'toolbar.undo', 'bones.title'] as const
    for (const key of mustDiffer) {
      expect(LOCALES[locale].translations[key], `${locale} / ${key}`).not.toBe(en[key])
    }
  })
})

describe('占位符替换', () => {
  it('替换命名参数', () => {
    expect(translate('en', 'status.imagesImported', { n: 3 })).toBe('Imported 3 image(s)')
    expect(translate('zh', 'status.imagesImported', { n: 3 })).toBe('已导入 3 张图片')
  })

  it('多个占位符', () => {
    expect(
      translate('en', 'timeline.trackLabel', { bone: 'arm', channel: 'Rotate' }),
    ).toBe('arm · Rotate')
  })

  it('漏传的参数原样保留,便于发现问题', () => {
    // 不静默替换成空串 —— 界面上看到 {error} 才知道漏了
    expect(translate('en', 'status.openFailed')).toBe('Open failed: {error}')
  })

  it('没有占位符的文案原样返回', () => {
    expect(translate('en', 'toolbar.save', { unused: 1 })).toBe('Save')
  })
})
