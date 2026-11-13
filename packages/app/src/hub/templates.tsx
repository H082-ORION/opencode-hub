import { Badge } from "@opencode/ui/badge"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Loader } from "@opencode/ui/loader"
import { Menu } from "@opencode/ui/menu"
import { Select } from "@opencode/ui/select"
import { TextInput } from "@opencode/ui/text-input"
import { Textarea } from "@opencode/ui/textarea"
import { showToast } from "@opencode/ui/toast"
import { createSignal, For, type JSX, Match, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { errorText, hubApi, HubError, type HubChatModel, type HubTemplate, type TemplateDraft } from "./api"
import { copy } from "./copy"
import type { Fail } from "./dashboard"

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_NAME = 48
const MAX_DESCRIPTION = 300

/** A model the dialog offers, or the conversation's own. */
type ModelOption = { value: string | null; label: string }

/**
 * The agent templates the chat gives its sub-agents: the built-in roles, then the user's own, which they edit here. A
 * template of theirs named like a built-in one replaces it.
 */
export function Templates(props: { fail: Fail }) {
  const dialog = useDialog()
  const [state, setState] = createStore<{
    status: "loading" | "ready" | "failed"
    data?: HubTemplate[]
    models?: HubChatModel[]
    error?: string
  }>({ status: "loading" })

  const load = () =>
    Promise.all([hubApi.templates(), hubApi.chatModels().catch((): HubChatModel[] => [])]).then(
      ([data, models]) => setState({ status: "ready", data, models, error: undefined }),
      (error: HubError) => {
        if (error instanceof HubError && error.status === 401) return props.fail(copy.templates.loadFailed, error)
        if (state.status === "ready") return props.fail(copy.templates.loadFailed, error)
        setState({ status: "failed", error: errorText(error) })
      },
    )
  onMount(() => void load())

  const edit = (template?: HubTemplate, copyOf?: HubTemplate) =>
    void dialog.show(() => (
      <TemplateDialog
        initial={template ?? copyOf}
        models={state.models ?? []}
        save={(draft) => hubApi.saveTemplate(draft, template?.id)}
        onDone={load}
        fail={props.fail}
      />
    ))
  const view = (template: HubTemplate) =>
    void dialog.show(() => <TemplateDialog initial={template} models={state.models ?? []} fail={props.fail} />)
  const remove = (template: HubTemplate) =>
    void dialog.show(() => <DeleteTemplateDialog template={template} onDone={load} fail={props.fail} />)

  const own = () => (state.data ?? []).filter((template) => !template.builtin)
  const builtin = () => (state.data ?? []).filter((template) => template.builtin)

  return (
    <section class="hub-section" aria-labelledby="hub-templates-title">
      <div class="hub-section-header">
        <div class="hub-section-heading">
          <h2 id="hub-templates-title" class="hub-section-title">
            {copy.templates.title}
          </h2>
          <p class="hub-section-description">{copy.templates.description}</p>
        </div>
        <Button variant="neutral" size="small" icon="plus" onClick={() => edit()} disabled={state.status !== "ready"}>
          {copy.templates.create}
        </Button>
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
              <div class="hub-empty-title">{copy.templates.loadFailed}</div>
              <p class="hub-empty-description">{state.error}</p>
              <Button variant="neutral" size="small" onClick={() => void load()}>
                {copy.templates.retry}
              </Button>
            </div>
          </Match>
          <Match when={state.data}>
            <For each={[...own(), ...builtin()]}>
              {(template) => (
                <TemplateRow template={template}>
                  <Menu gutter={6} modal={false} placement="bottom-end">
                    <Menu.Trigger
                      as={IconButton}
                      variant="ghost-muted"
                      size="small"
                      icon={<Icon name="outline-dots" />}
                      aria-label={copy.more}
                    />
                    <Menu.Portal>
                      <Menu.Content>
                        <Show
                          when={!template.builtin}
                          fallback={
                            <>
                              <Menu.Item onSelect={() => view(template)}>{copy.templates.view}</Menu.Item>
                              <Menu.Item onSelect={() => edit(undefined, template)}>
                                {copy.templates.duplicate}
                              </Menu.Item>
                            </>
                          }
                        >
                          <Menu.Item onSelect={() => edit(template)}>{copy.templates.edit}</Menu.Item>
                          <Menu.Item onSelect={() => remove(template)}>{copy.templates.delete}</Menu.Item>
                        </Show>
                      </Menu.Content>
                    </Menu.Portal>
                  </Menu>
                </TemplateRow>
              )}
            </For>
          </Match>
        </Switch>
      </div>
    </section>
  )
}

function TemplateRow(props: { template: HubTemplate; children: JSX.Element }) {
  return (
    <div class="hub-row">
      <div class="hub-row-lead">
        <div class="hub-row-copy">
          <span class="hub-row-name">
            <code dir="ltr">{props.template.name}</code>
            <Show when={props.template.builtin}>
              <Badge variant="subtle">{copy.templates.builtin}</Badge>
            </Show>
          </span>
          <span class="hub-row-meta">
            <Show when={props.template.model}>
              {(model) => (
                <>
                  <span>{copy.templates.defaultModel(model())}</span>
                  <span aria-hidden="true">·</span>
                </>
              )}
            </Show>
            <Show when={props.template.agent}>
              {(agent) => (
                <>
                  <span>{copy.templates.machineAgent(agent())}</span>
                  <span aria-hidden="true">·</span>
                </>
              )}
            </Show>
            <span class="hub-row-url">
              <bdi dir="auto">{props.template.description}</bdi>
            </span>
          </span>
        </div>
      </div>
      <div class="hub-row-actions">{props.children}</div>
    </div>
  )
}

function TemplateDialog(props: {
  initial?: HubTemplate
  models: HubChatModel[]
  save?: (draft: TemplateDraft) => Promise<object>
  onDone?: () => void
  fail: Fail
}) {
  const dialog = useDialog()
  const [form, setForm] = createStore<{
    name: string
    description: string
    system: string
    model: string | null
    agent: string
    busy: boolean
    error?: string
  }>({
    name: props.initial?.name ?? "",
    description: props.initial?.description ?? "",
    system: props.initial?.system ?? "",
    model: props.initial?.model ?? null,
    agent: props.initial?.agent ?? "",
    busy: false,
  })
  const readOnly = () => !props.save || form.busy
  const valid = () =>
    NAME.test(form.name.trim()) &&
    form.name.trim().length <= MAX_NAME &&
    form.description.trim().length > 0 &&
    form.system.trim().length > 0
  const options = (): ModelOption[] => [
    { value: null, label: copy.templates.modelNone },
    ...props.models.map((model) => ({ value: `${model.providerID}/${model.id}`, label: model.name })),
  ]
  const current = () => options().find((option) => option.value === form.model) ?? options()[0]

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const save = props.save
    if (!save || form.busy || !valid()) return
    const name = form.name.trim()
    setForm({ busy: true, error: undefined })
    save({
      name,
      description: form.description.trim(),
      system: form.system.trim(),
      model: form.model,
      agent: form.agent.trim() || null,
    }).then(
      () => {
        dialog.close()
        showToast({ variant: "success", title: copy.templates.saved(name) })
        props.onDone?.()
      },
      (error: HubError) => {
        if (error instanceof HubError && error.status === 401) {
          dialog.close()
          return props.fail(copy.templates.actionFailed, error)
        }
        setForm({ busy: false, error: errorText(error) })
      },
    )
  }

  return (
    <Dialog fit class="hub-skill-dialog">
      <DialogHeader>
        <DialogTitleGroup
          title={
            !props.save
              ? copy.templates.viewTitle(props.initial?.name ?? "")
              : props.initial && !props.initial.builtin
                ? copy.templates.editTitle
                : copy.templates.createTitle
          }
          description={copy.templates.formDescription}
        />
      </DialogHeader>
      <form onSubmit={submit} class="contents">
        <DialogBody class="hub-dialog-body">
          <div class="hub-stack">
            <div class="hub-field">
              <label for="hub-template-name">{copy.templates.name}</label>
              <TextInput
                id="hub-template-name"
                appearance="large"
                autofocus={!!props.save}
                maxLength={MAX_NAME}
                value={form.name}
                readOnly={readOnly()}
                aria-describedby="hub-template-name-hint"
                onInput={(event) => setForm({ name: event.currentTarget.value, error: undefined })}
              />
              <p id="hub-template-name-hint" class="hub-hint">
                {copy.templates.nameHint}
              </p>
            </div>
            <div class="hub-field">
              <label for="hub-template-description">{copy.templates.descriptionLabel}</label>
              <TextInput
                id="hub-template-description"
                appearance="large"
                maxLength={MAX_DESCRIPTION}
                value={form.description}
                readOnly={readOnly()}
                aria-describedby="hub-template-description-hint"
                onInput={(event) => setForm({ description: event.currentTarget.value, error: undefined })}
              />
              <p id="hub-template-description-hint" class="hub-hint">
                {copy.templates.descriptionHint}
              </p>
            </div>
            <div class="hub-field">
              <label for="hub-template-system">{copy.templates.system}</label>
              <Textarea
                class="w-full"
                id="hub-template-system"
                rows={10}
                value={form.system}
                readOnly={readOnly()}
                aria-describedby="hub-template-system-hint"
                onInput={(event) => setForm({ system: event.currentTarget.value, error: undefined })}
              />
              <p id="hub-template-system-hint" class="hub-hint">
                {copy.templates.systemHint}
              </p>
            </div>
            <div class="hub-field">
              <span class="hub-step-title">{copy.templates.model}</span>
              <Show when={props.save} fallback={<p class="hub-hint">{current()?.label}</p>}>
                <Select
                  aria-label={copy.templates.model}
                  options={options()}
                  current={current()}
                  value={(option) => option.value ?? ""}
                  label={(option) => option.label}
                  placement="bottom-start"
                  gutter={6}
                  onSelect={(option) => setForm({ model: option?.value ?? null, error: undefined })}
                />
              </Show>
              <p class="hub-hint">{copy.templates.modelHint}</p>
            </div>
            <div class="hub-field">
              <label for="hub-template-agent">{copy.templates.agent}</label>
              <TextInput
                id="hub-template-agent"
                appearance="large"
                maxLength={MAX_NAME}
                value={form.agent}
                readOnly={readOnly()}
                aria-describedby="hub-template-agent-hint"
                onInput={(event) => setForm({ agent: event.currentTarget.value, error: undefined })}
              />
              <p id="hub-template-agent-hint" class="hub-hint">
                {copy.templates.agentHint}
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
          <Show
            when={props.save}
            fallback={
              <Button variant="neutral" onClick={() => dialog.close()}>
                {copy.close}
              </Button>
            }
          >
            <Button variant="ghost" disabled={form.busy} onClick={() => dialog.close()}>
              {copy.cancel}
            </Button>
            <Button type="submit" variant="contrast" disabled={form.busy || !valid()}>
              {form.busy ? copy.templates.saving : copy.templates.save}
            </Button>
          </Show>
        </DialogFooter>
      </form>
    </Dialog>
  )
}

function DeleteTemplateDialog(props: { template: HubTemplate; onDone: () => void; fail: Fail }) {
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)
  const confirm = () => {
    if (busy()) return
    setBusy(true)
    hubApi.deleteTemplate(props.template.id).then(
      () => {
        dialog.close()
        showToast({ variant: "success", title: copy.templates.deleted(props.template.name) })
        props.onDone()
      },
      (error: HubError) => {
        dialog.close()
        props.fail(copy.templates.actionFailed, error)
      },
    )
  }
  return (
    <Dialog fit>
      <DialogHeader hideClose>
        <DialogTitleGroup
          title={copy.templates.deleteTitle}
          description={copy.templates.deleteDescription(props.template.name)}
        />
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" autofocus disabled={busy()} onClick={() => dialog.close()}>
          {copy.cancel}
        </Button>
        <Button variant="danger" disabled={busy()} onClick={confirm}>
          {copy.templates.deleteConfirm}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
