import { Loader } from "@opencode/ui/loader"
import { createSignal, Match, onMount, Switch } from "solid-js"
import { hubApi, type HubSession } from "./api"
import { Dashboard } from "./dashboard"
import { Login } from "./login"
import { Register } from "./register"

type Session = { status: "checking" } | { status: "signed-out" } | { status: "signed-in"; session: HubSession }

export function Hub() {
  // An invitation link opens the registration page whether or not someone is signed in on this browser.
  if (location.pathname === "/register") return <Register />

  const [session, setSession] = createSignal<Session>({ status: "checking" })

  onMount(() => {
    // Any failure, including a hub that cannot be reached, shows the sign-in form, which reports its own errors.
    void hubApi.session().then(
      (current) => setSession({ status: "signed-in", session: current }),
      () => setSession({ status: "signed-out" }),
    )
  })

  const signedIn = () => {
    const current = session()

    return current.status === "signed-in" ? current.session : undefined
  }

  return (
    <Switch>
      <Match when={session().status === "checking"}>
        <div class="hub-center">
          <Loader class="size-4 text-v2-icon-icon-muted" />
        </div>
      </Match>
      <Match when={session().status === "signed-out"}>
        <Login />
      </Match>
      <Match when={signedIn()}>
        {(current) => <Dashboard session={current()} onSignedOut={() => setSession({ status: "signed-out" })} />}
      </Match>
    </Switch>
  )
}
