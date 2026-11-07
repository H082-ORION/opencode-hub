import { Badge } from "@opencode/ui/badge"
import { Button } from "@opencode/ui/button"
import { Checkbox } from "@opencode/ui/checkbox"
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
import { CommandLine } from "./add-machine"
import { errorText, hubApi, HubError, type HubInvitation, type HubUser, type IssuedInvitation } from "./api"
import { copy } from "./copy"
import type { Fail } from "./dashboard"

const date = new Intl.DateTimeFormat("en", { dateStyle: "medium" })

const DEFAULT_DAYS = 7

const MAX_DAYS = 30

type ListState = {
  status: "loading" | "ready" | "failed"
  users: HubUser[]
  invitations: HubInvitation[]
  error?: string
}

/** User administration, shown to hub administrators only. */
export function Users(props: { fail: Fail }) {
  const dialog = useDialog()
  const [state, setState] = createStore<ListState>({ status: "loading", users: [], invitations: [] })

  const load = () =>
    Promise.all([hubApi.users(), hubApi.invitations()]).then(
      ([users, invitations]) => {
        setState({ status: "ready", error: undefined })
        setState("users", reconcile(users, { key: "id" }))
        setState("invitations", reconcile(invitations, { key: "id" }))
      },
      (error: unknown) => {
        if (error instanceof HubError && error.status === 401) return props.fail(copy.users.loadFailed, error)

        // A refresh that fails keeps the list already on screen.
        if (state.status === "ready") return props.fail(copy.users.loadFailed, error)
        setState({ status: "failed", error: errorText(error) })
      },
    )

  onMount(() => void load())

  /** Runs an account change, then reloads; a lost session goes back to sign-in through `fail`. */
  const act = (run: () => Promise<object>) =>
    run().then(
      () => void load(),
      (error: unknown) => props.fail(copy.users.actionFailed, error),
    )

  const invite = () => void dialog.show(() => <InviteDialog onIssued={load} fail={props.fail} />)

  const disable = (user: HubUser) =>
    void dialog.show(() => (
      <ConfirmDialog
        title={copy.users.disableTitle}
        description={copy.users.disableDescription(user.login)}
        confirm={copy.users.disableConfirm}
        run={() => hubApi.disable(user.id)}
        onDone={load}
        fail={props.fail}
      />
    ))

  const reset = (user: HubUser) => void dialog.show(() => <ResetDialog user={user} onDone={load} fail={props.fail} />)

  const revoke = (invitation: HubInvitation) =>
    hubApi.revokeInvitation(invitation.id).then(
      () => {
        showToast({ variant: "success", title: copy.users.revoked })
        void load()
      },
      (error: unknown) => props.fail(copy.users.revokeFailed, error),
    )

  return (
    <>
      <section class="hub-section" aria-labelledby="hub-users-title">
        <div class="hub-section-header">
          <div class="hub-section-heading">
            <h2 id="hub-users-title" class="hub-section-title">
              {copy.users.title}
            </h2>
            <p class="hub-section-description">{copy.users.description}</p>
          </div>
          <Button variant="neutral" size="small" icon="plus" onClick={invite} disabled={state.status !== "ready"}>
            {copy.users.invite}
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
                <div class="hub-empty-title">{copy.users.loadFailed}</div>
                <p class="hub-empty-description">{state.error}</p>
                <Button variant="neutral" size="small" onClick={() => void load()}>
                  {copy.users.retry}
                </Button>
              </div>
            </Match>
            <Match when={state.status === "ready"}>
              <For each={state.users}>
                {(user) => (
                  <div class="hub-row">
                    <div class="hub-row-lead">
                      <div class="hub-row-copy">
                        <span class="hub-row-name">
                          <bdi dir="auto">{user.login}</bdi>
                          <Show when={user.self}>
                            <Badge variant="subtle">{copy.users.you}</Badge>
                          </Show>
                          <Show when={user.role === "admin"}>
                            <Badge variant="accent">{copy.users.admin}</Badge>
                          </Show>
                          <Show when={user.disabled}>
                            <Badge variant="neutral">{copy.users.disabled}</Badge>
                          </Show>
                        </span>
                        <span class="hub-row-meta">
                          <span>{copy.users.created(date.format(user.createdAt))}</span>
                          <Show when={user.pending}>
                            <span aria-hidden="true">·</span>
                            <span>{copy.users.pending}</span>
                          </Show>
                        </span>
                      </div>
                    </div>
                    <div class="hub-row-actions">
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
                            <Menu.Item
                              onSelect={() =>
                                void act(() => hubApi.setRole(user.id, user.role === "admin" ? "user" : "admin"))
                              }
                            >
                              {user.role === "admin" ? copy.users.makeUser : copy.users.makeAdmin}
                            </Menu.Item>
                            <Menu.Item onSelect={() => reset(user)}>{copy.users.reset}</Menu.Item>
                            <Show
                              when={user.disabled}
                              fallback={<Menu.Item onSelect={() => disable(user)}>{copy.users.disable}</Menu.Item>}
                            >
                              <Menu.Item onSelect={() => void act(() => hubApi.enable(user.id))}>
                                {copy.users.enable}
                              </Menu.Item>
                            </Show>
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
      <Show when={state.status === "ready"}>
        <section class="hub-section" aria-labelledby="hub-invitations-title">
          <div class="hub-section-header">
            <div class="hub-section-heading">
              <h2 id="hub-invitations-title" class="hub-section-title">
                {copy.users.invitations}
              </h2>
              <p class="hub-section-description">{copy.users.invitationsDescription}</p>
            </div>
          </div>
          <div class="hub-list">
            <Show
              when={state.invitations.length > 0}
              fallback={
                <div class="hub-empty">
                  <div class="hub-empty-title">{copy.users.noInvitations}</div>
                </div>
              }
            >
              <For each={state.invitations}>
                {(invitation) => (
                  <div class="hub-row">
                    <div class="hub-row-lead">
                      <div class="hub-row-copy">
                        <span class="hub-row-name">
                          <bdi dir="auto">
                            {invitation.reset
                              ? copy.users.resetFor(invitation.reset)
                              : copy.users.invitation(invitation.role)}
                          </bdi>
                        </span>
                        <span class="hub-row-meta">
                          <span>{copy.users.expires(date.format(invitation.expiresAt))}</span>
                          <Show when={invitation.createdBy}>
                            {(login) => (
                              <>
                                <span aria-hidden="true">·</span>
                                <span>{copy.users.by(login())}</span>
                              </>
                            )}
                          </Show>
                        </span>
                      </div>
                    </div>
                    <div class="hub-row-actions">
                      <IconButton
                        variant="ghost-muted"
                        size="small"
                        icon={<Icon name="outline-trash" />}
                        aria-label={copy.users.revoke}
                        onClick={() => void revoke(invitation)}
                      />
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </section>
      </Show>
    </>
  )
}

function InviteDialog(props: { onIssued: () => void; fail: Fail }) {
  const dialog = useDialog()

  const [form, setForm] = createStore<{ admin: boolean; days: string; busy: boolean; error?: string }>({
    admin: false,
    days: String(DEFAULT_DAYS),
    busy: false,
  })

  const [issued, setIssued] = createSignal<IssuedInvitation>()

  const days = () => Number(form.days)
  const valid = () => Number.isInteger(days()) && days() >= 1 && days() <= MAX_DAYS

  const submit = (event: SubmitEvent) => {
    event.preventDefault()

    if (form.busy || !valid()) return
    setForm({ busy: true, error: undefined })
    hubApi.invite({ role: form.admin ? "admin" : "user", days: days() }).then(
      (invitation) => {
        setIssued(invitation)
        props.onIssued()
      },
      (error: unknown) => {
        if (error instanceof HubError && error.status === 401) {
          dialog.close()

          return props.fail(copy.invite.failed, error)
        }

        setForm({ busy: false, error: errorText(error) })
      },
    )
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup title={copy.invite.title} description={copy.invite.description} />
      </DialogHeader>
      <Show
        when={issued()}
        fallback={
          <form onSubmit={submit} class="contents">
            <DialogBody class="hub-dialog-body">
              <div class="hub-stack">
                <Checkbox
                  appearance="compact"
                  checked={form.admin}
                  disabled={form.busy}
                  description={copy.invite.adminDescription}
                  onChange={(admin: boolean) => setForm({ admin })}
                >
                  {copy.invite.admin}
                </Checkbox>
                <div class="hub-field">
                  <label for="hub-invite-days">{copy.invite.days}</label>
                  <TextInput
                    id="hub-invite-days"
                    appearance="large"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max={String(MAX_DAYS)}
                    value={form.days}
                    invalid={!valid()}
                    disabled={form.busy}
                    aria-describedby="hub-invite-days-hint"
                    onInput={(event) => setForm({ days: event.currentTarget.value, error: undefined })}
                  />
                  <p id="hub-invite-days-hint" class="hub-hint">
                    {copy.invite.daysHint}
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
                {form.busy ? copy.invite.creating : copy.invite.create}
              </Button>
            </DialogFooter>
          </form>
        }
      >
        {(invitation) => <IssuedLink label={copy.invite.link} invitation={invitation()} />}
      </Show>
    </Dialog>
  )
}

function ResetDialog(props: { user: HubUser; onDone: () => void; fail: Fail }) {
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)
  const [issued, setIssued] = createSignal<IssuedInvitation>()

  const confirm = () => {
    if (busy()) return
    setBusy(true)
    hubApi.reset(props.user.id).then(
      (invitation) => {
        setIssued(invitation)
        props.onDone()
      },
      (error: unknown) => {
        dialog.close()
        props.fail(copy.users.actionFailed, error)
      },
    )
  }

  return (
    <Dialog fit>
      <DialogHeader hideClose={!issued()}>
        <DialogTitleGroup title={copy.users.resetTitle} description={copy.users.resetDescription(props.user.login)} />
      </DialogHeader>
      <Show
        when={issued()}
        fallback={
          <DialogFooter>
            <Button variant="ghost" autofocus disabled={busy()} onClick={() => dialog.close()}>
              {copy.cancel}
            </Button>
            <Button variant="danger" disabled={busy()} onClick={confirm}>
              {copy.users.resetConfirm}
            </Button>
          </DialogFooter>
        }
      >
        {(invitation) => <IssuedLink label={copy.invite.resetLink} invitation={invitation()} />}
      </Show>
    </Dialog>
  )
}

/** The one-time link of a new invitation, shown once with its expiry. */
function IssuedLink(props: { label: string; invitation: IssuedInvitation }) {
  const dialog = useDialog()

  return (
    <>
      <DialogBody class="hub-dialog-body">
        <div class="hub-stack">
          <div class="hub-step">
            <span class="hub-step-title">{props.label}</span>
            <CommandLine command={props.invitation.url} />
            <p class="hub-hint">
              {copy.invite.linkHint} {copy.users.expires(date.format(props.invitation.expiresAt))}.
            </p>
          </div>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="neutral" onClick={() => dialog.close()}>
          {copy.done}
        </Button>
      </DialogFooter>
    </>
  )
}

function ConfirmDialog(props: {
  title: string
  description: string
  confirm: string
  run: () => Promise<object>
  onDone: () => void
  fail: Fail
}) {
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)

  const confirm = () => {
    if (busy()) return
    setBusy(true)
    props.run().then(
      () => {
        dialog.close()
        props.onDone()
      },
      (error: unknown) => {
        dialog.close()
        props.fail(copy.users.actionFailed, error)
      },
    )
  }

  return (
    <Dialog fit>
      <DialogHeader hideClose>
        <DialogTitleGroup title={props.title} description={props.description} />
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" autofocus disabled={busy()} onClick={() => dialog.close()}>
          {copy.cancel}
        </Button>
        <Button variant="danger" disabled={busy()} onClick={confirm}>
          {props.confirm}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
