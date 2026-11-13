import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { Spinner } from "@opencode/ui/spinner"
import { For } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { hubApi, type HubTask } from "./api"
import { useChat } from "./chat-context"
import { copy } from "./copy"
import "./chat-task-strip.css"

/**
 * The tasks of the open conversation still at work, above the composer: one row each with its status, machine, model
 * and cost, which opens the task's panel; and one button to stop them all (stopping the chat's own answer never does).
 */
export function ChatTaskStrip(props: { tasks: readonly HubTask[]; modelName: (reference: string) => string }) {
  const chat = useChat()
  const language = useLanguage()

  const cost = (task: HubTask) =>
    task.cost > 0
      ? new Intl.NumberFormat(language.locale(), { style: "currency", currency: "USD" }).format(task.cost)
      : undefined

  const stopAll = () => void Promise.all(props.tasks.map((task) => hubApi.stopTask(task.id))).catch(chat.fail)

  return (
    <div class="hub-task-strip" role="status" aria-label={copy.task.tasks}>
      <ul class="hub-task-strip-list">
        <For each={props.tasks}>
          {(task) => (
            <li>
              <button
                type="button"
                class="hub-task-strip-row"
                data-status={task.status}
                data-active={chat.task() === task.id ? "" : undefined}
                title={`${task.title} — ${task.machineName}`}
                onClick={() => chat.openTask(task.id)}
              >
                <span class="hub-task-strip-icon" aria-hidden="true">
                  {task.status === "running" || task.status === "starting" ? (
                    <Spinner class="size-4" />
                  ) : (
                    <Icon name="warning" size="small" />
                  )}
                </span>
                <span class="hub-task-strip-title">{task.title}</span>
                <span class="hub-task-strip-meta">
                  <span>{task.machineName}</span>
                  {task.model ? <span>{props.modelName(task.model)}</span> : null}
                  {cost(task) ? <span>{cost(task)}</span> : null}
                  <span class="hub-task-strip-status">{copy.task.status[task.status]}</span>
                </span>
              </button>
            </li>
          )}
        </For>
      </ul>
      <Button variant="ghost" size="small" onClick={stopAll}>
        {copy.task.stopAll}
      </Button>
    </div>
  )
}
