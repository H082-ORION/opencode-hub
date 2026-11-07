import { Button } from "@opencode/ui/button"
import { Loader } from "@opencode/ui/loader"
import { TextInput } from "@opencode/ui/text-input"
import { Wordmark } from "@opencode/ui/wordmark"
import { Match, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { errorText, hubApi, post } from "./api"
import { copy } from "./copy"

/** Client-side only: the hub never sees the password, so it cannot enforce a length itself. */
export const MIN_PASSWORD = 8

type RegisterState = {
  status: "checking" | "invalid" | "idle" | "submitting" | "failed"
  /** The account a reset invitation re-registers; its login is fixed. */
  reset?: string
  login: string
  password: string
  confirm: string
  error?: string
}

export function Register() {
  const invite = new URLSearchParams(location.search).get("invite") ?? ""
  const [state, setState] = createStore<RegisterState>({ status: "checking", login: "", password: "", confirm: "" })

  onMount(() => {
    if (!invite) return setState({ status: "invalid", error: copy.register.missing })
    hubApi.invitationFor(invite).then(
      (invitation) => setState({ status: "idle", reset: invitation.login ?? undefined }),
      (error: unknown) => setState({ status: "invalid", error: errorText(error) }),
    )
  })

  const problem = () => {
    if (state.password.length < MIN_PASSWORD) return copy.register.tooShort(MIN_PASSWORD)

    if (state.password !== state.confirm) return copy.register.mismatch

    return undefined
  }

  const ready = () => state.status !== "submitting" && (!!state.reset || !!state.login) && !!state.password

  const submit = (event: SubmitEvent) => {
    event.preventDefault()

    if (!ready()) return
    const invalid = problem()

    if (invalid) return setState({ status: "failed", error: invalid })
    setState({ status: "submitting", error: undefined })
    create().then(
      (result) => location.assign(result.redirect),
      (error: unknown) => setState({ status: "failed", error: errorText(error) }),
    )
  }

  const create = async () => {
    // OPAQUE and its WebAssembly load only on this page and the sign-in page.
    const { Account } = await import("@opencode/relay/account")

    return Account.register({ post, invite, login: state.reset ?? state.login, password: state.password })
  }

  return (
    <main class="hub-login" aria-labelledby="hub-register-title">
      <div class="hub-login-content">
        <div class="hub-login-brand" role="img" aria-label="OpenCode">
          <Wordmark fade={false} />
        </div>
        <header>
          <h1 id="hub-register-title">{state.reset ? copy.register.resetTitle : copy.register.title}</h1>
          <p>{state.reset ? copy.register.resetDescription(state.reset) : copy.register.description}</p>
        </header>
        <Switch>
          <Match when={state.status === "checking"}>
            <div class="hub-list-placeholder" role="status" aria-label={copy.register.checking}>
              <Loader class="size-4 text-v2-icon-icon-muted" />
            </div>
          </Match>
          <Match when={state.status === "invalid"}>
            <p class="hub-error" role="alert">
              {state.error}
            </p>
            <Button variant="neutral" size="large" onClick={() => location.assign("/login")}>
              {copy.register.signIn}
            </Button>
          </Match>
          <Match when={true}>
            <form onSubmit={submit}>
              <div class="hub-field">
                <label for="hub-register-login">{copy.register.login}</label>
                <TextInput
                  id="hub-register-login"
                  name="username"
                  autocomplete="username"
                  autocapitalize="off"
                  spellcheck={false}
                  appearance="large"
                  autofocus={!state.reset}
                  required
                  readOnly={!!state.reset}
                  value={state.reset ?? state.login}
                  disabled={state.status === "submitting"}
                  aria-describedby="hub-register-login-hint"
                  onInput={(event) => setState({ login: event.currentTarget.value })}
                />
                <p id="hub-register-login-hint" class="hub-hint">
                  {copy.register.loginHint}
                </p>
              </div>
              <div class="hub-field">
                <label for="hub-register-password">{copy.register.password}</label>
                <TextInput
                  id="hub-register-password"
                  name="new-password"
                  type="password"
                  autocomplete="new-password"
                  appearance="large"
                  autofocus={!!state.reset}
                  required
                  value={state.password}
                  disabled={state.status === "submitting"}
                  onInput={(event) => setState({ password: event.currentTarget.value })}
                />
              </div>
              <div class="hub-field">
                <label for="hub-register-confirm">{copy.register.confirm}</label>
                <TextInput
                  id="hub-register-confirm"
                  name="confirm-password"
                  type="password"
                  autocomplete="new-password"
                  appearance="large"
                  required
                  invalid={state.status === "failed"}
                  value={state.confirm}
                  disabled={state.status === "submitting"}
                  aria-describedby={state.error ? "hub-register-error" : undefined}
                  onInput={(event) => setState({ confirm: event.currentTarget.value })}
                />
              </div>
              <Show when={state.error}>
                <p id="hub-register-error" class="hub-error" role="alert">
                  {state.error}
                </p>
              </Show>
              <Button type="submit" variant="contrast" size="large" disabled={!ready()}>
                {state.status === "submitting"
                  ? copy.register.submitting
                  : state.reset
                    ? copy.register.resetSubmit
                    : copy.register.submit}
              </Button>
            </form>
          </Match>
        </Switch>
      </div>
    </main>
  )
}
