import { Agent } from "@opencode/relay/agent/index"
import { Service } from "@opencode/client/effect/service"
import { Global } from "@opencode/util/global"
import { Effect, FileSystem, Option, Schema } from "effect"
import path from "path"
import { ServiceConfig } from "./service-config"

// Enrollment with a hub, stored by `opencode agent join`, plus the service environment that routes the local
// service's LLM calls through the hub.

export type LlmConfig = Agent.LlmConfig

// The hub's LLM token. Every hub provider reads it through the `env` override that serviceEnv writes into CONFIG.
export const TOKEN = "OPENCODE_HUB_LLM_TOKEN"
export const CONFIG = "OPENCODE_CONFIG_CONTENT"

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Agent.Enrollment))

export const file = Effect.fnUntraced(function* () {
  const global = yield* Global.Service
  return path.join(global.data, "agent.json")
})

export const read = Effect.fn("cli.relay-agent.read")(function* () {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(yield* file()).pipe(Effect.option)
  if (Option.isNone(text)) return undefined
  return Option.getOrUndefined(decode(text.value))
})

export const write = Effect.fn("cli.relay-agent.write")(function* (enrollment: Agent.Enrollment) {
  const fs = yield* FileSystem.FileSystem
  const target = yield* file()
  yield* fs.makeDirectory(path.dirname(target), { recursive: true })
  yield* fs.writeFileString(target, JSON.stringify(enrollment, null, 2) + "\n", { mode: 0o600 })
  // The mode applies only when the file is created; an earlier enrollment's file keeps its own.
  yield* fs.chmod(target, 0o600)
})

export const remove = Effect.fn("cli.relay-agent.remove")(function* () {
  const fs = yield* FileSystem.FileSystem
  const target = yield* file()
  if (!(yield* fs.exists(target))) return false
  yield* fs.remove(target)
  return true
})

/**
 * Saves the service environment for `llm` and restarts a running service when it changed, keeping persistent
 * terminals. Returns whether the environment changed.
 */
export const apply = Effect.fn("cli.relay-agent.apply")(function* (llm: LlmConfig, token: string) {
  const next = serviceEnv((yield* ServiceConfig.read()).env, llm, token)
  if (!next.changed) return false
  yield* ServiceConfig.replaceEnv(next.env)
  const options = yield* ServiceConfig.options()
  if (!(yield* Service.discover({ ...options, version: undefined }))) return true
  yield* Service.stop({ file: options.file, pty: "handoff" })
  yield* Service.ensure(options)
  return true
})

/**
 * The service environment that sends every hub provider's calls to `<hub>/llm/<id>` with the LLM token as API key.
 * Each provider's `env` override replaces its catalog variables (ANTHROPIC_API_KEY, ...), so a key inherited from the
 * user's shell is never sent to the hub. Stored credentials still take precedence over environment variables.
 */
export function serviceEnv(current: Readonly<Record<string, string>> | undefined, llm: LlmConfig, token: string) {
  const { [TOKEN]: _token, [CONFIG]: _config, ...rest } = current ?? {}
  const base = llm.baseURL.replace(/\/+$/, "")
  const env =
    llm.providers.length === 0
      ? rest
      : {
          ...rest,
          [TOKEN]: token,
          [CONFIG]: JSON.stringify({
            providers: Object.fromEntries(
              llm.providers.map((provider) => [
                provider.id,
                { env: [TOKEN], settings: { baseURL: `${base}/${encodeURIComponent(provider.id)}` } },
              ]),
            ),
          }),
        }
  return { env, changed: !same(current ?? {}, env) }
}

function same(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

export * as RelayAgent from "./relay-agent"
