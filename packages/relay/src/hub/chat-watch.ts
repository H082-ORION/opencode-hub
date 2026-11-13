import { Option, Schema } from "effect"

export * as ChatWatch from "./chat-watch.js"

/**
 * What a task's followers hear from a machine's opencode server: the events that change a session's transcript,
 * status, usage, permissions and questions. Anything else (files, terminals, other locations' state) stays there.
 */
const TYPES = [
  "session.created",
  "session.deleted",
  "session.renamed",
  "session.usage.updated",
  "session.agent.selected",
  "session.model.selected",
  "session.synthetic",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.delivery.changed",
  "session.inbox.cancelled",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.retry.scheduled",
  "session.step.started",
  "session.step.streamed",
  "session.step.ended",
  "session.step.failed",
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.started",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.tool.input.started",
  "session.tool.input.delta",
  "session.tool.input.ended",
  "session.tool.called",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
  "session.shell.started",
  "session.shell.ended",
  "session.compaction.started",
  "session.compaction.delta",
  "session.compaction.ended",
  "session.compaction.failed",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
]
const FILTERED = `/api/event?${TYPES.map((type) => `types=${encodeURIComponent(type)}`).join("&")}`
/** A server that does not know one of the types refuses the filter: it is then followed whole. */
const UNFILTERED = "/api/event"
const FIRST_RETRY = 1000
const MAX_RETRY = 30_000
/** A stream that stayed up this long reconnects at once, then backs off again. */
const STABLE = 60_000
/** Larger events are dropped rather than buffered: a session's state is read again on the next resync. */
const MAX_EVENT = 4 * 1024 * 1024

const decodeEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ type: Schema.String, data: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) }),
  ),
)
const decodeForm = Schema.decodeUnknownOption(Schema.Struct({ sessionID: Schema.String }))
const isString = Schema.is(Schema.String)

/** One event of a machine's stream, with the JSON it arrived as so it can be forwarded unchanged. */
export type Event = {
  type: string
  data: Record<string, unknown>
  /** The session it belongs to, when it belongs to one. */
  session?: string
  /** For `session.created`, the session's parent. */
  parent?: string
  json: string
}

/** A follower of one user's events on one machine: every event, and whether the stream is up. */
export type Listener = { event: (event: Event) => void; status: (connected: boolean) => void }

type Request_ = {
  user: string
  machine: string
  method: string
  path: string
  signal?: AbortSignal
}

type Feed = { listeners: Set<Listener>; controller: AbortController; connected: boolean }

/**
 * One event stream per user and machine, shared by every task and browser following that user's sessions there, open
 * while anyone follows it and reconnecting with a backoff. The machine's `/api/event` cannot filter by session, so
 * followers filter what they receive. Reconnecting announces `server.connected` again, after which a follower reads
 * what it may have missed.
 */
export function create(input: { request: (request: Request_) => Promise<Response>; retry?: number }) {
  const feeds = new Map<string, Feed>()
  const first = input.retry ?? FIRST_RETRY

  return {
    /** Follows a user's events on a machine until the returned function is called. */
    subscribe(user: string, machine: string, listener: Listener) {
      const key = `${user}\n${machine}`
      const existing = feeds.get(key)
      const feed = existing ?? { listeners: new Set<Listener>(), controller: new AbortController(), connected: false }
      feed.listeners.add(listener)
      if (!existing) {
        feeds.set(key, feed)
        void run(user, machine, feed)
      }
      if (feed.connected) listener.status(true)
      return () => {
        feed.listeners.delete(listener)
        if (feed.listeners.size > 0 || feeds.get(key) !== feed) return
        feeds.delete(key)
        feed.controller.abort()
      }
    },

    connected: (user: string, machine: string) => feeds.get(`${user}\n${machine}`)?.connected ?? false,

    stop() {
      feeds.forEach((feed) => feed.controller.abort())
      feeds.clear()
    },
  }

  async function run(user: string, machine: string, feed: Feed) {
    const signal = feed.controller.signal
    const state = { attempt: 0, path: FILTERED }
    while (!signal.aborted) {
      const response = await input
        .request({ user, machine, method: "GET", path: state.path, signal })
        .catch(() => undefined)
      if (response?.status === 400 && state.path === FILTERED) {
        state.path = UNFILTERED
        continue
      }
      const started = Date.now()
      if (response?.ok && response.body) await read(response.body, feed, signal).catch(() => undefined)
      else await response?.body?.cancel().catch(() => undefined)
      if (feed.connected) {
        feed.connected = false
        feed.listeners.forEach((listener) => listener.status(false))
      }
      if (signal.aborted) return
      state.attempt = Date.now() - started >= STABLE ? 0 : state.attempt + 1
      const delay = Math.min(MAX_RETRY, first * 2 ** Math.max(0, state.attempt - 1))
      await sleep(delay, signal)
    }
  }

  async function read(body: ReadableStream<Uint8Array>, feed: Feed, signal: AbortSignal) {
    const decoder = new TextDecoder()
    const buffer = { text: "" }
    const reader = body.getReader()
    signal.addEventListener("abort", () => void reader.cancel().catch(() => undefined), { once: true })
    while (!signal.aborted) {
      const chunk = await reader.read()
      if (chunk.done) return
      buffer.text += decoder.decode(chunk.value, { stream: true })
      const blocks = buffer.text.split("\n\n")
      buffer.text = blocks.pop() ?? ""
      if (buffer.text.length > MAX_EVENT) buffer.text = ""
      blocks.forEach((block) => deliver(block, feed))
    }
  }

  function deliver(block: string, feed: Feed) {
    const json = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
      .join("\n")
    if (!json) return
    const parsed = Option.getOrUndefined(decodeEvent(json))
    if (!parsed) return
    const data = parsed.data ?? {}
    const form = parsed.type === "form.created" ? Option.getOrUndefined(decodeForm(data.form)) : undefined
    const session = isString(data.sessionID) ? data.sessionID : form?.sessionID
    const event: Event = {
      type: parsed.type,
      data,
      json,
      ...(session === undefined ? {} : { session }),
      ...(parsed.type === "session.created" && isString(data.parentID) ? { parent: data.parentID } : {}),
    }
    if (parsed.type === "server.connected" && !feed.connected) {
      feed.connected = true
      feed.listeners.forEach((listener) => listener.status(true))
    }
    feed.listeners.forEach((listener) => listener.event(event))
  }
}

export type Instance = ReturnType<typeof create>

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
  })
}
