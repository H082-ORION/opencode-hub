import { Database } from "bun:sqlite"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Account } from "../src/account.js"
import { Instances } from "../src/agent/instances.js"
import { Egress } from "../src/hub/egress.js"
import { Providers } from "../src/hub/providers.js"
import { Store } from "../src/hub/store.js"
import { Agent, Hub } from "../src/index.js"
import { browser } from "./fixture/browser.js"

// Connectors (specs/multi-users.md, step 7): remote MCP servers per user, their secrets sealed under the user's key,
// the `/mcp/` relay, the network guard, the instances' configuration, and OAuth run by the hub.

type Page = ReturnType<typeof browser>
/** An enrolled machine and the instances its agent was sent, latest last. */
type Box = { enrollment: Agent.Enrollment; instances: Agent.Instance[] }
type Seen = { method: string; path: string; headers: Record<string, string>; body: string }

const ALICE_SECRET = "alice-header-secret-0123456789"
const BOB_SECRET = "bob-header-secret-9876543210"

// A small MCP server over streamable HTTP. It records what reaches it, answers `initialize` with a session id,
// streams `tools/call` as SSE one event at a time, keeps GET streams open, and redirects on two paths.
const mcp = {
  seen: [] as Seen[],
  release: Promise.withResolvers<void>(),
  closed: 0,
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const body = await request.text()
    mcp.seen.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(request.headers),
      body,
    })
    if (url.pathname === "/mcp/moved") return new Response(null, { status: 307, headers: { location: "/mcp/new?x=1" } })
    if (url.pathname === "/mcp/away")
      return new Response(null, { status: 302, headers: { location: `http://127.0.0.2:${url.port}/mcp` } })
    if (request.method === "GET") {
      request.signal.addEventListener("abort", () => mcp.closed++)
      return new Response(
        new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode(": open\n\n")) }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    const message = JSON.parse(body) as { id: number; method: string }
    if (message.method === "initialize")
      return Response.json(
        { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {} } },
        { headers: { "mcp-session-id": "session-1", "set-cookie": "tracker=1" } },
      )
    const release = mcp.release.promise
    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ progress: 1 })}\n\n`))
          await release
          controller.enqueue(
            encoder.encode(
              `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n\n`,
            ),
          )
          controller.close()
        },
      }),
      { headers: { "content-type": "text/event-stream", "mcp-session-id": "session-1" } },
    )
  },
})

// An MCP server that requires OAuth, with its authorization server on the same origin: protected resource metadata,
// authorization server metadata, dynamic registration, authorization (it consents at once) and tokens.
const auth = {
  registered: [] as { redirect_uris: string[]; token_endpoint_auth_method: string }[],
  authorizations: [] as Record<string, string>[],
  grants: new Map<string, { challenge: string; client: string; redirect: string; resource: string }>(),
  valid: new Set<string>(),
  refreshes: 0,
  expiresIn: 3600,
  calls: [] as string[],
}
const protectedServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const origin = url.origin
    if (url.pathname === "/.well-known/oauth-protected-resource/secure")
      return Response.json({
        resource: `${origin}/secure`,
        authorization_servers: [`${origin}/as`],
        scopes_supported: ["tools"],
      })
    if (url.pathname === "/.well-known/oauth-authorization-server/as")
      return Response.json({
        issuer: `${origin}/as`,
        authorization_endpoint: `${origin}/as/authorize`,
        token_endpoint: `${origin}/as/token`,
        registration_endpoint: `${origin}/as/register`,
        code_challenge_methods_supported: ["S256"],
      })
    if (url.pathname === "/as/register") {
      const body = (await request.json()) as { redirect_uris: string[]; token_endpoint_auth_method: string }
      auth.registered.push(body)
      return Response.json({ client_id: "registered-client" }, { status: 201 })
    }
    if (url.pathname === "/as/authorize") {
      const params = Object.fromEntries(url.searchParams)
      auth.authorizations.push(params)
      const code = `code-${auth.authorizations.length}`
      auth.grants.set(code, {
        challenge: params.code_challenge ?? "",
        client: params.client_id ?? "",
        redirect: params.redirect_uri ?? "",
        resource: params.resource ?? "",
      })
      const back = new URL(params.redirect_uri ?? "")
      back.searchParams.set("code", code)
      back.searchParams.set("state", params.state ?? "")
      back.searchParams.set("iss", `${origin}/as`)
      return new Response(null, { status: 302, headers: { location: back.toString() } })
    }
    if (url.pathname === "/as/token") {
      const form = new URLSearchParams(await request.text())
      if (form.get("grant_type") === "refresh_token") {
        if (form.get("refresh_token") !== `refresh-${auth.refreshes}` || form.get("client_id") !== "registered-client")
          return Response.json({ error: "invalid_grant" }, { status: 400 })
        auth.refreshes++
        return issue(auth.refreshes)
      }
      const grant = auth.grants.get(form.get("code") ?? "")
      auth.grants.delete(form.get("code") ?? "")
      const challenge = new Bun.CryptoHasher("sha256").update(form.get("code_verifier") ?? "").digest("base64url")
      if (
        !grant ||
        challenge !== grant.challenge ||
        form.get("client_id") !== grant.client ||
        form.get("redirect_uri") !== grant.redirect ||
        form.get("resource") !== grant.resource
      )
        return Response.json({ error: "invalid_grant" }, { status: 400 })
      return issue(0)
    }
    if (url.pathname === "/secure") {
      const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? ""
      if (!auth.valid.has(token))
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/secure"`,
          },
        })
      auth.calls.push(token)
      return Response.json({ jsonrpc: "2.0", id: 1, result: { token } })
    }
    return new Response("not found", { status: 404 })
  },
})

function issue(generation: number) {
  const access = `access-token-secret-${generation}`
  auth.valid.add(access)
  return Response.json({
    access_token: access,
    token_type: "Bearer",
    refresh_token: `refresh-${generation}`,
    expires_in: auth.expiresIn,
  })
}

const local = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("local ok") })

const dirs: string[] = []
const addresses = { next: 1 }
const state = {} as {
  hub: Awaited<ReturnType<typeof Hub.start>>
  data: string
  alice: Page
  bob: Page
  machines: { alice: Box; bob: Box }
  agents: ReturnType<typeof Agent.connect>[]
}

beforeAll(async () => {
  state.data = tempDir()
  // Connectors on this machine's loopback need private networks allowed, as a hub on a LAN would.
  state.hub = await Hub.start({
    hostname: "127.0.0.1",
    port: 0,
    data: state.data,
    catalog: { fetch: offline },
    mcp: { privateNetworks: true },
  })
  state.alice = await signUp(state.hub.url, state.hub.invite("admin").url, "alice")
  state.bob = await signUp(state.hub.url, await invite(state.alice), "bob")
  state.machines = {
    alice: await enroll(state.hub.url, state.alice, "Alice Box"),
    bob: await enroll(state.hub.url, state.bob, "Bob Box"),
  }
  state.agents = await Promise.all([connect(state.machines.alice), connect(state.machines.bob)])
})

afterAll(async () => {
  mcp.release.resolve()
  await Promise.all(state.agents?.map((agent) => agent.close()) ?? [])
  await state.hub?.stop()
  server.stop(true)
  protectedServer.stop(true)
  local.stop(true)
  dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

describe("connectors per user", () => {
  test("two users save the same connector id with their own secrets; each instance gets its user's", async () => {
    const saved = await addEcho(state.alice, ALICE_SECRET)
    expect(saved).toEqual({
      id: "echo",
      name: "Echo",
      url: mcpURL(),
      auth: "headers",
      headers: ["X-Secret"],
      connected: null,
      server: "hub-echo",
    })
    await addEcho(state.bob, BOB_SECRET)
    expect((await call(state.machines.alice, initialize())).status).toBe(200)
    expect(mcp.seen.at(-1)?.headers["x-secret"]).toBe(ALICE_SECRET)
    expect((await call(state.machines.bob, initialize())).status).toBe(200)
    expect(mcp.seen.at(-1)?.headers["x-secret"]).toBe(BOB_SECRET)
    // The list shows header names, never their values.
    const listed = await (await state.bob.request("connectors")).text()
    expect(listed).not.toContain(BOB_SECRET)
    expect(JSON.parse(listed)).toHaveLength(1)
  })

  test("the instances get the connector list, and lose it when it is removed", async () => {
    const alice = state.machines.alice.instances
    await until(() => alice.at(-1)?.mcp.length === 1)
    expect(alice.at(-1)?.mcp).toEqual([{ id: "echo", name: "Echo", url: `${state.hub.url}/mcp/echo` }])
    await state.alice.post("connectors", { name: "Second", url: mcpURL(), headers: [] })
    await until(() => alice.at(-1)?.mcp.length === 2)
    expect((await state.alice.request("connectors/second", { method: "DELETE" })).status).toBe(204)
    await until(() => alice.at(-1)?.mcp.length === 1)
    // Bob cannot remove Alice's connector, and a taken id is refused.
    expect((await state.bob.request("connectors/second", { method: "DELETE" })).status).toBe(404)
    expect((await state.alice.request("connectors", { method: "POST", body: echo(ALICE_SECRET) })).status).toBe(409)
  })

  test("no header value is stored in clear", () => {
    const raw = ["hub.db", "hub.db-wal"]
      .map((name) => path.join(state.data, name))
      .filter((file) => existsSync(file))
      .map((file) => readFileSync(file).toString("latin1"))
      .join("")
    expect(raw.length).toBeGreaterThan(0)
    expect(raw).not.toContain(ALICE_SECRET)
    expect(raw).not.toContain(BOB_SECRET)
    expect(raw).not.toContain(Buffer.from(ALICE_SECRET).toString("base64url"))
  })

  test("refuses invalid ids, headers and URLs", async () => {
    const refused = async (body: object) => (await state.alice.request("connectors", { method: "POST", body })).status
    expect(await refused({ name: "x", id: "Bad Id", url: mcpURL() })).toBe(400)
    expect(await refused({ name: "x", url: mcpURL(), headers: [{ name: "Host", value: "a" }] })).toBe(400)
    expect(await refused({ name: "x", url: mcpURL(), headers: [{ name: "Mcp-Session-Id", value: "a" }] })).toBe(400)
    expect(await refused({ name: "x", url: mcpURL(), headers: [{ name: "X-A", value: "a\r\nInjected: b" }] })).toBe(400)
    expect(await refused({ name: "x", url: "ftp://example.com/" })).toBe(400)
  })
})

describe("relay", () => {
  test("injects the connector's headers, drops the instance token and passes the MCP session both ways", async () => {
    const opened = await call(state.machines.alice, initialize())
    expect(opened.headers.get("mcp-session-id")).toBe("session-1")
    // The MCP server's cookies stay on the hub's side.
    expect(opened.headers.get("set-cookie")).toBeNull()
    expect(((await opened.json()) as { result: object }).result).toBeDefined()
    const response = await call(
      state.machines.alice,
      { jsonrpc: "2.0", id: 2, method: "ping" },
      {
        "mcp-session-id": "session-1",
        "mcp-protocol-version": "2025-06-18",
      },
      "/sub?codemode=false",
    )
    mcp.release.resolve()
    await response.text()
    const seen = mcp.seen.at(-1)!
    expect(seen.path).toBe("/mcp/sub?codemode=false")
    expect(seen.headers["mcp-session-id"]).toBe("session-1")
    expect(seen.headers["mcp-protocol-version"]).toBe("2025-06-18")
    expect(seen.headers["x-secret"]).toBe(ALICE_SECRET)
    expect(seen.headers.authorization).toBeUndefined()
    expect(JSON.stringify(seen.headers)).not.toContain(state.machines.alice.instances.at(-1)!.token)
    mcp.release = Promise.withResolvers<void>()
  })

  test("streams an SSE answer as it comes, without buffering", async () => {
    const response = await call(state.machines.alice, { jsonrpc: "2.0", id: 3, method: "tools/call" })
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    const reader = response.body!.getReader()
    // The first event arrives while the server still holds the second.
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('"progress":1')
    mcp.release.resolve()
    const rest = await drain(reader)
    expect(rest).toContain('"id":3')
    mcp.release = Promise.withResolvers<void>()
  })

  test("closing the instance's stream closes the request to the MCP server", async () => {
    const abort = new AbortController()
    const before = mcp.closed
    const response = await fetch(`${state.hub.url}/mcp/echo`, {
      headers: { authorization: `Bearer ${token(state.machines.alice)}`, accept: "text/event-stream" },
      signal: abort.signal,
    })
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(": open")
    abort.abort()
    await until(() => mcp.closed > before)
  })

  test("refuses a wrong token (401), an unknown connector (404) and a machine its user lost (403)", async () => {
    const bad = await fetch(`${state.hub.url}/mcp/echo`, {
      method: "POST",
      headers: { authorization: "Bearer not-a-token", "content-type": "application/json" },
      body: JSON.stringify(initialize()),
    })
    expect(bad.status).toBe(401)
    expect((await call(state.machines.alice, initialize(), {}, "", "unknown")).status).toBe(404)
    expect((await call(state.machines.alice, initialize(), {}, "", "Not-An-Id")).status).toBe(404)
    // The machine changes owner behind the hub's back: its instance token no longer opens anything.
    const db = new Database(path.join(state.data, "hub.db"))
    db.run("UPDATE machine SET owner_user_id = ? WHERE id = ?", [await userID("bob"), "alice-box"])
    expect((await call(state.machines.alice, initialize())).status).toBe(403)
    db.run("UPDATE machine SET owner_user_id = ? WHERE id = ?", [await userID("alice"), "alice-box"])
    db.close()
    expect((await call(state.machines.alice, initialize())).status).toBe(200)
  })

  test("locked keys answer 423 to the relay and to saving; removing still works", async () => {
    await state.bob.post("account/lock", {})
    const locked = await call(state.machines.bob, initialize())
    expect(locked.status).toBe(423)
    expect(((await locked.json()) as { error: string }).error).toBe(Providers.LOCKED)
    expect((await state.bob.request("connectors", { method: "POST", body: echo("x", "other") })).status).toBe(423)
    expect((await state.bob.request("connectors/echo", { method: "POST", body: { name: "Renamed" } })).status).toBe(423)
    expect((await call(state.machines.alice, initialize())).status).toBe(200)
    await Account.login({ post: state.bob.post, login: "bob", password: "bob-password" })
    expect((await call(state.machines.bob, initialize())).status).toBe(200)
  })

  test("follows no redirect: one to another host is refused, one under the connector comes back through the hub", async () => {
    const away = await call(state.machines.alice, initialize(), {}, "/away")
    expect(away.status).toBe(502)
    expect(mcp.seen.at(-1)?.path).toBe("/mcp/away")
    const moved = await call(state.machines.alice, initialize(), {}, "/moved")
    expect(moved.status).toBe(307)
    expect(moved.headers.get("location")).toBe(`${state.hub.url}/mcp/echo/new?x=1`)
  })
})

describe("network guard", () => {
  test("classifies addresses", () => {
    expect(
      ["169.254.169.254", "fe80::1", "::ffff:169.254.169.254", "0.0.0.0", "100.100.100.200", "fd00:ec2::254"].map(
        Egress.classify,
      ),
    ).toEqual(["blocked", "blocked", "blocked", "blocked", "blocked", "blocked"])
    expect(["127.0.0.1", "10.1.2.3", "192.168.1.1", "::1", "fd12::1", "::ffff:10.0.0.1"].map(Egress.classify)).toEqual([
      "private",
      "private",
      "private",
      "private",
      "private",
      "private",
    ])
    expect(["1.1.1.1", "2606:4700::1111"].map(Egress.classify)).toEqual(["public", "public"])
  })

  test("refuses link-local addresses, the hub and its machines when a connector is saved", async () => {
    const port = state.hub.port
    const urls = [
      "http://169.254.169.254/latest/meta-data/",
      "https://[fe80::1]/mcp",
      "https://[::ffff:169.254.169.254]/mcp",
      `http://127.0.0.1:${port}/hub/health`,
      `http://localhost:${port}/hub/health`,
      `http://alice-box.localhost:${port}/`,
      "http://user:pass@127.0.0.1/mcp",
    ]
    const statuses = await Promise.all(
      urls.map(
        async (url, index) =>
          (await state.alice.request("connectors", { method: "POST", body: { name: `g${index}`, url } })).status,
      ),
    )
    expect(statuses).toEqual(urls.map(() => 400))
  })

  test("without private networks, refuses loopback and plain HTTP to a public address", async () => {
    const hub = await Hub.start({ hostname: "127.0.0.1", port: 0, data: tempDir(), catalog: { fetch: offline } })
    const page = await signUp(hub.url, hub.invite("admin").url, "erin")
    const loopback = await page.request("connectors", { method: "POST", body: { name: "x", url: mcpURL() } })
    expect(loopback.status).toBe(400)
    expect(((await loopback.json()) as { error: string }).error).toContain("private address")
    const plain = await page.request("connectors", { method: "POST", body: { name: "x", url: "http://1.1.1.1/mcp" } })
    expect(plain.status).toBe(400)
    await hub.stop()
  })

  test("checks again at each request: a connector that now points somewhere refused is not called", async () => {
    await state.alice.post("connectors", { name: "Moving", url: mcpURL(), headers: [] })
    const db = new Database(path.join(state.data, "hub.db"))
    const user = await userID("alice")
    const targets = ["http://169.254.169.254/", `http://127.0.0.1:${state.hub.port}/hub/health`]
    const before = mcp.seen.length
    const statuses = []
    for (const target of targets) {
      db.run("UPDATE connector SET url = ? WHERE user_id = ? AND id = 'moving'", [target, user])
      statuses.push((await call(state.machines.alice, initialize(), {}, "", "moving")).status)
    }
    db.close()
    expect(statuses).toEqual([502, 502])
    expect(mcp.seen.length).toBe(before)
  })
})

describe("instance configuration", () => {
  test("the agent turns connectors into remote MCP servers named hub-<id> with the instance token", () => {
    const env = Instances.hubEnv({
      iid: "sample-instance-0001",
      token: "instance-token",
      llm: { baseURL: "https://hub.example.com/llm", providers: [{ id: "fake", name: "Fake" }] },
      mcp: [{ id: "echo", name: "Echo", url: "https://hub.example.com/mcp/echo" }],
      skills: { version: "none" },
    })
    expect(JSON.parse(env[Instances.CONFIG]!)).toEqual({
      providers: { fake: { env: [Instances.TOKEN], settings: { baseURL: "https://hub.example.com/llm/fake" } } },
      mcp: {
        servers: {
          "hub-echo": {
            type: "remote",
            url: "https://hub.example.com/mcp/echo",
            headers: { Authorization: `Bearer {env:${Instances.TOKEN}}` },
            oauth: false,
          },
        },
      },
    })
    expect(env[Instances.TOKEN]).toBe("instance-token")
  })

  test("INSTANCE carries the user's connectors to the agent", () => {
    expect(state.machines.alice.instances.at(-1)?.mcp.map((connector) => connector.id)).toEqual(["echo", "moving"])
  })
})

describe("OAuth", () => {
  test("discovers, registers, signs in with PKCE, seals the tokens and refreshes them", async () => {
    await state.alice.post("connectors", { name: "Secure", url: secureURL(), auth: "oauth" })
    // Not connected yet: the instance hears it needs the dashboard.
    expect((await call(state.machines.alice, initialize(), {}, "", "secure")).status).toBe(409)

    const begun = await state.alice.post<{ url: string }>("connectors/secure/oauth/begin", {})
    const authorize = new URL(begun.url)
    expect(authorize.origin).toBe(new URL(secureURL()).origin)
    expect(auth.registered.at(-1)).toMatchObject({
      redirect_uris: [`${state.hub.url}/hub/oauth/callback`],
      token_endpoint_auth_method: "none",
    })
    // The authorization server consents at once and sends the browser back to the hub.
    const consent = await fetch(begun.url, { redirect: "manual" })
    const callback = consent.headers.get("location")!
    expect(auth.authorizations.at(-1)).toMatchObject({
      code_challenge_method: "S256",
      client_id: "registered-client",
      resource: secureURL(),
      scope: "tools",
    })
    // Another user cannot finish Alice's sign-in, and it stays usable for her.
    const stolen = await fetch(callback, { headers: { cookie: state.bob.jar.cookie }, redirect: "manual" })
    expect(stolen.status).toBe(400)
    const anonymous = await fetch(callback, { redirect: "manual" })
    expect(anonymous.status).toBe(401)
    const back = await fetch(callback, { headers: { cookie: state.alice.jar.cookie }, redirect: "manual" })
    expect(back.status).toBe(302)
    expect(back.headers.get("location")).toBe("/?connector=secure")
    // The code was used once.
    expect((await fetch(callback, { headers: { cookie: state.alice.jar.cookie } })).status).toBe(400)

    const listed = (await (await state.alice.request("connectors")).json()) as { id: string; connected: boolean }[]
    expect(listed.find((entry) => entry.id === "secure")?.connected).toBe(true)
    const first = await call(state.machines.alice, initialize(), {}, "", "secure")
    expect(first.status).toBe(200)
    expect(auth.calls.at(-1)).toBe("access-token-secret-0")

    // The server stops accepting that token: the relay refreshes it once and sends the request again.
    auth.valid.delete("access-token-secret-0")
    expect((await call(state.machines.alice, initialize(), {}, "", "secure")).status).toBe(200)
    expect(auth.calls.at(-1)).toBe("access-token-secret-1")
    // A token about to expire is refreshed before use.
    auth.expiresIn = 30
    auth.valid.delete("access-token-secret-1")
    expect((await call(state.machines.alice, initialize(), {}, "", "secure")).status).toBe(200)
    expect(auth.calls.at(-1)).toBe("access-token-secret-2")
    expect((await call(state.machines.alice, initialize(), {}, "", "secure")).status).toBe(200)
    expect(auth.calls.at(-1)).toBe("access-token-secret-3")
    expect(auth.refreshes).toBe(3)

    const raw = ["hub.db", "hub.db-wal"]
      .map((name) => path.join(state.data, name))
      .filter((file) => existsSync(file))
      .map((file) => readFileSync(file).toString("latin1"))
      .join("")
    expect(raw).not.toContain("access-token-secret-")
    expect(raw).not.toContain("refresh-3")
  })

  test("needs the user's key to start, and refuses a connector of headers", async () => {
    expect((await state.alice.request("connectors/echo/oauth/begin", { method: "POST" })).status).toBe(400)
    await state.alice.post("account/lock", {})
    expect((await state.alice.request("connectors/secure/oauth/begin", { method: "POST" })).status).toBe(423)
    expect((await call(state.machines.alice, initialize(), {}, "", "secure")).status).toBe(423)
    await Account.login({ post: state.alice.post, login: "alice", password: "alice-password" })
  })
})

describe("reset", () => {
  test("an administrator reset deletes the user's connectors", async () => {
    await state.alice.post(`users/${await userID("bob")}/reset`, {})
    const store = Store.open(state.data)
    expect(store.connectorSummaries(await userID("bob"))).toEqual([])
    store.close()
  })
})

/** Keeps the provider catalog on its built-in list, so tests never reach models.dev. */
const offline = Object.assign(async () => Response.error(), { preconnect: () => {} }) as typeof fetch

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opencode-connectors-"))
  dirs.push(dir)
  return dir
}

function mcpURL() {
  return `http://127.0.0.1:${server.port}/mcp`
}

function secureURL() {
  return `http://127.0.0.1:${protectedServer.port}/secure`
}

function echo(secret: string, id = "echo") {
  return { id, name: "Echo", url: mcpURL(), headers: [{ name: "X-Secret", value: secret }] }
}

async function addEcho(page: Page, secret: string) {
  return (await page.post<{ connector: object }>("connectors", echo(secret))).connector
}

function initialize() {
  return { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } }
}

function token(machine: Box) {
  return machine.instances.at(-1)!.token
}

/** Calls a connector through the hub as the machine's instance does. */
function call(machine: Box, body: object, headers: Record<string, string> = {}, rest = "", id = "echo") {
  return fetch(`${state.hub.url}/mcp/${id}${rest}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token(machine)}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
    redirect: "manual",
  })
}

/** The rest of a stream as text. */
async function drain(reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> }, text = ""): Promise<string> {
  const chunk = await reader.read()
  if (chunk.done) return text
  return drain(reader, text + new TextDecoder().decode(chunk.value))
}

/** Each page signs up from its own client address, so sign-in throttling never crosses tests. */
async function signUp(hub: string, url: string, login: string) {
  const page = browser(hub, { "x-forwarded-for": `198.51.100.${addresses.next++}` })
  const invite = new URL(url).searchParams.get("invite") ?? ""
  await Account.register({ post: page.post, invite, login, password: `${login}-password` })
  return page
}

async function invite(admin: Page) {
  return (await admin.post<{ url: string }>("invitations", { role: "user" })).url
}

async function enroll(hub: string, page: Page, name: string): Promise<Box> {
  const code = (await page.post<{ code: string }>("machines/code", {})).code
  return { enrollment: await Agent.enroll({ url: hub, code, name }), instances: [] }
}

/** Connects the machine's agent and waits for its owner's instance, which a personal machine gets at once. */
async function connect(box: Box) {
  const count = box.instances.length
  const agent = Agent.connect({
    enrollment: box.enrollment,
    local: async () => ({ url: `http://127.0.0.1:${local.port}` }),
    onInstance: (instance) => box.instances.push(instance),
  })
  await until(() => box.instances.length > count)
  return agent
}

async function userID(login: string) {
  const users = (await (await state.alice.request("users")).json()) as { id: string; login: string }[]
  return users.find((user) => user.login === login)?.id ?? ""
}

async function until(condition: () => boolean, deadline = Date.now() + 3000): Promise<void> {
  if (condition()) return
  if (Date.now() > deadline) throw new Error("condition not met in time")
  await Bun.sleep(5)
  return until(condition, deadline)
}
