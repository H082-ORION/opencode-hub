import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Catalog } from "../src/hub/catalog.js"

const chat = (...apis: [string, { base_url?: string; sdk?: { aisdk?: string; opencodeai?: string } }][]) => ({
  type: "chat",
  api: Object.fromEntries(apis),
})
const sdk = { aisdk: "@ai-sdk/openai-compatible" }

const catalog = {
  mistral: {
    id: "mistral",
    name: "Mistral",
    doc: "https://docs.mistral.ai",
    env: ["MISTRAL_API_KEY"],
    models: { a: chat(["chat-completions", { base_url: "https://api.mistral.ai/v1/", sdk }]) },
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    env: ["DEEPSEEK_API_KEY"],
    models: {
      a: chat(
        ["chat-completions", { base_url: "https://api.deepseek.com", sdk }],
        ["messages", { base_url: "https://api.deepseek.com/anthropic/v1", sdk }],
      ),
      b: chat(["chat-completions", { base_url: "https://api.deepseek.com", sdk }]),
      c: chat(["messages", { base_url: "https://api.deepseek.com/anthropic/v1", sdk }]),
    },
  },
  // The first API without an SDK is skipped, like opencode does.
  skipping: {
    id: "skipping",
    name: "Skipping",
    models: {
      a: chat(["x", { base_url: "https://wrong.example" }], ["y", { base_url: "https://right.example/v1", sdk }]),
    },
  },
  azure: {
    id: "azure",
    name: "Azure",
    models: { a: chat(["responses", { base_url: "https://${AZURE_RESOURCE_NAME}.openai.azure.com/openai", sdk }]) },
  },
  partial: {
    id: "partial",
    name: "Partial",
    models: { a: chat(["x", { base_url: "https://p.example", sdk }]), b: chat(["x", { base_url: "", sdk }]) },
  },
  images: {
    id: "images",
    name: "Images only",
    models: { a: { type: "image", api: { x: { base_url: "https://img.example", sdk } } } },
  },
  broken: { name: 3 },
}

const dirs: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opencode-catalog-"))
  dirs.push(dir)
  return dir
}
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

describe("catalog", () => {
  test("derives each provider's base URL the way opencode does", () => {
    expect(Catalog.parse(catalog)).toEqual([
      { id: "deepseek", name: "DeepSeek", baseURL: "https://api.deepseek.com", env: ["DEEPSEEK_API_KEY"] },
      {
        id: "mistral",
        name: "Mistral",
        baseURL: "https://api.mistral.ai/v1",
        doc: "https://docs.mistral.ai",
        env: ["MISTRAL_API_KEY"],
      },
      { id: "partial", name: "Partial", baseURL: "https://p.example", env: [] },
      { id: "skipping", name: "Skipping", baseURL: "https://right.example/v1", env: [] },
    ])
  })

  test("fetches once, caches on disk and serves the cache to a new instance", async () => {
    const data = tempDir()
    const calls = { count: 0 }
    const fetch = (async () => {
      calls.count++
      return Response.json(catalog)
    }) as unknown as typeof globalThis.fetch
    const first = Catalog.create({ data, fetch })
    const [a, b] = await Promise.all([first.list(), first.list()])
    expect(a.map((entry) => entry.id)).toEqual(["deepseek", "mistral", "partial", "skipping"])
    expect(b).toEqual(a)
    expect(calls.count).toBe(1)
    const second = Catalog.create({ data, fetch })
    expect((await second.find("mistral"))?.baseURL).toBe("https://api.mistral.ai/v1")
    expect(calls.count).toBe(1)
  })

  test("falls back to the built-in list when the catalog cannot be fetched", async () => {
    const fetch = (async () => new Response("down", { status: 503 })) as unknown as typeof globalThis.fetch
    const entries = await Catalog.create({ data: tempDir(), fetch }).list()
    expect(entries).toEqual(Catalog.FALLBACK)
  })

  test("refreshes a stale cache in the background", async () => {
    const data = tempDir()
    const clock = { now: 0 }
    const responses = [catalog, { mistral: catalog.mistral }]
    const fetch = (async () => Response.json(responses.shift())) as unknown as typeof globalThis.fetch
    const instance = Catalog.create({ data, fetch, now: () => clock.now })
    expect(await instance.list()).toHaveLength(4)
    clock.now = 25 * 60 * 60 * 1000
    expect(await instance.list()).toHaveLength(4)
    await Bun.sleep(0)
    expect(await instance.list()).toHaveLength(1)
  })
})
