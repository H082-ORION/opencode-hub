import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { client } from "@serenity-kit/opaque"
import { Account } from "../src/account.js"
import { Hub } from "../src/index.js"
import { browser, Refused } from "./fixture/browser.js"

const ADMIN = { login: "Admin", password: "admin-password" }
const DAY = 24 * 60 * 60 * 1000

const data = mkdtempSync(path.join(os.tmpdir(), "opencode-accounts-"))
const state = {} as {
  hub: Awaited<ReturnType<typeof Hub.start>>
  admin: ReturnType<typeof browser>
  users: { before: number; after: number }
}
// Each test that fails sign-ins on purpose poses as its own client address, so throttling stays inside it.
const addresses = { next: 1 }

beforeAll(async () => {
  state.hub = await Hub.start({ hostname: "127.0.0.1", port: 0, data, catalog: { fetch: offline } })
  state.admin = browser(state.hub.url)
  const before = state.hub.userCount()
  await register(state.admin, state.hub.invite("admin").url, ADMIN.login, ADMIN.password)
  state.users = { before, after: state.hub.userCount() }
})

afterAll(async () => {
  setSystemTime()
  await state.hub?.stop()
  rmSync(data, { recursive: true, force: true })
})

describe("registration", () => {
  test("the first invitation creates an administrator with a normalized login and an unlocked key", async () => {
    expect(state.users).toEqual({ before: 0, after: 1 })
    expect(await json(state.admin.request("session"))).toMatchObject({
      authenticated: true,
      user: { login: "admin", role: "admin" },
      unlocked: true,
    })
  })

  test("an invitation works once", async () => {
    const url = (await invite("user")).url
    const first = browser(state.hub.url)
    await register(first, url, "once", "password-1")
    const second = browser(state.hub.url, address())
    const refused = await register(second, url, "twice", "password-2").catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(Refused)
    expect((refused as Refused).status).toBe(400)
    expect(await login("twice", "password-2", address())).toBeUndefined()
  })

  test("an expired invitation is refused", async () => {
    const url = (await invite("user", 1)).url
    setSystemTime(new Date(Date.now() + DAY + 1000))
    const refused = await register(browser(state.hub.url, address()), url, "late", "password").catch(
      (error: unknown) => error,
    )
    setSystemTime()
    expect((refused as Refused).status).toBe(400)
  })

  test("refuses a taken or malformed login", async () => {
    const taken = await register(browser(state.hub.url), (await invite("user")).url, "ADMIN", "x").catch(
      (error: unknown) => error,
    )
    expect((taken as Refused).status).toBe(409)
    const malformed = await register(browser(state.hub.url), (await invite("user")).url, "a b", "x").catch(
      (error: unknown) => error,
    )
    expect((malformed as Refused).status).toBe(400)
  })

  test("refuses a user key whose check does not match", async () => {
    const code = inviteCode((await invite("user")).url)
    const page = browser(state.hub.url)
    const start = client.startRegistration({ password: "password" })
    const response = await page.post<{ registrationResponse: string; userID: string; login: string }>(
      "register/start",
      { invite: code, login: "forger", registrationRequest: start.registrationRequest },
    )
    const finish = client.finishRegistration({
      password: "password",
      registrationResponse: response.registrationResponse,
      clientRegistrationState: start.clientRegistrationState,
      keyStretching: Account.KEY_STRETCHING,
    })
    const userKey = await Account.createUserKey(finish.exportKey, response.userID)
    const refused = await page
      .post("register/finish", {
        invite: code,
        login: response.login,
        registrationRecord: finish.registrationRecord,
        userKey: { ...userKey, check: (await Account.createUserKey(finish.exportKey, response.userID)).check },
      })
      .catch((error: unknown) => error)
    expect((refused as Refused).status).toBe(400)
  })
})

describe("sign-in", () => {
  test("a correct password opens a session and unlocks the key", async () => {
    const page = browser(state.hub.url)
    expect(await Account.login({ post: page.post, login: " ADMIN ", password: ADMIN.password })).toEqual({
      redirect: "/",
    })
    expect(await json(page.request("session"))).toMatchObject({ user: { login: "admin" }, unlocked: true })
  })

  test("a wrong password fails in the browser and throttles the client address", async () => {
    const headers = address()
    expect(await login(ADMIN.login, "wrong", headers)).toBeUndefined()
    const attempt = () =>
      browser(state.hub.url, headers)
        .request("login/start", { method: "POST", body: { login: "admin", startLoginRequest: startRequest() } })
        .then((response) => response.status)
    // The delay starts at `login/start`, and the browser's key stretching can outlast its first second: this attempt
    // has no stretching, so the next one lands inside the delay whether or not the first has run out.
    await attempt()
    expect(await attempt()).toBe(429)
  })

  test("an unknown login gets an answer of the same shape, stable from one attempt to the next", async () => {
    const known = await loginStart("admin")
    const unknown = await loginStart("nobody")
    const again = await loginStart("nobody")
    expect(Object.keys(unknown).sort()).toEqual(Object.keys(known).sort())
    expect(unknown.loginResponse.length).toBe(known.loginResponse.length)
    expect(unknown.userID.length).toBe(known.userID.length)
    expect(unknown.wrappedUserKey.length).toBe(known.wrappedUserKey.length)
    expect(again.userID).toBe(unknown.userID)
    expect(again.wrappedUserKey).toBe(unknown.wrappedUserKey)
    expect(await login("nobody", "anything", address())).toBeUndefined()
  })

  test("five failures lock an account for 15 minutes, whatever the client address", async () => {
    await register(browser(state.hub.url), (await invite("user")).url, "locked", "right-password")
    // A sign-in counts as failed from its start until it finishes, so starting is enough to fail without hashing.
    await Promise.all(Array.from({ length: 5 }, () => loginStart("locked")))
    const refused = await login("locked", "right-password", address()).catch((error: unknown) => error)
    expect((refused as Refused).status).toBe(429)
    // An unknown login locks the same way, so locking reveals nothing either.
    await Promise.all(Array.from({ length: 5 }, () => loginStart("ghost")))
    expect(((await loginStart("ghost").catch((error: unknown) => error)) as Refused).status).toBe(429)
    setSystemTime(new Date(Date.now() + 15 * 60 * 1000 + 1000))
    const after = await login("locked", "right-password", address())
    setSystemTime()
    expect(after).toEqual({ redirect: "/" })
  })

  test("refuses a user key that does not match the stored check", async () => {
    await register(browser(state.hub.url), (await invite("user")).url, "keyed", "keyed-password")
    const page = browser(state.hub.url, address())
    const start = client.startLogin({ password: "keyed-password" })
    const response = await page.post<{ attempt: string; loginResponse: string }>("login/start", {
      login: "keyed",
      startLoginRequest: start.startLoginRequest,
    })
    const finish = client.finishLogin({
      clientLoginState: start.clientLoginState,
      loginResponse: response.loginResponse,
      password: "keyed-password",
      keyStretching: Account.KEY_STRETCHING,
    })
    const refused = await page
      .request("login/finish", {
        method: "POST",
        body: {
          attempt: response.attempt,
          finishLoginRequest: finish?.finishLoginRequest,
          userKey: (await Account.createUserKey(finish?.exportKey ?? "", "x")).key,
        },
      })
      .then((result) => result.status)
    expect(refused).toBe(401)
    expect(page.jar.cookie).toBe("")
  })
})

describe("account", () => {
  test("locking the keys keeps the session; signing out keeps the keys", async () => {
    const page = browser(state.hub.url)
    await register(page, (await invite("user")).url, "locker", "locker-password")
    expect(await userEntry("locker")).toMatchObject({ unlocked: true })
    expect(await page.post("account/lock", {})).toEqual({ unlocked: false })
    expect(await json(page.request("session"))).toMatchObject({ authenticated: true, unlocked: false })
    await login("locker", "locker-password")
    await page.post("logout", {})
    expect((await page.request("session")).status).toBe(401)
    expect(await userEntry("locker")).toMatchObject({ unlocked: true })
  })

  test("changing the password keeps the user key", async () => {
    const page = browser(state.hub.url, address())
    await register(page, (await invite("user")).url, "changer", "old-password")
    expect(await Account.changePassword({ post: page.post, password: "wrong", newPassword: "x" })).toBe(false)
    // The failed attempt throttles that client address for a second; the same session retries from another one.
    const retry = browser(state.hub.url, address())
    retry.jar.cookie = page.jar.cookie
    expect(
      await Account.changePassword({ post: retry.post, password: "old-password", newPassword: "new-password" }),
    ).toBe(true)
    expect(await login("changer", "old-password", address())).toBeUndefined()
    // The hub only accepts the key whose check it stored at registration, so this proves the key did not change.
    expect(await login("changer", "new-password", address())).toEqual({ redirect: "/" })
    // Registration, two password changes and two sign-ins each run Argon2, over a second apiece on a laptop.
  }, { timeout: 30_000 })
})

describe("administration", () => {
  test("only administrators reach the user and invitation routes", async () => {
    const page = browser(state.hub.url)
    await register(page, (await invite("user")).url, "plain", "plain-password")
    expect((await page.request("users")).status).toBe(403)
    expect((await page.request("invitations", { method: "POST", body: { role: "admin" } })).status).toBe(403)
    expect((await browser(state.hub.url).request("users")).status).toBe(401)
  })

  test("lists and revokes pending invitations", async () => {
    const created = await invite("admin", 3)
    const pending = (await json(state.admin.request("invitations"))) as {
      id: string
      role: string
      createdBy: string
    }[]
    expect(pending.find((entry) => entry.id === created.id)).toMatchObject({ role: "admin", createdBy: "admin" })
    expect(JSON.stringify(pending)).not.toContain(inviteCode(created.url))
    expect((await state.admin.request(`invitations/${created.id}`, { method: "DELETE" })).status).toBe(204)
    expect((await state.admin.request(`invitations/${created.id}`, { method: "DELETE" })).status).toBe(404)
    const refused = await register(browser(state.hub.url, address()), created.url, "revoked", "x").catch(
      (error: unknown) => error,
    )
    expect((refused as Refused).status).toBe(400)
  })

  test("disabling an account closes its sessions and drops its key until it is enabled again", async () => {
    const page = browser(state.hub.url)
    await register(page, (await invite("user")).url, "leaver", "leaver-password")
    const id = (await userEntry("leaver")).id
    expect(await state.admin.post(`users/${id}/disable`, {})).toEqual({})
    expect((await page.request("session")).status).toBe(401)
    expect(await userEntry("leaver")).toMatchObject({ disabled: true, unlocked: false })
    expect(await login("leaver", "leaver-password", address())).toBeUndefined()
    await state.admin.post(`users/${id}/enable`, {})
    expect(await login("leaver", "leaver-password", address())).toEqual({ redirect: "/" })
  })

  test("the last active administrator can be neither disabled nor demoted", async () => {
    const self = (await userEntry("admin")).id
    const disable = await state.admin.request(`users/${self}/disable`, { method: "POST" })
    expect(disable.status).toBe(409)
    const demote = await state.admin.request(`users/${self}/role`, { method: "POST", body: { role: "user" } })
    expect(demote.status).toBe(409)
    const deputy = browser(state.hub.url)
    await register(deputy, (await invite("user")).url, "deputy", "deputy-password")
    const deputyID = (await userEntry("deputy")).id
    await state.admin.post(`users/${deputyID}/role`, { role: "admin" })
    expect(await deputy.post(`users/${self}/role`, { role: "user" })).toEqual({})
    // The demoted administrator lost its rights at once, and the deputy is now the last one.
    expect((await state.admin.request("users")).status).toBe(403)
    expect((await deputy.request(`users/${deputyID}/disable`, { method: "POST" })).status).toBe(409)
    await deputy.post(`users/${self}/role`, { role: "admin" })
  })

  test("a reset forgets the password and key at once, and its invitation registers the same account", async () => {
    const page = browser(state.hub.url)
    await register(page, (await invite("user")).url, "forgetful", "lost-password")
    const id = (await userEntry("forgetful")).id
    const reset = await state.admin.post<{ url: string }>(`users/${id}/reset`, {})
    expect((await page.request("session")).status).toBe(401)
    expect(await userEntry("forgetful")).toMatchObject({ pending: true, unlocked: false })
    expect(await login("forgetful", "lost-password", address())).toBeUndefined()
    const fresh = browser(state.hub.url)
    expect(await fresh.post("register/invite", { invite: inviteCode(reset.url) })).toEqual({
      role: "user",
      login: "forgetful",
    })
    // The login typed on the page does not matter: a reset keeps the account's own.
    await register(fresh, reset.url, "someone-else", "found-password")
    expect(await userEntry("forgetful")).toMatchObject({ id, pending: false, unlocked: true })
    expect(await login("forgetful", "found-password")).toEqual({ redirect: "/" })
  })
})

describe("storage", () => {
  test("keeps the data directory owner-only and the OPAQUE key out of the database", async () => {
    expect(statSync(data).mode & 0o777).toBe(0o700)
    ;["hub.db", "hub.db-wal", "hub.db-shm", "opaque-server-setup"].forEach((name) =>
      expect(statSync(path.join(data, name)).mode & 0o777).toBe(0o600),
    )
    const database = await Bun.file(path.join(data, "hub.db")).text()
    const setup = (await Bun.file(path.join(data, "opaque-server-setup")).text()).trim()
    expect(database).not.toContain(setup)
  })

  test("`opencode hub invite` writes an invitation the running hub accepts", async () => {
    const created = Hub.invite({ data, role: "user" })
    expect(created.url.startsWith(`${state.hub.url}/register?invite=`)).toBe(true)
    await register(browser(state.hub.url), created.url, "from-cli", "cli-password")
    expect(await userEntry("from-cli")).toMatchObject({ role: "user" })
  })
})

describe("user key", () => {
  test("unwraps only with the same export key and user id", async () => {
    const exportKey = Account.encode(crypto.getRandomValues(new Uint8Array(64)))
    const created = await Account.createUserKey(exportKey, "user-1")
    expect(await Account.unwrapUserKey(exportKey, "user-1", created.wrapped)).toBe(created.key)
    expect(await Account.unwrapUserKey(exportKey, "user-2", created.wrapped)).toBeUndefined()
    const other = Account.encode(crypto.getRandomValues(new Uint8Array(64)))
    expect(await Account.unwrapUserKey(other, "user-1", created.wrapped)).toBeUndefined()
    expect(await Account.keyCheck(created.key)).toBe(created.check)
    expect(Account.decode(created.wrapped).length).toBe(Account.WRAPPED_BYTES)
  })

  test("normalizes logins", () => {
    expect(Account.normalizeLogin(" Ｊｅａｎ.Dupont ")).toBe("jean.dupont")
    expect(Account.normalizeLogin("ab")).toBeUndefined()
    expect(Account.normalizeLogin("a".repeat(33))).toBeUndefined()
    expect(Account.normalizeLogin("jean dupont")).toBeUndefined()
  })
})

/** Keeps the provider catalog on its built-in list, so tests never reach models.dev. */
const offline = Object.assign(async () => Response.error(), { preconnect: () => {} }) as typeof fetch

function address() {
  return { "x-forwarded-for": `198.51.100.${addresses.next++}` }
}

function inviteCode(url: string) {
  return new URL(url).searchParams.get("invite") ?? ""
}

async function register(page: ReturnType<typeof browser>, url: string, login: string, password: string) {
  return Account.register({ post: page.post, invite: inviteCode(url), login, password })
}

function login(login: string, password: string, headers: Record<string, string> = {}) {
  return Account.login({ post: browser(state.hub.url, headers).post, login, password })
}

function invite(role: "admin" | "user", days?: number) {
  return state.admin.post<{ id: string; url: string; expiresAt: number }>("invitations", { role, days })
}

function startRequest() {
  return client.startLogin({ password: "x" }).startLoginRequest
}

function loginStart(login: string) {
  return browser(state.hub.url, address()).post<{
    attempt: string
    loginResponse: string
    userID: string
    wrappedUserKey: string
  }>("login/start", { login, startLoginRequest: startRequest() })
}

async function json(response: Promise<Response>) {
  return (await response).json()
}

async function userEntry(login: string) {
  const users = (await json(state.admin.request("users"))) as {
    id: string
    login: string
    role: string
    disabled: boolean
    pending: boolean
    unlocked: boolean
  }[]
  const user = users.find((entry) => entry.login === login)
  if (!user) throw new Error(`no user ${login}`)
  return user
}
