import { en } from "./i18n/en"

export type HubCopy = typeof en

const locales = import.meta.glob<{ default: HubCopy }>(["./i18n/*.ts", "!./i18n/en.ts"])

/** The hub's visible strings, in English until `loadCopy` fills in the chosen language. */
export const copy: HubCopy = { ...en }

/** Must run before the hub's modules load, as some read their strings at import time. Locales without a file stay in English. */
export async function loadCopy(locale: string) {
  const load = locales[`./i18n/${locale}.ts`]
  if (load) Object.assign(copy, (await load()).default)
}
