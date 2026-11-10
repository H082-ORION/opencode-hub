import type { ModelInfo } from "@opencode/client/promise"
import { useDialog } from "@opencode/ui/context/dialog"
import { Loader } from "@opencode/ui/loader"
import { Select } from "@opencode/ui/select"
import { showToast } from "@opencode/ui/toast"
import { uuid } from "@opencode/util/uuid"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createEffect, onMount, Show } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"
import { ComposerEditor } from "@/composer/editor/editor"
import { createComposerEditor } from "@/composer/editor/interaction"
import { clonePrompt, promptLength } from "@/composer/prompt-parts"
import type { ComposerPersistedState } from "@/composer/types"
import type { HubChatTarget, HubMachine, HubMachineCommand } from "./api"
import { AttachMenuItems } from "./chat-machine"
import { copy } from "./copy"
import { modelKey } from "./models"

/** What a send asks for: a prompt to the hub's model, or a command or shell line run on the attached machine. */
export type HubSubmit =
  | { type: "prompt"; text: string; files: { uri: string; mime: string; name: string }[] }
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
    const slash = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text)
    const command =
      slash && props.target && props.commands.some((item) => item.name === slash[1])
        ? { type: "command" as const, name: slash[1]!, arguments: slash[2]?.trim() ?? "" }
        : undefined
    const request: HubSubmit =
      state.mode === "shell" ? { type: "shell", command: text } : (command ?? { type: "prompt", text, files })
    if (!text && files.length === 0) return
    setState({ prompt: EMPTY_PROMPT.map((part) => ({ ...part })), cursor: 0 })
    void props.onSubmit(request).then((sent) => {
      if (!sent) setState({ prompt, cursor: promptLength(prompt) })
    })
  }

  const editor = createComposerEditor({
    store: props.store,
    commands: () =>
      props.target
        ? props.commands.map((item) => ({
            id: `command.${item.name}`,
            kind: "command" as const,
            label: `/${item.name}`,
            trigger: item.name,
            title: item.description,
          }))
        : [],
    context: () => [],
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

  // Commands, files and the shell all live on a machine: without one, `/`, `@` and `!` stay plain text.
  createEffect(() => {
    if (props.target) return
    if (state.mode === "shell")
      setState({ mode: "normal", prompt: [{ type: "text", content: "!", start: 0, end: 1 }], cursor: 1 })
    if (editor.state.popover.type === "context" || editor.state.popover.type === "command-inline")
      editor.dispatch({ type: "popover.close" })
  })

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
        props.target ? undefined : { commands: true, context: true, shell: true, reason: copy.attach.needsMachine }
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
