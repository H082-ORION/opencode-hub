import { Badge } from "@opencode/ui/badge"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Loader } from "@opencode/ui/loader"
import { RadioGroup, RadioItem } from "@opencode/ui/radio"
import { TextInput } from "@opencode/ui/text-input"
import { showToast } from "@opencode/ui/toast"
import { createSignal, For, Match, onMount, Show, Switch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { errorText, hubApi, HubError, type HubConnector } from "./api"
import { copy } from "./copy"
import type { Fail } from "./dashboard"

type ListState = { status: "loading" | "ready" | "failed"; list: HubConnector[]; error?: string }

/**
 * The user's remote MCP servers. Their machines reach them through the hub, which adds the saved headers or the OAuth
 * token; header values are never shown again once saved.
 */
export function Connectors(props: { fail: Fail; unlocked: boolean; onLocked: () => void; onSignOut: () => void }) {
  const dialog = useDialog()
  const [state, setState] = createStore<ListState>({ status: "loading", list: [] })
  // The connector whose OAuth sign-in is starting; the browser leaves the page once it has its URL.
  const [starting, setStarting] = createSignal<string>()

  const load = () =>
    hubApi.connectors().then(
      (list) => {
        setState({ status: "ready", error: undefined })
        setState("list", reconcile(list, { key: "id" }))

        return list
      },
      (error: HubError) => {
        if (error instanceof HubError && error.status === 401) return props.fail(copy.connectors.loadFailed, error)

        // A refresh that fails keeps the list already on screen.
        if (state.status === "ready") return props.fail(copy.connectors.loadFailed, error)
        setState({ status: "failed", error: errorText(error) })
      },
    )

  onMount(() => {
    // The hub's OAuth callback comes back to `/?connector=<id>` once the connector is signed in.
    const returned = new URLSearchParams(window.location.search).get("connector")

    void load().then((list) => {
      if (!returned || !list) return
      window.history.replaceState(null, "", "/")
      const connector = list.find((entry) => entry.id === returned)

      if (connector?.connected) showToast({ variant: "success", title: copy.connectors.connected(connector.name) })
    })
  })

  const ready = () => state.status === "ready" && props.unlocked

  const add = () =>
    void dialog.show(() => <AddConnectorDialog onSaved={load} onLocked={props.onLocked} fail={props.fail} />)

  const remove = (connector: HubConnector) =>
    void dialog.show(() => <RemoveConnectorDialog connector={connector} onRemoved={load} fail={props.fail} />)

  const connect = (connector: HubConnector) => {
    if (starting()) return
    setStarting(connector.id)
    hubApi.connectorSignIn(connector.id).then(
      (signIn) => window.location.assign(signIn.url),
      (error: HubError) => {
        setStarting(undefined)

        if (error instanceof HubError && error.status === 423) props.onLocked()
        props.fail(copy.connectors.connectFailed, error)
      },
    )
  }

  return (
    <section class="hub-section" aria-labelledby="hub-connectors-title">
      <div class="hub-section-header">
        <div class="hub-section-heading">
          <h2 id="hub-connectors-title" class="hub-section-title">
            {copy.connectors.title}
          </h2>
          <p class="hub-section-description">{copy.connectors.description}</p>
        </div>
        <div class="hub-section-actions">
          <Button variant="neutral" size="small" icon="plus" onClick={add} disabled={!ready()}>
            {copy.connectors.add}
          </Button>
        </div>
      </div>
      <Show when={!props.unlocked}>
        <div class="hub-list">
          <div class="hub-row" role="status">
            <div class="hub-row-lead">
              <span class="hub-status" role="img" aria-label={copy.providers.locked} />
              <div class="hub-row-copy">
                <span class="hub-row-name">{copy.providers.locked}</span>
                <span class="hub-row-meta">{copy.connectors.lockedDescription}</span>
              </div>
            </div>
            <div class="hub-row-actions">
              <Button variant="neutral" size="small" onClick={props.onSignOut}>
                {copy.providers.signInAgain}
              </Button>
            </div>
          </div>
        </div>
      </Show>
      <div class="hub-list">
        <Switch>
          <Match when={state.status === "loading"}>
            <div class="hub-list-placeholder">
              <Loader class="size-4 text-v2-icon-icon-muted" />
            </div>
          </Match>
          <Match when={state.status === "failed"}>
            <div class="hub-empty">
              <div class="hub-empty-title">{copy.connectors.loadFailed}</div>
              <p class="hub-empty-description">{state.error}</p>
              <Button variant="neutral" size="small" onClick={() => void load()}>
                {copy.connectors.retry}
              </Button>
            </div>
          </Match>
          <Match when={state.list.length === 0}>
            <div class="hub-empty">
              <div class="hub-empty-title">{copy.connectors.empty}</div>
              <p class="hub-empty-description">{copy.connectors.emptyDescription}</p>
            </div>
          </Match>
          <Match when={state.list.length > 0}>
            <For each={state.list}>
              {(connector) => (
                <div class="hub-row">
                  <div class="hub-row-lead">
                    <div class="hub-row-copy">
                      <span class="hub-row-name">
                        <bdi dir="auto">{connector.name}</bdi>
                        <Switch>
                          <Match when={connector.auth === "headers"}>
                            <Badge variant="neutral">{copy.connectors.headersBadge(connector.headers.length)}</Badge>
                          </Match>
                          <Match when={connector.connected}>
                            <Badge variant="accent">{copy.connectors.oauthConnected}</Badge>
                          </Match>
                          <Match when={!connector.connected}>
                            <Badge variant="neutral">{copy.connectors.oauthNotConnected}</Badge>
                          </Match>
                        </Switch>
                      </span>
                      <span class="hub-row-meta">
                        <code dir="ltr">{connector.server}</code>
                        <span aria-hidden="true">·</span>
                        <span class="hub-row-url" dir="ltr">
                          {connector.url}
                        </span>
                      </span>
                    </div>
                  </div>
                  <div class="hub-row-actions">
                    <Show when={connector.auth === "oauth"}>
                      <Button
                        variant="neutral"
                        size="small"
                        disabled={!props.unlocked || starting() !== undefined}
                        onClick={() => connect(connector)}
                      >
                        {starting() === connector.id
                          ? copy.connectors.connecting
                          : connector.connected
                            ? copy.connectors.reconnect
                            : copy.connectors.connect}
                      </Button>
                    </Show>
                    <IconButton
                      variant="ghost-muted"
                      size="small"
                      icon={<Icon name="outline-trash" />}
                      aria-label={copy.connectors.remove}
                      onClick={() => remove(connector)}
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

type FormState = {
  name: string
  url: string
  auth: "headers" | "oauth"
  headers: { name: string; value: string }[]
  clientID: string
  clientSecret: string
  status: "editing" | "saving"
  error?: string
}

function AddConnectorDialog(props: { onSaved: () => void; onLocked: () => void; fail: Fail }) {
  const dialog = useDialog()

  const [form, setForm] = createStore<FormState>({
    name: "",
    url: "",
    auth: "headers",
    headers: [{ name: "", value: "" }],
    clientID: "",
    clientSecret: "",
    status: "editing",
  })

  const saving = () => form.status === "saving"
  // Empty header rows are ignored, so the first row can stay blank for a server without secrets.
  const headers = () => form.headers.filter((header) => header.name.trim() || header.value.trim())
  const canSave = () => form.status === "editing" && !!form.name.trim() && !!form.url.trim()

  const save = (event: SubmitEvent) => {
    event.preventDefault()

    if (!canSave()) return
    setForm({ status: "saving", error: undefined })
    hubApi
      .saveConnector(
        form.auth === "headers"
          ? { name: form.name.trim(), url: form.url.trim(), auth: "headers", headers: headers() }
          : {
              name: form.name.trim(),
              url: form.url.trim(),
              auth: "oauth",
              clientID: form.clientID.trim() || undefined,
              clientSecret: form.clientSecret.trim() || undefined,
            },
      )
      .then(
        (result) => {
          dialog.close()
          props.onSaved()
          showToast({ variant: "success", title: copy.connectors.saved(result.connector.name) })
        },
        (error: HubError) => {
          if (error instanceof HubError && error.status === 401) {
            dialog.close()

            return props.fail(copy.error.unknown, error)
          }

          if (error instanceof HubError && error.status === 423) props.onLocked()
          setForm({ status: "editing", error: errorText(error) })
        },
      )
  }

  return (
    <Dialog fit class="hub-skill-dialog">
      <DialogHeader>
        <DialogTitleGroup title={copy.connector.title} description={copy.connector.description} />
      </DialogHeader>
      <form onSubmit={save} class="contents">
        <DialogBody class="hub-dialog-body">
          <div class="hub-stack">
            <div class="hub-field">
              <label for="hub-connector-name">{copy.connector.name}</label>
              <TextInput
                id="hub-connector-name"
                appearance="large"
                autofocus
                maxLength={64}
                placeholder={copy.connector.namePlaceholder}
                value={form.name}
                disabled={saving()}
                aria-describedby="hub-connector-name-hint"
                onInput={(event) => setForm({ name: event.currentTarget.value, error: undefined })}
              />
              <p id="hub-connector-name-hint" class="hub-hint">
                {copy.connector.nameHint}
              </p>
            </div>
            <div class="hub-field">
              <label for="hub-connector-url">{copy.connector.url}</label>
              <TextInput
                id="hub-connector-url"
                appearance="large"
                dir="ltr"
                type="url"
                inputMode="url"
                autocapitalize="off"
                spellcheck={false}
                placeholder={copy.connector.urlPlaceholder}
                value={form.url}
                disabled={saving()}
                aria-describedby="hub-connector-url-hint"
                onInput={(event) => setForm({ url: event.currentTarget.value, error: undefined })}
              />
              <p id="hub-connector-url-hint" class="hub-hint">
                {copy.connector.urlHint}
              </p>
            </div>
            <RadioGroup
              label={copy.connector.auth}
              value={form.auth}
              disabled={saving()}
              onChange={(value: string) => setForm({ auth: value === "oauth" ? "oauth" : "headers", error: undefined })}
            >
              <RadioItem value="headers" label={copy.connector.headers} description={copy.connector.headersHint} />
              <RadioItem value="oauth" label={copy.connector.oauth} description={copy.connector.oauthHint} />
            </RadioGroup>
            <Show
              when={form.auth === "headers"}
              fallback={
                <>
                  <div class="hub-field">
                    <label for="hub-connector-client">{copy.connector.clientID}</label>
                    <TextInput
                      id="hub-connector-client"
                      appearance="large"
                      dir="ltr"
                      autocapitalize="off"
                      spellcheck={false}
                      placeholder={copy.connector.optional}
                      value={form.clientID}
                      disabled={saving()}
                      aria-describedby="hub-connector-client-hint"
                      onInput={(event) => setForm({ clientID: event.currentTarget.value, error: undefined })}
                    />
                    <p id="hub-connector-client-hint" class="hub-hint">
                      {copy.connector.clientIDHint}
                    </p>
                  </div>
                  <Show when={form.clientID.trim()}>
                    <div class="hub-field">
                      <label for="hub-connector-secret">{copy.connector.clientSecret}</label>
                      <TextInput
                        id="hub-connector-secret"
                        appearance="large"
                        type="password"
                        autocomplete="off"
                        dir="ltr"
                        placeholder={copy.connector.optional}
                        value={form.clientSecret}
                        disabled={saving()}
                        onInput={(event) => setForm({ clientSecret: event.currentTarget.value, error: undefined })}
                      />
                    </div>
                  </Show>
                </>
              }
            >
              <div class="hub-step">
                <span class="hub-step-title">{copy.connector.headerList}</span>
                <p class="hub-hint">{copy.connector.headerListHint}</p>
                <For each={form.headers}>
                  {(header, index) => (
                    <div class="hub-stack-tight">
                      <div class="hub-code-row">
                        <TextInput
                          class="min-w-0 flex-1"
                          dir="ltr"
                          autocapitalize="off"
                          spellcheck={false}
                          aria-label={copy.connector.headerName}
                          placeholder={copy.connector.headerNamePlaceholder}
                          value={header.name}
                          disabled={saving()}
                          onInput={(event) => setForm("headers", index(), "name", event.currentTarget.value)}
                        />
                        <IconButton
                          type="button"
                          variant="ghost-muted"
                          size="small"
                          icon={<Icon name="outline-trash" />}
                          aria-label={copy.connector.removeHeader}
                          disabled={saving()}
                          onClick={() => setForm("headers", (list) => list.filter((_, at) => at !== index()))}
                        />
                      </div>
                      <TextInput
                        dir="ltr"
                        type="password"
                        autocomplete="off"
                        aria-label={copy.connector.headerValue}
                        placeholder={copy.connector.headerValue}
                        value={header.value}
                        disabled={saving()}
                        onInput={(event) => setForm("headers", index(), "value", event.currentTarget.value)}
                      />
                    </div>
                  )}
                </For>
                <div>
                  <Button
                    type="button"
                    variant="neutral"
                    size="small"
                    icon="plus"
                    disabled={saving()}
                    onClick={() => setForm("headers", (list) => [...list, { name: "", value: "" }])}
                  >
                    {copy.connector.addHeader}
                  </Button>
                </div>
              </div>
            </Show>
            <Show when={form.error}>
              <p class="hub-error" role="alert">
                {form.error}
              </p>
            </Show>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={saving()} onClick={() => dialog.close()}>
            {copy.cancel}
          </Button>
          <Button type="submit" variant="contrast" disabled={!canSave()}>
            {saving() ? copy.connector.saving : copy.connector.save}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}

function RemoveConnectorDialog(props: { connector: HubConnector; onRemoved: () => void; fail: Fail }) {
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)

  const confirm = () => {
    if (busy()) return
    setBusy(true)
    hubApi.deleteConnector(props.connector.id).then(
      () => {
        dialog.close()
        props.onRemoved()
        showToast({ variant: "success", title: copy.connectors.removed(props.connector.name) })
      },
      (error: HubError) => {
        dialog.close()
        props.fail(copy.connectors.removeFailed, error)
      },
    )
  }

  return (
    <Dialog fit>
      <DialogHeader hideClose>
        <DialogTitleGroup
          title={copy.connectors.removeTitle}
          description={copy.connectors.removeDescription(props.connector.name)}
        />
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" autofocus disabled={busy()} onClick={() => dialog.close()}>
          {copy.cancel}
        </Button>
        <Button variant="danger" disabled={busy()} onClick={confirm}>
          {copy.connectors.removeConfirm}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
