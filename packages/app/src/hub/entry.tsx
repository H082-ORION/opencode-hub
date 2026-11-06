// @refresh reload

import "@/runtime/polyfills"
import "@/index.css"
import "./hub.css"
import { DialogProvider } from "@opencode/ui/context/dialog"
import { ThemeProvider } from "@opencode/ui/theme/context"
import { Toast } from "@opencode/ui/toast"
import { MetaProvider, Title } from "@solidjs/meta"
import { render } from "solid-js/web"
import { copy } from "./copy"
import { Hub } from "./hub"

// The hub dashboard (`opencode hub`): the app's theme, fonts and components, without a server runtime.
const root = document.getElementById("root")

if (root instanceof HTMLElement)
  render(
    () => (
      <MetaProvider>
        <Title>{copy.title}</Title>
        <ThemeProvider>
          <DialogProvider>
            <Hub />
            <Toast.Region />
          </DialogProvider>
        </ThemeProvider>
      </MetaProvider>
    ),
    root,
  )
