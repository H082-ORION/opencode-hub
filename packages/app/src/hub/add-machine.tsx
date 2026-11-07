import { createCopyFeedback } from "@opencode/session-ui/copy"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Loader } from "@opencode/ui/loader"
import { createSignal, Match, onCleanup, Show, Switch, untrack } from "solid-js"
import { errorText, hubApi, HubError, type EnrollmentCode } from "./api"
import { copy } from "./copy"
import type { Fail } from "./dashboard"

type CodeState =
  | { status: "loading"; request: number }
  | { status: "ready"; request: number; code: EnrollmentCode }
  | { status: "failed"; request: number; error: string }

const RUN_COMMAND = "opencode agent run"

export function AddMachineDialog(props: { fail: Fail }) {
  const dialog = useDialog()
  const [state, setState] = createSignal<CodeState>({ status: "loading", request: 0 })
  const [now, setNow] = createSignal(Date.now())
  const clock = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(clock))

  const request = () => {
    const current = untrack(state)

    if (current.status === "loading" && current.request > 0) return
    const id = current.request + 1
    setState({ status: "loading", request: id })
    hubApi.createCode().then(
      (code) => {
        if (untrack(state).request !== id) return
        setNow(Date.now())
        setState({ status: "ready", request: id, code })
      },
      (error: unknown) => {
        if (untrack(state).request !== id) return

        // A lost session closes the dialog and returns to sign-in.
        if (error instanceof HubError && error.status === 401) {
          dialog.close()

          return props.fail(copy.add.failed, error)
        }

        setState({ status: "failed", request: id, error: errorText(error) })
      },
    )
  }

  request()

  const ready = () => {
    const current = state()

    return current.status === "ready" ? current.code : undefined
  }

  const failure = () => {
    const current = state()

    return current.status === "failed" ? current.error : undefined
  }

  const remaining = () => Math.max(0, (ready()?.expiresAt ?? 0) - now())

  const countdown = () => {
    const seconds = Math.ceil(remaining() / 1000)

    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup title={copy.add.title} description={copy.add.description} />
      </DialogHeader>
      <DialogBody class="hub-dialog-body">
        <Switch>
          <Match when={state().status === "loading"}>
            <div class="hub-list-placeholder">
              <Loader class="size-4 text-v2-icon-icon-muted" />
            </div>
          </Match>
          <Match when={failure()}>
            {(error) => (
              <div class="hub-stack">
                <p class="hub-error" role="alert">
                  {error()}
                </p>
                <div>
                  <Button variant="neutral" size="small" onClick={request}>
                    {copy.add.retry}
                  </Button>
                </div>
              </div>
            )}
          </Match>
          <Match when={ready()} keyed>
            {(code) => (
              <div class="hub-stack">
                <div class="hub-code-block" data-expired={remaining() === 0 ? "" : undefined}>
                  <div class="hub-code-row">
                    <span class="hub-code" aria-label={copy.add.code}>
                      {code.code}
                    </span>
                    <Show when={remaining() > 0}>
                      <CopyButton text={code.code} />
                    </Show>
                  </div>
                  <span class="hub-code-expiry" role="status">
                    {remaining() === 0 ? copy.add.expired : copy.add.expiresIn(countdown())}
                  </span>
                  <Show when={remaining() === 0}>
                    <Button variant="neutral" size="small" icon="reset" onClick={request}>
                      {copy.add.newCode}
                    </Button>
                  </Show>
                </div>
                <div class="hub-step">
                  <span class="hub-step-title">{copy.add.step1}</span>
                  <CommandLine command={code.command} />
                </div>
                <div class="hub-step">
                  <span class="hub-step-title">{copy.add.step2}</span>
                  <CommandLine command={RUN_COMMAND} />
                </div>
              </div>
            )}
          </Match>
        </Switch>
      </DialogBody>
      <DialogFooter>
        <Button variant="neutral" onClick={() => dialog.close()}>
          {copy.done}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

function CommandLine(props: { command: string }) {
  return (
    <div class="hub-command">
      <code dir="ltr">{props.command}</code>
      <CopyButton text={props.command} />
    </div>
  )
}

function CopyButton(props: { text: string }) {
  const feedback = createCopyFeedback()

  return (
    <IconButton
      variant="ghost-muted"
      size="small"
      icon={<Icon name={feedback.copied() ? "check" : "outline-copy"} />}
      aria-label={feedback.copied() ? copy.copied : copy.copy}
      onClick={() => feedback.copy(props.text)}
    />
  )
}
