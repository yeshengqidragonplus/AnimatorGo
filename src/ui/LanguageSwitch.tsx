import { LOCALES, useI18nStore, useT, type Locale } from '@i18n/index.ts'

export function LanguageSwitch() {
  const t = useT()
  const locale = useI18nStore((s) => s.locale)
  const setLocale = useI18nStore((s) => s.setLocale)

  return (
    <select
      className="language-switch"
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      title={t('toolbar.language')}
      aria-label={t('toolbar.language')}
    >
      {(Object.keys(LOCALES) as Locale[]).map((key) => (
        <option key={key} value={key}>
          {LOCALES[key].label}
        </option>
      ))}
    </select>
  )
}
