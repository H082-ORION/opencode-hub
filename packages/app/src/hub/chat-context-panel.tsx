import { lastAssistantWithUsage } from "@opencode/client/solid"
import definition from "@opencode/gui-plugins/context/index"
import { createSessionContextFormatter } from "@opencode/gui-plugins/context/format"
import en from "@opencode/gui-plugins/context/i18n/en"
import type { BuiltinCatalog } from "@opencode/plugin/gui/builtin"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { createMemo, createResource, For, Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { useChat } from "./chat-context"
import "./chat-context-panel.css"

/** The open session's context stats, as OpenCode's Context tab shows them, beside the timeline while `panelOpen` is set. */
export function ChatSidePanel() {
  const chat = useChat()
  const usage = createChatUsage()
  const language = useLanguage()
  const formatter = createMemo(() => createSessionContextFormatter(language.locale()))

  const counts = createMemo(() => {
    const all = chat.messages()
    return {
      all: all.length,
      user: all.filter((message) => message.type === "user").length,
      assistant: all.filter((message) => message.type === "assistant").length,
    }
  })

  const stats = [
    { label: "stats.session", value: () => chat.current()?.title || "—" },
    { label: "stats.messages", value: () => counts().all.toLocaleString(language.locale()) },
    { label: "stats.provider", value: () => usage.context()?.provider ?? "—" },
    { label: "stats.model", value: () => usage.context()?.model ?? "—" },
    { label: "stats.limit", value: () => formatter().number(usage.context()?.limit) },
    { label: "stats.totalTokens", value: () => formatter().number(usage.context()?.total) },
    { label: "stats.usage", value: () => formatter().percent(usage.context()?.usage) },
    { label: "stats.inputTokens", value: () => formatter().number(usage.context()?.tokens.input) },
    { label: "stats.outputTokens", value: () => formatter().number(usage.context()?.tokens.output) },
    { label: "stats.reasoningTokens", value: () => formatter().number(usage.context()?.tokens.reasoning) },
    {
      label: "stats.cacheTokens",
      value: () =>
        `${formatter().number(usage.context()?.tokens.cache.read)} / ${formatter().number(usage.context()?.tokens.cache.write)}`,
    },
    { label: "stats.userMessages", value: () => counts().user.toLocaleString(language.locale()) },
    { label: "stats.assistantMessages", value: () => counts().assistant.toLocaleString(language.locale()) },
    { label: "stats.totalCost", value: () => (usage.showCost() ? usage.cost() : "—") },
    { label: "stats.sessionCreated", value: () => formatter().time(chat.current()?.time.created) },
    { label: "stats.lastActivity", value: () => formatter().time(usage.context()?.time) },
  ] satisfies { label: keyof typeof en; value: () => string }[]

  return (
    <Show when={chat.panelOpen() && chat.active()}>
      <aside class="hub-chat-panel" aria-label={usage.t("tab.title")}>
        <header class="hub-chat-panel-header">
          <h2>{usage.t("tab.title")}</h2>
          <IconButton
            icon={<Icon name="close" />}
            variant="ghost"
            aria-label={language.t("common.close")}
            onClick={() => chat.setPanelOpen(false)}
          />
        </header>
        <dl class="hub-chat-panel-stats">
          <For each={stats}>
            {(stat) => (
              <div>
                <dt>{usage.t(stat.label)}</dt>
                <dd>{stat.value()}</dd>
              </div>
            )}
          </For>
        </dl>
      </aside>
    </Show>
  )
}

/**
 * The open session's context usage, computed as OpenCode's context indicator does: the last assistant step with
 * usage, before an undo boundary, against its model's context limit. Also translates the context plugin's copy.
 */
export function createChatUsage() {
  const chat = useChat()
  const language = useLanguage()

  const [messages] = createResource(language.locale, (locale) => loadMessages(locale), { initialValue: en })
  const t = (key: keyof typeof en) => messages.latest[key] ?? en[key]

  // Reading the models while they load would suspend the whole chat.
  const models = () => (chat.modelsLoading() ? [] : chat.models())

  const context = createMemo(() => {
    const message = lastAssistantWithUsage(chat.messages(), chat.current()?.revert?.messageID)
    if (!message) return
    const model = models().find((item) => item.providerID === message.model.providerID && item.id === message.model.id)
    const total =
      message.tokens.input +
      message.tokens.output +
      message.tokens.reasoning +
      message.tokens.cache.read +
      message.tokens.cache.write
    return {
      total,
      tokens: message.tokens,
      time: message.time.created,
      provider: message.model.providerID,
      model: model?.name ?? message.model.id,
      limit: model?.limit.context,
      usage: model?.limit.context ? Math.round((total / model.limit.context) * 100) : null,
    }
  })

  // A root session's cost includes its subagent sessions, as in OpenCode.
  const spent = () => {
    const id = chat.active()
    return id ? chat.data.session.cost(id) : 0
  }

  // A free model shows no cost; an unknown one still does, as "—" when nothing was spent.
  const showCost = createMemo(() => {
    if (spent() > 0) return true
    const ref = chat.current()?.model ?? chat.messages().findLast((item) => item.type === "assistant")?.model
    const model = ref ? models().find((item) => item.providerID === ref.providerID && item.id === ref.id) : undefined
    if (!model) return true
    return model.cost.some((cost) => cost.input > 0 || cost.output > 0 || cost.cache.read > 0 || cost.cache.write > 0)
  })

  const cost = () => new Intl.NumberFormat(language.locale(), { style: "currency", currency: "USD" }).format(spent())

  const tokens = () =>
    new Intl.NumberFormat(language.locale(), { notation: "compact", maximumFractionDigits: 0 })
      .format(context()?.total ?? 0)
      .toLocaleLowerCase(language.locale())

  return { t, context, cost, showCost, tokens }
}

/** English merged under the locale's copy of the context plugin; a locale that fails to load leaves English. */
async function loadMessages(locale: string) {
  // SAFETY: the context plugin declares its catalog with `builtinCatalog`, whose locales are inline or loaders.
  const catalog = definition.i18n as BuiltinCatalog | undefined
  const source = catalog?.[locale]
  if (!source || locale === "en") return en
  const loaded =
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a catalog entry is inline messages or a loader, see SAFETY above
    typeof source === "function"
      ? await source().then(
          (module) => module.default,
          () => ({}),
        )
      : source
  return { ...en, ...loaded }
}
