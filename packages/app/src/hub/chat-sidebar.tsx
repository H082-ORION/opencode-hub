import type { SessionInfo } from "@opencode/client/promise"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { InlineInput } from "@opencode/ui/inline-input"
import { Keybind } from "@opencode/ui/keybind"
import { Mark } from "@opencode/ui/logo"
import { Menu } from "@opencode/ui/menu"
import { showToast } from "@opencode/ui/toast"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createEffect, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import {
  INITIAL_HOME_SESSION_ROW_STATE,
  selectLongPressMoved,
  selectRowEditor,
  selectRowMenu,
  selectRowSuppressClick,
  transitionHomeSessionRow,
  type HomeSessionRowEffect,
  type HomeSessionRowEvent,
  type HomeSessionRowState,
} from "@/home/sessions/row-machine"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerKey } from "@/runtime/server/persistence"
import { downloadSessionExport, fetchSessionExport, sessionExportFilename } from "@/session/commands/export"
import {
  createSessionDeleteState,
  selectSessionDeleteView,
  SESSION_DELETE_TIMEOUT_MS,
  transitionSessionDelete,
  type SessionDeleteEffect,
  type SessionDeleteEvent,
} from "@/session/delete-machine"
import { errorText } from "./api"
import { useChat } from "./chat-context"
import { ChatSearchDialog } from "./chat-search"
import { copy } from "./copy"
import "./chat-sidebar.css"

const IS_MAC = typeof navigator !== "undefined" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform)

// The row machine is shared with OpenCode's Home list, which tells servers apart; the hub has one chat engine.
const HUB_SERVER = ServerKey.make("hub")

const POINTER_DOWN: HomeSessionRowEvent = { type: "pointer.down" }
const TOUCH_UP: HomeSessionRowEvent = { type: "touch.up" }
const TOUCH_CANCEL: HomeSessionRowEvent = { type: "touch.cancel" }

/** The session list: new session, search, sessions with their menu, settings and sign-out. */
export function ChatSidebar() {
  const chat = useChat()
  const dialog = useDialog()
  const language = useLanguage()
  // Lives at the list root, keyed by session ID, so the menu and rename survive a row remounting when the list reorders.
  const [rowState, setRowState] = createSignal<HomeSessionRowState>(INITIAL_HOME_SESSION_ROW_STATE)
  const [exports, setExports] = createStore<Record<string, boolean>>({})
  const renames = new Map<number, { controller: AbortController; timer: ReturnType<typeof setTimeout> }>()
  let longPressTimer: ReturnType<typeof setTimeout> | undefined

  const dispatchRow = (event: HomeSessionRowEvent) =>
    untrack(() => {
      const previous = rowState()
      const next = transitionHomeSessionRow(previous, event)
      if (next.state !== previous) setRowState(next.state)
      next.effects.forEach(runRowEffect)
    })

  function runRowEffect(effect: HomeSessionRowEffect) {
    if (effect.type === "long-press.start") {
      clearTimeout(longPressTimer)
      longPressTimer = setTimeout(
        () => dispatchRow({ type: "long-press.fired", attempt: effect.attempt }),
        effect.delayMs,
      )
      return
    }
    if (effect.type === "long-press.stop") return clearTimeout(longPressTimer)
    if (effect.type === "rename.save") {
      const attempt = effect.attempt
      const controller = new AbortController()
      const timer = setTimeout(() => dispatchRow({ type: "rename.timed-out", attempt }), effect.timeoutMs)
      renames.set(attempt, { controller, timer })
      // A cancelled save resolves false for an attempt the machine already left.
      void rename(effect.session, effect.title, controller.signal).then((saved) => {
        clearTimeout(timer)
        renames.delete(attempt)
        dispatchRow({ type: saved ? "rename.succeeded" : "rename.failed", attempt })
      })
      return
    }
    if (effect.type === "rename.abort") {
      const pending = renames.get(effect.attempt)
      clearTimeout(pending?.timer)
      pending?.controller.abort()
      renames.delete(effect.attempt)
      return
    }
    if (effect.type === "toast.rename-timeout")
      return showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: language.t("home.sessions.load.timeout"),
      })

    // Focus targets are looked up by session ID: rows remount, so instance refs can point at detached nodes.
    const row = `.hub-chat-session[data-session-id="${effect.sessionID}"]`
    const active = document.activeElement
    if (effect.ifOwned && active !== document.body && !document.querySelector(row)?.contains(active)) return
    requestAnimationFrame(() => {
      if (effect.type === "focus.row") return document.querySelector<HTMLElement>(`${row} a`)?.focus()
      const input = document.querySelector<HTMLInputElement>(`${row} [data-slot="hub-chat-rename"]`)
      input?.focus()
      if (effect.select) input?.select()
    })
  }

  // A save the caller cancelled still updates the list if the server took it.
  const rename = (session: SessionInfo, title: string, signal: AbortSignal) => {
    const next = title.trim()
    if (!next || next === session.title) return Promise.resolve(true)
    return chat.api.session.update({ sessionID: session.id, title: next }, { signal }).then(
      () => {
        chat.data.session.remember({ ...(chat.data.session.get(session.id) ?? session), title: next })
        return true
      },
      (cause: unknown) => {
        if (signal.aborted) return false
        showToast({ variant: "error", title: language.t("common.requestFailed"), description: errorText(cause) })
        return false
      },
    )
  }

  const exportSession = (session: SessionInfo) => {
    if (exports[session.id]) return
    setExports(session.id, true)
    void fetchSessionExport({ sessionID: session.id, api: chat.api })
      .then((data) => {
        const filename = sessionExportFilename(data.info)
        downloadSessionExport(filename, data)
        showToast({
          variant: "success",
          title: language.t("toast.session.export.success.title"),
          description: language.t("toast.session.export.success.description", { filename }),
        })
      })
      .catch((cause: unknown) =>
        showToast({
          variant: "error",
          title: language.t("toast.session.export.failed.title"),
          description: errorText(cause) || language.t("toast.session.export.failed.description"),
        }),
      )
      .finally(() => setExports(session.id, false))
  }

  createEffect(() => {
    const sessionIDs = new Set(chat.sessions().map((session) => session.id))
    dispatchRow({ type: "sessions.synced", sessionIDs })
  })
  onCleanup(() => dispatchRow({ type: "disposed" }))

  const openSearch = () => void dialog.show(() => <ChatSearchDialog />)
  onMount(() =>
    makeEventListener(document, "keydown", (event) => {
      if (!(IS_MAC ? event.metaKey : event.ctrlKey) || event.shiftKey || event.altKey) return
      if (event.key.toLowerCase() !== "k" || dialog.active) return
      event.preventDefault()
      openSearch()
    }),
  )

  return (
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
          onClick={() => chat.fold(true)}
        />
      </div>
      <Button variant="outline" icon="plus" class="hub-chat-new" onClick={() => chat.open(undefined)}>
        {copy.chat.newSession}
      </Button>
      <button
        type="button"
        class="hub-chat-search hub-chat-search-trigger"
        aria-haspopup="dialog"
        aria-label={copy.chat.search}
        onClick={openSearch}
      >
        <Icon name="magnifying-glass" size="small" />
        <span>{language.t("common.search.placeholder")}</span>
        <Keybind keys={[IS_MAC ? "⌘" : "Ctrl", "K"]} variant="ghost" />
      </button>
      <nav class="hub-chat-sessions" data-scrollable>
        <Show when={chat.sessions().length > 0} fallback={<p class="hub-chat-none">{copy.chat.noSessions}</p>}>
          <For each={chat.sessions()}>
            {(session) => (
              <SessionRow
                session={session}
                rowState={rowState()}
                exporting={!!exports[session.id]}
                onRowEvent={dispatchRow}
                onExport={() => exportSession(session)}
                onDelete={() => void dialog.show(() => <DeleteDialog session={session} />)}
              />
            )}
          </For>
        </Show>
      </nav>
      <footer class="hub-chat-footer">
        <a class="hub-chat-link" href="/settings">
          <Icon name="settings-gear" size="small" />
          <span>{copy.chat.settings}</span>
        </a>
        <Button variant="ghost" size="small" onClick={chat.signOut}>
          {copy.signOut}
        </Button>
      </footer>
    </aside>
  )
}

/** One session: a link that opens it, its menu (right-click, Shift+F10, long press or the options button) and the inline rename. */
function SessionRow(props: {
  session: SessionInfo
  rowState: HomeSessionRowState
  exporting: boolean
  onRowEvent: (event: HomeSessionRowEvent) => void
  onExport: () => void
  onDelete: () => void
}) {
  const chat = useChat()
  const language = useLanguage()
  const id = () => props.session.id
  const title = () => props.session.title || copy.chat.untitled
  const menu = () => selectRowMenu(props.rowState, id())
  const editor = () => selectRowEditor(props.rowState, id())
  let container: HTMLDivElement | undefined

  const openMenu = (clientX: number, clientY: number) => {
    const bounds = container!.getBoundingClientRect()
    props.onRowEvent({ type: "menu.open", sessionID: id(), x: clientX - bounds.left, y: clientY - bounds.top })
  }

  return (
    <div
      ref={container}
      class="hub-chat-session"
      data-session-id={id()}
      data-active={id() === chat.active() ? "" : undefined}
      data-menu={menu() ? "" : undefined}
      onContextMenu={(event) => {
        // While renaming, keep the native menu so paste and spelling work.
        if (editor()) return
        event.preventDefault()
        openMenu(event.clientX, event.clientY)
      }}
    >
      <Show
        when={!editor()}
        fallback={
          <InlineInput
            data-slot="hub-chat-rename"
            class="hub-chat-rename"
            aria-label={language.t("common.rename")}
            dir="auto"
            value={editor()?.draft ?? ""}
            // Read-only rather than disabled keeps focus here while saving, so Escape can cancel the save.
            readOnly={editor()?.status === "renaming"}
            aria-busy={editor()?.status === "renaming" || undefined}
            onInput={(event) =>
              props.onRowEvent({ type: "editor.input", sessionID: id(), draft: event.currentTarget.value })
            }
            onKeyDown={(event) => {
              event.stopPropagation()
              // Enter and Escape during IME composition commit or cancel the composition, not the rename.
              if (event.isComposing || event.keyCode === 229) return
              if (event.key === "Enter") {
                event.preventDefault()
                props.onRowEvent({
                  type: "editor.submit",
                  sessionID: id(),
                  server: HUB_SERVER,
                  session: props.session,
                  title: title(),
                })
                return
              }
              if (event.key !== "Escape") return
              event.preventDefault()
              props.onRowEvent({ type: "editor.cancel", sessionID: id(), reason: "escape" })
            }}
            onBlur={() => props.onRowEvent({ type: "editor.cancel", sessionID: id(), reason: "blur" })}
          />
        }
      >
        <a
          href={`/s/${id()}`}
          aria-current={id() === chat.active() ? "page" : undefined}
          aria-haspopup="menu"
          aria-expanded={!!menu()}
          onPointerDown={(event) => {
            if (event.pointerType !== "touch") return props.onRowEvent(POINTER_DOWN)
            const bounds = container!.getBoundingClientRect()
            props.onRowEvent({
              type: "touch.down",
              sessionID: id(),
              x: event.clientX,
              y: event.clientY,
              menuX: event.clientX - bounds.left,
              menuY: event.clientY - bounds.top,
            })
          }}
          onPointerMove={(event) => {
            if (!selectLongPressMoved(props.rowState, event.clientX, event.clientY)) return
            props.onRowEvent({ type: "touch.move", x: event.clientX, y: event.clientY })
          }}
          onPointerUp={() => props.onRowEvent(TOUCH_UP)}
          onPointerCancel={() => props.onRowEvent(TOUCH_CANCEL)}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && (event.key !== "F10" || !event.shiftKey)) return
            event.preventDefault()
            const bounds = event.currentTarget.getBoundingClientRect()
            openMenu(bounds.left + 12, bounds.bottom)
          }}
          onClick={(event) => {
            event.preventDefault()
            // The long press's release click arrives however late; keyboard activation is never that click.
            const suppress = selectRowSuppressClick(props.rowState, id(), event.detail)
            props.onRowEvent({ type: "row.clicked", sessionID: id() })
            if (!suppress) chat.open(id())
          }}
        >
          <span class="hub-chat-session-title" dir="auto">
            {title()}
          </span>
        </a>
        <IconButton
          icon={<Icon name="outline-dots" />}
          variant="ghost"
          size="small"
          class="hub-chat-session-options"
          aria-label={language.t("common.moreOptions")}
          aria-haspopup="menu"
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect()
            openMenu(bounds.left, bounds.bottom)
          }}
        />
      </Show>
      <Menu
        modal={false}
        placement="bottom-start"
        gutter={2}
        open={!!menu()}
        onOpenChange={(open) => {
          if (open) return
          props.onRowEvent({ type: "menu.closed", sessionID: id() })
        }}
      >
        {/* Disabled, so it takes no focus: Kobalte focuses the trigger on close, which would blur the rename editor
            the Rename item just opened. Closing the menu restores focus to the row instead. */}
        <Menu.Trigger
          as="span"
          aria-hidden="true"
          disabled
          class="hub-chat-session-anchor"
          style={{ left: `${menu()?.x ?? 0}px`, top: `${menu()?.y ?? 0}px` }}
        />
        <Menu.Portal>
          <Menu.Content
            onInteractOutside={() => props.onRowEvent({ type: "menu.interact-outside", sessionID: id() })}
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <Menu.Item onSelect={() => props.onRowEvent({ type: "rename.start", sessionID: id(), title: title() })}>
              {language.t("common.rename")}
            </Menu.Item>
            <Menu.Item disabled={props.exporting} onSelect={props.onExport}>
              {language.t("common.export")}…
            </Menu.Item>
            <Menu.Separator />
            <Menu.Item onSelect={props.onDelete}>{language.t("common.delete")}…</Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
    </div>
  )
}

/** Confirms a delete and waits for the chat engine, as OpenCode's own session list does. */
function DeleteDialog(props: { session: SessionInfo }) {
  const chat = useChat()
  const dialog = useDialog()
  const language = useLanguage()
  const [deleteState, setDeleteState] = createSignal(createSessionDeleteState(props.session.id))
  let timer: ReturnType<typeof setTimeout> | undefined

  const dispatch = (event: SessionDeleteEvent) => {
    const next = transitionSessionDelete(untrack(deleteState), event)
    if (next.state !== untrack(deleteState)) setDeleteState(next.state)
    next.effects.forEach(run)
  }

  function run(effect: SessionDeleteEffect) {
    if (effect.type === "delete.run")
      return void chat.api.session.remove({ sessionID: effect.sessionID }).then(
        () => dispatch({ type: "delete.succeeded", attempt: effect.attempt, target: effect.target }),
        (cause: unknown) => dispatch({ type: "delete.failed", attempt: effect.attempt, cause }),
      )
    if (effect.type === "dialog.close") return dialog.close()
    if (effect.type === "session.removed") {
      chat.data.session.evict(effect.sessionID)
      if (chat.active() === effect.sessionID) chat.open(undefined)
      return
    }
    if (effect.type === "toast.delete-failed")
      return showToast({
        variant: "error",
        title: language.t("session.delete.failed.title"),
        description: effect.cause === undefined ? undefined : errorText(effect.cause),
      })
    clearTimeout(timer)
    timer = undefined
    if (effect.type === "timer.cancel") return
    timer = setTimeout(() => dispatch({ type: "delete.timed-out", attempt: effect.attempt }), SESSION_DELETE_TIMEOUT_MS)
  }

  onCleanup(() => dispatch({ type: "disposed" }))
  const busy = () => selectSessionDeleteView(deleteState()).busy

  return (
    <Dialog fit>
      <DialogHeader hideClose>
        <DialogTitleGroup
          title={language.t("session.delete.title")}
          description={language.t("session.delete.confirm", { name: props.session.title || copy.chat.untitled })}
        />
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" autofocus disabled={busy()} onClick={() => dispatch({ type: "cancel.requested" })}>
          {language.t("common.cancel")}
        </Button>
        <Button
          variant="danger"
          disabled={busy()}
          onClick={() => dispatch({ type: "confirm.requested", target: { removedIDs: [props.session.id] } })}
        >
          {language.t("session.delete.button")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
