import { toHeaders, withoutDecodedHeaders, withoutHopByHop } from "../headers.js"
import type { Store } from "./store.js"

export * as Llm from "./llm.js"

export const PRESETS = [
  { id: "anthropic", name: "Anthropic", baseURL: "https://api.anthropic.com/v1" },
  { id: "openai", name: "OpenAI", baseURL: "https://api.openai.com/v1" },
  { id: "openrouter", name: "OpenRouter", baseURL: "https://openrouter.ai/api/v1" },
  { id: "google", name: "Google", baseURL: "https://generativelanguage.googleapis.com/v1beta" },
  { id: "mistral", name: "Mistral", baseURL: "https://api.mistral.ai/v1" },
  { id: "groq", name: "Groq", baseURL: "https://api.groq.com/openai/v1" },
  { id: "deepseek", name: "DeepSeek", baseURL: "https://api.deepseek.com/v1" },
]

// Headers that describe the client's connection or encoding rather than the request itself.
const DROPPED_REQUEST = new Set(["host", "cookie", "origin", "referer", "content-length", "accept-encoding"])

/**
 * Forwards `/llm/<provider>/<rest>` to the provider's upstream, replacing the machine's llm token with the real key
 * in whichever place carried it.
 */
export async function proxy(request: Request, url: URL, store: Store.Instance) {
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
    { token: bearer, apply: (key: string) => headers.set("authorization", `Bearer ${key}`) },
    { token: request.headers.get("x-api-key"), apply: (key: string) => headers.set("x-api-key", key) },
    { token: request.headers.get("x-goog-api-key"), apply: (key: string) => headers.set("x-goog-api-key", key) },
    { token: query.get("key"), apply: (key: string) => query.set("key", key) },
  ].filter((slot) => slot.token && store.machineByLlmToken(slot.token))
  if (slots.length === 0) return json(401, "invalid llm token")
  const provider = store.provider(match[1])
  if (!provider) return json(404, "unknown provider")
  slots.forEach((slot) => slot.apply(provider.api_key))

  const search = query.toString()
  const upstream = `${provider.base_url.replace(/\/+$/, "")}${target.pathname}${search ? `?${search}` : ""}`
  const response = await fetch(upstream, {
    method: request.method,
    headers,
    // LLM requests are small; buffering gives upstreams a content-length instead of a chunked upload.
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
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

function json(status: number, error: string) {
  return Response.json({ error }, { status })
}
