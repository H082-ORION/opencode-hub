import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody } from "@opencode/ui/dialog"
import { SearchHighlight, SearchList } from "@opencode/ui/search-list"
import { createResource, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { getRelativeTime } from "@/shell/time"
import { useChat } from "./chat-context"
import { copy } from "./copy"
import "./chat-sidebar.css"

/** How long typing pauses before the server is asked, so each keystroke does not send a search. */
const SEARCH_DELAY_MS = 150

/** Searches the user's sessions on the chat engine; an empty query lists the most recent ones. */
export function ChatSearchDialog() {
  const chat = useChat()
  const dialog = useDialog()
  const language = useLanguage()
  const [state, setState] = createStore({ query: "", term: "" })
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))

  // The term travels with its results, so a slower answer for an earlier term never shows under a newer one.
  const [found] = createResource(
    () => state.term || undefined,
    (term) =>
      chat.api.session
        .list({ search: term, order: "desc", limit: 50 })
        .then((response) => ({ term, sessions: response.data.filter((session) => !session.parentID) })),
  )
  const current = () =>
    (found.state === "ready" || found.state === "refreshing") && found.latest.term === state.term
      ? found.latest.sessions
      : undefined
  const items = () => (state.term ? (current() ?? []) : chat.sessions())
  const empty = () => {
    if (state.term && found.state === "errored") return language.t("common.requestFailed")
    if (state.term && !current()) return language.t("common.loading")
    return copy.chat.noMatch
  }

  return (
    <Dialog class="hub-chat-search-dialog" size="large" fit>
      <DialogBody class="hub-chat-search-body">
        <SearchList
          query={state.query}
          onQuery={(query) => {
            setState("query", query)
            clearTimeout(timer)
            timer = setTimeout(() => setState("term", query.trim()), SEARCH_DELAY_MS)
          }}
          placeholder={copy.chat.search}
          items={items()}
          key={(session) => session.id}
          empty={empty()}
          onSelect={(session) => {
            dialog.close()
            chat.open(session.id)
          }}
          onClose={() => dialog.close()}
        >
          {(session, row) => (
            <button
              type="button"
              class="hub-chat-search-row"
              aria-current={session().id === chat.active() ? "page" : undefined}
              {...row}
            >
              <span class="hub-chat-search-title" dir="auto">
                <SearchHighlight text={session().title || copy.chat.untitled} />
              </span>
              <span class="hub-chat-search-time">
                {getRelativeTime(new Date(session().time.updated).toISOString(), language.t, language.intl())}
              </span>
            </button>
          )}
        </SearchList>
      </DialogBody>
    </Dialog>
  )
}
