import { Database } from "bun:sqlite"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Account } from "../src/account.js"
import { Agent, Hub } from "../src/index.js"
import { Providers } from "../src/hub/providers.js"
import { Secrets } from "../src/hub/secrets.js"
import { Store } from "../src/hub/store.js"
import { browser } from "./fixture/browser.js"

// API keys sealed under each user's key, and the LLM relay that uses the machine owner's (specs/multi-users.md,
// step 3).

type Page = ReturnType<typeof browser>
type Echo = { path: string; headers: Record<string, string> }

const ALICE_KEY = "sk-alice-0123456789-plaintext"
const BOB_KEY = "sk-bob-9876543210-plaintext"

// Echoes the headers it receives, so a test sees which key the hub injected.
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    return Response.json({ path: `${url.pathname}${url.search}`, headers: Object.fromEntries(request.headers) })
  },
})
const local = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("local ok") })

const dirs: string[] = []
const addresses = { next: 1 }
const state = {} as {
  hub: Awaited<ReturnType<typeof Hub.start>>
  alice: Page
  bob: Page
  machines: { alice: Agent.Enrollment; bob: Agent.Enrollment }
  configs: { alice: Agent.LlmConfig[]; bob: Agent.LlmConfig[] }
  agents: ReturnType<typeof Agent.connect>[]
}

beforeAll(async () => {
  state.hub = await Hub.start({ hostname: "127.0.0.1", port: 0, data: tempDir(), catalog: { fetch: offline } })
  state.alice = await signUp(state.hub.url, state.hub.invite("admin").url, "alice")
  state.bob = await signUp(state.hub.url, await invite(state.alice), "bob")
  state.machines = {
    alice: await enroll(state.hub.url, state.alice, "Alice Box"),
    bob: await enroll(state.hub.url, state.bob, "Bob Box"),
  }
  state.configs = { alice: [], bob: [] }
  state.agents = await Promise.all([
    connect(state.machines.alice, state.configs.alice),
    connect(state.machines.bob, state.configs.bob),
  ])
})

afterAll(async () => {
  await Promise.all(state.agents?.map((agent) => agent.close()) ?? [])
  await state.hub?.stop()
  upstream.stop(true)
  local.stop(true)
  dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

describe("sealed secrets", () => {
  const key = Account.encode(crypto.getRandomValues(new Uint8Array(32)))
  const place = { table: "provider", row: "anthropic", user: "user-1" }

  test("round-trips under the same key and place", async () => {
    const sealed = await Secrets.seal(key, place, "sk-secret")
    expect(sealed).not.toContain("sk-secret")
    expect(await Secrets.open(key, place, sealed)).toBe("sk-secret")
    // A fresh nonce each time.
    expect(await Secrets.seal(key, place, "sk-secret")).not.toBe(sealed)
  })

  test("is version 1, a 12-byte nonce, then the ciphertext and its 16-byte tag", async () => {
    const bytes = Account.decode(await Secrets.seal(key, place, "abc"))
    expect(bytes[0]).toBe(1)
    expect(bytes.length).toBe(1 + 12 + 3 + 16)
    expect(Secrets.aad(place)).toBe("opencode-hub/v1|provider|anthropic|user-1")
  })

  test("refuses another row, another user, another table, a wrong key or altered bytes", async () => {
    const sealed = await Secrets.seal(key, place, "sk-secret")
    expect(await Secrets.open(key, { ...place, row: "openai" }, sealed)).toBeUndefined()
    expect(await Secrets.open(key, { ...place, user: "user-2" }, sealed)).toBeUndefined()
    expect(await Secrets.open(key, { ...place, table: "connector" }, sealed)).toBeUndefined()
    const other = Account.encode(crypto.getRandomValues(new Uint8Array(32)))
    expect(await Secrets.open(other, place, sealed)).toBeUndefined()
    expect(await Secrets.open(key.slice(0, 20), place, sealed)).toBeUndefined()
    const bytes = Account.decode(sealed)
    bytes[bytes.length - 1] ^= 1
    expect(await Secrets.open(key, place, Account.encode(bytes))).toBeUndefined()
    const version = Account.decode(sealed)
    version[0] = 2
    expect(await Secrets.open(key, place, Account.encode(version))).toBeUndefined()
    expect(await Secrets.open(key, place, "")).toBeUndefined()
  })
})

describe("providers per user", () => {
  test("two users save the same provider id with their own keys; each machine uses its owner's", async () => {
    await addFake(state.alice, ALICE_KEY)
    await addFake(state.bob, BOB_KEY)
    expect((await relay(state.machines.alice)).headers.authorization).toBe(`Bearer ${ALICE_KEY}`)
    expect((await relay(state.machines.bob)).headers.authorization).toBe(`Bearer ${BOB_KEY}`)
    // The dashboard lists only the user's own providers, never a key.
    const listed = await (await state.bob.request("providers")).text()
    expect(JSON.parse(listed)).toEqual([
      { id: "fake", name: "Fake", baseURL: `http://127.0.0.1:${upstream.port}/v1`, auth: "key" },
    ])
    expect(listed).not.toContain(BOB_KEY)
  })

  test("pushes a user's provider list to that user's machines only", async () => {
    const before = state.configs.bob.length
    expect((await state.alice.request("providers", { method: "POST", body: extra("alice-only") })).status).toBe(200)
    await until(() => state.configs.alice.at(-1)?.providers.some((provider) => provider.id === "alice-only") === true)
    expect(state.configs.alice.at(-1)?.providers.map((provider) => provider.id)).toEqual(["alice-only", "fake"])
    expect((await state.alice.request("providers/alice-only", { method: "DELETE" })).status).toBe(204)
    await until(() => state.configs.alice.at(-1)?.providers.length === 1)
    // Bob's machine heard nothing, and Alice cannot delete Bob's provider.
    expect(state.configs.bob.length).toBe(before)
    expect((await state.alice.request("providers/alice-only", { method: "DELETE" })).status).toBe(404)
  })

  test("READY carries the owner's providers", async () => {
    const configs: Agent.LlmConfig[] = []
    const ready = Promise.withResolvers<Agent.Ready>()
    const agent = Agent.connect({
      enrollment: state.machines.bob,
      local: async () => ({ url: `http://127.0.0.1:${local.port}` }),
      onReady: ready.resolve,
      onConfig: (llm) => configs.push(llm),
    })
    expect((await ready.promise).llm.providers).toEqual([{ id: "fake", name: "Fake" }])
    await agent.close()
    // That connection replaced Bob's agent; bring it back for the next tests.
    state.agents.push(await connect(state.machines.bob, state.configs.bob))
  })

  test("no key is stored in clear", async () => {
    const raw = ["hub.db", "hub.db-wal"]
      .map((name) => path.join(dirs[0]!, name))
      .filter((file) => existsSync(file))
      .map((file) => readFileSync(file).toString("latin1"))
      .join("")
    expect(raw.length).toBeGreaterThan(0)
    expect(raw).not.toContain(ALICE_KEY)
    expect(raw).not.toContain(BOB_KEY)
    expect(raw).not.toContain(Buffer.from(ALICE_KEY).toString("base64url"))
  })
})

describe("locked keys", () => {
  test("locking makes the owner's relays 423 until they sign in again; other users are untouched", async () => {
    expect((await state.bob.post<{ unlocked: boolean }>("account/lock", {})).unlocked).toBe(false)
    const locked = await relayResponse(state.machines.bob)
    expect(locked.status).toBe(423)
    expect(((await locked.json()) as { error: string }).error).toBe(Providers.LOCKED)
    expect((await relay(state.machines.alice)).headers.authorization).toBe(`Bearer ${ALICE_KEY}`)

    // Adding or changing a provider needs the key too, and so does a ChatGPT sign-in.
    const refused = await state.bob.request("providers", { method: "POST", body: extra("other") })
    expect(refused.status).toBe(423)
    expect((await state.bob.request("providers/chatgpt/begin", { method: "POST" })).status).toBe(423)
    expect((await state.bob.request("session").then((response) => response.json())) as object).toMatchObject({
      unlocked: false,
    })

    // The administrator sees that Bob's machines wait for him.
    expect(await waiting(state.alice)).toEqual({ alice: false, bob: true })

    await Account.login({ post: state.bob.post, login: "bob", password: "bob-password" })
    expect((await relay(state.machines.bob)).headers.authorization).toBe(`Bearer ${BOB_KEY}`)
    expect(await waiting(state.alice)).toEqual({ alice: false, bob: false })
  })

  test("disabling the owner makes the relays 423", async () => {
    const carol = await signUp(state.hub.url, await invite(state.alice), "carol")
    const machine = await enroll(state.hub.url, carol, "Carol Box")
    await addFake(carol, "sk-carol")
    expect((await relay(machine)).headers.authorization).toBe("Bearer sk-carol")
    const id = await userID("carol")
    await state.alice.post(`users/${id}/disable`, {})
    expect((await relayResponse(machine)).status).toBe(423)
    // Enabled again, the key stays locked until Carol signs in.
    await state.alice.post(`users/${id}/enable`, {})
    expect((await relayResponse(machine)).status).toBe(423)
  })

  test("a reset deletes the user's providers and pushes the empty list", async () => {
    const dave = await signUp(state.hub.url, await invite(state.alice), "dave")
    const enrollment = await enroll(state.hub.url, dave, "Dave Box")
    const configs: Agent.LlmConfig[] = []
    state.agents.push(await connect(enrollment, configs))
    await addFake(dave, "sk-dave")
    await until(() => configs.at(-1)?.providers.length === 1)
    await state.alice.post(`users/${await userID("dave")}/reset`, {})
    await until(() => configs.at(-1)?.providers.length === 0)
    expect((await relayResponse(enrollment)).status).toBe(423)
    const store = Store.open(dirs[0]!)
    const left = store.providerSummaries(await userID("dave"))
    store.close()
    expect(left).toEqual([])
  })
})

describe("restart", () => {
  test("a restarted hub answers 423 until the owner signs in again", async () => {
    const data = tempDir()
    const first = await Hub.start({ hostname: "127.0.0.1", port: 0, data, catalog: { fetch: offline } })
    const page = await signUp(first.url, first.invite("admin").url, "erin")
    const machine = await enroll(first.url, page, "Erin Box")
    await addFake(page, "sk-erin")
    expect((await relay(machine, first.url)).headers.authorization).toBe("Bearer sk-erin")
    await first.stop()

    const second = await Hub.start({ hostname: "127.0.0.1", port: 0, data, catalog: { fetch: offline } })
    const response = await relayResponse(machine, second.url)
    expect(response.status).toBe(423)
    const again = browser(second.url, { "x-forwarded-for": `198.51.100.${addresses.next++}` })
    await Account.login({ post: again.post, login: "erin", password: "erin-password" })
    expect((await relay(machine, second.url)).headers.authorization).toBe("Bearer sk-erin")
    await second.stop()
  })
})

describe("migration", () => {
  test("drops the old shared provider table unread, and its keys leave the file", () => {
    const data = tempDir()
    const legacy = new Database(path.join(data, "hub.db"), { create: true })
    legacy.run(`CREATE TABLE provider (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL,
      auth TEXT NOT NULL DEFAULT 'key', oauth TEXT, created_at INTEGER NOT NULL
    )`)
    const plaintext = "sk-legacy-plaintext-key-0123456789"
    // Enough rows to span several pages, so freed pages are not all reused by the new table.
    legacy.transaction(() =>
      Array.from({ length: 300 }, (_, index) =>
        legacy.run("INSERT INTO provider VALUES (?, 'Anthropic', 'https://api.anthropic.com/v1', ?, 'key', NULL, 1)", [
          `provider-${index}`,
          plaintext,
        ]),
      ),
    )()
    legacy.close()
    expect(readFileSync(path.join(data, "hub.db")).toString("latin1")).toContain(plaintext)

    const store = Store.open(data)
    expect(store.providerSummaries("anyone")).toEqual([])
    store.close()
    const raw = ["hub.db", "hub.db-wal"]
      .map((name) => path.join(data, name))
      .filter((file) => existsSync(file))
      .map((file) => readFileSync(file).toString("latin1"))
      .join("")
    expect(raw).not.toContain(plaintext)

    // Opening again keeps the new table and what it holds.
    const again = Store.open(data)
    again.saveProvider({
      user: "u",
      id: "x",
      name: "X",
      baseURL: "https://x",
      auth: "key",
      apiKey: "sealed",
      oauth: null,
    })
    again.close()
    const third = Store.open(data)
    expect(third.providerSummaries("u")).toEqual([{ id: "x", name: "X", base_url: "https://x", auth: "key" }])
    third.close()
  })
})

/** Keeps the provider catalog on its built-in list, so tests never reach models.dev. */
const offline = Object.assign(async () => Response.error(), { preconnect: () => {} }) as typeof fetch

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opencode-keys-"))
  dirs.push(dir)
  return dir
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

async function enroll(hub: string, page: Page, name: string) {
  const code = (await page.post<{ code: string }>("machines/code", {})).code
  return Agent.enroll({ url: hub, code, name })
}

async function connect(enrollment: Agent.Enrollment, configs: Agent.LlmConfig[]) {
  const ready = Promise.withResolvers<void>()
  const agent = Agent.connect({
    enrollment,
    local: async () => ({ url: `http://127.0.0.1:${local.port}` }),
    onReady: () => ready.resolve(),
    onConfig: (llm) => configs.push(llm),
  })
  await ready.promise
  return agent
}

function extra(id: string) {
  return { id, name: id, baseURL: `http://127.0.0.1:${upstream.port}/v1`, apiKey: `sk-${id}` }
}

async function addFake(page: Page, apiKey: string) {
  await page.post("providers", { id: "fake", name: "Fake", baseURL: `http://127.0.0.1:${upstream.port}/v1`, apiKey })
}

function relayResponse(machine: Agent.Enrollment, hub = state.hub.url) {
  return fetch(`${hub}/llm/fake/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${machine.llmToken}`, "content-type": "application/json" },
    body: "{}",
  })
}

async function relay(machine: Agent.Enrollment, hub = state.hub.url) {
  const response = await relayResponse(machine, hub)
  expect(response.status).toBe(200)
  return (await response.json()) as Echo
}

async function userID(login: string) {
  const users = (await (await state.alice.request("users")).json()) as { id: string; login: string }[]
  return users.find((user) => user.login === login)?.id ?? ""
}

/** Which of Alice and Bob have machines waiting for their keys, as the administrator sees it. */
async function waiting(admin: Page) {
  const users = (await (await admin.request("users")).json()) as { login: string; waiting: boolean }[]
  return Object.fromEntries(
    users.filter((user) => user.login === "alice" || user.login === "bob").map((user) => [user.login, user.waiting]),
  )
}

async function until(condition: () => boolean, deadline = Date.now() + 3000): Promise<void> {
  if (condition()) return
  if (Date.now() > deadline) throw new Error("condition not met in time")
  await Bun.sleep(5)
  return until(condition, deadline)
}
