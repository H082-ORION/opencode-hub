import { Option, Schema } from "effect"
import { chmod } from "node:fs/promises"
import path from "node:path"

export * as Catalog from "./catalog.js"

/** A provider the hub can proxy with only an API key: its upstream URL comes from opencode's models.dev catalog. */
export type Entry = { id: string; name: string; baseURL: string; doc?: string; env: string[] }

export const SOURCE = "https://models.opencode.ai/experimental/v2.0/api.json?type=chat"
const TTL = 24 * 60 * 60 * 1000

// Used until the catalog has been fetched once, e.g. on a hub without internet access.
export const FALLBACK: Entry[] = [
  { id: "anthropic", name: "Anthropic", baseURL: "https://api.anthropic.com/v1", env: ["ANTHROPIC_API_KEY"] },
  { id: "deepseek", name: "DeepSeek", baseURL: "https://api.deepseek.com", env: ["DEEPSEEK_API_KEY"] },
  {
    id: "google",
    name: "Google",
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    env: ["GOOGLE_GENERATIVE_AI_API_KEY"],
  },
  { id: "groq", name: "Groq", baseURL: "https://api.groq.com/openai/v1", env: ["GROQ_API_KEY"] },
  { id: "mistral", name: "Mistral", baseURL: "https://api.mistral.ai/v1", env: ["MISTRAL_API_KEY"] },
  { id: "openai", name: "OpenAI", baseURL: "https://api.openai.com/v1", env: ["OPENAI_API_KEY"] },
  { id: "openrouter", name: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", env: ["OPENROUTER_API_KEY"] },
  { id: "xai", name: "xAI", baseURL: "https://api.x.ai/v1", env: ["XAI_API_KEY"] },
]

const Api = Schema.Struct({
  base_url: Schema.optional(Schema.String),
  sdk: Schema.optional(
    Schema.Struct({ aisdk: Schema.optional(Schema.String), opencodeai: Schema.optional(Schema.String) }),
  ),
})
const Model = Schema.Struct({
  type: Schema.optional(Schema.String),
  api: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
const Provider = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  doc: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Array(Schema.String)),
  models: Schema.Record(Schema.String, Schema.Unknown),
})
const decodeCatalog = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))
const decodeProvider = Schema.decodeUnknownOption(Provider)
const decodeModel = Schema.decodeUnknownOption(Model)
const decodeApi = Schema.decodeUnknownOption(Api)
const Cached = Schema.Struct({
  fetchedAt: Schema.Number,
  entries: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      baseURL: Schema.String,
      doc: Schema.optional(Schema.String),
      env: Schema.Array(Schema.String),
    }),
  ),
})
const decodeCached = Schema.decodeUnknownOption(Schema.fromJsonString(Cached))

export function create(input: { data: string; fetch?: typeof fetch; source?: string; now?: () => number }) {
  const file = path.join(input.data, "catalog.json")
  const now = input.now ?? Date.now
  const state: { cached?: { fetchedAt: number; entries: Entry[] }; refreshing?: Promise<Entry[]> } = {}

  const refresh = () => {
    state.refreshing ??= (input.fetch ?? fetch)(input.source ?? SOURCE, { signal: AbortSignal.timeout(30_000) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`catalog returned ${response.status}`)
        const entries = parse(await response.json())
        if (entries.length === 0) throw new Error("catalog has no usable providers")
        state.cached = { fetchedAt: now(), entries }
        await Bun.write(file, JSON.stringify(state.cached), { mode: 0o600 })
        // The mode above only applies when the file is created; an older cache keeps its own.
        await chmod(file, 0o600)
        return entries
      })
      .catch(() => state.cached?.entries ?? FALLBACK)
      .finally(() => {
        state.refreshing = undefined
      })
    return state.refreshing
  }

  // The disk copy is read once; concurrent first calls then share one fetch through `refresh`.
  const loaded = Bun.file(file)
    .text()
    .catch(() => "")
    .then((text) => {
      const stored = Option.getOrUndefined(decodeCached(text))
      state.cached ??= stored
        ? { fetchedAt: stored.fetchedAt, entries: stored.entries.map((entry) => ({ ...entry, env: [...entry.env] })) }
        : undefined
    })

  /** Providers sorted by name. Serves the cached copy and refreshes it in the background once a day. */
  const list = async (): Promise<Entry[]> => {
    await loaded
    if (!state.cached) return refresh()
    if (now() - state.cached.fetchedAt > TTL) void refresh()
    return state.cached.entries
  }

  return {
    list,
    find: async (id: string) => (await list()).find((entry) => entry.id === id),
  }
}

export type Instance = ReturnType<typeof create>

/**
 * Mirrors how opencode picks a provider's base URL: each chat model uses its first API that names an SDK, and the
 * provider URL is the most common of those. Providers without a URL, or whose URL is a template that the SDK fills from
 * settings (Azure, Bedrock, Vertex…), cannot be proxied with a key alone and are left out.
 */
export function parse(value: unknown): Entry[] {
  const catalog = Option.getOrUndefined(decodeCatalog(value)) ?? {}
  return Object.values(catalog)
    .flatMap((item) => {
      const provider = Option.getOrUndefined(decodeProvider(item))
      if (!provider) return []
      const urls = Object.values(provider.models).flatMap((raw) => {
        const model = Option.getOrUndefined(decodeModel(raw))
        if (!model || (model.type !== undefined && model.type !== "chat")) return []
        const api = Object.values(model.api ?? {})
          .flatMap((entry) => Option.toArray(decodeApi(entry)))
          .find((entry) => entry.sdk?.opencodeai || entry.sdk?.aisdk)
        return api?.base_url ? [api.base_url] : []
      })
      const baseURL = mostCommon(urls.filter((url) => url !== undefined))
      if (!baseURL || baseURL.includes("{") || !/^https:\/\//.test(baseURL)) return []
      return [
        {
          id: provider.id,
          name: provider.name,
          baseURL: baseURL.replace(/\/+$/, ""),
          ...(provider.doc ? { doc: provider.doc } : {}),
          env: [...(provider.env ?? [])],
        },
      ]
    })
    .toSorted((a, b) => a.name.localeCompare(b.name))
}

function mostCommon(values: string[]) {
  const counts = new Map<string, number>()
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1))
  return [...counts].reduce<[string, number] | undefined>(
    (best, entry) => (!best || entry[1] > best[1] ? entry : best),
    undefined,
  )?.[0]
}
