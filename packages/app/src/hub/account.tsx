import { Badge } from "@opencode/ui/badge"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { TextInput } from "@opencode/ui/text-input"
import { showToast } from "@opencode/ui/toast"
import { createSignal, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { errorText, hubApi, HubError, post, type HubSession } from "./api"
import { copy } from "./copy"
import type { Fail } from "./dashboard"
import { MIN_PASSWORD } from "./register"

export function AccountSection(props: { session: HubSession; fail: Fail; unlocked: boolean; onLocked: () => void }) {
  const dialog = useDialog()
  const unlocked = () => props.unlocked
  const [locking, setLocking] = createSignal(false)

  const lock = () => {
    if (locking()) return
    setLocking(true)
    hubApi.lock().then(
      () => {
        setLocking(false)
        props.onLocked()
        showToast({ variant: "success", title: copy.account.lockedToast })
      },
      (error: unknown) => {
        setLocking(false)
        props.fail(copy.account.lockFailed, error)
      },
    )
  }

  return (
    <section class="hub-section" aria-labelledby="hub-account-title">
      <div class="hub-section-header">
        <div class="hub-section-heading">
          <h2 id="hub-account-title" class="hub-section-title">
            {copy.account.title}
          </h2>
          <p class="hub-section-description">{copy.account.description}</p>
        </div>
      </div>
      <div class="hub-list">
        <div class="hub-row">
          <div class="hub-row-lead">
            <div class="hub-row-copy">
              <span class="hub-row-name">
                <bdi dir="auto">{props.session.user.login}</bdi>
                <Badge variant={props.session.user.role === "admin" ? "accent" : "neutral"}>
                  {props.session.user.role === "admin" ? copy.account.admin : copy.account.user}
                </Badge>
              </span>
            </div>
          </div>
        </div>
        <div class="hub-row">
          <div class="hub-row-lead">
            <div class="hub-row-copy">
              <span class="hub-row-name">{copy.account.password}</span>
              <span class="hub-row-meta">{copy.account.passwordDescription}</span>
            </div>
          </div>
          <div class="hub-row-actions">
            <Button
              variant="neutral"
              size="small"
              onClick={() => void dialog.show(() => <ChangePasswordDialog fail={props.fail} />)}
            >
              {copy.account.change}
            </Button>
          </div>
        </div>
        <div class="hub-row">
          <div class="hub-row-lead">
            <span
              class="hub-status"
              data-online={unlocked() ? "" : undefined}
              role="img"
              aria-label={unlocked() ? copy.account.unlocked : copy.account.locked}
            />
            <div class="hub-row-copy">
              <span class="hub-row-name">{copy.account.keys}</span>
              <span class="hub-row-meta">
                <span class="hub-row-url">{unlocked() ? copy.account.unlocked : copy.account.locked}</span>
              </span>
            </div>
          </div>
          <div class="hub-row-actions">
            <Button variant="neutral" size="small" disabled={!unlocked() || locking()} onClick={lock}>
              {copy.account.lock}
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}

type PasswordState = {
  status: "idle" | "submitting" | "failed"
  current: string
  next: string
  confirm: string
  error?: string
}

function ChangePasswordDialog(props: { fail: Fail }) {
  const dialog = useDialog()
  const [state, setState] = createStore<PasswordState>({ status: "idle", current: "", next: "", confirm: "" })

  const ready = () => state.status !== "submitting" && !!state.current && !!state.next

  const submit = (event: SubmitEvent) => {
    event.preventDefault()

    if (!ready()) return

    if (state.next.length < MIN_PASSWORD)
      return setState({ status: "failed", error: copy.register.tooShort(MIN_PASSWORD) })

    if (state.next !== state.confirm) return setState({ status: "failed", error: copy.register.mismatch })
    setState({ status: "submitting", error: undefined })
    change().then(
      (changed) => {
        if (!changed) return setState({ status: "failed", current: "", error: copy.password.wrong })
        dialog.close()
        showToast({ variant: "success", title: copy.password.changed })
      },
      (error: unknown) => {
        // A lost session closes the dialog and returns to sign-in.
        if (error instanceof HubError && error.status === 401) {
          dialog.close()

          return props.fail(copy.password.title, error)
        }

        setState({ status: "failed", error: errorText(error) })
      },
    )
  }

  const change = async () => {
    const { Account } = await import("@opencode/relay/account")

    return Account.changePassword({ post, password: state.current, newPassword: state.next })
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup title={copy.password.title} description={copy.password.description} />
      </DialogHeader>
      <form onSubmit={submit} class="contents">
        <DialogBody class="hub-dialog-body">
          <div class="hub-stack">
            <div class="hub-field">
              <label for="hub-password-current">{copy.password.current}</label>
              <TextInput
                id="hub-password-current"
                type="password"
                autocomplete="current-password"
                appearance="large"
                autofocus
                value={state.current}
                disabled={state.status === "submitting"}
                onInput={(event) => setState({ current: event.currentTarget.value })}
              />
            </div>
            <div class="hub-field">
              <label for="hub-password-next">{copy.password.next}</label>
              <TextInput
                id="hub-password-next"
                type="password"
                autocomplete="new-password"
                appearance="large"
                value={state.next}
                disabled={state.status === "submitting"}
                onInput={(event) => setState({ next: event.currentTarget.value })}
              />
            </div>
            <div class="hub-field">
              <label for="hub-password-confirm">{copy.password.confirm}</label>
              <TextInput
                id="hub-password-confirm"
                type="password"
                autocomplete="new-password"
                appearance="large"
                value={state.confirm}
                disabled={state.status === "submitting"}
                onInput={(event) => setState({ confirm: event.currentTarget.value })}
              />
            </div>
            <Show when={state.error}>
              <p class="hub-error" role="alert">
                {state.error}
              </p>
            </Show>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={state.status === "submitting"} onClick={() => dialog.close()}>
            {copy.cancel}
          </Button>
          <Button type="submit" variant="contrast" disabled={!ready()}>
            {state.status === "submitting" ? copy.password.submitting : copy.password.submit}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
