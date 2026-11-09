// @refresh reload

import "@/runtime/polyfills"
import "@/index.css"
import "./hub.css"
import { loadInitialLocale, LanguageProvider, UiI18nBridge, useLanguage } from "@/runtime/i18n/language"
import { PlatformProvider } from "@/runtime/platform/platform"
import { createWebPlatform } from "@/runtime/platform/web"
import { SettingsProvider } from "@/settings/model"
import { DialogProvider } from "@opencode/ui/context/dialog"
import { ThemeProvider } from "@opencode/ui/theme/context"
import { Toast } from "@opencode/ui/toast"
import { MetaProvider, Title } from "@solidjs/meta"
import { createEffect, on } from "solid-js"
import { render } from "solid-js/web"
import pkg from "../../package.json"
import { copy, loadCopy } from "./copy"

// The hub dashboard (`opencode hub`): the app's theme, fonts, language and components, without a server runtime.
const root = document.getElementById("root")

/** The hub's own strings are chosen once at startup, so a new language takes a reload to reach them. */
function ReloadOnLanguageChange() {
  const language = useLanguage()
  createEffect(on(language.locale, () => location.reload(), { defer: true }))
  return null
}

if (root instanceof HTMLElement)
  void loadInitialLocale().then(async (locale) => {
    await loadCopy(locale)
    const { Hub } = await import("./hub")
    render(
      () => (
        <MetaProvider>
          <Title>{copy.title}</Title>
          <PlatformProvider value={createWebPlatform(import.meta.env.VITE_OPENCODE_VERSION ?? pkg.version).platform}>
            <ThemeProvider>
              <LanguageProvider locale={locale}>
                <UiI18nBridge>
                  <SettingsProvider>
                    <DialogProvider>
                      <ReloadOnLanguageChange />
                      <Hub />
                      <Toast.Region />
                    </DialogProvider>
                  </SettingsProvider>
                </UiI18nBridge>
              </LanguageProvider>
            </ThemeProvider>
          </PlatformProvider>
        </MetaProvider>
      ),
      root,
    )
  })
