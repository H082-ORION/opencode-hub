import { createHash } from "node:crypto"
import { Option, Schema } from "effect"
import { HOP_BY_HOP, withoutDecodedHeaders } from "../headers.js"
import { Protocol } from "../protocol.js"
import pkg from "../../package.json" with { type: "json" }

export * as Agent from "./index.js"

export const Enrollment = Schema.Struct({
  url: Schema.String,
  machine: Schema.Struct({ id: Schema.String, name: Schema.String }),
  tunnelToken: Schema.String,
})
export type Enrollment = typeof Enrollment.Type
export type Ready = Protocol.Ready
export type LlmConfig = Protocol.LlmConfig
/** An instance as the agent hands it on: always with the token it holds for it. */
export type Instance = Protocol.Instance & { token: string }
/** `stopped` is final: the hub refused this agent for good (protocol mismatch, revoked, or replaced). */
export type Status = "connecting" | "connected" | "disconnected" | "stopped"
export type Local = { url: string; password?: string }

// Bun's WebSocket takes handshake headers; the DOM typings some consumers compile with do not know them.
type BunWebSocketConstructor = new (
  url: string | URL,
  options: { readonly headers?: Record<string, string>; readonly protocols?: string[] },
) => WebSocket
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Bun extends the browser constructor with handshake options.
const BunWebSocket = globalThis.WebSocket as unknown as BunWebSocketConstructor

export type ConnectInput = {
  enrollment: Enrollment
  /**
   * Instance tokens the agent already holds when it starts, e.g. the personal instance's from the service
   * environment: announced in HELLO (as hashes) so the hub does not issue new ones.
   */
  instances?: readonly { iid: string; token: string }[]
  /** Resolves an instance's local opencode server; called again after a local request to it fails to connect. */
  local: (iid: string) => Promise<Local>
  /** READY: `ready.instances` lists the instances that still exist; the others were already forgotten. */
  onReady?: (ready: Ready) => void
  /** INSTANCE: an instance's configuration, new or changed. */
  onInstance?: (instance: Instance) => void
  /** DROP, or an instance missing from READY: the instance is gone and its data should be deleted. */
  onDrop?: (iid: string) => void
  onStatus?: (status: Status, detail?: string) => void
  /** Overrides for timing constants, in milliseconds. */
  timing?: Partial<typeof TIMING>
}

const TIMING = {
  /** Without any message from the hub for this long, the connection is considered dead. */
  deadAfter: 60_000,
  backoffMin: 1_000,
  backoffMax: 30_000,
  /** A connection that stayed up this long resets the backoff. */
  stableAfter: 60_000,
}

// The hub closes with these codes when reconnecting cannot help.
const TERMINAL = new Map([
  [4400, "protocol mismatch"],
  [4403, "machine revoked"],
  [4409, "replaced by another agent for this machine"],
])

// Headers that describe the browser's connection to the hub, or carry hub credentials.
const DROPPED = new Set([...HOP_BY_HOP, "host", "origin", "cookie", "authorization", "content-length"])

const decodeEnrollment = Schema.decodeUnknownOption(Enrollment)

/**
 * Whether a hub URL keeps the enrollment code and the machine's tokens off the network in clear text: HTTPS, or
 * plain HTTP to this machine only (localhost, *.localhost, 127.0.0.0/8, ::1).
 */
export function isSecureURL(input: string) {
  const url = new URL(input)
  if (url.protocol === "https:") return true
  if (url.protocol !== "http:") return false
  const host = url.hostname
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host)
}

/**
 * Enrolls this machine with a one-time code from the hub dashboard. The code, and the tokens the hub answers with,
 * only travel over HTTPS unless `insecure` allows plain HTTP to another machine.
 */
export async function enroll(input: {
  url: string
  code: string
  name: string
  insecure?: boolean
}): Promise<Enrollment> {
  if (!input.insecure && !isSecureURL(input.url)) {
    throw new Error(
      `refusing to send the enrollment code in clear text to ${new URL(input.url).host}: use an https:// hub URL, or pass --insecure`,
    )
  }
  const response = await fetch(new URL("/hub/agent/enroll", input.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: input.code, name: input.name }),
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const error = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }))(body))
    throw new Error(`enrollment failed (${response.status}): ${error?.error ?? response.statusText}`)
  }
  const enrollment = Option.getOrUndefined(decodeEnrollment(body))
  if (!enrollment) throw new Error("enrollment failed: unexpected response from the hub")
  // The tunnel connects to the URL the hub announces (its --url), and sends the tunnel token on every connection.
  if (!input.insecure && !isSecureURL(enrollment.url)) {
    throw new Error(
      `the hub announces the plain HTTP URL ${enrollment.url}, so the tunnel would carry this machine's token in clear text: ` +
        `start the hub with an https:// --url, delete "${enrollment.machine.name}" in the dashboard, then enroll again (or pass --insecure)`,
    )
  }
  return enrollment
}

type HttpStream = {
  kind: "http"
  instance: string
  abort: AbortController
  body?: ReadableStreamDefaultController<Uint8Array>
}
type WsStream = { kind: "ws"; instance: string; socket?: WebSocket }

/** Keeps a tunnel to the hub open, reconnecting with backoff, and serves its streams from the local server. */
export function connect(input: ConnectInput) {
  const timing = { ...TIMING, ...input.timing }
  const target = new URL("/hub/agent/connect", input.enrollment.url)
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:"
  const streams = new Map<number, HttpStream | WsStream>()
  // Instance tokens live only here and in each instance's own configuration, never in agent.json.
  const tokens = new Map((input.instances ?? []).map((entry) => [entry.iid, entry.token]))
  const locals = new Map<string, Promise<Local>>()
  const state: {
    stopped: boolean
    socket?: WebSocket
    connectedAt?: number
    attempt: number
    retry?: Timer
    watchdog?: Timer
    closed?: PromiseWithResolvers<void>
  } = { stopped: false, attempt: 0 }

  open()

  return {
    async close() {
      state.stopped = true
      clearTimeout(state.retry)
      const socket = state.socket
      if (!socket) return abortStreams()
      state.closed = Promise.withResolvers<void>()
      socket.close(1000, "agent closed")
      await state.closed.promise
    },
  }

  function open() {
    if (state.stopped) return
    input.onStatus?.("connecting")
    const socket = new BunWebSocket(target, { headers: { authorization: `Bearer ${input.enrollment.tunnelToken}` } })
    socket.binaryType = "arraybuffer"
    state.socket = socket
    state.connectedAt = undefined
    socket.addEventListener("open", () => {
      arm(socket)
      socket.send(
        Protocol.encodeJson(Protocol.Type.HELLO, 0, {
          protocol: Protocol.VERSION,
          version: pkg.version,
          name: input.enrollment.machine.name,
          platform: process.platform,
          instances: Array.from(tokens, (entry) => ({
            iid: entry[0],
            hash: createHash("sha256").update(entry[1]).digest("hex"),
          })),
        }),
      )
    })
    socket.addEventListener("message", (event) => {
      if (state.socket !== socket) return
      arm(socket)
      const frame = Protocol.decode(event.data)
      if (frame) receive(socket, frame)
    })
    socket.addEventListener("close", (event) => finish(socket, event.code, event.reason))
  }

  /** Restarts the dead-connection timer; any message from the hub proves the connection alive. */
  function arm(socket: WebSocket) {
    clearTimeout(state.watchdog)
    state.watchdog = setTimeout(() => {
      // A dead connection may never deliver its close event, so the agent moves on without waiting for it.
      finish(socket, 4000, "no ping from the hub")
      socket.close(4000, "no ping")
    }, timing.deadAfter)
  }

  function finish(socket: WebSocket, code: number, reason: string) {
    if (state.socket !== socket) return
    state.socket = undefined
    clearTimeout(state.watchdog)
    abortStreams()
    const terminal = TERMINAL.get(code)
    input.onStatus?.(terminal ? "stopped" : "disconnected", reason || terminal || `closed with code ${code}`)
    if (terminal) state.stopped = true
    if (state.stopped) return state.closed?.resolve()
    if (state.connectedAt !== undefined && Date.now() - state.connectedAt >= timing.stableAfter) state.attempt = 0
    const delay = Math.min(timing.backoffMin * 2 ** state.attempt, timing.backoffMax) * (0.8 + Math.random() * 0.4)
    state.attempt++
    state.retry = setTimeout(open, delay)
  }

  function abortStreams() {
    streams.forEach((stream) => {
      if (stream.kind === "http") return stream.abort.abort()
      stream.socket?.close(1001, "tunnel closed")
    })
    streams.clear()
  }

  function receive(socket: WebSocket, frame: Protocol.Frame) {
    const send = (data: Uint8Array<ArrayBuffer>) => {
      if (state.socket === socket && socket.readyState === WebSocket.OPEN) socket.send(data)
    }
    if (frame.stream === 0) return control(frame, send)
    if (frame.type === Protocol.Type.OPEN) {
      const open = Protocol.decodeOpen(frame.payload)
      if (!open || streams.has(frame.stream) || !open.path.startsWith("/"))
        return send(Protocol.encodeJson(Protocol.Type.RESET, frame.stream, { message: "invalid OPEN" }))
      // Only instances the hub configured on this agent are served.
      if (!tokens.has(open.instance))
        return send(Protocol.encodeJson(Protocol.Type.RESET, frame.stream, { message: "unknown instance" }))
      if (open.kind === "http") return void http(frame.stream, open, send)
      return void websocket(frame.stream, open, send)
    }
    const stream = streams.get(frame.stream)
    if (!stream) return
    if (frame.type === Protocol.Type.RESET) {
      streams.delete(frame.stream)
      if (stream.kind === "http") return stream.abort.abort()
      return stream.socket?.close(1000, "reset")
    }
    if (stream.kind === "http") {
      if (frame.type === Protocol.Type.DATA) return stream.body?.enqueue(frame.payload.slice())
      if (frame.type !== Protocol.Type.END) return
      stream.body?.close()
      stream.body = undefined
      return
    }
    if (frame.type === Protocol.Type.TEXT) return stream.socket?.send(Protocol.text(frame.payload))
    if (frame.type === Protocol.Type.DATA) return stream.socket?.send(frame.payload.slice())
    if (frame.type !== Protocol.Type.CLOSE) return
    streams.delete(frame.stream)
    const close = Protocol.decodeClose(frame.payload)
    stream.socket?.close(Protocol.closeCode(close?.code ?? 1000), close?.reason ?? "")
  }

  function control(frame: Protocol.Frame, send: (data: Uint8Array<ArrayBuffer>) => void) {
    if (frame.type === Protocol.Type.PING) return send(Protocol.encode(Protocol.Type.PONG, 0))
    if (frame.type === Protocol.Type.READY) {
      const ready = Protocol.decodeReady(frame.payload)
      if (!ready) return
      state.connectedAt = Date.now()
      input.onStatus?.("connected")
      input.onReady?.(ready)
      // Instances dropped while this agent was offline are forgotten before any stream reaches them.
      const valid = new Set(ready.instances)
      Array.from(tokens.keys())
        .filter((iid) => !valid.has(iid))
        .forEach((iid) => forget(iid, send))
      return
    }
    if (frame.type === Protocol.Type.INSTANCE) {
      const instance = Protocol.decodeInstance(frame.payload)
      const token = instance?.token ?? (instance ? tokens.get(instance.iid) : undefined)
      // Without a token the instance could not reach the hub's relays; the hub sends one whenever it is needed.
      if (!instance || token === undefined) return
      tokens.set(instance.iid, token)
      // The instance may be restarted with its new configuration: its address is resolved again.
      locals.delete(instance.iid)
      return input.onInstance?.({ ...instance, token })
    }
    if (frame.type !== Protocol.Type.DROP) return
    const drop = Protocol.decodeDrop(frame.payload)
    if (drop) forget(drop.iid, send)
  }

  /** Forgets an instance: its token, its address and its open streams, then lets the caller delete it. */
  function forget(iid: string, send: (data: Uint8Array<ArrayBuffer>) => void) {
    tokens.delete(iid)
    locals.delete(iid)
    Array.from(streams)
      .filter((entry) => entry[1].instance === iid)
      .forEach((entry) => {
        streams.delete(entry[0])
        send(Protocol.encodeJson(Protocol.Type.RESET, entry[0], { message: "instance dropped" }))
        if (entry[1].kind === "http") return entry[1].abort.abort()
        entry[1].socket?.close(1001, "instance dropped")
      })
    input.onDrop?.(iid)
  }

  async function http(id: number, open: Protocol.OpenHttp, send: (data: Uint8Array<ArrayBuffer>) => void) {
    const stream: HttpStream = { kind: "http", instance: open.instance, abort: new AbortController() }
    const bodied = open.method !== "GET" && open.method !== "HEAD"
    const body = bodied
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            stream.body = controller
          },
          cancel() {
            stream.body = undefined
          },
        })
      : undefined
    streams.set(id, stream)
    const request = async () => {
      const local = await resolveLocal(open.instance)
      return fetch(`${local.url.replace(/\/+$/, "")}${open.path}`, {
        method: open.method,
        headers: localHeaders(open.headers, local),
        body,
        redirect: "manual",
        signal: stream.abort.signal,
      })
    }
    // A request without a body can be replayed once against a re-resolved local server.
    const response = await request()
      .catch((error: unknown) => {
        locals.delete(open.instance)
        if (bodied || stream.abort.signal.aborted) throw error
        return request()
      })
      .catch((error: unknown) => {
        locals.delete(open.instance)
        return error instanceof Error ? error : new Error(String(error))
      })
    if (!streams.has(id)) return
    if (response instanceof Error) {
      streams.delete(id)
      send(Protocol.encodeJson(Protocol.Type.RESPONSE, id, { status: 502, headers: [["content-type", "text/plain"]] }))
      send(Protocol.encodeText(Protocol.Type.DATA, id, `The local opencode server is unavailable: ${response.message}`))
      return send(Protocol.encode(Protocol.Type.END, id))
    }
    const headers = withoutDecodedHeaders(response.headers).filter((entry) => entry[0].toLowerCase() !== "set-cookie")
    send(Protocol.encodeJson(Protocol.Type.RESPONSE, id, { status: response.status, headers }))
    const forwarded = await forward(id, response.body, send).catch((error: unknown) => error as Error)
    if (!streams.delete(id)) return
    if (forwarded instanceof Error)
      return send(Protocol.encodeJson(Protocol.Type.RESET, id, { message: forwarded.message }))
    send(Protocol.encode(Protocol.Type.END, id))
  }

  async function forward(
    id: number,
    body: ReadableStream<Uint8Array> | null,
    send: (data: Uint8Array<ArrayBuffer>) => void,
  ) {
    if (!body) return
    for await (const chunk of body) {
      if (!streams.has(id)) return
      send(Protocol.encode(Protocol.Type.DATA, id, chunk))
    }
  }

  async function websocket(id: number, open: Protocol.OpenWs, send: (data: Uint8Array<ArrayBuffer>) => void) {
    const stream: WsStream = { kind: "ws", instance: open.instance }
    streams.set(id, stream)
    const local = await resolveLocal(open.instance).catch(() => undefined)
    if (!streams.has(id)) return
    if (!local) {
      streams.delete(id)
      return send(Protocol.encodeJson(Protocol.Type.RESPONSE, id, { status: 502 }))
    }
    const url = new URL(`${local.url.replace(/\/+$/, "")}${open.path}`)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    const socket = new BunWebSocket(url, {
      headers: Object.fromEntries(localHeaders(open.headers, local)),
      protocols: [...open.protocols],
    })
    socket.binaryType = "arraybuffer"
    stream.socket = socket
    const opened = { value: false }
    socket.addEventListener("open", () => {
      opened.value = true
      if (!streams.has(id)) return socket.close(1000, "stream closed")
      send(Protocol.encodeJson(Protocol.Type.RESPONSE, id, { status: 101, protocol: socket.protocol || undefined }))
    })
    socket.addEventListener("message", (event) => {
      if (!streams.has(id)) return
      if (typeof event.data === "string") return send(Protocol.encodeText(Protocol.Type.TEXT, id, event.data))
      send(Protocol.encode(Protocol.Type.DATA, id, new Uint8Array(event.data as ArrayBuffer)))
    })
    socket.addEventListener("close", (event) => {
      if (!streams.delete(id)) return
      if (!opened.value) {
        locals.delete(open.instance)
        return send(Protocol.encodeJson(Protocol.Type.RESPONSE, id, { status: 502 }))
      }
      send(Protocol.encodeJson(Protocol.Type.CLOSE, id, { code: event.code, reason: event.reason }))
    })
  }

  function resolveLocal(iid: string) {
    const known = locals.get(iid)
    if (known) return known
    const local = input.local(iid)
    locals.set(iid, local)
    // A failed resolution is not cached, so the next request tries again.
    local.catch(() => locals.get(iid) === local && locals.delete(iid))
    return local
  }
}

/**
 * Headers for the local server: everything the browser sent except connection-level headers and hub credentials,
 * plus the local service's Basic auth.
 */
function localHeaders(entries: readonly (readonly [string, string])[], local: Local) {
  const headers = new Headers()
  entries
    .filter((entry) => {
      const name = entry[0].toLowerCase()
      return !DROPPED.has(name) && !name.startsWith("sec-websocket-")
    })
    .forEach((entry) => headers.append(entry[0], entry[1]))
  if (local.password !== undefined)
    headers.set("authorization", `Basic ${Buffer.from(`opencode:${local.password}`).toString("base64")}`)
  return headers
}
