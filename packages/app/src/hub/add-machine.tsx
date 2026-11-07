import { createCopyFeedback } from "@opencode/session-ui/copy"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Loader } from "@opencode/ui/loader"
import { createSignal, For, Match, onCleanup, Show, Switch, untrack } from "solid-js"
import { errorText, hubApi, HubError, type EnrollmentCode, type HubMembership } from "./api"
import { copy } from "./copy"
import type { Fail } from "./dashboard"

type CodeState =
  | { status: "loading"; request: number }
  /** The user belongs to organizations: they choose whom the machine is for before any code exists. */
  | { status: "choose"; request: number; orgs: HubMembership[] }
  | { status: "ready"; request: number; code: EnrollmentCode }
  | { status: "failed"; request: number; error: string }

const RUN_COMMAND = "opencode agent run"

export function AddMachineDialog(props: { fail: Fail }) {
  const dialog = useDialog()
  const [state, setState] = createSignal<CodeState>({ status: "loading", request: 0 })
  // Whom the code is for: undefined for the user, or the id of one of their organizations. Kept for "New code".
  const [target, setTarget] = createSignal<string>()
  const [now, setNow] = createSignal(Date.now())
  const clock = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(clock))

  /** A lost session closes the dialog and returns to sign-in; any other failure shows in the dialog. */
  const failed = (id: number, error: HubError) => {
    if (untrack(state).request !== id) return

    if (error instanceof HubError && error.status === 401) {
      dialog.close()

      return props.fail(copy.add.failed, error)
    }

    setState({ status: "failed", request: id, error: errorText(error) })
  }

  // Without organizations there is nothing to choose: the code is for the user, as before.
  hubApi.memberships().then(
    (orgs) => {
      if (untrack(state).request !== 0) return
      if (orgs.length === 0) return request()
      setState({ status: "choose", request: 0, orgs })
    },
    (error: HubError) => failed(0, error),
  )

  const choose = (org?: string) => {
    setTarget(org)
    request()
  }

  const request = () => {
    const current = untrack(state)

    if (current.status === "loading" && current.request > 0) return
    const id = current.request + 1
    setState({ status: "loading", request: id })
    hubApi.createCode(untrack(target)).then(
      (code) => {
        if (untrack(state).request !== id) return
        setNow(Date.now())
        setState({ status: "ready", request: id, code })
      },
      (error: HubError) => failed(id, error),
    )
  }

  const ready = () => {
    const current = state()

    return current.status === "ready" ? current.code : undefined
  }

  const choices = () => {
    const current = state()

    return current.status === "choose" ? current.orgs : undefined
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
        <DialogTitleGroup title={copy.add.title} description={choices() ? copy.add.choose : copy.add.description} />
      </DialogHeader>
      <DialogBody class="hub-dialog-body">
        <Switch>
          <Match when={choices()}>
            {(orgs) => (
              <div class="hub-list">
                <TargetRow title={copy.add.forMe} description={copy.add.forMeDescription} onSelect={() => choose()} />
                <For each={orgs()}>
                  {(org) => (
                    <TargetRow
                      title={copy.add.forOrg(org.name)}
                      description={copy.add.forOrgDescription}
                      onSelect={() => choose(org.id)}
                    />
                  )}
                </For>
              </div>
            )}
          </Match>
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

/** One choice of whom a new machine is for. */
function TargetRow(props: { title: string; description: string; onSelect: () => void }) {
  return (
    <div class="hub-row">
      <div class="hub-row-lead">
        <div class="hub-row-copy">
          <span class="hub-row-name">
            <bdi dir="auto">{props.title}</bdi>
          </span>
          <span class="hub-row-meta">
            <span>{props.description}</span>
          </span>
        </div>
      </div>
      <div class="hub-row-actions">
        <Button variant="neutral" size="small" onClick={props.onSelect}>
          {copy.add.select}
        </Button>
      </div>
    </div>
  )
}

/** A one-line command or link with a copy button. */
export function CommandLine(props: { command: string }) {
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
