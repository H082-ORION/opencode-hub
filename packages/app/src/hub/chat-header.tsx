import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { InlineInput } from "@opencode/ui/inline-input"
import { ProgressCircle } from "@opencode/ui/progress-circle"
import { Tooltip } from "@opencode/ui/tooltip"
import { createSignal, Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { useChat } from "./chat-context"
import { createChatUsage } from "./chat-context-panel"
import { copy } from "./copy"

/**
 * The bar above the timeline: the drawer and sidebar toggles, the session's title, which a click renames, and its
 * context usage, which toggles the side panel.
 */
export function ChatHeader() {
  const chat = useChat()
  const language = useLanguage()
  const usage = createChatUsage()
  // The title being typed, while renaming.
  const [draft, setDraft] = createSignal<string>()
  const [saving, setSaving] = createSignal(false)

  const title = () => chat.current()?.title || (chat.active() ? copy.chat.untitled : copy.chat.newSession)

  const rename = () => {
    const id = chat.active()
    const next = draft()?.trim()
    if (saving()) return
    if (!id || !next || next === chat.current()?.title) return setDraft(undefined)
    setSaving(true)
    void chat.api.session
      .update({ sessionID: id, title: next })
      .then(() => setDraft(undefined), chat.fail)
      .finally(() => setSaving(false))
  }

  return (
    <header class="hub-chat-header">
      <IconButton
        icon={<Icon name="menu" />}
        variant="ghost"
        class="hub-chat-menu"
        aria-label={copy.chat.sessions}
        onClick={() => chat.setDrawer(true)}
      />
      <Show when={chat.folded()}>
        <IconButton
          icon={<Icon name="layout-left" />}
          variant="ghost"
          class="hub-chat-unfold"
          aria-label={copy.chat.expand}
          onClick={() => chat.fold(false)}
        />
      </Show>
      <Show
        when={draft() !== undefined}
        fallback={
          <h1 dir="auto">
            <Show when={chat.active()} fallback={title()}>
              <button
                type="button"
                class="hub-chat-title"
                aria-label={language.t("command.session.rename")}
                title={title()}
                onClick={() => setDraft(chat.current()?.title ?? "")}
              >
                {title()}
              </button>
            </Show>
          </h1>
        }
      >
        <InlineInput
          class="hub-chat-title-input"
          aria-label={language.t("command.session.rename")}
          dir="auto"
          value={draft() ?? ""}
          readOnly={saving()}
          aria-busy={saving() || undefined}
          ref={(element) => queueMicrotask(() => element.select())}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onBlur={rename}
          onKeyDown={(event) => {
            // Enter and Escape during IME composition belong to the composition.
            if (event.isComposing || event.keyCode === 229) return
            if (event.key === "Enter") {
              event.preventDefault()
              rename()
            }
            if (event.key === "Escape") {
              event.preventDefault()
              setDraft(undefined)
            }
          }}
        />
      </Show>
      <Show when={chat.active()}>
        <Tooltip value={usage.t("usage.toggle")} placement="bottom">
          <Button
            type="button"
            variant="ghost-muted"
            class="hub-chat-usage"
            aria-label={usage.t("usage.toggle")}
            aria-expanded={chat.panelOpen()}
            onClick={() => chat.setPanelOpen(!chat.panelOpen())}
          >
            <ProgressCircle appearance="compact" size={16} percentage={usage.context()?.usage ?? 0} />
            <span>{usage.tokens()}</span>
            <Show when={usage.showCost()}>
              <span aria-hidden="true">·</span>
              <span>{usage.cost()}</span>
            </Show>
          </Button>
        </Tooltip>
      </Show>
    </header>
  )
}
