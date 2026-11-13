import type { FormInfo } from "@opencode/client/promise"
import { DockPrompt } from "@opencode/session-ui/dock-prompt"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { TextInput } from "@opencode/ui/text-input"
import { showToast } from "@opencode/ui/toast"
import { createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import {
  QUESTION_REQUEST_TIMEOUT_MS,
  buildFormAnswer,
  createQuestionDockState,
  isQuestionBusy,
  questionAnswer,
  questionDraft,
  questionSpecs,
  questionTab,
  transitionQuestionDock,
  type QuestionDockEvent,
} from "@/session/requests/question-machine"
import { hubApi } from "./api"
import { copy } from "./copy"

/**
 * A question the agent of a task asks, answered from the task's panel. OpenCode's question machine and dock, sending
 * the answer through the hub instead of straight to the machine.
 */
export function TaskQuestionDock(props: { task: string; request: FormInfo }) {
  const language = useLanguage()
  const questions = createMemo(() => questionSpecs(props.request))
  const [dock, setDock] = createSignal(createQuestionDockState(untrack(questions).length))
  const pending: { controller?: AbortController; timer?: ReturnType<typeof setTimeout> } = {}

  const abort = () => {
    clearTimeout(pending.timer)
    pending.controller?.abort()
    pending.controller = undefined
  }

  const dispatch = (event: QuestionDockEvent) => {
    const result = transitionQuestionDock(untrack(dock), event)
    if (result.state !== untrack(dock)) setDock(result.state)
    result.effects.forEach((effect) => {
      if (effect.type === "request.abort") return abort()
      if (effect.type === "toast.fail")
        return showToast({ variant: "error", title: copy.task.replyFailed, description: effect.error })
      if (effect.type !== "request.send") return
      abort()
      const controller = new AbortController()
      const attempt = effect.attempt
      pending.controller = controller
      pending.timer = setTimeout(() => dispatch({ type: "request.timed-out", attempt }), QUESTION_REQUEST_TIMEOUT_MS)
      const request = untrack(() => props.request)
      void (
        effect.action.type === "reply"
          ? hubApi.answerTask(props.task, request.id, effect.action.answer, request.sessionID)
          : hubApi.dismissTask(props.task, request.id, request.sessionID)
      ).then(
        () => dispatch({ type: "request.succeeded", attempt }),
        (error: Error) => dispatch({ type: "request.failed", attempt, error: error.message }),
      )
    })
  }
  onCleanup(() => dispatch({ type: "disposed" }))

  const tab = () => questionTab(dock())
  const busy = () => isQuestionBusy(dock())
  const spec = () => questions()[tab()]
  const draft = () => questionDraft(dock(), tab())
  const last = () => tab() >= questions().length - 1
  const multiple = () => spec()?.multiple === true

  const next = () => {
    if (busy()) return
    if (!last()) return dispatch({ type: "tab.select", tab: tab() + 1 })
    const current = untrack(dock)
    if (current.status !== "answering") return
    dispatch({ type: "send", action: { type: "reply", answer: buildFormAnswer(questions(), current.drafts) } })
  }

  return (
    <DockPrompt
      kind="question"
      header={
        <div data-slot="question-header-top">
          <div data-slot="question-header-title">
            <bdi>{spec()?.header || props.request.title}</bdi>
          </div>
          <Show when={questions().length > 1}>
            <div data-slot="question-progress">
              <For each={questions()}>
                {(_, index) => (
                  <button
                    type="button"
                    data-slot="question-progress-segment"
                    data-active={index() === tab()}
                    data-answered={questionAnswer(questions()[index()]!, questionDraft(dock(), index())).length > 0}
                    disabled={busy()}
                    onClick={() => dispatch({ type: "tab.select", tab: index() })}
                    aria-label={language.t("ui.tool.questions.numbered", { number: index() + 1 })}
                    aria-current={index() === tab() ? "step" : undefined}
                  >
                    <span data-slot="question-progress-bar" aria-hidden="true" />
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      }
      footer={
        <>
          <Button
            variant="ghost"
            size="normal"
            disabled={busy()}
            onClick={() => dispatch({ type: "send", action: { type: "dismiss" } })}
          >
            {language.t("ui.common.dismiss")}
          </Button>
          <div data-slot="question-footer-actions">
            <Show when={tab() > 0}>
              <Button
                variant="ghost"
                size="normal"
                disabled={busy()}
                onClick={() => dispatch({ type: "tab.select", tab: tab() - 1 })}
              >
                {language.t("ui.common.back")}
              </Button>
            </Show>
            <Button variant={last() ? "submit" : "neutral"} size="normal" disabled={busy()} onClick={next}>
              {last() ? language.t("ui.common.submit") : language.t("ui.common.next")}
            </Button>
          </div>
        </>
      }
    >
      <Show when={spec()}>
        {(current) => (
          <>
            <div data-slot="question-text">
              <bdi>{current().question}</bdi>
            </div>
            <div data-slot="question-options" role={multiple() ? "group" : "radiogroup"}>
              <For each={current().options}>
                {(option) => {
                  const picked = () => draft().selected.includes(option.value)
                  return (
                    <div
                      data-slot="question-option"
                      data-picked={picked()}
                      data-disabled={busy()}
                      role={multiple() ? "checkbox" : "radio"}
                      aria-checked={picked()}
                      aria-disabled={busy()}
                      tabindex={busy() ? -1 : 0}
                      onClick={() =>
                        !busy() && dispatch({ type: "option.pick", value: option.value, multiple: multiple() })
                      }
                      onKeyDown={(event) => {
                        if (event.key !== " " && event.key !== "Enter") return
                        event.preventDefault()
                        if (!busy()) dispatch({ type: "option.pick", value: option.value, multiple: multiple() })
                      }}
                    >
                      <span data-slot="question-option-check" aria-hidden="true">
                        <span
                          data-slot="question-option-box"
                          data-type={multiple() ? "checkbox" : "radio"}
                          data-picked={picked()}
                        >
                          <Show when={multiple()} fallback={<span data-slot="question-option-radio-dot" />}>
                            <Icon name="check" size="normal" />
                          </Show>
                        </span>
                      </span>
                      <span data-slot="question-option-main">
                        <span data-slot="option-label">
                          <bdi>{option.label}</bdi>
                        </span>
                        <Show when={option.description}>
                          <span data-slot="option-description">
                            <bdi>{option.description}</bdi>
                          </span>
                        </Show>
                      </span>
                    </div>
                  )
                }}
              </For>
              <TextInput
                value={draft().customText}
                placeholder={language.t("ui.question.custom.placeholder")}
                disabled={busy()}
                onInput={(event) =>
                  dispatch({ type: "custom.input", text: event.currentTarget.value, multiple: multiple() })
                }
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.isComposing) return
                  event.preventDefault()
                  next()
                }}
              />
            </div>
          </>
        )}
      </Show>
    </DockPrompt>
  )
}
