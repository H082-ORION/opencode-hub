import { Agent } from "@opencode/relay/agent/index"
import { Instances } from "@opencode/relay/agent/instances"
import { AgentSkills } from "@opencode/relay/agent/skills"
import { Service } from "@opencode/client/effect/service"
import { Global } from "@opencode/util/global"
import { Effect, FileSystem, Option, Schema } from "effect"
import path from "path"
import { ServiceConfig } from "./service-config"

// Enrollment with a hub, stored by `opencode agent join`, plus the service environment that routes the local
// service's LLM calls through the hub with the owner's instance token (personal machines).

export type Instance = Agent.Instance

export const TOKEN = Instances.TOKEN
export const CONFIG = Instances.CONFIG
export const INSTANCE = Instances.INSTANCE

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Agent.Enrollment))

export const file = Effect.fnUntraced(function* () {
  const global = yield* Global.Service
  return path.join(global.data, "agent.json")
})

/** Where an organization machine keeps its members' instances. */
export const instancesRoot = Effect.fnUntraced(function* () {
  const global = yield* Global.Service
  return path.join(global.data, "hub-instances")
})

export const read = Effect.fn("cli.relay-agent.read")(function* () {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(yield* file()).pipe(Effect.option)
  if (Option.isNone(text)) return undefined
  const enrollment = Option.getOrUndefined(decode(text.value))
  // Enrollments from protocol 1 also stored a machine-wide LLM token, now useless: the file is rewritten without it.
  if (enrollment && text.value.includes('"llmToken"')) yield* write(enrollment)
  return enrollment
})

export const write = Effect.fn("cli.relay-agent.write")(function* (enrollment: Agent.Enrollment) {
  const fs = yield* FileSystem.FileSystem
  const target = yield* file()
  yield* fs.makeDirectory(path.dirname(target), { recursive: true })
  // Only the declared fields: instance tokens never go into this file.
  const saved: Agent.Enrollment = {
    url: enrollment.url,
    machine: enrollment.machine,
    tunnelToken: enrollment.tunnelToken,
  }
  yield* fs.writeFileString(target, JSON.stringify(saved, null, 2) + "\n", { mode: 0o600 })
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
 * The personal instance whose token the service environment holds, so the agent announces it in HELLO, with the
 * version of the hub skills written for it.
 */
export const held = Effect.fn("cli.relay-agent.held")(function* () {
  const env = (yield* ServiceConfig.read()).env ?? {}
  const iid = env[INSTANCE]
  const token = env[TOKEN]
  if (!iid || !token) return []
  const written = AgentSkills.manifest(yield* skillsFolder())
  return [{ iid, token, ...(written?.iid === iid && written.version ? { skills: written.version } : {}) }]
})

/** The background service's skills folder (`<config>/skills`), where the owner's hub skills go as `hub-*`. */
export const skillsFolder = Effect.fnUntraced(function* () {
  const global = yield* Global.Service
  return AgentSkills.folder(global.config)
})

/**
 * Replaces the owner's hub skills in the service's skills folder, leaving the account's own skills alone, and makes a
 * running service reload its configuration when they changed.
 */
export const writeSkills = Effect.fn("cli.relay-agent.write-skills")(function* (payload: Agent.Skills) {
  const dir = yield* skillsFolder()
  const result = yield* Effect.try(() => AgentSkills.write(dir, payload))
  if (result.changed) yield* reloadService()
  return result
})

/**
 * Deletes the hub skills the agent wrote for an instance that `stale` says is gone (only the `hub-*` folders its
 * manifest lists), and makes a running service reload. Returns whether there were any.
 */
export const removeSkills = Effect.fn("cli.relay-agent.remove-skills")(function* (stale: (iid: string) => boolean) {
  const dir = yield* skillsFolder()
  const written = AgentSkills.manifest(dir)
  if (!written || !stale(written.iid)) return false
  yield* Effect.try(() => AgentSkills.remove(dir))
  yield* reloadService()
  return true
})

const reloadService = Effect.fnUntraced(function* () {
  const options = yield* ServiceConfig.options()
  const endpoint = yield* Service.discover({ ...options, version: undefined })
  if (!endpoint) return
  yield* Effect.tryPromise(() => AgentSkills.reload({ url: endpoint.url, password: endpoint.auth?.password }))
})

/**
 * Saves the service environment for the owner's instance (none to remove the hub's entries) and restarts a running
 * service when it changed, keeping persistent terminals. Returns whether the environment changed.
 */
export const apply = Effect.fn("cli.relay-agent.apply")(function* (instance: Agent.Instance | undefined) {
  const next = serviceEnv((yield* ServiceConfig.read()).env, instance)
  if (!next.changed) return false
  yield* ServiceConfig.replaceEnv(next.env)
  const options = yield* ServiceConfig.options()
  if (!(yield* Service.discover({ ...options, version: undefined }))) return true
  yield* Service.stop({ file: options.file, pty: "handoff" })
  yield* Service.ensure(options)
  return true
})

/** Removes the hub's entries from the service environment when they belong to `iid`, e.g. once it was dropped. */
export const clear = Effect.fn("cli.relay-agent.clear")(function* (iid: string) {
  if ((yield* ServiceConfig.read()).env?.[INSTANCE] !== iid) return false
  return yield* apply(undefined)
})

/**
 * The service environment for the owner's instance: its id, its token and the configuration that sends every hub
 * provider's calls to `<hub>/llm/<id>` (see `Instances.hubEnv`). Stored credentials still take precedence over
 * environment variables. Without an instance, the hub's entries are removed.
 */
export function serviceEnv(
  current: Readonly<Record<string, string>> | undefined,
  instance: Agent.Instance | undefined,
) {
  const { [TOKEN]: _token, [CONFIG]: _config, [INSTANCE]: _instance, ...rest } = current ?? {}
  const env = instance ? { ...rest, ...Instances.hubEnv(instance) } : rest
  return { env, changed: !same(current ?? {}, env) }
}

function same(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

export * as RelayAgent from "./relay-agent"
