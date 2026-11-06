import type { Server, ServerWebSocket } from "bun"
import { Option, Schema } from "effect"
import { Protocol } from "../protocol.js"
import { Auth } from "./auth.js"
import { Html } from "./html.js"
import { Llm } from "./llm.js"
import { Store } from "./store.js"
import { Tunnel } from "./tunnel.js"

export * as Hub from "./index.js"

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
}

const PASSWORD_KEY = "password_hash"
const PING_INTERVAL = 25_000
const HELLO_TIMEOUT = 10_000
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const EnrollRequest = Schema.fromJsonString(Schema.Struct({ code: Schema.String, name: Schema.String }))
const decodeEnrollRequest = Schema.decodeUnknownOption(EnrollRequest)

export async function start(options: Options) {
  const store = Store.open(options.data)
  const fixed = options.password ?? process.env.OPENCODE_HUB_PASSWORD
  const fixedHash = fixed ? await Bun.password.hash(fixed) : undefined
  const generated = fixedHash || store.setting(PASSWORD_KEY) ? undefined : await setStoredPassword(store)
  if (generated) console.log(`opencode hub password (shown once): ${generated}`)
  const auth = Auth.create()
  const tunnels = new Map<string, Tunnel.Instance>()
  const pings = new Map<Tunnel.Instance, Timer>()

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
    if (pathname.startsWith("/llm/")) return Llm.proxy(request, url, store)
    if (pathname === "/login") return login(request, url, server)
    const session = auth.session(Auth.readCookie(request.headers.get("cookie")))
    if (pathname === "/logout" && request.method === "POST") {
      if (!sameOrigin(request)) return forbidden()
      if (session) auth.deleteSession(session)
      return redirect("/login", Auth.clearCookie(secure))
    }
    if (!session) {
      const next = pathname === "/" ? "" : `?next=${encodeURIComponent(`${origin}${pathname}${url.search}`)}`
      return redirect(`/login${next}`)
    }
    if (pathname === "/hub/handoff") return handoff(url, session)
    if (request.method === "POST") return sameOrigin(request) ? mutate(request, pathname) : forbidden()
    if (pathname === "/" && (request.method === "GET" || request.method === "HEAD")) return dashboard()
    if (pathname === "/hub/machines" && request.method === "GET") return Html.respond(Html.machines(machineList()))
    return Html.respond(Html.message("Not found", ""), { status: 404 })
  }

  async function machineRoute(request: Request, url: URL, server: Server<Tunnel.SocketData>, label: string) {
    const machine = LABEL.test(label) ? store.machine(label) : undefined
    if (!machine) {
      const body = `<p class="muted">No machine is registered under this address.</p><p><a href="${Html.escape(origin)}/">Back to the hub</a></p>`
      return Html.respond(Html.message("Unknown machine", body), { status: 404 })
    }
    if (url.pathname === "/__hub/session") return session(url, machine)
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
    const target = new URL("/__hub/session", machineOrigin(machine.id))
    target.searchParams.set("ticket", ticket)
    target.searchParams.set("next", `${next.pathname}${next.search}`)
    return redirect(target.toString())
  }

  async function login(request: Request, url: URL, server: Server<Tunnel.SocketData>) {
    const current = auth.session(Auth.readCookie(request.headers.get("cookie")))
    const afterLogin = (next: string) => (next ? `/hub/handoff?next=${encodeURIComponent(next)}` : "/")
    if (request.method === "GET" || request.method === "HEAD") {
      const next = url.searchParams.get("next") ?? ""
      if (current) return redirect(afterLogin(next))
      return Html.respond(Html.login({ next }))
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 })
    if (!sameOrigin(request)) return forbidden()
    const form = await request.formData()
    const next = String(form.get("next") ?? "")
    const client = clientAddress(request, server)
    const wait = auth.throttled(client)
    if (wait > 0) {
      const error = `Too many failed attempts. Try again in ${Math.ceil(wait / 1000)} s.`
      return Html.respond(Html.login({ next, error }), { status: 429 })
    }
    const password = form.get("password")
    const hash = fixedHash ?? store.setting(PASSWORD_KEY)
    const valid = typeof password === "string" && hash !== undefined && (await Bun.password.verify(password, hash))
    if (!valid) {
      auth.fail(client)
      return Html.respond(Html.login({ next, error: "Wrong password." }), { status: 401 })
    }
    auth.succeed(client)
    return redirect(afterLogin(next), Auth.sessionCookie(auth.createSession(), secure))
  }

  async function mutate(request: Request, pathname: string) {
    if (pathname === "/machines/code") return dashboard({ code: auth.createCode() })
    const revoke = /^\/machines\/([^/]+)\/revoke$/.exec(pathname)
    if (revoke) {
      store.deleteMachine(revoke[1])
      tunnels.get(revoke[1])?.ws.close(4403, "machine revoked")
      tunnels.delete(revoke[1])
      return redirect("/")
    }
    const remove = /^\/providers\/([^/]+)\/delete$/.exec(pathname)
    if (remove) {
      if (store.deleteProvider(remove[1])) pushConfig()
      return redirect("/")
    }
    if (pathname !== "/providers") return Html.respond(Html.message("Not found", ""), { status: 404 })
    const form = await request.formData()
    const field = (name: string) => String(form.get(name) ?? "").trim()
    const preset = Llm.PRESETS.find((entry) => entry.id === field("preset"))
    const id = field("id") || preset?.id || ""
    const baseURL = field("baseURL") || preset?.baseURL || ""
    const apiKey = field("apiKey")
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id))
      return dashboard({ error: "Provider id must be letters, digits, dots, dashes or underscores." }, 400)
    if (!/^https?:$/.test(URL.parse(baseURL)?.protocol ?? ""))
      return dashboard({ error: "Upstream base URL must be http(s)." }, 400)
    if (!apiKey) return dashboard({ error: "API key is required." }, 400)
    store.saveProvider({ id, name: field("name") || (preset?.id === id ? preset.name : id), baseURL, apiKey })
    pushConfig()
    return redirect("/")
  }

  function dashboard(extra: { code?: { code: string; expiresAt: number }; error?: string } = {}, status = 200) {
    const body = Html.dashboard({
      ...machineList(),
      url: origin,
      providers: store.providers(),
      ...extra,
    })
    return Html.respond(body, { status })
  }

  function machineList() {
    return {
      machines: store.machines(),
      online: (id: string) => tunnels.has(id),
      machineURL: (id: string) => `${machineOrigin(id)}/`,
    }
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
    return Response.json({ ...store.createMachine(name), url: origin })
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

  function sameOrigin(request: Request) {
    const header = request.headers.get("origin")
    if (header) return header === origin
    return URL.parse(request.headers.get("referer") ?? "")?.origin === origin
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
