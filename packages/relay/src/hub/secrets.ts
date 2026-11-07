import { Account } from "../account.js"

export * as Secrets from "./secrets.js"

/**
 * Secrets stored in `hub.db` (API keys, OAuth tokens), sealed under the user key `UK` that the hub only holds in memory
 * after a sign-in (see `specs/multi-users.md`, "Chiffrement"). The stored form is `1 | nonce (12 bytes) | ciphertext
 * and tag`, AES-256-GCM, unpadded base64url. The additional data binds a secret to its table, row and user, so it
 * cannot be moved to another row or account. Web Crypto only.
 */

const VERSION = 1
const NONCE_BYTES = 12
const KEY_BYTES = 32
const TAG_BYTES = 16
const AAD = "opencode-hub/v1|"
const encoder = new TextEncoder()

/** Where a secret lives; all three parts go into its additional data. */
export type Place = { table: string; row: string; user: string }

export function aad(place: Place) {
  return `${AAD}${place.table}|${place.row}|${place.user}`
}

/** Seals `plaintext` under the user key (32 bytes, base64url). */
export async function seal(key: string, place: Place, plaintext: string) {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(aad(place)) },
    await importKey(key),
    encoder.encode(plaintext),
  )
  const bytes = new Uint8Array(1 + NONCE_BYTES + sealed.byteLength)
  bytes[0] = VERSION
  bytes.set(nonce, 1)
  bytes.set(new Uint8Array(sealed), 1 + NONCE_BYTES)
  return Account.encode(bytes)
}

/** The plaintext, or undefined when the key, the place or the sealed bytes do not match. */
export async function open(key: string, place: Place, sealed: string) {
  const bytes = Account.decode(sealed)
  if (bytes.length < 1 + NONCE_BYTES + TAG_BYTES || bytes[0] !== VERSION) return undefined
  if (Account.decode(key).length !== KEY_BYTES) return undefined
  const opened = await crypto.subtle
    .decrypt(
      { name: "AES-GCM", iv: bytes.slice(1, 1 + NONCE_BYTES), additionalData: encoder.encode(aad(place)) },
      await importKey(key),
      bytes.slice(1 + NONCE_BYTES),
    )
    .catch(() => undefined)
  return opened ? new TextDecoder().decode(opened) : undefined
}

function importKey(key: string) {
  const bytes = Account.decode(key)
  // A wrong-sized key would silently select AES-128 or AES-192; refuse it instead.
  if (bytes.length !== KEY_BYTES) throw new Error("the user key must be 32 bytes")
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
}
