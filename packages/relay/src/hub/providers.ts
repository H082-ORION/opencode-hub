import { Option } from "effect"
import { Secrets } from "./secrets.js"
import { Store } from "./store.js"

export * as Providers from "./providers.js"

/** Shown when a user's key is not in memory: after a restart, a lock, or before their first sign-in. */
export const LOCKED = "Keys locked: sign in to the hub to unlock them."

/** A provider with its secret in clear; it exists only in memory, while a request needs it. */
export type Provider = {
  id: string
  name: string
  base_url: string
  auth: Store.Auth
  api_key: string
  oauth: Store.OAuth | undefined
}

/** Thrown when an operation needs a user key the hub does not hold. */
export class LockedError extends Error {
  constructor() {
    super(LOCKED)
  }
}

export type Opened =
  | { kind: "unknown" }
  | { kind: "locked" }
  /** The secret does not open under the key in memory: a damaged row, never a reason to try another key. */
  | { kind: "unreadable" }
  | { kind: "ok"; provider: Provider; key: string }

const TABLE = "provider"

/**
 * Each user's providers, with their secrets sealed under that user's key (`key(user)`, from the in-memory table of
 * unlocked keys). Reading a provider's name or URL needs no key; reading or writing a secret does.
 */
export function create(input: { store: Store.Instance; key: (user: string) => string | undefined }) {
  const store = input.store
  const place = (user: string, id: string) => ({ table: TABLE, row: id, user })

  return {
    /** Whether the user's key is in memory, so their secrets can be sealed and opened. */
    unlocked: (user: string) => input.key(user) !== undefined,

    /** A user's providers without secrets, for the dashboard and for the machines' READY and CONFIG frames. */
    summaries: (user: string) => store.providerSummaries(user),

    /** Opens a user's provider with the key in memory. */
    async open(user: string, id: string): Promise<Opened> {
      const row = store.provider(user, id)
      if (!row) return { kind: "unknown" }
      const key = input.key(user)
      if (!key) return { kind: "locked" }
      const sealed = row.auth === "chatgpt" ? row.oauth : row.api_key
      const secret = sealed === null ? undefined : await Secrets.open(key, place(user, id), sealed)
      if (secret === undefined) return { kind: "unreadable" }
      const oauth = row.auth === "chatgpt" ? Option.getOrUndefined(Store.decodeOAuth(secret)) : undefined
      if (row.auth === "chatgpt" && !oauth) return { kind: "unreadable" }
      return {
        kind: "ok",
        key,
        provider: {
          id: row.id,
          name: row.name,
          base_url: row.base_url,
          auth: row.auth,
          api_key: row.auth === "key" ? secret : "",
          oauth,
        },
      }
    },

    /** Saves an API-key provider; throws `LockedError` when the user's key is not in memory. */
    async saveKey(user: string, provider: { id: string; name: string; baseURL: string; apiKey: string }) {
      const key = requireKey(user)
      store.saveProvider({
        user,
        id: provider.id,
        name: provider.name,
        baseURL: provider.baseURL,
        auth: "key",
        apiKey: await Secrets.seal(key, place(user, provider.id), provider.apiKey),
        oauth: null,
      })
    },

    /** Saves an OAuth provider (ChatGPT); throws `LockedError` when the user's key is not in memory. */
    async saveOAuth(user: string, provider: { id: string; name: string; baseURL: string; oauth: Store.OAuth }) {
      const key = requireKey(user)
      store.saveProvider({
        user,
        id: provider.id,
        name: provider.name,
        baseURL: provider.baseURL,
        auth: "chatgpt",
        apiKey: null,
        oauth: await Secrets.seal(key, place(user, provider.id), JSON.stringify(provider.oauth)),
      })
    },

    /**
     * Seals a refreshed OAuth credential with the key the provider was opened with: the refresh token may already be
     * rotated, so a lock that lands during the refresh must not lose it.
     */
    async updateOAuth(user: string, id: string, key: string, oauth: Store.OAuth) {
      return store.updateOAuth(user, id, await Secrets.seal(key, place(user, id), JSON.stringify(oauth)))
    },

    delete: (user: string, id: string) => store.deleteProvider(user, id),
  }

  function requireKey(user: string) {
    const key = input.key(user)
    if (!key) throw new LockedError()
    return key
  }
}

export type Instance = ReturnType<typeof create>
