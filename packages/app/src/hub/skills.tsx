import { Badge } from "@opencode/ui/badge"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Loader } from "@opencode/ui/loader"
import { Menu } from "@opencode/ui/menu"
import { TextInput } from "@opencode/ui/text-input"
import { Textarea } from "@opencode/ui/textarea"
import { showToast } from "@opencode/ui/toast"
import { createSignal, For, type JSX, Match, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { errorText, hubApi, HubError, type HubOrg, type HubSkill, type HubSkills, type SkillDraft } from "./api"
import { copy } from "./copy"
import type { Fail } from "./dashboard"

const ENTRY = "SKILL.md"

// The same frontmatter block the hub reads (`@opencode/relay/skills`), to edit the markdown body on its own.
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const MAX_NAME = 64

/** The user's own skills, which they manage, then the ones their organizations give them, read-only. */
export function Skills(props: { fail: Fail }) {
  const dialog = useDialog()

  const [state, setState] = createStore<{ status: "loading" | "ready" | "failed"; data?: HubSkills; error?: string }>({
    status: "loading",
  })

  const load = () =>
    hubApi.skills().then(
      (data) => setState({ status: "ready", data, error: undefined }),
      (error: HubError) => {
        if (error instanceof HubError && error.status === 401) return props.fail(copy.skills.loadFailed, error)

        // A refresh that fails keeps the list already on screen.
        if (state.status === "ready") return props.fail(copy.skills.loadFailed, error)
        setState({ status: "failed", error: errorText(error) })
      },
    )

  onMount(() => void load())

  const edit = (skill?: HubSkill) =>
    void dialog.show(() => (
      <SkillDialog
        initial={skill}
        save={(draft) => hubApi.saveSkill(draft, skill?.id)}
        onDone={load}
        fail={props.fail}
      />
    ))

  const view = (skill: HubSkill) => void dialog.show(() => <SkillDialog initial={skill} fail={props.fail} />)

  const remove = (skill: HubSkill) =>
    void dialog.show(() => (
      <DeleteSkillDialog
        skill={skill}
        description={copy.skills.deleteDescription(skill.name)}
        remove={() => hubApi.deleteSkill(skill.id)}
        onDone={load}
        fail={props.fail}
      />
    ))

  return (
    <section class="hub-section" aria-labelledby="hub-skills-title">
      <div class="hub-section-header">
        <div class="hub-section-heading">
          <h2 id="hub-skills-title" class="hub-section-title">
            {copy.skills.title}
          </h2>
          <p class="hub-section-description">{copy.skills.description}</p>
        </div>
        <Button variant="neutral" size="small" icon="plus" onClick={() => edit()} disabled={state.status !== "ready"}>
          {copy.skills.create}
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
              <div class="hub-empty-title">{copy.skills.loadFailed}</div>
              <p class="hub-empty-description">{state.error}</p>
              <Button variant="neutral" size="small" onClick={() => void load()}>
                {copy.skills.retry}
              </Button>
            </div>
          </Match>
          <Match when={state.data?.own.length === 0}>
            <div class="hub-empty">
              <div class="hub-empty-title">{copy.skills.empty}</div>
              <p class="hub-empty-description">{copy.skills.emptyDescription}</p>
            </div>
          </Match>
          <Match when={state.data}>
            {(data) => (
              <For each={data().own}>
                {(skill) => (
                  <SkillRow skill={skill} hiddenBy={skill.hiddenBy}>
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
                          <Menu.Item onSelect={() => edit(skill)}>{copy.skills.edit}</Menu.Item>
                          <Menu.Item onSelect={() => remove(skill)}>{copy.skills.delete}</Menu.Item>
                        </Menu.Content>
                      </Menu.Portal>
                    </Menu>
                  </SkillRow>
                )}
              </For>
            )}
          </Match>
        </Switch>
      </div>
      <Show when={(state.data?.inherited.length ?? 0) > 0}>
        <div class="hub-section-heading">
          <h3 class="hub-section-title">{copy.skills.inherited}</h3>
          <p class="hub-section-description">{copy.skills.inheritedDescription}</p>
        </div>
        <div class="hub-list">
          <For each={state.data?.inherited}>
            {(skill) => (
              <SkillRow skill={skill} org={skill.org.name} hiddenBy={skill.hiddenBy}>
                <Button variant="neutral" size="small" onClick={() => view(skill)}>
                  {copy.skills.view}
                </Button>
              </SkillRow>
            )}
          </For>
        </div>
      </Show>
    </section>
  )
}

/** An organization's skills, for hub administrators: listed in a dialog opened from the Organizations section. */
export function OrgSkillsDialog(props: { org: HubOrg; fail: Fail }) {
  const dialog = useDialog()
  const [state, setState] = createStore<{ loaded: boolean; list: HubSkill[] }>({ loaded: false, list: [] })

  const load = () =>
    hubApi.orgSkills(props.org.id).then(
      (list) => setState({ loaded: true, list }),
      (error: HubError) => {
        dialog.close()
        props.fail(copy.skills.loadFailed, error)
      },
    )

  onMount(() => void load())

  const edit = (skill?: HubSkill) =>
    void dialog.push(() => (
      <SkillDialog
        initial={skill}
        save={(draft) => hubApi.saveOrgSkill(props.org.id, draft, skill?.id)}
        onDone={load}
        fail={props.fail}
      />
    ))

  const remove = (skill: HubSkill) =>
    void dialog.push(() => (
      <DeleteSkillDialog
        skill={skill}
        description={copy.skills.orgDeleteDescription(skill.name)}
        remove={() => hubApi.deleteOrgSkill(props.org.id, skill.id)}
        onDone={load}
        fail={props.fail}
      />
    ))

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup title={copy.skills.orgTitle(props.org.name)} description={copy.skills.orgDescription} />
      </DialogHeader>
      <DialogBody class="hub-dialog-body">
        <div class="hub-list">
          <Show
            when={state.loaded}
            fallback={
              <div class="hub-list-placeholder">
                <Loader class="size-4 text-v2-icon-icon-muted" />
              </div>
            }
          >
            <Show
              when={state.list.length > 0}
              fallback={
                <div class="hub-empty">
                  <div class="hub-empty-title">{copy.skills.empty}</div>
                </div>
              }
            >
              <For each={state.list}>
                {(skill) => (
                  <SkillRow skill={skill} hiddenBy={null}>
                    <Button variant="neutral" size="small" onClick={() => edit(skill)}>
                      {copy.skills.edit}
                    </Button>
                    <IconButton
                      variant="ghost-muted"
                      size="small"
                      icon={<Icon name="outline-trash" />}
                      aria-label={copy.skills.delete}
                      onClick={() => remove(skill)}
                    />
                  </SkillRow>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="neutral" icon="plus" disabled={!state.loaded} onClick={() => edit()}>
          {copy.skills.create}
        </Button>
        <Button variant="contrast" onClick={() => dialog.close()}>
          {copy.done}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

function SkillRow(props: { skill: HubSkill; org?: string; hiddenBy: string | null; children: JSX.Element }) {
  return (
    <div class="hub-row">
      <div class="hub-row-lead">
        <div class="hub-row-copy">
          <span class="hub-row-name">
            <code dir="ltr">{props.skill.name}</code>
            <Show when={props.hiddenBy}>
              <Badge variant="subtle">{copy.skills.hidden}</Badge>
            </Show>
          </span>
          <span class="hub-row-meta">
            <Show when={props.org}>
              {(org) => (
                <>
                  <span>{copy.skills.fromOrg(org())}</span>
                  <span aria-hidden="true">·</span>
                </>
              )}
            </Show>
            <span>{copy.skills.files(props.skill.files.length)}</span>
            <span aria-hidden="true">·</span>
            <span class="hub-row-url">
              <bdi dir="auto">{props.skill.description}</bdi>
            </span>
          </span>
          <Show when={props.hiddenBy}>
            {(name) => <span class="hub-row-meta">{copy.skills.hiddenBy(name())}</span>}
          </Show>
        </div>
      </div>
      <div class="hub-row-actions">{props.children}</div>
    </div>
  )
}

/**
 * Creates or edits a skill: its name, its description and the body of SKILL.md, plus other text files. Without `save`
 * it only shows the skill (an organization's, for a member).
 */
function SkillDialog(props: {
  initial?: HubSkill
  save?: (draft: SkillDraft) => Promise<object>
  onDone?: () => void
  fail: Fail
}) {
  const dialog = useDialog()
  const entry = props.initial?.files.find((file) => file.path === ENTRY)?.content ?? ""

  const [form, setForm] = createStore<{
    name: string
    description: string
    body: string
    files: { path: string; content: string }[]
    busy: boolean
    error?: string
  }>({
    name: props.initial?.name ?? "",
    description: props.initial?.description ?? "",
    body: entry.replace(FRONTMATTER, "").replace(/^\r?\n/, ""),
    files: (props.initial?.files ?? []).filter((file) => file.path !== ENTRY),
    busy: false,
  })

  const readOnly = () => !props.save || form.busy
  const valid = () => NAME.test(form.name.trim()) && form.name.trim().length <= MAX_NAME && form.description.trim()

  const submit = (event: SubmitEvent) => {
    event.preventDefault()

    const save = props.save

    if (!save || form.busy || !valid()) return

    const name = form.name.trim()

    setForm({ busy: true, error: undefined })
    // JSON strings are valid YAML double-quoted scalars, so any description round-trips.
    const content = `---\nname: ${name}\ndescription: ${JSON.stringify(form.description.trim())}\n---\n\n${form.body}`
    save({
      name,
      files: [{ path: ENTRY, content }, ...form.files.map((file) => ({ ...file, path: file.path.trim() }))],
    }).then(
      () => {
        dialog.close()
        showToast({ variant: "success", title: copy.skills.saved(name) })
        props.onDone?.()
      },
      (error: HubError) => {
        if (error instanceof HubError && error.status === 401) {
          dialog.close()

          return props.fail(copy.skills.actionFailed, error)
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
              ? copy.skills.viewTitle(props.initial?.name ?? "")
              : props.initial
                ? copy.skills.editTitle
                : copy.skills.createTitle
          }
          description={props.save ? copy.skills.formDescription : copy.skills.inheritedDescription}
        />
      </DialogHeader>
      <form onSubmit={submit} class="contents">
        <DialogBody class="hub-dialog-body">
          <div class="hub-stack">
            <div class="hub-field">
              <label for="hub-skill-name">{copy.skills.name}</label>
              <TextInput
                id="hub-skill-name"
                appearance="large"
                autofocus={!!props.save}
                maxLength={MAX_NAME}
                value={form.name}
                readOnly={readOnly()}
                aria-describedby="hub-skill-name-hint"
                onInput={(event) => setForm({ name: event.currentTarget.value, error: undefined })}
              />
              <p id="hub-skill-name-hint" class="hub-hint">
                {copy.skills.nameHint}
              </p>
            </div>
            <div class="hub-field">
              <label for="hub-skill-description">{copy.skills.descriptionLabel}</label>
              <TextInput
                id="hub-skill-description"
                appearance="large"
                maxLength={1024}
                value={form.description}
                readOnly={readOnly()}
                aria-describedby="hub-skill-description-hint"
                onInput={(event) => setForm({ description: event.currentTarget.value, error: undefined })}
              />
              <p id="hub-skill-description-hint" class="hub-hint">
                {copy.skills.descriptionHint}
              </p>
            </div>
            <div class="hub-field">
              <label for="hub-skill-body">{copy.skills.body}</label>
              <Textarea
                class="w-full"
                id="hub-skill-body"
                rows={10}
                value={form.body}
                readOnly={readOnly()}
                aria-describedby="hub-skill-body-hint"
                onInput={(event) => setForm({ body: event.currentTarget.value, error: undefined })}
              />
              <p id="hub-skill-body-hint" class="hub-hint">
                {copy.skills.bodyHint}
              </p>
            </div>
            <div class="hub-step">
              <span class="hub-step-title">{copy.skills.extraFiles}</span>
              <p class="hub-hint">{copy.skills.extraFilesHint}</p>
              <For each={form.files}>
                {(file, index) => (
                  <div class="hub-stack-tight">
                    <div class="hub-code-row">
                      <TextInput
                        aria-label={copy.skills.path}
                        placeholder={copy.skills.path}
                        value={file.path}
                        readOnly={readOnly()}
                        onInput={(event) => setForm("files", index(), "path", event.currentTarget.value)}
                      />
                      <Show when={props.save}>
                        <IconButton
                          type="button"
                          variant="ghost-muted"
                          size="small"
                          icon={<Icon name="outline-trash" />}
                          aria-label={copy.skills.removeFile}
                          disabled={form.busy}
                          onClick={() => setForm("files", (files) => files.filter((_, at) => at !== index()))}
                        />
                      </Show>
                    </div>
                    <Textarea
                      class="w-full"
                      aria-label={copy.skills.content}
                      rows={4}
                      value={file.content}
                      readOnly={readOnly()}
                      onInput={(event) => setForm("files", index(), "content", event.currentTarget.value)}
                    />
                  </div>
                )}
              </For>
              <Show when={props.save}>
                <div>
                  <Button
                    type="button"
                    variant="neutral"
                    size="small"
                    icon="plus"
                    disabled={form.busy}
                    onClick={() => setForm("files", (files) => [...files, { path: "", content: "" }])}
                  >
                    {copy.skills.addFile}
                  </Button>
                </div>
              </Show>
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
              {form.busy ? copy.skills.saving : copy.skills.save}
            </Button>
          </Show>
        </DialogFooter>
      </form>
    </Dialog>
  )
}

function DeleteSkillDialog(props: {
  skill: HubSkill
  description: string
  remove: () => Promise<void>
  onDone: () => void
  fail: Fail
}) {
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)

  const confirm = () => {
    if (busy()) return
    setBusy(true)
    props.remove().then(
      () => {
        dialog.close()
        showToast({ variant: "success", title: copy.skills.deleted(props.skill.name) })
        props.onDone()
      },
      (error: HubError) => {
        dialog.close()
        props.fail(copy.skills.actionFailed, error)
      },
    )
  }

  return (
    <Dialog fit>
      <DialogHeader hideClose>
        <DialogTitleGroup title={copy.skills.deleteTitle} description={props.description} />
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" autofocus disabled={busy()} onClick={() => dialog.close()}>
          {copy.cancel}
        </Button>
        <Button variant="danger" disabled={busy()} onClick={confirm}>
          {copy.skills.deleteConfirm}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
