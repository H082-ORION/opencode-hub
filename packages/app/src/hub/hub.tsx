import { Loader } from "@opencode/ui/loader"
import { createSignal, Match, onMount, Switch } from "solid-js"
import { hubApi } from "./api"
import { Dashboard } from "./dashboard"
import { Login } from "./login"

type Session = "checking" | "signed-out" | "signed-in"

export function Hub() {
  const [session, setSession] = createSignal<Session>("checking")

  onMount(() => {
    // Any failure, including a hub that cannot be reached, shows the sign-in form, which reports its own errors.
    void hubApi.session().then(
      () => setSession("signed-in"),
      () => setSession("signed-out"),
    )
  })

  return (
    <Switch>
      <Match when={session() === "checking"}>
        <div class="hub-center">
          <Loader class="size-4 text-v2-icon-icon-muted" />
        </div>
      </Match>
      <Match when={session() === "signed-out"}>
        <Login />
      </Match>
      <Match when={session() === "signed-in"}>
        <Dashboard onSignedOut={() => setSession("signed-out")} />
      </Match>
    </Switch>
  )
}
