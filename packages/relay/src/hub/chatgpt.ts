import { Option, Schema } from "effect"
import { createRemoteJWKSet, jwtVerify } from "jose"
import { Providers } from "./providers.js"
import type { Store } from "./store.js"

export * as ChatGPT from "./chatgpt.js"

/** Overridable OpenAI auth endpoints, for tests. */
export type Options = { issuer?: string; jwks?: string }

export const PROVIDER = { id: "openai", name: "ChatGPT", baseURL: "https://api.openai.com/v1" }

// First-time sign-in registers a user-owned client; OpenAI returns its issued client ID on the callback.
const registrationClientID = "dynamic_agent_client"
const agentName = "OpenCode"
const resource = "https://api.openai.com/v1"
const tokenSharingScope = "chatgpt.tokens.use.direct"
// The hub has no loopback listener: the browser lands on this URL and fails to load, and the user pastes it back.
const redirect = "http://127.0.0.1:1455/auth/callback"
const hostIDKey = "chatgpt-agent-host-id"
const attemptTTL = 15 * 60_000
const refreshMargin = 2 * 60_000

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  id_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  scope: Schema.optional(Schema.String),
})
type TokenResponse = typeof TokenResponse.Type
const decodeTokenResponse = Schema.decodeUnknownOption(Schema.fromJsonString(TokenResponse))

/** A sign-in in progress, bound to the hub user who started it. */
type Attempt = { user: string; verifier: string; state: string; nonce: string; savedClientID?: string; expires: number }

export function create(input: {
  store: Store.Instance
  providers: Providers.Instance
  options?: Options
  app: { name: string; version: string }
}) {
  const issuer = (input.options?.issuer ?? "https://auth.openai.com").replace(/\/+$/, "")
  const tokenURL = `${issuer}/api/accounts/oauth/token`
  const jwks = createRemoteJWKSet(new URL(input.options?.jwks ?? `${issuer}/.well-known/jwks.json`))
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": `opencode/hub/${input.app.version}/${input.app.name}`,
  }
  const attempts = new Map<string, Attempt>()
  const refreshing = new Map<string, Promise<string>>()

  async function tokens(body: Record<string, string>) {
    const response = await fetch(tokenURL, { method: "POST", headers, body: new URLSearchParams(body).toString() })
    const text = await response.text()
    if (!response.ok) throw new Error(`ChatGPT token request failed (${response.status}): ${text.slice(0, 300)}`)
    return Option.getOrThrowWith(
      decodeTokenResponse(text),
      () => new Error("ChatGPT token endpoint returned an unexpected response."),
    )
  }

  async function verifyIDToken(token: string, clientID: string, nonce: string) {
    const payload = await jwtVerify(token, jwks, {
      issuer,
      audience: clientID,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "nonce", "sub"],
    }).then(
      (result) => result.payload,
      (cause: unknown) => {
        throw new Error("ChatGPT sign-in returned an invalid ID token.", { cause })
      },
    )
    if (typeof payload.sub !== "string" || !payload.sub.trim())
      throw new Error("ChatGPT sign-in returned an ID token without a subject.")
    if (payload.nonce !== nonce) throw new Error("ChatGPT sign-in returned an ID token for another sign-in attempt.")
  }

  async function refresh(user: string, key: string, opened: Store.OAuth) {
    // Another request may have refreshed it since this one opened the provider: its refresh token may be rotated.
    const latest = await input.providers.open(user, PROVIDER.id)
    const current = latest.kind === "ok" && latest.provider.oauth ? latest.provider.oauth : opened
    if (current.expires - Date.now() > refreshMargin) return current.access
    const response = await tokens({
      grant_type: "refresh_token",
      client_id: current.clientID,
      refresh_token: current.refresh,
      resource,
    })
    const next = credential(response, current.clientID, current)
    await input.providers.updateOAuth(user, PROVIDER.id, key, next)
    return next.access
  }

  return {
    /**
     * Starts a sign-in for a hub user; the returned URL opens ChatGPT's consent page. Throws `LockedError` when the
     * user's key is not in memory, since finishing would have nothing to seal the tokens with.
     */
    async begin(user: string) {
      prune(attempts)
      if (!input.providers.unlocked(user)) throw new Providers.LockedError()
      const saved = await input.providers.open(user, PROVIDER.id)
      const hostID = input.store.setting(hostIDKey) ?? `urn:uuid:${crypto.randomUUID()}`
      input.store.setSetting(hostIDKey, hostID)
      const verifier = randomValue()
      const state = randomValue()
      const nonce = randomValue()
      const savedClientID =
        saved.kind === "ok" && saved.provider.auth === "chatgpt" ? saved.provider.oauth?.clientID : undefined
      const attempt = randomValue()
      attempts.set(attempt, { user, verifier, state, nonce, savedClientID, expires: Date.now() + attemptTTL })
      const url = `${issuer}/api/accounts/authorize?${new URLSearchParams({
        client_id: savedClientID ?? registrationClientID,
        ...(savedClientID ? {} : { agent_name_hint: agentName }),
        ext_agent_host_id: hostID,
        response_type: "code",
        redirect_uri: redirect,
        scope: `openid profile email offline_access resource.invoke ${tokenSharingScope}`,
        resource,
        state,
        nonce,
        code_challenge_method: "S256",
        code_challenge: challenge(verifier),
      })}`
      return { attempt, url }
    },

    /**
     * Finishes a user's sign-in from the pasted callback URL (or bare code) and saves their `openai` provider. Throws
     * `LockedError` when their key left memory meanwhile.
     */
    async complete(user: string, request: { attempt: string; callback: string }) {
      prune(attempts)
      const attempt = attempts.get(request.attempt)
      // Another user's attempt is as unknown as an expired one.
      if (!attempt || attempt.user !== user) throw new Error("This ChatGPT sign-in expired. Start again.")
      const callback = parseCallback(request.callback)
      if (callback.state !== undefined && callback.state !== attempt.state)
        throw new Error("The pasted URL belongs to another sign-in attempt. Paste the URL from the latest sign-in.")
      // Reauthorization callbacks may omit the client ID; reuse the one this attempt started with.
      if (attempt.savedClientID && callback.clientID && callback.clientID !== attempt.savedClientID)
        throw new Error("ChatGPT returned a different client than this connection. Sign in again.")
      const clientID = attempt.savedClientID ?? callback.clientID
      if (!clientID)
        throw new Error(
          "ChatGPT sign-in did not return a client ID. Paste the full URL from the address bar, not only the code.",
        )
      // The code is single-use, so the attempt cannot be retried past this point.
      attempts.delete(request.attempt)
      const response = await tokens({
        grant_type: "authorization_code",
        client_id: clientID,
        code: callback.code,
        code_verifier: attempt.verifier,
        redirect_uri: redirect,
        resource,
      })
      if (!response.scope?.split(" ").includes(tokenSharingScope))
        throw new Error(
          "ChatGPT sign-in finished without token sharing. Sign in again and allow token sharing, or add OpenAI with an API key.",
        )
      if (!response.id_token) throw new Error("ChatGPT sign-in did not return an ID token.")
      await verifyIDToken(response.id_token, clientID, attempt.nonce)
      await input.providers.saveOAuth(user, { ...PROVIDER, oauth: credential(response, clientID) })
    },

    /**
     * Returns a valid access token for a user's `chatgpt` provider, opened with `key`, refreshing it once for
     * concurrent callers. The refreshed credential is sealed again under the same key.
     */
    accessToken(user: string, provider: Providers.Provider, key: string) {
      const current = provider.oauth
      if (!current) return Promise.reject(new Error("ChatGPT is not signed in. Sign in again from the hub dashboard."))
      if (current.expires - Date.now() > refreshMargin) return Promise.resolve(current.access)
      // A user id never contains a NUL, so the pair cannot collide with another user's.
      const slot = `${user}\0${provider.id}`
      const pending = refreshing.get(slot) ?? refresh(user, key, current).finally(() => refreshing.delete(slot))
      refreshing.set(slot, pending)
      return pending
    },
  }
}

export type Instance = ReturnType<typeof create>

/** Accepts the full callback URL, its query string, or a bare authorization code. */
function parseCallback(input: string) {
  const text = input.trim()
  const url = /^https?:\/\//i.test(text)
    ? URL.parse(text)
    : text.includes("code=")
      ? URL.parse(`http://callback/?${text.replace(/^[?#]/, "")}`)
      : null
  if (!url) {
    if (!text) throw new Error("Paste the URL your browser was redirected to.")
    return { code: text, state: undefined, clientID: undefined }
  }
  const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
  if (error) throw new Error(`ChatGPT sign-in failed: ${error}`)
  const code = url.searchParams.get("code")
  if (!code) throw new Error("The pasted URL has no authorization code.")
  const state = url.searchParams.get("state")
  if (!state) throw new Error("The pasted URL has no state. Paste the full URL from the address bar.")
  return { code, state, clientID: url.searchParams.get("client_id") ?? undefined }
}

function credential(tokens: TokenResponse, clientID: string, previous?: Store.OAuth): Store.OAuth {
  const refresh = tokens.refresh_token ?? previous?.refresh
  if (!refresh) throw new Error("ChatGPT sign-in did not return a refresh token.")
  return {
    access: tokens.access_token,
    refresh,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    clientID,
    scopes: tokens.scope?.split(" ").filter(Boolean) ?? previous?.scopes ?? [],
  }
}

function prune(attempts: Map<string, Attempt>) {
  const now = Date.now()
  attempts.forEach((attempt, key) => {
    if (attempt.expires <= now) attempts.delete(key)
  })
}

function challenge(verifier: string) {
  return new Bun.CryptoHasher("sha256").update(verifier).digest("base64url")
}

function randomValue() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
}
