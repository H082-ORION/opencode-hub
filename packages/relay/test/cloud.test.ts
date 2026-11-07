import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Account } from "../src/account.js"
import { type Agent, Hub } from "../src/index.js"
import { browser, Refused } from "./fixture/browser.js"

// Cloud hosts and cloud instances (specs/cloud.md). A fake host speaks the host protocol of agent-hub-lxd.

type Page = ReturnType<typeof browser>
type Message = { type: string; [key: string]: unknown }
type CloudInstance = {
  id: string
  name: string
  status: string
  error: string | null
  limits: { cpu: number; memory_mib: number; disk_gib: number }
  machine: string | null
  url: string | null
  metrics: { cpuPercent: number | null; memoryUsedBytes: number } | null
}
type CloudView = {
  hosts: {
    id: string
    name: string
    online: boolean
    max: { cpu: number; memory_mib: number; disk_gib: number; full: boolean } | null
  }[]
  instances: CloudInstance[]
  admin: {
    hosts: { id: string; online: boolean; capacity: unknown; metrics: unknown; instances: number }[]
    instances: (CloudInstance & { owner: string | null })[]
  } | null
}
type Enrolled = { host: { id: string; name: string }; token: string; url: string }

const CAPACITY = {
  cpu: { total: 16, reserved: 2, allocated: 0, available: 14 },
  memory_mib: { total: 65536, reserved: 4096, allocated: 0, available: 61440 },
  disk_gib: { total: 1000, reserved: 50, allocated: 0, available: 950 },
  instances: { count: 0, max: 10 },
  per_instance_max: { cpu: 8, memory_mib: 16384, disk_gib: 100 },
}
const LIMITS = { cpu: 2, memory_mib: 4096, disk_gib: 20 }
const offline = Object.assign(async () => Response.error(), { preconnect: () => {} }) as typeof fetch

const data = mkdtempSync(path.join(os.tmpdir(), "opencode-cloud-"))
const state = {} as { hub: Awaited<ReturnType<typeof Hub.start>>; alice: Page; bob: Page; host: Enrolled }
const addresses = { next: 1 }

beforeAll(async () => {
  state.hub = await Hub.start({ hostname: "127.0.0.1", port: 0, data, catalog: { fetch: offline } })
  state.alice = await signUp(state.hub.invite("admin").url, "alice")
  state.bob = await signUp((await state.alice.post<{ url: string }>("invitations", { role: "user" })).url, "bob")
  state.host = await enrollHost(state.alice, "LXD Paris")
})

afterAll(async () => {
  await state.hub?.stop()
  rmSync(data, { recursive: true, force: true })
})

describe("enrollment", () => {
  test("only administrators create host codes", async () => {
    expect((await state.bob.request("cloud/hosts/code", { method: "POST", body: {} })).status).toBe(403)
    expect(state.host.host.id).toBe("lxd-paris")
    expect(state.host.url).toBe(state.hub.url)
  })

  test("a machine code does not enroll a host, and a host code does not enroll a machine", async () => {
    const machineCode = (await state.bob.post<{ code: string }>("machines/code", {})).code
    expect((await hostEnroll(machineCode, "Sneaky")).status).toBe(403)
    const hostCode = (await state.alice.post<{ code: string }>("cloud/hosts/code", {})).code
    expect((await machineEnroll(hostCode, "Sneaky")).status).toBe(403)
  })

  test("an unknown token is refused at the upgrade, and a protocol mismatch closes the socket", async () => {
    const refused = await fetch(`${state.hub.url}/hub/host/connect`, { headers: { authorization: "Bearer nope" } })
    expect(refused.status).toBe(401)
    const ws = new WebSocket(connectURL(), { headers: { authorization: `Bearer ${state.host.token}` } })
    await new Promise((resolve) => ws.addEventListener("open", resolve))
    ws.send(JSON.stringify({ ...hello([]), protocol: 99 }))
    expect(await closedWith(ws)).toBe(4400)
  })
})

describe("instances", () => {
  test("a user creates an instance, its VM pairs as their machine, and the host's answer makes it running", async () => {
    const host = await connectHost(state.host.token)
    const view = await cloudView(state.bob)
    expect(view.hosts).toEqual([
      {
        id: "lxd-paris",
        name: "LXD Paris",
        online: true,
        max: { cpu: 8, memory_mib: 16384, disk_gib: 100, full: false },
      },
    ])
    expect(view.admin).toBeNull()

    const created = await state.bob.post<{ instance: CloudInstance }>("cloud/instances", {
      host: "lxd-paris",
      name: "Bob Cloud",
      ...LIMITS,
    })
    expect(created.instance.status).toBe("creating")
    const request = await host.next("create")
    expect(request.instance).toBe(created.instance.id)
    expect(request.limits).toEqual(LIMITS)
    // SAFETY: the hub sends `pairing: { code }` with every create.
    const code = (request.pairing as { code: string }).code

    // What hub-pair does in the VM: `opencode agent join` with the code.
    const paired = await machineEnroll(code, `hub-${created.instance.id}`)
    expect(paired.status).toBe(200)
    // SAFETY: a 200 from `/hub/agent/enroll` carries the machine.
    const machine = (await paired.json()) as Agent.Enrollment
    expect(machine.machine.name).toBe("Bob Cloud")
    expect((await machineEnroll(code, "again")).status).toBe(403)
    host.send({
      type: "result",
      id: request.id,
      ok: true,
      instance: { instance: created.instance.id, status: "running", limits: LIMITS, created_at: null },
    })
    await until(async () => (await mine(state.bob))?.status === "running")
    const instance = await mine(state.bob)
    expect(instance?.machine).toBe(machine.machine.id)
    expect(instance?.url).toContain(encodeURIComponent(`${machine.machine.id}.localhost`))

    // The machine is Bob's, and it goes away with the instance only.
    const machines = (await (await state.bob.request("machines")).json()) as { id: string; canRevoke: boolean }[]
    expect(machines.find((entry) => entry.id === machine.machine.id)?.canRevoke).toBe(false)
    expect((await state.bob.request(`machines/${machine.machine.id}`, { method: "DELETE" })).status).toBe(409)
    host.close()
  })

  test("limits beyond what the host can give, and other users' instances, are refused", async () => {
    const host = await connectHost(state.host.token, [
      { instance: (await mine(state.bob))!.id, status: "running", limits: LIMITS },
    ])
    const tooBig = state.bob.post("cloud/instances", { host: "lxd-paris", name: "Huge", ...LIMITS, cpu: 9 })
    await expect(tooBig).rejects.toBeInstanceOf(Refused)
    expect(
      (await state.bob.request("cloud/instances", { method: "POST", body: { host: "nowhere", name: "x", ...LIMITS } }))
        .status,
    ).toBe(409)
    const id = (await mine(state.bob))!.id
    // A user who does not have it cannot see, stop or delete it; an administrator can.
    const other = await signUp((await state.alice.post<{ url: string }>("invitations", { role: "user" })).url, "carol")
    expect((await other.request(`cloud/instances/${id}/stop`, { method: "POST", body: {} })).status).toBe(404)
    expect((await other.request(`cloud/instances/${id}`, { method: "DELETE" })).status).toBe(404)
    expect((await cloudView(other)).instances).toEqual([])
    host.close()
  })

  test("metrics reach the instance's owner, and the host's details only administrators", async () => {
    const id = (await mine(state.bob))!.id
    const host = await connectHost(state.host.token, [{ instance: id, status: "running", limits: LIMITS }])
    const sample = (usage: number) => ({
      type: "metrics",
      host: {
        cpu_threads: 16,
        load: [0.5, 0.4, 0.3],
        memory_total_bytes: 64 * 2 ** 30,
        memory_used_bytes: 8 * 2 ** 30,
        disk_total_bytes: 2 ** 40,
        disk_used_bytes: 2 ** 38,
      },
      capacity: { ...CAPACITY, cpu: { ...CAPACITY.cpu, allocated: 2, available: 12 } },
      instances: [
        {
          instance: id,
          status: "running",
          cpu_usage_ns: usage,
          memory_usage_bytes: 2 ** 30,
          memory_total_bytes: 4 * 2 ** 30,
          disk_usage_bytes: 5 * 2 ** 30,
          network_rx_bytes: 10,
          network_tx_bytes: 20,
        },
      ],
    })
    host.send(sample(1_000_000_000))
    await until(async () => (await mine(state.bob))?.metrics?.memoryUsedBytes === 2 ** 30)
    expect((await mine(state.bob))?.metrics?.cpuPercent).toBeNull()
    host.send(sample(2_000_000_000))
    await until(async () => (await mine(state.bob))?.metrics?.cpuPercent !== null)
    expect((await mine(state.bob))?.metrics?.cpuPercent).toBeGreaterThan(0)

    expect((await cloudView(state.bob)).hosts[0]?.max?.cpu).toBe(8)
    const admin = (await cloudView(state.alice)).admin
    expect(admin?.hosts.map((entry) => [entry.id, entry.online, entry.instances])).toEqual([["lxd-paris", true, 1]])
    expect(admin?.hosts[0]?.metrics).not.toBeNull()
    expect(admin?.instances.map((entry) => entry.owner)).toEqual(["bob"])
    host.close()
  })

  test("a failed create is reported, and a failed instance is deleted without its host", async () => {
    const host = await connectHost(state.host.token, [
      { instance: (await mine(state.bob))!.id, status: "running", limits: LIMITS },
    ])
    const created = await state.bob.post<{ instance: CloudInstance }>("cloud/instances", {
      host: "lxd-paris",
      name: "Doomed",
      ...LIMITS,
    })
    const request = await host.next("create")
    host.send({ type: "result", id: request.id, ok: false, error: { code: "pairing", message: "pairing failed" } })
    await until(async () => (await byName(state.bob, "Doomed"))?.status === "failed")
    expect((await byName(state.bob, "Doomed"))?.error).toBe("pairing failed")
    host.close()
    await until(async () => !(await cloudView(state.bob)).hosts[0]?.online)
    expect((await state.bob.request(`cloud/instances/${created.instance.id}`, { method: "DELETE" })).status).toBe(204)
    expect(await byName(state.bob, "Doomed")).toBeUndefined()
  })

  test("a host that reconnects settles what the hub was waiting for", async () => {
    const running = (await mine(state.bob))!.id
    const host = await connectHost(state.host.token, [{ instance: running, status: "running", limits: LIMITS }])
    await state.bob.post("cloud/instances", { host: "lxd-paris", name: "Lost", ...LIMITS })
    await host.next("create")
    host.close()
    // The VM never appeared: the answer was lost with the connection, so the instance failed. The running one stopped.
    const again = await connectHost(state.host.token, [{ instance: running, status: "stopped", limits: LIMITS }])
    await until(async () => (await byName(state.bob, "Lost"))?.status === "failed")
    expect((await mine(state.bob))?.status).toBe("stopped")
    expect(
      (await state.bob.request(`cloud/instances/${(await byName(state.bob, "Lost"))!.id}`, { method: "DELETE" }))
        .status,
    ).toBe(202)
    const deleted = await again.next("delete")
    again.send({ type: "result", id: deleted.id, ok: false, error: { code: "not_found", message: "unknown instance" } })
    await until(async () => (await byName(state.bob, "Lost")) === undefined)
    again.close()
  })

  test("start, stop and delete go to the host; deleting revokes the instance's machine", async () => {
    const instance = (await mine(state.bob))!
    const host = await connectHost(state.host.token, [{ instance: instance.id, status: "stopped", limits: LIMITS }])
    await state.bob.post(`cloud/instances/${instance.id}/start`, {})
    expect((await mine(state.bob))?.status).toBe("starting")
    // One operation at a time.
    expect((await state.bob.request(`cloud/instances/${instance.id}/stop`, { method: "POST", body: {} })).status).toBe(
      409,
    )
    const start = await host.next("start")
    host.send({
      type: "result",
      id: start.id,
      ok: true,
      instance: { instance: instance.id, status: "running", limits: LIMITS },
    })
    await until(async () => (await mine(state.bob))?.status === "running")

    // A host that still has instances cannot be revoked.
    expect((await state.alice.request("cloud/hosts/lxd-paris", { method: "DELETE" })).status).toBe(409)

    expect((await state.bob.request(`cloud/instances/${instance.id}`, { method: "DELETE" })).status).toBe(202)
    const deleted = await host.next("delete")
    expect(deleted.instance).toBe(instance.id)
    host.send({ type: "result", id: deleted.id, ok: true })
    await until(async () => (await cloudView(state.bob)).instances.length === 0)
    const machines = (await (await state.bob.request("machines")).json()) as { id: string }[]
    expect(machines.map((machine) => machine.id)).not.toContain(instance.machine!)

    // Now it can be revoked, and its connection closes for good.
    const closed = closedWith(host.ws)
    expect((await state.alice.request("cloud/hosts/lxd-paris", { method: "DELETE" })).status).toBe(204)
    expect(await closed).toBe(4401)
    expect((await cloudView(state.bob)).hosts).toEqual([])
  })
})

async function signUp(url: string, login: string) {
  const page = browser(state.hub.url, { "x-forwarded-for": `198.51.100.${addresses.next++}` })
  const invite = new URL(url).searchParams.get("invite") ?? ""
  await Account.register({ post: page.post, invite, login, password: `${login}-password` })
  return page
}

async function enrollHost(admin: Page, name: string) {
  const code = (await admin.post<{ code: string }>("cloud/hosts/code", {})).code
  const response = await hostEnroll(code, name)
  expect(response.status).toBe(200)
  // SAFETY: a 200 from `/hub/host/enroll` carries the enrollment.
  return (await response.json()) as Enrolled
}

function hostEnroll(code: string, name: string) {
  return fetch(`${state.hub.url}/hub/host/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${addresses.next++}` },
    body: JSON.stringify({ code, name }),
  })
}

/** What `opencode agent join` sends, from its own client address so failed attempts elsewhere do not throttle it. */
function machineEnroll(code: string, name: string) {
  return fetch(`${state.hub.url}/hub/agent/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${addresses.next++}` },
    body: JSON.stringify({ code, name }),
  })
}

function connectURL() {
  return `${state.hub.url.replace(/^http/, "ws")}/hub/host/connect`
}

function hello(instances: unknown[]) {
  return {
    type: "hello",
    protocol: 1,
    version: "0.1.0",
    name: "lxd-paris",
    platform: { os: "linux", arch: "x86_64", lxd_version: "6.1", project: "hub" },
    capacity: CAPACITY,
    instances,
  }
}

/** A fake agent-hub-lxd: answers pings, and hands the test every other message it receives. */
async function connectHost(token: string, instances: unknown[] = []) {
  const ws = new WebSocket(connectURL(), { headers: { authorization: `Bearer ${token}` } })
  const inbox: Message[] = []
  const waiting: { type: string; resolve: (message: Message) => void }[] = []
  ws.addEventListener("message", (event) => {
    // SAFETY: the hub only sends JSON objects with a `type`.
    const message = JSON.parse(String(event.data)) as Message
    if (message.type === "ping") return ws.send(JSON.stringify({ type: "pong" }))
    const index = waiting.findIndex((entry) => entry.type === message.type)
    if (index === -1) return void inbox.push(message)
    waiting.splice(index, 1)[0]!.resolve(message)
  })
  await new Promise((resolve) => ws.addEventListener("open", resolve))
  ws.send(JSON.stringify(hello(instances)))
  const next = (type: string) => {
    const index = inbox.findIndex((message) => message.type === type)
    if (index !== -1) return Promise.resolve(inbox.splice(index, 1)[0]!)
    return new Promise<Message>((resolve) => waiting.push({ type, resolve }))
  }
  await next("ready")
  return {
    ws,
    next: (type: string) => next(type).then((message) => message as Message & { id: string; instance: string }),
    send: (message: unknown) => ws.send(JSON.stringify(message)),
    close: () => ws.close(),
  }
}

function closedWith(ws: WebSocket) {
  return new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code)))
}

async function cloudView(page: Page) {
  return (await (await page.request("cloud")).json()) as CloudView
}

async function byName(page: Page, name: string) {
  return (await cloudView(page)).instances.find((instance) => instance.name === name)
}

async function mine(page: Page) {
  return byName(page, "Bob Cloud")
}

/** Polls a condition the hub reaches asynchronously, for at most 5 seconds. */
async function until(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 5000
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not reached in time")
    await Bun.sleep(10)
  }
}
