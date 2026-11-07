import type { Server, ServerWebSocket } from "bun"
import { createHash } from "node:crypto"
import { Option, Schema } from "effect"
import { Protocol } from "../protocol.js"
import { Auth } from "./auth.js"
import { Catalog } from "./catalog.js"
import { ChatGPT } from "./chatgpt.js"
import { Html } from "./html.js"
import { Llm } from "./llm.js"
import { Store } from "./store.js"
import { Tunnel } from "./tunnel.js"

export * as Hub from "./index.js"

/** The built web app; `path` has no leading slash (`hub.html`, `_assets/hub-abc.js`). */
export type UI = { file(path: string): { body: string | Uint8Array; type: string } | undefined }

export type Options = {
  hostname?: string
  port?: number
  /** Public base URL; its host is the routing domain. Defaults to `http://localhost:<port>`. */
  url?: string
  /** Directory holding `hub.db`. */
  data: string
  /** Fixed password; defaults to `OPENCODE_HUB_PASSWORD`, then to the stored (or a newly generated) one. */
  password?: string
  /** Milliseconds between tunnel PINGs. */
  pingInterval?: number
  /** The dashboard's assets. Without them the hub host serves a page explaining how to build them. */
  ui?: UI
  chatgpt?: ChatGPT.Options
  /** Where the provider catalog comes from; defaults to models.dev. */
  catalog?: { source?: string; fetch?: typeof fetch }
  /** The running opencode version, sent to OpenAI when signing in with ChatGPT. */
  version?: string
}

/** A browser following `/hub/api/events`. */
type Listener = { session: string; send: (text: string) => void; close: () => void }

const PASSWORD_KEY = "password_hash"
// The machine's web app installs a service worker that answers every navigation with its own index.html except under
// /api and /auth, so the handoff has to live under /auth to reach the hub once that worker is installed.
const SESSION_PATH = "/auth/hub-session"
const PING_INTERVAL = 25_000
const KEEPALIVE_INTERVAL = 25_000
const HELLO_TIMEOUT = 10_000
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const PROVIDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const EnrollRequest = Schema.fromJsonString(Schema.Struct({ code: Schema.String, name: Schema.String }))
const decodeEnrollRequest = Schema.decodeUnknownOption(EnrollRequest)
const decodeLogin = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ password: Schema.String, next: Schema.optional(Schema.String) })),
)
const decodeProvider = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optional(Schema.String),
      baseURL: Schema.optional(Schema.String),
      apiKey: Schema.String,
    }),
  ),
)
const decodeChatGPTComplete = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ attempt: Schema.String, callback: Schema.String })),
)

export async function start(options: Options) {
  const store = Store.open(options.data)
  const fixed = options.password ?? process.env.OPENCODE_HUB_PASSWORD
  const fixedHash = fixed ? await Bun.password.hash(fixed) : undefined
  const generated = fixedHash || store.setting(PASSWORD_KEY) ? undefined : await setStoredPassword(store)
  if (generated) console.log(`opencode hub password (shown once): ${generated}`)
  const auth = Auth.create()
  const chatgpt = ChatGPT.create({
    store,
    options: options.chatgpt,
    app: { name: "hub", version: options.version ?? "local" },
  })
  const catalog = Catalog.create({ data: options.data, ...options.catalog })
  const tunnels = new Map<string, Tunnel.Instance>()
  const pings = new Map<Tunnel.Instance, Timer>()
  const listeners = new Set<Listener>()

  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 4800,
    // Proxied responses such as SSE stay idle for long periods; they must not be cut by the server.
    idleTimeout: 0,
    fetch: (request, server) => handle(request, server),
    websocket: {
      data: {} as Tunnel.SocketData,
      maxPayloadLength: 64 * 1024 * 1024,
      open(ws) {
        const data = ws.data
        if (data.kind === "client") return data.tunnel.clientOpen(ws, data.stream)
        setTimeout(() => {
          if (!data.tunnel) ws.close(4400, "expected HELLO")
        }, HELLO_TIMEOUT)
      },
      message(ws, message) {
        const data = ws.data
        if (data.kind === "client")
          return data.tunnel.clientMessage(data.stream, typeof message === "string" ? message : new Uint8Array(message))
        const frame = Protocol.decode(message)
        if (!data.tunnel) return hello(ws, data, frame)
        if (!frame) return
        if (frame.stream !== 0) return data.tunnel.receive(frame)
        if (frame.type === Protocol.Type.PONG) store.touchMachine(data.machine.id)
      },
      close(ws, code, reason) {
        const data = ws.data
        if (data.kind === "client") return data.tunnel.clientClose(data.stream, code, reason)
        if (!data.tunnel) return
        clearInterval(pings.get(data.tunnel))
        pings.delete(data.tunnel)
        data.tunnel.dispose()
        if (tunnels.get(data.machine.id) !== data.tunnel) return
        tunnels.delete(data.machine.id)
        store.touchMachine(data.machine.id)
        notifyMachines()
      },
    },
  })

  const base = new URL(options.url ?? `http://localhost:${server.port}`)
  const domain = base.host.toLowerCase()
  const origin = base.origin
  const secure = base.protocol === "https:"
  const machineOrigin = (id: string) => `${base.protocol}//${id}.${domain}`

  return {
    url: origin,
    port: server.port ?? 0,
    /** The password generated on this first start, when one was generated. */
    password: generated,
    /** Issues a one-time enrollment code, as the dashboard's "Add machine" does. */
    createEnrollmentCode: () => auth.createCode(),
    async stop() {
      pings.forEach((timer) => clearInterval(timer))
      listeners.forEach((listener) => listener.close())
      tunnels.forEach((tunnel) => tunnel.ws.close(1001, "hub stopping"))
      await server.stop(true)
      store.close()
    },
  }

  async function handle(request: Request, server: Server<Tunnel.SocketData>) {
    const url = new URL(request.url)
    const host = (request.headers.get("host") ?? url.host).toLowerCase()
    if (host === domain) return hubRoute(request, url, server)
    if (host.endsWith(`.${domain}`)) return machineRoute(request, url, server, host.slice(0, -domain.length - 1))
    // Direct requests such as Caddy's on-demand TLS check reach the hub by IP address.
    if (url.pathname === "/hub/health" || url.pathname === "/hub/tls-allowed") return hubRoute(request, url, server)
    return redirect(`${origin}${url.pathname}${url.search}`)
  }

  async function hubRoute(request: Request, url: URL, server: Server<Tunnel.SocketData>) {
    const pathname = url.pathname
    if (pathname === "/hub/health") return new Response("ok")
    if (pathname === "/hub/tls-allowed") return tlsAllowed(url)
    if (pathname === "/hub/agent/enroll") return enroll(request, server)
    if (pathname === "/hub/agent/connect") return connect(request, server)
    if (pathname.startsWith("/llm/")) return Llm.proxy(request, url, store, chatgpt)
    if (pathname.startsWith("/hub/api/")) return api(request, pathname.slice("/hub/api/".length), server)
    const session = auth.session(Auth.readCookie(request.headers.get("cookie")))
    if (pathname === "/hub/handoff") {
      if (session) return handoff(url, session)
      const next = url.searchParams.get("next")
      return redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login")
    }
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method not allowed", { status: 405 })
    // A machine host sends signed-out browsers here; one that is already signed in goes straight on.
    if (pathname === "/login" && session) {
      const next = url.searchParams.get("next") ?? ""
      return redirect(next ? `/hub/handoff?next=${encodeURIComponent(next)}` : "/")
    }
    return serveUI(pathname)
  }

  async function api(request: Request, route: string, server: Server<Tunnel.SocketData>) {
    const method = request.method
    if (method !== "GET" && method !== "HEAD") {
      if (request.headers.get("origin") !== origin) return forbidden()
      if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? ""))
        return json(415, { error: "Expected a JSON request body." })
    }
    if (route === "login" && method === "POST") return login(request, server)
    const session = auth.session(Auth.readCookie(request.headers.get("cookie")))
    if (route === "session" && method === "GET")
      return session ? json(200, { authenticated: true }) : json(401, { authenticated: false })
    if (!session) return json(401, { error: "Sign in to the hub first." })
    if (route === "logout" && method === "POST") {
      auth.deleteSession(session)
      listeners.forEach((listener) => listener.session === session && listener.close())
      return json(200, {}, Auth.clearCookie(secure))
    }
    if (route === "machines" && method === "GET") return json(200, machineList())
    if (route === "events" && method === "GET") return events(session)
    if (route === "machines/code" && method === "POST") {
      const code = auth.createCode()
      // Without --code, `agent join` asks for the code without echo, so it stays out of the shell history.
      return json(200, { ...code, command: `opencode agent join ${origin}` })
    }
    const machine = /^machines\/([^/]+)$/.exec(route)
    if (machine && method === "DELETE") {
      const id = decodeURIComponent(machine[1])
      if (!store.deleteMachine(id)) return json(404, { error: "Unknown machine." })
      tunnels.get(id)?.ws.close(4403, "machine revoked")
      tunnels.delete(id)
      notifyMachines()
      return new Response(null, { status: 204 })
    }
    if (route === "providers" && method === "GET") return json(200, providerList())
    if (route === "providers" && method === "POST") return saveProvider(request)
    if (route === "presets" && method === "GET") return json(200, await catalog.list())
    if (route === "providers/chatgpt/begin" && method === "POST") return json(200, chatgpt.begin())
    if (route === "providers/chatgpt/complete" && method === "POST") {
      const body = Option.getOrUndefined(decodeChatGPTComplete(await request.text()))
      if (!body) return json(400, { error: "Expected { attempt, callback }." })
      const failure = await chatgpt.complete(body).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
      if (failure) return json(400, { error: failure })
      pushConfig()
      return json(200, { provider: providerList().find((provider) => provider.id === ChatGPT.PROVIDER.id) })
    }
    const provider = /^providers\/([^/]+)$/.exec(route)
    if (provider && method === "DELETE") {
      if (!store.deleteProvider(decodeURIComponent(provider[1]))) return json(404, { error: "Unknown provider." })
      pushConfig()
      return new Response(null, { status: 204 })
    }
    return json(404, { error: "Not found." })
  }

  async function login(request: Request, server: Server<Tunnel.SocketData>) {
    const client = clientAddress(request, server)
    const wait = auth.throttled(client)
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000)
      return json(429, { error: `Too many failed attempts. Try again in ${seconds} s.`, retryAfter: seconds })
    }
    const body = Option.getOrUndefined(decodeLogin(await request.text()))
    const hash = fixedHash ?? store.setting(PASSWORD_KEY)
    const valid = body !== undefined && hash !== undefined && (await Bun.password.verify(body.password, hash))
    if (!valid) {
      auth.fail(client)
      return json(401, { error: "Wrong password." })
    }
    auth.succeed(client)
    const next = body.next ?? ""
    return json(
      200,
      { redirect: next ? `/hub/handoff?next=${encodeURIComponent(next)}` : "/" },
      Auth.sessionCookie(auth.createSession(), secure),
    )
  }

  async function saveProvider(request: Request) {
    const body = Option.getOrUndefined(decodeProvider(await request.text()))
    if (!body) return json(400, { error: "Expected { id, apiKey, name?, baseURL? }." })
    const id = body.id.trim()
    // A catalog provider needs only its id; a custom one passes its own name and upstream.
    const entry = await catalog.find(id)
    const baseURL = body.baseURL?.trim() || entry?.baseURL || ""
    const apiKey = body.apiKey.trim()
    if (!PROVIDER_ID.test(id))
      return json(400, { error: "Provider id must be letters, digits, dots, dashes or underscores." })
    if (!/^https?:$/.test(URL.parse(baseURL)?.protocol ?? ""))
      return json(400, { error: "Upstream base URL must be http(s)." })
    if (!apiKey) return json(400, { error: "API key is required." })
    const name = body.name?.trim() || entry?.name || id
    store.saveProvider({ id, name, baseURL, apiKey })
    pushConfig()
    return json(200, { provider: { id, name, baseURL, auth: "key" } })
  }

  function events(session: string) {
    const encoder = new TextEncoder()
    const state = {} as { listener?: Listener; timer?: Timer }
    const cleanup = () => {
      clearInterval(state.timer)
      if (state.listener) listeners.delete(state.listener)
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (text: string) => controller.enqueue(encoder.encode(text))
        state.listener = {
          session,
          send,
          close() {
            cleanup()
            controller.close()
          },
        }
        listeners.add(state.listener)
        state.timer = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_INTERVAL)
        send(`retry: 2000\n${machinesEvent()}`)
      },
      cancel: cleanup,
    })
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    })
  }

  function machinesEvent() {
    return `event: machines\ndata: ${JSON.stringify(machineList())}\n\n`
  }

  function notifyMachines() {
    if (listeners.size === 0) return
    const event = machinesEvent()
    listeners.forEach((listener) => listener.send(event))
  }

  function machineList() {
    return store.machines().map((machine) => ({
      id: machine.id,
      name: machine.name,
      online: tunnels.has(machine.id),
      lastSeenAt: machine.last_seen_at,
      url: `/hub/handoff?next=${encodeURIComponent(`${machineOrigin(machine.id)}/`)}`,
    }))
  }

  function providerList() {
    return store.providerSummaries().map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseURL: provider.base_url,
      auth: provider.auth,
    }))
  }

  function serveUI(pathname: string) {
    const key = pathname.replace(/^\/+/, "")
    const ui = options.ui
    if (!ui) return Html.respond(Html.message("Web UI missing", MISSING_UI), { status: 503 })
    // The main app's shell is for machine hosts; the hub host only serves its own page and the shared assets.
    const asset = key && key !== "index.html" && key !== "hub.html" ? ui.file(key) : undefined
    if (asset) return assetResponse(key, asset)
    if (/^(?:_assets|assets|icons)\//.test(key) || /\.[a-z0-9]+$/i.test(key))
      return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } })
    const page = ui.file("hub.html")
    if (!page) return Html.respond(Html.message("Web UI missing", MISSING_UI), { status: 503 })
    const html = typeof page.body === "string" ? page.body : new TextDecoder().decode(page.body)
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        "content-security-policy": csp(html),
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "same-origin",
      },
    })
  }

  async function machineRoute(request: Request, url: URL, server: Server<Tunnel.SocketData>, label: string) {
    const machine = LABEL.test(label) ? store.machine(label) : undefined
    if (!machine) {
      const body = `<p class="muted">No machine is registered under this address.</p><p><a href="${Html.escape(origin)}/">Back to the hub</a></p>`
      return Html.respond(Html.message("Unknown machine", body), { status: 404 })
    }
    if (url.pathname === SESSION_PATH) return session(url, machine)
    const cookie = request.headers.get("cookie")
    const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket"
    if (!auth.session(Auth.readCookie(cookie))) {
      if (upgrade || (request.method !== "GET" && request.method !== "HEAD"))
        return new Response("Unauthorized", { status: 401 })
      return redirect(
        `${origin}/login?next=${encodeURIComponent(`${machineOrigin(machine.id)}${url.pathname}${url.search}`)}`,
      )
    }
    // The agent drops Origin before reaching the local server, so the hub enforces same-origin itself: sibling
    // machine hosts are same-site and would otherwise ride the Lax session cookie.
    const requestOrigin = request.headers.get("origin")
    if (requestOrigin && requestOrigin !== machineOrigin(machine.id)) return forbidden()
    const tunnel = tunnels.get(machine.id)
    if (!tunnel) {
      const body = `<p class="muted">${Html.escape(machine.name)} is not connected to the hub right now. Start <code>opencode agent run</code> on it, then reload this page.</p><p><a href="${Html.escape(origin)}/">Back to the dashboard</a></p>`
      return Html.respond(Html.message("Machine offline", body), { status: 503 })
    }
    // The hub's own credentials never reach the machine.
    const headers = Array.from(request.headers).filter((entry) => {
      const name = entry[0].toLowerCase()
      return name !== "authorization" && name !== "cookie"
    })
    const cookies = Auth.stripCookie(cookie)
    if (cookies) headers.push(["cookie", cookies])
    const path = `${url.pathname}${url.search}`
    if (upgrade) return tunnel.websocket(request, server, path, headers)
    return tunnel.http(request, path, headers)
  }

  function session(url: URL, machine: Store.Machine) {
    const id = auth.consumeTicket(url.searchParams.get("ticket") ?? "", machine.id)
    if (!id) return redirect(`${origin}/login?next=${encodeURIComponent(`${machineOrigin(machine.id)}/`)}`)
    const next = url.searchParams.get("next") ?? "/"
    const local = next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/"
    return redirect(local, Auth.sessionCookie(id, secure))
  }

  function handoff(url: URL, session: string) {
    const next = URL.parse(url.searchParams.get("next") ?? "")
    if (!next || next.protocol !== base.protocol) return redirect("/")
    const host = next.host.toLowerCase()
    if (host === domain) return redirect(`${next.pathname}${next.search}`)
    const machine = host.endsWith(`.${domain}`) ? store.machine(host.slice(0, -domain.length - 1)) : undefined
    if (!machine) return redirect("/")
    const ticket = auth.createTicket(session, machine.id)
    const target = new URL(SESSION_PATH, machineOrigin(machine.id))
    target.searchParams.set("ticket", ticket)
    target.searchParams.set("next", `${next.pathname}${next.search}`)
    return redirect(target.toString())
  }

  async function enroll(request: Request, server: Server<Tunnel.SocketData>) {
    if (request.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 })
    const client = clientAddress(request, server)
    if (auth.throttled(client) > 0) return Response.json({ error: "too many attempts" }, { status: 429 })
    const body = Option.getOrUndefined(decodeEnrollRequest(await request.text()))
    const name = body?.name.trim().slice(0, 100)
    if (!body || !name) return Response.json({ error: "expected { code, name }" }, { status: 400 })
    if (!auth.consumeCode(body.code)) {
      auth.fail(client)
      return Response.json({ error: "invalid or expired enrollment code" }, { status: 403 })
    }
    const enrolled = store.createMachine(name)
    notifyMachines()
    return Response.json({ ...enrolled, url: origin })
  }

  function connect(request: Request, server: Server<Tunnel.SocketData>) {
    const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
    const machine = token ? store.machineByTunnelToken(token) : undefined
    if (!machine) return Response.json({ error: "unknown or revoked machine" }, { status: 401 })
    if (server.upgrade(request, { data: { kind: "tunnel", machine } })) return undefined
    return Response.json({ error: "expected a WebSocket upgrade" }, { status: 426 })
  }

  function hello(
    ws: ServerWebSocket<Tunnel.SocketData>,
    data: Extract<Tunnel.SocketData, { kind: "tunnel" }>,
    frame: Protocol.Frame | undefined,
  ) {
    const greeting =
      frame?.type === Protocol.Type.HELLO && frame.stream === 0 ? Protocol.decodeHello(frame.payload) : undefined
    if (!greeting) return ws.close(4400, "expected HELLO")
    if (greeting.protocol !== Protocol.VERSION)
      return ws.close(4400, `unsupported protocol ${greeting.protocol}; this hub speaks protocol ${Protocol.VERSION}`)
    const machine = store.machine(data.machine.id)
    if (!machine) return ws.close(4403, "machine revoked")
    tunnels.get(machine.id)?.ws.close(4409, "replaced by a new connection")
    const tunnel = Tunnel.create(ws, machine)
    data.tunnel = tunnel
    tunnels.set(machine.id, tunnel)
    store.touchMachine(machine.id)
    notifyMachines()
    tunnel.send(
      Protocol.encodeJson(Protocol.Type.READY, 0, {
        machine: { id: machine.id, name: machine.name },
        llm: llmConfig(),
      }),
    )
    pings.set(
      tunnel,
      setInterval(() => tunnel.send(Protocol.encode(Protocol.Type.PING, 0)), options.pingInterval ?? PING_INTERVAL),
    )
  }

  function llmConfig(): Protocol.LlmConfig {
    return {
      baseURL: `${origin}/llm`,
      providers: store.providers().map((provider) => ({ id: provider.id, name: provider.name })),
    }
  }

  function pushConfig() {
    const frame = Protocol.encodeJson(Protocol.Type.CONFIG, 0, llmConfig())
    tunnels.forEach((tunnel) => tunnel.send(frame))
  }

  function tlsAllowed(url: URL) {
    const requested = (url.searchParams.get("domain") ?? "").toLowerCase()
    const hostname = base.hostname.toLowerCase()
    if (requested === hostname) return new Response("ok")
    const label = requested.endsWith(`.${hostname}`) ? requested.slice(0, -hostname.length - 1) : ""
    if (LABEL.test(label) && store.machine(label)) return new Response("ok")
    return new Response("not allowed", { status: 404 })
  }
}

/** Sets the stored hub password (generating one when omitted) and returns it. */
export async function setPassword(input: { data: string; password?: string }) {
  const store = Store.open(input.data)
  const password = await setStoredPassword(store, input.password)
  store.close()
  return password
}

async function setStoredPassword(store: Store.Instance, password = Store.randomToken().slice(0, 24)) {
  store.setSetting(PASSWORD_KEY, await Bun.password.hash(password))
  return password
}

/** Behind a local reverse proxy every peer is loopback, so the forwarded client address is used instead. */
function clientAddress(request: Request, server: Server<Tunnel.SocketData>) {
  const peer = server.requestIP(request)?.address ?? "unknown"
  const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1"
  const forwarded = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim()
  return loopback && forwarded ? forwarded : peer
}

function redirect(location: string, cookie?: string) {
  const headers = new Headers({ location, "cache-control": "no-store" })
  if (cookie) headers.set("set-cookie", cookie)
  return new Response(null, { status: 302, headers })
}

function forbidden() {
  return new Response("Cross-origin request refused", { status: 403 })
}

function json(status: number, body: unknown, cookie?: string) {
  const headers = new Headers({ "cache-control": "no-store" })
  if (cookie) headers.set("set-cookie", cookie)
  return Response.json(body, { status, headers })
}

function assetResponse(key: string, asset: { body: string | Uint8Array; type: string }) {
  // Vite content-hashes everything under `_assets/`; other files (fonts, icons) keep their names across releases.
  const immutable = key.startsWith("_assets/")
  // The copy gives DOM typings the ArrayBuffer-backed view they require.
  return new Response(typeof asset.body === "string" ? asset.body : new Uint8Array(asset.body), {
    headers: {
      "content-type": asset.type,
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600, must-revalidate",
      "x-content-type-options": "nosniff",
    },
  })
}

/** Allows the page's inline theme preload script by hash, like the CLI's web UI does. */
function csp(html: string) {
  const script = html.match(
    /<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(["'])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i,
  )?.[2]
  const hash = script === undefined ? "" : ` 'sha256-${createHash("sha256").update(script).digest("base64")}'`
  return `default-src 'self'; script-src 'self'${hash}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`
}

const MISSING_UI = `<p>This hub was started without its web interface. In a source checkout, build it with <code>bun run --cwd packages/app build</code> and restart <code>opencode hub</code>. Release builds embed it.</p>`
