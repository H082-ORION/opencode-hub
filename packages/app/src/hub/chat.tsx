import { OpenCode, type ModelInfo } from "@opencode/client/promise"
import { createClientConnection, createData } from "@opencode/client/solid"
import { DataProvider } from "@opencode/session-ui/context/data"
import { File } from "@opencode/session-ui/file"
import { SessionTimeline } from "@opencode/session-ui/timeline"
import { FileComponentProvider } from "@opencode/ui/context/file"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Avatar } from "@opencode/ui/avatar"
import { Logo } from "@opencode/ui/logo"
import { showToast } from "@opencode/ui/toast"
import { SessionID } from "@opencode/schema/session-id"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { ComposerPersistedState } from "@/composer/types"
import { useLanguage } from "@/runtime/i18n/language"
import { useSettings } from "@/settings/model"
import { errorText, hubApi, HubError, type HubChatTarget, type HubSession } from "./api"
import { createChatCommands } from "./chat-commands"
import { ChatContext, type ChatEventMap, type ChatState } from "./chat-context"
import { ChatSidePanel } from "./chat-context-panel"
import { ChatHeader } from "./chat-header"
import { projectName } from "./chat-machine"
import { showMachineRuns, showMachineTasks, type TaskLabel } from "./chat-machine-runs"
import { ChatTaskPanel } from "./chat-task-panel"
import { ChatTaskStrip } from "./chat-task-strip"
import { createTaskFeed, isActiveTask } from "./chat-tasks"
import { useChatNotifications } from "./chat-notify"
import { ChatSidebar } from "./chat-sidebar"
import { HubComposer, type HubSubmit } from "./composer"
import { copy } from "./copy"
import { modelKey, providerCatalog, readHiddenModels } from "./models"

const MODEL_KEY = "hub.chat.model"
const SIDEBAR_KEY = "hub.chat.sidebar"
const STICK_DISTANCE = 80
/** Thumbnails under a task's card, at most; the panel shows the rest. */
const MAX_CARD_IMAGES = 4
const MACHINES_REFRESH = 15_000
const MODELS_RETRY = 1500

const sessionFromPath = () => /^\/s\/([^/]+)$/.exec(location.pathname)?.[1]

export function Chat(props: { session: HubSession; onSignedOut: () => void }) {
  return (
    <FileComponentProvider component={File}>
      <ChatScreen session={props.session} onSignedOut={props.onSignedOut} />
    </FileComponentProvider>
  )
}

function ChatScreen(props: { session: HubSession; onSignedOut: () => void }) {
  /** Reports a failed request; one refused for a missing session returns to the sign-in form instead. */
  const fail = (error: unknown) => {
    if (error instanceof HubError && error.status === 401) return props.onSignedOut()
    if (typeof error === "object" && error !== null && "status" in error && error.status === 401)
      return props.onSignedOut()
    showToast({ variant: "error", title: copy.chat.failed, description: errorText(error) })
  }

  const api = OpenCode.make({
    baseUrl: `${location.origin}/hub/api/chat`,
    // The hub refuses a write without a JSON content type, even one with no body.
    headers: { "content-type": "application/json" },
  })
  const emitter = createGlobalEmitter<ChatEventMap>()
  onCleanup(() => emitter.clear())
  const connection = createClientConnection(api, {
    flushInterval: 16,
    pageLifecycle: true,
    onEvent: (event) => emitter.emit(event.type, event),
  })
  const data = createData({
    api: () => api,
    directory: "",
    event: {
      on: emitter.on,
      listen: (handler) => emitter.listen((event) => handler(event)),
    },
    connection,
    omitToolFileData: true,
    onError: fail,
  })

  const [active, setActive] = createSignal(sessionFromPath())
  const composer = createStore<ComposerPersistedState>({
    prompt: [{ type: "text", content: "", start: 0, end: 0 }],
    cursor: 0,
    context: { items: [] },
  })
  // The effort chosen before the session exists, which it is created with.
  const [pickedVariant, setPickedVariant] = createSignal("default")
  const [drawer, setDrawer] = createSignal(false)
  const [picked, setPicked] = createSignal(readStored(MODEL_KEY))
  const [folded, setFolded] = createSignal(readStored(SIDEBAR_KEY) === "closed")
  // One panel at most beside the timeline: the session's context, or a task.
  const [panel, setPanel] = createSignal<{ type: "none" } | { type: "context" } | { type: "task"; id: string }>({
    type: "none",
  })
  const panelOpen = () => panel().type === "context"
  const setPanelOpen = (value: boolean) => setPanel(value ? { type: "context" } : { type: "none" })
  const taskPanel = () => {
    const current = panel()
    return current.type === "task" ? current.id : undefined
  }
  const tasks = createTaskFeed({ onError: fail })
  const fold = (value: boolean) => {
    setFolded(value)
    store(SIDEBAR_KEY, value ? "closed" : "open")
  }

  const open = (id: string | undefined) => {
    setDrawer(false)
    if (id === active()) return
    history.pushState(null, "", id ? `/s/${id}` : "/")
    setActive(id)
  }
  const onPopState = () => setActive(sessionFromPath())
  onMount(() => window.addEventListener("popstate", onPopState))
  onCleanup(() => window.removeEventListener("popstate", onPopState))

  const [models, { refetch: refetchModels }] = createResource(() =>
    api.model.list({}).then(
      (response) => {
        const hidden = readHiddenModels()
        return response.data.filter(
          (model) => (model.type === undefined || model.type === "chat") && !hidden.has(modelKey(model)),
        )
      },
      // The engine restarts when the user's providers change, so one failed read is expected: read them again.
      () => {
        setTimeout(() => void refetchModels(), MODELS_RETRY)
        return []
      },
    ),
  )
  // The engine lists its models once it has finished starting, and announces it.
  onCleanup(emitter.on("model.updated", () => void refetchModels()))

  const sessions = createMemo(() =>
    data.session
      .list()
      .filter((session) => !session.parentID)
      .toSorted((a, b) => b.time.updated - a.time.updated),
  )
  onMount(() => {
    void api.session
      .list({ order: "desc", limit: 100 })
      .then((response) => response.data.forEach((session) => data.session.remember(session)), fail)
  })

  createEffect(
    on(active, (id) => {
      if (!id) return
      void Promise.all([data.session.sync(id), data.session.message.sync(id), data.session.pending.sync(id)]).catch(
        fail,
      )
    }),
  )

  const current = () => {
    const id = active()
    return id ? data.session.get(id) : undefined
  }
  const model = createMemo(() => {
    const list = models() ?? []
    const session = current()?.model
    const key = session ? modelKey(session) : picked()
    return list.find((item) => modelKey(item) === key) ?? list[0]
  })
  const busy = () => {
    const id = active()
    return id !== undefined && data.session.status(id) === "running"
  }

  const variant = () => {
    const id = active()
    const chosen = id ? (current()?.model?.variant ?? "default") : pickedVariant()
    return model()?.variants.some((item) => item.id === chosen) ? chosen : "default"
  }
  const modelRef = (next: ModelInfo, effort: string) => ({
    id: next.id,
    providerID: next.providerID,
    variant: effort === "default" ? undefined : effort,
  })

  const chooseModel = (next: ModelInfo | null) => {
    if (!next) return
    setPicked(modelKey(next))
    store(MODEL_KEY, modelKey(next))
    const effort = next.variants.some((item) => item.id === variant()) ? variant() : "default"
    setPickedVariant(effort)
    const id = active()
    if (id) void api.session.switchModel({ sessionID: id, model: modelRef(next, effort) }).catch(fail)
  }

  const chooseVariant = (effort: string) => {
    setPickedVariant(effort)
    const id = active()
    const chosen = model()
    if (id && chosen) void api.session.switchModel({ sessionID: id, model: modelRef(chosen, effort) }).catch(fail)
  }

  const [target, setTarget] = createSignal<HubChatTarget>()
  const [machines, { refetch: refetchMachines }] = createResource(() => hubApi.machines().catch(() => []))
  // The badge's light follows the machine, which can disconnect at any time.
  const machinesTimer = setInterval(() => void refetchMachines(), MACHINES_REFRESH)
  onCleanup(() => clearInterval(machinesTimer))
  const targetOnline = () => {
    const current = target()
    return current !== undefined && (machines()?.find((machine) => machine.id === current.machine)?.online ?? false)
  }
  const settings = useSettings()
  const language = useLanguage()
  createEffect(
    on(active, (id) => {
      if (!id) return setTarget(undefined)
      void hubApi.chatTarget(id).then((response) => {
        if (active() !== id) return
        setTarget(response.target ?? undefined)
      }, fail)
    }),
  )

  const [machineCommands] = createResource(
    () => target(),
    (attached) =>
      hubApi.machineCommands(attached.machine, attached.directory).then(
        (data) => ({ key: attached, data }),
        () => ({ key: attached, data: [] }),
      ),
  )
  const commands = () => {
    const loaded = machineCommands.state === "ready" || machineCommands.state === "refreshing"
    const result = loaded ? machineCommands.latest : undefined
    return result && result.key === target() ? result.data : []
  }
  const searchFiles = (query: string) => {
    const attached = target()
    return attached
      ? hubApi.machineFiles(attached.machine, attached.directory, query).catch(() => [])
      : Promise.resolve([])
  }
  const attach = (next: HubChatTarget) => {
    setTarget(next)
    const id = active()
    if (id) void hubApi.setChatTarget(id, next).catch(fail)
  }
  const detach = () => {
    setTarget(undefined)
    const id = active()
    if (id) void hubApi.clearChatTarget(id).catch(fail)
  }

  /**
   * Sends a prompt to the hub's model, or runs a command or shell line on the machine as a task followed live in its
   * panel; false keeps the draft.
   */
  const send = async (request: HubSubmit) => {
    const chosen = model()
    const existing = active()
    // A new session takes the chosen model, even when its first message runs on the machine.
    if (!chosen && (request.type === "prompt" || !existing)) return false
    const id = existing ?? SessionID.create()
    if (!existing && chosen) {
      const created = await data.session.create({ id, model: modelRef(chosen, variant()) }).request.then(
        () => true,
        (error: unknown) => {
          fail(error)
          return false
        },
      )
      if (!created) return false
      const attached = target()
      if (attached) await hubApi.setChatTarget(id, attached).catch(fail)
      open(id)
    }
    if (request.type === "prompt")
      return data.session
        .prompt({
          sessionID: id,
          text: request.text,
          files: request.files.length > 0 ? request.files : undefined,
          skills: request.skills?.length ? request.skills.map((id) => ({ id })) : undefined,
          delivery: settings.general.followUpBehavior(),
        })
        .then(
          () => true,
          (error: unknown) => {
            fail(error)
            return false
          },
        )
    return hubApi
      .startTask(
        id,
        request.type === "command"
          ? { kind: "command", command: { name: request.name, arguments: request.arguments } }
          : { kind: "shell", shell: request.command },
      )
      .then(
        (task) => {
          tasks.put(task)
          setPanel({ type: "task", id: task.id })
          return true
        },
        (error: unknown) => {
          fail(error)
          return false
        },
      )
  }

  const stop = () => {
    const id = active()
    if (id && busy()) void api.session.interrupt({ sessionID: id }).catch(fail)
  }

  const remove = (id: string) => {
    void api.session.remove({ sessionID: id }).then(() => {
      data.session.evict(id)
      if (active() === id) open(undefined)
    }, fail)
  }

  const signOut = () => hubApi.logout().then(props.onSignedOut, fail)

  const messages = () => {
    const id = active()
    return id ? data.session.message.list(id) : []
  }

  const chat: ChatState = {
    user: props.session.user,
    api,
    data,
    emitter,
    composer,
    fail,
    signOut,
    active,
    current,
    messages,
    sessions,
    open,
    remove,
    busy,
    models: () => models() ?? [],
    modelsLoading: () => models.loading,
    model,
    chooseModel,
    variant,
    target,
    folded,
    fold,
    drawer,
    setDrawer,
    panelOpen,
    setPanelOpen,
    tasks,
    task: taskPanel,
    openTask: (id) => setPanel({ type: "task", id }),
    closeTask: () => setPanel({ type: "none" }),
    machines: () => machines() ?? [],
  }
  useChatNotifications(chat)
  const chatCommands = createChatCommands(chat)

  /**
   * A task card's lines: the machine and the model (with the template's role), the task's title with what it cost so
   * far, and the images it produced, served by the hub.
   */
  const taskLabel = (id: string | undefined, fallback: TaskLabel): TaskLabel => {
    const task = id ? tasks.get(id) : undefined
    if (!task) return fallback
    const tokens =
      task.tokens.input + task.tokens.output + task.tokens.reasoning + task.tokens.cache.read + task.tokens.cache.write
    const usage =
      tokens > 0 || task.cost > 0
        ? copy.task.usage(
            new Intl.NumberFormat(language.locale(), { notation: "compact", maximumFractionDigits: 1 }).format(tokens),
            new Intl.NumberFormat(language.locale(), { style: "currency", currency: "USD" }).format(task.cost),
          )
        : undefined
    const role = [task.template, task.model ? modelName(task.model) : undefined].filter(Boolean).join(" · ")
    return {
      agent: role ? `${task.machineName} · ${role}` : task.machineName,
      description: usage ? `${task.title} · ${usage}` : task.title,
      images: Array.from({ length: Math.min(task.images, MAX_CARD_IMAGES) }, (_, index) => ({
        uri: `/hub/api/chat-tasks/${encodeURIComponent(task.id)}/image/${index}`,
      })),
    }
  }
  /** The model's name as the hub lists it, for a `provider/model#variant` reference; the reference otherwise. */
  const modelName = (reference: string) => {
    const [ref, variant] = reference.split("#")
    const found = (models() ?? []).find((model) => modelKey(model) === ref)
    const name = found?.name ?? ref?.split("/").slice(1).join("/") ?? reference
    return variant ? `${name} (${variant})` : name
  }
  // The hub's cards stand for tasks the user follows: they stay their own rows, never folded into a tool group.
  const timelineDetail = createMemo(() => ({
    ...settings.general.timelineDetail(),
    subagents: { placement: "separate" as const },
  }))
  const document = createMemo(() => {
    const id = active()
    if (!id) return undefined
    // An undone turn stays in the history until the next prompt commits the revert; like OpenCode, it is hidden.
    const boundary = current()?.revert?.messageID
    return {
      sessionID: id,
      messages: showMachineTasks(
        showMachineRuns(boundary ? messages().filter((message) => message.id < boundary) : messages()),
        taskLabel,
      ),
      status: busy() ? ({ type: "busy" } as const) : ({ type: "idle" } as const),
      diffs: [],
    }
  })

  // The open session's tasks, which its cards and notices show as working while they run.
  const sessionTasks = createMemo(() => {
    const id = active()
    return id ? tasks.list().filter((task) => task.session === id) : []
  })
  const runningTasks = createMemo(() => sessionTasks().filter(isActiveTask))
  const openSession = (id: string) => (id.startsWith("tsk_") ? setPanel({ type: "task", id }) : open(id))

  let scroller: HTMLDivElement | undefined
  const stick = { value: true }
  const onScroll = () => {
    if (!scroller) return
    stick.value = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_DISTANCE
  }
  createEffect(
    on(active, () => {
      stick.value = true
    }),
  )
  const resize = new ResizeObserver(() => {
    if (scroller && stick.value) scroller.scrollTop = scroller.scrollHeight
  })
  onCleanup(() => resize.disconnect())

  const noModels = () => models.state === "ready" && (models() ?? []).length === 0

  // The new-session screen shows the composer under the logo, an open session docks it under the timeline.
  const composerBlock = () => (
    <div class="hub-chat-composer">
      <Show when={noModels()}>
        <p class="hub-chat-notice" role="status">
          {copy.chat.noProviders} <a href="/settings">{copy.chat.openSettings}</a>
        </p>
      </Show>
      <Show when={runningTasks().length > 0}>
        <ChatTaskStrip tasks={runningTasks()} modelName={modelName} />
      </Show>
      <HubComposer
        store={composer}
        models={models() ?? []}
        modelsLoading={models.loading}
        model={model()}
        onModel={chooseModel}
        variant={variant()}
        onVariant={chooseVariant}
        target={target()}
        commands={commands()}
        clientCommands={chatCommands.clientCommands()}
        skills={chatCommands.skills()}
        searchFiles={searchFiles}
        machines={machines() ?? []}
        onMachinesOpen={() => void refetchMachines()}
        onAttach={attach}
        placeholder={
          target() ? copy.chat.placeholderMachine : active() ? copy.chat.placeholder : copy.chat.emptyDescription
        }
        working={busy()}
        onSubmit={send}
        onStop={stop}
        onError={fail}
      />
      <div class="hub-chat-under">
        <span class="hub-chat-user">
          <Avatar fallback={props.session.user.login} size="small" />
          <span class="hub-chat-badge-text">{props.session.user.login}</span>
        </span>
        <Show when={target()}>
          {(attached) => (
            <span class="hub-chat-place" title={`${attached().machineName}: ${attached().directory}`}>
              <span class="hub-status" data-online={targetOnline() ? "" : undefined} aria-hidden="true" />
              <span class="hub-chat-badge-text">{attached().machineName}</span>
              <Icon name="folder" size="small" />
              <span class="hub-chat-badge-text">{projectName(attached().directory)}</span>
              <IconButton
                icon={<Icon name="close" size="small" />}
                variant="ghost"
                size="small"
                aria-label={copy.attach.detach}
                onClick={detach}
              />
            </span>
          )}
        </Show>
      </div>
    </div>
  )

  return (
    <ChatContext.Provider value={chat}>
      <div
        class="hub-chat"
        data-drawer={drawer() ? "" : undefined}
        data-folded={folded() ? "" : undefined}
        data-panel={panel().type === "none" ? undefined : ""}
      >
        <button
          type="button"
          class="hub-chat-scrim"
          aria-label={copy.close}
          tabindex="-1"
          onClick={() => setDrawer(false)}
        />
        <ChatSidebar />

        <main class="hub-chat-main">
          <ChatHeader />

          <Show when={!props.session.unlocked}>
            <p class="hub-chat-notice" role="status">
              {copy.chat.locked}
            </p>
          </Show>

          <Show
            when={document()}
            fallback={
              <div class="hub-chat-start">
                <div class="hub-chat-start-content">
                  <h2 class="sr-only">{copy.chat.emptyTitle}</h2>
                  <div class="hub-chat-logo" aria-hidden="true">
                    <Logo />
                  </div>
                  {composerBlock()}
                </div>
              </div>
            }
          >
            {(doc) => (
              <>
                <div class="hub-chat-scroll" data-scrollable ref={scroller} onScroll={onScroll}>
                  <div
                    class="hub-chat-timeline"
                    ref={(element) => {
                      resize.observe(element)
                      onCleanup(() => resize.unobserve(element))
                    }}
                  >
                    <DataProvider
                      directory=""
                      sessionID={doc().sessionID}
                      agents={false}
                      onNavigateToSession={openSession}
                      data={{
                        session: sessions(),
                        session_status: {
                          ...Object.fromEntries(
                            sessionTasks().map((task) => [
                              task.id,
                              isActiveTask(task) ? ({ type: "busy" } as const) : ({ type: "idle" } as const),
                            ]),
                          ),
                          [doc().sessionID]: doc().status,
                        },
                        session_diff: {},
                        provider: providerCatalog(models() ?? []),
                      }}
                    >
                      <SessionTimeline document={doc()} timelineDetail={timelineDetail()} />
                    </DataProvider>
                  </div>
                </div>
                <div class="hub-chat-dock">{composerBlock()}</div>
              </>
            )}
          </Show>
        </main>
        <ChatSidePanel />
        <Show when={taskPanel()} keyed>
          {(id) => <ChatTaskPanel task={id} />}
        </Show>
      </div>
    </ChatContext.Provider>
  )
}

function readStored(key: string) {
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Only a convenience: without storage, the choice lasts for this page.
  }
}
