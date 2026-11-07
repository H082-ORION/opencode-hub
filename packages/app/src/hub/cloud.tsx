import { Badge } from "@opencode/ui/badge"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Loader } from "@opencode/ui/loader"
import { Menu } from "@opencode/ui/menu"
import { TextInput } from "@opencode/ui/text-input"
import { showToast } from "@opencode/ui/toast"
import { createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { CommandLine } from "./add-machine"
import {
  errorText,
  hubApi,
  type EnrollmentCode,
  type HubCloud,
  type HubCloudAdminHost,
  type HubCloudHost,
  type HubCloudInstance,
} from "./api"
import { copy } from "./copy"
import type { Fail } from "./dashboard"

const GIB = 1024 ** 3

// Statuses in which the instance waits for its server: no other action until it answers.
const BUSY = new Set(["creating", "starting", "stopping", "deleting"])

/** The user's cloud instances, live from the dashboard's event stream. Hidden while the hub has no cloud server. */
export function CloudInstances(props: { cloud: HubCloud; fail: Fail }) {
  const dialog = useDialog()
  const online = createMemo(() => props.cloud.hosts.filter((host) => host.online))

  const create = () => void dialog.show(() => <NewInstanceDialog hosts={online()} fail={props.fail} />)

  return (
    <Show when={props.cloud.hosts.length > 0 || props.cloud.instances.length > 0}>
      <section class="hub-section" aria-labelledby="hub-cloud-title">
        <div class="hub-section-header">
          <div class="hub-section-heading">
            <h2 id="hub-cloud-title" class="hub-section-title">
              {copy.cloud.title}
            </h2>
            <p class="hub-section-description">{copy.cloud.description}</p>
          </div>
          <Show when={props.cloud.instances.length > 0}>
            <Button variant="neutral" size="small" icon="plus" disabled={online().length === 0} onClick={create}>
              {copy.cloud.create}
            </Button>
          </Show>
        </div>
        <div class="hub-list">
          <Show
            when={props.cloud.instances.length > 0}
            fallback={
              <div class="hub-empty">
                <Icon name="monitor" class="text-v2-icon-icon-muted" />
                <div class="hub-empty-title">{copy.cloud.empty}</div>
                <p class="hub-empty-description">
                  {online().length > 0 ? copy.cloud.emptyDescription : copy.cloud.noServer}
                </p>
                <Show when={online().length > 0}>
                  <Button variant="contrast" size="normal" icon="plus" onClick={create}>
                    {copy.cloud.create}
                  </Button>
                </Show>
              </div>
            }
          >
            <For each={props.cloud.instances}>
              {(instance) => <InstanceRow instance={instance} fail={props.fail} />}
            </For>
          </Show>
        </div>
      </section>
    </Show>
  )
}

/** One cloud instance with its status, size, live usage and actions. `owner` shows for administrators. */
function InstanceRow(props: { instance: HubCloudInstance; owner?: string | null; fail: Fail }) {
  const dialog = useDialog()
  const instance = () => props.instance
  const busy = () => BUSY.has(instance().status)

  const act = (action: (id: string) => Promise<object>) =>
    void action(instance().id).catch((error: unknown) => props.fail(copy.cloud.actionFailed, error))

  const remove = () =>
    void dialog.show(() => (
      <ConfirmDialog
        title={copy.cloud.deleteTitle}
        description={copy.cloud.deleteDescription(instance().name)}
        confirm={copy.cloud.deleteConfirm}
        run={() => hubApi.deleteCloudInstance(instance().id)}
        done={copy.cloud.deleting(instance().name)}
        failed={copy.cloud.actionFailed}
        fail={props.fail}
      />
    ))

  return (
    <div class="hub-row">
      <div class="hub-row-lead">
        <Show
          when={!busy()}
          fallback={<Loader class="size-3 text-v2-icon-icon-muted" aria-label={copy.cloud.status[instance().status]} />}
        >
          <span
            class="hub-status"
            data-online={instance().status === "running" ? "" : undefined}
            role="img"
            aria-label={copy.cloud.status[instance().status]}
          />
        </Show>
        <div class="hub-row-copy">
          <span class="hub-row-name">
            <bdi dir="auto">{instance().name}</bdi>
            <Show when={instance().status === "failed" || instance().status === "missing"}>
              <Badge variant="neutral">{copy.cloud.status[instance().status]}</Badge>
            </Show>
          </span>
          <span class="hub-row-meta">
            <span>{copy.cloud.status[instance().status]}</span>
            <span aria-hidden="true">·</span>
            <span>
              {copy.cloud.limits(
                instance().limits.cpu,
                gib(instance().limits.memory_mib / 1024),
                instance().limits.disk_gib,
              )}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              <bdi dir="auto">{copy.cloud.on(instance().host.name)}</bdi>
            </span>
            <Show when={props.owner}>
              {(owner) => (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    <bdi dir="auto">{copy.cloud.owner(owner())}</bdi>
                  </span>
                </>
              )}
            </Show>
          </span>
          <Show when={instance().status === "running" ? instance().metrics : undefined}>
            {(metrics) => (
              <span class="hub-row-meta">
                {copy.cloud.usage(
                  metrics().cpuPercent === null ? "…" : `${Math.round(metrics().cpuPercent ?? 0)}%`,
                  `${gib(metrics().memoryUsedBytes / GIB)} / ${gib(metrics().memoryTotalBytes / GIB)}`,
                  gib(metrics().diskUsedBytes / GIB),
                )}
              </span>
            )}
          </Show>
          <Show when={instance().error}>
            {(error) => (
              <span class="hub-error" role="status">
                {error()}
              </span>
            )}
          </Show>
        </div>
      </div>
      <div class="hub-row-actions">
        <Show when={instance().url !== null && props.owner === undefined}>
          <Button
            variant={instance().status === "running" ? "contrast" : "neutral"}
            size="small"
            disabled={instance().status !== "running"}
            onClick={() => window.open(instance().url ?? "", "_blank", "noopener")}
          >
            {copy.cloud.open}
          </Button>
        </Show>
        <Show when={!busy()}>
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
                <Show when={instance().status === "stopped" || instance().status === "missing"}>
                  <Menu.Item onSelect={() => act(hubApi.startCloudInstance)}>{copy.cloud.start}</Menu.Item>
                </Show>
                <Show when={instance().status === "running"}>
                  <Menu.Item onSelect={() => act(hubApi.stopCloudInstance)}>{copy.cloud.stop}</Menu.Item>
                </Show>
                <Menu.Item onSelect={remove}>{copy.cloud.delete}</Menu.Item>
              </Menu.Content>
            </Menu.Portal>
          </Menu>
        </Show>
      </div>
    </div>
  )
}

function NewInstanceDialog(props: { hosts: HubCloudHost[]; fail: Fail }) {
  const dialog = useDialog()

  const [form, setForm] = createStore<{
    name: string
    host: string
    cpu: string
    memory: string
    disk: string
    busy: boolean
    error?: string
  }>({
    name: "",
    host: props.hosts[0]?.id ?? "",
    cpu: "2",
    memory: "4",
    disk: "20",
    busy: false,
  })

  const host = () => props.hosts.find((entry) => entry.id === form.host)
  const max = () => host()?.max ?? undefined
  const memoryGiB = () => Math.floor((max()?.memory_mib ?? 0) / 1024)

  const values = () => ({
    cpu: Number(form.cpu),
    memory_mib: Math.round(Number(form.memory) * 1024),
    disk_gib: Number(form.disk),
  })

  const valid = () => {
    const limit = max()
    const value = values()

    return (
      form.name.trim().length > 0 &&
      limit !== undefined &&
      !limit.full &&
      Number.isInteger(value.cpu) &&
      Number.isInteger(value.disk_gib) &&
      value.cpu >= 1 &&
      value.cpu <= limit.cpu &&
      value.memory_mib >= 256 &&
      value.memory_mib <= limit.memory_mib &&
      value.disk_gib >= 1 &&
      value.disk_gib <= limit.disk_gib
    )
  }

  const submit = (event: SubmitEvent) => {
    event.preventDefault()

    if (form.busy || !valid()) return
    setForm({ busy: true, error: undefined })
    hubApi.createCloudInstance({ host: form.host, name: form.name.trim(), ...values() }).then(
      (created) => {
        dialog.close()
        showToast({ variant: "success", title: copy.cloud.created(created.instance.name) })
      },
      (error: unknown) => setForm({ busy: false, error: errorText(error) }),
    )
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup title={copy.cloud.newTitle} description={copy.cloud.newDescription} />
      </DialogHeader>
      <form onSubmit={submit} class="contents">
        <DialogBody class="hub-dialog-body">
          <div class="hub-stack">
            <div class="hub-field">
              <label for="hub-cloud-name">{copy.cloud.name}</label>
              <TextInput
                id="hub-cloud-name"
                appearance="large"
                maxLength={64}
                value={form.name}
                disabled={form.busy}
                autofocus
                onInput={(event) => setForm({ name: event.currentTarget.value, error: undefined })}
              />
            </div>
            <Show when={props.hosts.length > 1}>
              <div class="hub-field">
                <span class="hub-field-label">{copy.cloud.server}</span>
                <div class="hub-row-actions">
                  <For each={props.hosts}>
                    {(entry) => (
                      <Button
                        variant={entry.id === form.host ? "contrast" : "neutral"}
                        size="small"
                        disabled={form.busy}
                        aria-pressed={entry.id === form.host}
                        onClick={() => setForm({ host: entry.id, error: undefined })}
                      >
                        {entry.name}
                      </Button>
                    )}
                  </For>
                </div>
              </div>
            </Show>
            <Show when={max()?.full}>
              <p class="hub-error" role="alert">
                {copy.cloud.full}
              </p>
            </Show>
            <NumberField
              id="hub-cloud-cpu"
              label={copy.cloud.cpu}
              value={form.cpu}
              max={max()?.cpu ?? 0}
              disabled={form.busy}
              onInput={(cpu) => setForm({ cpu, error: undefined })}
            />
            <NumberField
              id="hub-cloud-memory"
              label={copy.cloud.memory}
              value={form.memory}
              max={memoryGiB()}
              disabled={form.busy}
              onInput={(memory) => setForm({ memory, error: undefined })}
            />
            <NumberField
              id="hub-cloud-disk"
              label={copy.cloud.disk}
              value={form.disk}
              max={max()?.disk_gib ?? 0}
              disabled={form.busy}
              onInput={(disk) => setForm({ disk, error: undefined })}
            />
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
            {form.busy ? copy.cloud.creating : copy.cloud.create}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}

function NumberField(props: {
  id: string
  label: string
  value: string
  max: number
  disabled: boolean
  onInput: (value: string) => void
}) {
  return (
    <div class="hub-field">
      <label for={props.id}>{props.label}</label>
      <TextInput
        id={props.id}
        appearance="large"
        type="number"
        inputMode="numeric"
        min="1"
        max={String(props.max)}
        value={props.value}
        disabled={props.disabled}
        aria-describedby={`${props.id}-hint`}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
      <p id={`${props.id}-hint`} class="hub-hint">
        {copy.cloud.max(props.max)}
      </p>
    </div>
  )
}

/** The cloud servers and every cloud instance, for administrators, who link and revoke servers. */
export function CloudHosts(props: { cloud: HubCloud; fail: Fail }) {
  const dialog = useDialog()
  const admin = () => props.cloud.admin

  const link = () => void dialog.show(() => <LinkHostDialog fail={props.fail} />)

  const revoke = (host: HubCloudAdminHost) =>
    void dialog.show(() => (
      <ConfirmDialog
        title={copy.cloudHosts.revokeTitle}
        description={copy.cloudHosts.revokeDescription(host.name)}
        confirm={copy.cloudHosts.revokeConfirm}
        run={() => hubApi.revokeCloudHost(host.id)}
        done={copy.cloudHosts.revoked(host.name)}
        failed={copy.cloudHosts.revokeFailed}
        fail={props.fail}
      />
    ))

  return (
    <Show when={admin()}>
      {(view) => (
        <section class="hub-section" aria-labelledby="hub-cloud-hosts-title">
          <div class="hub-section-header">
            <div class="hub-section-heading">
              <h2 id="hub-cloud-hosts-title" class="hub-section-title">
                {copy.cloudHosts.title}
              </h2>
              <p class="hub-section-description">{copy.cloudHosts.description}</p>
            </div>
            <Show when={view().hosts.length > 0}>
              <Button variant="neutral" size="small" icon="plus" onClick={link}>
                {copy.cloudHosts.link}
              </Button>
            </Show>
          </div>
          <div class="hub-list">
            <Show
              when={view().hosts.length > 0}
              fallback={
                <div class="hub-empty">
                  <Icon name="monitor" class="text-v2-icon-icon-muted" />
                  <div class="hub-empty-title">{copy.cloudHosts.empty}</div>
                  <p class="hub-empty-description">{copy.cloudHosts.emptyDescription}</p>
                  <Button variant="contrast" size="normal" icon="plus" onClick={link}>
                    {copy.cloudHosts.link}
                  </Button>
                </div>
              }
            >
              <For each={view().hosts}>{(host) => <HostRow host={host} onRevoke={() => revoke(host)} />}</For>
            </Show>
          </div>
          <Show when={view().instances.length > 0}>
            <h3 class="hub-section-description">{copy.cloudHosts.instances}</h3>
            <div class="hub-list">
              <For each={view().instances}>
                {(instance) => <InstanceRow instance={instance} owner={instance.owner ?? ""} fail={props.fail} />}
              </For>
            </div>
          </Show>
        </section>
      )}
    </Show>
  )
}

function HostRow(props: { host: HubCloudAdminHost; onRevoke: () => void }) {
  const capacity = () => props.host.capacity

  const used = (resource: { total: number; allocated: number }, unit = "") =>
    `${resource.allocated}${unit} / ${resource.total}${unit}`

  return (
    <div class="hub-row">
      <div class="hub-row-lead">
        <span
          class="hub-status"
          data-online={props.host.online ? "" : undefined}
          role="img"
          aria-label={props.host.online ? copy.machines.online : copy.machines.offline}
        />
        <div class="hub-row-copy">
          <span class="hub-row-name">
            <bdi dir="auto">{props.host.name}</bdi>
          </span>
          <span class="hub-row-meta">
            <code dir="ltr">{props.host.id}</code>
            <Show when={props.host.version}>
              <span aria-hidden="true">·</span>
              <span>{copy.cloudHosts.version(props.host.version ?? "", props.host.lxdVersion ?? "")}</span>
            </Show>
            <Show when={!props.host.online}>
              <span aria-hidden="true">·</span>
              <span>{copy.machines.offline}</span>
            </Show>
          </span>
          <Show when={capacity()}>
            {(value) => (
              <span class="hub-row-meta">
                {copy.cloudHosts.capacity(
                  used(value().cpu),
                  used(
                    { total: gibNumber(value().memory_mib.total), allocated: gibNumber(value().memory_mib.allocated) },
                    " GiB",
                  ),
                  used(value().disk_gib, " GiB"),
                  `${value().instances.count} / ${value().instances.max}`,
                )}
              </span>
            )}
          </Show>
          <Show when={props.host.metrics}>
            {(metrics) => (
              <span class="hub-row-meta">
                {copy.cloudHosts.load(
                  metrics()
                    .load.map((value) => value.toFixed(2))
                    .join(" "),
                )}
                <span aria-hidden="true"> · </span>
                {`RAM ${gib(metrics().memory_used_bytes / GIB)} / ${gib(metrics().memory_total_bytes / GIB)}`}
                <span aria-hidden="true"> · </span>
                {`disk ${gib(metrics().disk_used_bytes / GIB)} / ${gib(metrics().disk_total_bytes / GIB)}`}
              </span>
            )}
          </Show>
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
              <Menu.Item onSelect={props.onRevoke}>{copy.cloudHosts.revoke}</Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu>
      </div>
    </div>
  )
}

function LinkHostDialog(props: { fail: Fail }) {
  const dialog = useDialog()
  const [code, setCode] = createSignal<EnrollmentCode>()
  const [error, setError] = createSignal<string>()
  const [now, setNow] = createSignal(Date.now())
  const clock = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(clock))

  const request = () => {
    setError(undefined)
    setCode(undefined)
    hubApi.createHostCode().then(
      (issued) => {
        setNow(Date.now())
        setCode(issued)
      },
      (failure: unknown) => setError(errorText(failure)),
    )
  }

  request()

  const remaining = () => Math.max(0, (code()?.expiresAt ?? 0) - now())

  const countdown = () => {
    const seconds = Math.ceil(remaining() / 1000)

    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup title={copy.cloudHosts.linkTitle} description={copy.cloudHosts.linkDescription} />
      </DialogHeader>
      <DialogBody class="hub-dialog-body">
        <Switch
          fallback={
            <div class="hub-list-placeholder">
              <Loader class="size-4 text-v2-icon-icon-muted" />
            </div>
          }
        >
          <Match when={error()}>
            {(message) => (
              <div class="hub-stack">
                <p class="hub-error" role="alert">
                  {copy.cloudHosts.codeFailed}: {message()}
                </p>
                <div>
                  <Button variant="neutral" size="small" onClick={request}>
                    {copy.add.retry}
                  </Button>
                </div>
              </div>
            )}
          </Match>
          <Match when={code()}>
            {(issued) => (
              <div class="hub-stack">
                <div class="hub-code-block" data-expired={remaining() === 0 ? "" : undefined}>
                  <div class="hub-code-row">
                    <span class="hub-code" aria-label={copy.add.code}>
                      {issued().code}
                    </span>
                  </div>
                  <span class="hub-code-expiry" role="status">
                    {remaining() === 0 ? copy.add.expired : copy.add.expiresIn(countdown())}
                  </span>
                  <Show when={remaining() === 0}>
                    <Button variant="neutral" size="small" icon="reset" onClick={request}>
                      {copy.add.newCode}
                    </Button>
                  </Show>
                </div>
                <div class="hub-step">
                  <span class="hub-step-title">{copy.cloudHosts.step1}</span>
                  <CommandLine command={`sudo -u agent-hub-lxd ${issued().command}`} />
                </div>
                <div class="hub-step">
                  <span class="hub-step-title">{copy.cloudHosts.step2}</span>
                  <CommandLine command="sudo systemctl enable --now agent-hub-lxd" />
                </div>
              </div>
            )}
          </Match>
        </Switch>
      </DialogBody>
      <DialogFooter>
        <Button variant="neutral" onClick={() => dialog.close()}>
          {copy.done}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

function ConfirmDialog(props: {
  title: string
  description: string
  confirm: string
  run: () => Promise<void>
  done: string
  failed: string
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
        showToast({ variant: "success", title: props.done })
      },
      (error: unknown) => {
        dialog.close()
        props.fail(props.failed, error)
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

/** GiB with at most one decimal: `4`, `1.5`. */
function gib(value: number) {
  return `${Math.round(value * 10) / 10} GiB`
}

function gibNumber(mib: number) {
  return Math.round((mib / 1024) * 10) / 10
}
