import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Account } from "../src/account.js"
import { ChatGPT } from "../src/hub/chatgpt.js"
import { Llm } from "../src/hub/llm.js"
import { Providers } from "../src/hub/providers.js"
import { Store } from "../src/hub/store.js"

const CLIENT = "client-registered"
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
const keys = await generateKeyPair("RS256")
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test", alg: "RS256", use: "sig" }

type Grant = { challenge: string; nonce: string; clientID: string; scope: string }
const issuerState = {
  grants: new Map<string, Grant>(),
  refreshes: 0,
  refreshGate: undefined as Promise<void> | undefined,
  lastRefreshToken: "",
}

const issuer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/.well-known/jwks.json") return Response.json({ keys: [jwk] })
    if (url.pathname !== "/api/accounts/oauth/token" || request.method !== "POST")
      return new Response("not found", { status: 404 })
    const form = new URLSearchParams(await request.text())
    if (form.get("resource") !== "https://api.openai.com/v1") return oauthError("invalid_target")
    if (form.get("grant_type") === "refresh_token") {
      if (form.get("client_id") !== CLIENT || !form.get("refresh_token")?.startsWith("refresh-"))
        return oauthError("invalid_grant")
      issuerState.lastRefreshToken = form.get("refresh_token")!
      issuerState.refreshes++
      await issuerState.refreshGate
      return Response.json({ access_token: `access-refreshed-${issuerState.refreshes}`, expires_in: 3600 })
    }
    const grant = issuerState.grants.get(form.get("code") ?? "")
    if (!grant || form.get("grant_type") !== "authorization_code") return oauthError("invalid_grant")
    issuerState.grants.delete(form.get("code")!)
    const challenge = new Bun.CryptoHasher("sha256").update(form.get("code_verifier") ?? "").digest("base64url")
    if (
      challenge !== grant.challenge ||
      form.get("client_id") !== grant.clientID ||
      form.get("redirect_uri") !== "http://127.0.0.1:1455/auth/callback"
    )
      return oauthError("invalid_grant")
    return Response.json({
      access_token: "access-initial",
      refresh_token: "refresh-initial",
      expires_in: 3600,
      scope: grant.scope,
      id_token: await new SignJWT({ nonce: grant.nonce })
        .setProtectedHeader({ alg: "RS256", kid: "test" })
        .setIssuer(url.origin)
        .setAudience(grant.clientID)
        .setSubject("user-1")
        .setExpirationTime("1h")
        .sign(keys.privateKey),
    })
  },
})

const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const raw = new Uint8Array(await request.arrayBuffer())
    const encoding = request.headers.get("content-encoding")
    return Response.json({
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(request.headers),
      body: new TextDecoder().decode(encoding === "zstd" ? Bun.zstdDecompressSync(raw) : raw),
      size: raw.length,
    })
  },
})

const dirs: string[] = []

afterAll(() => {
  issuer.stop(true)
  upstream.stop(true)
  dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

beforeEach(() => {
  issuerState.refreshes = 0
  issuerState.refreshGate = undefined
})

function issuerURL() {
  return `http://127.0.0.1:${issuer.port}`
}

function oauthError(error: string) {
  return Response.json({ error }, { status: 400 })
}

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opencode-chatgpt-"))
  dirs.push(dir)
  return dir
}

/** A hub's provider stack for two users, `alice` and `bob`, with their keys unlocked in `keys`. */
function setup() {
  const store = Store.open(tempDir())
  const keys = new Map([
    [ALICE, randomKey()],
    [BOB, randomKey()],
  ])
  const providers = Providers.create({ store, key: (user) => keys.get(user) })
  const chatgpt = ChatGPT.create({
    store,
    providers,
    options: { issuer: issuerURL() },
    app: { name: "hub-test", version: "0.0.0" },
  })
  const active = (id: string) => (id === ALICE || id === BOB ? ({ id } as Store.User) : undefined)
  return { store, keys, providers, chatgpt, active }
}

const ALICE = "alice-id"
const BOB = "bob-id"

function randomKey() {
  return Account.encode(crypto.getRandomValues(new Uint8Array(32)))
}

/** The user's `openai` provider in clear, or the reason it cannot be opened. */
async function openai(providers: Providers.Instance, user = ALICE) {
  const opened = await providers.open(user, "openai")
  return opened.kind === "ok" ? opened.provider : opened.kind
}

/** Plays the user's part at the authorize endpoint: consents and returns the redirect the browser would land on. */
function consent(authorize: string, scope = SCOPE) {
  const params = new URL(authorize).searchParams
  const code = `code-${crypto.randomUUID()}`
  const clientID = params.get("client_id") === "dynamic_agent_client" ? CLIENT : params.get("client_id")!
  issuerState.grants.set(code, {
    challenge: params.get("code_challenge")!,
    nonce: params.get("nonce")!,
    clientID,
    scope,
  })
  const callback = new URL(params.get("redirect_uri")!)
  callback.search = new URLSearchParams({ code, state: params.get("state")!, client_id: clientID }).toString()
  return { code, callback: callback.toString() }
}

describe("sign-in", () => {
  test("begin builds the authorize URL and keeps the host id", async () => {
    const { store, chatgpt } = setup()
    const first = new URL((await chatgpt.begin(ALICE)).url)
    const second = new URL((await chatgpt.begin(BOB)).url)
    expect(`${first.origin}${first.pathname}`).toBe(`${issuerURL()}/api/accounts/authorize`)
    expect(first.searchParams.get("client_id")).toBe("dynamic_agent_client")
    expect(first.searchParams.get("agent_name_hint")).toBe("OpenCode")
    expect(first.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback")
    expect(first.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct")
    expect(first.searchParams.get("code_challenge_method")).toBe("S256")
    expect(first.searchParams.get("ext_agent_host_id")).toStartWith("urn:uuid:")
    // The host id names the hub, whoever signs in.
    expect(second.searchParams.get("ext_agent_host_id")).toBe(first.searchParams.get("ext_agent_host_id"))
    expect(store.setting("chatgpt-agent-host-id")).toBe(first.searchParams.get("ext_agent_host_id")!)
    expect(second.searchParams.get("state")).not.toBe(first.searchParams.get("state"))
  })

  test("completes with the pasted callback URL and saves the provider of that user only", async () => {
    const { store, providers, chatgpt } = setup()
    const started = await chatgpt.begin(ALICE)
    await chatgpt.complete(ALICE, { attempt: started.attempt, callback: `  ${consent(started.url).callback}\n` })
    const provider = await openai(providers)
    expect(provider).toMatchObject({ id: "openai", name: "ChatGPT", base_url: "https://api.openai.com/v1" })
    if (typeof provider === "string") throw new Error(provider)
    expect(provider.auth).toBe("chatgpt")
    expect(provider.api_key).toBe("")
    expect(provider.oauth).toMatchObject({ access: "access-initial", refresh: "refresh-initial", clientID: CLIENT })
    expect(provider.oauth!.scopes).toContain("chatgpt.tokens.use.direct")
    expect(providers.summaries(ALICE)).toEqual([
      { id: "openai", name: "ChatGPT", base_url: "https://api.openai.com/v1", auth: "chatgpt" },
    ])
    expect(providers.summaries(BOB)).toEqual([])
    // Stored sealed: neither token is in the row.
    const row = JSON.stringify(store.provider(ALICE, "openai"))
    expect(row).not.toContain("access-initial")
    expect(row).not.toContain("refresh-initial")
    // The attempt is single-use.
    await expect(chatgpt.complete(ALICE, { attempt: started.attempt, callback: "x" })).rejects.toThrow("expired")

    // Reauthorization reuses the registered client, so a bare code is enough.
    const again = await chatgpt.begin(ALICE)
    expect(new URL(again.url).searchParams.get("client_id")).toBe(CLIENT)
    expect(new URL(again.url).searchParams.get("agent_name_hint")).toBeNull()
    await chatgpt.complete(ALICE, { attempt: again.attempt, callback: consent(again.url).code })
    expect(await openai(providers)).toMatchObject({ oauth: { clientID: CLIENT } })
    // Bob has no saved client: he registers his own.
    expect(new URL((await chatgpt.begin(BOB)).url).searchParams.get("client_id")).toBe("dynamic_agent_client")
  })

  test("an attempt only completes for the user who started it", async () => {
    const { providers, chatgpt } = setup()
    const started = await chatgpt.begin(ALICE)
    const callback = consent(started.url).callback
    await expect(chatgpt.complete(BOB, { attempt: started.attempt, callback })).rejects.toThrow("expired")
    expect(await openai(providers, BOB)).toBe("unknown")
    await chatgpt.complete(ALICE, { attempt: started.attempt, callback })
    expect(await openai(providers)).toMatchObject({ auth: "chatgpt" })
  })

  test("needs the user's key to start and to finish", async () => {
    const { keys, providers, chatgpt } = setup()
    const bobKey = keys.get(BOB)!
    keys.delete(BOB)
    await expect(chatgpt.begin(BOB)).rejects.toBeInstanceOf(Providers.LockedError)
    keys.set(BOB, bobKey)
    const started = await chatgpt.begin(BOB)
    keys.delete(BOB)
    await expect(
      chatgpt.complete(BOB, { attempt: started.attempt, callback: consent(started.url).callback }),
    ).rejects.toBeInstanceOf(Providers.LockedError)
    expect(await openai(providers, BOB)).toBe("unknown")
  })

  test("a bare code without a registered client asks for the full URL", async () => {
    const { chatgpt } = setup()
    const started = await chatgpt.begin(ALICE)
    await expect(
      chatgpt.complete(ALICE, { attempt: started.attempt, callback: consent(started.url).code }),
    ).rejects.toThrow("Paste the full URL")
  })

  test("rejects a callback from another attempt", async () => {
    const { providers, chatgpt } = setup()
    const started = await chatgpt.begin(ALICE)
    const other = await chatgpt.begin(ALICE)
    await expect(
      chatgpt.complete(ALICE, { attempt: started.attempt, callback: consent(other.url).callback }),
    ).rejects.toThrow("another sign-in attempt")
    expect(await openai(providers)).toBe("unknown")
    // The rejected paste does not burn the attempt.
    await chatgpt.complete(ALICE, { attempt: started.attempt, callback: consent(started.url).callback })
    expect(await openai(providers)).toMatchObject({ auth: "chatgpt" })
  })

  test("reports an error returned on the callback", async () => {
    const { chatgpt } = setup()
    const started = await chatgpt.begin(ALICE)
    const callback = `http://127.0.0.1:1455/auth/callback?error=access_denied&error_description=User+cancelled`
    await expect(chatgpt.complete(ALICE, { attempt: started.attempt, callback })).rejects.toThrow("User cancelled")
  })

  test("requires the token-sharing scope", async () => {
    const { providers, chatgpt } = setup()
    const started = await chatgpt.begin(ALICE)
    await expect(
      chatgpt.complete(ALICE, {
        attempt: started.attempt,
        callback: consent(started.url, "openid profile email offline_access").callback,
      }),
    ).rejects.toThrow("without token sharing")
    expect(await openai(providers)).toBe("unknown")
  })
})

describe("access tokens", () => {
  test("refreshes an expiring token once for concurrent callers and seals it again", async () => {
    const { store, keys, providers, chatgpt } = setup()
    await saveChatGPT(providers, Date.now() + 60_000)
    const gate = Promise.withResolvers<void>()
    issuerState.refreshGate = gate.promise
    const provider = await openai(providers)
    if (typeof provider === "string") throw new Error(provider)
    const key = keys.get(ALICE)!
    const pending = Array.from({ length: 5 }, () => chatgpt.accessToken(ALICE, provider, key))
    gate.resolve()
    expect(await Promise.all(pending)).toEqual(Array(5).fill("access-refreshed-1"))
    expect(issuerState.refreshes).toBe(1)
    expect(issuerState.lastRefreshToken).toBe("refresh-saved")
    expect(JSON.stringify(store.provider(ALICE, "openai"))).not.toContain("access-refreshed-1")
    const saved = await openai(providers)
    if (typeof saved === "string") throw new Error(saved)
    expect(saved.oauth!.access).toBe("access-refreshed-1")
    // The refresh response had no refresh token or scope, so the previous ones are kept.
    expect(saved.oauth!.refresh).toBe("refresh-saved")
    expect(saved.oauth!.scopes).toEqual(["chatgpt.tokens.use.direct"])
    expect(saved.oauth!.expires).toBeGreaterThan(Date.now() + 3_000_000)
    // A caller still holding the expiring credential gets the refreshed token without a second refresh.
    expect(await chatgpt.accessToken(ALICE, provider, key)).toBe("access-refreshed-1")
    expect(issuerState.refreshes).toBe(1)
  })

  test("uses a fresh token without refreshing", async () => {
    const { keys, providers, chatgpt } = setup()
    await saveChatGPT(providers, Date.now() + 3_600_000)
    const provider = await openai(providers)
    if (typeof provider === "string") throw new Error(provider)
    expect(await chatgpt.accessToken(ALICE, provider, keys.get(ALICE)!)).toBe("access-saved")
    expect(issuerState.refreshes).toBe(0)
  })
})

describe("llm proxy", () => {
  test("injects the owner's ChatGPT access token and compresses the body with zstd", async () => {
    const deps = setup()
    const machine = instanceToken(deps, "box", ALICE)
    await saveChatGPT(deps.providers, Date.now() + 3_600_000, `http://127.0.0.1:${upstream.port}/v1`)
    const payload = JSON.stringify({ input: "x".repeat(2 * 1024 * 1024) })
    const bearer = await proxyJSON(deps, "/llm/openai/responses?stream=1", {
      method: "POST",
      headers: { authorization: `Bearer ${machine}`, "content-type": "application/json" },
      body: payload,
    })
    expect(bearer.path).toBe("/v1/responses?stream=1")
    expect(bearer.headers.authorization).toBe("Bearer access-saved")
    expect(bearer.headers["content-encoding"]).toBe("zstd")
    expect(bearer.body).toBe(payload)
    expect(bearer.size).toBeLessThan(payload.length / 10)

    const other = await proxyJSON(deps, `/llm/openai/models?key=${machine}`, {
      headers: { "x-api-key": machine },
    })
    expect(other.path).toBe("/v1/models")
    expect(other.headers.authorization).toBe("Bearer access-saved")
    expect(other.headers["x-api-key"]).toBeUndefined()
    expect(other.headers["content-encoding"]).toBeUndefined()

    // Bob's machine does not see Alice's sign-in.
    const bobs = instanceToken(deps, "bob box", BOB)
    const missing = await proxy(deps, "/llm/openai/models", { headers: { authorization: `Bearer ${bobs}` } })
    expect(missing.status).toBe(404)
  })

  test("answers 423 when the owner's key is locked, refresh due or not", async () => {
    const deps = setup()
    const machine = instanceToken(deps, "box", ALICE)
    await saveChatGPT(deps.providers, Date.now() - 1000, `http://127.0.0.1:${upstream.port}/v1`)
    deps.keys.delete(ALICE)
    const response = await proxy(deps, "/llm/openai/models", {
      headers: { authorization: `Bearer ${machine}` },
    })
    expect(response.status).toBe(423)
    expect(((await response.json()) as { error: string }).error).toBe(Providers.LOCKED)
    expect(issuerState.refreshes).toBe(0)
  })

  test("rejects bad llm tokens, foreign machines and reports refresh failures", async () => {
    const deps = setup()
    const machine = instanceToken(deps, "box", ALICE)
    await saveChatGPT(deps.providers, Date.now() - 1000, `http://127.0.0.1:${upstream.port}/v1`, "bad-refresh")
    const unauthorized = await proxy(deps, "/llm/openai/models", { headers: { authorization: "Bearer nope" } })
    expect(unauthorized.status).toBe(401)
    // Two instances' tokens in one request could pick either user's keys.
    const bobs = instanceToken(deps, "bob box", BOB)
    const mixed = await proxy(deps, "/llm/openai/models", {
      headers: { authorization: `Bearer ${machine}`, "x-api-key": bobs },
    })
    expect(mixed.status).toBe(401)
    const failed = await proxy(deps, "/llm/openai/models", { headers: { authorization: `Bearer ${machine}` } })
    expect(failed.status).toBe(502)
    expect(((await failed.json()) as { error: string }).error).toContain("ChatGPT token refresh failed")
  })
})

async function saveChatGPT(
  providers: Providers.Instance,
  expires: number,
  baseURL = "https://api.openai.com/v1",
  refresh = "refresh-saved",
) {
  await providers.saveOAuth(ALICE, {
    id: "openai",
    name: "ChatGPT",
    baseURL,
    oauth: { access: "access-saved", refresh, expires, clientID: CLIENT, scopes: ["chatgpt.tokens.use.direct"] },
  })
}

/** A machine of `user` with that user's instance on it, and the instance's LLM token. */
function instanceToken(deps: ReturnType<typeof setup>, name: string, user: string) {
  const machine = deps.store.createMachine({ name, enrolledBy: user })
  return deps.store.issueInstanceToken(deps.store.ensureInstance(machine.machine.id, user).id)
}

function proxy(deps: ReturnType<typeof setup>, target: string, init: RequestInit) {
  return Llm.proxy(new Request(`http://hub${target}`, init), new URL(`http://hub${target}`), {
    store: deps.store,
    providers: deps.providers,
    allowed: (user, machine) => deps.active(user) !== undefined && machine.owner_user_id === user,
    chatgpt: deps.chatgpt,
  })
}

async function proxyJSON(deps: ReturnType<typeof setup>, target: string, init: RequestInit) {
  const response = await proxy(deps, target, init)
  expect(response.status).toBe(200)
  return (await response.json()) as { path: string; headers: Record<string, string>; body: string; size: number }
}
