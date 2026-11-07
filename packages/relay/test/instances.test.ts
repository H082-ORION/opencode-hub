import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Account } from "../src/account.js"
import { Instances } from "../src/agent/instances.js"
import { Agent, Hub } from "../src/index.js"
import { Store } from "../src/hub/store.js"
import { browser } from "./fixture/browser.js"

// One opencode instance per user and machine (specs/multi-users.md, step 5): the hub's instances, protocol 2 frames
// and the agent's instance manager, with a stand-in for `opencode serve --stdio`.

type Page = ReturnType<typeof browser>
type Server = {
  pid: number
  cwd: string
  args: string[]
  data: string
  config: string
  state: string
  cache: string
  token: string
  content?: string
  leaked?: string
}

const SERVER = [process.execPath, path.join(import.meta.dir, "fixture", "instance-server.ts")]

const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => Response.json({ authorization: request.headers.get("authorization") }),
})
const personal = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("personal service") })

const dirs: string[] = []
const addresses = { next: 1 }
const state = {} as {
  hub: Awaited<ReturnType<typeof Hub.start>>
  data: string
  root: string
  alice: Page
  bob: Page
  carol: Page
  acme: string
  box: Agent.Enrollment
  instances: Instances.Manager
  agent: ReturnType<typeof Agent.connect>
  received: Agent.Instance[]
  dropped: string[]
  store: Store.Instance
}

beforeAll(async () => {
  state.data = tempDir()
  state.root = path.join(tempDir(), "hub-instances")
  state.hub = await Hub.start({ hostname: "127.0.0.1", port: 0, data: state.data, catalog: { fetch: offline } })
  state.store = Store.open(state.data)
  state.alice = await signUp(state.hub.invite("admin").url, "alice")
  state.bob = await signUp(await invite(), "bob")
  state.carol = await signUp(await invite(), "carol")
  state.acme = (await state.alice.post<{ id: string }>("orgs", { name: "Acme" })).id
  await state.alice.post(`orgs/${state.acme}/members`, { user: userID("bob") })
  await state.alice.post(`orgs/${state.acme}/members`, { user: userID("carol") })
  await state.bob.post("providers", { id: "fake", name: "Fake", baseURL: upstreamURL(), apiKey: "sk-bob" })
  await state.carol.post("providers", { id: "fake", name: "Fake", baseURL: upstreamURL(), apiKey: "sk-carol" })
  state.box = await enroll(state.bob, "Acme Box", state.acme)
  state.instances = Instances.create({ root: state.root, command: SERVER, cwd: os.tmpdir() })
  state.received = []
  state.dropped = []
  state.agent = await connectOrg()
})

afterAll(async () => {
  await state.agent?.close()
  await state.instances?.stop()
  await state.hub?.stop()
  state.store?.close()
  upstream.stop(true)
  personal.stop(true)
  dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

describe("personal machine", () => {
  test("has one instance, its owner's, sent right after READY and reused when the owner opens it", async () => {
    const enrollment = await enroll(state.alice, "Alice Box")
    const ready = Promise.withResolvers<Agent.Ready>()
    const received: Agent.Instance[] = []
    const opened: string[] = []
    const agent = Agent.connect({
      enrollment,
      local: async (iid) => {
        opened.push(iid)
        return { url: `http://127.0.0.1:${personal.port}` }
      },
      onReady: ready.resolve,
      onInstance: (instance) => received.push(instance),
    })
    const greeting = await ready.promise
    expect(greeting.owner).toBe("user")
    await until(() => received.length === 1)
    expect(greeting.instances).toEqual([received[0]!.iid])
    expect(await (await host("alice-box", "/", state.alice)).text()).toBe("personal service")
    expect(await (await host("alice-box", "/", state.alice)).text()).toBe("personal service")
    // No second INSTANCE: the agent already holds the token on this connection.
    expect(received.length).toBe(1)
    expect(new Set(opened)).toEqual(new Set([received[0]!.iid]))
    expect(state.store.instancesOf("alice-box").map((instance) => instance.user_id)).toEqual([userID("alice")])
    await agent.close()
  })
})

describe("organization machine", () => {
  test("READY says the machine belongs to an organization and starts with no instance", () => {
    expect(state.received).toEqual([])
  })

  test("routes each member to their own server, with its own folders, port, password and token", async () => {
    const bob = (await (await host("acme-box", "/", state.bob)).json()) as Server
    const carol = (await (await host("acme-box", "/", state.carol)).json()) as Server
    const iids = state.received.map((instance) => instance.iid)
    expect(new Set(iids).size).toBe(2)
    const [bobID, carolID] = [instanceID("bob"), instanceID("carol")]
    expect(iids).toEqual([bobID, carolID])
    expect(bob.pid).not.toBe(carol.pid)
    expect(bob.data).toBe(path.join(state.root, bobID, "data"))
    expect(bob.config).toBe(path.join(state.root, bobID, "config"))
    expect(bob.state).toBe(path.join(state.root, bobID, "state"))
    expect(bob.cache).toBe(path.join(state.root, bobID, "cache"))
    expect(carol.data).toBe(path.join(state.root, carolID, "data"))
    expect(bob.args).toEqual(["--stdio", "--hostname", "127.0.0.1", "--port", "0"])
    expect(bob.token).toBe(latest(bobID).token)
    expect(carol.token).toBe(latest(carolID).token)
    expect(JSON.parse(bob.content ?? "{}")).toEqual({
      providers: {
        fake: { env: [Instances.TOKEN], settings: { baseURL: `${state.hub.url}/llm/fake` } },
      },
    })
    // The same member reaches the same server again.
    expect(((await (await host("acme-box", "/", state.bob)).json()) as Server).pid).toBe(bob.pid)
    // Each instance's token relays with its own member's keys.
    expect(await relayAuthorization(bob.token)).toBe("Bearer sk-bob")
    expect(await relayAuthorization(carol.token)).toBe("Bearer sk-carol")
  })

  test("a member's provider change restarts only their instance, with the same token", async () => {
    const bobID = instanceID("bob")
    const carolID = instanceID("carol")
    const before = {
      bob: ((await (await host("acme-box", "/", state.bob)).json()) as Server).pid,
      carol: ((await (await host("acme-box", "/", state.carol)).json()) as Server).pid,
    }
    await state.bob.post("providers", { id: "extra", name: "Extra", baseURL: upstreamURL(), apiKey: "sk-x" })
    await until(() => latest(bobID).llm.providers.length === 2)
    await until(() => !state.instances.running(bobID))
    const bob = (await (await host("acme-box", "/", state.bob)).json()) as Server
    expect(bob.pid).not.toBe(before.bob)
    expect(Object.keys((JSON.parse(bob.content ?? "{}") as { providers: object }).providers)).toEqual(["extra", "fake"])
    expect(bob.token).toBe(state.received.find((instance) => instance.iid === bobID)!.token)
    expect(((await (await host("acme-box", "/", state.carol)).json()) as Server).pid).toBe(before.carol)
    expect(state.instances.running(carolID)).toBe(true)
  })

  test("removing a member stops their instance, deletes its folder and refuses its token", async () => {
    const page = await signUp(await invite(), "dave")
    await state.alice.post(`orgs/${state.acme}/members`, { user: userID("dave") })
    const dave = (await (await host("acme-box", "/", page)).json()) as Server
    const iid = instanceID("dave")
    expect(existsSync(path.join(state.root, iid))).toBe(true)

    await state.alice.request(`orgs/${state.acme}/members/${userID("dave")}`, { method: "DELETE" })
    await until(() => state.dropped.includes(iid))
    await until(() => !existsSync(path.join(state.root, iid)))
    expect(state.instances.running(iid)).toBe(false)
    expect(processAlive(dave.pid)).toBe(false)
    expect(await relayStatus(dave.token)).toBe(401)
    // The other members' instances keep running.
    expect(state.instances.running(instanceID("carol"))).toBe(true)
  })

  test("disabling a member drops their instance too", async () => {
    const page = await signUp(await invite(), "erin")
    await state.alice.post(`orgs/${state.acme}/members`, { user: userID("erin") })
    const erin = (await (await host("acme-box", "/", page)).json()) as Server
    const iid = instanceID("erin")
    await state.alice.post(`users/${userID("erin")}/disable`, {})
    await until(() => state.dropped.includes(iid) && !existsSync(path.join(state.root, iid)))
    expect(processAlive(erin.pid)).toBe(false)
    expect(await relayStatus(erin.token)).toBe(401)
  })

  test("an agent that reconnects after a removal made offline deletes the stale instance, keeping the others' tokens", async () => {
    const bobID = instanceID("bob")
    const carolID = instanceID("carol")
    const tokens = new Map([bobID, carolID].map((iid) => [iid, latest(iid).token] as const))
    const carol = ((await (await host("acme-box", "/", state.carol)).json()) as Server).pid
    await state.agent.close()
    await state.instances.stop()
    expect(processAlive(carol)).toBe(false)

    await signUp(await invite(), "frank")
    await state.alice.post(`orgs/${state.acme}/members`, { user: userID("frank") })
    // Frank's instance exists on the hub while the machine is offline; its folder stands for one left on disk.
    const frank = state.store.ensureInstance("acme-box", userID("frank"))
    mkdirSync(path.join(state.root, frank.id, "data"), { recursive: true })
    await state.alice.request(`orgs/${state.acme}/members/${userID("bob")}`, { method: "DELETE" })
    await state.alice.request(`orgs/${state.acme}/members/${userID("frank")}`, { method: "DELETE" })

    const before = state.received.length
    const ready = Promise.withResolvers<Agent.Ready>()
    state.agent = Agent.connect({
      enrollment: state.box,
      instances: Array.from(tokens, (entry) => ({ iid: entry[0], token: entry[1] })),
      local: (iid) => state.instances.local(iid),
      onReady: (greeting) => {
        void state.instances.prune(greeting.instances)
        ready.resolve(greeting)
      },
      onInstance: (instance) => {
        state.received.push(instance)
        void state.instances.configure(instance)
      },
      onDrop: (iid) => {
        state.dropped.push(iid)
        void state.instances.drop(iid)
      },
    })
    const greeting = await ready.promise
    expect(greeting.instances).toEqual([carolID])
    expect(state.dropped).toContain(bobID)
    await until(() => !existsSync(path.join(state.root, bobID)) && !existsSync(path.join(state.root, frank.id)))
    // Carol's instance is refreshed without a new token: the agent proved it holds the current one.
    await until(() => state.received.length > before)
    expect(state.received.at(-1)).toMatchObject({ iid: carolID, token: tokens.get(carolID) })
    expect(await relayAuthorization(tokens.get(carolID)!)).toBe("Bearer sk-carol")
    // Her folder, with her sessions, survived; her server starts again on demand.
    expect(existsSync(path.join(state.root, carolID))).toBe(true)
    expect(((await (await host("acme-box", "/", state.carol)).json()) as Server).token).toBe(tokens.get(carolID)!)
  })

  test("an agent that does not hold the current token gets a new one at the next open", async () => {
    const carolID = instanceID("carol")
    const old = latest(carolID).token
    await state.agent.close()
    await state.instances.stop()
    state.agent = await connectOrg()
    const carol = (await (await host("acme-box", "/", state.carol)).json()) as Server
    expect(latest(carolID).token).not.toBe(old)
    expect(carol.token).toBe(latest(carolID).token)
    expect(await relayStatus(old)).toBe(401)
  })

  test("revoking the machine drops every instance before the agent stops", async () => {
    const carolID = instanceID("carol")
    const token = latest(carolID).token
    // Bob, who enrolled it, left the organization: an administrator revokes it.
    expect((await state.alice.request("machines/acme-box", { method: "DELETE" })).status).toBe(204)
    await until(() => state.dropped.includes(carolID) && !existsSync(path.join(state.root, carolID)))
    expect(await relayStatus(token)).toBe(401)
    expect(state.store.instancesOf("acme-box")).toEqual([])
  })
})

describe("instance manager", () => {
  test("refuses instance ids that are not plain names", async () => {
    const manager = Instances.create({ root: tempDir(), command: SERVER })
    await expect(manager.configure({ ...sample(), iid: "../../escape-attempt" })).rejects.toThrow("invalid instance")
    await expect(manager.local("unknown-instance-id")).rejects.toThrow("unknown instance")
  })

  test("drops only unlisted instance folders on prune, and leaves other files alone", async () => {
    const root = tempDir()
    const manager = Instances.create({ root, command: SERVER })
    ;["keep-this-instance-1", "drop-this-instance-2"].forEach((iid) => mkdirSync(path.join(root, iid)))
    mkdirSync(path.join(root, "not.an.instance"))
    await manager.prune(["keep-this-instance-1"])
    expect(existsSync(path.join(root, "keep-this-instance-1"))).toBe(true)
    expect(existsSync(path.join(root, "drop-this-instance-2"))).toBe(false)
    expect(existsSync(path.join(root, "not.an.instance"))).toBe(true)
  })

  test("does not pass the agent's own configuration or credentials to an instance", async () => {
    const root = tempDir()
    const manager = Instances.create({
      root,
      command: SERVER,
      env: { ...process.env, OPENCODE_CONFIG_DIR: "/agent/config", OPENCODE_HUB_LLM_TOKEN: "agent-token" },
    })
    const instance = sample()
    await manager.configure(instance)
    const local = await manager.local(instance.iid)
    const answer = (await (
      await fetch(local.url, { headers: { authorization: `Basic ${btoa(`opencode:${local.password}`)}` } })
    ).json()) as Server
    expect(answer.leaked).toBeUndefined()
    expect(answer.token).toBe(instance.token)
    // No providers: no configuration content, the token is still there for later.
    expect(answer.content).toBeUndefined()
    await manager.stop()
    expect(processAlive(answer.pid)).toBe(false)
    // Stopping keeps the instance's folder; only a drop deletes it.
    expect(existsSync(path.join(root, instance.iid))).toBe(true)
  })
})

/** Keeps the provider catalog on its built-in list, so tests never reach models.dev. */
const offline = Object.assign(async () => Response.error(), { preconnect: () => {} }) as typeof fetch

function sample(): Agent.Instance {
  return {
    iid: "sample-instance-0001",
    token: "sample-token",
    llm: { baseURL: "https://hub.example.com/llm", providers: [] },
    mcp: [],
    skills: { version: "none" },
  }
}

async function connectOrg() {
  const ready = Promise.withResolvers<Agent.Ready>()
  const agent = Agent.connect({
    enrollment: state.box,
    local: (iid) => state.instances.local(iid),
    onReady: (greeting) => {
      expect(greeting.owner).toBe("org")
      ready.resolve(greeting)
    },
    onInstance: (instance) => {
      state.received.push(instance)
      void state.instances.configure(instance)
    },
    onDrop: (iid) => {
      state.dropped.push(iid)
      void state.instances.drop(iid)
    },
  })
  await ready.promise
  return agent
}

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opencode-instances-"))
  dirs.push(dir)
  return dir
}

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

function userID(login: string) {
  return state.store.userByLogin(login)!.id
}

function instanceID(login: string) {
  return state.store.instance("acme-box", userID(login))!.id
}

function latest(iid: string) {
  return state.received.findLast((instance) => instance.iid === iid)!
}

function upstreamURL() {
  return `http://127.0.0.1:${upstream.port}/v1`
}

function host(id: string, pathname: string, page: Page) {
  return fetch(`http://${id}.localhost:${state.hub.port}${pathname}`, {
    headers: { cookie: page.jar.cookie },
    redirect: "manual",
  })
}

function relay(token: string) {
  return fetch(`${state.hub.url}/llm/fake/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: "{}",
  })
}

async function relayStatus(token: string) {
  return (await relay(token)).status
}

/** The key the hub put in front of the upstream, or undefined when the relay refused. */
async function relayAuthorization(token: string) {
  const response = await relay(token)
  if (response.status !== 200) return undefined
  return ((await response.json()) as { authorization: string }).authorization
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(condition: () => boolean, deadline = Date.now() + 10_000): Promise<void> {
  if (condition()) return
  if (Date.now() > deadline) throw new Error("condition not met in time")
  await Bun.sleep(10)
  return until(condition, deadline)
}
