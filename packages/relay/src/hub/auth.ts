import { randomToken } from "./store.js"

export * as Auth from "./auth.js"

export const COOKIE = "opencode_hub"

const SESSION_TTL = 30 * 24 * 60 * 60 * 1000
const CODE_TTL = 10 * 60 * 1000
const TICKET_TTL = 60 * 1000
const MAX_DELAY = 5 * 60 * 1000
// Base32 without easily confused characters, so a code can be read aloud or retyped.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

/** In-memory credentials of the single hub user: sessions, enrollment codes, handoff tickets and login throttling. */
export function create() {
  const sessions = new Map<string, number>()
  const codes = new Map<string, number>()
  const tickets = new Map<string, { session: string; machine: string; expires: number }>()
  const failures = new Map<string, { count: number; until: number }>()

  const session = (id: string | undefined) => {
    if (!id) return undefined
    const expires = sessions.get(id)
    if (expires === undefined) return undefined
    if (expires > Date.now()) return id
    sessions.delete(id)
    return undefined
  }

  return {
    createSession() {
      const id = randomToken()
      sessions.set(id, Date.now() + SESSION_TTL)
      return id
    },
    session,
    deleteSession: (id: string) => sessions.delete(id),

    createCode() {
      prune(codes, (expires) => expires)
      const bytes = crypto.getRandomValues(new Uint8Array(8))
      const chars = Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("")
      const code = `${chars.slice(0, 4)}-${chars.slice(4)}`
      const expiresAt = Date.now() + CODE_TTL
      codes.set(code, expiresAt)
      return { code, expiresAt }
    },
    /** Consumes a code once; accepts it case-insensitively and with or without the dash. */
    consumeCode(input: string) {
      const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, "")
      const code = `${compact.slice(0, 4)}-${compact.slice(4)}`
      const expires = codes.get(code)
      codes.delete(code)
      return expires !== undefined && expires > Date.now()
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

    /** Milliseconds the client must still wait before its next login attempt. */
    throttled(client: string) {
      const entry = failures.get(client)
      return entry ? Math.max(0, entry.until - Date.now()) : 0
    },
    fail(client: string) {
      prune(failures, (entry) => entry.until + MAX_DELAY)
      const count = (failures.get(client)?.count ?? 0) + 1
      failures.set(client, { count, until: Date.now() + Math.min(1000 * 2 ** (count - 1), MAX_DELAY) })
    },
    succeed: (client: string) => failures.delete(client),
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
