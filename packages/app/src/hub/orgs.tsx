import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Loader } from "@opencode/ui/loader"
import { Menu } from "@opencode/ui/menu"
import { TextInput } from "@opencode/ui/text-input"
import { showToast } from "@opencode/ui/toast"
import { createSignal, For, Match, onMount, Show, Switch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { errorText, hubApi, HubError, type HubOrg, type HubUser } from "./api"
import { copy } from "./copy"
import type { Fail } from "./dashboard"

const MAX_NAME = 64

/** Organization administration, shown to hub administrators only. */
export function Organizations(props: { fail: Fail }) {
  const dialog = useDialog()

  const [state, setState] = createStore<{ status: "loading" | "ready" | "failed"; list: HubOrg[]; error?: string }>({
    status: "loading",
    list: [],
  })

  const load = () =>
    hubApi.orgs().then(
      (list) => {
        setState({ status: "ready", error: undefined })
        setState("list", reconcile(list, { key: "id" }))
      },
      (error: HubError) => {
        if (error instanceof HubError && error.status === 401) return props.fail(copy.orgs.loadFailed, error)

        // A refresh that fails keeps the list already on screen.
        if (state.status === "ready") return props.fail(copy.orgs.loadFailed, error)
        setState({ status: "failed", error: errorText(error) })
      },
    )

  onMount(() => void load())

  const create = () =>
    void dialog.show(() => (
      <NameDialog
        title={copy.orgs.createTitle}
        save={(name) => hubApi.createOrg(name)}
        onDone={load}
        fail={props.fail}
      />
    ))

  const rename = (org: HubOrg) =>
    void dialog.show(() => (
      <NameDialog
        title={copy.orgs.renameTitle}
        initial={org.name}
        save={(name) => hubApi.renameOrg(org.id, name)}
        onDone={load}
        fail={props.fail}
      />
    ))

  const remove = (org: HubOrg) => void dialog.show(() => <DeleteDialog org={org} onDone={load} fail={props.fail} />)

  const members = (org: HubOrg) =>
    void dialog.show(() => (
      <MembersDialog org={() => state.list.find((entry) => entry.id === org.id)} onChange={load} fail={props.fail} />
    ))

  return (
    <section class="hub-section" aria-labelledby="hub-orgs-title">
      <div class="hub-section-header">
        <div class="hub-section-heading">
          <h2 id="hub-orgs-title" class="hub-section-title">
            {copy.orgs.title}
          </h2>
          <p class="hub-section-description">{copy.orgs.description}</p>
        </div>
        <Button variant="neutral" size="small" icon="plus" onClick={create} disabled={state.status !== "ready"}>
          {copy.orgs.create}
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
              <div class="hub-empty-title">{copy.orgs.loadFailed}</div>
              <p class="hub-empty-description">{state.error}</p>
              <Button variant="neutral" size="small" onClick={() => void load()}>
                {copy.orgs.retry}
              </Button>
            </div>
          </Match>
          <Match when={state.status === "ready" && state.list.length === 0}>
            <div class="hub-empty">
              <div class="hub-empty-title">{copy.orgs.empty}</div>
            </div>
          </Match>
          <Match when={state.status === "ready"}>
            <For each={state.list}>
              {(org) => (
                <div class="hub-row">
                  <div class="hub-row-lead">
                    <div class="hub-row-copy">
                      <span class="hub-row-name">
                        <bdi dir="auto">{org.name}</bdi>
                      </span>
                      <span class="hub-row-meta">
                        <span>{copy.orgs.members(org.members.length)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{copy.orgs.machines(org.machines)}</span>
                      </span>
                    </div>
                  </div>
                  <div class="hub-row-actions">
                    <Button variant="neutral" size="small" onClick={() => members(org)}>
                      {copy.orgs.manage}
                    </Button>
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
                          <Menu.Item onSelect={() => rename(org)}>{copy.orgs.rename}</Menu.Item>
                          <Menu.Item onSelect={() => remove(org)}>{copy.orgs.delete}</Menu.Item>
                        </Menu.Content>
                      </Menu.Portal>
                    </Menu>
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

/** Creates or renames an organization. */
function NameDialog(props: {
  title: string
  initial?: string
  save: (name: string) => Promise<object>
  onDone: () => void
  fail: Fail
}) {
  const dialog = useDialog()

  const [form, setForm] = createStore<{ name: string; busy: boolean; error?: string }>({
    name: props.initial ?? "",
    busy: false,
  })

  const valid = () => form.name.trim().length > 0 && form.name.trim().length <= MAX_NAME

  const submit = (event: SubmitEvent) => {
    event.preventDefault()

    if (form.busy || !valid()) return
    setForm({ busy: true, error: undefined })
    props.save(form.name.trim()).then(
      () => {
        dialog.close()
        props.onDone()
      },
      (error: HubError) => {
        if (error instanceof HubError && error.status === 401) {
          dialog.close()

          return props.fail(copy.orgs.actionFailed, error)
        }

        setForm({ busy: false, error: errorText(error) })
      },
    )
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup title={props.title} description={copy.orgs.formDescription} />
      </DialogHeader>
      <form onSubmit={submit} class="contents">
        <DialogBody class="hub-dialog-body">
          <div class="hub-stack">
            <div class="hub-field">
              <label for="hub-org-name">{copy.orgs.name}</label>
              <TextInput
                id="hub-org-name"
                appearance="large"
                autofocus
                maxLength={MAX_NAME}
                value={form.name}
                disabled={form.busy}
                aria-describedby="hub-org-name-hint"
                onInput={(event) => setForm({ name: event.currentTarget.value, error: undefined })}
              />
              <p id="hub-org-name-hint" class="hub-hint">
                {copy.orgs.nameHint}
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
          <Button variant="ghost" disabled={form.busy} onClick={() => dialog.close()}>
            {copy.cancel}
          </Button>
          <Button type="submit" variant="contrast" disabled={form.busy || !valid()}>
            {form.busy ? copy.orgs.saving : copy.orgs.save}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}

function DeleteDialog(props: { org: HubOrg; onDone: () => void; fail: Fail }) {
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)

  const confirm = () => {
    if (busy()) return
    setBusy(true)
    hubApi.deleteOrg(props.org.id).then(
      () => {
        dialog.close()
        showToast({ variant: "success", title: copy.orgs.deleted(props.org.name) })
        props.onDone()
      },
      (error: HubError) => {
        dialog.close()
        props.fail(copy.orgs.actionFailed, error)
      },
    )
  }

  return (
    <Dialog fit>
      <DialogHeader hideClose>
        <DialogTitleGroup title={copy.orgs.deleteTitle} description={copy.orgs.deleteDescription(props.org.name)} />
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" autofocus disabled={busy()} onClick={() => dialog.close()}>
          {copy.cancel}
        </Button>
        <Button variant="danger" disabled={busy()} onClick={confirm}>
          {copy.orgs.deleteConfirm}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

/** The members of one organization, and the other users who can be added. `org` follows the reloaded list. */
function MembersDialog(props: { org: () => HubOrg | undefined; onChange: () => Promise<void>; fail: Fail }) {
  const dialog = useDialog()
  const [users, setUsers] = createStore<{ loaded: boolean; list: HubUser[] }>({ loaded: false, list: [] })
  const [busy, setBusy] = createSignal(false)

  onMount(() =>
    hubApi.users().then(
      (list) => setUsers({ loaded: true, list }),
      (error: HubError) => {
        dialog.close()
        props.fail(copy.orgs.actionFailed, error)
      },
    ),
  )

  const others = () => users.list.filter((user) => !props.org()?.members.some((member) => member.id === user.id))

  const act = (run: (org: string) => Promise<object | void>) => {
    const org = props.org()

    if (busy() || !org) return
    setBusy(true)
    run(org.id)
      .then(props.onChange, (error: HubError) => props.fail(copy.orgs.actionFailed, error))
      .finally(() => setBusy(false))
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup
          title={copy.orgs.membersTitle(props.org()?.name ?? "")}
          description={copy.orgs.membersDescription}
        />
      </DialogHeader>
      <DialogBody class="hub-dialog-body">
        <div class="hub-stack">
          <div class="hub-list">
            <Show
              when={(props.org()?.members.length ?? 0) > 0}
              fallback={
                <div class="hub-empty">
                  <div class="hub-empty-title">{copy.orgs.noMembers}</div>
                </div>
              }
            >
              <For each={props.org()?.members}>
                {(member) => (
                  <div class="hub-row">
                    <div class="hub-row-lead">
                      <div class="hub-row-copy">
                        <span class="hub-row-name">
                          <bdi dir="auto">{member.login}</bdi>
                        </span>
                      </div>
                    </div>
                    <div class="hub-row-actions">
                      <IconButton
                        variant="ghost-muted"
                        size="small"
                        icon={<Icon name="outline-trash" />}
                        aria-label={copy.orgs.remove}
                        disabled={busy()}
                        onClick={() => act((org) => hubApi.removeMember(org, member.id))}
                      />
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </div>
          <div class="hub-step">
            <span class="hub-step-title">{copy.orgs.others}</span>
            <div class="hub-list">
              <Show
                when={users.loaded}
                fallback={
                  <div class="hub-list-placeholder">
                    <Loader class="size-4 text-v2-icon-icon-muted" />
                  </div>
                }
              >
                <Show
                  when={others().length > 0}
                  fallback={
                    <div class="hub-empty">
                      <div class="hub-empty-title">{copy.orgs.noOthers}</div>
                    </div>
                  }
                >
                  <For each={others()}>
                    {(user) => (
                      <div class="hub-row">
                        <div class="hub-row-lead">
                          <div class="hub-row-copy">
                            <span class="hub-row-name">
                              <bdi dir="auto">{user.login}</bdi>
                            </span>
                          </div>
                        </div>
                        <div class="hub-row-actions">
                          <Button
                            variant="neutral"
                            size="small"
                            disabled={busy()}
                            onClick={() => act((org) => hubApi.addMember(org, user.id))}
                          >
                            {copy.orgs.add}
                          </Button>
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </Show>
            </div>
          </div>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="neutral" onClick={() => dialog.close()}>
          {copy.done}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
