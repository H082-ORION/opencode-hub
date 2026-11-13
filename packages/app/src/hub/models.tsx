import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import type { ModelInfo } from "@opencode/client/promise"
import { Switch } from "@opencode/ui/switch"
import { TextInput } from "@opencode/ui/text-input"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { request } from "./api"
import { copy } from "./copy"
import type { Fail } from "./dashboard"

const HIDDEN_KEY = "hub.chat.models.hidden"

export const modelKey = (model: Pick<ModelInfo, "providerID" | "id">) => `${model.providerID}/${model.id}`

/** Models by provider, in the shape the session timeline names a message's model with. */
export function providerCatalog(models: readonly ModelInfo[]) {
  const all = new Map<string, { models: Record<string, { name: string }> }>()
  models.forEach((model) => {
    const provider = all.get(model.providerID) ?? { models: {} }
    provider.models[model.id] = { name: model.name }
    all.set(model.providerID, provider)
  })
  return { all, default: {}, connected: Array.from(all.keys()) }
}

/** The models left out of the chat's picker, in this browser. */
export function readHiddenModels() {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]")
    return new Set(Array.isArray(stored) ? stored.filter((item) => typeof item === "string") : [])
  } catch {
    return new Set<string>()
  }
}

function storeHiddenModels(hidden: ReadonlySet<string>) {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(Array.from(hidden)))
  } catch {
    // Only a convenience: without storage, the choice lasts for this page.
  }
}

export function HubModels(props: { fail: Fail }) {
  const [hidden, setHidden] = createSignal(readHiddenModels())
  const [query, setQuery] = createSignal("")
  const [models] = createResource(() =>
    request<{ data: ModelInfo[] }>("chat/api/model").then(
      (response) => response.data,
      (error: unknown) => {
        props.fail(copy.chat.failed, error)
        return []
      },
    ),
  )
  const shown = createMemo(() => {
    const term = query().trim().toLowerCase()
    return (models() ?? []).filter((model) => !term || `${model.name} ${model.providerID}`.toLowerCase().includes(term))
  })
  const toggle = (model: ModelInfo, visible: boolean) => {
    const next = new Set(hidden())
    if (visible) next.delete(modelKey(model))
    else next.add(modelKey(model))
    setHidden(next)
    storeHiddenModels(next)
  }

  return (
    <>
      <div class="settings-tab-header">
        <div class="flex flex-col gap-1">
          <h2 class="settings-tab-title">{copy.settings.modelsTitle}</h2>
          <span class="text-11-regular text-v2-text-text-muted">{copy.settings.modelsDescription}</span>
        </div>
      </div>
      <div class="settings-tab-body">
        <div class="settings-section">
          <TextInput
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder={copy.settings.modelsSearch}
            aria-label={copy.settings.modelsSearch}
          />
          <Show
            when={shown().length > 0}
            fallback={<p class="text-11-regular text-v2-text-text-muted">{copy.settings.modelsEmpty}</p>}
          >
            <SettingsList>
              <For each={shown()}>
                {(model) => (
                  <SettingsRow title={model.name} description={model.providerID}>
                    <Switch
                      checked={!hidden().has(modelKey(model))}
                      aria-label={copy.settings.modelsVisible}
                      onChange={(visible) => toggle(model, visible)}
                    />
                  </SettingsRow>
                )}
              </For>
            </SettingsList>
          </Show>
        </div>
      </div>
    </>
  )
}
