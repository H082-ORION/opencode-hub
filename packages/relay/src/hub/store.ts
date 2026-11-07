import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs"
import path from "node:path"

export * as Store from "./store.js"

/**
 * A machine belongs to exactly one owner: a user (`owner_user_id`) or an organization (`owner_org_id`). The code keeps
 * that invariant, and a row that breaks it opens for nobody; a machine enrolled before owners existed has neither
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

/** A machine as the administration lists it, with its owner's login or organization name. */
export type MachineSummary = Machine & { owner_login: string | null; org_name: string | null }

/** A machine a user may open, with the name of its organization (null for a personal machine). */
export type VisibleMachine = Machine & { org_name: string | null }

/**
 * One user's opencode instance on one machine. `token_hash` is the SHA-256 of its LLM token, null until the hub first
 * sends the instance to the machine's agent.
 */
export type InstanceRow = {
  id: string
  machine_id: string
  user_id: string
  token_hash: string | null
  created_at: number
  token_issued_at: number | null
}

export type Org = { id: string; name: string; created_at: number }

/** An organization as administrators list it, with how many machines it owns. */
export type OrgSummary = Org & { machines: number }

export type Member = { org_id: string; user_id: string; login: string; created_at: number }

/** Who a skill belongs to: a user's own skill, or one every member of an organization inherits. */
export type SkillOwner = { kind: "user" | "org"; id: string }

/** A skill as stored: its files are JSON `[{ path, content }]`, in clear (skills hold no secret). */
export type SkillRow = {
  id: string
  owner_kind: "user" | "org"
  owner_id: string
  name: string
  description: string
  files: string
  created_at: number
  updated_at: number
}

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

const MAX_ORG_NAME = 64
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
  const machineTable = `(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tunnel_token_hash TEXT NOT NULL UNIQUE,
    owner_user_id TEXT,
    owner_org_id TEXT,
    enrolled_by TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER
  )`
  db.run(`CREATE TABLE IF NOT EXISTS machine ${machineTable}`)
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
  // Protocol 1 gave each machine one LLM token; instances now have their own. SQLite cannot drop a UNIQUE column, so
  // the table is rebuilt without it.
  if (ownerColumns.has("llm_token_hash"))
    db.transaction(() => {
      db.run(`CREATE TABLE machine_next ${machineTable}`)
      db.run(
        `INSERT INTO machine_next (id, name, tunnel_token_hash, owner_user_id, owner_org_id, enrolled_by, created_at,
           last_seen_at)
         SELECT id, name, tunnel_token_hash, owner_user_id, owner_org_id, enrolled_by, created_at, last_seen_at
         FROM machine`,
      )
      db.run("DROP TABLE machine")
      db.run("ALTER TABLE machine_next RENAME TO machine")
    })()
  // One opencode instance per (machine, user who opened it). Its LLM token is issued when the hub sends it to the
  // agent, so it stays null until then.
  db.run(`CREATE TABLE IF NOT EXISTS instance (
    id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    token_hash TEXT UNIQUE,
    created_at INTEGER NOT NULL,
    token_issued_at INTEGER,
    UNIQUE (machine_id, user_id)
  )`)
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
  // Organization names compare case-insensitively, so "Acme" and "acme" cannot both exist.
  db.run(`CREATE TABLE IF NOT EXISTS org (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at INTEGER NOT NULL
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS membership (
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, user_id)
  )`)
  // Skills of a user or of an organization (specs/multi-users.md, "Skills"); names are unique per owner.
  db.run(`CREATE TABLE IF NOT EXISTS skill (
    id TEXT PRIMARY KEY,
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('user', 'org')),
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    files TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (owner_kind, owner_id, name)
  )`)
  // The organizations a new account joins when its invitation is used.
  db.run(`CREATE TABLE IF NOT EXISTS invitation_org (
    invitation_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    PRIMARY KEY (invitation_id, org_id)
  )`)

  const machineColumns = "id, name, owner_user_id, owner_org_id, enrolled_by, created_at, last_seen_at"
  const queries = {
    machines: db.query<MachineSummary, []>(
      `SELECT machine.id, machine.name, machine.owner_user_id, machine.owner_org_id, machine.enrolled_by,
         machine.created_at, machine.last_seen_at, user.login AS owner_login, org.name AS org_name
       FROM machine LEFT JOIN user ON user.id = machine.owner_user_id LEFT JOIN org ON org.id = machine.owner_org_id
       ORDER BY machine.created_at`,
    ),
    /**
     * A user's personal machines, then those of the organizations they belong to, grouped by organization name. The
     * same conditions as `canOpen`: an organization machine never has a user owner as well.
     */
    machinesFor: db.query<VisibleMachine, [string, string]>(
      `SELECT machine.id, machine.name, machine.owner_user_id, machine.owner_org_id, machine.enrolled_by,
         machine.created_at, machine.last_seen_at, org.name AS org_name
       FROM machine LEFT JOIN org ON org.id = machine.owner_org_id
       WHERE (machine.owner_org_id IS NULL AND machine.owner_user_id = ?)
         OR (machine.owner_user_id IS NULL AND org.id IN (SELECT org_id FROM membership WHERE user_id = ?))
       ORDER BY org.name IS NOT NULL, org.name COLLATE NOCASE, machine.created_at`,
    ),
    machine: db.query<Machine, [string]>(`SELECT ${machineColumns} FROM machine WHERE id = ?`),
    byTunnel: db.query<Machine, [string]>(`SELECT ${machineColumns} FROM machine WHERE tunnel_token_hash = ?`),
    instance: db.query<InstanceRow, [string, string]>("SELECT * FROM instance WHERE machine_id = ? AND user_id = ?"),
    instanceByToken: db.query<InstanceRow, [string]>("SELECT * FROM instance WHERE token_hash = ?"),
    instancesOf: db.query<InstanceRow, [string]>("SELECT * FROM instance WHERE machine_id = ? ORDER BY created_at"),
    provider: db.query<ProviderRow, [string, string]>("SELECT * FROM provider WHERE user_id = ? AND id = ?"),
    summaries: db.query<ProviderSummary, [string]>(
      "SELECT id, name, base_url, auth FROM provider WHERE user_id = ? ORDER BY id",
    ),
    /** Users whose instances rely on providers they saved, i.e. need their key in memory. */
    keysInUse: db.query<{ user_id: string }, []>(
      "SELECT DISTINCT provider.user_id FROM provider JOIN instance ON instance.user_id = provider.user_id",
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
    orgs: db.query<OrgSummary, []>(
      `SELECT org.id, org.name, org.created_at,
         (SELECT count(*) FROM machine WHERE machine.owner_org_id = org.id) AS machines
       FROM org ORDER BY org.name COLLATE NOCASE`,
    ),
    org: db.query<Org, [string]>("SELECT id, name, created_at FROM org WHERE id = ?"),
    orgByName: db.query<Org, [string]>("SELECT id, name, created_at FROM org WHERE name = ?"),
    members: db.query<Member, []>(
      `SELECT membership.org_id, membership.user_id, user.login, membership.created_at
       FROM membership JOIN user ON user.id = membership.user_id ORDER BY user.login`,
    ),
    membershipsOf: db.query<Org, [string]>(
      `SELECT org.id, org.name, org.created_at FROM org JOIN membership ON membership.org_id = org.id
       WHERE membership.user_id = ? ORDER BY org.name COLLATE NOCASE`,
    ),
    member: db.query<{ found: number }, [string, string]>(
      "SELECT 1 AS found FROM membership WHERE org_id = ? AND user_id = ?",
    ),
    invitationOrgs: db.query<{ invitation_id: string; name: string }, []>(
      `SELECT invitation_org.invitation_id, org.name FROM invitation_org JOIN org ON org.id = invitation_org.org_id
       ORDER BY org.name COLLATE NOCASE`,
    ),
    skills: db.query<SkillRow, [string, string]>(
      "SELECT * FROM skill WHERE owner_kind = ? AND owner_id = ? ORDER BY name",
    ),
    skill: db.query<SkillRow, [string]>("SELECT * FROM skill WHERE id = ?"),
    skillCount: db.query<{ count: number }, [string, string]>(
      "SELECT count(*) AS count FROM skill WHERE owner_kind = ? AND owner_id = ?",
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

  const insertInvitation = (input: {
    role: Role
    days?: number
    createdBy?: string
    userID?: string
    orgs?: readonly string[]
  }) => {
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
    new Set(input.orgs ?? []).forEach((org) =>
      db.run("INSERT INTO invitation_org (invitation_id, org_id) VALUES (?, ?)", [id, org]),
    )
    return { id, code, expiresAt }
  }

  return {
    /** Every machine with its owner's login, for administrators. */
    machines: () => queries.machines.all(),
    /** The machines a user may open: their own, then their organizations'. */
    machinesFor: (user: string) => queries.machinesFor.all(user, user),
    machine: (id: string) => queries.machine.get(id) ?? undefined,
    machineByTunnelToken: (token: string) => queries.byTunnel.get(hashToken(token)) ?? undefined,
    /**
     * Creates a machine with an id derived from `name`, owned by the user who enrolled it or by an organization, and
     * returns it with its fresh plaintext tunnel token.
     */
    createMachine(input: { name: string; enrolledBy: string; org?: string }) {
      const name = input.name
      const tunnelToken = randomToken()
      const id = db.transaction(() => {
        const machineID = availableID(slug(name), (candidate) => queries.machine.get(candidate) !== null)
        db.run(
          `INSERT INTO machine (id, name, tunnel_token_hash, owner_user_id, owner_org_id, enrolled_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            machineID,
            name,
            hashToken(tunnelToken),
            input.org === undefined ? input.enrolledBy : null,
            input.org ?? null,
            input.enrolledBy,
            Date.now(),
          ],
        )
        return machineID
      })()
      return { machine: { id, name }, tunnelToken }
    },
    /** Deletes a machine with its instances, whose tokens stop working with them. */
    deleteMachine: (id: string) =>
      db.transaction(() => {
        db.run("DELETE FROM instance WHERE machine_id = ?", [id])
        return db.run("DELETE FROM machine WHERE id = ?", [id]).changes > 0
      })(),
    /** A user's instance on a machine, if it has one. */
    instance: (machine: string, user: string) => queries.instance.get(machine, user) ?? undefined,
    /** Creates the user's instance on a machine unless it exists, and returns it. */
    ensureInstance(machine: string, user: string) {
      db.run("INSERT OR IGNORE INTO instance (id, machine_id, user_id, created_at) VALUES (?, ?, ?, ?)", [
        randomID(),
        machine,
        user,
        Date.now(),
      ])
      return queries.instance.get(machine, user)!
    },
    instanceByToken: (token: string) => queries.instanceByToken.get(hashToken(token)) ?? undefined,
    instancesOf: (machine: string) => queries.instancesOf.all(machine),
    /** Issues a new token for an instance, replacing the previous one; the plaintext exists only in the result. */
    issueInstanceToken(id: string) {
      const token = randomToken()
      db.run("UPDATE instance SET token_hash = ?, token_issued_at = ? WHERE id = ?", [hashToken(token), Date.now(), id])
      return token
    },
    /**
     * Deletes every instance whose user may no longer open its machine: account disabled, reset or gone, machine gone,
     * no longer its personal owner or a member of its organization (the same rules as opening the machine). Returns
     * what was deleted, so the agents can be told.
     */
    pruneInstances: () =>
      db
        .query<{ id: string; machine_id: string }, []>(
          `DELETE FROM instance WHERE NOT EXISTS (
             SELECT 1 FROM machine JOIN user ON user.id = instance.user_id
             WHERE machine.id = instance.machine_id AND user.disabled_at IS NULL
               AND user.registration_record IS NOT NULL
               AND ((machine.owner_org_id IS NULL AND machine.owner_user_id = instance.user_id)
                 OR (machine.owner_user_id IS NULL AND machine.owner_org_id IS NOT NULL AND EXISTS (
                   SELECT 1 FROM membership
                   WHERE membership.org_id = machine.owner_org_id AND membership.user_id = instance.user_id)))
           ) RETURNING id, machine_id`,
        )
        .all(),
    touchMachine: (id: string) => db.run("UPDATE machine SET last_seen_at = ? WHERE id = ?", [Date.now(), id]),
    /** A user's provider with its sealed secret; only `Providers` reads these. */
    provider: (user: string, id: string) => queries.provider.get(user, id) ?? undefined,
    /** A user's providers, without secrets. */
    providerSummaries: (user: string) => queries.summaries.all(user),
    /** The users who have both an instance and a saved provider. */
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
    /**
     * Issues a single-use invitation, which may name organizations for the new account to join; its plaintext code
     * exists only in the returned value.
     */
    createInvitation: (input: { role: Role; days?: number; createdBy?: string; orgs?: readonly string[] }) =>
      db.transaction(() => insertInvitation(input))(),
    /** The names of the organizations each pending invitation joins, by invitation id. */
    invitationOrgs() {
      const names = new Map<string, string[]>()
      queries.invitationOrgs
        .all()
        .forEach((row) => names.set(row.invitation_id, [...(names.get(row.invitation_id) ?? []), row.name]))
      return names
    },
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
      db.transaction(() => {
        const deleted = db.run("DELETE FROM invitation WHERE id = ? AND used_at IS NULL", [id]).changes > 0
        if (deleted) db.run("DELETE FROM invitation_org WHERE invitation_id = ?", [id])
        return deleted
      })(),
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
          // The organizations the invitation names, as far as they still exist, in the same transaction.
          db.run(
            `INSERT OR IGNORE INTO membership (org_id, user_id, created_at)
             SELECT invitation_org.org_id, ?, ? FROM invitation_org JOIN org ON org.id = invitation_org.org_id
             WHERE invitation_org.invitation_id = ?`,
            [input.userID, now, invitation.id],
          )
        }
        db.run("DELETE FROM invitation_org WHERE invitation_id = ?", [invitation.id])
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
        db.run("DELETE FROM invitation_org WHERE invitation_id NOT IN (SELECT id FROM invitation)")
        return insertInvitation({ role: user.role, days: input.days, createdBy: input.createdBy, userID: id })
      })(),

    /** Every organization with its machine count, by name. */
    orgs: () => queries.orgs.all(),
    org: (id: string) => queries.org.get(id) ?? undefined,
    /** An organization by name, compared case-insensitively. */
    orgByName: (name: string) => queries.orgByName.get(name) ?? undefined,
    /** Every membership with the member's login, for administrators. */
    members: () => queries.members.all(),
    /** The organizations a user belongs to, by name. */
    membershipsOf: (user: string) => queries.membershipsOf.all(user),
    isMember: (org: string, user: string) => queries.member.get(org, user) !== null,
    /** Creates an organization; undefined when the name is already taken. */
    createOrg(name: string) {
      const org = { id: randomID(), name, created_at: Date.now() }
      const created = db.run("INSERT INTO org (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", [
        org.id,
        org.name,
        org.created_at,
      ])
      return created.changes > 0 ? org : undefined
    },
    renameOrg: (id: string, name: string) =>
      db.transaction((): "ok" | "unknown" | "taken" => {
        if (!queries.org.get(id)) return "unknown"
        const other = queries.orgByName.get(name)
        if (other && other.id !== id) return "taken"
        db.run("UPDATE org SET name = ? WHERE id = ?", [name, id])
        return "ok"
      })(),
    /** Deletes an organization with its memberships; refused while it still owns machines. */
    deleteOrg: (id: string) =>
      db.transaction((): "ok" | "unknown" | "has-machines" => {
        if (!queries.org.get(id)) return "unknown"
        if (db.query("SELECT 1 FROM machine WHERE owner_org_id = ?").get(id)) return "has-machines"
        db.run("DELETE FROM membership WHERE org_id = ?", [id])
        db.run("DELETE FROM invitation_org WHERE org_id = ?", [id])
        db.run("DELETE FROM skill WHERE owner_kind = 'org' AND owner_id = ?", [id])
        db.run("DELETE FROM org WHERE id = ?", [id])
        return "ok"
      })(),
    addMember: (org: string, user: string) =>
      db.transaction((): "ok" | "unknown-org" | "unknown-user" => {
        if (!queries.org.get(org)) return "unknown-org"
        if (!queries.user.get(user)) return "unknown-user"
        db.run("INSERT OR IGNORE INTO membership (org_id, user_id, created_at) VALUES (?, ?, ?)", [
          org,
          user,
          Date.now(),
        ])
        return "ok"
      })(),
    removeMember: (org: string, user: string) =>
      db.run("DELETE FROM membership WHERE org_id = ? AND user_id = ?", [org, user]).changes > 0,

    /** The skills of one owner, by name. */
    skills: (owner: SkillOwner) => queries.skills.all(owner.kind, owner.id),
    skill: (id: string) => queries.skill.get(id) ?? undefined,
    /**
     * Creates a skill (no `id`) or replaces one of the same owner (`id`), already checked. Refused when another skill
     * of the owner has the name, when the owner already has `limit` skills, or when `id` names no skill of the owner.
     */
    saveSkill: (input: {
      owner: SkillOwner
      id?: string
      name: string
      description: string
      files: readonly { path: string; content: string }[]
      limit: number
    }) =>
      db.transaction((): { status: "ok"; id: string } | { status: "taken" | "limit" | "unknown" } => {
        const now = Date.now()
        const owner = input.owner
        const files = JSON.stringify(input.files)
        const other = db
          .query<
            { id: string },
            [string, string, string]
          >("SELECT id FROM skill WHERE owner_kind = ? AND owner_id = ? AND name = ?")
          .get(owner.kind, owner.id, input.name)
        if (other && other.id !== input.id) return { status: "taken" }
        if (input.id !== undefined) {
          const updated = db.run(
            `UPDATE skill SET name = ?, description = ?, files = ?, updated_at = ?
             WHERE id = ? AND owner_kind = ? AND owner_id = ?`,
            [input.name, input.description, files, now, input.id, owner.kind, owner.id],
          )
          return updated.changes > 0 ? { status: "ok", id: input.id } : { status: "unknown" }
        }
        if ((queries.skillCount.get(owner.kind, owner.id)?.count ?? 0) >= input.limit) return { status: "limit" }
        const id = randomID()
        db.run(
          `INSERT INTO skill (id, owner_kind, owner_id, name, description, files, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, owner.kind, owner.id, input.name, input.description, files, now, now],
        )
        return { status: "ok", id }
      })(),
    /** Deletes a skill of this owner only. */
    deleteSkill: (owner: SkillOwner, id: string) =>
      db.run("DELETE FROM skill WHERE id = ? AND owner_kind = ? AND owner_id = ?", [id, owner.kind, owner.id]).changes >
      0,
    close: () => db.close(),
  }
}

/** An organization name: trimmed, 1 to 64 characters, no control characters; undefined otherwise. */
export function orgName(input: string) {
  const name = input.normalize("NFKC").trim().replace(/\s+/g, " ")
  if (!name || name.length > MAX_ORG_NAME || /\p{Cc}/u.test(name)) return undefined
  return name
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
