import { en } from "./i18n/en"

export type HubCopy = typeof en

/**
 * A translation: any section, or any string of a section, may be left out, and English shows in its place until it
 * is translated.
 */
export type HubLocale = {
  [Key in keyof HubCopy]?: HubCopy[Key] extends Record<string, unknown> ? Partial<HubCopy[Key]> : HubCopy[Key]
}

const locales = import.meta.glob<{ default: HubLocale }>(["./i18n/*.ts", "!./i18n/en.ts"])

/** The hub's visible strings, in English until `loadCopy` fills in the chosen language. */
export const copy: HubCopy = { ...en }

/** Must run before the hub's modules load, as some read their strings at import time. Locales without a file stay in English. */
export async function loadCopy(locale: string) {
  const load = locales[`./i18n/${locale}.ts`]
  if (!load) return
  const translated = (await load()).default
  // Section by section, so a section the translation lacks a string of keeps the English one.
  for (const key of Object.keys(translated) as (keyof HubCopy)[]) {
    const value = translated[key]
    const english = en[key]
    Object.assign(copy, {
      [key]: typeof value === "object" && typeof english === "object" ? { ...english, ...value } : value,
    })
  }
}
