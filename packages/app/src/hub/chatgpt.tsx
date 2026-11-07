import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { TextInput } from "@opencode/ui/text-input"
import { createMemo, createSignal, Show, untrack } from "solid-js"
import { errorText, hubApi, HubError } from "./api"
import { copy } from "./copy"
import type { Fail } from "./dashboard"
import { createChatGPT, transitionChatGPT, viewChatGPT, type ChatGPTEffect, type ChatGPTEvent } from "./machine"

export function ChatGPTDialog(props: { onConnected: () => void; onLocked: () => void; fail: Fail }) {
  const dialog = useDialog()
  const initial = createChatGPT()
  const [state, setState] = createSignal(initial.state)
  const view = createMemo(() => viewChatGPT(state()))

  const dispatch = (event: ChatGPTEvent) => {
    const next = transitionChatGPT(untrack(state), event)

    if (next.state !== untrack(state)) setState(next.state)
    next.effects.forEach(run)
  }

  // A lost session closes the dialog and returns to sign-in; every other failure stays in the dialog. Locked keys also
  // show on the dashboard behind it.
  const signedOut = (error: unknown) => {
    if (error instanceof HubError && error.status === 423) props.onLocked()

    if (!(error instanceof HubError && error.status === 401)) return false
    dialog.close()
    props.fail(copy.error.unknown, error)

    return true
  }

  function run(effect: ChatGPTEffect) {
    if (effect.type === "connected") return props.onConnected()

    if (effect.type === "begin")
      return void hubApi.chatgptBegin().then(
        (signIn) => dispatch({ type: "begin.succeeded", request: effect.request, signIn }),
        (error: unknown) =>
          signedOut(error) || dispatch({ type: "begin.failed", request: effect.request, error: errorText(error) }),
      )
    void hubApi.chatgptComplete(effect.attempt, effect.callback).then(
      () => dispatch({ type: "complete.succeeded", request: effect.request }),
      (error: unknown) =>
        signedOut(error) || dispatch({ type: "complete.failed", request: effect.request, error: errorText(error) }),
    )
  }

  // The sign-in URL is fetched as the dialog opens, so the button can open it within the click and avoid popup blocking.
  initial.effects.forEach(run)

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup title={copy.chatgpt.title} description={copy.chatgpt.description} />
      </DialogHeader>
      <Show
        when={!view().done}
        fallback={
          <>
            <DialogBody class="hub-dialog-body">
              <div class="hub-success" role="status">
                <Icon name="check" class="text-icon-success-base" />
                <div class="hub-stack-tight">
                  <span class="hub-step-title">{copy.chatgpt.success}</span>
                  <p class="hub-hint">{copy.chatgpt.successDescription}</p>
                </div>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button variant="contrast" autofocus onClick={() => dialog.close()}>
                {copy.done}
              </Button>
            </DialogFooter>
          </>
        }
      >
        <form
          class="contents"
          onSubmit={(event) => {
            event.preventDefault()
            dispatch({ type: "submitted" })
          }}
        >
          <DialogBody class="hub-dialog-body">
            <div class="hub-stack">
              <div class="hub-step">
                <span class="hub-step-title">
                  <span class="hub-step-number">1</span>
                  {copy.chatgpt.step1}
                </span>
                <div>
                  <Button
                    variant="neutral"
                    icon="arrow-up-right"
                    disabled={!view().url}
                    onClick={() => {
                      const url = view().url

                      if (url) window.open(url, "_blank", "noopener")
                    }}
                  >
                    {view().preparing ? copy.chatgpt.preparing : copy.chatgpt.open}
                  </Button>
                </div>
              </div>
              <div class="hub-step">
                <label class="hub-step-title" for="hub-chatgpt-callback">
                  <span class="hub-step-number">2</span>
                  {copy.chatgpt.callback}
                </label>
                <p class="hub-hint">{copy.chatgpt.step2}</p>
                <TextInput
                  id="hub-chatgpt-callback"
                  appearance="large"
                  dir="ltr"
                  inputMode="url"
                  autocapitalize="off"
                  autocomplete="off"
                  spellcheck={false}
                  placeholder={copy.chatgpt.callbackPlaceholder}
                  value={view().callback}
                  invalid={!!view().error}
                  disabled={view().busy}
                  aria-describedby={view().error ? "hub-chatgpt-error" : undefined}
                  onInput={(event) => dispatch({ type: "callback.changed", value: event.currentTarget.value })}
                />
              </div>
              <Show when={view().error}>
                <p id="hub-chatgpt-error" class="hub-error" role="alert">
                  {view().error}
                </p>
              </Show>
            </div>
          </DialogBody>
          <DialogFooter>
            <Show when={view().canRestart}>
              <Button variant="ghost" onClick={() => dispatch({ type: "restarted" })}>
                {copy.chatgpt.restart}
              </Button>
            </Show>
            <Button type="submit" variant="contrast" disabled={!view().canSubmit}>
              {view().busy ? copy.chatgpt.completing : copy.chatgpt.complete}
            </Button>
          </DialogFooter>
        </form>
      </Show>
    </Dialog>
  )
}
