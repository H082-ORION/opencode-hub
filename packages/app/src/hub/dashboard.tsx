import { Button } from "@opencode/ui/button"
import { Mark } from "@opencode/ui/logo"
import { showToast } from "@opencode/ui/toast"
import { errorText, hubApi, HubError } from "./api"
import { copy } from "./copy"
import { Machines } from "./machines"
import { Providers } from "./providers"

export function Dashboard(props: { onSignedOut: () => void }) {
  /** Reports a failed request; one refused for a missing session returns to the sign-in form instead. */
  const fail = (title: string, error: unknown) => {
    if (error instanceof HubError && error.status === 401) return props.onSignedOut()
    showToast({ variant: "error", title, description: errorText(error) })
  }

  const signOut = () => hubApi.logout().then(props.onSignedOut, (error: unknown) => fail(copy.error.unknown, error))

  return (
    <div class="hub-shell">
      <header class="hub-topbar">
        <div class="hub-topbar-brand">
          <Mark class="hub-topbar-mark" />
          <span class="hub-topbar-title">{copy.hub}</span>
        </div>
        <Button variant="ghost" size="small" onClick={signOut}>
          {copy.signOut}
        </Button>
      </header>
      <main class="hub-scroll" data-scrollable>
        <div class="hub-content">
          <Machines onSignedOut={props.onSignedOut} fail={fail} />
          <Providers fail={fail} />
        </div>
      </main>
    </div>
  )
}

export type Fail = (title: string, error: unknown) => void
