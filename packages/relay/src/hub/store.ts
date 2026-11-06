import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import path from "node:path"

export * as Store from "./store.js"

export type Machine = {
  id: string
  name: string
  created_at: number
  last_seen_at: number | null
}

export type Provider = {
  id: string
  name: string
  base_url: string
  api_key: string
  created_at: number
}

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
    created_at INTEGER NOT NULL
  )`)
  db.run("CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)")

  const machineColumns = "id, name, created_at, last_seen_at"
  const queries = {
    machines: db.query<Machine, []>(`SELECT ${machineColumns} FROM machine ORDER BY created_at`),
    machine: db.query<Machine, [string]>(`SELECT ${machineColumns} FROM machine WHERE id = ?`),
    byTunnel: db.query<Machine, [string]>(`SELECT ${machineColumns} FROM machine WHERE tunnel_token_hash = ?`),
    byLlm: db.query<Machine, [string]>(`SELECT ${machineColumns} FROM machine WHERE llm_token_hash = ?`),
    providers: db.query<Provider, []>("SELECT * FROM provider ORDER BY id"),
    provider: db.query<Provider, [string]>("SELECT * FROM provider WHERE id = ?"),
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
    providers: () => queries.providers.all(),
    provider: (id: string) => queries.provider.get(id) ?? undefined,
    saveProvider: (input: { id: string; name: string; baseURL: string; apiKey: string }) =>
      db.run(
        `INSERT INTO provider (id, name, base_url, api_key, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url, api_key = excluded.api_key`,
        [input.id, input.name, input.baseURL, input.apiKey, Date.now()],
      ),
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
