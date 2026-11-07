import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Account } from "../src/account.js"
import { Agent, Hub } from "../src/index.js"
import { Store } from "../src/hub/store.js"
import { browser } from "./fixture/browser.js"

// Organizations, their members and their machines (specs/multi-users.md, step 4).

type Page = ReturnType<typeof browser>
type Reader = { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> }
type Listed = { id: string; org: { id: string; name: string } | null; canRevoke: boolean }
type Org = { id: string; name: string; machines: number; members: { id: string; login: string }[] }
type Echo = { headers: Record<string, string> }

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

// Echoes the headers it receives, so a test sees which key the hub injected.
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => Response.json({ headers: Object.fromEntries(request.headers) }),
})

const data = mkdtempSync(path.join(os.tmpdir(), "opencode-orgs-"))
const addresses = { next: 1 }
const state = {} as {
  hub: Awaited<ReturnType<typeof Hub.start>>
  alice: Page
  bob: Page
  carol: Page
  dave: Page
  acme: string
  box: Agent.Enrollment
  instances: Agent.Instance[]
  dropped: string[]
  /** How many OPEN frames reached each instance. */
  opened: Map<string, number>
  store?: Store.Instance
  agents: ReturnType<typeof Agent.connect>[]
}

beforeAll(async () => {
  state.hub = await Hub.start({ hostname: "127.0.0.1", port: 0, data, catalog: { fetch: offline } })
  state.alice = await signUp(state.hub.invite("admin").url, "alice")
  state.bob = await signUp(await invite(), "bob")
  state.carol = await signUp(await invite(), "carol")
  state.dave = await signUp(await invite(), "dave")
  state.acme = (await state.alice.post<{ id: string }>("orgs", { name: "Acme" })).id
  await state.alice.post(`orgs/${state.acme}/members`, { user: await userID("bob") })
  await state.alice.post(`orgs/${state.acme}/members`, { user: await userID("carol") })
  state.box = await enroll(state.bob, "Acme Box", state.acme)
  state.instances = []
  state.dropped = []
  state.opened = new Map()
  state.agents = [await connect(state.box)]
})

afterAll(async () => {
  await Promise.all(state.agents?.map((agent) => agent.close()) ?? [])
  state.store?.close()
  await state.hub?.stop()
  local.stop(true)
  upstream.stop(true)
  rmSync(data, { recursive: true, force: true })
})

describe("administration", () => {
  test("administrators create, rename and list organizations with their members", async () => {
    const created = await state.alice.post<{ id: string; name: string }>("orgs", { name: "  Globex  " })
    expect(created.name).toBe("Globex")
    expect((await state.alice.request("orgs", { method: "POST", body: { name: "globex" } })).status).toBe(409)
    expect((await state.alice.request("orgs", { method: "POST", body: { name: " " } })).status).toBe(400)
    expect(
      (await state.alice.request(`orgs/${created.id}/rename`, { method: "POST", body: { name: "acme" } })).status,
    ).toBe(409)
    await state.alice.post(`orgs/${created.id}/rename`, { name: "Initech" })
    const orgs = await listOrgs()
    expect(orgs.map((org) => [org.name, org.machines, org.members.map((member) => member.login)])).toEqual([
      ["Acme", 1, ["bob", "carol"]],
      ["Initech", 0, []],
    ])
    // An organization without machines is deleted, with its memberships.
    await state.alice.post(`orgs/${created.id}/members`, { user: await userID("dave") })
    expect((await state.alice.request(`orgs/${created.id}`, { method: "DELETE" })).status).toBe(204)
    expect((await listOrgs()).map((org) => org.name)).toEqual(["Acme"])
    expect(await memberships(state.dave)).toEqual([])
  })

  test("an organization with machines cannot be deleted", async () => {
    const response = await state.alice.request(`orgs/${state.acme}`, { method: "DELETE" })
    expect(response.status).toBe(409)
    expect((await listOrgs()).map((org) => org.name)).toEqual(["Acme"])
  })

  test("non-administrators are refused every organization route, even as members", async () => {
    const bob = await userID("bob")
    const attempts = [
      state.bob.request("orgs"),
      state.bob.request("orgs", { method: "POST", body: { name: "Mine" } }),
      state.bob.request(`orgs/${state.acme}/rename`, { method: "POST", body: { name: "Bob Inc" } }),
      state.bob.request(`orgs/${state.acme}`, { method: "DELETE" }),
      state.dave.request(`orgs/${state.acme}/members`, { method: "POST", body: { user: await userID("dave") } }),
      state.bob.request(`orgs/${state.acme}/members/${bob}`, { method: "DELETE" }),
    ]
    expect((await Promise.all(attempts)).map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403])
    expect((await fetch(`${state.hub.url}/hub/api/orgs`)).status).toBe(401)
    expect((await listOrgs()).map((org) => [org.name, org.members.length])).toEqual([["Acme", 2]])
  })

  test("an administrator is not a member of an organization unless added", async () => {
    expect(await memberships(state.alice)).toEqual([])
    expect(await memberships(state.bob)).toEqual([{ id: state.acme, name: "Acme" }])
    expect((await list(state.alice)).map((machine) => machine.id)).toEqual([])
    expect((await host("acme-box", "/", state.alice)).status).toBe(404)
    expect((await state.alice.request("machines/code", { method: "POST", body: { org: state.acme } })).status).toBe(403)
  })
})

describe("invitations", () => {
  test("an invitation joins the new account to its organizations in the same step", async () => {
    const url = (await state.alice.post<{ url: string }>("invitations", { role: "user", orgs: [state.acme] })).url
    const pending = (await (await state.alice.request("invitations")).json()) as { orgs: string[] }[]
    expect(pending.map((invitation) => invitation.orgs)).toEqual([["Acme"]])
    const frank = await signUp(url, "frank")
    expect(await memberships(frank)).toEqual([{ id: state.acme, name: "Acme" }])
    expect((await list(frank)).map((machine) => machine.id)).toEqual(["acme-box"])
    expect(
      (await state.alice.request("invitations", { method: "POST", body: { role: "user", orgs: ["nope"] } })).status,
    ).toBe(400)
    await state.alice.request(`orgs/${state.acme}/members/${await userID("frank")}`, { method: "DELETE" })
  })

  test("the command line invitation names organizations by name, and refuses an unknown one", async () => {
    const url = Hub.invite({ data, role: "user", orgs: ["acme"] }).url
    const gina = await signUp(url, "gina")
    expect(await memberships(gina)).toEqual([{ id: state.acme, name: "Acme" }])
    expect(() => Hub.invite({ data, role: "user", orgs: ["Nowhere"] })).toThrow("unknown organization: Nowhere")
    await state.alice.request(`orgs/${state.acme}/members/${await userID("gina")}`, { method: "DELETE" })
  })
})

describe("enrollment", () => {
  test("a member enrolls a machine for the organization, which records who did", async () => {
    const all = (await (await state.alice.request("admin/machines")).json()) as { id: string; org: string | null }[]
    expect(all.map((machine) => [machine.id, machine.org])).toEqual([["acme-box", "Acme"]])
    expect((await list(state.bob)).map((machine) => [machine.id, machine.org?.name])).toEqual([["acme-box", "Acme"]])
  })

  test("a non-member cannot create a code for the organization", async () => {
    const response = await state.dave.request("machines/code", { method: "POST", body: { org: state.acme } })
    expect(response.status).toBe(403)
    expect((await state.dave.request("machines/code", { method: "POST", body: { org: "unknown" } })).status).toBe(403)
  })

  test("a member removed between the code and the enrollment is refused", async () => {
    const carol = await userID("carol")
    const code = (await state.carol.post<{ code: string }>("machines/code", { org: state.acme })).code
    await state.alice.request(`orgs/${state.acme}/members/${carol}`, { method: "DELETE" })
    const response = await fetch(`${state.hub.url}/hub/agent/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.40" },
      body: JSON.stringify({ code, name: "Carol Acme" }),
    })
    expect(response.status).toBe(403)
    await state.alice.post(`orgs/${state.acme}/members`, { user: carol })
    expect((await list(state.carol)).map((machine) => machine.id)).toEqual(["acme-box"])
  })
})

describe("access", () => {
  test("every member lists, opens and follows the organization's machines; a non-member does none of it", async () => {
    expect((await list(state.carol)).map((machine) => machine.id)).toEqual(["acme-box"])
    expect(await list(state.dave)).toEqual([])

    const events = sse((await state.carol.request("events")).body!.getReader())
    expect((await events.next()).map((machine) => machine.id)).toEqual(["acme-box"])
    await events.cancel()
    const foreign = sse((await state.dave.request("events")).body!.getReader())
    expect(await foreign.next()).toEqual([])
    await foreign.cancel()

    expect(await (await host("acme-box", "/", state.bob)).text()).toBe("local ok")
    expect(await (await host("acme-box", "/", state.carol)).text()).toBe("local ok")
    const refused = await host("acme-box", "/", state.dave)
    expect(refused.status).toBe(404)
    expect(await refused.text()).toBe(await (await host("nobody", "/", state.dave)).text())

    expect(await socketOutcome("acme-box", state.carol)).toBe("open")
    expect(await socketOutcome("acme-box", state.dave)).toBe("refused")

    const next = machineURL("acme-box", "/")
    expect(await handoff(state.carol, next)).toStartWith(`${machineURL("acme-box", "/auth/hub-session")}?ticket=`)
    expect(await handoff(state.dave, next)).toBe("/")
  })

  test("removing a member cuts their open streams, their next requests and their tickets", async () => {
    const harry = await signUp(await invite(), "harry")
    const id = await userID("harry")
    await state.alice.post(`orgs/${state.acme}/members`, { user: id })
    const ticket = await handoff(harry, machineURL("acme-box", "/"))
    const reader = (await host("acme-box", "/endless", harry)).body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("data: one")
    const socket = await openSocket("acme-box", harry)
    const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve))
    const events = sse((await harry.request("events")).body!.getReader())
    expect((await events.next()).map((machine) => machine.id)).toEqual(["acme-box"])

    const iid = store().instance("acme-box", id)!.id
    expect((await state.alice.request(`orgs/${state.acme}/members/${id}`, { method: "DELETE" })).status).toBe(204)
    await until(() => state.dropped.includes(iid))
    expect(await drained(reader)).toBe(true)
    await gate.cancelled.promise
    expect((await closed).code).toBe(1008)
    // The live list drops the machine at once.
    expect(await events.next()).toEqual([])
    await events.cancel()

    expect((await host("acme-box", "/", harry)).status).toBe(404)
    const used = await fetch(ticket, { redirect: "manual" })
    expect(used.status).toBe(404)
    // The other members keep their access.
    expect(await (await host("acme-box", "/", state.carol)).text()).toBe("local ok")
  })
})

describe("instances and LLM relay", () => {
  test("each member gets their own instance, every OPEN names it, and its relay uses that member's keys", async () => {
    await addFake(state.bob, "sk-bob")
    await addFake(state.carol, "sk-carol")
    const bob = await instanceOf(state.bob, "bob")
    const carol = await instanceOf(state.carol, "carol")
    expect(bob.iid).not.toBe(carol.iid)
    expect(bob.token).not.toBe(carol.token)
    expect(state.opened.get(bob.iid)).toBeGreaterThan(0)
    expect(state.opened.get(carol.iid)).toBeGreaterThan(0)
    expect((await relay(bob)).headers.authorization).toBe("Bearer sk-bob")
    expect((await relay(carol)).headers.authorization).toBe("Bearer sk-carol")
    // A member who never opened the machine has no instance on it.
    expect(store().instance("acme-box", await userID("dave"))).toBeUndefined()
  })

  test("pushes a member's provider changes to their own instance only", async () => {
    const carol = await instanceOf(state.carol, "carol")
    const bob = await instanceOf(state.bob, "bob")
    await state.bob.post("providers", { id: "bob-extra", name: "Extra", baseURL: upstreamURL(), apiKey: "sk-x" })
    await until(() => latest(bob.iid).llm.providers.length === 2)
    expect(latest(bob.iid).llm.providers.map((provider) => provider.id)).toEqual(["bob-extra", "fake"])
    // A configuration change keeps the token.
    expect(latest(bob.iid).token).toBe(bob.token)
    expect(latest(carol.iid).llm.providers.map((provider) => provider.id)).toEqual(["fake"])
    expect((await state.bob.request("providers/bob-extra", { method: "DELETE" })).status).toBe(204)
    await until(() => latest(bob.iid).llm.providers.length === 1)
  })

  test("answers 423 while that member's keys are locked, and only for them", async () => {
    const bob = await instanceOf(state.bob, "bob")
    const carol = await instanceOf(state.carol, "carol")
    await state.bob.post("account/lock", {})
    expect((await relayResponse(bob)).status).toBe(423)
    expect((await relay(carol)).headers.authorization).toBe("Bearer sk-carol")
    await Account.login({ post: state.bob.post, login: "bob", password: "bob-password" })
    expect((await relay(bob)).headers.authorization).toBe("Bearer sk-bob")
  })

  test("removing a member drops their instance and refuses its token; the others keep theirs", async () => {
    const bob = await instanceOf(state.bob, "bob")
    const carol = await instanceOf(state.carol, "carol")
    const id = await userID("bob")
    await state.alice.request(`orgs/${state.acme}/members/${id}`, { method: "DELETE" })
    await until(() => state.dropped.includes(bob.iid))
    expect(state.dropped).not.toContain(carol.iid)
    expect(store().instance("acme-box", id)).toBeUndefined()
    expect((await relayResponse(bob)).status).toBe(401)
    expect((await relay(carol)).headers.authorization).toBe("Bearer sk-carol")

    // Added again, Bob starts over with a new instance.
    await state.alice.post(`orgs/${state.acme}/members`, { user: id })
    const again = await instanceOf(state.bob, "bob")
    expect(again.iid).not.toBe(bob.iid)
    expect((await relay(again)).headers.authorization).toBe("Bearer sk-bob")
  })

  test("disabling a member drops their instances; the relay refuses with 403 whenever access is gone", async () => {
    const page = await signUp(await invite(), "ivan")
    const id = await userID("ivan")
    await state.alice.post(`orgs/${state.acme}/members`, { user: id })
    await addFake(page, "sk-ivan")
    const ivan = await instanceOf(page, "ivan")
    expect((await relay(ivan)).headers.authorization).toBe("Bearer sk-ivan")
    await state.alice.post(`users/${id}/disable`, {})
    await until(() => state.dropped.includes(ivan.iid))
    expect((await relayResponse(ivan)).status).toBe(401)
    await state.alice.post(`users/${id}/enable`, {})

    // An instance whose user may not open the machine, had it not been deleted: the relay checks access itself.
    const row = store().ensureInstance("acme-box", await userID("dave"))
    const token = store().issueInstanceToken(row.id)
    expect(
      (
        await fetch(`${state.hub.url}/llm/fake/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: "{}",
        })
      ).status,
    ).toBe(403)
    expect(store().pruneInstances()).toEqual([{ id: row.id, machine_id: "acme-box" }])
  })
})

describe("revocation", () => {
  test("the member who enrolled the machine or an administrator revokes it; other members cannot", async () => {
    const spare = await enroll(state.bob, "Acme Spare", state.acme)
    const listed = await list(state.carol)
    expect(listed.map((machine) => [machine.id, machine.canRevoke])).toEqual([
      ["acme-box", false],
      ["acme-spare", false],
    ])
    expect((await list(state.bob)).map((machine) => machine.canRevoke)).toEqual([true, true])
    expect((await state.carol.request("machines/acme-spare", { method: "DELETE" })).status).toBe(403)
    expect((await state.dave.request("machines/acme-spare", { method: "DELETE" })).status).toBe(404)
    expect((await state.bob.request("machines/acme-spare", { method: "DELETE" })).status).toBe(204)

    const other = await enroll(state.bob, "Acme Other", state.acme)
    expect((await state.alice.request(`machines/${other.machine.id}`, { method: "DELETE" })).status).toBe(204)
    expect((await list(state.carol)).map((machine) => machine.id)).toEqual(["acme-box"])
    expect(spare.machine.id).toBe("acme-spare")
  })
})

/** Keeps the provider catalog on its built-in list, so tests never reach models.dev. */
const offline = Object.assign(async () => Response.error(), { preconnect: () => {} }) as typeof fetch

/** Each page signs up from its own client address, so sign-in throttling never crosses tests. */
async function signUp(url: string, login: string) {
  const page = browser(state.hub.url, { "x-forwarded-for": `198.51.100.${addresses.next++}` })
  const invite = new URL(url).searchParams.get("invite") ?? ""
  await Account.register({ post: page.post, invite, login, password: `${login}-password` })
  return page
}

async function invite() {
  return (await state.alice.post<{ url: string }>("invitations", { role: "user" })).url
}

async function enroll(page: Page, name: string, org?: string) {
  const code = (await page.post<{ code: string }>("machines/code", org ? { org } : {})).code
  return Agent.enroll({ url: state.hub.url, code, name })
}

async function connect(enrollment: Agent.Enrollment) {
  const ready = Promise.withResolvers<void>()
  const agent = Agent.connect({
    enrollment,
    local: async (iid) => {
      state.opened.set(iid, (state.opened.get(iid) ?? 0) + 1)
      return { url: `http://127.0.0.1:${local.port}` }
    },
    onReady: () => ready.resolve(),
    onInstance: (instance) => state.instances.push(instance),
    onDrop: (iid) => state.dropped.push(iid),
  })
  await ready.promise
  return agent
}

/** The hub's database, opened once alongside the running hub. */
function store() {
  state.store ??= Store.open(data)
  return state.store
}

/** The latest configuration the agent received for an instance. */
function latest(iid: string) {
  return state.instances.findLast((instance) => instance.iid === iid)!
}

/** Opens the organization machine as this member, then returns their instance as the agent last received it. */
async function instanceOf(page: Page, login: string) {
  expect(await (await host("acme-box", "/", page)).text()).toBe("local ok")
  const row = store().instance("acme-box", await userID(login))
  expect(row).toBeDefined()
  return latest(row!.id)
}

async function list(page: Page) {
  return (await (await page.request("machines")).json()) as Listed[]
}

async function listOrgs() {
  return (await (await state.alice.request("orgs")).json()) as Org[]
}

async function memberships(page: Page) {
  return (await (await page.request("memberships")).json()) as { id: string; name: string }[]
}

async function userID(login: string) {
  const users = (await (await state.alice.request("users")).json()) as { id: string; login: string }[]
  return users.find((user) => user.login === login)?.id ?? ""
}

function upstreamURL() {
  return `http://127.0.0.1:${upstream.port}/v1`
}

async function addFake(page: Page, apiKey: string) {
  await page.post("providers", { id: "fake", name: "Fake", baseURL: upstreamURL(), apiKey })
}

function relayResponse(instance: Agent.Instance) {
  return fetch(`${state.hub.url}/llm/fake/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${instance.token}`, "content-type": "application/json" },
    body: "{}",
  })
}

async function relay(instance: Agent.Instance) {
  const response = await relayResponse(instance)
  expect(response.status).toBe(200)
  return (await response.json()) as Echo
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

async function until(condition: () => boolean, deadline = Date.now() + 3000): Promise<void> {
  if (condition()) return
  if (Date.now() > deadline) throw new Error("condition not met in time")
  await Bun.sleep(5)
  return until(condition, deadline)
}
