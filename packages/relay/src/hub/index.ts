import type { Server, ServerWebSocket } from "bun"
import { createHash } from "node:crypto"
import { Option, Schema } from "effect"
import { Protocol } from "../protocol.js"
import { Skills } from "../skills.js"
import { Accounts, json } from "./accounts.js"
import { Auth } from "./auth.js"
import { Catalog } from "./catalog.js"
import { ChatGPT } from "./chatgpt.js"
import { Connectors } from "./connectors.js"
import { Egress } from "./egress.js"
import { Html } from "./html.js"
import { Llm } from "./llm.js"
import { Mcp } from "./mcp.js"
import { McpOAuth } from "./mcp-oauth.js"
import { Orgs } from "./orgs.js"
import { Providers } from "./providers.js"
import { HubSkills } from "./skills.js"
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
  /** Directory holding `hub.db` and the OPAQUE server key; kept owner-only. */
  data: string
  /** Milliseconds between tunnel PINGs. */
  pingInterval?: number
  /** The dashboard's assets. Without them the hub host serves a page explaining how to build them. */
  ui?: UI
  chatgpt?: ChatGPT.Options
  /** Where the provider catalog comes from; defaults to models.dev. */
  catalog?: { source?: string; fetch?: typeof fetch }
  /** The running opencode version, sent to OpenAI when signing in with ChatGPT. */
  version?: string
  /** Where connectors may point (see `Egress`): by default public HTTPS servers only. */
  mcp?: Egress.Options
}

/** A browser following `/hub/api/events`; it only ever hears about its user's machines. */
type Listener = { session: string; user: string; send: (text: string) => void; close: () => void }

/** The public URL the hub last started with, so `opencode hub invite` can print a full link. */
const URL_KEY = "url"
const DEFAULT_URL = "http://localhost:4800"
// The machine's web app installs a service worker that answers every navigation with its own index.html except under
// /api and /auth, so the handoff has to live under /auth to reach the hub once that worker is installed.
const SESSION_PATH = "/auth/hub-session"
const PING_INTERVAL = 25_000
const KEEPALIVE_INTERVAL = 25_000
const HELLO_TIMEOUT = 10_000
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const PROVIDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
/** The provider changes, all of which seal a secret under the user's key. */
const PROVIDER_ROUTES = new Set(["providers", "providers/chatgpt/begin", "providers/chatgpt/complete"])
const EnrollRequest = Schema.fromJsonString(Schema.Struct({ code: Schema.String, name: Schema.String }))
const decodeEnrollRequest = Schema.decodeUnknownOption(EnrollRequest)
const decodeCodeRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ org: Schema.optional(Schema.String) })),
)
/** The same answer whether a code is unknown, expired, or its author may no longer enroll what it was issued for. */
const INVALID_CODE = "invalid or expired enrollment code"
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
  const setup = await Accounts.loadServerSetup(options.data)
  const store = Store.open(options.data)
  const auth = Auth.create()
  const providers = Providers.create({ store, key: auth.key })
  const chatgpt = ChatGPT.create({
    store,
    providers,
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
  store.setSetting(URL_KEY, origin)
  const egress = Egress.create({
    options: options.mcp,
    hostname: base.hostname,
    listen: { hostname: options.hostname ?? "127.0.0.1", port: server.port ?? 0 },
  })
  const connectors = Connectors.create({ store, key: auth.key, egress, changed: (user) => pushConfig(user) })
  const oauth = McpOAuth.create({
    connectors,
    egress,
    origin,
    key: auth.key,
    app: { name: "hub", version: options.version ?? "local" },
  })
  const accounts = Accounts.create({
    store,
    auth,
    setup,
    origin,
    secure,
    closed(sessions) {
      listeners.forEach((listener) => sessions.includes(listener.session) && listener.close())
      recheckStreams()
    },
    // A reset or disabled account loses its instances; enabled again (or given adopted machines), its personal
    // machines get one back.
    reset: () => syncInstances(),
    updated: () => syncInstances(),
  })
  // A skill change goes to every connected instance whose effective skills it changes.
  const skills = HubSkills.create({ store, changed: () => pushSkills() })
  const orgs = Orgs.create({
    store,
    changed() {
      // A removed member's open streams to the organization's machines close now, not at their next request, and
      // their instances there are deleted.
      recheckStreams()
      syncInstances()
      notifyMachines()
      // Joining, leaving, renaming (which orders organizations) or deleting an organization changes inherited skills.
      pushSkills()
    },
  })

  return {
    url: origin,
    port: server.port ?? 0,
    /** How many accounts exist; none means the first administrator still has to be invited. */
    userCount: () => store.userCount(),
    /** Issues an invitation and returns its one-time link, as `opencode hub invite` does. */
    invite: (role: Store.Role) => accounts.invite(role),
    /**
     * Issues a one-time enrollment code for a user's new machine, or for one of an organization they belong to, as
     * the dashboard's "Add machine" does.
     */
    createEnrollmentCode: (user: string, org?: string) => auth.createCode(user, org),
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
    if (pathname.startsWith("/llm/")) return Llm.proxy(request, url, { store, providers, allowed: mayOpen, chatgpt })
    if (pathname.startsWith("/mcp/"))
      return Mcp.proxy(request, url, { store, connectors, oauth, egress, allowed: mayOpen, origin })
    if (pathname === McpOAuth.CALLBACK_PATH) return oauthCallback(request, url)
    if (pathname.startsWith("/hub/api/")) return api(request, pathname.slice("/hub/api/".length), server)
    const current = accounts.current(request)
    if (pathname === "/hub/handoff") {
      if (current) return handoff(url, current)
      const next = url.searchParams.get("next")
      return redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login")
    }
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method not allowed", { status: 405 })
    // A machine host sends signed-out browsers here; one that is already signed in goes straight on.
    if (pathname === "/login" && current) {
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
    const handled = await accounts.handle(request, route, clientAddress(request, server))
    if (handled) return handled
    const current = accounts.current(request)
    if (!current) return json(401, { error: "Sign in to the hub first." })
    const user = current.user
    // Before `orgs`, which owns every other `orgs/…` route.
    const skill = await skills.handle(request, route, current)
    if (skill) return skill
    const organizations = await orgs.handle(request, route, current)
    if (organizations) return organizations
    const connector = await connectors.handle(request, route, current)
    if (connector) return connector
    const signIn = /^connectors\/([^/]+)\/oauth\/begin$/.exec(route)
    if (signIn && method === "POST") return beginOAuth(user.id, decodeURIComponent(signIn[1]))
    if (route === "machines" && method === "GET") return json(200, machineList(user.id))
    if (route === "events" && method === "GET") return events(current)
    if (route === "admin/machines" && method === "GET") {
      if (user.role !== "admin") return json(403, { error: "Only hub administrators can do this." })
      return json(200, allMachines())
    }
    if (route === "machines/code" && method === "POST") {
      const body = Option.getOrUndefined(decodeCodeRequest(await request.text()))
      if (!body) return json(400, { error: "Expected { org? }." })
      // Only a member enrolls a machine for an organization, administrators included; checked again at enrollment.
      if (body.org !== undefined && !(store.org(body.org) && store.isMember(body.org, user.id)))
        return json(403, { error: "You are not a member of this organization." })
      const code = auth.createCode(user.id, body.org)
      // Without --code, `agent join` asks for the code without echo, so it stays out of the shell history.
      return json(200, { ...code, command: `opencode agent join ${origin}` })
    }
    const machine = /^machines\/([^/]+)$/.exec(route)
    if (machine && method === "DELETE") {
      const id = decodeURIComponent(machine[1])
      // A machine the user may not open does not exist for them, unless they administer the hub.
      const target = store.machine(id)
      if (!target || (user.role !== "admin" && !canOpen(user, target))) return json(404, { error: "Unknown machine." })
      if (!canRevoke(user, target))
        return json(403, { error: "Only the member who enrolled this machine or an administrator can revoke it." })
      const instances = store.instancesOf(id)
      if (!store.deleteMachine(id)) return json(404, { error: "Unknown machine." })
      // The agent deletes its instances before it stops for good.
      const tunnel = tunnels.get(id)
      instances.forEach((instance) => tunnel?.send(Protocol.encodeJson(Protocol.Type.DROP, 0, { iid: instance.id })))
      tunnel?.ws.close(4403, "machine revoked")
      tunnels.delete(id)
      notifyMachines()
      return new Response(null, { status: 204 })
    }
    if (route === "providers" && method === "GET") return json(200, providerList(user.id))
    if (route === "presets" && method === "GET") return json(200, await catalog.list())
    const provider = /^providers\/([^/]+)$/.exec(route)
    // Removing a provider needs no key: nothing is decrypted.
    if (provider && method === "DELETE") {
      if (!providers.delete(user.id, decodeURIComponent(provider[1]))) return json(404, { error: "Unknown provider." })
      pushConfig(user.id)
      return new Response(null, { status: 204 })
    }
    if (!PROVIDER_ROUTES.has(route) || method !== "POST") return json(404, { error: "Not found." })
    // Every provider change seals a secret under the user's key, so it needs that key in memory.
    if (!auth.unlocked(user.id)) return locked()
    if (route === "providers") return saveProvider(request, user.id)
    if (route === "providers/chatgpt/begin")
      return chatgpt.begin(user.id).then(
        (started) => json(200, started),
        (error: unknown) => (error instanceof Providers.LockedError ? locked() : Promise.reject(error)),
      )
    if (route === "providers/chatgpt/complete") {
      const body = Option.getOrUndefined(decodeChatGPTComplete(await request.text()))
      if (!body) return json(400, { error: "Expected { attempt, callback }." })
      const failure = await chatgpt.complete(user.id, body).then(
        () => undefined,
        (error: unknown) => error,
      )
      if (failure instanceof Providers.LockedError) return locked()
      if (failure) return json(400, { error: failure instanceof Error ? failure.message : String(failure) })
      pushConfig(user.id)
      return json(200, { provider: providerList(user.id).find((entry) => entry.id === ChatGPT.PROVIDER.id) })
    }
    return json(404, { error: "Not found." })
  }

  /** Starts a connector's OAuth sign-in; the dashboard sends the browser to the returned URL. */
  async function beginOAuth(user: string, id: string) {
    const started = await oauth.begin(user, id).then(
      (value) => value,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    )
    if (started instanceof Providers.LockedError) return locked()
    if (started instanceof McpOAuth.OAuthError) return json(400, { error: started.message })
    if (started instanceof Error) throw started
    return json(200, started)
  }

  /**
   * The authorization server sends the browser back here. The sign-in belongs to the user who started it: another
   * session, or none, cannot finish it. Back to the dashboard on success, an explanation otherwise.
   */
  async function oauthCallback(request: Request, url: URL) {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 })
    const current = accounts.current(request)
    const back = `<p><a href="${Html.escape(origin)}/">Back to the dashboard</a></p>`
    if (!current)
      return Html.respond(
        Html.message("Sign-in not finished", `<p class="muted">Sign in to the hub, then connect again.</p>${back}`),
        { status: 401 },
      )
    const finished = await oauth.complete(current.user.id, url).then(
      (value) => value,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    )
    if (finished instanceof Providers.LockedError || finished instanceof McpOAuth.OAuthError)
      return Html.respond(
        Html.message("Sign-in not finished", `<p class="muted">${Html.escape(finished.message)}</p>${back}`),
        { status: 400 },
      )
    if (finished instanceof Error) throw finished
    return redirect(`/?connector=${encodeURIComponent(finished)}`)
  }

  async function saveProvider(request: Request, user: string) {
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
    const saved = await providers.saveKey(user, { id, name, baseURL, apiKey }).then(
      () => true,
      (error: unknown) => (error instanceof Providers.LockedError ? false : Promise.reject(error)),
    )
    if (!saved) return locked()
    pushConfig(user)
    return json(200, { provider: { id, name, baseURL, auth: "key" } })
  }

  function events(current: Accounts.Current) {
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
          session: current.session,
          user: current.user.id,
          send,
          close() {
            cleanup()
            controller.close()
          },
        }
        listeners.add(state.listener)
        state.timer = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_INTERVAL)
        send(`retry: 2000\n${machinesEvent(current.user.id)}`)
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

  function machinesEvent(user: string) {
    return `event: machines\ndata: ${JSON.stringify(machineList(user))}\n\n`
  }

  function notifyMachines() {
    listeners.forEach((listener) => listener.send(machinesEvent(listener.user)))
  }

  /**
   * The machines a user may open, with their handoff links: personal ones first, then each organization's. `org` is
   * null for a personal machine.
   */
  function machineList(id: string) {
    const user = store.user(id)
    if (!user) return []
    return store.machinesFor(id).map((machine) => ({
      id: machine.id,
      name: machine.name,
      org: machine.owner_org_id === null ? null : { id: machine.owner_org_id, name: machine.org_name ?? "" },
      online: tunnels.has(machine.id),
      lastSeenAt: machine.last_seen_at,
      url: `/hub/handoff?next=${encodeURIComponent(`${machineOrigin(machine.id)}/`)}`,
      canRevoke: canRevoke(user, machine),
    }))
  }

  /**
   * Every machine with its owner (a login, or an organization's name in `org`), for administrators: no handoff link,
   * since they cannot open other users' machines.
   */
  function allMachines() {
    return store.machines().map((machine) => ({
      id: machine.id,
      name: machine.name,
      owner: machine.owner_org_id === null ? machine.owner_login : null,
      org: machine.owner_org_id === null ? null : machine.org_name,
      online: tunnels.has(machine.id),
      lastSeenAt: machine.last_seen_at,
    }))
  }

  /**
   * Whether a user may open a machine: a personal machine only its owner, an organization machine every current
   * member. Anything else, an ownerless machine or one with both owners, opens for nobody.
   */
  function canOpen(user: Store.User, machine: Store.Machine) {
    if (machine.owner_org_id === null) return machine.owner_user_id === user.id
    return machine.owner_user_id === null && store.isMember(machine.owner_org_id, user.id)
  }

  /** Whether a user id names an active account that may open the machine. */
  function mayOpen(id: string, machine: Store.Machine) {
    const user = accounts.activeUser(id)
    return user !== undefined && canOpen(user, machine)
  }

  /** Administrators revoke any machine; owners their own, and members the organization machines they enrolled. */
  function canRevoke(user: Store.User, machine: Store.Machine) {
    if (user.role === "admin") return true
    if (machine.owner_org_id === null) return canOpen(user, machine)
    return canOpen(user, machine) && machine.enrolled_by === user.id
  }

  /**
   * Cuts proxied streams (SSE responses, WebSockets) whose session may no longer open their machine. Each new request
   * is checked on its own; this covers the ones already open when a session ends or an account is disabled.
   */
  function recheckStreams() {
    tunnels.forEach((tunnel) => {
      const machine = store.machine(tunnel.machine.id)
      tunnel.drop((session) => {
        const current = accounts.active(auth.session(session))
        return current !== undefined && machine !== undefined && canOpen(current.user, machine)
      })
    })
  }

  function providerList(user: string) {
    return providers.summaries(user).map((provider) => ({
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
    if (!LABEL.test(label)) return unknownMachine()
    if (url.pathname === SESSION_PATH) return session(url, label)
    const cookie = request.headers.get("cookie")
    const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket"
    // Checked on every request, so a machine stops opening as soon as its owner's account is disabled.
    const current = accounts.current(request)
    if (!current) {
      if (upgrade || (request.method !== "GET" && request.method !== "HEAD"))
        return new Response("Unauthorized", { status: 401 })
      return redirect(
        `${origin}/login?next=${encodeURIComponent(`${machineOrigin(label)}${url.pathname}${url.search}`)}`,
      )
    }
    // Another user's machine answers exactly like one that does not exist.
    const machine = store.machine(label)
    if (!machine || !canOpen(current.user, machine)) return unknownMachine()
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
    // Each user reaches their own instance of the machine, created at their first request.
    const instance = openInstance(tunnel, machine, current.user.id)
    if (upgrade) return tunnel.websocket(request, server, instance, path, headers, current.session)
    return tunnel.http(request, instance, path, headers, current.session)
  }

  function session(url: URL, label: string) {
    const current = accounts.active(auth.consumeTicket(url.searchParams.get("ticket") ?? "", label))
    if (!current) return redirect(`${origin}/login?next=${encodeURIComponent(`${machineOrigin(label)}/`)}`)
    // The ticket was issued for a machine the user owned; ownership is checked again when it is used.
    const machine = store.machine(label)
    if (!machine || !canOpen(current.user, machine)) return unknownMachine()
    const next = url.searchParams.get("next") ?? "/"
    const local = next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/"
    return redirect(local, Auth.sessionCookie(current.session, secure))
  }

  function handoff(url: URL, current: Accounts.Current) {
    const next = URL.parse(url.searchParams.get("next") ?? "")
    if (!next || next.protocol !== base.protocol) return redirect("/")
    const host = next.host.toLowerCase()
    if (host === domain) return redirect(`${next.pathname}${next.search}`)
    const machine = host.endsWith(`.${domain}`) ? store.machine(host.slice(0, -domain.length - 1)) : undefined
    if (!machine || !canOpen(current.user, machine)) return redirect("/")
    const ticket = auth.createTicket(current.session, machine.id)
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
    const code = auth.consumeCode(body.code)
    if (!code) {
      auth.fail(client)
      return Response.json({ error: INVALID_CODE }, { status: 403 })
    }
    // The machine belongs to whoever created the code, only while that account is still active, or to the
    // organization the code names, only while its author is still a member of it.
    const author = accounts.activeUser(code.user)
    if (!author) return Response.json({ error: INVALID_CODE }, { status: 403 })
    if (code.org !== undefined && !(store.org(code.org) && store.isMember(code.org, author.id)))
      return Response.json({ error: INVALID_CODE }, { status: 403 })
    const enrolled = store.createMachine({ name, enrolledBy: author.id, org: code.org })
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
    // The agent keeps the tokens it still holds, as long as they are the current ones.
    const held = new Map((greeting.instances ?? []).map((entry) => [entry.iid, entry]))
    store
      .instancesOf(machine.id)
      .filter((instance) => instance.token_hash !== null && held.get(instance.id)?.hash === instance.token_hash)
      .forEach((instance) => {
        tunnel.held.add(instance.id)
        // The skills the agent already wrote for it: SKILLS follows INSTANCE only when they differ.
        const version = held.get(instance.id)?.skills
        if (version !== undefined) tunnel.skills.set(instance.id, version)
      })
    // A personal machine's owner instance is the machine's own opencode service, configured even before it is opened.
    const owner = machine.owner_org_id === null ? machine.owner_user_id : null
    if (owner !== null && mayOpen(owner, machine)) store.ensureInstance(machine.id, owner)
    const instances = store.instancesOf(machine.id)
    tunnel.send(
      Protocol.encodeJson(Protocol.Type.READY, 0, {
        machine: { id: machine.id, name: machine.name },
        owner: machine.owner_org_id === null ? "user" : "org",
        instances: instances.map((instance) => instance.id),
      }),
    )
    // Configurations may have changed while the machine was offline.
    instances
      .filter((instance) => instance.user_id === owner || tunnel.held.has(instance.id))
      .forEach((instance) => sendInstance(tunnel, instance))
    pings.set(
      tunnel,
      setInterval(() => tunnel.send(Protocol.encode(Protocol.Type.PING, 0)), options.pingInterval ?? PING_INTERVAL),
    )
  }

  /**
   * The user's instance on a machine they may open, created at their first request. Its configuration and a new
   * token go to the agent first, unless it already holds them on this connection.
   */
  function openInstance(tunnel: Tunnel.Instance, machine: Store.Machine, user: string) {
    const instance = store.ensureInstance(machine.id, user)
    if (!tunnel.held.has(instance.id)) sendInstance(tunnel, instance)
    return instance.id
  }

  /**
   * Sends an instance's configuration: its user's providers and connectors (to reach through the relay), and the version of its
   * user's effective skills, followed by the skills themselves when the agent does not have that version. A token is
   * issued, replacing the previous one, only when the agent does not hold the current one.
   */
  function sendInstance(tunnel: Tunnel.Instance, instance: Store.InstanceRow) {
    const token = tunnel.held.has(instance.id) ? undefined : store.issueInstanceToken(instance.id)
    tunnel.held.add(instance.id)
    const effective = skills.effective(instance.user_id).skills
    const version = Skills.version(effective)
    tunnel.send(
      Protocol.encodeJson(Protocol.Type.INSTANCE, 0, {
        iid: instance.id,
        token,
        llm: {
          baseURL: `${origin}/llm`,
          providers: providers
            .summaries(instance.user_id)
            .map((provider) => ({ id: provider.id, name: provider.name })),
        },
        mcp: connectors.summaries(instance.user_id).map((connector) => ({
          id: connector.id,
          name: connector.name,
          url: `${origin}/mcp/${connector.id}`,
        })),
        skills: { version },
      }),
    )
    sendSkills(tunnel, instance.id, effective, version)
  }

  /** Sends SKILLS for an instance unless the agent already has this version. */
  function sendSkills(tunnel: Tunnel.Instance, iid: string, effective: readonly Skills.Skill[], version: string) {
    if (tunnel.skills.get(iid) === version) return
    tunnel.skills.set(iid, version)
    tunnel.send(Protocol.encodeJson(Protocol.Type.SKILLS, 0, { iid, version, skills: effective }))
  }

  /**
   * Sends the new skills of every connected instance whose user's effective skills changed. Only instances the agent
   * holds on this connection: the others get theirs with INSTANCE, before their first stream.
   */
  function pushSkills() {
    const versions = new Map<string, { skills: Skills.Skill[]; version: string }>()
    const of = (user: string) => {
      const known = versions.get(user)
      if (known) return known
      const effective = skills.effective(user).skills
      const entry = { skills: effective, version: Skills.version(effective) }
      versions.set(user, entry)
      return entry
    }
    tunnels.forEach((tunnel) =>
      store
        .instancesOf(tunnel.machine.id)
        .filter((instance) => tunnel.held.has(instance.id))
        .forEach((instance) => {
          const entry = of(instance.user_id)
          sendSkills(tunnel, instance.id, entry.skills, entry.version)
        }),
    )
  }

  /** Sends the new configuration of a user's instances to the connected machines that run them. */
  function pushConfig(user: string) {
    tunnels.forEach((tunnel) =>
      store
        .instancesOf(tunnel.machine.id)
        .filter((instance) => instance.user_id === user && tunnel.held.has(instance.id))
        .forEach((instance) => sendInstance(tunnel, instance)),
    )
  }

  /**
   * Brings instances in line with who may open what: deletes those whose user lost access (their tokens die with
   * them) and tells their agents to drop them, then gives connected personal machines their owner's instance if they
   * lack it (an account enabled again, machines adopted by an administrator).
   */
  function syncInstances() {
    store.pruneInstances().forEach((instance) => {
      const tunnel = tunnels.get(instance.machine_id)
      if (!tunnel) return
      tunnel.held.delete(instance.id)
      tunnel.skills.delete(instance.id)
      tunnel.send(Protocol.encodeJson(Protocol.Type.DROP, 0, { iid: instance.id }))
    })
    tunnels.forEach((tunnel) => {
      const machine = store.machine(tunnel.machine.id)
      const owner = machine?.owner_org_id === null ? machine.owner_user_id : null
      if (!machine || owner === null || !mayOpen(owner, machine) || store.instance(machine.id, owner)) return
      sendInstance(tunnel, store.ensureInstance(machine.id, owner))
    })
  }

  function unknownMachine() {
    const body = `<p class="muted">No machine is registered under this address.</p><p><a href="${Html.escape(origin)}/">Back to the hub</a></p>`
    return Html.respond(Html.message("Unknown machine", body), { status: 404 })
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

/**
 * Writes an invitation straight into the hub's database, for the first administrator or a locked-out hub, and
 * returns its one-time link on the URL the hub last started with. `orgs` names organizations, case-insensitively, for
 * the new account to join; an unknown one throws and nothing is written.
 */
export function invite(input: { data: string; role: Store.Role; orgs?: readonly string[] }) {
  const store = Store.open(input.data)
  const url = store.setting(URL_KEY) ?? DEFAULT_URL
  const orgs = (input.orgs ?? []).map((name) => ({ name, org: store.orgByName(Store.orgName(name) ?? "") }))
  const unknown = orgs.find((entry) => !entry.org)
  if (unknown) {
    store.close()
    throw new Error(`unknown organization: ${unknown.name}`)
  }
  const invitation = store.createInvitation({ role: input.role, orgs: orgs.flatMap((entry) => entry.org?.id ?? []) })
  store.close()
  return {
    url: `${url}/register?invite=${encodeURIComponent(invitation.code)}`,
    expiresAt: invitation.expiresAt,
  }
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

function locked() {
  return json(423, { error: Providers.LOCKED, locked: true })
}

function forbidden() {
  return new Response("Cross-origin request refused", { status: 403 })
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
  // OPAQUE runs in WebAssembly, which needs 'wasm-unsafe-eval' (and nothing that allows eval of scripts).
  return `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`
}

const MISSING_UI = `<p>This hub was started without its web interface. In a source checkout, build it with <code>bun run --cwd packages/app build</code> and restart <code>opencode hub</code>. Release builds embed it.</p>`
