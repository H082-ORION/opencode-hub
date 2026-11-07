import { client, ready } from "@serenity-kit/opaque"

export * as Account from "./account.js"

/**
 * Hub accounts as the browser sees them: OPAQUE registration and sign-in, and the user key `UK` wrapped with the
 * OPAQUE export key. Only Web Crypto and the OPAQUE client, so the dashboard and Bun (tests, the hub) share it.
 */

/**
 * Argon2id with 64 MiB, 3 passes and 4 lanes (the second recommended option of RFC 9106 §4). The client applies it to
 * the password before the OPRF; the hub never sees which one was used, so every client must use this one.
 */
export const KEY_STRETCHING = "memory-constrained"

const LOGIN = /^[a-z0-9._-]{3,32}$/
const VERSION = 1
const NONCE_BYTES = 12
const KEY_BYTES = 32
/** Version byte, nonce, then the encrypted 32-byte key and its 16-byte tag. */
export const WRAPPED_BYTES = 1 + NONCE_BYTES + KEY_BYTES + 16
const SALT = "opencode-hub/v1"
const WRAP_INFO = "opencode-hub/v1/user-key-wrap"
const WRAP_AAD = "opencode-hub/v1/user-key|"
const CHECK = "opencode-hub/v1/key-check"
const encoder = new TextEncoder()

/** The login as stored: NFKC, lowercase, 3 to 32 of `a-z 0-9 . _ -`; undefined when it does not fit. */
export function normalizeLogin(input: string) {
  const login = input.normalize("NFKC").toLowerCase().trim()
  return LOGIN.test(login) ? login : undefined
}

/** Draws a new user key and wraps it; `key` is the plaintext key, kept only in memory. */
export async function createUserKey(exportKey: string, userID: string) {
  const key = encode(crypto.getRandomValues(new Uint8Array(KEY_BYTES)))
  return { key, ...(await wrapUserKey(exportKey, userID, key)) }
}

/** Wraps `key` under the key derived from an OPAQUE export key, bound to the user id, with its check value. */
export async function wrapUserKey(exportKey: string, userID: string, key: string) {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(WRAP_AAD + userID) },
    await wrappingKey(exportKey),
    decode(key),
  )
  const wrapped = new Uint8Array(WRAPPED_BYTES)
  wrapped[0] = VERSION
  wrapped.set(nonce, 1)
  wrapped.set(new Uint8Array(sealed), 1 + NONCE_BYTES)
  return { wrapped: encode(wrapped), check: await keyCheck(key) }
}

/** The plaintext user key, or undefined when the export key, user id or wrapped bytes do not match. */
export async function unwrapUserKey(exportKey: string, userID: string, wrapped: string) {
  const bytes = decode(wrapped)
  if (bytes.length !== WRAPPED_BYTES || bytes[0] !== VERSION) return undefined
  const opened = await crypto.subtle
    .decrypt(
      { name: "AES-GCM", iv: bytes.slice(1, 1 + NONCE_BYTES), additionalData: encoder.encode(WRAP_AAD + userID) },
      await wrappingKey(exportKey),
      bytes.slice(1 + NONCE_BYTES),
    )
    .catch(() => undefined)
  return opened ? encode(new Uint8Array(opened)) : undefined
}

/** HMAC-SHA256 of a fixed label under the user key: lets the hub refuse a wrong key without storing it. */
export async function keyCheck(key: string) {
  const bytes = decode(key)
  if (bytes.length !== KEY_BYTES) return ""
  const hmac = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return encode(new Uint8Array(await crypto.subtle.sign("HMAC", hmac, encoder.encode(CHECK))))
}

async function wrappingKey(exportKey: string) {
  const material = await crypto.subtle.importKey("raw", decode(exportKey), "HKDF", false, ["deriveKey"])
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(SALT), info: encoder.encode(WRAP_INFO) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
}

/** Sends one JSON request to `/hub/api/<route>` and returns its JSON answer, throwing on an error status. */
export type Post = <T>(route: string, body: unknown) => Promise<T>

/** Creates an account from an invitation; the hub signs the browser in on success. */
export async function register(input: { post: Post; invite: string; login: string; password: string }) {
  await ready
  const start = client.startRegistration({ password: input.password })
  const response = await input.post<{ registrationResponse: string; userID: string; login: string }>("register/start", {
    invite: input.invite,
    login: input.login,
    registrationRequest: start.registrationRequest,
  })
  const finish = client.finishRegistration({
    password: input.password,
    registrationResponse: response.registrationResponse,
    clientRegistrationState: start.clientRegistrationState,
    keyStretching: KEY_STRETCHING,
  })
  return input.post<{ redirect: string }>("register/finish", {
    invite: input.invite,
    login: response.login,
    registrationRecord: finish.registrationRecord,
    userKey: await createUserKey(finish.exportKey, response.userID),
  })
}

/** Signs in and hands the unwrapped user key to the hub; undefined when the login or password is wrong. */
export async function login(input: { post: Post; login: string; password: string; next?: string }) {
  await ready
  const start = client.startLogin({ password: input.password })
  const response = await input.post<LoginStart>("login/start", {
    login: input.login,
    startLoginRequest: start.startLoginRequest,
  })
  const finish = client.finishLogin({
    clientLoginState: start.clientLoginState,
    loginResponse: response.loginResponse,
    password: input.password,
    keyStretching: KEY_STRETCHING,
  })
  if (!finish) return undefined
  const key = await unwrapUserKey(finish.exportKey, response.userID, response.wrappedUserKey)
  if (!key) return undefined
  return input.post<{ redirect: string }>("login/finish", {
    attempt: response.attempt,
    finishLoginRequest: finish.finishLoginRequest,
    userKey: key,
    next: input.next,
  })
}

/**
 * Proves the current password with a sign-in, then registers the new one and wraps the same user key under it, so
 * the data it protects stays readable. Returns false when the current password is wrong.
 */
export async function changePassword(input: { post: Post; password: string; newPassword: string }) {
  await ready
  const login = client.startLogin({ password: input.password })
  const registration = client.startRegistration({ password: input.newPassword })
  const response = await input.post<LoginStart & { registrationResponse: string }>("account/password/start", {
    startLoginRequest: login.startLoginRequest,
    registrationRequest: registration.registrationRequest,
  })
  const finish = client.finishLogin({
    clientLoginState: login.clientLoginState,
    loginResponse: response.loginResponse,
    password: input.password,
    keyStretching: KEY_STRETCHING,
  })
  if (!finish) return false
  const key = await unwrapUserKey(finish.exportKey, response.userID, response.wrappedUserKey)
  if (!key) return false
  const registered = client.finishRegistration({
    password: input.newPassword,
    registrationResponse: response.registrationResponse,
    clientRegistrationState: registration.clientRegistrationState,
    keyStretching: KEY_STRETCHING,
  })
  await input.post<object>("account/password/finish", {
    attempt: response.attempt,
    finishLoginRequest: finish.finishLoginRequest,
    registrationRecord: registered.registrationRecord,
    userKey: await wrapUserKey(registered.exportKey, response.userID, key),
  })
  return true
}

type LoginStart = { attempt: string; loginResponse: string; userID: string; wrappedUserKey: string }

/** Unpadded base64url, the encoding OPAQUE messages use too. */
export function encode(bytes: Uint8Array) {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

/** Decodes unpadded base64url; anything that is not base64url decodes to no bytes. */
export function decode(text: string) {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return new Uint8Array(0)
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}
