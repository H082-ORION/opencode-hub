import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { ChatGPT } from "../src/hub/chatgpt.js"
import { Llm } from "../src/hub/llm.js"
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

function setup() {
  const store = Store.open(tempDir())
  const chatgpt = ChatGPT.create({
    store,
    options: { issuer: issuerURL() },
    app: { name: "hub-test", version: "0.0.0" },
  })
  return { store, chatgpt }
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
  test("begin builds the authorize URL and keeps the host id", () => {
    const { store, chatgpt } = setup()
    const first = new URL(chatgpt.begin().url)
    const second = new URL(chatgpt.begin().url)
    expect(`${first.origin}${first.pathname}`).toBe(`${issuerURL()}/api/accounts/authorize`)
    expect(first.searchParams.get("client_id")).toBe("dynamic_agent_client")
    expect(first.searchParams.get("agent_name_hint")).toBe("OpenCode")
    expect(first.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback")
    expect(first.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct")
    expect(first.searchParams.get("code_challenge_method")).toBe("S256")
    expect(first.searchParams.get("ext_agent_host_id")).toStartWith("urn:uuid:")
    expect(second.searchParams.get("ext_agent_host_id")).toBe(first.searchParams.get("ext_agent_host_id"))
    expect(store.setting("chatgpt-agent-host-id")).toBe(first.searchParams.get("ext_agent_host_id")!)
    expect(second.searchParams.get("state")).not.toBe(first.searchParams.get("state"))
  })

  test("completes with the pasted callback URL and saves the provider", async () => {
    const { store, chatgpt } = setup()
    const started = chatgpt.begin()
    await chatgpt.complete({ attempt: started.attempt, callback: `  ${consent(started.url).callback}\n` })
    const provider = store.provider("openai")!
    expect(provider).toMatchObject({ id: "openai", name: "ChatGPT", base_url: "https://api.openai.com/v1" })
    expect(provider.auth).toBe("chatgpt")
    expect(provider.api_key).toBe("")
    expect(provider.oauth).toMatchObject({ access: "access-initial", refresh: "refresh-initial", clientID: CLIENT })
    expect(provider.oauth!.scopes).toContain("chatgpt.tokens.use.direct")
    expect(store.providerSummaries()).toEqual([
      { id: "openai", name: "ChatGPT", base_url: "https://api.openai.com/v1", auth: "chatgpt" },
    ])
    // The attempt is single-use.
    await expect(chatgpt.complete({ attempt: started.attempt, callback: "x" })).rejects.toThrow("expired")

    // Reauthorization reuses the registered client, so a bare code is enough.
    const again = chatgpt.begin()
    expect(new URL(again.url).searchParams.get("client_id")).toBe(CLIENT)
    expect(new URL(again.url).searchParams.get("agent_name_hint")).toBeNull()
    await chatgpt.complete({ attempt: again.attempt, callback: consent(again.url).code })
    expect(store.provider("openai")!.oauth!.clientID).toBe(CLIENT)
  })

  test("a bare code without a registered client asks for the full URL", async () => {
    const { chatgpt } = setup()
    const started = chatgpt.begin()
    await expect(chatgpt.complete({ attempt: started.attempt, callback: consent(started.url).code })).rejects.toThrow(
      "Paste the full URL",
    )
  })

  test("rejects a callback from another attempt", async () => {
    const { store, chatgpt } = setup()
    const started = chatgpt.begin()
    const other = chatgpt.begin()
    await expect(chatgpt.complete({ attempt: started.attempt, callback: consent(other.url).callback })).rejects.toThrow(
      "another sign-in attempt",
    )
    expect(store.provider("openai")).toBeUndefined()
    // The rejected paste does not burn the attempt.
    await chatgpt.complete({ attempt: started.attempt, callback: consent(started.url).callback })
    expect(store.provider("openai")?.auth).toBe("chatgpt")
  })

  test("reports an error returned on the callback", async () => {
    const { chatgpt } = setup()
    const started = chatgpt.begin()
    const callback = `http://127.0.0.1:1455/auth/callback?error=access_denied&error_description=User+cancelled`
    await expect(chatgpt.complete({ attempt: started.attempt, callback })).rejects.toThrow("User cancelled")
  })

  test("requires the token-sharing scope", async () => {
    const { store, chatgpt } = setup()
    const started = chatgpt.begin()
    await expect(
      chatgpt.complete({
        attempt: started.attempt,
        callback: consent(started.url, "openid profile email offline_access").callback,
      }),
    ).rejects.toThrow("without token sharing")
    expect(store.provider("openai")).toBeUndefined()
  })
})

describe("access tokens", () => {
  test("refreshes an expiring token once for concurrent callers and persists it", async () => {
    const { store, chatgpt } = setup()
    saveChatGPT(store, Date.now() + 60_000)
    const gate = Promise.withResolvers<void>()
    issuerState.refreshGate = gate.promise
    const provider = store.provider("openai")!
    const pending = Array.from({ length: 5 }, () => chatgpt.accessToken(provider))
    gate.resolve()
    expect(await Promise.all(pending)).toEqual(Array(5).fill("access-refreshed-1"))
    expect(issuerState.refreshes).toBe(1)
    expect(issuerState.lastRefreshToken).toBe("refresh-saved")
    const saved = store.provider("openai")!.oauth!
    expect(saved.access).toBe("access-refreshed-1")
    // The refresh response had no refresh token or scope, so the previous ones are kept.
    expect(saved.refresh).toBe("refresh-saved")
    expect(saved.scopes).toEqual(["chatgpt.tokens.use.direct"])
    expect(saved.expires).toBeGreaterThan(Date.now() + 3_000_000)
    expect(await chatgpt.accessToken(provider)).toBe("access-refreshed-1")
    expect(issuerState.refreshes).toBe(1)
  })

  test("uses a fresh token without refreshing", async () => {
    const { store, chatgpt } = setup()
    saveChatGPT(store, Date.now() + 3_600_000)
    expect(await chatgpt.accessToken(store.provider("openai")!)).toBe("access-saved")
    expect(issuerState.refreshes).toBe(0)
  })
})

describe("llm proxy", () => {
  test("injects the ChatGPT access token and compresses the body with zstd", async () => {
    const { store, chatgpt } = setup()
    const machine = store.createMachine({ name: "box", owner: "someone" })
    saveChatGPT(store, Date.now() + 3_600_000, `http://127.0.0.1:${upstream.port}/v1`)
    const payload = JSON.stringify({ input: "x".repeat(2 * 1024 * 1024) })
    const bearer = await proxyJSON(store, chatgpt, "/llm/openai/responses?stream=1", {
      method: "POST",
      headers: { authorization: `Bearer ${machine.llmToken}`, "content-type": "application/json" },
      body: payload,
    })
    expect(bearer.path).toBe("/v1/responses?stream=1")
    expect(bearer.headers.authorization).toBe("Bearer access-saved")
    expect(bearer.headers["content-encoding"]).toBe("zstd")
    expect(bearer.body).toBe(payload)
    expect(bearer.size).toBeLessThan(payload.length / 10)

    const other = await proxyJSON(store, chatgpt, `/llm/openai/models?key=${machine.llmToken}`, {
      headers: { "x-api-key": machine.llmToken },
    })
    expect(other.path).toBe("/v1/models")
    expect(other.headers.authorization).toBe("Bearer access-saved")
    expect(other.headers["x-api-key"]).toBeUndefined()
    expect(other.headers["content-encoding"]).toBeUndefined()
  })

  test("rejects bad llm tokens and reports refresh failures", async () => {
    const { store, chatgpt } = setup()
    const machine = store.createMachine({ name: "box", owner: "someone" })
    saveChatGPT(store, Date.now() - 1000, `http://127.0.0.1:${upstream.port}/v1`, "bad-refresh")
    const unauthorized = await Llm.proxy(
      new Request("http://hub/llm/openai/models", { headers: { authorization: "Bearer nope" } }),
      new URL("http://hub/llm/openai/models"),
      store,
      chatgpt,
    )
    expect(unauthorized.status).toBe(401)
    const failed = await Llm.proxy(
      new Request("http://hub/llm/openai/models", { headers: { authorization: `Bearer ${machine.llmToken}` } }),
      new URL("http://hub/llm/openai/models"),
      store,
      chatgpt,
    )
    expect(failed.status).toBe(502)
    expect(((await failed.json()) as { error: string }).error).toContain("ChatGPT token refresh failed")
  })
})

describe("store", () => {
  test("adds the auth columns to an existing database", () => {
    const dir = tempDir()
    const db = new Database(path.join(dir, "hub.db"), { create: true })
    db.run(`CREATE TABLE provider (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL, created_at INTEGER NOT NULL
    )`)
    db.run("INSERT INTO provider VALUES ('anthropic', 'Anthropic', 'https://api.anthropic.com/v1', 'sk-old', 1)")
    db.close()
    const store = Store.open(dir)
    expect(store.provider("anthropic")).toMatchObject({ api_key: "sk-old", auth: "key", oauth: undefined })
    saveChatGPT(store, 1)
    store.saveProvider({ id: "openai", name: "OpenAI", baseURL: "https://api.openai.com/v1", apiKey: "sk-new" })
    expect(store.provider("openai")).toMatchObject({ api_key: "sk-new", auth: "key", oauth: undefined })
    expect(store.updateOAuth("openai", { access: "a", refresh: "r", expires: 1, clientID: CLIENT, scopes: [] })).toBe(
      false,
    )
    store.close()
  })
})

function saveChatGPT(
  store: Store.Instance,
  expires: number,
  baseURL = "https://api.openai.com/v1",
  refresh = "refresh-saved",
) {
  store.saveOAuthProvider({
    id: "openai",
    name: "ChatGPT",
    baseURL,
    oauth: { access: "access-saved", refresh, expires, clientID: CLIENT, scopes: ["chatgpt.tokens.use.direct"] },
  })
}

async function proxyJSON(store: Store.Instance, chatgpt: ChatGPT.Instance, target: string, init: RequestInit) {
  const response = await Llm.proxy(
    new Request(`http://hub${target}`, init),
    new URL(`http://hub${target}`),
    store,
    chatgpt,
  )
  expect(response.status).toBe(200)
  return (await response.json()) as { path: string; headers: Record<string, string>; body: string; size: number }
}
