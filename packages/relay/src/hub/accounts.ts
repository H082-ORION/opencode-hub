import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { ready, server } from "@serenity-kit/opaque"
import { Option, Schema } from "effect"
import { Account } from "../account.js"
import { Auth } from "./auth.js"
import { Store } from "./store.js"

export * as Accounts from "./accounts.js"

/** The OPAQUE server key, kept out of `hub.db` so that a copy of the database alone allows no offline guessing. */
const SETUP_FILE = "opaque-server-setup"
const MAX_MESSAGE = 4096
const ROLE = Schema.Literals(["admin", "user"])

const decodeInvite = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ invite: Schema.String })))
const decodeRegisterStart = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ invite: Schema.String, login: Schema.String, registrationRequest: Schema.String }),
  ),
)
const decodeRegisterFinish = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      invite: Schema.String,
      login: Schema.String,
      registrationRecord: Schema.String,
      userKey: Schema.Struct({ wrapped: Schema.String, check: Schema.String, key: Schema.String }),
    }),
  ),
)
const decodeLoginStart = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ login: Schema.String, startLoginRequest: Schema.String })),
)
const decodeLoginFinish = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      attempt: Schema.String,
      finishLoginRequest: Schema.String,
      userKey: Schema.String,
      next: Schema.optional(Schema.String),
    }),
  ),
)
const decodePasswordStart = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ startLoginRequest: Schema.String, registrationRequest: Schema.String })),
)
const decodePasswordFinish = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      attempt: Schema.String,
      finishLoginRequest: Schema.String,
      registrationRecord: Schema.String,
      userKey: Schema.Struct({ wrapped: Schema.String, check: Schema.String }),
    }),
  ),
)
const decodeInvitation = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ role: ROLE, days: Schema.optional(Schema.Number) })),
)
const decodeReset = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ days: Schema.optional(Schema.Number) })),
)
const decodeRole = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ role: ROLE })))

/** Reads the OPAQUE server setup from the data directory, creating it (mode 0600) on the first start. */
export async function loadServerSetup(data: string) {
  await ready
  Store.secureDirectory(data)
  const file = path.join(data, SETUP_FILE)
  if (!existsSync(file)) writeFileSync(file, server.createSetup(), { mode: 0o600, flag: "wx" })
  chmodSync(file, 0o600)
  const setup = readFileSync(file, "utf8").trim()
  // Throws on a damaged file, so the hub refuses to start rather than refusing every sign-in.
  server.getPublicKey(setup)
  return setup
}

export type Current = { session: string; user: Store.User }

export function create(input: {
  store: Store.Instance
  auth: Auth.Instance
  setup: string
  origin: string
  secure: boolean
  /** Called with the ids of sessions that were just closed, so whatever they hold open closes too. */
  closed: (sessions: string[]) => void
  /** Called after an administrator reset a user, whose providers are gone with their key. */
  reset: (user: string) => void
}) {
  const store = input.store
  const auth = input.auth
  const setup = input.setup
  // Answers for unknown logins are derived from this key, so they stay the same from one attempt to the next.
  const dummyKey = createHash("sha256").update(`opencode-hub/v1/dummy|${setup}`).digest()

  /** The user, only while the account exists, is enabled and has a password (a reset one has none yet). */
  const activeUser = (id: string | undefined) => {
    const user = id ? store.user(id) : undefined
    if (!user || user.disabled_at !== null || user.registration_record === null) return undefined
    return user
  }

  /** The session's user, only while the account is active: anything else is no session. */
  const active = (entry: { id: string; user: string } | undefined): Current | undefined => {
    const user = activeUser(entry?.user)
    if (!entry || !user) return undefined
    return { session: entry.id, user }
  }

  const current = (request: Request) => active(auth.session(Auth.readCookie(request.headers.get("cookie"))))

  return {
    current,
    /** The active user behind a session id, e.g. one carried by a handoff ticket. */
    active,
    activeUser,
    /** Issues an invitation without an author, as `opencode hub invite` and the first start do. */
    invite: (role: Store.Role) => withURL(store.createInvitation({ role })),
    /** Handles the account and administration routes under `/hub/api/`; undefined for any other route. */
    async handle(request: Request, route: string, client: string) {
      const method = request.method
      if (method === "POST" && route === "register/invite") return registerInvite(request, client)
      if (method === "POST" && route === "register/start") return registerStart(request, client)
      if (method === "POST" && route === "register/finish") return registerFinish(request, client)
      if (method === "POST" && route === "login/start") return loginStart(request, client)
      if (method === "POST" && route === "login/finish") return loginFinish(request, client)
      const user = current(request)
      if (route === "session" && method === "GET")
        return user
          ? json(200, {
              authenticated: true,
              user: { id: user.user.id, login: user.user.login, role: user.user.role },
              unlocked: auth.unlocked(user.user.id),
            })
          : json(401, { authenticated: false })
      if (!isAccountRoute(route)) return undefined
      if (!user) return json(401, { error: "Sign in to the hub first." })
      if (route === "logout" && method === "POST") {
        auth.deleteSession(user.session)
        input.closed([user.session])
        return json(200, {}, Auth.clearCookie(input.secure))
      }
      if (route === "account/lock" && method === "POST") {
        auth.lock(user.user.id)
        return json(200, { unlocked: false })
      }
      if (route === "account/password/start" && method === "POST") return passwordStart(request, client, user)
      if (route === "account/password/finish" && method === "POST") return passwordFinish(request, client, user)
      if (user.user.role !== "admin") return json(403, { error: "Only hub administrators can do this." })
      return admin(request, route, user)
    },
  }

  async function registerInvite(request: Request, client: string) {
    const wait = auth.throttled(client)
    if (wait > 0) return tooMany(wait)
    const body = Option.getOrUndefined(decodeInvite(await request.text()))
    const invitation = body ? store.invitation(body.invite) : undefined
    if (!invitation) return invalidInvitation(client)
    const target = invitation.user_id ? store.user(invitation.user_id) : undefined
    return json(200, { role: invitation.role, login: target?.login ?? null })
  }

  async function registerStart(request: Request, client: string) {
    const wait = auth.throttled(client)
    if (wait > 0) return tooMany(wait)
    const body = Option.getOrUndefined(decodeRegisterStart(await request.text()))
    const invitation = body ? store.invitation(body.invite) : undefined
    if (!body || !invitation) return invalidInvitation(client)
    // A reset invitation re-registers its account under the same login and id.
    const target = invitation.user_id ? store.user(invitation.user_id) : undefined
    const login = target?.login ?? Account.normalizeLogin(body.login)
    if (!login)
      return json(400, { error: "A login has 3 to 32 lowercase letters, digits, dots, dashes or underscores." })
    if (!target && store.userByLogin(login)) return json(409, { error: "This login is already taken." })
    const userID = target?.id ?? Store.randomID()
    const response = attempt(() =>
      server.createRegistrationResponse({
        serverSetup: setup,
        userIdentifier: userID,
        registrationRequest: message(body.registrationRequest),
      }),
    )
    if (!response) return json(400, { error: "Malformed registration request." })
    auth.startRegistration(Store.hashToken(body.invite), { login, user: userID })
    return json(200, { registrationResponse: response.registrationResponse, userID, login })
  }

  async function registerFinish(request: Request, client: string) {
    const wait = auth.throttled(client)
    if (wait > 0) return tooMany(wait)
    const body = Option.getOrUndefined(decodeRegisterFinish(await request.text()))
    const key = body ? Store.hashToken(body.invite) : ""
    const pending = body ? auth.registration(key) : undefined
    if (!body || !pending || pending.login !== body.login) return invalidInvitation(client)
    const userKey = body.userKey
    if (!validWrapped(userKey.wrapped) || !(await sameCheck(userKey.key, userKey.check)))
      return json(400, { error: "Malformed user key." })
    if (!validMessage(body.registrationRecord)) return json(400, { error: "Malformed registration record." })
    const result = store.register({
      code: body.invite,
      userID: pending.user,
      login: pending.login,
      record: body.registrationRecord,
      wrappedKey: userKey.wrapped,
      keyCheck: userKey.check,
    })
    if (result === "taken") return json(409, { error: "This login is already taken." })
    if (result === "invalid") return invalidInvitation(client)
    auth.finishRegistration(key)
    auth.succeed(client)
    auth.unlock(pending.user, userKey.key)
    return json(200, { redirect: "/" }, Auth.sessionCookie(auth.createSession(pending.user), input.secure))
  }

  async function loginStart(request: Request, client: string) {
    const body = Option.getOrUndefined(decodeLoginStart(await request.text()))
    if (!body) return json(400, { error: "Expected { login, startLoginRequest }." })
    // A login that cannot exist is still answered like an unknown one, under its own throttle.
    const login = Account.normalizeLogin(body.login) ?? body.login.normalize("NFKC").toLowerCase().trim().slice(0, 64)
    const wait = Math.max(auth.throttled(client), auth.accountThrottled(login))
    if (wait > 0) return tooMany(wait)
    const user = store.userByLogin(login)
    const real = user && user.disabled_at === null && user.registration_record && user.wrapped_key ? user : undefined
    const userID = real?.id ?? Account.encode(dummy(`user-id|${login}`, 16))
    // Without a record the library answers with a fake one derived from the server setup and the identifier, which
    // a client cannot tell from a real account's.
    const started = attempt(() =>
      server.startLogin({
        serverSetup: setup,
        registrationRecord: real?.registration_record,
        startLoginRequest: message(body.startLoginRequest),
        userIdentifier: userID,
      }),
    )
    if (!started) return json(400, { error: "Malformed sign-in request." })
    // Counted as a failure until `login/finish` succeeds: a wrong password fails in the browser, which then never
    // calls it.
    auth.fail(client)
    auth.accountFail(login)
    return json(200, {
      attempt: auth.createAttempt({ kind: "login", user: real?.id, login, state: started.serverLoginState }),
      loginResponse: started.loginResponse,
      userID,
      wrappedUserKey: real?.wrapped_key ?? dummyWrapped(login),
    })
  }

  async function loginFinish(request: Request, client: string) {
    const body = Option.getOrUndefined(decodeLoginFinish(await request.text()))
    const entry = body ? auth.consumeAttempt(body.attempt) : undefined
    if (!body || !entry || entry.kind !== "login" || !entry.user) return signInFailed()
    const finished = attempt(() =>
      server.finishLogin({ serverLoginState: entry.state, finishLoginRequest: message(body.finishLoginRequest) }),
    )
    const user = store.user(entry.user)
    if (!finished || !user || user.disabled_at !== null || !(await sameCheck(body.userKey, user.key_check)))
      return signInFailed()
    auth.succeed(client)
    auth.accountSucceed(entry.login)
    auth.unlock(user.id, body.userKey)
    const next = body.next ?? ""
    return json(
      200,
      { redirect: next ? `/hub/handoff?next=${encodeURIComponent(next)}` : "/" },
      Auth.sessionCookie(auth.createSession(user.id), input.secure),
    )
  }

  async function passwordStart(request: Request, client: string, current: Current) {
    const user = current.user
    const wait = Math.max(auth.throttled(client), auth.accountThrottled(user.login))
    if (wait > 0) return tooMany(wait)
    const body = Option.getOrUndefined(decodePasswordStart(await request.text()))
    if (!body || !user.wrapped_key) return json(400, { error: "Expected { startLoginRequest, registrationRequest }." })
    const started = attempt(() =>
      server.startLogin({
        serverSetup: setup,
        registrationRecord: user.registration_record,
        startLoginRequest: message(body.startLoginRequest),
        userIdentifier: user.id,
      }),
    )
    const registration = attempt(() =>
      server.createRegistrationResponse({
        serverSetup: setup,
        userIdentifier: user.id,
        registrationRequest: message(body.registrationRequest),
      }),
    )
    if (!started || !registration) return json(400, { error: "Malformed password change request." })
    auth.fail(client)
    auth.accountFail(user.login)
    return json(200, {
      attempt: auth.createAttempt({
        kind: "password",
        user: user.id,
        login: user.login,
        state: started.serverLoginState,
      }),
      loginResponse: started.loginResponse,
      userID: user.id,
      wrappedUserKey: user.wrapped_key,
      registrationResponse: registration.registrationResponse,
    })
  }

  async function passwordFinish(request: Request, client: string, current: Current) {
    const user = current.user
    const body = Option.getOrUndefined(decodePasswordFinish(await request.text()))
    const entry = body ? auth.consumeAttempt(body.attempt) : undefined
    // 403 rather than 401: the session is still valid, only the proof of the current password failed.
    if (!body || !entry || entry.kind !== "password" || entry.user !== user.id)
      return json(403, { error: "The current password is wrong." })
    const finished = attempt(() =>
      server.finishLogin({ serverLoginState: entry.state, finishLoginRequest: message(body.finishLoginRequest) }),
    )
    if (!finished) return json(403, { error: "The current password is wrong." })
    // The same user key, wrapped anew: its check value cannot change.
    if (!validWrapped(body.userKey.wrapped) || !equal(body.userKey.check, user.key_check))
      return json(400, { error: "The new wrapped key does not hold your user key." })
    if (!validMessage(body.registrationRecord)) return json(400, { error: "Malformed registration record." })
    if (!store.setCredentials({ userID: user.id, record: body.registrationRecord, wrappedKey: body.userKey.wrapped }))
      return json(401, { error: "Sign in to the hub first." })
    auth.succeed(client)
    auth.accountSucceed(user.login)
    return json(200, {})
  }

  async function admin(request: Request, route: string, current: Current) {
    const method = request.method
    if (route === "users" && method === "GET") {
      const inUse = store.usersWithKeysInUse()
      return json(
        200,
        store.users().map((user) => ({
          id: user.id,
          login: user.login,
          role: user.role,
          createdAt: user.created_at,
          disabled: user.disabled_at !== null,
          // A reset account has no password until its reset invitation is used.
          pending: user.registration_record === null,
          unlocked: auth.unlocked(user.id),
          // Machines that rely on this user's providers get 423 until the user signs in again.
          waiting: inUse.has(user.id) && !auth.unlocked(user.id),
          self: user.id === current.user.id,
        })),
      )
    }
    if (route === "invitations" && method === "GET")
      return json(
        200,
        store.invitations().map((invitation) => ({
          id: invitation.id,
          role: invitation.role,
          createdAt: invitation.created_at,
          expiresAt: invitation.expires_at,
          createdBy: invitation.created_by_login,
          reset: invitation.user_login,
        })),
      )
    if (route === "invitations" && method === "POST") {
      const body = Option.getOrUndefined(decodeInvitation(await request.text()))
      if (!body) return json(400, { error: "Expected { role, days? }." })
      return json(
        200,
        withURL(store.createInvitation({ role: body.role, days: body.days, createdBy: current.user.id })),
      )
    }
    const invitation = /^invitations\/([^/]+)$/.exec(route)
    if (invitation && method === "DELETE") {
      if (!store.revokeInvitation(decodeURIComponent(invitation[1]))) return json(404, { error: "Unknown invitation." })
      return new Response(null, { status: 204 })
    }
    const action = /^users\/([^/]+)\/(disable|enable|role|reset)$/.exec(route)
    if (!action || method !== "POST") return json(404, { error: "Not found." })
    const id = decodeURIComponent(action[1])
    if (action[2] === "reset") {
      const body = Option.getOrUndefined(decodeReset(await request.text()))
      if (!body) return json(400, { error: "Expected { days? }." })
      const reset = store.resetUser(id, { days: body.days, createdBy: current.user.id })
      if (!reset) return json(404, { error: "Unknown user." })
      signOut(id)
      input.reset(id)
      return json(200, withURL(reset))
    }
    const body = action[2] === "role" ? Option.getOrUndefined(decodeRole(await request.text())) : undefined
    if (action[2] === "role" && !body) return json(400, { error: "Expected { role }." })
    const result = body ? store.setRole(id, body.role) : store.setDisabled(id, action[2] === "disable")
    if (result === "unknown") return json(404, { error: "Unknown user." })
    if (result === "last-admin") return json(409, { error: "The hub needs at least one active administrator." })
    if (action[2] === "disable") signOut(id)
    return json(200, {})
  }

  /** Ends everything a user holds: sessions, the event streams they keep open, and the unlocked key. */
  function signOut(user: string) {
    input.closed(auth.deleteUserSessions(user))
    auth.lock(user)
  }

  function withURL(invitation: { id: string; code: string; expiresAt: number }) {
    return {
      id: invitation.id,
      expiresAt: invitation.expiresAt,
      url: `${input.origin}/register?invite=${encodeURIComponent(invitation.code)}`,
    }
  }

  function invalidInvitation(client: string) {
    auth.fail(client)
    return json(400, { error: "This invitation is invalid, used or expired." })
  }

  /** `length` bytes that look random but are the same for the same label. */
  function dummy(label: string, length: number) {
    const blocks = Array.from({ length: Math.ceil(length / 32) }, (_, index) =>
      createHmac("sha256", dummyKey).update(`${label}|${index}`).digest(),
    )
    return new Uint8Array(Buffer.concat(blocks).subarray(0, length))
  }

  function dummyWrapped(login: string) {
    const bytes = dummy(`wrapped-key|${login}`, Account.WRAPPED_BYTES)
    bytes[0] = 1
    return Account.encode(bytes)
  }
}

export type Instance = ReturnType<typeof create>

function isAccountRoute(route: string) {
  return (
    route === "logout" ||
    route.startsWith("account/") ||
    route === "users" ||
    route.startsWith("users/") ||
    route === "invitations" ||
    route.startsWith("invitations/")
  )
}

function signInFailed() {
  return json(401, { error: "Wrong login or password." })
}

function tooMany(wait: number) {
  const seconds = Math.ceil(wait / 1000)
  return json(429, { error: `Too many failed attempts. Try again in ${seconds} s.`, retryAfter: seconds })
}

/** The OPAQUE library throws on malformed messages; a bounded message keeps oversized input out of it. */
function message(text: string) {
  if (!validMessage(text)) throw new Error("malformed message")
  return text
}

function validMessage(text: string) {
  return text.length > 0 && text.length <= MAX_MESSAGE && Account.decode(text).length > 0
}

function validWrapped(text: string) {
  return Account.decode(text).length === Account.WRAPPED_BYTES
}

/** Whether `key` is the user key that `check` was computed from. */
async function sameCheck(key: string, check: string | null) {
  return equal(await Account.keyCheck(key), check)
}

function equal(value: string, expected: string | null) {
  if (!value || !expected) return false
  const left = Buffer.from(value)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function attempt<T>(run: () => T) {
  // The OPAQUE library reports every invalid message by throwing; any of them is a refusal.
  try {
    return run()
  } catch {
    return undefined
  }
}

export function json(status: number, body: unknown, cookie?: string) {
  const headers = new Headers({ "cache-control": "no-store" })
  if (cookie) headers.set("set-cookie", cookie)
  return Response.json(body, { status, headers })
}
