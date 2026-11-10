import type { ModelInfo } from "@opencode/client/promise"
import { useDialog } from "@opencode/ui/context/dialog"
import { Loader } from "@opencode/ui/loader"
import { Select } from "@opencode/ui/select"
import { showToast } from "@opencode/ui/toast"
import { uuid } from "@opencode/util/uuid"
import { makeEventListener } from "@solid-primitives/event-listener"
import { Skill } from "@opencode/schema/skill"
import { createEffect, createSignal, on, onMount, Show } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"
import { parseSlashCommand } from "@/composer/client-slash-command"
import { ComposerEditor } from "@/composer/editor/editor"
import { createComposerEditor } from "@/composer/editor/interaction"
import { clonePrompt, promptLength } from "@/composer/prompt-parts"
import type { ComposerPersistedState, ComposerSuggestion } from "@/composer/types"
import { hubApi, type HubChatTarget, type HubMachine, type HubMachineCommand } from "./api"
import type { HubClientCommand, HubComposerActions, HubSkillOption } from "./chat-commands"
import { AttachMenuItems } from "./chat-machine"
import { copy } from "./copy"
import { modelKey } from "./models"

/** What a send asks for: a prompt to the hub's model, or a command or shell line run on the attached machine. */
export type HubSubmit =
  | {
      type: "prompt"
      text: string
      files: { uri: string; mime: string; name: string }[]
      /** Names of the skills the prompt loads. */
      skills?: string[]
    }
  | { type: "command"; name: string; arguments: string }
  | { type: "shell"; command: string }

const IS_MAC = typeof navigator !== "undefined" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform)
const EMPTY_PROMPT = [{ type: "text" as const, content: "", start: 0, end: 0 }]

/** OpenCode's composer, wired to the hub: its models, the attached machine's commands and files, and image attachments. */
export function HubComposer(props: {
  store: [Store<ComposerPersistedState>, SetStoreFunction<ComposerPersistedState>]
  models: ModelInfo[]
  modelsLoading: boolean
  model: ModelInfo | undefined
  onModel: (model: ModelInfo | null) => void
  variant: string
  onVariant: (variant: string) => void
  target: HubChatTarget | undefined
  commands: HubMachineCommand[]
  clientCommands: HubClientCommand[]
  skills: HubSkillOption[]
  searchFiles: (query: string) => Promise<string[]>
  machines: readonly HubMachine[]
  onMachinesOpen: () => void
  onAttach: (target: HubChatTarget) => void
  placeholder: string
  working: boolean
  onSubmit: (request: HubSubmit) => Promise<boolean>
  onStop: () => void
  onError: (error: unknown) => void
}) {
  const dialog = useDialog()
  const [state, setState] = props.store
  const input = (kind: string) => props.model?.capabilities.input.includes(kind) ?? false
  const [modelOpen, setModelOpen] = createSignal(false)
  // The popover closes and focuses the editor first; opening the menu in the same frame would close it again.
  const actions: HubComposerActions = { openModel: () => requestAnimationFrame(() => setModelOpen(true)) }

  // The machine's commands as last read when the `/` popover opened, so a command added there shows up without a reload.
  const [fresh, setFresh] = createSignal<{ key: HubChatTarget; data: HubMachineCommand[] }>()
  const machineCommands = () => {
    const read = fresh()
    return read && read.key === props.target ? read.data : props.commands
  }
  // Without a machine, its commands, files and shell are out of reach; the hub's commands and skills remain.
  const clientNames = () => new Set(props.clientCommands.map((item) => item.name))
  const skillSuggestion = (skill: HubSkillOption, prefix: "/" | "@"): ComposerSuggestion => ({
    id: `skill:${prefix}${skill.name}`,
    kind: "skill",
    label: `${prefix}${skill.name}`,
    trigger: skill.name,
    title: skill.name,
    description: skill.description,
    mention: {
      type: "skill",
      id: Skill.ID.make(skill.name),
      name: Skill.Name.make(skill.name),
      content: `@${skill.name}`,
      start: 0,
      end: 0,
    },
  })

  const submit = () => {
    const prompt = clonePrompt(state.prompt)
    const text = prompt
      .flatMap((part) => ("content" in part ? [part.content] : []))
      .join("")
      .trim()
    const files = prompt.flatMap((part) =>
      part.type === "image" && part.blob.url?.startsWith("data:")
        ? [{ uri: part.blob.url, mime: part.mime, name: part.filename }]
        : [],
    )
    if (!text && files.length === 0) return
    const clear = () => setState({ prompt: EMPTY_PROMPT.map((part) => ({ ...part })), cursor: 0 })
    const slash = state.mode === "shell" ? undefined : parseSlashCommand(text)
    // The hub's own commands win, then the machine's, then a skill of that name, which loads it for the prompt.
    const client = slash && props.clientCommands.find((item) => item.name === slash.name)
    if (client) {
      clear()
      return client.run(actions)
    }
    const command =
      slash && props.target && machineCommands().some((item) => item.name === slash.name)
        ? { type: "command" as const, name: slash.name, arguments: slash.input }
        : undefined
    const typed = slash && !command && props.skills.some((item) => item.name === slash.name) ? [slash.name] : []
    const skills = [
      ...new Set([...prompt.flatMap((part) => (part.type === "skill" ? [String(part.name)] : [])), ...typed]),
    ]
    const request: HubSubmit =
      state.mode === "shell"
        ? { type: "shell", command: text }
        : (command ?? { type: "prompt", text, files, skills: skills.length > 0 ? skills : undefined })
    clear()
    void props.onSubmit(request).then((sent) => {
      if (!sent) setState({ prompt, cursor: promptLength(prompt) })
    })
  }

  const editor = createComposerEditor({
    store: props.store,
    commands: () => {
      const machine = props.target ? machineCommands().filter((item) => !clientNames().has(item.name)) : []
      const taken = new Set([...clientNames(), ...machine.map((item) => item.name)])
      return [
        ...props.clientCommands.map((item) => ({
          id: `client.${item.name}`,
          kind: "command" as const,
          label: `/${item.name}`,
          trigger: item.name,
          title: item.name,
          description: item.description,
        })),
        ...machine.map((item) => ({
          id: `command.${item.name}`,
          kind: "command" as const,
          label: `/${item.name}`,
          trigger: item.name,
          title: item.name,
          description: item.description,
        })),
        ...props.skills.filter((item) => !taken.has(item.name)).map((item) => skillSuggestion(item, "/")),
      ]
    },
    context: () => props.skills.map((item) => skillSuggestion(item, "@")),
    onSuggestionSelect: (item) => {
      if (item.kind !== "command" || !item.id.startsWith("client.")) return
      const selected = props.clientCommands.find((entry) => `client.${entry.name}` === item.id)
      if (selected) return () => selected.run(actions)
    },
    searchContextFiles: (query) =>
      props.target
        ? props.searchFiles(query).then((paths) =>
            paths.map((path) => ({
              id: `file:${path}`,
              kind: "file" as const,
              label: path,
              path,
              mention: { type: "file" as const, path, content: `@${path}`, start: 0, end: 0 },
            })),
          )
        : [],
    view: {
      placeholder: () => props.placeholder,
      variant: {
        options: () =>
          ["default", ...(props.model?.variants ?? []).map((item) => item.id)].map((id) => ({ id, label: id })),
        current: () => props.variant,
        onSelect: props.onVariant,
      },
      submit: {
        stopping: () => props.working,
        working: () => props.working,
        onSubmit: submit,
        onStop: props.onStop,
      },
    },
    attachments: {
      directory: () => "",
      destination: () => ({
        input: { image: input("image"), pdf: input("pdf") },
        local: false,
        // Only media the model reads travels with a prompt; anything else would need a server to hold it.
        upload: () => Promise.reject(new Error(copy.chat.attachRejected)),
      }),
      isDialogActive: () => !!dialog.active,
      duplicate: () => {},
      onError: props.onError,
      onUploadError: () => showToast({ variant: "error", title: copy.chat.attachRejected }),
      store: (file) => readDataUrl(file).then((url) => ({ id: uuid(), url })),
    },
  })

  // Files and the shell live on a machine: without one, `!` stays plain text and `@` offers only skills.
  createEffect(() => {
    if (props.target) return
    if (state.mode === "shell")
      setState({ mode: "normal", prompt: [{ type: "text", content: "!", start: 0, end: 1 }], cursor: 1 })
    if (editor.state.popover.type === "context" && props.skills.length === 0) editor.dispatch({ type: "popover.close" })
  })

  createEffect(
    on(
      () => editor.state.popover.type === "command-inline" || editor.state.popover.type === "command-menu",
      (open) => {
        const attached = props.target
        if (!open || !attached) return
        void hubApi.machineCommands(attached.machine, attached.directory).then(
          (data) => setFresh({ key: attached, data }),
          () => {},
        )
      },
    ),
  )

  onMount(() => {
    editor.restoreFocus()
    makeEventListener(document, "keydown", (event) => {
      if (!(IS_MAC ? event.metaKey : event.ctrlKey) || event.shiftKey || event.altKey) return
      if (event.key.toLowerCase() !== "u" || dialog.active) return
      event.preventDefault()
      editor.attach()
    })
  })

  return (
    <ComposerEditor
      controller={editor}
      attachKeybind={[IS_MAC ? "⌘" : "Ctrl", "U"]}
      attachShortcut={IS_MAC ? "⌘U" : "Ctrl+U"}
      addMenuUnavailable={
        props.target ? undefined : { context: props.skills.length === 0, shell: true, reason: copy.attach.needsMachine }
      }
      addMenuExtra={<AttachMenuItems machines={props.machines} onOpen={props.onMachinesOpen} onPick={props.onAttach} />}
      modelControl={
        <Show
          when={props.models.length > 0}
          fallback={
            <Show when={props.modelsLoading}>
              <Loader class="mx-2 size-4 text-v2-icon-icon-muted" />
            </Show>
          }
        >
          <Select
            class="hub-chat-model"
            appearance="small"
            surface="invisible"
            options={props.models}
            current={props.model}
            value={modelKey}
            label={(item) => `${item.providerID} / ${item.name}`}
            groupBy={(item) => item.providerID}
            onSelect={props.onModel}
            open={modelOpen()}
            onOpenChange={setModelOpen}
          >
            {(item) => item.name}
          </Select>
        </Show>
      }
    />
  )
}

function readDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
