import { toHeaders, withoutDecodedHeaders, withoutHopByHop } from "../headers.js"
import { Providers } from "./providers.js"
import type { Store } from "./store.js"

export * as Llm from "./llm.js"

// Headers that describe the client's connection or encoding rather than the request itself.
const DROPPED_REQUEST = new Set(["host", "cookie", "origin", "referer", "content-length", "accept-encoding"])

type ChatGPT = { accessToken(user: string, provider: Providers.Provider, key: string): Promise<string> }

/** Answered for an organization machine whose enroller left the organization or is no longer active. */
export const ENROLLER_GONE =
  "The member who enrolled this organization machine is no longer an active member of it: its keys cannot be used. Enroll the machine again."

export type Deps = {
  store: Store.Instance
  providers: Providers.Instance
  /** The user, only while the account is active (see `Accounts.activeUser`). */
  activeUser: (id: string) => Store.User | undefined
  chatgpt?: ChatGPT
}

/**
 * Whose keys a machine uses: a personal machine its owner's, an organization machine those of the member who enrolled
 * it, only while that account is active and still a member (step 4: every member shares the machine's one instance).
 * A personal owner who is disabled still holds the keys, so that the relay answers it as locked.
 */
export function keyHolder(
  machine: Store.Machine,
  deps: Pick<Deps, "store" | "activeUser">,
): { kind: "user"; user: string } | { kind: "none" } | { kind: "gone" } {
  if (machine.owner_org_id === null)
    return machine.owner_user_id === null ? { kind: "none" } : { kind: "user", user: machine.owner_user_id }
  // An organization machine never has a user owner too; a row that does uses nobody's keys.
  if (machine.owner_user_id !== null || machine.enrolled_by === null) return { kind: "none" }
  const enroller = deps.activeUser(machine.enrolled_by)
  if (!enroller || !deps.store.isMember(machine.owner_org_id, enroller.id)) return { kind: "gone" }
  return { kind: "user", user: enroller.id }
}

/**
 * Forwards `/llm/<provider>/<rest>` to the upstream of that provider **of the machine's key holder** (see
 * `keyHolder`), replacing the machine's llm token with the holder's real key in whichever place carried it. ChatGPT
 * providers always get a bearer access token from `chatgpt` instead. The key is opened with the holder's user key in
 * memory; without it, 423.
 */
export async function proxy(request: Request, url: URL, deps: Deps) {
  const match = /^\/llm\/([^/]+)(\/.*)?$/.exec(url.pathname)
  if (!match) return json(404, "unknown provider")
  const headers = toHeaders(
    withoutHopByHop(request.headers).filter((entry) => !DROPPED_REQUEST.has(entry[0].toLowerCase())),
  )
  // Resolving the rest against a placeholder normalizes dot segments so a request cannot climb above the base path.
  const target = new URL((match[2] ?? "").slice(1), "http://placeholder/")
  const query = new URLSearchParams(url.search)
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
  const slots = [
    {
      token: bearer,
      apply: (key: string) => headers.set("authorization", `Bearer ${key}`),
      clear: () => headers.delete("authorization"),
    },
    {
      token: request.headers.get("x-api-key"),
      apply: (key: string) => headers.set("x-api-key", key),
      clear: () => headers.delete("x-api-key"),
    },
    {
      token: request.headers.get("x-goog-api-key"),
      apply: (key: string) => headers.set("x-goog-api-key", key),
      clear: () => headers.delete("x-goog-api-key"),
    },
    { token: query.get("key"), apply: (key: string) => query.set("key", key), clear: () => query.delete("key") },
  ].flatMap((slot) => {
    const machine = slot.token ? deps.store.machineByLlmToken(slot.token) : undefined
    return machine ? [{ ...slot, machine }] : []
  })
  const machines = new Set(slots.map((slot) => slot.machine.id))
  // Tokens of two machines in one request could pick either owner's keys: refused.
  if (machines.size !== 1) return json(401, "invalid llm token")
  const machine = slots[0]!.machine
  const holder = keyHolder(machine, deps)
  if (holder.kind === "gone") return json(403, ENROLLER_GONE)
  if (holder.kind === "none") return json(403, "this machine has no owner whose keys it may use")
  const owner = holder.user
  // A disabled or reset account has no key in memory either: both answer as locked until the owner signs in again.
  if (!deps.activeUser(owner)) return json(423, Providers.LOCKED)
  const opened = await deps.providers.open(owner, match[1])
  if (opened.kind === "unknown") return json(404, "unknown provider")
  if (opened.kind === "locked") return json(423, Providers.LOCKED)
  if (opened.kind === "unreadable")
    return json(500, "stored provider credential is unreadable; save the provider again")
  const provider = opened.provider
  const access = provider.auth === "chatgpt" ? await chatgptToken(owner, provider, opened.key, deps.chatgpt) : undefined
  if (access instanceof Response) return access
  slots.forEach((slot) => (access === undefined ? slot.apply(provider.api_key) : slot.clear()))
  if (access !== undefined) headers.set("authorization", `Bearer ${access}`)
  const body =
    request.method === "GET" || request.method === "HEAD" ? undefined : new Uint8Array(await request.arrayBuffer())
  // ChatGPT token sharing rejects uncompressed bodies over ~1 MiB and decodes zstd.
  const compress = access !== undefined && body !== undefined && body.length > 0 && !headers.has("content-encoding")
  if (compress) headers.set("content-encoding", "zstd")

  const search = query.toString()
  const upstream = `${provider.base_url.replace(/\/+$/, "")}${target.pathname}${search ? `?${search}` : ""}`
  const response = await fetch(upstream, {
    method: request.method,
    headers,
    // LLM requests are small; buffering gives upstreams a content-length instead of a chunked upload.
    body: compress ? new Uint8Array(Bun.zstdCompressSync(body)) : body,
    redirect: "manual",
    signal: request.signal,
  }).catch((error: unknown) => error as Error)
  if (response instanceof Error) return json(502, `upstream request failed: ${response.message}`)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: toHeaders(withoutDecodedHeaders(response.headers)),
  })
}

async function chatgptToken(user: string, provider: Providers.Provider, key: string, chatgpt: ChatGPT | undefined) {
  if (!chatgpt) return json(502, "ChatGPT sign-in is not available on this hub")
  return chatgpt
    .accessToken(user, provider, key)
    .catch((error: unknown) =>
      json(502, `ChatGPT token refresh failed: ${error instanceof Error ? error.message : String(error)}`),
    )
}

function json(status: number, error: string) {
  return Response.json({ error }, { status })
}
