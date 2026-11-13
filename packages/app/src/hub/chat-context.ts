import type {
  ModelInfo,
  OpenCodeClient,
  OpenCodeEvent,
  SessionInfo,
  SessionMessageInfo,
} from "@opencode/client/promise"
import type { Data } from "@opencode/client/solid"
import type { GlobalEmitter } from "@solid-primitives/event-bus"
import { createContext, useContext, type Accessor } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"
import type { ComposerPersistedState } from "@/composer/types"
import type { HubChatTarget, HubMachine, HubSession } from "./api"
import type { TaskFeed } from "./chat-tasks"

export type ChatEventMap = { [Type in OpenCodeEvent["type"]]: Extract<OpenCodeEvent, { type: Type }> }

/** The chat screen's state and actions, shared by the sidebar, header, side panel, composer and notifications. */
export type ChatState = {
  user: HubSession["user"]
  /** The client for the hub's chat engine (`/hub/api/chat`). */
  api: OpenCodeClient
  data: Data
  /** Every event the chat engine streams. */
  emitter: GlobalEmitter<ChatEventMap>
  composer: [Store<ComposerPersistedState>, SetStoreFunction<ComposerPersistedState>]
  /** Reports a failed request; one refused for a missing session signs out instead. */
  fail: (error: unknown) => void
  signOut: () => Promise<void>

  /** The open session's ID; undefined on the new-session screen. */
  active: Accessor<string | undefined>
  current: Accessor<SessionInfo | undefined>
  /** The open session's messages; empty on the new-session screen. */
  messages: Accessor<SessionMessageInfo[]>
  /** Top-level sessions, most recently updated first. */
  sessions: Accessor<SessionInfo[]>
  /** Opens a session, or the new-session screen when undefined. */
  open: (id: string | undefined) => void
  remove: (id: string) => void
  /** Whether the hub's model is working on the open session. */
  busy: Accessor<boolean>

  models: Accessor<ModelInfo[]>
  modelsLoading: Accessor<boolean>
  /** The open session's model, or the one the next session is created with. */
  model: Accessor<ModelInfo | undefined>
  chooseModel: (model: ModelInfo | null) => void
  variant: Accessor<string>

  target: Accessor<HubChatTarget | undefined>
  /** Whether a command or shell line is running on the attached machine. */
  running: Accessor<boolean>

  folded: Accessor<boolean>
  fold: (value: boolean) => void
  drawer: Accessor<boolean>
  setDrawer: (value: boolean) => void
  /** Whether the context panel shows beside the timeline. */
  panelOpen: Accessor<boolean>
  setPanelOpen: (value: boolean) => void

  /** Every task the user handed to machines, kept live. */
  tasks: TaskFeed
  /** The task whose panel shows beside the timeline, in place of the context panel. */
  task: Accessor<string | undefined>
  openTask: (id: string) => void
  closeTask: () => void
  /** The user's machines, with their links. */
  machines: Accessor<readonly HubMachine[]>
}

export const ChatContext = createContext<ChatState>()

export function useChat() {
  const chat = useContext(ChatContext)
  if (!chat) throw new Error("useChat must be used inside the chat screen")
  return chat
}
