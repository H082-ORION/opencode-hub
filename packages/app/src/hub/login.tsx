import { Button } from "@opencode/ui/button"
import { TextInput } from "@opencode/ui/text-input"
import { Wordmark } from "@opencode/ui/wordmark"
import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { errorText, hubApi } from "./api"
import { copy } from "./copy"

type LoginState = { status: "idle" | "submitting" | "failed"; password: string; error?: string }

export function Login() {
  // A machine host sends signed-out browsers to `/login?next=<machine url>`.
  const next = new URLSearchParams(location.search).get("next") ?? undefined
  const [state, setState] = createStore<LoginState>({ status: "idle", password: "" })

  const submit = (event: SubmitEvent) => {
    event.preventDefault()

    if (state.status === "submitting" || !state.password) return
    setState({ status: "submitting", error: undefined })
    hubApi.login(state.password, next).then(
      (result) => location.assign(result.redirect),
      (error: unknown) => setState({ status: "failed", password: "", error: errorText(error) }),
    )
  }

  return (
    <main class="hub-login" aria-labelledby="hub-login-title">
      <div class="hub-login-content">
        <div class="hub-login-brand" role="img" aria-label="OpenCode">
          <Wordmark fade={false} />
        </div>
        <header>
          <h1 id="hub-login-title">{copy.login.title}</h1>
          <p>{next ? copy.login.machineDescription : copy.login.description}</p>
        </header>
        <form onSubmit={submit}>
          <div class="hub-field">
            <label for="hub-password">{copy.login.password}</label>
            <TextInput
              id="hub-password"
              name="password"
              type="password"
              autocomplete="current-password"
              appearance="large"
              autofocus
              required
              invalid={state.status === "failed"}
              value={state.password}
              disabled={state.status === "submitting"}
              aria-describedby={state.error ? "hub-login-error" : undefined}
              onInput={(event) => setState({ password: event.currentTarget.value })}
            />
          </div>
          <Show when={state.error}>
            <p id="hub-login-error" class="hub-error" role="alert">
              {state.error}
            </p>
          </Show>
          <Button
            type="submit"
            variant="contrast"
            size="large"
            disabled={state.status === "submitting" || !state.password}
          >
            {state.status === "submitting" ? copy.login.submitting : copy.login.submit}
          </Button>
        </form>
      </div>
    </main>
  )
}
