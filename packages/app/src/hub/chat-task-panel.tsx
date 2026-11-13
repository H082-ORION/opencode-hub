import { OpenCode } from "@opencode/client/promise"
import { createClientConnection, createData } from "@opencode/client/solid"
import { DataProvider } from "@opencode/session-ui/context/data"
import { SessionTimeline } from "@opencode/session-ui/timeline"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Loader } from "@opencode/ui/loader"
import { Spinner } from "@opencode/ui/spinner"
import { Textarea } from "@opencode/ui/textarea"
import { showToast } from "@opencode/ui/toast"
import { Tooltip } from "@opencode/ui/tooltip"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { useSettings } from "@/settings/model"
import { SessionPermissionDock } from "@/session/requests/session-permission-dock"
import { errorText, hubApi, type HubTask } from "./api"
import { useChat, type ChatEventMap } from "./chat-context"
import { projectName } from "./chat-machine"
import { TaskQuestionDock } from "./chat-task-question"
import { taskUpdate } from "./chat-tasks"
import { providerCatalog } from "./models"
import { copy } from "./copy"
import {
  CLOSED_TASK_PANEL,
  transitionTaskPanel,
  viewTaskPanel,
  type TaskPanelEffect,
  type TaskPanelEvent,
} from "./task-panel-machine"
import "./chat-task-panel.css"

const STICK_DISTANCE = 80
const noticeText = {
  reconnecting: () => copy.task.reconnecting,
  waiting: () => copy.task.waiting,
  offline: () => copy.task.offline,
  lost: (task: HubTask | undefined) => task?.error ?? copy.task.lost,
  failed: (task: HubTask | undefined) => task?.error ?? copy.task.failed,
}
const IS_MAC = typeof navigator !== "undefined" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform)

/**
 * The right-hand panel of a task handed to a machine: its session there, live, with OpenCode's own timeline, the
 * permissions and questions it waits on, and a composer to steer it or queue a follow-up. Keyed by task: another
 * task gets a new client, stream and data.
 */
export function ChatTaskPanel(props: { task: string }) {
  const chat = useChat()
  const language = useLanguage()
  const settings = useSettings()
  const task = () => chat.tasks.get(props.task)

  const [panel, setPanel] = createSignal(CLOSED_TASK_PANEL)
  const view = createMemo(() => viewTaskPanel(panel()))
  const dispatch = (event: TaskPanelEvent) => {
    const result = transitionTaskPanel(untrack(panel), event)
    if (result.state !== untrack(panel)) setPanel(result.state)
    result.effects.forEach(run)
  }

  const api = OpenCode.make({
    baseUrl: `${location.origin}/hub/api/chat-tasks/${encodeURIComponent(props.task)}`,
    headers: { "content-type": "application/json" },
  })
  const emitter = createGlobalEmitter<ChatEventMap>()
  onCleanup(() => emitter.clear())
  // The hub opens each stream with `server.connected`; another one on the same stream means the machine's stream behind
  // the hub came back, and whatever happened meanwhile has to be read again.
  const stream = { opened: false }
  const connection = createClientConnection(api, {
    flushInterval: 16,
    pageLifecycle: true,
    onEvent: (event) => {
      const update = taskUpdate(event)
      if (update) {
        chat.tasks.put(update)
        return dispatch({ type: "update", attempt: untrack(panel).attempt, task: update.id, status: update.status })
      }
      // SAFETY: the hub's own event, outside OpenCode's union: the hub cut this stream, which reconnects and reads again.
      if ((event.type as string) === "hub.task.resync") return
      if (event.type === "server.connected") {
        if (stream.opened) dispatch({ type: "resync", attempt: untrack(panel).attempt })
        stream.opened = true
      }
      emitter.emit(event.type, event)
    },
  })
  const data = createData({
    api: () => api,
    directory: untrack(task)?.directory ?? "",
    event: { on: emitter.on, listen: (handler) => emitter.listen((event) => handler(event)) },
    connection,
    // Screenshots are what the panel is for.
    omitToolFileData: false,
    // Reads behind events are advisory: the panel's own state reports the stream, and the next sync fixes the rest.
    onError: () => undefined,
  })

  onMount(() => dispatch({ type: "open", task: props.task }))
  createEffect(
    on(connection.status, (status) => {
      if (status !== "connected") stream.opened = false
      dispatch({ type: "connection", attempt: untrack(panel).attempt, connected: status === "connected" })
    }),
  )

  const remote = () => task()?.remoteSession ?? undefined

  function run(effect: TaskPanelEffect) {
    const id = untrack(remote)
    if (effect.type !== "sync" || !id) return
    data.session.invalidate(id)
    data.session.message.invalidate(id)
    data.session.pending.invalidate(id)
    data.session.permission.invalidate(id)
    data.session.form.invalidate(id)
    void Promise.all([
      data.session.sync(id),
      data.session.message.sync(id),
      data.session.pending.sync(id),
      data.session.permission.sync(id),
      data.session.form.sync(id),
    ]).catch(() => undefined)
  }
  // A task still starting has no session yet: read it once it has one.
  createEffect(
    on(remote, (id) => {
      if (id && untrack(panel).status === "live") run({ type: "sync", attempt: untrack(panel).attempt })
    }),
  )

  const document = createMemo(() => {
    const id = remote()
    if (!id) return undefined
    return {
      sessionID: id,
      messages: data.session.message.list(id),
      status: data.session.status(id) === "running" ? ({ type: "busy" } as const) : ({ type: "idle" } as const),
      diffs: [],
    }
  })
  const sessions = createMemo(() => data.session.list())
  const statuses = createMemo(() =>
    Object.fromEntries(
      sessions().map((session) => [
        session.id,
        data.session.status(session.id) === "running" ? ({ type: "busy" } as const) : ({ type: "idle" } as const),
      ]),
    ),
  )
  // The task's subagents ask too: whatever waits, oldest first.
  const permission = createMemo(
    () => data.session.permission.sessions().flatMap((id) => data.session.permission.list(id) ?? [])[0],
  )
  const question = createMemo(() => data.session.form.sessions().flatMap((id) => data.session.form.list(id) ?? [])[0])
  const [responding, setResponding] = createSignal(false)
  const decide = (decision: "once" | "always" | "reject") => {
    const request = permission()
    if (!request || responding()) return
    setResponding(true)
    void hubApi
      .replyTaskPermission(props.task, request.id, decision, request.sessionID)
      .then(
        () => data.session.permission.sync(request.sessionID),
        (error: unknown) =>
          showToast({ variant: "error", title: copy.task.replyFailed, description: errorText(error) }),
      )
      .finally(() => setResponding(false))
  }

  const stop = () =>
    void hubApi
      .stopTask(props.task)
      .catch((error: unknown) =>
        showToast({ variant: "error", title: copy.task.stopFailed, description: errorText(error) }),
      )
  const background = () => void hubApi.backgroundTask(props.task).catch(chat.fail)

  const usage = createMemo(() => {
    const current = task()
    if (!current) return undefined
    const total =
      current.tokens.input +
      current.tokens.output +
      current.tokens.reasoning +
      current.tokens.cache.read +
      current.tokens.cache.write
    if (total === 0 && current.cost === 0) return undefined
    return copy.task.usage(
      new Intl.NumberFormat(language.locale(), { notation: "compact", maximumFractionDigits: 1 }).format(total),
      new Intl.NumberFormat(language.locale(), { style: "currency", currency: "USD" }).format(current.cost),
    )
  })
  const machineURL = () => chat.machines().find((machine) => machine.id === task()?.machine)?.url

  // Follows the newest messages until the user scrolls up, as the chat does.
  const scroll = { element: undefined as HTMLDivElement | undefined, stick: true }
  const resize = new ResizeObserver(() => {
    if (scroll.element && scroll.stick) scroll.element.scrollTop = scroll.element.scrollHeight
  })
  onCleanup(() => resize.disconnect())

  return (
    <aside class="hub-chat-panel hub-task-panel" aria-label={task()?.title ?? copy.task.label}>
      <header class="hub-task-header">
        <div class="hub-task-heading">
          <span class="hub-task-indicator" aria-hidden="true">
            <Show when={view().working} fallback={<Show when={view().connecting}>{<Loader class="size-4" />}</Show>}>
              <Spinner class="size-4" />
            </Show>
          </span>
          <h2 dir="auto" title={task()?.title}>
            {task()?.title ?? copy.task.label}
          </h2>
          <IconButton
            icon={<Icon name="close" />}
            variant="ghost"
            aria-label={copy.task.close}
            onClick={() => chat.closeTask()}
          />
        </div>
        <Show when={task()}>
          {(current) => (
            <div class="hub-task-meta">
              <span class="hub-task-status" data-status={current().status}>
                {copy.task.status[current().status]}
              </span>
              <span class="hub-task-place" title={`${current().machineName}: ${current().directory}`}>
                <span class="hub-status" data-online={current().machineOnline ? "" : undefined} aria-hidden="true" />
                <span>{current().machineName}</span>
                <Icon name="folder" size="small" />
                <span>{projectName(current().directory)}</span>
              </span>
              <Show when={usage()}>
                <span class="hub-task-usage">{usage()}</span>
              </Show>
              <span class="hub-task-actions">
                <Show when={view().working}>
                  <Tooltip value={copy.task.backgroundHint} placement="bottom">
                    <Button variant="ghost" size="small" onClick={background}>
                      {copy.task.background}
                    </Button>
                  </Tooltip>
                </Show>
                <Show when={machineURL()}>
                  {(url) => (
                    <Tooltip value={copy.task.open} placement="bottom">
                      <IconButton
                        icon={<Icon name="square-arrow-top-right" size="small" />}
                        variant="ghost"
                        size="small"
                        aria-label={copy.task.open}
                        onClick={() => window.open(url(), "_blank", "noopener")}
                      />
                    </Tooltip>
                  )}
                </Show>
                <Show when={view().canStop}>
                  <Button variant="ghost" size="small" onClick={stop}>
                    {copy.task.stop}
                  </Button>
                </Show>
              </span>
            </div>
          )}
        </Show>
      </header>

      <Show when={view().notice}>
        {(notice) => (
          <p class="hub-task-notice" role="status" data-notice={notice()}>
            {noticeText[notice()](task())}
          </p>
        )}
      </Show>

      <div
        class="hub-task-scroll"
        data-scrollable
        ref={(element) => (scroll.element = element)}
        onScroll={(event) => {
          const element = event.currentTarget
          scroll.stick = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_DISTANCE
        }}
      >
        <Show
          when={document()}
          fallback={
            <div class="hub-task-empty">
              <Show when={view().connecting} fallback={copy.task.empty}>
                <Loader class="size-4" />
                <span>{copy.task.connecting}</span>
              </Show>
            </div>
          }
        >
          {(doc) => (
            <div
              class="hub-task-timeline"
              ref={(element) => {
                resize.observe(element)
                onCleanup(() => resize.unobserve(element))
              }}
            >
              <DataProvider
                directory={task()?.directory ?? ""}
                sessionID={doc().sessionID}
                agents={false}
                data={{
                  session: sessions(),
                  session_status: statuses(),
                  session_diff: {},
                  provider: providerCatalog(chat.models()),
                }}
              >
                <SessionTimeline document={doc()} />
              </DataProvider>
            </div>
          )}
        </Show>
      </div>

      <div class="hub-task-dock">
        <Show when={permission()}>
          {(request) => <SessionPermissionDock request={request()} responding={responding()} onDecide={decide} />}
        </Show>
        <Show when={permission() ? undefined : question()}>
          {(request) => <TaskQuestionDock task={props.task} request={request()} />}
        </Show>
        <TaskComposer
          task={task()}
          disabled={!view().canSend || !remote()}
          working={view().working}
          delivery={settings.general.followUpBehavior()}
        />
      </div>
    </aside>
  )
}

/** Writes to the task's agent: Enter sends with the chosen follow-up behavior, Mod+Enter steers, Alt+Enter queues. */
function TaskComposer(props: {
  task: HubTask | undefined
  disabled: boolean
  working: boolean
  delivery: "steer" | "queue"
}) {
  const [draft, setDraft] = createStore({ text: "", sending: false })

  const send = (delivery: "steer" | "queue") => {
    const task = props.task
    const text = draft.text.trim()
    if (!task || !text || draft.sending || props.disabled) return
    setDraft("sending", true)
    void hubApi
      .promptTask(task.id, text, delivery)
      .then(
        () => setDraft("text", ""),
        (error: unknown) => showToast({ variant: "error", title: copy.task.sendFailed, description: errorText(error) }),
      )
      .finally(() => setDraft("sending", false))
  }

  return (
    <form
      class="hub-task-composer"
      onSubmit={(event) => {
        event.preventDefault()
        send(props.delivery)
      }}
    >
      <Textarea
        rows={2}
        surface="layer-1"
        value={draft.text}
        placeholder={copy.task.placeholder}
        title={copy.task.hint}
        aria-label={copy.task.placeholder}
        disabled={props.disabled}
        onInput={(event) => setDraft("text", event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return
          event.preventDefault()
          const mod = IS_MAC ? event.metaKey : event.ctrlKey
          send(mod ? "steer" : event.altKey ? "queue" : props.working ? props.delivery : "queue")
        }}
      />
      <IconButton
        type="submit"
        icon={
          <Show when={draft.sending} fallback={<Icon name="arrow-up" />}>
            <Loader class="size-4" />
          </Show>
        }
        variant="submit"
        aria-label={copy.task.send}
        disabled={props.disabled || draft.sending || !draft.text.trim()}
      />
    </form>
  )
}
