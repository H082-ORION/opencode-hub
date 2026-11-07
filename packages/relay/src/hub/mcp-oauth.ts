import { Option, Schema } from "effect"
import { Connectors } from "./connectors.js"
import { Egress } from "./egress.js"
import { Providers } from "./providers.js"

export * as McpOAuth from "./mcp-oauth.js"

/**
 * OAuth for connectors whose MCP server requires it, run by the hub (specs/multi-users.md, "Connecteurs MCP"): the
 * authorization code flow with PKCE (S256), discovered as the MCP authorization specification describes. The protected
 * resource metadata (RFC 9728) comes from the server's `WWW-Authenticate` challenge or its well-known URL, then the
 * authorization server's metadata (RFC 8414, or OpenID Connect discovery). Without a client id from the user, the hub
 * registers itself (RFC 7591). The browser comes back to the hub's callback route; the tokens are sealed under the
 * user's key and refreshed by the relay. Every request the hub sends goes through the network guard.
 */

/** The hub's callback route, on its own host. */
export const CALLBACK_PATH = "/hub/oauth/callback"
const ATTEMPT_TTL = 10 * 60_000
const REFRESH_MARGIN = 60_000
const PROTOCOL_VERSION = "2025-06-18"
const MAX_DOCUMENT = 64 * 1024

const ResourceMetadata = Schema.Struct({
  resource: Schema.String,
  authorization_servers: Schema.optional(Schema.Array(Schema.String)),
  scopes_supported: Schema.optional(Schema.Array(Schema.String)),
})
const decodeResourceMetadata = Schema.decodeUnknownOption(Schema.fromJsonString(ResourceMetadata))

const ServerMetadata = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.optional(Schema.String),
  code_challenge_methods_supported: Schema.optional(Schema.Array(Schema.String)),
  token_endpoint_auth_methods_supported: Schema.optional(Schema.Array(Schema.String)),
})
type ServerMetadata = typeof ServerMetadata.Type
const decodeServerMetadata = Schema.decodeUnknownOption(Schema.fromJsonString(ServerMetadata))

const Registration = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.optional(Schema.String),
  token_endpoint_auth_method: Schema.optional(Schema.String),
})
const decodeRegistration = Schema.decodeUnknownOption(Schema.fromJsonString(Registration))

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  scope: Schema.optional(Schema.String),
})
type TokenResponse = typeof TokenResponse.Type
const decodeTokenResponse = Schema.decodeUnknownOption(Schema.fromJsonString(TokenResponse))

type AuthMethod = Connectors.Tokens["authMethod"]

/** A sign-in in progress, bound to the hub user who started it and to the connector's URL at that time. */
type Attempt = {
  user: string
  connector: string
  url: string
  verifier: string
  issuer: string
  tokenEndpoint: string
  resource: string
  scope?: string
  client: { id: string; secret?: string; method: AuthMethod }
  expires: number
}

/** A sign-in that cannot go on, with a message for the user. */
export class OAuthError extends Error {}

export function create(input: {
  connectors: Connectors.Instance
  egress: Egress.Instance
  /** The hub's public origin: the redirect URI is `<origin>/hub/oauth/callback`. */
  origin: string
  key: (user: string) => string | undefined
  app: { name: string; version: string }
}) {
  const redirectURI = `${input.origin}${CALLBACK_PATH}`
  const attempts = new Map<string, Attempt>()
  const refreshing = new Map<string, Promise<string>>()

  return {
    /**
     * Starts a sign-in for one of the user's `oauth` connectors and returns the authorization URL to open. Throws
     * `LockedError` without the user's key (the client and tokens could not be sealed), `OAuthError` otherwise.
     */
    async begin(user: string, id: string) {
      prune()
      const opened = await input.connectors.open(user, id)
      if (opened.kind === "locked") throw new Providers.LockedError()
      if (opened.kind === "unknown") throw new OAuthError("Unknown connector.")
      if (opened.kind === "unreadable") throw new OAuthError("This connector's saved state is unreadable: remove it.")
      const connector = opened.connector
      if (connector.auth !== "oauth") throw new OAuthError("This connector uses headers, not OAuth.")
      const config = connector.oauth ?? {}
      const resource = await discoverResource(connector.url)
      const issuer = resource.server
      const server = await serverMetadata(issuer)
      if (!server.code_challenge_methods_supported?.includes("S256"))
        throw new OAuthError("The authorization server does not support PKCE with S256, which MCP requires.")
      const authorize = URL.parse(server.authorization_endpoint)
      if (!authorize || !input.egress.browsable(authorize))
        throw new OAuthError("The authorization server's sign-in page is not an https:// URL.")
      const client = config.clientID
        ? {
            id: config.clientID,
            secret: config.clientSecret,
            method: secretMethod(config.clientSecret, server.token_endpoint_auth_methods_supported),
          }
        : await register(server)
      const verifier = randomValue()
      const state = randomValue()
      const scope = config.scope ?? resource.scopes?.join(" ")
      // One sign-in at a time per connector: an older attempt for it stops working.
      attempts.forEach((attempt, key) => attempt.user === user && attempt.connector === id && attempts.delete(key))
      attempts.set(state, {
        user,
        connector: id,
        url: connector.url,
        verifier,
        issuer: server.issuer,
        tokenEndpoint: server.token_endpoint,
        resource: resource.resource,
        scope,
        client,
        expires: Date.now() + ATTEMPT_TTL,
      })
      authorize.searchParams.set("response_type", "code")
      authorize.searchParams.set("client_id", client.id)
      authorize.searchParams.set("redirect_uri", redirectURI)
      authorize.searchParams.set("code_challenge", challenge(verifier))
      authorize.searchParams.set("code_challenge_method", "S256")
      authorize.searchParams.set("state", state)
      authorize.searchParams.set("resource", resource.resource)
      if (scope) authorize.searchParams.set("scope", scope)
      return { url: authorize.toString() }
    },

    /**
     * Finishes a sign-in from the callback URL the browser was sent to, for the signed-in user, and seals the tokens.
     * Returns the connector id. Another user's attempt is as unknown as an expired one.
     */
    async complete(user: string, callback: URL) {
      prune()
      const state = callback.searchParams.get("state") ?? ""
      const attempt = attempts.get(state)
      if (!attempt || attempt.user !== user) throw new OAuthError("This sign-in expired. Connect again from the hub.")
      // Single use, whatever happens next.
      attempts.delete(state)
      const error = callback.searchParams.get("error_description") ?? callback.searchParams.get("error")
      if (error) throw new OAuthError(`The authorization server refused the sign-in: ${error.slice(0, 300)}`)
      const issuer = callback.searchParams.get("iss")
      // RFC 9207: a response that names another issuer is a mix-up attack.
      if (issuer !== null && issuer !== attempt.issuer)
        throw new OAuthError("The sign-in answer came from another authorization server.")
      const code = callback.searchParams.get("code")
      if (!code) throw new OAuthError("The sign-in answer has no authorization code.")
      const key = input.key(user)
      if (!key) throw new Providers.LockedError()
      const response = await tokens(attempt.tokenEndpoint, attempt.client, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectURI,
        code_verifier: attempt.verifier,
        resource: attempt.resource,
      })
      const opened = await input.connectors.open(user, attempt.connector)
      if (opened.kind !== "ok" || opened.connector.url !== attempt.url)
        throw new OAuthError("This connector changed during the sign-in. Connect again.")
      const saved = await input.connectors.saveOAuth(user, attempt.connector, attempt.url, key, {
        ...opened.connector.oauth,
        tokens: credential(response, attempt),
      })
      if (!saved) throw new OAuthError("This connector changed during the sign-in. Connect again.")
      return attempt.connector
    },

    /**
     * A valid access token for an opened `oauth` connector, refreshed (once for concurrent callers) when it expires
     * within a minute, or when `force` says the server refused it. The refreshed tokens are sealed again under `key`,
     * the key the connector was opened with. Throws `OAuthError` when the user has to sign in again.
     */
    accessToken(user: string, connector: Connectors.Connector, key: string, force = false) {
      const current = connector.oauth?.tokens
      if (!current) return Promise.reject(new OAuthError("This connector is not connected: connect it from the hub."))
      const fresh = current.expires === undefined || current.expires - Date.now() > REFRESH_MARGIN
      if (fresh && !force) return Promise.resolve(current.access)
      if (!current.refresh)
        return Promise.reject(new OAuthError("This connector's sign-in expired: connect it again from the hub."))
      // A user id never contains a NUL, so the pair cannot collide with another user's.
      const slot = `${user}\0${connector.id}`
      const pending =
        refreshing.get(slot) ?? refresh(user, connector, key, current.access).finally(() => refreshing.delete(slot))
      refreshing.set(slot, pending)
      return pending
    },
  }

  async function refresh(user: string, connector: Connectors.Connector, key: string, refused: string) {
    // Another request may have refreshed it since this one opened the connector: its refresh token may be rotated.
    const latest = await input.connectors.open(user, connector.id)
    const state = latest.kind === "ok" && latest.connector.url === connector.url ? latest.connector.oauth : undefined
    const current = state?.tokens ?? connector.oauth?.tokens
    if (!current?.refresh) throw new OAuthError("This connector's sign-in expired: connect it again from the hub.")
    if (current.access !== refused && current.expires !== undefined && current.expires - Date.now() > REFRESH_MARGIN)
      return current.access
    const response = await tokens(
      current.tokenEndpoint,
      { id: current.clientID, secret: current.clientSecret, method: current.authMethod },
      { grant_type: "refresh_token", refresh_token: current.refresh, resource: current.resource },
    ).catch((error: unknown) => {
      throw new OAuthError(
        `Refreshing this connector's sign-in failed (${error instanceof Error ? error.message : String(error)}): connect it again from the hub.`,
      )
    })
    const next = { ...current, ...credential(response, current) }
    await input.connectors.saveOAuth(user, connector.id, connector.url, key, { ...state, tokens: next })
    return next.access
  }

  /**
   * The protected resource behind a connector URL and its authorization server: the metadata URL from the server's
   * 401 challenge, else the well-known URLs (path-specific first). A server without metadata is its own authorization
   * server, as the first MCP authorization revision had it.
   */
  async function discoverResource(url: string) {
    const target = new URL(url)
    const challenged = await probe(target)
    const candidates = [
      ...(challenged ? [challenged] : []),
      ...(target.pathname !== "/"
        ? [new URL(`/.well-known/oauth-protected-resource${target.pathname.replace(/\/+$/, "")}`, target)]
        : []),
      new URL("/.well-known/oauth-protected-resource", target),
    ]
    const metadata = await first(candidates, async (candidate) =>
      Option.getOrUndefined(decodeResourceMetadata(await document(candidate))),
    )
    if (!metadata) return { resource: url, server: target.origin, scopes: undefined }
    const resource = URL.parse(metadata.resource)
    // RFC 9728 section 3.3: metadata for another resource must not be used.
    if (!resource || resource.origin !== target.origin)
      throw new OAuthError("The MCP server's metadata describes another resource.")
    const server = metadata.authorization_servers?.[0]
    if (!server) throw new OAuthError("The MCP server's metadata names no authorization server.")
    return { resource: metadata.resource, server, scopes: metadata.scopes_supported }
  }

  /** Sends an MCP `initialize` without credentials and reads `resource_metadata` from a 401 challenge. */
  async function probe(target: URL) {
    const response = await input.egress
      .fetch(target, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": PROTOCOL_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: `opencode-${input.app.name}`, version: input.app.version },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      })
      .catch(rethrow)
    await response.body?.cancel()
    if (response.status !== 401) return undefined
    const header = response.headers.get("www-authenticate") ?? ""
    const value = /resource_metadata="([^"]+)"/i.exec(header)?.[1] ?? /resource_metadata=([^\s,]+)/i.exec(header)?.[1]
    return value ? (URL.parse(value, target.href) ?? undefined) : undefined
  }

  /** RFC 8414 metadata, else OpenID Connect discovery, as the MCP authorization specification orders them. */
  async function serverMetadata(issuer: string) {
    const url = URL.parse(issuer)
    if (!url) throw new OAuthError("The authorization server's address is not a URL.")
    const path = url.pathname.replace(/\/+$/, "")
    const candidates = path
      ? [
          new URL(`/.well-known/oauth-authorization-server${path}`, url),
          new URL(`/.well-known/openid-configuration${path}`, url),
          new URL(`${path}/.well-known/openid-configuration`, url),
        ]
      : [new URL("/.well-known/oauth-authorization-server", url), new URL("/.well-known/openid-configuration", url)]
    const metadata = await first(candidates, async (candidate) =>
      Option.getOrUndefined(decodeServerMetadata(await document(candidate))),
    )
    if (!metadata) throw new OAuthError("The authorization server publishes no OAuth metadata.")
    if (metadata.issuer.replace(/\/+$/, "") !== issuer.replace(/\/+$/, ""))
      throw new OAuthError("The authorization server's metadata names another issuer.")
    return metadata
  }

  /** Registers the hub as a public client (RFC 7591), when the server allows it. */
  async function register(server: ServerMetadata) {
    if (!server.registration_endpoint)
      throw new OAuthError(
        "This server does not let the hub register itself: enter the client id it gave you for this connector.",
      )
    const response = await input.egress
      .fetch(server.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_name: "OpenCode Hub",
          redirect_uris: [redirectURI],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
        signal: AbortSignal.timeout(15_000),
      })
      .catch(rethrow)
    const text = await limited(response)
    if (!response.ok) throw new OAuthError(`The authorization server refused to register the hub (${response.status}).`)
    const registered = Option.getOrUndefined(decodeRegistration(text))
    if (!registered) throw new OAuthError("The authorization server answered the registration unexpectedly.")
    return {
      id: registered.client_id,
      secret: registered.client_secret,
      method: registered.client_secret
        ? registered.token_endpoint_auth_method === "client_secret_post"
          ? ("client_secret_post" as const)
          : ("client_secret_basic" as const)
        : ("none" as const),
    }
  }

  async function tokens(endpoint: string, client: Attempt["client"], body: Record<string, string>) {
    const headers = new Headers({
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    })
    const form = new URLSearchParams(body)
    if (client.method === "client_secret_basic" && client.secret)
      headers.set(
        "authorization",
        `Basic ${btoa(`${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret)}`)}`,
      )
    if (client.method !== "client_secret_basic") form.set("client_id", client.id)
    if (client.method === "client_secret_post" && client.secret) form.set("client_secret", client.secret)
    const response = await input.egress
      .fetch(endpoint, { method: "POST", headers, body: form.toString(), signal: AbortSignal.timeout(15_000) })
      .catch(rethrow)
    const text = await limited(response)
    if (!response.ok) throw new OAuthError(`The token request failed (${response.status}).`)
    const parsed = Option.getOrUndefined(decodeTokenResponse(text))
    if (!parsed) throw new OAuthError("The token endpoint answered unexpectedly.")
    if (parsed.token_type !== undefined && parsed.token_type.toLowerCase() !== "bearer")
      throw new OAuthError(`The token endpoint issued a ${parsed.token_type} token; only bearer tokens are supported.`)
    return parsed
  }

  /** A JSON document from a metadata URL, or undefined when it is missing. */
  async function document(url: URL) {
    const response = await input.egress
      .fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) })
      .catch(rethrow)
    if (!response.ok) {
      await response.body?.cancel()
      return undefined
    }
    return limited(response)
  }

  function prune() {
    const now = Date.now()
    attempts.forEach((attempt, key) => attempt.expires <= now && attempts.delete(key))
  }
}

export type Instance = ReturnType<typeof create>

function credential(
  response: TokenResponse,
  base: Pick<Attempt, "issuer" | "tokenEndpoint" | "resource"> & {
    client?: Attempt["client"]
    clientID?: string
    clientSecret?: string
    authMethod?: AuthMethod
    refresh?: string
    scope?: string
  },
): Connectors.Tokens {
  return {
    access: response.access_token,
    // A refresh answer may leave the refresh token out: the previous one stays valid.
    refresh: response.refresh_token ?? base.refresh,
    expires: response.expires_in === undefined ? undefined : Date.now() + response.expires_in * 1000,
    tokenEndpoint: base.tokenEndpoint,
    issuer: base.issuer,
    resource: base.resource,
    clientID: base.client?.id ?? base.clientID ?? "",
    clientSecret: base.client ? base.client.secret : base.clientSecret,
    authMethod: base.client?.method ?? base.authMethod ?? "none",
    scope: response.scope ?? base.scope,
  }
}

function secretMethod(secret: string | undefined, supported: readonly string[] | undefined): AuthMethod {
  if (!secret) return "none"
  // RFC 8414: without a list, client_secret_basic is the default.
  if (supported && !supported.includes("client_secret_basic") && supported.includes("client_secret_post"))
    return "client_secret_post"
  return "client_secret_basic"
}

/** The first candidate that gives a value, tried in order. */
async function first<T, R>(candidates: readonly T[], attempt: (candidate: T) => Promise<R | undefined>) {
  for (const candidate of candidates) {
    const found = await attempt(candidate)
    if (found !== undefined) return found
  }
  return undefined
}

/** A response body as text, refused beyond 64 KiB: metadata and token answers are small. */
async function limited(response: Response) {
  const text = await response.text()
  if (text.length > MAX_DOCUMENT) throw new OAuthError("The authorization server's answer is too large.")
  return text
}

function rethrow(error: unknown): never {
  if (error instanceof Egress.RefusedError) throw new OAuthError(error.message)
  throw new OAuthError(`Could not reach the server: ${error instanceof Error ? error.message : String(error)}`)
}

function challenge(verifier: string) {
  return new Bun.CryptoHasher("sha256").update(verifier).digest("base64url")
}

function randomValue() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
}
