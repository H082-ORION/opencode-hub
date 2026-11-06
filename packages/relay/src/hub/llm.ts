import { toHeaders, withoutDecodedHeaders, withoutHopByHop } from "../headers.js"
import type { Store } from "./store.js"

export * as Llm from "./llm.js"

// Headers that describe the client's connection or encoding rather than the request itself.
const DROPPED_REQUEST = new Set(["host", "cookie", "origin", "referer", "content-length", "accept-encoding"])

/**
 * Forwards `/llm/<provider>/<rest>` to the provider's upstream, replacing the machine's llm token with the real key
 * in whichever place carried it. ChatGPT providers always get a bearer access token from `chatgpt` instead.
 */
export async function proxy(
  request: Request,
  url: URL,
  store: Store.Instance,
  chatgpt?: { accessToken(provider: Store.Provider): Promise<string> },
) {
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
  ].filter((slot) => slot.token && store.machineByLlmToken(slot.token))
  if (slots.length === 0) return json(401, "invalid llm token")
  const provider = store.provider(match[1])
  if (!provider) return json(404, "unknown provider")
  const access = provider.auth === "chatgpt" ? await chatgptToken(provider, chatgpt) : undefined
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

async function chatgptToken(
  provider: Store.Provider,
  chatgpt: { accessToken(provider: Store.Provider): Promise<string> } | undefined,
) {
  if (!chatgpt) return json(502, "ChatGPT sign-in is not available on this hub")
  return chatgpt
    .accessToken(provider)
    .catch((error: unknown) =>
      json(502, `ChatGPT token refresh failed: ${error instanceof Error ? error.message : String(error)}`),
    )
}

function json(status: number, error: string) {
  return Response.json({ error }, { status })
}
