// Lifecycles of the hub dashboard: the live machine feed and the ChatGPT sign-in. Pure transitions; the components'
// drivers run the effects.

const RETRY_MIN = 1000

const RETRY_MAX = 30_000

export type FeedState =
  | { status: "connecting"; attempt: number; failures: number }
  | { status: "live"; attempt: number }
  | { status: "waiting"; attempt: number; failures: number }
  | { status: "signed-out" }

export type FeedEvent =
  | { type: "opened"; attempt: number }
  | { type: "failed"; attempt: number }
  | { type: "retry.due"; attempt: number }
  | { type: "unauthorized"; attempt: number }

export type FeedEffect =
  | { type: "connect"; attempt: number }
  | { type: "close" }
  | { type: "schedule"; attempt: number; delayMs: number }
  | { type: "signed-out" }

export type FeedTransition = { state: FeedState; effects: FeedEffect[] }

export function createFeed(): FeedTransition {
  return { state: { status: "connecting", attempt: 1, failures: 0 }, effects: [{ type: "connect", attempt: 1 }] }
}

export function transitionFeed(state: FeedState, event: FeedEvent): FeedTransition {
  if (state.status === "signed-out" || event.attempt !== state.attempt) return { state, effects: [] }

  if (event.type === "unauthorized") return { state: { status: "signed-out" }, effects: [{ type: "close" }] }

  if (event.type === "opened")
    return state.status === "connecting"
      ? { state: { status: "live", attempt: state.attempt }, effects: [] }
      : { state, effects: [] }

  if (event.type === "failed") {
    if (state.status === "waiting") return { state, effects: [] }
    const failures = state.status === "connecting" ? state.failures + 1 : 1

    return {
      state: { status: "waiting", attempt: state.attempt, failures },
      effects: [
        { type: "close" },
        { type: "schedule", attempt: state.attempt, delayMs: Math.min(RETRY_MIN * 2 ** (failures - 1), RETRY_MAX) },
      ],
    }
  }

  if (state.status !== "waiting") return { state, effects: [] }
  const attempt = state.attempt + 1

  return {
    state: { status: "connecting", attempt, failures: state.failures },
    effects: [{ type: "connect", attempt }],
  }
}

/** Whether the list on screen may be stale. */
export const feedReconnecting = (state: FeedState) => state.status === "waiting" || state.status === "connecting"

type SignIn = { attempt: string; url: string }

export type ChatGPTState =
  | { step: "preparing"; request: number; callback: string; error?: string }
  | { step: "ready"; request: number; signIn: SignIn; callback: string; error?: string }
  | { step: "completing"; request: number; signIn: SignIn; callback: string }
  | { step: "done" }

export type ChatGPTEvent =
  | { type: "begin.succeeded"; request: number; signIn: SignIn }
  | { type: "begin.failed"; request: number; error: string }
  | { type: "callback.changed"; value: string }
  | { type: "submitted" }
  | { type: "complete.succeeded"; request: number }
  | { type: "complete.failed"; request: number; error: string }
  | { type: "restarted" }

export type ChatGPTEffect =
  | { type: "begin"; request: number }
  | { type: "complete"; request: number; attempt: string; callback: string }
  | { type: "connected" }

export type ChatGPTTransition = { state: ChatGPTState; effects: ChatGPTEffect[] }

export function createChatGPT(): ChatGPTTransition {
  return { state: { step: "preparing", request: 1, callback: "" }, effects: [{ type: "begin", request: 1 }] }
}

export function transitionChatGPT(state: ChatGPTState, event: ChatGPTEvent): ChatGPTTransition {
  const same: ChatGPTTransition = { state, effects: [] }

  if (state.step === "done") return same

  if (event.type === "callback.changed") {
    if (state.step === "completing") return same

    return { state: { ...state, callback: event.value, error: undefined }, effects: [] }
  }

  if (event.type === "restarted") {
    if (state.step === "completing") return same
    const request = state.request + 1

    return {
      state: { step: "preparing", request, callback: state.callback },
      effects: [{ type: "begin", request }],
    }
  }

  if (event.type === "begin.succeeded" || event.type === "begin.failed") {
    if (state.step !== "preparing" || event.request !== state.request) return same

    if (event.type === "begin.failed") return { state: { ...state, error: event.error }, effects: [] }

    return {
      state: { step: "ready", request: state.request, signIn: event.signIn, callback: state.callback },
      effects: [],
    }
  }

  if (event.type === "submitted") {
    if (state.step !== "ready" || !state.callback.trim()) return same
    const request = state.request + 1

    return {
      state: { step: "completing", request, signIn: state.signIn, callback: state.callback },
      effects: [{ type: "complete", request, attempt: state.signIn.attempt, callback: state.callback.trim() }],
    }
  }

  if (state.step !== "completing" || event.request !== state.request) return same

  if (event.type === "complete.succeeded") return { state: { step: "done" }, effects: [{ type: "connected" }] }

  return {
    state: {
      step: "ready",
      request: state.request,
      signIn: state.signIn,
      callback: state.callback,
      error: event.error,
    },
    effects: [],
  }
}

export function viewChatGPT(state: ChatGPTState) {
  return {
    callback: state.step === "done" ? "" : state.callback,
    url: state.step === "ready" || state.step === "completing" ? state.signIn.url : undefined,
    preparing: state.step === "preparing" && !state.error,
    busy: state.step === "completing",
    canSubmit: state.step === "ready" && state.callback.trim().length > 0,
    canRestart: state.step === "ready" || (state.step === "preparing" && !!state.error),
    error: state.step === "ready" || state.step === "preparing" ? state.error : undefined,
    done: state.step === "done",
  }
}
