import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Loader } from "@opencode/ui/loader"
import { Menu } from "@opencode/ui/menu"
import { showToast } from "@opencode/ui/toast"
import { createEffect, createSignal, For, Match, on, onCleanup, Show, Switch, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { AddMachineDialog } from "./add-machine"
import { errorText, hubApi, HubError, type HubAdminMachine, type HubMachine } from "./api"
import { copy } from "./copy"
import type { Fail } from "./dashboard"
import { createFeed, feedReconnecting, transitionFeed, type FeedEffect, type FeedEvent } from "./machine"

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" })

const UNITS = [
  { unit: "day", ms: 86_400_000 },
  { unit: "hour", ms: 3_600_000 },
  { unit: "minute", ms: 60_000 },
] as const

export function Machines(props: { onSignedOut: () => void; fail: Fail; onChange?: () => void }) {
  const dialog = useDialog()
  const [machines, setMachines] = createStore<{ loaded: boolean; list: HubMachine[] }>({ loaded: false, list: [] })
  const initial = createFeed()
  const [feed, setFeed] = createSignal(initial.state)
  const [now, setNow] = createSignal(Date.now())
  const clock = setInterval(() => setNow(Date.now()), 30_000)
  const driver: { source?: EventSource; timer?: ReturnType<typeof setTimeout> } = {}

  const dispatch = (event: FeedEvent) => {
    const next = transitionFeed(untrack(feed), event)

    if (next.state !== untrack(feed)) setFeed(next.state)
    next.effects.forEach(run)
  }

  function run(effect: FeedEffect) {
    if (effect.type === "signed-out") return props.onSignedOut()

    if (effect.type === "close") {
      driver.source?.close()
      driver.source = undefined

      return
    }

    if (effect.type === "schedule") {
      clearTimeout(driver.timer)
      driver.timer = setTimeout(() => dispatch({ type: "retry.due", attempt: effect.attempt }), effect.delayMs)

      return
    }

    // An EventSource cannot see a 401, so the session is checked first to tell sign-out from a dropped connection.
    void hubApi.session().then(
      () => open(effect.attempt),
      (error: unknown) =>
        dispatch({
          type: error instanceof HubError && error.status === 401 ? "unauthorized" : "failed",
          attempt: effect.attempt,
        }),
    )
  }

  function open(attempt: number) {
    if (untrack(feed).status !== "connecting") return
    const source = new EventSource("/hub/api/events")
    driver.source = source
    source.addEventListener("open", () => dispatch({ type: "opened", attempt }))
    source.addEventListener("error", () => dispatch({ type: "failed", attempt }))
    source.addEventListener("machines", (event) => {
      setMachines({ loaded: true })
      // SAFETY: the hub that serves this page writes `machines` events from the same list as `GET machines`.
      setMachines("list", reconcile(JSON.parse(event.data) as HubMachine[], { key: "id" }))
      // The hub sends this event whenever any machine enrolls, connects, disconnects or is revoked.
      props.onChange?.()
    })
  }

  initial.effects.forEach(run)
  onCleanup(() => {
    clearInterval(clock)
    clearTimeout(driver.timer)
    driver.source?.close()
  })

  const add = () => void dialog.show(() => <AddMachineDialog fail={props.fail} />)
  const revoke = (machine: HubMachine) => void dialog.show(() => <RevokeDialog machine={machine} fail={props.fail} />)

  return (
    <section class="hub-section" aria-labelledby="hub-machines-title">
      <div class="hub-section-header">
        <div class="hub-section-heading">
          <h2 id="hub-machines-title" class="hub-section-title">
            {copy.machines.title}
            <Show when={machines.loaded && feedReconnecting(feed())}>
              <span class="hub-section-status" role="status">
                <Loader class="size-3" />
                {copy.machines.reconnecting}
              </span>
            </Show>
          </h2>
          <p class="hub-section-description">{copy.machines.description}</p>
        </div>
        <Show when={machines.list.length > 0}>
          <Button variant="neutral" size="small" icon="plus" onClick={add}>
            {copy.machines.add}
          </Button>
        </Show>
      </div>
      <div class="hub-list">
        <Show
          when={machines.loaded}
          fallback={
            <div class="hub-list-placeholder">
              <Loader class="size-4 text-v2-icon-icon-muted" />
            </div>
          }
        >
          <Show
            when={machines.list.length > 0}
            fallback={
              <div class="hub-empty">
                <Icon name="monitor" class="text-v2-icon-icon-muted" />
                <div class="hub-empty-title">{copy.machines.empty}</div>
                <p class="hub-empty-description">{copy.machines.emptyDescription}</p>
                <Button variant="contrast" size="normal" icon="plus" onClick={add}>
                  {copy.machines.add}
                </Button>
              </div>
            }
          >
            <For each={machines.list}>
              {(machine) => (
                <div class="hub-row">
                  <div class="hub-row-lead">
                    <span
                      class="hub-status"
                      data-online={machine.online ? "" : undefined}
                      role="img"
                      aria-label={machine.online ? copy.machines.online : copy.machines.offline}
                    />
                    <div class="hub-row-copy">
                      <span class="hub-row-name">
                        <bdi dir="auto">{machine.name}</bdi>
                      </span>
                      <span class="hub-row-meta">
                        <code dir="ltr">{machine.id}</code>
                        <span aria-hidden="true">·</span>
                        <span>{lastSeen(machine, now())}</span>
                      </span>
                    </div>
                  </div>
                  <div class="hub-row-actions">
                    <Button
                      variant={machine.online ? "contrast" : "neutral"}
                      size="small"
                      onClick={() => window.open(machine.url, "_blank", "noopener")}
                    >
                      {copy.machines.open}
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
                          <Menu.Item onSelect={() => revoke(machine)}>{copy.machines.revoke}</Menu.Item>
                        </Menu.Content>
                      </Menu.Portal>
                    </Menu>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </section>
  )
}

/** Every machine of the hub with its owner, shown to administrators, who can revoke but not open them. */
export function AllMachines(props: { fail: Fail; revision: () => number }) {
  const dialog = useDialog()

  const [state, setState] = createStore<{
    status: "loading" | "ready" | "failed"
    list: HubAdminMachine[]
    error?: string
  }>({ status: "loading", list: [] })

  const [now, setNow] = createSignal(Date.now())
  const clock = setInterval(() => setNow(Date.now()), 30_000)
  onCleanup(() => clearInterval(clock))

  const load = () =>
    hubApi.allMachines().then(
      (list) => {
        setNow(Date.now())
        setState({ status: "ready", error: undefined })
        setState("list", reconcile(list, { key: "id" }))
      },
      (error: unknown) => {
        if (error instanceof HubError && error.status === 401) return props.fail(copy.allMachines.loadFailed, error)

        // A refresh that fails keeps the list already on screen.
        if (state.status === "ready") return props.fail(copy.allMachines.loadFailed, error)
        setState({ status: "failed", error: errorText(error) })
      },
    )

  // Reloads whenever the live feed of the user's own machines reports a change anywhere on the hub.
  createEffect(on(props.revision, () => void load()))

  const revoke = (machine: HubAdminMachine) =>
    void dialog.show(() => <RevokeDialog machine={machine} onDone={load} fail={props.fail} />)

  return (
    <section class="hub-section" aria-labelledby="hub-all-machines-title">
      <div class="hub-section-header">
        <div class="hub-section-heading">
          <h2 id="hub-all-machines-title" class="hub-section-title">
            {copy.allMachines.title}
          </h2>
          <p class="hub-section-description">{copy.allMachines.description}</p>
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
              <div class="hub-empty-title">{copy.allMachines.loadFailed}</div>
              <p class="hub-empty-description">{state.error}</p>
              <Button variant="neutral" size="small" onClick={() => void load()}>
                {copy.allMachines.retry}
              </Button>
            </div>
          </Match>
          <Match when={state.status === "ready" && state.list.length === 0}>
            <div class="hub-empty">
              <Icon name="monitor" class="text-v2-icon-icon-muted" />
              <div class="hub-empty-title">{copy.allMachines.empty}</div>
            </div>
          </Match>
          <Match when={state.status === "ready"}>
            <For each={state.list}>
              {(machine) => (
                <div class="hub-row">
                  <div class="hub-row-lead">
                    <span
                      class="hub-status"
                      data-online={machine.online ? "" : undefined}
                      role="img"
                      aria-label={machine.online ? copy.machines.online : copy.machines.offline}
                    />
                    <div class="hub-row-copy">
                      <span class="hub-row-name">
                        <bdi dir="auto">{machine.name}</bdi>
                      </span>
                      <span class="hub-row-meta">
                        <code dir="ltr">{machine.id}</code>
                        <span aria-hidden="true">·</span>
                        <span>
                          <bdi dir="auto">
                            {machine.owner ? copy.allMachines.owner(machine.owner) : copy.allMachines.noOwner}
                          </bdi>
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{lastSeen(machine, now())}</span>
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
                          <Menu.Item onSelect={() => revoke(machine)}>{copy.machines.revoke}</Menu.Item>
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

function lastSeen(machine: { online: boolean; lastSeenAt: number | null }, now: number) {
  if (machine.online) return copy.machines.online

  if (machine.lastSeenAt === null) return copy.machines.never
  const elapsed = machine.lastSeenAt - now
  const unit = UNITS.find((entry) => Math.abs(elapsed) >= entry.ms)
  const when = unit ? relative.format(Math.round(elapsed / unit.ms), unit.unit) : relative.format(0, "minute")

  return copy.machines.lastSeen(when)
}

function RevokeDialog(props: { machine: { id: string; name: string }; onDone?: () => void; fail: Fail }) {
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)

  const confirm = () => {
    if (busy()) return
    setBusy(true)
    hubApi.revoke(props.machine.id).then(
      () => {
        dialog.close()
        showToast({ variant: "success", title: copy.machines.revoked(props.machine.name) })
        props.onDone?.()
      },
      (error: unknown) => {
        dialog.close()
        props.fail(copy.machines.revokeFailed, error)
      },
    )
  }

  return (
    <Dialog fit>
      <DialogHeader hideClose>
        <DialogTitleGroup
          title={copy.machines.revokeTitle}
          description={copy.machines.revokeDescription(props.machine.name)}
        />
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" autofocus disabled={busy()} onClick={() => dialog.close()}>
          {copy.cancel}
        </Button>
        <Button variant="danger" disabled={busy()} onClick={confirm}>
          {copy.machines.revokeConfirm}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
