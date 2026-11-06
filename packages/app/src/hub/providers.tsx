import { Badge } from "@opencode/ui/badge"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Loader } from "@opencode/ui/loader"
import { ProviderIcon } from "@opencode/ui/provider-icon"
import { SearchHighlight, SearchList } from "@opencode/ui/search-list"
import { TextInput } from "@opencode/ui/text-input"
import { showToast } from "@opencode/ui/toast"
import fuzzysort from "fuzzysort"
import { createMemo, createSignal, For, Match, onMount, Show, Switch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { errorText, hubApi, HubError, type HubPreset, type HubProvider } from "./api"
import { ChatGPTDialog } from "./chatgpt"
import { copy } from "./copy"
import type { Fail } from "./dashboard"

type ListState = { status: "loading" | "ready" | "failed"; list: HubProvider[]; error?: string }

export function Providers(props: { fail: Fail }) {
  const dialog = useDialog()
  const [state, setState] = createStore<ListState>({ status: "loading", list: [] })

  const load = () =>
    hubApi.providers().then(
      (list) => {
        setState({ status: "ready", error: undefined })
        setState("list", reconcile(list, { key: "id" }))
      },
      (error: unknown) => {
        if (error instanceof HubError && error.status === 401) return props.fail(copy.providers.loadFailed, error)

        // A refresh that fails keeps the list already on screen.
        if (state.status === "ready") return props.fail(copy.providers.loadFailed, error)
        setState({ status: "failed", error: errorText(error) })
      },
    )

  onMount(() => void load())

  const add = () => void dialog.show(() => <AddProviderDialog onSaved={load} fail={props.fail} />)
  const chatgpt = () => void dialog.show(() => <ChatGPTDialog onConnected={load} fail={props.fail} />)

  const remove = (provider: HubProvider) =>
    void dialog.show(() => <RemoveProviderDialog provider={provider} onRemoved={load} fail={props.fail} />)

  return (
    <section class="hub-section" aria-labelledby="hub-providers-title">
      <div class="hub-section-header">
        <div class="hub-section-heading">
          <h2 id="hub-providers-title" class="hub-section-title">
            {copy.providers.title}
          </h2>
          <p class="hub-section-description">{copy.providers.description}</p>
        </div>
        <div class="hub-section-actions">
          <Button variant="neutral" size="small" onClick={chatgpt} disabled={state.status !== "ready"}>
            {copy.providers.chatgpt}
          </Button>
          <Button variant="neutral" size="small" icon="plus" onClick={add} disabled={state.status !== "ready"}>
            {copy.providers.add}
          </Button>
        </div>
      </div>
      <div class="hub-list">
        <Switch>
          <Match when={state.status === "loading"}>
            <div class="hub-list-placeholder">
              <Loader class="size-4 text-v2-icon-icon-muted" />
            </div>
          </Match>
          <Match when={state.status === "failed"}>
            <div class="hub-empty">
              <div class="hub-empty-title">{copy.providers.loadFailed}</div>
              <p class="hub-empty-description">{state.error}</p>
              <Button variant="neutral" size="small" onClick={() => void load()}>
                {copy.providers.retry}
              </Button>
            </div>
          </Match>
          <Match when={state.list.length === 0}>
            <div class="hub-empty">
              <div class="hub-empty-title">{copy.providers.empty}</div>
              <p class="hub-empty-description">{copy.providers.emptyDescription}</p>
            </div>
          </Match>
          <Match when={state.list.length > 0}>
            <For each={state.list}>
              {(provider) => (
                <div class="hub-row">
                  <div class="hub-row-lead">
                    <ProviderIcon id={provider.id} class="hub-provider-icon" aria-hidden="true" />
                    <div class="hub-row-copy">
                      <span class="hub-row-name">
                        <bdi dir="auto">{provider.name}</bdi>
                        <Badge variant={provider.auth === "chatgpt" ? "accent" : "neutral"}>
                          {provider.auth === "chatgpt" ? copy.providers.subscription : copy.providers.apiKey}
                        </Badge>
                      </span>
                      <span class="hub-row-meta">
                        <code dir="ltr">{provider.id}</code>
                        <span aria-hidden="true">·</span>
                        <span class="hub-row-url" dir="ltr">
                          {provider.baseURL}
                        </span>
                      </span>
                    </div>
                  </div>
                  <div class="hub-row-actions">
                    <IconButton
                      variant="ghost-muted"
                      size="small"
                      icon={<Icon name="outline-trash" />}
                      aria-label={copy.providers.remove}
                      onClick={() => remove(provider)}
                    />
                  </div>
                </div>
              )}
            </For>
          </Match>
        </Switch>
      </div>
    </section>
  )
}

type Draft =
  | { step: "pick"; query: string }
  | { step: "catalog"; entry: HubPreset; baseURL: string; editURL: boolean }
  | { step: "custom"; id: string; name: string; baseURL: string }

type FormState = { draft: Draft; apiKey: string; status: "editing" | "saving"; error?: string }

type CatalogState = { status: "loading" | "ready" | "failed"; list: HubPreset[]; error?: string }

function AddProviderDialog(props: { onSaved: () => void; fail: Fail }) {
  const dialog = useDialog()
  // The hub downloads the models.dev catalog on first use, so the picker can wait a few seconds the first time.
  const [catalog, setCatalog] = createStore<CatalogState>({ status: "loading", list: [] })

  const loadCatalog = () => {
    setCatalog({ status: "loading", error: undefined })
    hubApi.presets().then(
      (list) => setCatalog({ status: "ready", list }),
      (error: unknown) => {
        if (error instanceof HubError && error.status === 401) {
          dialog.close()

          return props.fail(copy.error.unknown, error)
        }

        setCatalog({ status: "failed", error: errorText(error) })
      },
    )
  }

  loadCatalog()
  const [form, setForm] = createStore<FormState>({ draft: { step: "pick", query: "" }, apiKey: "", status: "editing" })

  const results = createMemo(() => {
    const draft = form.draft
    const query = draft.step === "pick" ? draft.query.trim() : ""

    if (!query) return catalog.list

    return fuzzysort.go(query, catalog.list, { keys: ["name", "id"] }).map((result) => result.obj)
  })

  const saving = () => form.status === "saving"
  // Drafts are replaced whole: a store write would merge one step's fields into the next.
  const setDraft = (draft: Draft) => setForm("draft", reconcile(draft))

  const canSave = () => {
    const draft = form.draft

    if (form.status !== "editing" || !form.apiKey.trim() || draft.step === "pick") return false

    return draft.step === "catalog" ? !!draft.baseURL.trim() : !!draft.id.trim() && !!draft.baseURL.trim()
  }

  const save = (event: SubmitEvent) => {
    event.preventDefault()
    const draft = form.draft

    if (!canSave() || draft.step === "pick") return
    setForm({ status: "saving", error: undefined })
    hubApi
      .saveProvider(
        draft.step === "catalog"
          ? {
              id: draft.entry.id,
              apiKey: form.apiKey,
              baseURL: draft.baseURL.trim() === draft.entry.baseURL ? undefined : draft.baseURL.trim(),
            }
          : {
              id: draft.id.trim(),
              name: draft.name.trim() || undefined,
              baseURL: draft.baseURL.trim(),
              apiKey: form.apiKey,
            },
      )
      .then(
        (result) => {
          dialog.close()
          props.onSaved()
          showToast({ variant: "success", title: copy.providers.saved(result.provider.name) })
        },
        (error: unknown) => {
          if (error instanceof HubError && error.status === 401) {
            dialog.close()

            return props.fail(copy.error.unknown, error)
          }

          setForm({ status: "editing", error: errorText(error) })
        },
      )
  }

  const picking = () => (form.draft.step === "pick" ? form.draft : undefined)
  const catalogDraft = () => (form.draft.step === "catalog" ? form.draft : undefined)
  const customDraft = () => (form.draft.step === "custom" ? form.draft : undefined)

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup title={copy.provider.title} description={copy.provider.description} />
      </DialogHeader>
      <Show
        when={picking()}
        fallback={
          <form onSubmit={save} class="contents">
            <DialogBody class="hub-dialog-body">
              <div class="hub-stack">
                <Show when={catalogDraft()}>
                  {(draft) => (
                    <>
                      <div class="hub-picked">
                        <ProviderIcon id={draft().entry.id} class="hub-provider-icon" aria-hidden="true" />
                        <div class="hub-row-copy">
                          <span class="hub-row-name">{draft().entry.name}</span>
                          <span class="hub-row-meta">
                            <code dir="ltr">{draft().entry.id}</code>
                          </span>
                        </div>
                        <Show when={draft().entry.doc}>
                          {(doc) => (
                            <a class="hub-link" href={doc()} target="_blank" rel="noopener noreferrer">
                              {copy.provider.docs}
                              <Icon name="arrow-up-right" size="small" />
                            </a>
                          )}
                        </Show>
                      </div>
                      <div class="hub-field">
                        <div class="hub-field-label">
                          <label for="hub-provider-url">{copy.provider.baseURL}</label>
                          <Show when={!draft().editURL}>
                            <Button
                              variant="ghost-muted"
                              size="small"
                              disabled={saving()}
                              onClick={() => setForm("draft", { editURL: true })}
                            >
                              {copy.provider.editURL}
                            </Button>
                          </Show>
                        </div>
                        <TextInput
                          id="hub-provider-url"
                          appearance="large"
                          dir="ltr"
                          type="url"
                          inputMode="url"
                          autocapitalize="off"
                          spellcheck={false}
                          readOnly={!draft().editURL}
                          value={draft().baseURL}
                          disabled={saving()}
                          onInput={(event) => setForm("draft", { baseURL: event.currentTarget.value })}
                        />
                      </div>
                    </>
                  )}
                </Show>
                <Show when={customDraft()}>
                  {(draft) => (
                    <>
                      <div class="hub-field">
                        <label for="hub-provider-id">{copy.provider.id}</label>
                        <TextInput
                          id="hub-provider-id"
                          appearance="large"
                          dir="ltr"
                          autocapitalize="off"
                          spellcheck={false}
                          placeholder={copy.provider.idPlaceholder}
                          value={draft().id}
                          disabled={saving()}
                          aria-describedby="hub-provider-id-hint"
                          onInput={(event) => setForm("draft", { id: event.currentTarget.value })}
                        />
                        <p id="hub-provider-id-hint" class="hub-hint">
                          {copy.provider.idHint}
                        </p>
                      </div>
                      <div class="hub-field">
                        <label for="hub-provider-name">{copy.provider.name}</label>
                        <TextInput
                          id="hub-provider-name"
                          appearance="large"
                          placeholder={copy.provider.namePlaceholder}
                          value={draft().name}
                          disabled={saving()}
                          onInput={(event) => setForm("draft", { name: event.currentTarget.value })}
                        />
                      </div>
                      <div class="hub-field">
                        <label for="hub-provider-url">{copy.provider.baseURL}</label>
                        <TextInput
                          id="hub-provider-url"
                          appearance="large"
                          dir="ltr"
                          type="url"
                          inputMode="url"
                          autocapitalize="off"
                          spellcheck={false}
                          placeholder={copy.provider.baseURLPlaceholder}
                          value={draft().baseURL}
                          disabled={saving()}
                          onInput={(event) => setForm("draft", { baseURL: event.currentTarget.value })}
                        />
                      </div>
                    </>
                  )}
                </Show>
                <div class="hub-field">
                  <label for="hub-provider-key">{copy.provider.apiKey}</label>
                  <TextInput
                    id="hub-provider-key"
                    appearance="large"
                    type="password"
                    autocomplete="off"
                    dir="ltr"
                    autofocus
                    value={form.apiKey}
                    disabled={saving()}
                    aria-describedby="hub-provider-key-hint"
                    onInput={(event) => setForm({ apiKey: event.currentTarget.value, error: undefined })}
                  />
                  <p id="hub-provider-key-hint" class="hub-hint">
                    {copy.provider.replaceHint}
                  </p>
                </div>
                <Show when={form.error}>
                  <p class="hub-error" role="alert">
                    {form.error}
                  </p>
                </Show>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button
                variant="ghost"
                disabled={saving()}
                onClick={() => {
                  setForm({ error: undefined })
                  setDraft({ step: "pick", query: "" })
                }}
              >
                {copy.provider.back}
              </Button>
              <Button type="submit" variant="contrast" disabled={!canSave()}>
                {saving() ? copy.provider.saving : copy.provider.save}
              </Button>
            </DialogFooter>
          </form>
        }
      >
        {(draft) => (
          <>
            <DialogBody class="hub-picker">
              <Switch>
                <Match when={catalog.status === "loading"}>
                  <div class="hub-list-placeholder">
                    <Loader class="size-4 text-v2-icon-icon-muted" />
                  </div>
                </Match>
                <Match when={catalog.status === "failed"}>
                  <div class="hub-empty">
                    <div class="hub-empty-title">{copy.provider.catalogFailed}</div>
                    <p class="hub-empty-description">{catalog.error}</p>
                    <Button variant="neutral" size="small" onClick={loadCatalog}>
                      {copy.providers.retry}
                    </Button>
                  </div>
                </Match>
                <Match when={catalog.status === "ready"}>
                  <SearchList
                    query={draft().query}
                    onQuery={(query) => setForm("draft", { query })}
                    placeholder={copy.provider.search}
                    label={copy.provider.preset}
                    items={results()}
                    key={(entry) => entry.id}
                    empty={copy.provider.noMatch}
                    onSelect={(entry) =>
                      setDraft({ step: "catalog", entry: { ...entry }, baseURL: entry.baseURL, editURL: false })
                    }
                    onClose={() => dialog.close()}
                  >
                    {(entry, attrs) => (
                      <button type="button" class="hub-picker-row" {...attrs}>
                        <ProviderIcon id={entry().id} class="hub-provider-icon" aria-hidden="true" />
                        <span class="hub-picker-copy">
                          <span class="hub-picker-name">
                            <SearchHighlight text={entry().name} />
                            <code dir="ltr">{entry().id}</code>
                          </span>
                          <span class="hub-picker-url" dir="ltr">
                            {entry().baseURL}
                          </span>
                        </span>
                      </button>
                    )}
                  </SearchList>
                </Match>
              </Switch>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDraft({ step: "custom", id: "", name: "", baseURL: "" })}>
                {copy.provider.custom}
              </Button>
            </DialogFooter>
          </>
        )}
      </Show>
    </Dialog>
  )
}

function RemoveProviderDialog(props: { provider: HubProvider; onRemoved: () => void; fail: Fail }) {
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)

  const confirm = () => {
    if (busy()) return
    setBusy(true)
    hubApi.deleteProvider(props.provider.id).then(
      () => {
        dialog.close()
        props.onRemoved()
        showToast({ variant: "success", title: copy.providers.removed(props.provider.name) })
      },
      (error: unknown) => {
        dialog.close()
        props.fail(copy.providers.removeFailed, error)
      },
    )
  }

  return (
    <Dialog fit>
      <DialogHeader hideClose>
        <DialogTitleGroup
          title={copy.providers.removeTitle}
          description={copy.providers.removeDescription(props.provider.name)}
        />
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" autofocus disabled={busy()} onClick={() => dialog.close()}>
          {copy.cancel}
        </Button>
        <Button variant="danger" disabled={busy()} onClick={confirm}>
          {copy.providers.removeConfirm}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
