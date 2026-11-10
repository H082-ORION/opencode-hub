import { useLanguage } from "@/runtime/i18n/language"
import { Markdown } from "@opencode/session-ui/markdown"
import { Badge } from "@opencode/ui/badge"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Loader } from "@opencode/ui/loader"
import { Switch } from "@opencode/ui/switch"
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { CommandLine } from "./add-machine"
import { errorText, HubError, hubApi, type HubRelease, type HubUpdates } from "./api"
import { copy } from "./copy"
import type { Fail } from "./dashboard"

const DISMISSED_KEY = "hub.updates.dismissed"
const POLL = 2000
const MANUAL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/H082-ORION/opencode-hub/remote-machines/install.sh | bash"

const tag = (version: string) => `v${version}`

/** The settings page: the running version, the stable update and, on request, the development versions. */
export function UpdatesSettings(props: { fail: Fail }) {
  const language = useLanguage()
  const dialog = useDialog()
  const [updates, setUpdates] = createSignal<HubUpdates>()
  const [checking, setChecking] = createSignal(false)
  const [restarting, setRestarting] = createSignal(false)
  const [showDev, setShowDev] = createSignal(false)

  const day = () => new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium" })
  const moment = () => new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium", timeStyle: "short" })

  onMount(() => void hubApi.updates().then(setUpdates, (error: unknown) => props.fail(copy.updates.checkFailed, error)))

  const check = () => {
    if (checking()) return
    setChecking(true)
    hubApi
      .checkUpdates()
      .then(setUpdates, (error: unknown) => props.fail(copy.updates.checkFailed, error))
      .finally(() => setChecking(false))
  }

  // An update in progress, whoever started it: follow it until the hub runs the new version.
  const target = () => installing(updates())
  createEffect(
    on(target, (version) => {
      if (!version) return
      const timer = setInterval(
        () =>
          hubApi.updates().then(
            (next) => {
              if (next.current === version) return location.reload()
              setRestarting(false)
              setUpdates(next)
            },
            // The hub cannot answer while it restarts, then has forgotten the sign-in: reloading lands on the login.
            (error: unknown) =>
              error instanceof HubError && error.status === 401 ? location.reload() : setRestarting(true),
          ),
        POLL,
      )
      onCleanup(() => clearInterval(timer))
    }),
  )

  const install = (release: HubRelease) =>
    void dialog.show(() => <InstallDialog release={release} onUpdates={setUpdates} />)

  return (
    <>
      <section class="hub-section" aria-labelledby="hub-updates-title">
        <div class="hub-section-header">
          <div class="hub-section-heading">
            <h2 id="hub-updates-title" class="hub-section-title">
              {copy.updates.title}
            </h2>
            <p class="hub-section-description">{copy.updates.description}</p>
          </div>
          <div class="hub-section-actions">
            <Button variant="neutral" size="small" icon="reset" disabled={checking() || !updates()} onClick={check}>
              {checking() ? copy.updates.checking : copy.updates.check}
            </Button>
          </div>
        </div>
        <Show
          when={updates()}
          fallback={
            <div class="hub-list">
              <div class="hub-list-placeholder">
                <Loader class="size-4 text-v2-icon-icon-muted" />
              </div>
            </div>
          }
        >
          {(data) => (
            <>
              <div class="hub-list">
                <div class="hub-row">
                  <div class="hub-row-lead">
                    <div class="hub-row-copy">
                      <span class="hub-row-name">
                        <bdi dir="ltr">{tag(data().current)}</bdi>
                        <Show when={data().development}>
                          <Badge variant="subtle">{copy.updates.local}</Badge>
                        </Show>
                      </span>
                      <span class="hub-row-meta">
                        <span>{copy.updates.current}</span>
                        <span aria-hidden="true">·</span>
                        <span class="hub-row-url">
                          {(() => {
                            const at = data().checkedAt
                            return at === null ? copy.updates.neverChecked : copy.updates.checkedAt(moment().format(at))
                          })()}
                        </span>
                      </span>
                      <Show when={data().error}>
                        {(error) => (
                          <span class="hub-update-text hub-update-failed">{copy.updates.checkError(error())}</span>
                        )}
                      </Show>
                      <Show when={data().development}>
                        <span class="hub-update-text">{copy.updates.localDescription}</span>
                      </Show>
                    </div>
                  </div>
                </div>
                <Show when={target()}>
                  {(version) => (
                    <div class="hub-row" role="status">
                      <div class="hub-row-lead">
                        <Loader class="size-4 shrink-0 text-v2-icon-icon-muted" />
                        <div class="hub-row-copy">
                          <span class="hub-row-name">
                            {progressTitle(data().status.state, tag(version()), restarting())}
                          </span>
                          <span class="hub-update-text">{data().status.message || copy.updates.progressHint}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </Show>
                <Show when={failure(data())}>
                  {(status) => (
                    <div class="hub-row" role="alert">
                      <div class="hub-row-copy">
                        <span class="hub-row-name hub-update-failed">{copy.updates.failed(tag(status().version))}</span>
                        <span class="hub-update-text">{status().message || copy.updates.failedHint}</span>
                      </div>
                    </div>
                  )}
                </Show>
                <Show
                  when={data().stable}
                  fallback={
                    <div class="hub-row">
                      <div class="hub-row-copy">
                        <span class="hub-row-name">{copy.updates.upToDate}</span>
                        <span class="hub-update-text">{copy.updates.upToDateDescription}</span>
                      </div>
                    </div>
                  }
                >
                  {(release) => (
                    <div class="hub-row">
                      <div class="hub-row-lead">
                        <div class="hub-row-copy">
                          <span class="hub-row-name">{copy.updates.available(tag(release().version))}</span>
                          <span class="hub-row-meta">
                            <span class="hub-row-url">
                              {copy.updates.published(day().format(new Date(release().publishedAt)))}
                            </span>
                          </span>
                        </div>
                      </div>
                      <div class="hub-row-actions">
                        <a class="hub-link" href={release().url} target="_blank" rel="noopener noreferrer">
                          {copy.updates.github}
                        </a>
                        <Show when={data().installer.available}>
                          <Button
                            variant="contrast"
                            size="small"
                            disabled={!!target()}
                            onClick={() => install(release())}
                          >
                            {copy.updates.update}
                          </Button>
                        </Show>
                      </div>
                    </div>
                  )}
                </Show>
              </div>
              <Show when={data().stable}>
                {(release) => (
                  <div class="hub-step">
                    <span class="hub-step-title">{copy.updates.notes}</span>
                    <ReleaseNotes release={release()} />
                  </div>
                )}
              </Show>
              <Show when={!data().installer.available}>
                <div class="hub-step">
                  <span class="hub-step-title">{copy.updates.manualTitle}</span>
                  <p class="hub-hint">{copy.updates.manualDescription}</p>
                  <CommandLine command={MANUAL_COMMAND} />
                </div>
              </Show>
            </>
          )}
        </Show>
      </section>
      <Show when={updates()}>
        {(data) => (
          <section class="hub-section" aria-labelledby="hub-updates-dev-title">
            <div class="hub-section-header">
              <div class="hub-section-heading">
                <h2 id="hub-updates-dev-title" class="hub-section-title">
                  {copy.updates.devTitle}
                </h2>
                <p class="hub-section-description">{copy.updates.devDescription}</p>
              </div>
              <div class="hub-section-actions">
                <Switch checked={showDev()} onChange={setShowDev}>
                  {copy.updates.showDev}
                </Switch>
              </div>
            </div>
            <Show when={showDev()}>
              <Show
                when={data().releases.some((release) => release.prerelease)}
                fallback={
                  <div class="hub-list">
                    <div class="hub-empty">
                      <span class="hub-empty-description">{copy.updates.devNone}</span>
                    </div>
                  </div>
                }
              >
                <div class="hub-list">
                  <For each={data().releases.filter((release) => release.prerelease)}>
                    {(release) => (
                      <div class="hub-row">
                        <div class="hub-row-lead">
                          <div class="hub-row-copy">
                            <span class="hub-row-name">
                              <bdi dir="ltr">{tag(release.version)}</bdi>
                              <Show when={data().dev?.version === release.version}>
                                <Badge variant="accent">{copy.updates.newest}</Badge>
                              </Show>
                              <Show when={data().current === release.version}>
                                <Badge variant="neutral">{copy.updates.installed}</Badge>
                              </Show>
                            </span>
                            <span class="hub-row-meta">
                              <span class="hub-row-url">
                                {copy.updates.published(day().format(new Date(release.publishedAt)))}
                              </span>
                            </span>
                          </div>
                        </div>
                        <div class="hub-row-actions">
                          <a class="hub-link" href={release.url} target="_blank" rel="noopener noreferrer">
                            {copy.updates.github}
                          </a>
                          <Show when={data().installer.available && data().current !== release.version}>
                            <Button
                              variant="neutral"
                              size="small"
                              disabled={!!target()}
                              onClick={() => install(release)}
                            >
                              {copy.updates.install}
                            </Button>
                          </Show>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
                <Show when={data().dev}>
                  {(release) => (
                    <div class="hub-step">
                      <span class="hub-step-title">
                        {copy.updates.notes} · {tag(release().version)}
                      </span>
                      <ReleaseNotes release={release()} />
                    </div>
                  )}
                </Show>
              </Show>
            </Show>
          </section>
        )}
      </Show>
    </>
  )
}

/** Offers a newer stable release to administrators once per version, on any hub page but its own settings. */
export function UpdatePrompt() {
  const dialog = useDialog()

  onMount(() => {
    if (location.pathname.startsWith("/settings/updates")) return
    // The prompt is a convenience: a hub that cannot check simply shows none.
    void hubApi.updates().then(
      (updates) => {
        const release = updates.stable
        if (!release || updates.development || installing(updates) || readDismissed() === release.version) return
        void dialog.show(
          () => <PromptDialog updates={updates} release={release} />,
          () => storeDismissed(release.version),
        )
      },
      () => undefined,
    )
  })

  return null
}

function PromptDialog(props: { updates: HubUpdates; release: HubRelease }) {
  const dialog = useDialog()

  return (
    <Dialog fit class="hub-update-dialog">
      <DialogHeader>
        <DialogTitleGroup
          title={copy.updates.promptTitle(tag(props.release.version))}
          description={copy.updates.promptDescription(tag(props.updates.current))}
        />
      </DialogHeader>
      <DialogBody class="hub-dialog-body">
        <div class="hub-stack">
          <ReleaseNotes release={props.release} />
          <Show when={!props.updates.installer.available}>
            <p class="hub-hint">{copy.updates.promptManual}</p>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => dialog.close()}>
          {copy.updates.later}
        </Button>
        <Button variant="neutral" onClick={() => location.assign("/settings/updates")}>
          {copy.updates.openSettings}
        </Button>
        <Show when={props.updates.installer.available}>
          <Button
            variant="contrast"
            onClick={() => void dialog.show(() => <InstallDialog release={props.release} confirmed />)}
          >
            {copy.updates.updateNow}
          </Button>
        </Show>
      </DialogFooter>
    </Dialog>
  )
}

type Phase = "confirm" | "starting" | "installing" | "refused" | "failed"

/**
 * Confirms an update, asks the hub to install it and follows it until the hub runs the new version, then reloads the
 * page. `confirmed` skips the confirmation, for the prompt's own "Update now".
 */
function InstallDialog(props: { release: HubRelease; confirmed?: boolean; onUpdates?: (updates: HubUpdates) => void }) {
  const dialog = useDialog()
  const [phase, setPhase] = createSignal<Phase>(props.confirmed ? "starting" : "confirm")
  const [state, setState] = createSignal<HubUpdates["status"]["state"]>("pending")
  const [message, setMessage] = createSignal<string>()
  const [restarting, setRestarting] = createSignal(false)
  const dev = () => props.release.prerelease
  const version = () => tag(props.release.version)

  const start = () => {
    setPhase("starting")
    hubApi.installUpdate(props.release.version).then(
      (updates) => {
        props.onUpdates?.(updates)
        setState(updates.status.state)
        setPhase("installing")
      },
      (error: unknown) => {
        setMessage(errorText(error))
        setPhase("refused")
      },
    )
  }

  onMount(() => {
    if (props.confirmed) start()
  })

  createEffect(
    on(phase, (current) => {
      if (current !== "installing") return
      const timer = setInterval(
        () =>
          hubApi.updates().then(
            (updates) => {
              if (updates.current === props.release.version) return location.reload()
              setRestarting(false)
              setState(updates.status.state)
              setMessage(updates.status.message)
              props.onUpdates?.(updates)
              if (updates.status.state !== "failed" || updates.status.version !== props.release.version) return
              setMessage(updates.status.message || copy.updates.failedHint)
              setPhase("failed")
            },
            // The hub cannot answer while it restarts, then has forgotten the sign-in: reloading lands on the login.
            (error: unknown) =>
              error instanceof HubError && error.status === 401 ? location.reload() : setRestarting(true),
          ),
        POLL,
      )
      onCleanup(() => clearInterval(timer))
    }),
  )

  return (
    <Dialog fit class="hub-update-dialog">
      <DialogHeader>
        <DialogTitleGroup
          title={
            phase() === "refused"
              ? copy.updates.startFailed
              : phase() === "failed"
                ? copy.updates.failed(version())
                : dev()
                  ? copy.updates.confirmDevTitle(version())
                  : copy.updates.confirmTitle(version())
          }
        />
      </DialogHeader>
      <DialogBody class="hub-dialog-body">
        <Show when={phase() === "confirm"}>
          <div class="hub-stack">
            <p class="hub-update-text">{copy.updates.confirmDescription}</p>
            <Show when={dev()}>
              <p class="hub-update-warning" role="alert">
                {copy.updates.confirmDevWarning}
              </p>
            </Show>
          </div>
        </Show>
        <Show when={phase() === "starting" || phase() === "installing"}>
          <div class="hub-update-progress" role="status">
            <Loader class="size-4 shrink-0 text-v2-icon-icon-muted" />
            <div class="hub-stack-tight">
              <span class="hub-row-name">{progressTitle(state(), version(), restarting())}</span>
              <span class="hub-update-text">{message() || copy.updates.progressHint}</span>
            </div>
          </div>
        </Show>
        <Show when={phase() === "refused" || phase() === "failed"}>
          <p class="hub-error" role="alert">
            {message()}
          </p>
        </Show>
      </DialogBody>
      <DialogFooter>
        <Show
          when={phase() === "confirm"}
          fallback={
            <Button variant="neutral" onClick={() => dialog.close()}>
              {copy.close}
            </Button>
          }
        >
          <Button variant="ghost" onClick={() => dialog.close()}>
            {copy.cancel}
          </Button>
          <Button variant={dev() ? "warning" : "contrast"} onClick={start}>
            {dev() ? copy.updates.confirmDev : copy.updates.confirm}
          </Button>
        </Show>
      </DialogFooter>
    </Dialog>
  )
}

function ReleaseNotes(props: { release: HubRelease }) {
  return (
    <div class="hub-update-notes">
      <Show when={props.release.notes.trim()} fallback={<p class="hub-hint">{copy.updates.noNotes}</p>}>
        {(notes) => <Markdown text={notes()} cacheKey={`hub-release-${props.release.tag}`} />}
      </Show>
    </div>
  )
}

/** The version an update in progress installs. */
function installing(updates: HubUpdates | undefined) {
  const status = updates?.status
  if (status?.state !== "pending" && status?.state !== "running") return
  return status.version
}

/** The last failed update, unless the hub runs that version anyway. */
function failure(updates: HubUpdates) {
  const status = updates.status
  if (status.state !== "failed" || !status.version || status.version === updates.current) return
  return { version: status.version, message: status.message }
}

function progressTitle(state: HubUpdates["status"]["state"], version: string, restarting: boolean) {
  if (restarting) return copy.updates.restarting
  if (state === "running") return copy.updates.running(version)
  return copy.updates.pending(version)
}

function readDismissed() {
  try {
    return localStorage.getItem(DISMISSED_KEY)
  } catch {
    return null
  }
}

function storeDismissed(version: string) {
  try {
    localStorage.setItem(DISMISSED_KEY, version)
  } catch {
    // Without storage, the prompt comes back on the next visit.
  }
}
