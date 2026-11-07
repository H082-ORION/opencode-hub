import { randomToken } from "./store.js"

export * as Auth from "./auth.js"

export const COOKIE = "opencode_hub"

const SESSION_TTL = 30 * 24 * 60 * 60 * 1000
const CODE_TTL = 10 * 60 * 1000
// A cloud VM uses its code once it has booted and its pairing command runs, which takes minutes on a busy host.
const CLOUD_CODE_TTL = 30 * 60 * 1000
const TICKET_TTL = 60 * 1000
const ATTEMPT_TTL = 60 * 1000
const REGISTRATION_TTL = 10 * 60 * 1000
const MAX_DELAY = 5 * 60 * 1000
const ACCOUNT_FAILURES = 5
const ACCOUNT_LOCK = 15 * 60 * 1000
// Base32 without easily confused characters, so a code can be read aloud or retyped.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

/** Server state of an OPAQUE sign-in between `start` and `finish`; `user` is absent for an unknown login. */
export type Attempt = { kind: "login" | "password"; user?: string; login: string; state: string }

/**
 * Whom an enrollment code was issued by and what it enrolls: a machine (of the organization `org`, if any, or the
 * VM of the cloud instance `cloud`), or a cloud host. A code of one kind never enrolls the other.
 */
export type Code = { user: string; kind: "machine" | "host"; org?: string; cloud?: string }

/** A registration between `register/start` and `register/finish`, keyed by the invitation's code hash. */
export type Registration = { login: string; user: string }

/**
 * In-memory credentials: user sessions, unlocked user keys, OPAQUE attempts, enrollment codes, handoff tickets and
 * sign-in throttling. A restart signs everyone out and locks every key.
 */
export function create() {
  const sessions = new Map<string, { user: string; expires: number }>()
  const keys = new Map<string, string>()
  const attempts = new Map<string, Attempt & { expires: number }>()
  const registrations = new Map<string, Registration & { expires: number }>()
  const codes = new Map<string, Code & { expires: number }>()
  const tickets = new Map<string, { session: string; machine: string; expires: number }>()
  const failures = new Map<string, { count: number; until: number }>()
  const accounts = new Map<string, { count: number; until: number; last: number }>()

  const issueCode = (entry: Code, ttl: number) => {
    prune(codes, (code) => code.expires)
    const bytes = crypto.getRandomValues(new Uint8Array(8))
    const chars = Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("")
    const code = `${chars.slice(0, 4)}-${chars.slice(4)}`
    const expiresAt = Date.now() + ttl
    codes.set(code, { ...entry, expires: expiresAt })
    return { code, expiresAt }
  }

  const session = (id: string | undefined) => {
    if (!id) return undefined
    const entry = sessions.get(id)
    if (!entry) return undefined
    if (entry.expires > Date.now()) return { id, user: entry.user }
    sessions.delete(id)
    return undefined
  }

  return {
    createSession(user: string) {
      prune(sessions, (entry) => entry.expires)
      const id = randomToken()
      sessions.set(id, { user, expires: Date.now() + SESSION_TTL })
      return id
    },
    /** The session behind a cookie value; the caller still checks that its user is active. */
    session,
    deleteSession: (id: string) => sessions.delete(id),
    /** Closes every session of a user and returns their ids. */
    deleteUserSessions(user: string) {
      const ids = Array.from(sessions).flatMap(([id, entry]) => (entry.user === user ? [id] : []))
      ids.forEach((id) => sessions.delete(id))
      return ids
    },

    /** Keeps a user's key in memory until the hub stops, the user locks it or the account is disabled or reset. */
    unlock: (user: string, key: string) => keys.set(user, key),
    lock: (user: string) => keys.delete(user),
    unlocked: (user: string) => keys.has(user),
    /** The unlocked key of a user, to seal or open their secrets; never logged or sent anywhere. */
    key: (user: string) => keys.get(user),

    createAttempt(attempt: Attempt) {
      prune(attempts, (entry) => entry.expires)
      const id = randomToken()
      attempts.set(id, { ...attempt, expires: Date.now() + ATTEMPT_TTL })
      return id
    },
    /** Takes an attempt once; an expired or unknown one is undefined. */
    consumeAttempt(id: string) {
      const entry = attempts.get(id)
      attempts.delete(id)
      if (!entry || entry.expires <= Date.now()) return undefined
      return entry
    },

    startRegistration(key: string, registration: Registration) {
      prune(registrations, (entry) => entry.expires)
      registrations.set(key, { ...registration, expires: Date.now() + REGISTRATION_TTL })
    },
    registration(key: string) {
      const entry = registrations.get(key)
      if (!entry || entry.expires <= Date.now()) return undefined
      return entry
    },
    finishRegistration: (key: string) => registrations.delete(key),

    /** Issues an enrollment code by `user`, for a machine of their own or of the organization `org`. */
    createCode: (user: string, org?: string) => issueCode({ user, kind: "machine", org }, CODE_TTL),
    /** Issues an enrollment code by an administrator, for a cloud host. */
    createHostCode: (user: string) => issueCode({ user, kind: "host" }, CODE_TTL),
    /** Issues the code the VM of a cloud instance pairs with, as a machine of the instance's user. */
    createCloudCode: (user: string, cloud: string) => issueCode({ user, kind: "machine", cloud }, CLOUD_CODE_TTL),
    /**
     * Consumes a code once and returns whom it was issued by and for; accepts it case-insensitively and with or
     * without the dash. The caller still checks that the user is active and, for an organization, still a member.
     */
    consumeCode(input: string) {
      const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, "")
      const code = `${compact.slice(0, 4)}-${compact.slice(4)}`
      const entry = codes.get(code)
      codes.delete(code)
      if (!entry || entry.expires <= Date.now()) return undefined
      return { user: entry.user, kind: entry.kind, org: entry.org, cloud: entry.cloud } satisfies Code
    },

    createTicket(session: string, machine: string) {
      prune(tickets, (ticket) => ticket.expires)
      const ticket = randomToken()
      tickets.set(ticket, { session, machine, expires: Date.now() + TICKET_TTL })
      return ticket
    },
    /** Returns the session carried by a one-time ticket issued for this machine. */
    consumeTicket(ticket: string, machine: string) {
      const entry = tickets.get(ticket)
      tickets.delete(ticket)
      if (!entry || entry.expires <= Date.now() || entry.machine !== machine) return undefined
      return session(entry.session)
    },

    /** Milliseconds the client address must still wait before its next attempt. */
    throttled(client: string) {
      const entry = failures.get(client)
      return entry ? Math.max(0, entry.until - Date.now()) : 0
    },
    /** Exponential delay per client address: 1 s after the first failure, doubling up to 5 minutes. */
    fail(client: string) {
      prune(failures, (entry) => entry.until + MAX_DELAY)
      const count = (failures.get(client)?.count ?? 0) + 1
      failures.set(client, { count, until: Date.now() + Math.min(1000 * 2 ** (count - 1), MAX_DELAY) })
    },
    succeed: (client: string) => failures.delete(client),

    /** Milliseconds a login must still wait; counted the same way whether the account exists or not. */
    accountThrottled(login: string) {
      const entry = accounts.get(login)
      return entry ? Math.max(0, entry.until - Date.now()) : 0
    },
    /** Five consecutive failures lock a login for 15 minutes; the count is forgotten 15 minutes after the last one. */
    accountFail(login: string) {
      prune(accounts, (entry) => Math.max(entry.until, entry.last + ACCOUNT_LOCK))
      const now = Date.now()
      const count = (accounts.get(login)?.count ?? 0) + 1
      const locked = count >= ACCOUNT_FAILURES
      accounts.set(login, { count: locked ? 0 : count, until: locked ? now + ACCOUNT_LOCK : 0, last: now })
    },
    accountSucceed: (login: string) => accounts.delete(login),
  }
}

export type Instance = ReturnType<typeof create>

function prune<T>(map: Map<string, T>, expiry: (value: T) => number) {
  const now = Date.now()
  for (const [key, value] of map) if (expiry(value) <= now) map.delete(key)
}

export function readCookie(header: string | null) {
  if (!header) return undefined
  const prefix = `${COOKIE}=`
  return header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length)
}

/** The cookie header without the hub's own session cookie, or undefined when nothing else is left. */
export function stripCookie(header: string | null) {
  if (!header) return undefined
  const rest = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${COOKIE}=`))
  return rest.length ? rest.join("; ") : undefined
}

export function sessionCookie(value: string, secure: boolean) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure ? "; Secure" : ""}`
}

export function clearCookie(secure: boolean) {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`
}
