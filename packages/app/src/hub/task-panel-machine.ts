import type { HubTaskStatus } from "./api"

/**
 * The task panel: which task it shows, whether its event stream is up, and what the task is doing. The stream's phases
 * are the variants; what the task does is the `work` field, which only the hub's `hub.task.updated` events change.
 */
export type TaskWork = "starting" | "working" | "waiting" | "ended" | "failed" | "offline" | "lost"

export type TaskPanelState =
  | { readonly status: "closed"; readonly attempt: number }
  | { readonly status: "loading"; readonly task: string; readonly attempt: number; readonly work: TaskWork }
  | { readonly status: "live"; readonly task: string; readonly attempt: number; readonly work: TaskWork }
  | { readonly status: "reconnecting"; readonly task: string; readonly attempt: number; readonly work: TaskWork }

export type TaskPanelEvent =
  | { readonly type: "open"; readonly task: string }
  | { readonly type: "close" }
  /** The panel's event stream for `attempt` came up or went down. */
  | { readonly type: "connection"; readonly attempt: number; readonly connected: boolean }
  /** The machine's stream behind the hub came back: what happened meanwhile has to be read again. */
  | { readonly type: "resync"; readonly attempt: number }
  | { readonly type: "update"; readonly attempt: number; readonly task: string; readonly status: HubTaskStatus }

/** `sync` reads the task's session, messages, inbox, permissions and questions again. */
export type TaskPanelEffect = { readonly type: "sync"; readonly attempt: number }

export type TaskPanelTransition = { readonly state: TaskPanelState; readonly effects: readonly TaskPanelEffect[] }

export const CLOSED_TASK_PANEL: TaskPanelState = Object.freeze({ status: "closed", attempt: 0 })

export function transitionTaskPanel(state: TaskPanelState, event: TaskPanelEvent): TaskPanelTransition {
  if (event.type === "open") {
    if (state.status !== "closed" && state.task === event.task) return unchanged(state)
    return changed({ status: "loading", task: event.task, attempt: state.attempt + 1, work: "starting" })
  }

  if (event.type === "close") {
    if (state.status === "closed") return unchanged(state)
    return changed({ status: "closed", attempt: state.attempt })
  }

  if (state.status === "closed" || event.attempt !== state.attempt) return unchanged(state)

  if (event.type === "update") {
    const work = workOf(event.status)
    if (event.task !== state.task || work === state.work) return unchanged(state)
    return changed({ ...state, work })
  }

  if (event.type === "resync") {
    if (state.status !== "live") return unchanged(state)
    return changed(state, [{ type: "sync", attempt: state.attempt }])
  }

  if (event.connected) {
    if (state.status === "live") return unchanged(state)
    return changed({ status: "live", task: state.task, attempt: state.attempt, work: state.work }, [
      { type: "sync", attempt: state.attempt },
    ])
  }

  if (state.status !== "live") return unchanged(state)
  return changed({ status: "reconnecting", task: state.task, attempt: state.attempt, work: state.work })
}

export function workOf(status: HubTaskStatus): TaskWork {
  if (status === "running") return "working"
  if (status === "idle" || status === "interrupted") return "ended"
  return status
}

/** What the panel shows and allows. */
export function viewTaskPanel(state: TaskPanelState) {
  if (state.status === "closed")
    return { open: false, connecting: false, working: false, canStop: false, canSend: false, notice: undefined }
  const work = state.work
  const reachable = work !== "offline" && work !== "lost"
  return {
    open: true,
    // The stream to the hub, not the agent: OpenCode's loader, never the agent's spinner.
    connecting: state.status !== "live",
    // The agent is working only while the panel can see it do so.
    working: state.status === "live" && (work === "starting" || work === "working"),
    canStop: reachable && (work === "starting" || work === "working" || work === "waiting"),
    canSend: reachable,
    notice:
      state.status === "reconnecting"
        ? ("reconnecting" as const)
        : work === "offline" || work === "lost" || work === "failed" || work === "waiting"
          ? work
          : undefined,
  }
}

function changed(state: TaskPanelState, effects: readonly TaskPanelEffect[] = []): TaskPanelTransition {
  return { state, effects }
}

function unchanged(state: TaskPanelState): TaskPanelTransition {
  return { state, effects: [] }
}
