import { OpenCode, type ModelInfo, type OpenCodeEvent } from "@opencode/client/promise"
import { createClientConnection, createData } from "@opencode/client/solid"
import { DataProvider } from "@opencode/session-ui/context/data"
import { File } from "@opencode/session-ui/file"
import { SessionTimeline } from "@opencode/session-ui/timeline"
import { Button } from "@opencode/ui/button"
import { FileComponentProvider } from "@opencode/ui/context/file"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Avatar } from "@opencode/ui/avatar"
import { Logo, Mark } from "@opencode/ui/logo"
import { Spinner } from "@opencode/ui/spinner"
import { showToast } from "@opencode/ui/toast"
import { SessionID } from "@opencode/schema/session-id"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { ComposerPersistedState } from "@/composer/types"
import { errorText, hubApi, HubError, type HubChatTarget, type HubSession } from "./api"
import { projectName } from "./chat-machine"
import { HubComposer, type HubSubmit } from "./composer"
import { copy } from "./copy"
import { modelKey, readHiddenModels } from "./models"

type EventMap = { [Type in OpenCodeEvent["type"]]: Extract<OpenCodeEvent, { type: Type }> }

const MODEL_KEY = "hub.chat.model"
const SIDEBAR_KEY = "hub.chat.sidebar"
const STICK_DISTANCE = 80
const MACHINES_REFRESH = 15_000
const MODELS_RETRY = 1500
const RUN_POLL = 2000

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
  const emitter = createGlobalEmitter<EventMap>()
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
  const [search, setSearch] = createSignal("")
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
  const matching = createMemo(() => {
    const term = search().trim().toLowerCase()
    return term
      ? sessions().filter((session) => (session.title || copy.chat.untitled).toLowerCase().includes(term))
      : sessions()
  })
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
  // A command or shell line running on the attached machine, polled until the hub reports it done.
  const [running, setRunning] = createSignal(false)
  createEffect(
    on(active, (id) => {
      setRunning(false)
      if (!id) return setTarget(undefined)
      void hubApi.chatTarget(id).then((response) => {
        if (active() !== id) return
        setTarget(response.target ?? undefined)
        setRunning(response.running ?? false)
      }, fail)
    }),
  )
  createEffect(() => {
    const id = active()
    if (!id || !running()) return
    const timer = setInterval(() => {
      void hubApi.chatTarget(id).then((response) => {
        if (active() !== id || response.running) return
        setRunning(false)
        if (response.error) showToast({ variant: "error", title: copy.chat.runFailed, description: response.error })
      }, fail)
    }, RUN_POLL)
    onCleanup(() => clearInterval(timer))
  })

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

  /** Sends a prompt to the hub's model, or runs a command or shell line on the machine; false keeps the draft. */
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
    const sent =
      request.type === "prompt"
        ? data.session.prompt({
            sessionID: id,
            text: request.text,
            files: request.files.length > 0 ? request.files : undefined,
          })
        : request.type === "command"
          ? hubApi.runCommand(id, request.name, request.arguments)
          : hubApi.runShell(id, request.command)
    return sent.then(
      () => {
        if (request.type !== "prompt") setRunning(true)
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
    if (!id) return
    if (running()) void hubApi.stopRun(id).then(() => setRunning(false), fail)
    if (busy()) void api.session.interrupt({ sessionID: id }).catch(fail)
  }

  const remove = (id: string) => {
    void api.session.remove({ sessionID: id }).then(() => {
      data.session.evict(id)
      if (active() === id) open(undefined)
    }, fail)
  }

  const signOut = () => hubApi.logout().then(props.onSignedOut, fail)

  const document = createMemo(() => {
    const id = active()
    if (!id) return undefined
    return {
      sessionID: id,
      messages: data.session.message.list(id),
      status: busy() ? ({ type: "busy" } as const) : ({ type: "idle" } as const),
      diffs: [],
    }
  })

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
      <Show when={running() ? target() : undefined}>
        {(attached) => (
          <div class="hub-chat-running" role="status">
            <Spinner class="size-4" />
            <span class="hub-chat-badge-text">{copy.chat.running(attached().machineName)}</span>
            <Button variant="ghost" size="small" onClick={stop}>
              {copy.chat.stop}
            </Button>
          </div>
        )}
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
        searchFiles={searchFiles}
        machines={machines() ?? []}
        onMachinesOpen={() => void refetchMachines()}
        onAttach={attach}
        placeholder={
          target() ? copy.chat.placeholderMachine : active() ? copy.chat.placeholder : copy.chat.emptyDescription
        }
        working={busy() || running()}
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
    <div class="hub-chat" data-drawer={drawer() ? "" : undefined} data-folded={folded() ? "" : undefined}>
      <button
        type="button"
        class="hub-chat-scrim"
        aria-label={copy.close}
        tabindex="-1"
        onClick={() => setDrawer(false)}
      />
      <aside class="hub-chat-sidebar" aria-label={copy.chat.sessions}>
        <div class="hub-chat-brand">
          <Mark class="hub-topbar-mark" />
          <span class="hub-topbar-title">{copy.hub}</span>
          <IconButton
            icon={<Icon name="layout-left-full" />}
            variant="ghost"
            size="small"
            class="hub-chat-fold"
            aria-label={copy.chat.collapse}
            onClick={() => fold(true)}
          />
        </div>
        <Button variant="outline" icon="plus" class="hub-chat-new" onClick={() => open(undefined)}>
          {copy.chat.newSession}
        </Button>
        <div class="hub-chat-search">
          <Icon name="magnifying-glass" size="small" />
          <input
            type="search"
            value={search()}
            placeholder={copy.chat.search}
            aria-label={copy.chat.search}
            onInput={(event) => setSearch(event.currentTarget.value)}
          />
        </div>
        <nav class="hub-chat-sessions" data-scrollable>
          <Show
            when={matching().length > 0}
            fallback={<p class="hub-chat-none">{search().trim() ? copy.chat.noMatch : copy.chat.noSessions}</p>}
          >
            <For each={matching()}>
              {(session) => (
                <div class="hub-chat-session" data-active={session.id === active() ? "" : undefined}>
                  <a
                    href={`/s/${session.id}`}
                    aria-current={session.id === active() ? "page" : undefined}
                    onClick={(event) => {
                      event.preventDefault()
                      open(session.id)
                    }}
                  >
                    <span class="hub-chat-session-title">{session.title || copy.chat.untitled}</span>
                  </a>
                  <IconButton
                    icon={<Icon name="trash" />}
                    variant="ghost"
                    size="small"
                    aria-label={copy.chat.deleteSession}
                    onClick={() => remove(session.id)}
                  />
                </div>
              )}
            </For>
          </Show>
        </nav>
        <footer class="hub-chat-footer">
          <a class="hub-chat-link" href="/settings">
            <Icon name="settings-gear" size="small" />
            <span>{copy.chat.settings}</span>
          </a>
          <Button variant="ghost" size="small" onClick={signOut}>
            {copy.signOut}
          </Button>
        </footer>
      </aside>

      <main class="hub-chat-main">
        <header class="hub-chat-header">
          <IconButton
            icon={<Icon name="menu" />}
            variant="ghost"
            class="hub-chat-menu"
            aria-label={copy.chat.sessions}
            onClick={() => setDrawer(true)}
          />
          <Show when={folded()}>
            <IconButton
              icon={<Icon name="layout-left" />}
              variant="ghost"
              class="hub-chat-unfold"
              aria-label={copy.chat.expand}
              onClick={() => fold(false)}
            />
          </Show>
          <h1>{current()?.title || (active() ? copy.chat.untitled : copy.chat.newSession)}</h1>
        </header>

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
                    data={{
                      session: sessions(),
                      session_status: { [doc().sessionID]: doc().status },
                      session_diff: {},
                      provider: providerCatalog(models() ?? []),
                    }}
                  >
                    <SessionTimeline document={doc()} />
                  </DataProvider>
                </div>
              </div>
              <div class="hub-chat-dock">{composerBlock()}</div>
            </>
          )}
        </Show>
      </main>
    </div>
  )
}

function providerCatalog(models: ModelInfo[]) {
  const all = new Map<string, { models: Record<string, { name: string }> }>()
  models.forEach((model) => {
    const provider = all.get(model.providerID) ?? { models: {} }
    provider.models[model.id] = { name: model.name }
    all.set(model.providerID, provider)
  })
  return { all, default: {}, connected: Array.from(all.keys()) }
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
