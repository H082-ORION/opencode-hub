import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs"
import path from "node:path"

export * as Store from "./store.js"

/**
 * A machine belongs to exactly one owner: a user (`owner_user_id`) or, from step 4 of the multi-user spec, an
 * organization (`owner_org_id`). The code keeps that invariant; a machine enrolled before owners existed has neither
 * until it is adopted by the first administrator (see `adoptMachines`).
 */
export type Machine = {
  id: string
  name: string
  owner_user_id: string | null
  owner_org_id: string | null
  /** The user whose enrollment code created the machine. */
  enrolled_by: string | null
  created_at: number
  last_seen_at: number | null
}

/** A machine as the administration lists it, with its owner's login. */
export type MachineSummary = Machine & { owner_login: string | null }

const OAuth = Schema.Struct({
  access: Schema.String,
  refresh: Schema.String,
  expires: Schema.Number,
  clientID: Schema.String,
  scopes: Schema.Array(Schema.String),
})
export type OAuth = typeof OAuth.Type
export const decodeOAuth = Schema.decodeUnknownOption(Schema.fromJsonString(OAuth))

/** `key` providers forward their API key; `chatgpt` providers use an OAuth credential. */
export type Auth = "key" | "chatgpt"

/**
 * A provider of one user as stored: `api_key` (for `key`) or `oauth` (JSON, for `chatgpt`) is sealed under the user's
 * key (see `Secrets`), and the other is null. Only `Providers` opens them.
 */
export type ProviderRow = {
  user_id: string
  id: string
  name: string
  base_url: string
  auth: Auth
  api_key: string | null
  oauth: string | null
  created_at: number
  updated_at: number
}

export type Role = "admin" | "user"

export type User = {
  id: string
  login: string
  role: Role
  /** OPAQUE registration record; null after an administrator reset, until the reset invitation is used. */
  registration_record: string | null
  /** The user key wrapped with the OPAQUE export key, and its HMAC check (see `Account`). */
  wrapped_key: string | null
  key_check: string | null
  created_at: number
  updated_at: number
  disabled_at: number | null
}

export type Invitation = {
  id: string
  role: Role
  created_by: string | null
  /** The account a reset invitation re-registers; null for a new account. */
  user_id: string | null
  created_at: number
  expires_at: number
  used_at: number | null
}

/** A pending invitation as the dashboard lists it, with the logins it refers to. */
export type InvitationSummary = Invitation & { created_by_login: string | null; user_login: string | null }

/** Provider fields that are safe to show in the UI and to send to machines: no key, no tokens. */
export type ProviderSummary = Pick<ProviderRow, "id" | "name" | "base_url" | "auth">

// Labels that would collide with infrastructure names or look like the hub itself.
const RESERVED = new Set(["www", "hub", "api", "app", "admin", "mail", "llm", "localhost", "static", "assets"])
const MAX_ID = 32

const INVITATION_DAYS = 7
const MAX_INVITATION_DAYS = 30
const DAY = 24 * 60 * 60 * 1000
// SQLite creates the WAL and shared-memory files with the database's own mode.
const DATABASE_FILES = ["hub.db", "hub.db-wal", "hub.db-shm"]

export function open(dir: string) {
  secureDirectory(dir)
  const file = path.join(dir, "hub.db")
  // Created owner-only before SQLite opens it, whatever the process umask.
  if (!existsSync(file)) closeSync(openSync(file, "a", 0o600))
  const db = new Database(file, { create: true, strict: true })
  db.run("PRAGMA journal_mode = WAL")
  DATABASE_FILES.forEach((name) => existsSync(path.join(dir, name)) && chmodSync(path.join(dir, name), 0o600))
  db.run(`CREATE TABLE IF NOT EXISTS machine (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tunnel_token_hash TEXT NOT NULL UNIQUE,
    llm_token_hash TEXT NOT NULL UNIQUE,
    owner_user_id TEXT,
    owner_org_id TEXT,
    enrolled_by TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER
  )`)
  // Earlier versions kept every provider's key in clear, shared by all users. That table is dropped unread: its keys
  // have to be entered again by each user. secure_delete zeroes the freed pages, and the checkpoint below moves that
  // into the main file, so the old keys do not linger on disk.
  db.run("PRAGMA secure_delete = ON")
  const providerColumns = db
    .query<{ name: string }, []>("PRAGMA table_info(provider)")
    .all()
    .map((row) => row.name)
  const legacyProviders = providerColumns.length > 0 && !providerColumns.includes("user_id")
  if (legacyProviders) db.run("DROP TABLE provider")
  db.run(`CREATE TABLE IF NOT EXISTS provider (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    auth TEXT NOT NULL CHECK (auth IN ('key', 'chatgpt')),
    api_key TEXT,
    oauth TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )`)
  if (legacyProviders) db.run("PRAGMA wal_checkpoint(TRUNCATE)")
  // Databases created before machines had owners lack these columns; their machines are adopted below.
  const ownerColumns = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(machine)")
      .all()
      .map((row) => row.name),
  )
  ;["owner_user_id", "owner_org_id", "enrolled_by"]
    .filter((column) => !ownerColumns.has(column))
    .forEach((column) => db.run(`ALTER TABLE machine ADD COLUMN ${column} TEXT`))
  db.run("CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  // The single hub password of earlier versions is gone: accounts replace it.
  db.run("DELETE FROM setting WHERE key = 'password_hash'")
  db.run(`CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY,
    login TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    registration_record TEXT,
    wrapped_key TEXT,
    key_check TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    disabled_at INTEGER
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS invitation (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    created_by TEXT,
    user_id TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  )`)

  const machineColumns = "id, name, owner_user_id, owner_org_id, enrolled_by, created_at, last_seen_at"
  const queries = {
    machines: db.query<MachineSummary, []>(
      `SELECT machine.id, machine.name, machine.owner_user_id, machine.owner_org_id, machine.enrolled_by,
         machine.created_at, machine.last_seen_at, user.login AS owner_login
       FROM machine LEFT JOIN user ON user.id = machine.owner_user_id
       ORDER BY machine.created_at`,
    ),
    machinesOf: db.query<Machine, [string]>(
      `SELECT ${machineColumns} FROM machine WHERE owner_user_id = ? AND owner_org_id IS NULL ORDER BY created_at`,
    ),
    machine: db.query<Machine, [string]>(`SELECT ${machineColumns} FROM machine WHERE id = ?`),
    byTunnel: db.query<Machine, [string]>(`SELECT ${machineColumns} FROM machine WHERE tunnel_token_hash = ?`),
    byLlm: db.query<Machine, [string]>(`SELECT ${machineColumns} FROM machine WHERE llm_token_hash = ?`),
    provider: db.query<ProviderRow, [string, string]>("SELECT * FROM provider WHERE user_id = ? AND id = ?"),
    summaries: db.query<ProviderSummary, [string]>(
      "SELECT id, name, base_url, auth FROM provider WHERE user_id = ? ORDER BY id",
    ),
    /** Users whose personal machines rely on providers they saved, i.e. need their key in memory. */
    keysInUse: db.query<{ user_id: string }, []>(
      `SELECT DISTINCT provider.user_id FROM provider
       JOIN machine ON machine.owner_user_id = provider.user_id AND machine.owner_org_id IS NULL`,
    ),
    setting: db.query<{ value: string }, [string]>("SELECT value FROM setting WHERE key = ?"),
    users: db.query<User, []>("SELECT * FROM user ORDER BY created_at"),
    user: db.query<User, [string]>("SELECT * FROM user WHERE id = ?"),
    userByLogin: db.query<User, [string]>("SELECT * FROM user WHERE login = ?"),
    userCount: db.query<{ count: number }, []>("SELECT count(*) AS count FROM user"),
    activeAdmins: db.query<{ count: number }, []>(
      "SELECT count(*) AS count FROM user WHERE role = 'admin' AND disabled_at IS NULL",
    ),
    invitation: db.query<Invitation, [string, number]>(
      `SELECT id, role, created_by, user_id, created_at, expires_at, used_at FROM invitation
       WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
    ),
    invitations: db.query<InvitationSummary, [number]>(
      `SELECT invitation.id, invitation.role, invitation.created_by, invitation.user_id, invitation.created_at,
         invitation.expires_at, invitation.used_at, creator.login AS created_by_login, target.login AS user_login
       FROM invitation
       LEFT JOIN user AS creator ON creator.id = invitation.created_by
       LEFT JOIN user AS target ON target.id = invitation.user_id
       WHERE invitation.used_at IS NULL AND invitation.expires_at > ?
       ORDER BY invitation.created_at`,
    ),
  }

  /**
   * Gives the machines that have no owner yet, enrolled before machines belonged to users, to the oldest active
   * administrator. Until one exists they stay ownerless, which nobody may open.
   */
  const adoptMachines = () =>
    db.run(
      `UPDATE machine SET owner_user_id = (
         SELECT id FROM user WHERE role = 'admin' AND disabled_at IS NULL ORDER BY created_at, rowid LIMIT 1
       )
       WHERE owner_user_id IS NULL AND owner_org_id IS NULL
         AND EXISTS (SELECT 1 FROM user WHERE role = 'admin' AND disabled_at IS NULL)`,
    ).changes
  adoptMachines()

  /** Disabling or demoting the last active administrator would leave nobody able to administer the hub. */
  const lastAdmin = (user: User) =>
    user.role === "admin" && user.disabled_at === null && (queries.activeAdmins.get()?.count ?? 0) <= 1

  const insertInvitation = (input: { role: Role; days?: number; createdBy?: string; userID?: string }) => {
    const code = randomToken()
    const now = Date.now()
    const days = Math.min(Math.max(Math.trunc(input.days ?? INVITATION_DAYS), 1), MAX_INVITATION_DAYS)
    const id = randomToken().slice(0, 16)
    const expiresAt = now + days * DAY
    db.run(
      `INSERT INTO invitation (id, code_hash, role, created_by, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, hashToken(code), input.role, input.createdBy ?? null, input.userID ?? null, now, expiresAt],
    )
    return { id, code, expiresAt }
  }

  return {
    /** Every machine with its owner's login, for administrators. */
    machines: () => queries.machines.all(),
    /** The machines a user owns personally. */
    machinesOf: (user: string) => queries.machinesOf.all(user),
    machine: (id: string) => queries.machine.get(id) ?? undefined,
    machineByTunnelToken: (token: string) => queries.byTunnel.get(hashToken(token)) ?? undefined,
    machineByLlmToken: (token: string) => queries.byLlm.get(hashToken(token)) ?? undefined,
    /**
     * Creates a machine owned by the user who enrolled it, with an id derived from `name`, and returns it with its
     * fresh plaintext tokens.
     */
    createMachine(input: { name: string; owner: string }) {
      const name = input.name
      const tunnelToken = randomToken()
      const llmToken = randomToken()
      const id = db.transaction(() => {
        const machineID = availableID(slug(name), (candidate) => queries.machine.get(candidate) !== null)
        db.run(
          `INSERT INTO machine (id, name, tunnel_token_hash, llm_token_hash, owner_user_id, enrolled_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [machineID, name, hashToken(tunnelToken), hashToken(llmToken), input.owner, input.owner, Date.now()],
        )
        return machineID
      })()
      return { machine: { id, name }, tunnelToken, llmToken }
    },
    deleteMachine: (id: string) => db.run("DELETE FROM machine WHERE id = ?", [id]).changes > 0,
    touchMachine: (id: string) => db.run("UPDATE machine SET last_seen_at = ? WHERE id = ?", [Date.now(), id]),
    /** A user's provider with its sealed secret; only `Providers` reads these. */
    provider: (user: string, id: string) => queries.provider.get(user, id) ?? undefined,
    /** A user's providers, without secrets. */
    providerSummaries: (user: string) => queries.summaries.all(user),
    /** The users who have both a personal machine and a saved provider. */
    usersWithKeysInUse: () => new Set(queries.keysInUse.all().map((row) => row.user_id)),
    /** Inserts or replaces a user's provider; exactly one of `apiKey` and `oauth` is set, both already sealed. */
    saveProvider: (input: {
      user: string
      id: string
      name: string
      baseURL: string
      auth: Auth
      apiKey: string | null
      oauth: string | null
    }) =>
      db.run(
        `INSERT INTO provider (user_id, id, name, base_url, auth, api_key, oauth, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url,
           auth = excluded.auth, api_key = excluded.api_key, oauth = excluded.oauth, updated_at = excluded.updated_at`,
        [
          input.user,
          input.id,
          input.name,
          input.baseURL,
          input.auth,
          input.apiKey,
          input.oauth,
          Date.now(),
          Date.now(),
        ],
      ),
    /** Replaces the sealed credential of an existing OAuth provider, e.g. after a refresh. */
    updateOAuth: (user: string, id: string, oauth: string) =>
      db.run("UPDATE provider SET oauth = ?, updated_at = ? WHERE user_id = ? AND id = ? AND auth = 'chatgpt'", [
        oauth,
        Date.now(),
        user,
        id,
      ]).changes > 0,
    deleteProvider: (user: string, id: string) =>
      db.run("DELETE FROM provider WHERE user_id = ? AND id = ?", [user, id]).changes > 0,
    setting: (key: string) => queries.setting.get(key)?.value,
    setSetting: (key: string, value: string) =>
      db.run("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [
        key,
        value,
      ]),

    users: () => queries.users.all(),
    user: (id: string) => queries.user.get(id) ?? undefined,
    userByLogin: (login: string) => queries.userByLogin.get(login) ?? undefined,
    userCount: () => queries.userCount.get()?.count ?? 0,
    /** Issues a single-use invitation; its plaintext code exists only in the returned value. */
    createInvitation: (input: { role: Role; days?: number; createdBy?: string }) => insertInvitation(input),
    /** The unused, unexpired invitation behind a code; for a reset, only while its account still exists. */
    invitation(code: string) {
      const invitation = queries.invitation.get(hashToken(code), Date.now())
      if (!invitation) return undefined
      if (invitation.user_id !== null && !queries.user.get(invitation.user_id)) return undefined
      return invitation
    },
    invitations: () => queries.invitations.all(Date.now()),
    /** Deletes an invitation that has not been used yet. */
    revokeInvitation: (id: string) =>
      db.run("DELETE FROM invitation WHERE id = ? AND used_at IS NULL", [id]).changes > 0,
    /**
     * Uses an invitation: creates the account, or re-registers the account a reset invitation names, in the same
     * transaction that marks the invitation used.
     */
    register: (input: {
      code: string
      userID: string
      login: string
      record: string
      wrappedKey: string
      keyCheck: string
    }) =>
      db.transaction((): "ok" | "invalid" | "taken" => {
        const now = Date.now()
        const invitation = queries.invitation.get(hashToken(input.code), now)
        if (!invitation) return "invalid"
        if (invitation.user_id !== null) {
          if (invitation.user_id !== input.userID) return "invalid"
          const reset = db.run(
            `UPDATE user SET registration_record = ?, wrapped_key = ?, key_check = ?, updated_at = ?
             WHERE id = ? AND login = ?`,
            [input.record, input.wrappedKey, input.keyCheck, now, input.userID, input.login],
          )
          if (reset.changes === 0) return "invalid"
        }
        if (invitation.user_id === null) {
          const created = db.run(
            `INSERT INTO user (id, login, role, registration_record, wrapped_key, key_check, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
            [input.userID, input.login, invitation.role, input.record, input.wrappedKey, input.keyCheck, now, now],
          )
          if (created.changes === 0) return "taken"
        }
        db.run("UPDATE invitation SET used_at = ? WHERE id = ?", [now, invitation.id])
        adoptMachines()
        return "ok"
      })(),
    /** Replaces the OPAQUE record and the wrapped key after a password change; the user key itself is unchanged. */
    setCredentials: (input: { userID: string; record: string; wrappedKey: string }) =>
      db.run(
        "UPDATE user SET registration_record = ?, wrapped_key = ?, updated_at = ? WHERE id = ? AND disabled_at IS NULL",
        [input.record, input.wrappedKey, Date.now(), input.userID],
      ).changes > 0,
    setDisabled: (id: string, disabled: boolean) =>
      db.transaction((): "ok" | "unknown" | "last-admin" => {
        const user = queries.user.get(id)
        if (!user) return "unknown"
        if (disabled && lastAdmin(user)) return "last-admin"
        db.run("UPDATE user SET disabled_at = ?, updated_at = ? WHERE id = ?", [
          disabled ? (user.disabled_at ?? Date.now()) : null,
          Date.now(),
          id,
        ])
        adoptMachines()
        return "ok"
      })(),
    setRole: (id: string, role: Role) =>
      db.transaction((): "ok" | "unknown" | "last-admin" => {
        const user = queries.user.get(id)
        if (!user) return "unknown"
        if (role !== "admin" && lastAdmin(user)) return "last-admin"
        db.run("UPDATE user SET role = ?, updated_at = ? WHERE id = ?", [role, Date.now(), id])
        adoptMachines()
        return "ok"
      })(),
    /**
     * Forgets the account's password and user key, so the old password stops working at once, and issues the
     * invitation that registers a new one. Data encrypted under the old key can no longer be read.
     */
    resetUser: (id: string, input: { days?: number; createdBy: string }) =>
      db.transaction(() => {
        const user = queries.user.get(id)
        if (!user) return undefined
        db.run(
          "UPDATE user SET registration_record = NULL, wrapped_key = NULL, key_check = NULL, updated_at = ? WHERE id = ?",
          [Date.now(), id],
        )
        // Sealed under the key that was just forgotten: unreadable from now on, so they go too.
        db.run("DELETE FROM provider WHERE user_id = ?", [id])
        // An earlier reset link for this account must not outlive the new one.
        db.run("DELETE FROM invitation WHERE user_id = ? AND used_at IS NULL", [id])
        return insertInvitation({ role: user.role, days: input.days, createdBy: input.createdBy, userID: id })
      })(),
    close: () => db.close(),
  }
}

/** Creates the data directory if needed and keeps it owner-only. */
export function secureDirectory(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
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

/** A 128-bit random identifier, unpadded base64url. */
export function randomID() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url")
}
