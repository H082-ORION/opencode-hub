import type { Server, ServerWebSocket } from "bun"
import { toHeaders, withoutHopByHop } from "../headers.js"
import { Protocol } from "../protocol.js"
import type { Machine } from "./store.js"

export * as Tunnel from "./tunnel.js"

export type SocketData =
  | { kind: "tunnel"; machine: Machine; tunnel?: Instance }
  | { kind: "client"; tunnel: Instance; stream: number }

type Head = { status: number; headers: Headers }

type HttpStream = {
  kind: "http"
  /** The browser session the stream was opened for, so it can be cut when that session loses access. */
  session: string
  head: PromiseWithResolvers<Head | undefined>
  responded: boolean
  body: ReadableStreamDefaultController<Uint8Array>
}

type WsStream = {
  kind: "ws"
  session: string
  head: PromiseWithResolvers<Protocol.Response | undefined>
  client?: ServerWebSocket<SocketData>
  // Messages the agent sends between its 101 and the moment the browser socket is open.
  pending: (string | Uint8Array | Protocol.Close)[]
}

// Statuses whose responses must not carry a body.
const NULL_BODY = new Set([101, 103, 204, 205, 304])

/** The hub side of one machine's tunnel: allocates streams and proxies HTTP and WebSocket traffic over it. */
export function create(ws: ServerWebSocket<SocketData>, machine: Machine) {
  const streams = new Map<number, HttpStream | WsStream>()
  const state = { next: 1, closed: false }

  const send = (frame: Uint8Array) => {
    if (!state.closed) ws.sendBinary(frame)
  }
  /** Aborts a stream from the hub side and tells the machine to forget it. */
  const reset = (id: number, message?: string) => {
    const stream = streams.get(id)
    if (!stream) return
    streams.delete(id)
    send(Protocol.encodeJson(Protocol.Type.RESET, id, { message }))
    stream.head.resolve(undefined)
    if (stream.kind === "http") return stream.body.error(new Error(message ?? "stream reset"))
    stream.client?.close(1011, "stream reset")
  }

  const tunnel = {
    machine,
    ws,
    send,
    /** The instances whose current token the agent holds on this connection, so INSTANCE can omit it. */
    held: new Set<string>(),

    /** Proxies one HTTP request for a browser session to an instance; `path` includes the query string. */
    http(request: Request, instance: string, path: string, headers: [string, string][], session: string) {
      const id = state.next++
      const head = Promise.withResolvers<Head | undefined>()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streams.set(id, { kind: "http", session, head, responded: false, body: controller })
        },
        cancel() {
          reset(id, "client went away")
        },
      })
      send(
        Protocol.encodeJson(Protocol.Type.OPEN, id, { kind: "http", instance, method: request.method, path, headers }),
      )
      request.signal.addEventListener("abort", () => reset(id, "client went away"), { once: true })
      pump(request.body, id).catch((error: unknown) => reset(id, String(error)))
      return head.promise.then((response) => {
        if (!response) return unavailable()
        const empty = NULL_BODY.has(response.status) || request.method === "HEAD"
        return new Response(empty ? null : body, response)
      })
    },

    /** Opens a WebSocket stream and upgrades the browser connection once the machine accepted it. */
    async websocket(
      request: Request,
      server: Server<SocketData>,
      instance: string,
      path: string,
      headers: [string, string][],
      session: string,
    ) {
      const id = state.next++
      const head = Promise.withResolvers<Protocol.Response | undefined>()
      const stream: WsStream = { kind: "ws", session, head, pending: [] }
      streams.set(id, stream)
      const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((protocol) => protocol.trim())
        .filter(Boolean)
      send(Protocol.encodeJson(Protocol.Type.OPEN, id, { kind: "ws", instance, path, headers, protocols }))
      const response = await head.promise
      if (!response || response.status !== 101) {
        streams.delete(id)
        return new Response("The machine refused the WebSocket connection.", {
          status: response && response.status >= 200 ? response.status : 502,
        })
      }
      const upgraded = server.upgrade(request, {
        data: { kind: "client", tunnel, stream: id },
        headers: response.protocol ? { "sec-websocket-protocol": response.protocol } : undefined,
      })
      if (upgraded) return undefined
      reset(id, "upgrade failed")
      return new Response("WebSocket upgrade failed.", { status: 400 })
    },

    clientOpen(client: ServerWebSocket<SocketData>, id: number) {
      const stream = streams.get(id)
      if (stream?.kind !== "ws") return client.close(1011, "stream closed")
      stream.client = client
      stream.pending.splice(0).forEach((message) => deliver(stream, message))
    },
    clientMessage(id: number, message: string | Uint8Array) {
      if (!streams.has(id)) return
      if (typeof message === "string") return send(Protocol.encodeText(Protocol.Type.TEXT, id, message))
      send(Protocol.encode(Protocol.Type.DATA, id, message))
    },
    clientClose(id: number, code: number, reason: string) {
      if (streams.delete(id)) send(Protocol.encodeJson(Protocol.Type.CLOSE, id, { code, reason }))
    },

    receive(frame: Protocol.Frame) {
      const stream = streams.get(frame.stream)
      if (!stream) return
      if (stream.kind === "http") return receiveHttp(frame, stream)
      receiveWs(frame, stream)
    },

    /** Resets every stream whose session `allowed` refuses, e.g. after a sign-out or a disabled account. */
    drop(allowed: (session: string) => boolean) {
      Array.from(streams)
        .filter((entry) => !allowed(entry[1].session))
        .forEach((entry) => {
          const stream = entry[1]
          streams.delete(entry[0])
          send(Protocol.encodeJson(Protocol.Type.RESET, entry[0], { message: "access revoked" }))
          stream.head.resolve(undefined)
          // A policy cut, not a failure: the response simply ends and the socket closes with 1008.
          if (stream.kind === "http") return stream.body.close()
          stream.client?.close(1008, "access revoked")
        })
    },

    /** Fails every open stream; called when the tunnel goes away. */
    dispose() {
      state.closed = true
      for (const stream of streams.values()) {
        if (stream.kind === "ws") {
          stream.head.resolve(undefined)
          stream.client?.close(1001, "machine disconnected")
          continue
        }
        stream.head.resolve(undefined)
        stream.body.error(new Error("machine disconnected"))
      }
      streams.clear()
    },
  }
  return tunnel

  async function pump(body: ReadableStream<Uint8Array> | null, id: number) {
    if (body) {
      for await (const chunk of body) {
        if (!streams.has(id)) return
        send(Protocol.encode(Protocol.Type.DATA, id, chunk))
      }
    }
    if (streams.has(id)) send(Protocol.encode(Protocol.Type.END, id))
  }

  function receiveHttp(frame: Protocol.Frame, stream: HttpStream) {
    if (frame.type === Protocol.Type.RESPONSE && !stream.responded) {
      const response = Protocol.decodeResponse(frame.payload)
      if (!response || response.status < 200 || response.status > 599) {
        return reset(frame.stream, "invalid response")
      }
      stream.responded = true
      // A machine-side response cannot replace the hub's session cookie.
      const headers = withoutHopByHop(response.headers ?? []).filter((entry) => entry[0].toLowerCase() !== "set-cookie")
      return stream.head.resolve({ status: response.status, headers: toHeaders(headers) })
    }
    if (frame.type === Protocol.Type.DATA) return stream.body.enqueue(frame.payload.slice())
    if (frame.type === Protocol.Type.END) {
      streams.delete(frame.stream)
      return stream.body.close()
    }
    if (frame.type !== Protocol.Type.RESET) return
    streams.delete(frame.stream)
    stream.head.resolve(undefined)
    stream.body.error(new Error(Protocol.decodeReset(frame.payload)?.message ?? "stream reset by machine"))
  }

  function receiveWs(frame: Protocol.Frame, stream: WsStream) {
    if (frame.type === Protocol.Type.RESPONSE) return stream.head.resolve(Protocol.decodeResponse(frame.payload))
    if (frame.type === Protocol.Type.RESET) {
      streams.delete(frame.stream)
      stream.head.resolve(undefined)
      return stream.client?.close(1011, "stream reset by machine")
    }
    if (frame.type === Protocol.Type.CLOSE) {
      streams.delete(frame.stream)
      return queue(stream, Protocol.decodeClose(frame.payload) ?? { code: 1000, reason: "" })
    }
    if (frame.type === Protocol.Type.TEXT) return queue(stream, Protocol.text(frame.payload))
    if (frame.type === Protocol.Type.DATA) queue(stream, frame.payload.slice())
  }
}

export type Instance = ReturnType<typeof create>

function queue(stream: WsStream, message: string | Uint8Array | Protocol.Close) {
  if (!stream.client) return void stream.pending.push(message)
  deliver(stream, message)
}

function deliver(stream: WsStream, message: string | Uint8Array | Protocol.Close) {
  if (typeof message === "string" || message instanceof Uint8Array) return void stream.client?.send(message)
  stream.client?.close(Protocol.closeCode(message.code), message.reason)
}

function unavailable() {
  return new Response("The machine did not answer.", { status: 502 })
}
