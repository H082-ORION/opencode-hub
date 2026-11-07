import { Option, Schema } from "effect"
import { HOP_BY_HOP } from "../headers.js"
import { json, type Current } from "./accounts.js"
import { Egress } from "./egress.js"
import { Providers } from "./providers.js"
import { Secrets } from "./secrets.js"
import type { Store } from "./store.js"

export * as Connectors from "./connectors.js"

/** Lowercase words joined by single dashes, as `Protocol.ConnectorID` requires. */
export const ID = /^(?=.{1,48}$)[a-z0-9]+(?:-[a-z0-9]+)*$/
/** The server name of a connector in an instance's configuration, so it never replaces a server of the machine's. */
export const SERVER_PREFIX = "hub-"
export const LIMIT = 50
const MAX_NAME = 64
const MAX_HEADERS = 32
const MAX_VALUE = 8192
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/
// Headers that describe the request or the MCP session rather than credentials; the instance sends its own.
const RESERVED = new Set([
  ...HOP_BY_HOP,
  "host",
  "content-length",
  "content-type",
  "content-encoding",
  "accept",
  "accept-encoding",
  "origin",
  "referer",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
])
const TABLE = "connector"

const Tokens = Schema.Struct({
  access: Schema.String,
  refresh: Schema.optional(Schema.String),
  /** Milliseconds since the epoch; absent when the server did not say. */
  expires: Schema.optional(Schema.Number),
  tokenEndpoint: Schema.String,
  issuer: Schema.String,
  resource: Schema.String,
  clientID: Schema.String,
  clientSecret: Schema.optional(Schema.String),
  authMethod: Schema.Literals(["none", "client_secret_post", "client_secret_basic"]),
  scope: Schema.optional(Schema.String),
})
export type Tokens = typeof Tokens.Type

/**
 * What an `oauth` connector keeps sealed: the client the user entered, if any (otherwise the hub registers one), and
 * the tokens of the last sign-in.
 */
const OAuthState = Schema.Struct({
  clientID: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
  tokens: Schema.optional(Tokens),
})
export type OAuthState = typeof OAuthState.Type
const decodeOAuth = Schema.decodeUnknownOption(Schema.fromJsonString(OAuthState))
const decodeHeaders = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Tuple([Schema.String, Schema.String]))),
)
const decodeNames = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))

const Header = Schema.Struct({ name: Schema.String, value: Schema.String })
const decodeCreate = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      name: Schema.String,
      url: Schema.String,
      auth: Schema.optional(Schema.Literals(["headers", "oauth"])),
      headers: Schema.optional(Schema.Array(Header)),
      clientID: Schema.optional(Schema.String),
      clientSecret: Schema.optional(Schema.String),
      scope: Schema.optional(Schema.String),
    }),
  ),
)
const decodeUpdate = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      url: Schema.optional(Schema.String),
      headers: Schema.optional(Schema.Array(Header)),
      clientID: Schema.optional(Schema.String),
      clientSecret: Schema.optional(Schema.String),
      scope: Schema.optional(Schema.String),
    }),
  ),
)

/** A connector with its secrets in clear; it exists only in memory, while a request needs it. */
export type Connector = {
  id: string
  name: string
  url: string
  auth: Store.ConnectorAuth
  headers: (readonly [string, string])[]
  oauth: OAuthState | undefined
}

export type Opened =
  | { kind: "unknown" }
  | { kind: "locked" }
  /** The secret does not open under the key in memory: a damaged row, never a reason to try another key. */
  | { kind: "unreadable" }
  | { kind: "ok"; connector: Connector; key: string }

/**
 * Each user's remote MCP servers (specs/multi-users.md, "Connecteurs MCP"), with the headers to inject, or the OAuth
 * state, sealed under that user's key. Saving one checks its URL with the network guard; listing one needs no key.
 */
export function create(input: {
  store: Store.Instance
  key: (user: string) => string | undefined
  egress: Egress.Instance
  /** Called after a user's connectors changed, so their instances get the new list. */
  changed: (user: string) => void
}) {
  const store = input.store
  const place = (user: string, id: string) => ({ table: TABLE, row: id, user })

  async function open(user: string, id: string): Promise<Opened> {
    const row = store.connector(user, id)
    if (!row) return { kind: "unknown" }
    const key = input.key(user)
    if (!key) return { kind: "locked" }
    const sealed = row.auth === "oauth" ? row.oauth : row.headers
    const secret = sealed === null ? undefined : await Secrets.open(key, place(user, id), sealed)
    if (secret === undefined) return { kind: "unreadable" }
    const headers = row.auth === "headers" ? Option.getOrUndefined(decodeHeaders(secret)) : []
    const oauth = row.auth === "oauth" ? Option.getOrUndefined(decodeOAuth(secret)) : undefined
    if (!headers || (row.auth === "oauth" && !oauth)) return { kind: "unreadable" }
    return {
      kind: "ok",
      key,
      connector: { id: row.id, name: row.name, url: row.url, auth: row.auth, headers: [...headers], oauth },
    }
  }

  return {
    open,

    /** A user's connectors without secrets, for the dashboard and the machines' INSTANCE frames. */
    summaries,

    /**
     * Seals a refreshed or new OAuth state with `key`, the key the connector was opened with, while its URL is still
     * `url`. Returns false when the connector changed or went away meanwhile.
     */
    async saveOAuth(user: string, id: string, url: string, key: string, oauth: OAuthState) {
      return store.updateConnectorOAuth({
        user,
        id,
        url,
        oauth: await Secrets.seal(key, place(user, id), JSON.stringify(oauth)),
        connected: oauth.tokens !== undefined,
      })
    },

    /** Handles `connectors` and `connectors/<id>` under `/hub/api/`; undefined for any other route. */
    async handle(request: Request, route: string, current: Current) {
      const method = request.method
      const user = current.user.id
      if (route === "connectors" && method === "GET") return json(200, summaries(user))
      const one = /^connectors\/([^/]+)$/.exec(route)
      // Removing a connector needs no key: nothing is decrypted.
      if (one && method === "DELETE") {
        if (!store.deleteConnector(user, decodeURIComponent(one[1]))) return json(404, { error: "Unknown connector." })
        input.changed(user)
        return new Response(null, { status: 204 })
      }
      if (route !== "connectors" && !one) return undefined
      if (method !== "POST") return json(404, { error: "Not found." })
      // Saving seals the headers or the OAuth client under the user's key, so it needs that key in memory.
      const key = input.key(user)
      if (!key) return json(423, { error: Providers.LOCKED, locked: true })
      if (one) return update(request, user, key, decodeURIComponent(one[1]))
      return add(request, user, key)
    },
  }

  async function add(request: Request, user: string, key: string) {
    const body = Option.getOrUndefined(decodeCreate(await request.text()))
    if (!body) return json(400, { error: "Expected { name, url, id?, auth?, headers?, clientID?, clientSecret? }." })
    const name = displayName(body.name)
    if (!name) return json(400, { error: `The name must be 1 to ${MAX_NAME} characters.` })
    const id = body.id?.trim() || slug(name)
    if (!ID.test(id))
      return json(400, {
        error: "The id must be lowercase letters and digits joined by dashes, 48 characters at most.",
      })
    const url = await checkURL(body.url)
    if (url instanceof Response) return url
    const auth = body.auth ?? "headers"
    const headers = auth === "headers" ? checkHeaders(body.headers ?? []) : []
    if (headers instanceof Response) return headers
    const oauth = auth === "oauth" ? clientConfig(body) : undefined
    const sealed = await Secrets.seal(
      key,
      place(user, id),
      JSON.stringify(auth === "headers" ? headers : (oauth ?? {})),
    )
    const saved = store.saveConnector({
      user,
      id,
      name,
      url,
      auth,
      headerNames: headers.map((entry) => entry[0]),
      headers: auth === "headers" ? sealed : null,
      oauth: auth === "oauth" ? sealed : null,
      connectedAt: null,
      create: true,
      limit: LIMIT,
    })
    if (saved === "taken") return json(409, { error: `You already have a connector with the id ${id}.` })
    if (saved === "limit") return json(409, { error: `You can have at most ${LIMIT} connectors.` })
    input.changed(user)
    return json(200, { connector: summary(user, id) })
  }

  /**
   * Changes a connector. Headers left out are kept; for an `oauth` connector, a new URL or client drops the tokens,
   * which were issued for the previous server or client.
   */
  async function update(request: Request, user: string, key: string, id: string) {
    const body = Option.getOrUndefined(decodeUpdate(await request.text()))
    if (!body) return json(400, { error: "Expected { name?, url?, headers?, clientID?, clientSecret?, scope? }." })
    const row = store.connector(user, id)
    if (!row) return json(404, { error: "Unknown connector." })
    const name = body.name === undefined ? row.name : displayName(body.name)
    if (!name) return json(400, { error: `The name must be 1 to ${MAX_NAME} characters.` })
    const url = body.url === undefined ? row.url : await checkURL(body.url)
    if (url instanceof Response) return url
    const headers = body.headers === undefined ? undefined : checkHeaders(body.headers)
    if (headers instanceof Response) return headers
    if (row.auth === "headers") {
      const saved = store.saveConnector({
        user,
        id,
        name,
        url,
        auth: "headers",
        headerNames: headers
          ? headers.map((entry) => entry[0])
          : Option.getOrElse(decodeNames(row.header_names), () => []),
        headers: headers ? await Secrets.seal(key, place(user, id), JSON.stringify(headers)) : row.headers,
        oauth: null,
        connectedAt: null,
        create: false,
        limit: LIMIT,
      })
      if (saved !== "ok") return json(404, { error: "Unknown connector." })
      input.changed(user)
      return json(200, { connector: summary(user, id) })
    }
    const opened = await open(user, id)
    if (opened.kind === "locked") return json(423, { error: Providers.LOCKED, locked: true })
    if (opened.kind !== "ok") return json(500, { error: "This connector's saved state is unreadable: remove it." })
    const previous = opened.connector.oauth ?? {}
    const client = body.clientID !== undefined || body.clientSecret !== undefined || body.scope !== undefined
    const config = client ? clientConfig(body) : previous
    const keep = url === row.url && !client
    const oauth: OAuthState = keep ? previous : { ...config, tokens: undefined }
    const saved = store.saveConnector({
      user,
      id,
      name,
      url,
      auth: "oauth",
      headerNames: [],
      headers: null,
      oauth: await Secrets.seal(key, place(user, id), JSON.stringify(oauth)),
      connectedAt: keep ? row.connected_at : null,
      create: false,
      limit: LIMIT,
    })
    if (saved !== "ok") return json(404, { error: "Unknown connector." })
    input.changed(user)
    return json(200, { connector: summary(user, id) })
  }

  function summaries(user: string) {
    return store.connectorSummaries(user).map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      auth: row.auth,
      headers: Option.getOrElse(decodeNames(row.header_names), () => []),
      connected: row.auth === "oauth" ? row.connected_at !== null : null,
      server: `${SERVER_PREFIX}${row.id}`,
    }))
  }

  function summary(user: string, id: string) {
    return summaries(user).find((entry) => entry.id === id)
  }

  /** The normalized URL of a connector, or a 400 that says why the network guard refused it. */
  async function checkURL(input: string) {
    const url = URL.parse(input.trim())
    if (!url) return json(400, { error: "Enter the MCP server's full URL, starting with https://." })
    if (url.hash) return json(400, { error: "The URL must not contain a fragment (#)." })
    const refused = await egressCheck(url)
    if (refused) return json(400, { error: refused })
    return url.toString()
  }

  async function egressCheck(url: URL) {
    return input.egress.check(url).then(
      () => undefined,
      (error: unknown) => {
        if (error instanceof Egress.RefusedError) return error.message
        throw error
      },
    )
  }
}

export type Instance = ReturnType<typeof create>

/** Header pairs to inject, checked; or a 400 that says what is wrong. */
function checkHeaders(input: readonly { name: string; value: string }[]) {
  if (input.length > MAX_HEADERS) return json(400, { error: `At most ${MAX_HEADERS} headers.` })
  const headers = input.map((entry) => [entry.name.trim(), entry.value.trim()] as const)
  const bad = headers.find(
    (entry) => !HEADER_NAME.test(entry[0]) || RESERVED.has(entry[0].toLowerCase()) || entry[0].startsWith("proxy-"),
  )
  if (bad) return json(400, { error: `${bad[0] || "An empty name"} cannot be used as a connector header.` })
  // A value travels in a header line: no line breaks, no NUL, nothing beyond Latin-1.
  const value = headers.find(
    (entry) => !entry[1] || entry[1].length > MAX_VALUE || /[\0\r\n]|[^\t\x20-\x7e\x80-\xff]/.test(entry[1]),
  )
  if (value) return json(400, { error: `The value of ${value[0]} is empty, too long or has invalid characters.` })
  const names = headers.map((entry) => entry[0].toLowerCase())
  if (new Set(names).size !== names.length) return json(400, { error: "Each header name may appear only once." })
  return headers
}

function clientConfig(body: { clientID?: string; clientSecret?: string; scope?: string }): OAuthState {
  const clientID = body.clientID?.trim() || undefined
  return {
    clientID,
    // A secret without its client means nothing.
    clientSecret: clientID ? body.clientSecret?.trim() || undefined : undefined,
    scope: body.scope?.trim() || undefined,
  }
}

function displayName(input: string) {
  const name = input.normalize("NFKC").trim().replace(/\s+/g, " ")
  if (!name || name.length > MAX_NAME || /\p{Cc}/u.test(name)) return undefined
  return name
}

/** A connector id derived from its name: `My GitHub` becomes `my-github`. */
export function slug(name: string) {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "")
}
