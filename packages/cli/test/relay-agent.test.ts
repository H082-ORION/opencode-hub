import { expect, test } from "bun:test"
import { RelayAgent } from "../src/services/relay-agent"

const llm = {
  baseURL: "https://hub.example.com/llm/",
  providers: [
    { id: "anthropic", name: "Anthropic" },
    { id: "openai", name: "OpenAI" },
  ],
}

test("routes every hub provider to the hub with the LLM token", () => {
  const result = RelayAgent.serviceEnv({ OTHER: "kept" }, llm, "token")
  expect(result.changed).toBe(true)
  expect(result.env.OTHER).toBe("kept")
  expect(result.env[RelayAgent.TOKEN]).toBe("token")
  expect(JSON.parse(result.env[RelayAgent.CONFIG])).toEqual({
    providers: {
      anthropic: { env: [RelayAgent.TOKEN], settings: { baseURL: "https://hub.example.com/llm/anthropic" } },
      openai: { env: [RelayAgent.TOKEN], settings: { baseURL: "https://hub.example.com/llm/openai" } },
    },
  })
})

test("reports no change when the environment already matches", () => {
  const first = RelayAgent.serviceEnv(undefined, llm, "token")
  expect(RelayAgent.serviceEnv(first.env, llm, "token")).toEqual({ env: first.env, changed: false })
})

test("reports a change when the provider list or token changes", () => {
  const first = RelayAgent.serviceEnv(undefined, llm, "token")
  expect(RelayAgent.serviceEnv(first.env, { ...llm, providers: llm.providers.slice(0, 1) }, "token").changed).toBe(true)
  expect(RelayAgent.serviceEnv(first.env, llm, "other").changed).toBe(true)
})

test("removes the hub entries when the hub offers no providers", () => {
  const first = RelayAgent.serviceEnv({ OTHER: "kept" }, llm, "token")
  expect(RelayAgent.serviceEnv(first.env, { ...llm, providers: [] }, "token")).toEqual({
    env: { OTHER: "kept" },
    changed: true,
  })
  expect(RelayAgent.serviceEnv({ OTHER: "kept" }, { ...llm, providers: [] }, "token").changed).toBe(false)
  expect(RelayAgent.serviceEnv(undefined, { ...llm, providers: [] }, "token").changed).toBe(false)
})
