import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Account } from "../src/account.js"
import { Agent, Hub, Protocol } from "../src/index.js"
import { browser } from "./fixture/browser.js"

const LOGIN = "admin"
const PASSWORD = "hub-secret"
const LOCAL_PASSWORD = "local-secret"
const LARGE = Uint8Array.from({ length: 5 * 1024 * 1024 + 123 }, (_, index) => (index * 31 + 7) % 251)

type Statuses = { list: { status: Agent.Status; detail?: string }[]; waiters: (() => void)[] }

const gates = {
  sse: Promise.withResolvers<void>(),
  llm: Promise.withResolvers<void>(),
  cancelled: Promise.withResolvers<void>(),
}
const localCalls = { count: 0 }

const local = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request, server) {
    const url = new URL(request.url)
    if (url.pathname === "/ws") {
      if (server.upgrade(request, { data: { protocol: request.headers.get("sec-websocket-protocol") } })) return
      return new Response("upgrade failed", { status: 400 })
    }
    if (url.pathname === "/echo")
      return Response.json({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      })
    if (url.pathname === "/hash")
      return new Response(new Bun.CryptoHasher("sha256").update(await request.arrayBuffer()).digest("hex"))
    if (url.pathname === "/large")
      return new Response(LARGE, { headers: { "content-type": "application/octet-stream" } })
    if (url.pathname === "/gzip")
      return new Response(Bun.gzipSync(new TextEncoder().encode("compressed body")), {
        headers: { "content-encoding": "gzip", "content-type": "text/plain" },
      })
    if (url.pathname === "/cookie") return new Response("ok", { headers: { "set-cookie": "local=1; Path=/" } })
    if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: "/echo" } })
    if (url.pathname === "/sse") return eventStream(gates.sse.promise)
    if (url.pathname === "/endless")
      return new Response(
        new ReadableStream({
          start: (controller) => controller.enqueue(new TextEncoder().encode("data: one\n\n")),
          cancel: () => gates.cancelled.resolve(),
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    return new Response("not found", { status: 404 })
  },
  websocket: {
    data: {} as { protocol: string | null },
    message(ws, message) {
      ws.send(message)
    },
  },
})

const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/v1/stream") return eventStream(gates.llm.promise)
    return Response.json({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    })
  },
})

const data = mkdtempSync(path.join(os.tmpdir(), "opencode-relay-"))
const state = {} as {
  hub: Awaited<ReturnType<typeof Hub.start>>
  enrollment: Agent.Enrollment
  agent: ReturnType<typeof Agent.connect>
  ready: Agent.Ready
  instances: Agent.Instance[]
  dropped: string[]
  statuses: Statuses
  cookie: string
  machineURL: string
  userID: string
}

beforeAll(async () => {
  state.hub = await Hub.start({ hostname: "127.0.0.1", port: 0, data, catalog: { fetch: offline } })
  const admin = browser(state.hub.url)
  await Account.register({
    post: admin.post,
    invite: new URL(state.hub.invite("admin").url).searchParams.get("invite") ?? "",
    login: LOGIN,
    password: PASSWORD,
  })
  state.userID = ((await (await admin.request("session")).json()) as { user: { id: string } }).user.id
  state.enrollment = await Agent.enroll({
    url: state.hub.url,
    code: state.hub.createEnrollmentCode(state.userID).code,
    name: "Test Machine",
  })
  state.instances = []
  state.dropped = []
  state.statuses = { list: [], waiters: [] }
  const ready = Promise.withResolvers<Agent.Ready>()
  state.agent = Agent.connect({
    enrollment: state.enrollment,
    // The first resolution points at a closed port, so the first request exercises re-resolution.
    local: async () => {
      localCalls.count++
      return {
        url: localCalls.count === 1 ? "http://127.0.0.1:1" : `http://127.0.0.1:${local.port}`,
        password: LOCAL_PASSWORD,
      }
    },
    onReady: ready.resolve,
    onInstance: (instance) => state.instances.push(instance),
    onDrop: (iid) => state.dropped.push(iid),
    onStatus: record(state.statuses),
  })
  state.ready = await ready.promise
  // A personal machine gets its owner's instance right after READY, before anyone opens it.
  await until(() => state.instances.length > 0)
  state.cookie = await login()
  state.machineURL = `http://${state.enrollment.machine.id}.localhost:${state.hub.port}`
})

afterAll(async () => {
  await state.agent?.close()
  await state.hub?.stop()
  local.stop(true)
  upstream.stop(true)
  rmSync(data, { recursive: true, force: true })
})

describe("enrollment", () => {
  test("derives a DNS-safe machine id and returns the hub URL", () => {
    expect(state.enrollment.machine).toEqual({ id: "test-machine", name: "Test Machine" })
    expect(state.enrollment.url).toBe(`http://localhost:${state.hub.port}`)
    expect(state.ready.machine).toEqual(state.enrollment.machine)
    expect(state.ready.owner).toBe("user")
    expect(state.ready.instances).toEqual([state.instances[0]!.iid])
    expect(state.instances[0]!.llm).toEqual({ baseURL: `${state.hub.url}/llm`, providers: [] })
    expect(state.instances[0]!.token.length).toBeGreaterThan(20)
    expect(JSON.stringify(state.enrollment)).not.toContain(state.instances[0]!.token)
  })

  test("codes are single use", async () => {
    const code = state.hub.createEnrollmentCode(state.userID).code
    await Agent.enroll({ url: state.hub.url, code, name: "other" })
    // A separate forwarded client address keeps the failure throttle away from the other tests.
    const reused = await fetch(`${state.hub.url}/hub/agent/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
      body: JSON.stringify({ code, name: "other" }),
    })
    expect(reused.status).toBe(403)
  })

  test("suffixes taken and reserved ids", async () => {
    const taken = await Agent.enroll({
      url: state.hub.url,
      code: state.hub.createEnrollmentCode(state.userID).code,
      name: "test machine",
    })
    expect(taken.machine.id).toBe("test-machine-2")
    const reserved = await Agent.enroll({
      url: state.hub.url,
      code: state.hub.createEnrollmentCode(state.userID).code,
      name: "HUB",
    })
    expect(reserved.machine.id).toBe("hub-2")
  })
})

describe("browser access", () => {
  test("a machine host without a session redirects to the hub login", async () => {
    const response = await fetch(`${state.machineURL}/echo?x=1`, { redirect: "manual" })
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get("location") ?? "")
    expect(location.origin).toBe(state.hub.url)
    expect(location.pathname).toBe("/login")
    expect(location.searchParams.get("next")).toBe(`${state.machineURL}/echo?x=1`)
  })

  test("login hands the session off to the machine host with a one-time ticket", async () => {
    const next = `${state.machineURL}/echo?x=1`
    const handoff = await fetch(`${state.hub.url}/hub/handoff?next=${encodeURIComponent(next)}`, {
      headers: { cookie: state.cookie },
      redirect: "manual",
    })
    expect(handoff.status).toBe(302)
    const ticketURL = handoff.headers.get("location") ?? ""
    expect(ticketURL.startsWith(`${state.machineURL}/auth/hub-session?ticket=`)).toBe(true)

    const session = await fetch(ticketURL, { redirect: "manual" })
    expect(session.status).toBe(302)
    expect(session.headers.get("location")).toBe("/echo?x=1")
    const cookie = session.headers.get("set-cookie") ?? ""
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Lax")
    expect(cookie).not.toContain("Domain=")

    const proxied = await fetch(`${state.machineURL}/echo?x=1`, { headers: { cookie: cookie.split(";")[0] } })
    expect(proxied.status).toBe(200)

    const reused = await fetch(ticketURL, { redirect: "manual" })
    expect(reused.headers.get("location")?.startsWith(`${state.hub.url}/login`)).toBe(true)
  })

  test("handoff refuses foreign destinations", async () => {
    const response = await fetch(`${state.hub.url}/hub/handoff?next=${encodeURIComponent("http://evil.example/")}`, {
      headers: { cookie: state.cookie },
      redirect: "manual",
    })
    expect(response.headers.get("location")).toBe("/")
  })

  test("login returns the handoff redirect for a machine destination", async () => {
    const next = `${state.machineURL}/echo`
    const client = browser(state.hub.url, { "x-forwarded-for": "203.0.113.11" })
    const result = await Account.login({ post: client.post, login: LOGIN, password: PASSWORD, next })
    expect(result).toEqual({ redirect: `/hub/handoff?next=${encodeURIComponent(next)}` })
    expect(client.jar.cookie).toStartWith("opencode_hub=")
  })

  test("reports the session and signs out", async () => {
    expect((await api("session", { cookie: "" })).status).toBe(401)
    expect(await (await api("session")).json()).toMatchObject({
      authenticated: true,
      user: { login: LOGIN, role: "admin" },
      unlocked: true,
    })
    const cookie = await login()
    const out = await api("logout", { method: "POST", cookie })
    expect(out.status).toBe(200)
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0")
    expect((await api("session", { cookie })).status).toBe(401)
    expect((await api("machines", { cookie })).status).toBe(401)
  })

  test("refuses cross-origin and non-JSON mutations", async () => {
    const foreign = await api("machines/code", { method: "POST", headers: { origin: "http://evil.example" } })
    expect(foreign.status).toBe(403)
    const missing = await api("machines/code", { method: "POST", headers: { origin: "" } })
    expect(missing.status).toBe(403)
    const form = await fetch(`${state.hub.url}/hub/api/machines/code`, {
      method: "POST",
      headers: { cookie: state.cookie, origin: state.hub.url },
      body: new URLSearchParams({ x: "1" }),
    })
    expect(form.status).toBe(415)
  })

  test("issues enrollment codes with the join command", async () => {
    const response = await api("machines/code", { method: "POST" })
    const body = (await response.json()) as { code: string; expiresAt: number; command: string }
    expect(body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(body.expiresAt).toBeGreaterThan(Date.now())
    expect(body.command).toBe(`opencode agent join ${state.hub.url}`)
  })

  test("lists machines with their status and handoff link", async () => {
    const list = (await (await api("machines")).json()) as Machine[]
    const entry = list.find((item) => item.id === "test-machine")
    expect(entry).toMatchObject({ name: "Test Machine", online: true })
    expect(entry?.lastSeenAt).toBeNumber()
    expect(entry?.url).toBe(`/hub/handoff?next=${encodeURIComponent(`${state.machineURL}/`)}`)
  })

  test("pushes the machine list when a machine enrolls, connects and is revoked", async () => {
    const response = await api("events")
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    const events = sse(response.body!.getReader())
    expect((await events.next()).find((item) => item.id === "test-machine")?.online).toBe(true)

    const enrollment = await Agent.enroll({
      url: state.hub.url,
      code: state.hub.createEnrollmentCode(state.userID).code,
      name: "Live",
    })
    expect((await events.next()).find((item) => item.id === "live")).toMatchObject({ online: false })

    const agent = Agent.connect({ enrollment, local: async () => ({ url: `http://127.0.0.1:${local.port}` }) })
    expect((await events.next()).find((item) => item.id === "live")).toMatchObject({ online: true })

    expect((await api("machines/live", { method: "DELETE" })).status).toBe(204)
    const after = await events.until((list) => !list.some((item) => item.id === "live"))
    expect(after.some((item) => item.id === "test-machine")).toBe(true)
    expect((await api("machines/live", { method: "DELETE" })).status).toBe(404)
    await events.cancel()
    await agent.close()
  })

  test("manages providers without exposing keys", async () => {
    const presets = (await (await api("presets")).json()) as { id: string }[]
    expect(presets.map((preset) => preset.id)).toContain("anthropic")
    const saved = await api("providers", { method: "POST", body: { id: "anthropic", apiKey: "sk-secret" } })
    expect(saved.status).toBe(200)
    const invalid = await api("providers", { method: "POST", body: { id: "bad id", baseURL: "x", apiKey: "k" } })
    expect(invalid.status).toBe(400)
    const listed = await (await api("providers")).text()
    expect(JSON.parse(listed)).toContainEqual({
      id: "anthropic",
      name: "Anthropic",
      baseURL: "https://api.anthropic.com/v1",
      auth: "key",
    })
    expect(listed).not.toContain("sk-secret")
    expect((await api("providers/anthropic", { method: "DELETE" })).status).toBe(204)
    expect((await api("providers/anthropic", { method: "DELETE" })).status).toBe(404)
  })

  test("starts a ChatGPT sign-in and reports a bad callback", async () => {
    const begin = (await (await api("providers/chatgpt/begin", { method: "POST" })).json()) as {
      attempt: string
      url: string
    }
    expect(begin.url).toContain("/api/accounts/authorize?")
    const complete = await api("providers/chatgpt/complete", {
      method: "POST",
      body: { attempt: "unknown", callback: "http://127.0.0.1:1455/auth/callback?code=x" },
    })
    expect(complete.status).toBe(400)
    expect(((await complete.json()) as { error: string }).error).toContain("expired")
  })

  test("serves the dashboard page and assets from the web UI", async () => {
    const ui = {
      "hub.html": `<html><script id="oc-theme-preload-script">theme()</script><div id="root"></div></html>`,
      "_assets/hub-abc.js": "console.log(1)",
      "index.html": "<html>main app</html>",
    } as Record<string, string>
    const hub = await Hub.start({
      hostname: "127.0.0.1",
      port: 0,
      data: mkdtempSync(path.join(os.tmpdir(), "opencode-relay-ui-")),
      catalog: { fetch: offline },
      ui: { file: (key) => (ui[key] === undefined ? undefined : { body: ui[key], type: Bun.file(key).type }) },
    })
    const page = await fetch(`${hub.url}/`)
    expect(await page.text()).toBe(ui["hub.html"])
    expect(page.headers.get("cache-control")).toBe("no-cache")
    const hash = new Bun.CryptoHasher("sha256").update("theme()").digest("base64")
    expect(page.headers.get("content-security-policy")).toContain(`'sha256-${hash}'`)
    // OPAQUE's WebAssembly needs this, and only this, relaxation of script-src.
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self' 'wasm-unsafe-eval' 'sha256-")
    expect(await (await fetch(`${hub.url}/login?next=x`)).text()).toBe(ui["hub.html"])
    // The main app shell belongs to machine hosts.
    expect((await fetch(`${hub.url}/index.html`)).status).toBe(404)
    const script = await fetch(`${hub.url}/_assets/hub-abc.js`)
    expect(await script.text()).toBe("console.log(1)")
    expect(script.headers.get("cache-control")).toContain("immutable")
    expect((await fetch(`${hub.url}/_assets/missing.js`)).status).toBe(404)
    await hub.stop()
  })

  test("explains a missing web UI", async () => {
    const response = await fetch(`${state.hub.url}/`)
    expect(response.status).toBe(503)
    expect(await response.text()).toContain("bun run --cwd packages/app build")
  })

  test("a signed-in visit to the login page goes straight on", async () => {
    const next = `${state.machineURL}/echo`
    const response = await fetch(`${state.hub.url}/login?next=${encodeURIComponent(next)}`, {
      headers: { cookie: state.cookie },
      redirect: "manual",
    })
    expect(response.headers.get("location")).toBe(`/hub/handoff?next=${encodeURIComponent(next)}`)
    const anonymous = await fetch(`${state.hub.url}/hub/handoff?next=${encodeURIComponent(next)}`, {
      redirect: "manual",
    })
    expect(anonymous.headers.get("location")).toBe(`/login?next=${encodeURIComponent(next)}`)
  })
})

describe("http proxy", () => {
  test("forwards method, query, body and safe headers, and injects local Basic auth", async () => {
    const response = await machine("/echo?a=1&b=two", {
      method: "POST",
      headers: {
        "x-test": "yes",
        origin: state.machineURL,
        authorization: "Bearer should-not-pass",
        cookie: `${state.cookie}; theme=dark`,
        "content-type": "text/plain",
      },
      body: "hello body",
    })
    expect(response.status).toBe(200)
    const echo = (await response.json()) as {
      method: string
      path: string
      headers: Record<string, string>
      body: string
    }
    expect(echo.method).toBe("POST")
    expect(echo.path).toBe("/echo?a=1&b=two")
    expect(echo.body).toBe("hello body")
    expect(echo.headers["x-test"]).toBe("yes")
    expect(echo.headers.authorization).toBe(`Basic ${btoa(`opencode:${LOCAL_PASSWORD}`)}`)
    expect(echo.headers.origin).toBeUndefined()
    expect(echo.headers.cookie).toBeUndefined()
    expect(echo.headers.host).toBe(`127.0.0.1:${local.port}`)
    // The closed port from the first resolution was replaced after one failed connection; the provider change
    // since then sent a new INSTANCE, which resolves the instance once more.
    expect(localCalls.count).toBe(3)
  })

  test("refuses requests from another origin, including sibling machine hosts", async () => {
    const sibling = new URL(state.machineURL)
    sibling.hostname = `other.${sibling.hostname.split(".").slice(1).join(".")}`
    const response = await machine("/echo", { method: "POST", headers: { origin: sibling.origin }, body: "x" })
    expect(response.status).toBe(403)
    expect(localCalls.count).toBe(3)
  })

  test("passes redirects through and drops machine cookies", async () => {
    const redirect = await machine("/redirect", { redirect: "manual" })
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get("location")).toBe("/echo")
    const cookie = await machine("/cookie")
    expect(await cookie.text()).toBe("ok")
    expect(cookie.headers.get("set-cookie")).toBeNull()
  })

  test("forwards compressed local responses as decoded bytes", async () => {
    const response = await machine("/gzip")
    expect(await response.text()).toBe("compressed body")
  })

  test("streams large bodies intact in both directions", async () => {
    const download = new Uint8Array(await (await machine("/large")).arrayBuffer())
    expect(download.byteLength).toBe(LARGE.byteLength)
    expect(Bun.hash(download)).toBe(Bun.hash(LARGE))
    const upload = await machine("/hash", { method: "POST", body: LARGE })
    expect(await upload.text()).toBe(new Bun.CryptoHasher("sha256").update(LARGE).digest("hex"))
  })

  test("streams SSE events as they are produced", async () => {
    const response = await machine("/sse")
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    const reader = response.body!.getReader()
    // The local server holds the second event until the first one has arrived through the tunnel.
    expect(await readUntil(reader, "data: one\n\n")).toContain("data: one")
    gates.sse.resolve()
    expect(await readUntil(reader, "data: two\n\n")).toContain("data: two")
  })

  test("a browser that goes away aborts the local request", async () => {
    const reader = (await machine("/endless")).body!.getReader()
    expect(await readUntil(reader, "data: one\n\n")).toContain("data: one")
    await reader.cancel()
    await gates.cancelled.promise
  })

  test("unknown machines are 404 and offline machines are 503", async () => {
    expect(
      (await fetch(`http://nobody.localhost:${state.hub.port}/`, { headers: { cookie: state.cookie } })).status,
    ).toBe(404)
    const offline = await fetch(`http://test-machine-2.localhost:${state.hub.port}/`, {
      headers: { cookie: state.cookie },
    })
    expect(offline.status).toBe(503)
    expect(await offline.text()).toContain("Machine offline")
  })
})

describe("websocket proxy", () => {
  test("echoes text and binary messages", async () => {
    const socket = new WebSocket(`ws://${state.enrollment.machine.id}.localhost:${state.hub.port}/ws`, {
      headers: { cookie: state.cookie },
    })
    socket.binaryType = "arraybuffer"
    const messages = queue<string | ArrayBuffer>()
    socket.addEventListener("message", (event) => messages.push(event.data as string | ArrayBuffer))
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve)
      socket.addEventListener("error", reject)
    })
    socket.send("hello")
    expect(await messages.next()).toBe("hello")
    socket.send(new Uint8Array([1, 2, 3, 250]))
    expect(Array.from(new Uint8Array((await messages.next()) as ArrayBuffer))).toEqual([1, 2, 3, 250])
    const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve))
    socket.close(1000, "done")
    expect((await closed).code).toBe(1000)
  })

  test("refuses upgrades without a session", async () => {
    const socket = new WebSocket(`ws://${state.enrollment.machine.id}.localhost:${state.hub.port}/ws`)
    const closed = await new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve))
    expect(closed.code).not.toBe(1000)
  })
})

describe("llm proxy", () => {
  test("pushes provider changes to connected agents", async () => {
    const response = await api("providers", {
      method: "POST",
      body: { id: "fake", name: "Fake", baseURL: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "real-key" },
    })
    expect(response.status).toBe(200)
    await until(() => state.instances.at(-1)?.llm.providers.some((provider) => provider.id === "fake") === true)
    expect(state.instances.at(-1)?.llm).toEqual({
      baseURL: `${state.hub.url}/llm`,
      providers: [{ id: "fake", name: "Fake" }],
    })
    // The same instance and token: a configuration change issues no new token.
    expect(new Set(state.instances.map((instance) => `${instance.iid} ${instance.token}`)).size).toBe(1)
  })

  test("replaces the llm token with the real key wherever it was sent", async () => {
    const token = token0()
    const bearer = await llm("/fake/chat/completions?x=1", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{}",
    })
    expect(bearer.path).toBe("/v1/chat/completions?x=1")
    expect(bearer.method).toBe("POST")
    expect(bearer.body).toBe("{}")
    expect(bearer.headers.authorization).toBe("Bearer real-key")

    const anthropic = await llm("/fake/messages", {
      headers: { "x-api-key": token, authorization: "Bearer untouched" },
    })
    expect(anthropic.headers["x-api-key"]).toBe("real-key")
    expect(anthropic.headers.authorization).toBe("Bearer untouched")

    const google = await llm("/fake/models", { headers: { "x-goog-api-key": token } })
    expect(google.headers["x-goog-api-key"]).toBe("real-key")

    const query = await llm(`/fake/models?alt=sse&key=${token}`, {})
    expect(query.path).toBe("/v1/models?alt=sse&key=real-key")
  })

  test("rejects bad tokens and unknown providers", async () => {
    expect(
      (await fetch(`${state.hub.url}/llm/fake/models`, { headers: { authorization: "Bearer nope" } })).status,
    ).toBe(401)
    const unknown = await fetch(`${state.hub.url}/llm/missing/models`, {
      headers: { authorization: `Bearer ${token0()}` },
    })
    expect(unknown.status).toBe(404)
  })

  test("streams upstream SSE", async () => {
    const response = await fetch(`${state.hub.url}/llm/fake/stream`, {
      headers: { authorization: `Bearer ${token0()}` },
    })
    const reader = response.body!.getReader()
    expect(await readUntil(reader, "data: one\n\n")).toContain("data: one")
    gates.llm.resolve()
    expect(await readUntil(reader, "data: two\n\n")).toContain("data: two")
  })
})

describe("hub endpoints", () => {
  test("health and tls-allowed", async () => {
    expect((await fetch(`http://127.0.0.1:${state.hub.port}/hub/health`)).status).toBe(200)
    const allowed = (domain: string) =>
      fetch(`http://127.0.0.1:${state.hub.port}/hub/tls-allowed?domain=${domain}`).then((response) => response.status)
    expect(await allowed("localhost")).toBe(200)
    expect(await allowed("test-machine.localhost")).toBe(200)
    expect(await allowed("nobody.localhost")).toBe(404)
    expect(await allowed("evil.example")).toBe(404)
  })
})

describe("tunnel lifecycle", () => {
  test("refuses a protocol 1 HELLO with 4400", async () => {
    const enrollment = await Agent.enroll({
      url: state.hub.url,
      code: state.hub.createEnrollmentCode(state.userID).code,
      name: "future",
    })
    const socket = tunnelSocket(enrollment.tunnelToken)
    socket.addEventListener("open", () =>
      socket.send(
        Protocol.encodeJson(Protocol.Type.HELLO, 0, { protocol: 1, version: "9", name: "future", platform: "x" }),
      ),
    )
    const closed = await new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve))
    expect(closed.code).toBe(4400)
    expect(closed.reason).toContain("unsupported protocol 1")
    expect(closed.reason).toContain("protocol 2")
  })

  test("a second connection for the same machine replaces the first with 4409", async () => {
    const enrollment = await Agent.enroll({
      url: state.hub.url,
      code: state.hub.createEnrollmentCode(state.userID).code,
      name: "twin",
    })
    const first = { statuses: { list: [], waiters: [] } as Statuses, ready: Promise.withResolvers<void>() }
    const firstAgent = Agent.connect({
      enrollment,
      local: async () => ({ url: `http://127.0.0.1:${local.port}` }),
      onReady: () => first.ready.resolve(),
      onStatus: record(first.statuses),
    })
    await first.ready.promise
    const second = Promise.withResolvers<void>()
    const secondAgent = Agent.connect({
      enrollment,
      local: async () => ({ url: `http://127.0.0.1:${local.port}` }),
      onReady: () => second.resolve(),
    })
    await second.promise
    await waitStatus(first.statuses, (entry) => entry.status === "stopped")
    expect(first.statuses.list.at(-1)?.detail).toContain("replaced")
    await Promise.all([firstAgent.close(), secondAgent.close()])
  })

  test("the agent answers pings and reconnects when the hub goes silent", async () => {
    const pong = Promise.withResolvers<void>()
    // A fake hub that pings once on connect and then never speaks again.
    const silent = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, server) => (server.upgrade(request, { data: undefined }) ? undefined : new Response("no")),
      websocket: {
        open: (ws) => void ws.sendBinary(Protocol.encode(Protocol.Type.PING, 0)),
        message(_ws, message) {
          if (Protocol.decode(message)?.type === Protocol.Type.PONG) pong.resolve()
        },
      },
    })
    const statuses: Statuses = { list: [], waiters: [] }
    const agent = Agent.connect({
      enrollment: { ...state.enrollment, url: `http://127.0.0.1:${silent.port}` },
      local: async () => ({ url: `http://127.0.0.1:${local.port}` }),
      onStatus: record(statuses),
      timing: { deadAfter: 100, backoffMin: 10, backoffMax: 20 },
    })
    await pong.promise
    await waitStatus(statuses, (entry) => entry.detail === "no ping from the hub")
    await waitStatus(statuses, (entry, index) => entry.status === "connecting" && index > 1)
    await agent.close()
    silent.stop(true)
  })

  test("revoking a machine drops its instances, closes its tunnel and refuses its tokens", async () => {
    const token = token0()
    const response = await api("machines/test-machine", { method: "DELETE" })
    expect(response.status).toBe(204)
    await waitStatus(state.statuses, (entry) => entry.status === "stopped")
    expect(state.dropped).toEqual([state.instances[0]!.iid])
    expect(
      (await fetch(`${state.hub.url}/llm/fake/models`, { headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(401)
    expect(state.statuses.list.at(-1)?.detail).toBe("machine revoked")
    expect((await fetch(`${state.machineURL}/echo`, { headers: { cookie: state.cookie } })).status).toBe(404)

    const socket = tunnelSocket(state.enrollment.tunnelToken)
    const outcome = await new Promise<string>((resolve) => {
      socket.addEventListener("open", () => resolve("open"))
      socket.addEventListener("close", () => resolve("closed"))
    })
    expect(outcome).toBe("closed")
    const refused = await fetch(`${state.hub.url}/hub/agent/connect`, {
      headers: { authorization: `Bearer ${state.enrollment.tunnelToken}` },
    })
    expect(refused.status).toBe(401)
  })
})

/** Keeps the provider catalog on its built-in list, so tests never reach models.dev. */
const offline = Object.assign(async () => Response.error(), { preconnect: () => {} }) as typeof fetch

type Machine = { id: string; name: string; online: boolean; lastSeenAt: number | null; url: string }

async function login() {
  const client = browser(state.hub.url)
  expect(await Account.login({ post: client.post, login: LOGIN, password: PASSWORD })).toEqual({ redirect: "/" })
  return client.jar.cookie
}

/** Calls the dashboard API as the signed-in browser would: same origin, JSON bodies. */
function api(
  route: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; cookie?: string } = {},
) {
  const method = init.method ?? "GET"
  const headers = new Headers(method === "GET" ? {} : { origin: state.hub.url, "content-type": "application/json" })
  const cookie = init.cookie ?? state.cookie
  if (cookie) headers.set("cookie", cookie)
  Object.entries(init.headers ?? {}).forEach(([name, value]) =>
    value ? headers.set(name, value) : headers.delete(name),
  )
  return fetch(`${state.hub.url}/hub/api/${route}`, {
    method,
    headers,
    body: init.body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(init.body),
    redirect: "manual",
  })
}

/** Reads `machines` events from the dashboard's event stream. */
function sse(reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> }) {
  const decoder = new TextDecoder()
  const buffer = { text: "" }
  const next = async (): Promise<Machine[]> => {
    const match = /event: machines\ndata: (.*)\n\n/.exec(buffer.text)
    if (match) {
      buffer.text = buffer.text.slice(match.index + match[0].length)
      return JSON.parse(match[1]) as Machine[]
    }
    const chunk = await reader.read()
    if (chunk.done) throw new Error("event stream ended")
    buffer.text += decoder.decode(chunk.value, { stream: true })
    return next()
  }
  const until = async (match: (list: Machine[]) => boolean): Promise<Machine[]> => {
    const list = await next()
    return match(list) ? list : until(match)
  }
  return { next, until, cancel: () => reader.cancel() }
}

/** The LLM token of the owner's instance on the test machine. */
function token0() {
  return state.instances.at(-1)!.token
}

function machine(pathname: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (!headers.has("cookie")) headers.set("cookie", state.cookie)
  return fetch(`${state.machineURL}${pathname}`, { ...init, headers })
}

async function llm(pathname: string, init: RequestInit) {
  const response = await fetch(`${state.hub.url}/llm${pathname}`, init)
  expect(response.status).toBe(200)
  return (await response.json()) as { method: string; path: string; headers: Record<string, string>; body: string }
}

function tunnelSocket(token: string) {
  const url = new URL("/hub/agent/connect", state.hub.url)
  url.protocol = "ws:"
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })
  socket.binaryType = "arraybuffer"
  return socket
}

function eventStream(gate: Promise<void>) {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode("data: one\n\n"))
        await gate
        controller.enqueue(encoder.encode("data: two\n\n"))
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

async function readUntil(reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> }, marker: string) {
  const decoder = new TextDecoder()
  const read = async (text: string): Promise<string> => {
    if (text.includes(marker)) return text
    const chunk = await reader.read()
    if (chunk.done) return text
    return read(text + decoder.decode(chunk.value, { stream: true }))
  }
  return read("")
}

function record(statuses: Statuses) {
  return (status: Agent.Status, detail?: string) => {
    statuses.list.push({ status, detail })
    statuses.waiters.splice(0).forEach((wake) => wake())
  }
}

async function waitStatus(
  statuses: Statuses,
  match: (entry: Statuses["list"][number], index: number) => boolean,
): Promise<void> {
  if (statuses.list.some(match)) return
  await new Promise<void>((resolve) => statuses.waiters.push(resolve))
  return waitStatus(statuses, match)
}

async function until(condition: () => boolean, deadline = Date.now() + 3000): Promise<void> {
  if (condition()) return
  if (Date.now() > deadline) throw new Error("condition not met in time")
  await Bun.sleep(5)
  return until(condition, deadline)
}

function queue<T>() {
  const items: T[] = []
  const waiters: ((item: T) => void)[] = []
  return {
    push(item: T) {
      const waiter = waiters.shift()
      if (waiter) return waiter(item)
      items.push(item)
    },
    next() {
      const item = items.shift()
      if (item !== undefined) return Promise.resolve(item)
      return new Promise<T>((resolve) => waiters.push(resolve))
    },
  }
}
