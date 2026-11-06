import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Agent, Hub, Protocol } from "../src/index.js"

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
  configs: Agent.LlmConfig[]
  statuses: Statuses
  cookie: string
  machineURL: string
}

beforeAll(async () => {
  state.hub = await Hub.start({ hostname: "127.0.0.1", port: 0, data, password: PASSWORD })
  state.enrollment = await Agent.enroll({
    url: state.hub.url,
    code: state.hub.createEnrollmentCode().code,
    name: "Test Machine",
  })
  state.configs = []
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
    onConfig: (llm) => state.configs.push(llm),
    onStatus: record(state.statuses),
  })
  state.ready = await ready.promise
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
    expect(state.ready.llm).toEqual({ baseURL: `${state.hub.url}/llm`, providers: [] })
  })

  test("codes are single use", async () => {
    const code = state.hub.createEnrollmentCode().code
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
      code: state.hub.createEnrollmentCode().code,
      name: "test machine",
    })
    expect(taken.machine.id).toBe("test-machine-2")
    const reserved = await Agent.enroll({
      url: state.hub.url,
      code: state.hub.createEnrollmentCode().code,
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
    expect(ticketURL.startsWith(`${state.machineURL}/__hub/session?ticket=`)).toBe(true)

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

  test("a wrong password is throttled per client", async () => {
    const attempt = (password: string) =>
      fetch(`${state.hub.url}/login`, {
        method: "POST",
        headers: { origin: state.hub.url, "x-forwarded-for": "203.0.113.9" },
        body: new URLSearchParams({ password }),
        redirect: "manual",
      })
    expect((await attempt("wrong")).status).toBe(401)
    expect((await attempt(PASSWORD)).status).toBe(429)
  })

  test("dashboard lists the machine and refuses cross-origin mutations", async () => {
    const page = await (await fetch(`${state.hub.url}/`, { headers: { cookie: state.cookie } })).text()
    expect(page).toContain("Test Machine")
    expect(page).toContain(">online<")
    const refused = await fetch(`${state.hub.url}/machines/code`, {
      method: "POST",
      headers: { cookie: state.cookie, origin: "http://evil.example" },
    })
    expect(refused.status).toBe(403)
    const code = await fetch(`${state.hub.url}/machines/code`, {
      method: "POST",
      headers: { cookie: state.cookie, origin: state.hub.url },
    })
    expect(await code.text()).toContain(`opencode agent join ${state.hub.url} --code `)
  })

  test("escapes machine names in the dashboard", async () => {
    await Agent.enroll({ url: state.hub.url, code: state.hub.createEnrollmentCode().code, name: "<b>evil</b>" })
    const page = await (await fetch(`${state.hub.url}/`, { headers: { cookie: state.cookie } })).text()
    expect(page).toContain("&#60;b&#62;evil&#60;/b&#62;")
    expect(page).not.toContain("<b>evil</b>")
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
    // The closed port from the first resolution was replaced after one failed connection.
    expect(localCalls.count).toBe(2)
  })

  test("refuses requests from another origin, including sibling machine hosts", async () => {
    const sibling = new URL(state.machineURL)
    sibling.hostname = `other.${sibling.hostname.split(".").slice(1).join(".")}`
    const response = await machine("/echo", { method: "POST", headers: { origin: sibling.origin }, body: "x" })
    expect(response.status).toBe(403)
    expect(localCalls.count).toBe(2)
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
    const response = await fetch(`${state.hub.url}/providers`, {
      method: "POST",
      headers: { cookie: state.cookie, origin: state.hub.url },
      body: new URLSearchParams({
        preset: "",
        id: "fake",
        name: "Fake",
        baseURL: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "real-key",
      }),
      redirect: "manual",
    })
    expect(response.status).toBe(302)
    await until(() => state.configs.length > 0)
    expect(state.configs.at(-1)).toEqual({ baseURL: `${state.hub.url}/llm`, providers: [{ id: "fake", name: "Fake" }] })
  })

  test("replaces the llm token with the real key wherever it was sent", async () => {
    const token = state.enrollment.llmToken
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
      headers: { authorization: `Bearer ${state.enrollment.llmToken}` },
    })
    expect(unknown.status).toBe(404)
  })

  test("streams upstream SSE", async () => {
    const response = await fetch(`${state.hub.url}/llm/fake/stream`, {
      headers: { authorization: `Bearer ${state.enrollment.llmToken}` },
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
  test("refuses a HELLO for another protocol version with 4400", async () => {
    const enrollment = await Agent.enroll({
      url: state.hub.url,
      code: state.hub.createEnrollmentCode().code,
      name: "future",
    })
    const socket = tunnelSocket(enrollment.tunnelToken)
    socket.addEventListener("open", () =>
      socket.send(
        Protocol.encodeJson(Protocol.Type.HELLO, 0, { protocol: 2, version: "9", name: "future", platform: "x" }),
      ),
    )
    const closed = await new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve))
    expect(closed.code).toBe(4400)
    expect(closed.reason).toContain("protocol 1")
  })

  test("a second connection for the same machine replaces the first with 4409", async () => {
    const enrollment = await Agent.enroll({
      url: state.hub.url,
      code: state.hub.createEnrollmentCode().code,
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

  test("revoking a machine closes its tunnel and refuses its token", async () => {
    const response = await fetch(`${state.hub.url}/machines/test-machine/revoke`, {
      method: "POST",
      headers: { cookie: state.cookie, origin: state.hub.url },
      redirect: "manual",
    })
    expect(response.status).toBe(302)
    await waitStatus(state.statuses, (entry) => entry.status === "stopped")
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

async function login() {
  const response = await fetch(`${state.hub.url}/login`, {
    method: "POST",
    headers: { origin: state.hub.url },
    body: new URLSearchParams({ password: PASSWORD, next: "" }),
    redirect: "manual",
  })
  expect(response.status).toBe(302)
  return (response.headers.get("set-cookie") ?? "").split(";")[0]
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
