import { Database } from "bun:sqlite"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Account } from "../src/account.js"
import { Agent, Hub } from "../src/index.js"
import { Store } from "../src/hub/store.js"
import { browser } from "./fixture/browser.js"

// Machines belong to the user who enrolled them (specs/multi-users.md, step 2).

type Page = ReturnType<typeof browser>
type Reader = { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> }
type Listed = { id: string; name: string; online: boolean; url: string }
type AdminListed = { id: string; name: string; owner: string | null; online: boolean; lastSeenAt: number | null }

const gate = { cancelled: Promise.withResolvers<void>() }

const local = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, server) {
    const url = new URL(request.url)
    if (url.pathname === "/ws") {
      if (server.upgrade(request, { data: undefined })) return
      return new Response("upgrade failed", { status: 400 })
    }
    if (url.pathname === "/endless")
      return new Response(
        new ReadableStream({
          start: (controller) => controller.enqueue(new TextEncoder().encode("data: one\n\n")),
          cancel: () => gate.cancelled.resolve(),
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    return new Response("local ok")
  },
  websocket: {
    message(ws, message) {
      ws.send(message)
    },
  },
})

const data = mkdtempSync(path.join(os.tmpdir(), "opencode-machines-"))
const state = {} as {
  hub: Awaited<ReturnType<typeof Hub.start>>
  alice: Page
  bob: Page
  agents: ReturnType<typeof Agent.connect>[]
  machines: { alice: Agent.Enrollment; bob: Agent.Enrollment }
}
const addresses = { next: 1 }

beforeAll(async () => {
  state.hub = await Hub.start({ hostname: "127.0.0.1", port: 0, data, catalog: { fetch: offline } })
  state.alice = await signUp(state.hub.invite("admin").url, "alice")
  state.bob = await signUp(await invite(state.alice, "user"), "bob")
  state.machines = {
    alice: await enroll(state.alice, "Alice Laptop"),
    bob: await enroll(state.bob, "Bob Desktop"),
  }
  state.agents = await Promise.all([connect(state.machines.alice), connect(state.machines.bob)])
})

afterAll(async () => {
  await Promise.all(state.agents?.map((agent) => agent.close()) ?? [])
  await state.hub?.stop()
  local.stop(true)
  rmSync(data, { recursive: true, force: true })
})

describe("ownership", () => {
  test("each user lists only the machines they enrolled", async () => {
    expect((await list(state.alice)).map((machine) => machine.id)).toEqual(["alice-laptop"])
    expect((await list(state.bob)).map((machine) => machine.id)).toEqual(["bob-desktop"])
  })

  test("the live machine list only carries the user's own machines", async () => {
    const events = sse((await state.alice.request("events")).body!.getReader())
    expect((await events.next()).map((machine) => machine.id)).toEqual(["alice-laptop"])
    // Bob's enrollment wakes every dashboard, but Alice's still only hears about her machine.
    const extra = await enroll(state.bob, "Bob Spare")
    expect((await events.next()).map((machine) => machine.id)).toEqual(["alice-laptop"])
    expect((await list(state.bob)).map((machine) => machine.id)).toEqual(["bob-desktop", extra.machine.id])
    await events.cancel()
  })

  test("another user's machine host answers like an unknown machine, over HTTP and WebSocket", async () => {
    const unknown = await host("nobody", "/", state.bob)
    const foreign = await host("alice-laptop", "/", state.bob)
    expect(foreign.status).toBe(404)
    expect(await foreign.text()).toBe(await unknown.text())
    expect(await (await host("alice-laptop", "/", state.alice)).text()).toBe("local ok")

    expect(await socketOutcome("alice-laptop", state.bob)).toBe("refused")
    expect(await socketOutcome("alice-laptop", state.alice)).toBe("open")
  })

  test("a handoff ticket is only issued for the user's own machine", async () => {
    const next = machineURL("alice-laptop", "/")
    const foreign = await handoff(state.bob, next)
    expect(foreign).toBe("/")
    expect(await handoff(state.bob, machineURL("nobody", "/"))).toBe(foreign)
    expect(await handoff(state.alice, next)).toStartWith(`${machineURL("alice-laptop", "/auth/hub-session")}?ticket=`)
  })

  test("only the owner or an administrator revokes a machine", async () => {
    expect((await state.bob.request("machines/alice-laptop", { method: "DELETE" })).status).toBe(404)
    expect((await list(state.alice)).map((machine) => machine.id)).toEqual(["alice-laptop"])
    expect((await state.bob.request("machines/bob-spare", { method: "DELETE" })).status).toBe(204)
    expect((await list(state.bob)).map((machine) => machine.id)).toEqual(["bob-desktop"])
  })
})

describe("administration", () => {
  test("administrators list every machine with its owner, and nobody else does", async () => {
    const all = (await (await state.alice.request("admin/machines")).json()) as AdminListed[]
    expect(all.map((machine) => [machine.id, machine.owner, machine.online])).toEqual([
      ["alice-laptop", "alice", true],
      ["bob-desktop", "bob", true],
    ])
    // No handoff link: an administrator cannot open other users' machines.
    expect(JSON.stringify(all)).not.toContain("handoff")
    expect((await state.bob.request("admin/machines")).status).toBe(403)
    expect(await handoff(state.alice, machineURL("bob-desktop", "/"))).toBe("/")
    expect((await host("bob-desktop", "/", state.alice)).status).toBe(404)
  })

  test("an administrator revokes another user's machine", async () => {
    const carol = await signUp(await invite(state.alice, "user"), "carol")
    const enrollment = await enroll(carol, "Carol Box")
    expect((await state.alice.request(`machines/${enrollment.machine.id}`, { method: "DELETE" })).status).toBe(204)
    expect(await list(carol)).toEqual([])
    const refused = await fetch(`${state.hub.url}/hub/agent/connect`, {
      headers: { authorization: `Bearer ${enrollment.tunnelToken}` },
    })
    expect(refused.status).toBe(401)
  })
})

describe("disabled accounts", () => {
  test("an enrollment code stops working once its author is disabled", async () => {
    const dave = await signUp(await invite(state.alice, "user"), "dave")
    const code = ((await (await dave.request("machines/code", { method: "POST" })).json()) as { code: string }).code
    await state.alice.post(`users/${await userID("dave")}/disable`, {})
    const response = await fetch(`${state.hub.url}/hub/agent/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.20" },
      body: JSON.stringify({ code, name: "Dave Box" }),
    })
    expect(response.status).toBe(403)
    const all = (await (await state.alice.request("admin/machines")).json()) as AdminListed[]
    expect(all.some((machine) => machine.name === "Dave Box")).toBe(false)
  })

  test("disabling an account cuts its open streams and its next requests", async () => {
    const erin = await signUp(await invite(state.alice, "user"), "erin")
    const enrollment = await enroll(erin, "Erin Box")
    state.agents.push(await connect(enrollment))
    const id = enrollment.machine.id
    const ticket = await handoff(erin, machineURL(id, "/"))

    const reader = (await host(id, "/endless", erin)).body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("data: one")
    const socket = await openSocket(id, erin)
    const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve))

    await state.alice.post(`users/${await userID("erin")}/disable`, {})
    expect(await drained(reader)).toBe(true)
    await gate.cancelled.promise
    expect((await closed).code).toBe(1008)

    const next = await host(id, "/", erin)
    expect(next.status).toBe(302)
    expect(next.headers.get("location")).toStartWith(`${state.hub.url}/login`)
    // A ticket issued before the account was disabled no longer opens a session either.
    const used = await fetch(ticket, { redirect: "manual" })
    expect(used.headers.get("location")).toStartWith(`${state.hub.url}/login`)
  })
})

describe("machines enrolled before owners existed", () => {
  test("go to the oldest administrator once one exists, and to nobody before", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "opencode-machines-legacy-"))
    const legacy = new Database(path.join(dir, "hub.db"), { create: true })
    legacy.run(`CREATE TABLE machine (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, tunnel_token_hash TEXT NOT NULL UNIQUE,
      llm_token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_seen_at INTEGER
    )`)
    legacy.run("INSERT INTO machine VALUES ('old', 'Old', 't1', 'l1', 1, NULL)")
    legacy.close()

    const hub = await Hub.start({ hostname: "127.0.0.1", port: 0, data: dir, catalog: { fetch: offline } })
    const user = await signUp(hub.invite("user").url, "first-user", hub.url)
    expect(await list(user)).toEqual([])
    const admin = await signUp(hub.invite("admin").url, "first-admin", hub.url)
    await signUp(hub.invite("admin").url, "second-admin", hub.url)
    expect((await list(admin)).map((machine) => machine.id)).toEqual(["old"])
    await hub.stop()

    // An ownerless row found at start, e.g. restored from an old backup, is adopted the same way.
    const restored = new Database(path.join(dir, "hub.db"))
    restored.run(
      "INSERT INTO machine (id, name, tunnel_token_hash, llm_token_hash, created_at) VALUES ('restored', 'R', 't2', 'l2', 2)",
    )
    restored.close()
    const store = Store.open(dir)
    const owners = store.machines().map((machine) => [machine.id, machine.owner_login, machine.enrolled_by])
    store.close()
    expect(owners).toEqual([
      ["old", "first-admin", null],
      ["restored", "first-admin", null],
    ])
    rmSync(dir, { recursive: true, force: true })
  })
})

/** Keeps the provider catalog on its built-in list, so tests never reach models.dev. */
const offline = Object.assign(async () => Response.error(), { preconnect: () => {} }) as typeof fetch

/** Each page signs up from its own client address, so sign-in throttling never crosses tests. */
async function signUp(url: string, login: string, hub = state.hub.url) {
  const page = browser(hub, { "x-forwarded-for": `198.51.100.${addresses.next++}` })
  const invite = new URL(url).searchParams.get("invite") ?? ""
  await Account.register({ post: page.post, invite, login, password: `${login}-password` })
  return page
}

async function invite(admin: Page, role: "admin" | "user") {
  return (await admin.post<{ url: string }>("invitations", { role })).url
}

/** Enrolls a machine with a code the page's user created on the dashboard. */
async function enroll(page: Page, name: string) {
  const code = (await page.post<{ code: string }>("machines/code", {})).code
  return Agent.enroll({ url: state.hub.url, code, name })
}

async function connect(enrollment: Agent.Enrollment) {
  const ready = Promise.withResolvers<void>()
  const agent = Agent.connect({
    enrollment,
    local: async () => ({ url: `http://127.0.0.1:${local.port}` }),
    onReady: () => ready.resolve(),
  })
  await ready.promise
  return agent
}

async function list(page: Page) {
  return (await (await page.request("machines")).json()) as Listed[]
}

async function userID(login: string) {
  const users = (await (await state.alice.request("users")).json()) as { id: string; login: string }[]
  return users.find((user) => user.login === login)?.id ?? ""
}

function machineURL(id: string, pathname: string) {
  return `http://${id}.localhost:${state.hub.port}${pathname}`
}

function host(id: string, pathname: string, page: Page) {
  return fetch(machineURL(id, pathname), { headers: { cookie: page.jar.cookie }, redirect: "manual" })
}

/** Where `/hub/handoff` sends the page's user for `next`. */
async function handoff(page: Page, next: string) {
  const response = await fetch(`${state.hub.url}/hub/handoff?next=${encodeURIComponent(next)}`, {
    headers: { cookie: page.jar.cookie },
    redirect: "manual",
  })
  return response.headers.get("location") ?? ""
}

function socket(id: string, page: Page) {
  return new WebSocket(`ws://${id}.localhost:${state.hub.port}/ws`, { headers: { cookie: page.jar.cookie } })
}

function socketOutcome(id: string, page: Page) {
  const ws = socket(id, page)
  return new Promise<"open" | "refused">((resolve) => {
    ws.addEventListener("open", () => {
      resolve("open")
      ws.close()
    })
    ws.addEventListener("close", () => resolve("refused"))
  })
}

async function openSocket(id: string, page: Page) {
  const ws = socket(id, page)
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve)
    ws.addEventListener("error", reject)
  })
  return ws
}

/** Whether the stream ends or fails before sending anything more. */
async function drained(reader: Reader): Promise<boolean> {
  const chunk = await reader.read().catch(() => ({ done: true, value: undefined }))
  if (chunk.done) return true
  return drained(reader)
}

/** Reads `machines` events from the dashboard's event stream. */
function sse(reader: Reader) {
  const decoder = new TextDecoder()
  const buffer = { text: "" }
  const next = async (): Promise<Listed[]> => {
    const match = /event: machines\ndata: (.*)\n\n/.exec(buffer.text)
    if (match) {
      buffer.text = buffer.text.slice(match.index + match[0].length)
      return JSON.parse(match[1]) as Listed[]
    }
    const chunk = await reader.read()
    if (chunk.done) throw new Error("event stream ended")
    buffer.text += decoder.decode(chunk.value, { stream: true })
    return next()
  }
  return { next, cancel: () => reader.cancel() }
}
