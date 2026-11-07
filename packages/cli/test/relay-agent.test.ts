import { NodeServices } from "@effect/platform-node"
import { Global } from "@opencode/util/global"
import { expect, test } from "bun:test"
import { Effect, FileSystem } from "effect"
import path from "node:path"
import { RelayAgent } from "../src/services/relay-agent"
import { ServiceConfig } from "../src/services/service-config"
import { it } from "../../core/test/lib/effect"

const instance: RelayAgent.Instance = {
  iid: "owner-instance-0001",
  token: "token",
  llm: {
    baseURL: "https://hub.example.com/llm/",
    providers: [
      { id: "anthropic", name: "Anthropic" },
      { id: "openai", name: "OpenAI" },
    ],
  },
  mcp: [],
  skills: { version: "none" },
}

test("routes every hub provider to the hub with the instance token", () => {
  const result = RelayAgent.serviceEnv({ OTHER: "kept" }, instance)
  expect(result.changed).toBe(true)
  expect(result.env.OTHER).toBe("kept")
  expect(result.env[RelayAgent.TOKEN]).toBe("token")
  expect(result.env[RelayAgent.INSTANCE]).toBe(instance.iid)
  expect(JSON.parse(result.env[RelayAgent.CONFIG])).toEqual({
    providers: {
      anthropic: { env: [RelayAgent.TOKEN], settings: { baseURL: "https://hub.example.com/llm/anthropic" } },
      openai: { env: [RelayAgent.TOKEN], settings: { baseURL: "https://hub.example.com/llm/openai" } },
    },
  })
})

test("reaches every hub connector as the remote MCP server hub-<id>, also without providers", () => {
  const connectors = {
    ...instance,
    llm: { ...instance.llm, providers: [] },
    mcp: [{ id: "github", name: "GitHub", url: "https://hub.example.com/mcp/github" }],
  }
  const result = RelayAgent.serviceEnv(undefined, connectors)
  expect(JSON.parse(result.env[RelayAgent.CONFIG])).toEqual({
    mcp: {
      servers: {
        "hub-github": {
          type: "remote",
          url: "https://hub.example.com/mcp/github",
          headers: { Authorization: `Bearer {env:${RelayAgent.TOKEN}}` },
          oauth: false,
        },
      },
    },
  })
  // The token itself stays in its own variable.
  expect(result.env[RelayAgent.CONFIG]).not.toContain("token")
  expect(RelayAgent.serviceEnv(result.env, { ...connectors, mcp: [] }).changed).toBe(true)
})

test("reports no change when the environment already matches", () => {
  const first = RelayAgent.serviceEnv(undefined, instance)
  expect(RelayAgent.serviceEnv(first.env, instance)).toEqual({ env: first.env, changed: false })
})

test("reports a change when the provider list, the token or the instance changes", () => {
  const first = RelayAgent.serviceEnv(undefined, instance)
  const fewer = { ...instance, llm: { ...instance.llm, providers: instance.llm.providers.slice(0, 1) } }
  expect(RelayAgent.serviceEnv(first.env, fewer).changed).toBe(true)
  expect(RelayAgent.serviceEnv(first.env, { ...instance, token: "other" }).changed).toBe(true)
  expect(RelayAgent.serviceEnv(first.env, { ...instance, iid: "another-instance-01" }).changed).toBe(true)
})

test("keeps the instance and its token without providers, and removes every hub entry without an instance", () => {
  const empty = { ...instance, llm: { ...instance.llm, providers: [] } }
  const first = RelayAgent.serviceEnv({ OTHER: "kept" }, instance)
  expect(RelayAgent.serviceEnv(first.env, empty)).toEqual({
    env: { OTHER: "kept", [RelayAgent.INSTANCE]: instance.iid, [RelayAgent.TOKEN]: "token" },
    changed: true,
  })
  expect(RelayAgent.serviceEnv(first.env, undefined)).toEqual({ env: { OTHER: "kept" }, changed: true })
  expect(RelayAgent.serviceEnv({ OTHER: "kept" }, undefined).changed).toBe(false)
  expect(RelayAgent.serviceEnv(undefined, undefined).changed).toBe(false)
})

it.live("agent.json keeps no LLM token, and an old one loses its token when read", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-relay-agent-" })
    const data = path.join(root, "data")
    const enrollment = {
      url: "https://hub.example.com",
      machine: { id: "box", name: "Box" },
      tunnelToken: "tunnel-secret",
    }
    yield* Effect.gen(function* () {
      const file = yield* RelayAgent.file()
      // An enrollment from protocol 1, with its machine-wide LLM token.
      yield* fs.makeDirectory(data, { recursive: true })
      yield* fs.writeFileString(file, JSON.stringify({ ...enrollment, llmToken: "old-llm-token" }))
      expect(yield* RelayAgent.read()).toEqual(enrollment)
      expect(yield* fs.readFileString(file)).not.toContain("old-llm-token")
      expect(yield* RelayAgent.read()).toEqual(enrollment)

      // Writing never copies anything else, such as an instance token, into the file.
      yield* RelayAgent.write({ ...enrollment, ...{ token: "instance-token" } })
      expect(JSON.parse(yield* fs.readFileString(file))).toEqual(enrollment)
      expect(((yield* fs.stat(file)).mode & 0o777).toString(8)).toBe("600")
    }).pipe(
      Effect.provideService(
        Global.Service,
        Global.make({ data, config: path.join(root, "config"), state: path.join(root, "state") }),
      ),
    )
  }).pipe(Effect.provide(NodeServices.layer)),
)

it.live("the personal instance's token is found again in the service environment, and cleared only for it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-relay-agent-" })
    const config = path.join(root, "config")
    const state = path.join(root, "state")
    yield* fs.makeDirectory(config, { recursive: true })
    yield* fs.makeDirectory(state, { recursive: true })
    yield* Effect.gen(function* () {
      expect(yield* RelayAgent.held()).toEqual([])
      // No service is running here, so applying only saves the environment.
      expect(yield* RelayAgent.apply(instance)).toBe(true)
      expect(yield* RelayAgent.held()).toEqual([{ iid: instance.iid, token: "token" }])
      expect(yield* RelayAgent.apply(instance)).toBe(false)
      expect(yield* RelayAgent.clear("another-instance-01")).toBe(false)
      expect(yield* RelayAgent.clear(instance.iid)).toBe(true)
      expect(yield* RelayAgent.held()).toEqual([])
      expect((yield* ServiceConfig.read()).env).toBeUndefined()
    }).pipe(Effect.provideService(Global.Service, Global.make({ config, state })))
  }).pipe(Effect.provide(NodeServices.layer)),
)

it.live("the owner's hub skills go into the service's skills folder as hub-*, and a drop removes only those", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-relay-agent-" })
    const config = path.join(root, "config")
    const state = path.join(root, "state")
    const skills = path.join(config, "skills")
    yield* fs.makeDirectory(path.join(skills, "mine"), { recursive: true })
    yield* fs.writeFileString(path.join(skills, "mine", "SKILL.md"), "local")
    yield* fs.makeDirectory(state, { recursive: true })
    const entry = { path: "SKILL.md", content: "---\nname: review\ndescription: Reviews.\n---\n" }
    yield* Effect.gen(function* () {
      expect(yield* RelayAgent.skillsFolder()).toBe(skills)
      // No service is running here, so nothing is reloaded.
      const written = yield* RelayAgent.writeSkills({
        iid: instance.iid,
        version: "v1",
        skills: [{ name: "review", files: [entry] }],
      })
      expect(written).toMatchObject({ changed: true, written: ["hub-review"] })
      expect(yield* fs.readFileString(path.join(skills, "hub-review", "SKILL.md"))).toBe(entry.content)
      // The version written is announced with the instance's token.
      yield* RelayAgent.apply(instance)
      expect(yield* RelayAgent.held()).toEqual([{ iid: instance.iid, token: "token", skills: "v1" }])
      // A drop of another instance leaves them; a drop of this one removes the hub's folders only.
      expect(yield* RelayAgent.removeSkills((iid) => iid === "another-instance-01")).toBe(false)
      expect(yield* RelayAgent.removeSkills((iid) => iid === instance.iid)).toBe(true)
      expect((yield* fs.readDirectory(skills)).toSorted()).toEqual(["mine"])
      expect(yield* fs.readFileString(path.join(skills, "mine", "SKILL.md"))).toBe("local")
      expect(yield* RelayAgent.held()).toEqual([{ iid: instance.iid, token: "token" }])
    }).pipe(Effect.provideService(Global.Service, Global.make({ config, state })))
  }).pipe(Effect.provide(NodeServices.layer)),
)
