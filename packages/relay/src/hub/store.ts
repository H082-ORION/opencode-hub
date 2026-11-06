import { Database } from "bun:sqlite"
import { Option, Schema } from "effect"
import { mkdirSync } from "node:fs"
import path from "node:path"

export * as Store from "./store.js"

export type Machine = {
  id: string
  name: string
  created_at: number
  last_seen_at: number | null
}

const OAuth = Schema.Struct({
  access: Schema.String,
  refresh: Schema.String,
  expires: Schema.Number,
  clientID: Schema.String,
  scopes: Schema.Array(Schema.String),
})
export type OAuth = typeof OAuth.Type
const decodeOAuth = Schema.decodeUnknownOption(Schema.fromJsonString(OAuth))

/** `key` providers forward `api_key`; `chatgpt` providers use the OAuth credential in `oauth`. */
export type Auth = "key" | "chatgpt"

export type Provider = {
  id: string
  name: string
  base_url: string
  api_key: string
  auth: Auth
  oauth: OAuth | undefined
  created_at: number
}

/** Provider fields that are safe to show in the UI: no key, no tokens. */
export type ProviderSummary = Pick<Provider, "id" | "name" | "base_url" | "auth">

type ProviderRow = Omit<Provider, "auth" | "oauth"> & { auth: string; oauth: string | null }

// Labels that would collide with infrastructure names or look like the hub itself.
const RESERVED = new Set(["www", "hub", "api", "app", "admin", "mail", "llm", "localhost", "static", "assets"])
const MAX_ID = 32

export function open(dir: string) {
  mkdirSync(dir, { recursive: true })
  const db = new Database(path.join(dir, "hub.db"), { create: true, strict: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run(`CREATE TABLE IF NOT EXISTS machine (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tunnel_token_hash TEXT NOT NULL UNIQUE,
    llm_token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS provider (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    auth TEXT NOT NULL DEFAULT 'key',
    oauth TEXT,
    created_at INTEGER NOT NULL
  )`)
  // Databases created before OAuth providers lack these columns.
  const columns = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(provider)")
      .all()
      .map((row) => row.name),
  )
  if (!columns.has("auth")) db.run("ALTER TABLE provider ADD COLUMN auth TEXT NOT NULL DEFAULT 'key'")
  if (!columns.has("oauth")) db.run("ALTER TABLE provider ADD COLUMN oauth TEXT")
  db.run("CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)")

  const machineColumns = "id, name, created_at, last_seen_at"
  const queries = {
    machines: db.query<Machine, []>(`SELECT ${machineColumns} FROM machine ORDER BY created_at`),
    machine: db.query<Machine, [string]>(`SELECT ${machineColumns} FROM machine WHERE id = ?`),
    byTunnel: db.query<Machine, [string]>(`SELECT ${machineColumns} FROM machine WHERE tunnel_token_hash = ?`),
    byLlm: db.query<Machine, [string]>(`SELECT ${machineColumns} FROM machine WHERE llm_token_hash = ?`),
    providers: db.query<ProviderRow, []>("SELECT * FROM provider ORDER BY id"),
    provider: db.query<ProviderRow, [string]>("SELECT * FROM provider WHERE id = ?"),
    summaries: db.query<ProviderSummary, []>("SELECT id, name, base_url, auth FROM provider ORDER BY id"),
    setting: db.query<{ value: string }, [string]>("SELECT value FROM setting WHERE key = ?"),
  }

  return {
    machines: () => queries.machines.all(),
    machine: (id: string) => queries.machine.get(id) ?? undefined,
    machineByTunnelToken: (token: string) => queries.byTunnel.get(hashToken(token)) ?? undefined,
    machineByLlmToken: (token: string) => queries.byLlm.get(hashToken(token)) ?? undefined,
    /** Creates a machine with an id derived from `name` and returns it with its fresh plaintext tokens. */
    createMachine(name: string) {
      const tunnelToken = randomToken()
      const llmToken = randomToken()
      const id = db.transaction(() => {
        const machineID = availableID(slug(name), (candidate) => queries.machine.get(candidate) !== null)
        db.run("INSERT INTO machine (id, name, tunnel_token_hash, llm_token_hash, created_at) VALUES (?, ?, ?, ?, ?)", [
          machineID,
          name,
          hashToken(tunnelToken),
          hashToken(llmToken),
          Date.now(),
        ])
        return machineID
      })()
      return { machine: { id, name }, tunnelToken, llmToken }
    },
    deleteMachine: (id: string) => db.run("DELETE FROM machine WHERE id = ?", [id]).changes > 0,
    touchMachine: (id: string) => db.run("UPDATE machine SET last_seen_at = ? WHERE id = ?", [Date.now(), id]),
    /** Full provider rows including secrets; only for the proxy and other server-side code. */
    providers: () => queries.providers.all().map(fromRow),
    provider(id: string) {
      const row = queries.provider.get(id)
      return row ? fromRow(row) : undefined
    },
    providerSummaries: () => queries.summaries.all(),
    saveProvider: (input: { id: string; name: string; baseURL: string; apiKey: string }) =>
      db.run(
        `INSERT INTO provider (id, name, base_url, api_key, auth, oauth, created_at) VALUES (?, ?, ?, ?, 'key', NULL, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url, api_key = excluded.api_key,
           auth = excluded.auth, oauth = excluded.oauth`,
        [input.id, input.name, input.baseURL, input.apiKey, Date.now()],
      ),
    saveOAuthProvider: (input: { id: string; name: string; baseURL: string; oauth: OAuth }) =>
      db.run(
        `INSERT INTO provider (id, name, base_url, api_key, auth, oauth, created_at) VALUES (?, ?, ?, '', 'chatgpt', ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url, api_key = excluded.api_key,
           auth = excluded.auth, oauth = excluded.oauth`,
        [input.id, input.name, input.baseURL, JSON.stringify(input.oauth), Date.now()],
      ),
    /** Replaces the credential of an existing OAuth provider, e.g. after a refresh. */
    updateOAuth: (id: string, oauth: OAuth) =>
      db.run("UPDATE provider SET oauth = ? WHERE id = ? AND auth = 'chatgpt'", [JSON.stringify(oauth), id]).changes >
      0,
    deleteProvider: (id: string) => db.run("DELETE FROM provider WHERE id = ?", [id]).changes > 0,
    setting: (key: string) => queries.setting.get(key)?.value,
    setSetting: (key: string, value: string) =>
      db.run("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [
        key,
        value,
      ]),
    close: () => db.close(),
  }
}

export type Instance = ReturnType<typeof open>

function fromRow(row: ProviderRow): Provider {
  return {
    ...row,
    auth: row.auth === "chatgpt" ? "chatgpt" : "key",
    oauth: row.oauth === null ? undefined : Option.getOrUndefined(decodeOAuth(row.oauth)),
  }
}

/** Lowercase DNS label derived from a machine name: a-z, 0-9 and single hyphens, at most 32 characters. */
export function slug(name: string) {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_ID)
    .replace(/^-+|-+$/g, "")
  return base || "machine"
}

function availableID(base: string, taken: (id: string) => boolean) {
  if (!RESERVED.has(base) && !taken(base)) return base
  for (let index = 2; index < 10_000; index++) {
    const suffix = `-${index}`
    const candidate = `${base.slice(0, MAX_ID - suffix.length).replace(/-+$/, "")}${suffix}`
    if (!taken(candidate)) return candidate
  }
  throw new Error(`no machine id available for ${base}`)
}

export function randomToken() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
}

export function hashToken(token: string) {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex")
}
