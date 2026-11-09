import { toHeaders, withoutDecodedHeaders, withoutHopByHop } from "../headers.js"
import { Providers } from "./providers.js"
import type { Store } from "./store.js"

export * as Llm from "./llm.js"

// Headers that describe the client's connection or encoding rather than the request itself.
const DROPPED_REQUEST = new Set(["host", "cookie", "origin", "referer", "content-length", "accept-encoding"])

type ChatGPT = { accessToken(user: string, provider: Providers.Provider, key: string): Promise<string> }

/** Answered when the instance's user may no longer open its machine (disabled, reset, left the organization). */
export const NO_ACCESS = "This account no longer has access to this machine."

export type Deps = {
  store: Store.Instance
  providers: Providers.Instance
  /** Whether a user may still open a machine: the account is active, and owns it or belongs to its organization. */
  allowed: (user: string, machine: Store.Machine) => boolean
  chatgpt?: ChatGPT
  /** The user a hub chat instance's token belongs to. */
  chatOwner?: (token: string) => string | undefined
}

/**
 * Forwards `/llm/<provider>/<rest>` to the upstream of that provider **of the instance's user**: the instance token
 * names one user's instance on one machine. The token is replaced with the user's real key in whichever place carried
 * it; ChatGPT providers always get a bearer access token from `chatgpt` instead. The key is opened with the user's key
 * in memory; without it, 423.
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
    const instance = slot.token ? deps.store.instanceByToken(slot.token) : undefined
    const chat = slot.token ? deps.chatOwner?.(slot.token) : undefined
    return instance || chat ? [{ ...slot, instance, chat }] : []
  })
  const instances = new Set(slots.map((slot) => slot.instance?.id ?? `chat:${slot.chat}`))
  // Tokens of two instances in one request could pick either user's keys: refused.
  if (instances.size !== 1) return json(401, "invalid llm token")
  const instance = slots[0]!.instance
  // A chat instance runs on the hub itself: it has no machine to lose access to.
  const machine = instance && deps.store.machine(instance.machine_id)
  if (instance && !machine) return json(401, "invalid llm token")
  // Checked on every call, besides the instance being deleted when access ends: fail closed.
  if (instance && machine && !deps.allowed(instance.user_id, machine)) return json(403, NO_ACCESS)
  const owner = instance?.user_id ?? slots[0]!.chat!
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
