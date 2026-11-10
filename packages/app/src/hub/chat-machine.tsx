import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { Loader } from "@opencode/ui/loader"
import { Menu } from "@opencode/ui/menu"
import { TextInput } from "@opencode/ui/text-input"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { errorText, hubApi, type HubChatTarget, type HubMachine } from "./api"
import { copy } from "./copy"

/** The last folder of a path, which names the project in the composer. */
export const projectName = (directory: string) => directory.replace(/\/+$/, "").split("/").at(-1) || directory

/** The hub's entries in the composer's + menu: one of the user's machines, connected ones first, then the cloud. */
export function AttachMenuItems(props: {
  machines: readonly HubMachine[]
  onOpen: () => void
  onPick: (target: HubChatTarget) => void
}) {
  const dialog = useDialog()
  const sorted = createMemo(() =>
    props.machines.toSorted((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
  )
  const open = (machine: HubMachine) =>
    dialog.show(() => (
      <ProjectDialog
        machine={machine}
        onPick={(directory) => {
          dialog.close()
          props.onPick({ machine: machine.id, machineName: machine.name, directory, online: true })
        }}
      />
    ))

  return (
    <>
      <Menu.Sub gutter={4} overflowPadding={16} overlap onOpenChange={(value) => value && props.onOpen()}>
        <Menu.SubTrigger>{copy.attach.machine}</Menu.SubTrigger>
        <Menu.Portal>
          <Menu.SubContent class="hub-chat-machines">
            <Show when={sorted().length > 0} fallback={<Menu.Item disabled>{copy.attach.noMachines}</Menu.Item>}>
              <For each={sorted()}>
                {(machine) => (
                  <Menu.Item disabled={!machine.online} onSelect={() => open(machine)}>
                    <span class="hub-status" data-online={machine.online ? "" : undefined} aria-hidden="true" />
                    <span class="hub-chat-machine-name">{machine.name}</span>
                    <Show when={!machine.online}>
                      <span class="hub-chat-machine-state">{copy.machines.offline}</span>
                    </Show>
                  </Menu.Item>
                )}
              </For>
            </Show>
          </Menu.SubContent>
        </Menu.Portal>
      </Menu.Sub>
      <Menu.Item disabled badge={copy.attach.soon}>
        {copy.attach.cloud}
      </Menu.Item>
    </>
  )
}

/** Picks a project already known to the machine, or browses its folders to open another, creating one if needed. */
function ProjectDialog(props: { machine: HubMachine; onPick: (directory: string) => void }) {
  const [browsing, setBrowsing] = createSignal(false)
  const [projects] = createResource(() => hubApi.chatProjects(props.machine.id))
  const failed = () => (projects.error ? errorText(projects.error) : undefined)
  const showBrowser = () => browsing() || (projects.state === "ready" && (projects() ?? []).length === 0)

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup
          title={copy.attach.dialogTitle(props.machine.name)}
          description={copy.attach.dialogDescription}
        />
      </DialogHeader>
      <Show when={!showBrowser()} fallback={<FolderBrowser machine={props.machine.id} onPick={props.onPick} />}>
        <DialogBody class="hub-dialog-body">
          <Show when={failed()}>{(message) => <p class="hub-chat-picker-error">{message()}</p>}</Show>
          <Show when={!projects.loading} fallback={<Loader class="size-4 text-v2-icon-icon-muted" />}>
            <div class="hub-chat-picker-list">
              <For each={projects() ?? []}>
                {(project) => (
                  <button type="button" class="hub-chat-picker-row" onClick={() => props.onPick(project.directory)}>
                    <Icon name="folder" />
                    <span class="hub-chat-picker-text">
                      <span>{project.name}</span>
                      <span class="hub-chat-picker-path">{project.directory}</span>
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" icon="plus" onClick={() => setBrowsing(true)}>
            {copy.attach.newProject}
          </Button>
        </DialogFooter>
      </Show>
    </Dialog>
  )
}

function FolderBrowser(props: { machine: string; onPick: (directory: string) => void }) {
  const [path, setPath] = createSignal<string | undefined>(undefined)
  const [listing] = createResource(
    () => ({ path: path() }),
    (source) => hubApi.chatDirectories(props.machine, source.path),
  )
  const [naming, setNaming] = createSignal(false)
  const [name, setName] = createSignal("")
  const [problem, setProblem] = createSignal<string>()
  const current = () => listing.latest
  const go = (next: string) => {
    setProblem(undefined)
    setNaming(false)
    setPath(next)
  }
  const join = (parent: string, child: string) => `${parent.replace(/\/+$/, "")}/${child}`
  const create = async () => {
    const parent = current()?.directory
    const folder = name().trim()
    if (!parent || !folder) return
    const created = await hubApi.createChatDirectory(props.machine, parent, folder).catch((error: unknown) => {
      setProblem(errorText(error))
      return undefined
    })
    if (!created) return
    setName("")
    setNaming(false)
    go(created.directory)
  }

  return (
    <>
      <DialogBody class="hub-dialog-body">
        <div class="hub-chat-picker-toolbar">
          <span class="hub-chat-picker-current" title={current()?.directory}>
            <bdi dir="ltr">{current()?.directory ?? ""}</bdi>
          </span>
          <Button variant="outline" size="small" icon="plus" onClick={() => setNaming(true)}>
            {copy.attach.newFolder}
          </Button>
        </div>
        <Show when={naming()}>
          <form
            class="hub-chat-picker-new"
            onSubmit={(event) => {
              event.preventDefault()
              void create()
            }}
          >
            <TextInput
              autofocus
              value={name()}
              placeholder={copy.attach.folderName}
              aria-label={copy.attach.folderName}
              onInput={(event) => setName(event.currentTarget.value)}
            />
            <Button type="submit" variant="contrast" size="small" disabled={!name().trim()}>
              {copy.attach.create}
            </Button>
          </form>
        </Show>
        <Show when={problem() ?? (listing.error ? errorText(listing.error) : undefined)}>
          {(message) => <p class="hub-chat-picker-error">{message()}</p>}
        </Show>
        <Show when={current()} fallback={<Loader class="size-4 text-v2-icon-icon-muted" />}>
          {(folder) => (
            <div class="hub-chat-picker-list">
              <Show when={folder().parent}>
                {(parent) => (
                  <button type="button" class="hub-chat-picker-row" onClick={() => go(parent())}>
                    <Icon name="arrow-left" />
                    <span>{copy.attach.parent}</span>
                  </button>
                )}
              </Show>
              <For each={folder().directories} fallback={<p class="hub-chat-picker-empty">{copy.attach.noFolders}</p>}>
                {(child) => (
                  <button type="button" class="hub-chat-picker-row" onClick={() => go(join(folder().directory, child))}>
                    <Icon name="folder" />
                    <span>{child}</span>
                  </button>
                )}
              </For>
            </div>
          )}
        </Show>
      </DialogBody>
      <DialogFooter>
        <Button
          variant="contrast"
          disabled={!current()}
          onClick={() => {
            const directory = current()?.directory
            if (directory) props.onPick(directory)
          }}
        >
          {copy.attach.open}
        </Button>
      </DialogFooter>
    </>
  )
}
