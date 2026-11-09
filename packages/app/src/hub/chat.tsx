import { OpenCode, type ModelInfo, type OpenCodeEvent } from "@opencode/client/promise"
import { createClientConnection, createData } from "@opencode/client/solid"
import { DataProvider } from "@opencode/session-ui/context/data"
import { File } from "@opencode/session-ui/file"
import { SessionTimeline } from "@opencode/session-ui/timeline"
import { Button } from "@opencode/ui/button"
import { FileComponentProvider } from "@opencode/ui/context/file"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Loader } from "@opencode/ui/loader"
import { Mark } from "@opencode/ui/logo"
import { Select } from "@opencode/ui/select"
import { showToast } from "@opencode/ui/toast"
import { SessionID } from "@opencode/schema/session-id"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { errorText, hubApi, HubError, type HubChatTarget, type HubSession } from "./api"
import { AttachMenu, projectName } from "./chat-machine"
import { copy } from "./copy"
import { modelKey, readHiddenModels } from "./models"

type EventMap = { [Type in OpenCodeEvent["type"]]: Extract<OpenCodeEvent, { type: Type }> }

const MODEL_KEY = "hub.chat.model"
const SIDEBAR_KEY = "hub.chat.sidebar"
const STICK_DISTANCE = 80
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
  const [draft, setDraft] = createSignal("")
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

  const chooseModel = (next: ModelInfo | null) => {
    if (!next) return
    setPicked(modelKey(next))
    store(MODEL_KEY, modelKey(next))
    const id = active()
    if (id)
      void api.session.switchModel({ sessionID: id, model: { id: next.id, providerID: next.providerID } }).catch(fail)
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
  createEffect(
    on(active, (id) => {
      if (!id) return setTarget(undefined)
      void hubApi.chatTarget(id).then((response) => {
        if (active() === id) setTarget(response.target ?? undefined)
      }, fail)
    }),
  )
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

  const send = async () => {
    const text = draft().trim()
    const chosen = model()
    if (!text || !chosen) return
    setDraft("")
    const existing = active()
    const id = existing ?? SessionID.create()
    if (!existing) {
      const created = await data.session
        .create({ id, model: { id: chosen.id, providerID: chosen.providerID } })
        .request.then(
          () => true,
          (error: unknown) => {
            setDraft(text)
            fail(error)
            return false
          },
        )
      if (!created) return
      const attached = target()
      if (attached) await hubApi.setChatTarget(id, attached).catch(fail)
      open(id)
    }
    await data.session.prompt({ sessionID: id, text }).catch((error: unknown) => {
      setDraft(text)
      fail(error)
    })
  }

  const stop = () => {
    const id = active()
    if (id) void api.session.interrupt({ sessionID: id }).catch(fail)
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

        <div class="hub-chat-scroll" data-scrollable ref={scroller} onScroll={onScroll}>
          <Show
            when={document()}
            fallback={
              <div class="hub-chat-empty">
                <h2>{copy.chat.emptyTitle}</h2>
                <p>{copy.chat.emptyDescription}</p>
              </div>
            }
          >
            {(doc) => (
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
            )}
          </Show>
        </div>

        <div class="hub-chat-composer">
          <Show when={noModels()}>
            <p class="hub-chat-notice" role="status">
              {copy.chat.noProviders} <a href="/settings">{copy.chat.openSettings}</a>
            </p>
          </Show>
          <form
            class="hub-chat-form"
            onSubmit={(event) => {
              event.preventDefault()
              void send()
            }}
          >
            <div class="hub-chat-input">
              <Show when={target()}>
                {(current) => (
                  <div class="hub-chat-badges">
                    <span class="hub-chat-badge">
                      <span class="hub-status" data-online={targetOnline() ? "" : undefined} aria-hidden="true" />
                      <span class="hub-chat-badge-text">{current().machineName}</span>
                    </span>
                    <span class="hub-chat-badge" title={current().directory}>
                      <Icon name="folder" size="small" />
                      <span class="hub-chat-badge-text">{projectName(current().directory)}</span>
                      <button type="button" aria-label={copy.attach.detach} onClick={detach}>
                        <Icon name="close" size="small" />
                      </button>
                    </span>
                  </div>
                )}
              </Show>
              <textarea
                rows={1}
                value={draft()}
                placeholder={copy.chat.placeholder}
                aria-label={copy.chat.placeholder}
                onInput={(event) => setDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
                  event.preventDefault()
                  void send()
                }}
              />
            </div>
            <div class="hub-chat-form-row">
              <AttachMenu machines={machines() ?? []} onOpen={() => void refetchMachines()} onPick={attach} />
              <Show
                when={(models() ?? []).length > 0}
                fallback={
                  <Show when={models.loading}>
                    <Loader class="size-4 text-v2-icon-icon-muted" />
                  </Show>
                }
              >
                <Select
                  class="hub-chat-model"
                  appearance="small"
                  surface="invisible"
                  options={models() ?? []}
                  current={model()}
                  value={modelKey}
                  label={(item) => item.name}
                  groupBy={(item) => item.providerID}
                  onSelect={chooseModel}
                />
              </Show>
              <Show
                when={busy()}
                fallback={
                  <Button type="submit" variant="submit" disabled={!draft().trim() || !model()}>
                    {copy.chat.send}
                  </Button>
                }
              >
                <Button type="button" variant="outline" onClick={stop}>
                  {copy.chat.stop}
                </Button>
              </Show>
            </div>
          </form>
        </div>
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
