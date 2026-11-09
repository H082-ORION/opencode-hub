import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import type { Instance, Local, Skills } from "./index.js"
import { AgentSkills } from "./skills.js"

export * as Instances from "./instances.js"

// The instance's LLM token. Every hub provider reads it through the `env` override in CONFIG.
export const TOKEN = "OPENCODE_HUB_LLM_TOKEN"
export const CONFIG = "OPENCODE_CONFIG_CONTENT"
/** Which hub instance a configuration belongs to, so the agent finds its token again after a restart. */
export const INSTANCE = "OPENCODE_HUB_INSTANCE"

// Directory names are instance ids, which the protocol restricts to this alphabet.
const IID = /^[A-Za-z0-9_-]{16,64}$/
// Variables the instance must not inherit from the agent: they would point it at the agent's own configuration,
// data or credentials.
const INHERITED =
  /^(XDG_(DATA|CONFIG|STATE|CACHE)_HOME|OPENCODE_(CONFIG|CONFIG_DIR|CONFIG_CONTENT|PASSWORD|SERVER_PASSWORD|HUB_LLM_TOKEN|HUB_INSTANCE))$/
const START_TIMEOUT = 120_000
const STOP_TIMEOUT = 10_000
const decodeReady = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ url: Schema.String })))

/** Connectors become remote MCP servers named `hub-<id>`, so they never replace a server configured on the machine. */
export const MCP_PREFIX = "hub-"

/**
 * The environment that sends every hub provider's calls to `<hub>/llm/<id>` with the instance token as API key, and
 * reaches every hub connector as the remote MCP server `hub-<id>` at `<hub>/mcp/<id>` with the same token. Each
 * provider's `env` override replaces its catalog variables (ANTHROPIC_API_KEY, ...), so a key inherited from the
 * shell is never sent to the hub. The MCP servers read the token from the environment too (`{env:...}`), and have
 * opencode's own OAuth off: the hub holds their credentials.
 */
export function hubEnv(instance: Instance, extra: Readonly<Record<string, unknown>> = {}): Record<string, string> {
  const base = instance.llm.baseURL.replace(/\/+$/, "")
  const providers = instance.llm.providers
  const connectors = instance.mcp
  const config = {
    ...extra,
    ...(providers.length === 0
      ? {}
      : {
          providers: Object.fromEntries(
            providers.map((provider) => [
              provider.id,
              { env: [TOKEN], settings: { baseURL: `${base}/${encodeURIComponent(provider.id)}` } },
            ]),
          ),
        }),
    ...(connectors.length === 0
      ? {}
      : {
          mcp: {
            servers: Object.fromEntries(
              connectors.map((connector) => [
                `${MCP_PREFIX}${connector.id}`,
                {
                  type: "remote",
                  url: connector.url,
                  headers: { Authorization: `Bearer {env:${TOKEN}}` },
                  oauth: false,
                },
              ]),
            ),
          },
        }),
  }
  return {
    [INSTANCE]: instance.iid,
    [TOKEN]: instance.token,
    ...(Object.keys(config).length === 0 ? {} : { [CONFIG]: JSON.stringify(config) }),
  }
}

/** Where an instance's opencode loads its skills from: its own configuration folder. */
export function skillsFolder(root: string, iid: string) {
  return AgentSkills.folder(path.join(directories(root, iid).XDG_CONFIG_HOME, "opencode"))
}

/** The data, configuration, state and cache directories of an instance, under its own folder. */
export function directories(root: string, iid: string) {
  const dir = path.join(root, iid)
  return {
    dir,
    XDG_DATA_HOME: path.join(dir, "data"),
    XDG_CONFIG_HOME: path.join(dir, "config"),
    XDG_STATE_HOME: path.join(dir, "state"),
    XDG_CACHE_HOME: path.join(dir, "cache"),
  }
}

type Running = { child: ChildProcess; local: Local; key: string; exited: Promise<void> }

/**
 * The instances of an organization machine: one opencode server per member, started on demand from `command` (which
 * must accept `--stdio --port 0`, like `opencode serve`), each with its own XDG directories under `<root>/<iid>/`,
 * its own port and its own random password. Every instance runs under the agent's system account. A server holds its
 * stdin as a lease, so it also stops when the agent dies.
 */
export function create(input: {
  root: string
  command: readonly string[]
  /** The environment instances inherit; defaults to this process's. */
  env?: Readonly<Record<string, string | undefined>>
  /**
   * Where the servers start; defaults to the agent's own directory, which a source checkout needs (Bun reads the CLI's
   * bunfig.toml from there).
   */
  cwd?: string
  /** Configuration every instance gets besides its providers and connectors. */
  config?: Readonly<Record<string, unknown>>
  log?: (message: string) => void
}) {
  const envKey = (instance: Instance) => JSON.stringify(hubEnv(instance, input.config))
  const configs = new Map<string, Instance>()
  const running = new Map<string, Promise<Running>>()
  // Drops in progress, so stopping the agent waits for their folders to be deleted.
  const dropping = new Set<Promise<void>>()
  // Skill writes in progress, one at a time per instance; an instance starts only once its skills are written.
  const writing = new Map<string, Promise<unknown>>()

  return {
    /** Records an instance's configuration; a running instance whose environment changed is stopped, to restart. */
    async configure(instance: Instance) {
      requireIID(instance.iid)
      configs.set(instance.iid, instance)
      const current = await running.get(instance.iid)?.catch(() => undefined)
      if (current && current.key !== envKey(instance)) await stop(instance.iid)
    },

    /** The local server of a configured instance, started if it is not running. */
    local(iid: string): Promise<Local> {
      const known = running.get(iid)
      if (known) return known.then((entry) => entry.local)
      const config = configs.get(iid)
      if (!config) return Promise.reject(new Error(`unknown instance ${iid}`))
      const started = start(config)
      running.set(iid, started)
      started.then(
        (entry) => entry.exited.then(() => running.get(iid) === started && running.delete(iid)),
        (error: unknown) => {
          input.log?.(error instanceof Error ? error.message : String(error))
          if (running.get(iid) === started) running.delete(iid)
        },
      )
      return started.then((entry) => entry.local)
    },

    /**
     * Writes an instance's hub skills into its configuration folder, after any write still in progress, then makes
     * its server reload them if it is running (a server that starts later reads them anyway).
     */
    async skills(payload: Skills) {
      requireIID(payload.iid)
      if (!configs.has(payload.iid)) throw new Error(`unknown instance ${payload.iid}`)
      const write = (writing.get(payload.iid) ?? Promise.resolve()).then(() => {
        secure(input.root)
        secure(directories(input.root, payload.iid).dir)
        return AgentSkills.write(skillsFolder(input.root, payload.iid), payload)
      })
      const settled = write.catch(() => undefined)
      writing.set(payload.iid, settled)
      void settled.then(() => writing.get(payload.iid) === settled && writing.delete(payload.iid))
      const result = await write
      result.skipped.forEach((name) => input.log?.(`Skipped hub skill ${name}: a local skill has this folder name`))
      if (!result.changed) return
      const current = await running.get(payload.iid)?.catch(() => undefined)
      if (current) await AgentSkills.reload(current.local)
      input.log?.(`Wrote ${result.written.length} hub skills for instance ${payload.iid}`)
    },

    drop,

    /** Drops every instance whose folder exists or that is configured, except those in `valid`. */
    async prune(valid: Iterable<string>) {
      const keep = new Set(valid)
      secure(input.root)
      const present = readdirSync(input.root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && IID.test(entry.name))
        .map((entry) => entry.name)
        .concat(Array.from(configs.keys()))
      await Promise.all(
        Array.from(new Set(present))
          .filter((iid) => !keep.has(iid))
          .map(drop),
      )
    },

    /** Whether an instance's server is running, for tests and status. */
    running: (iid: string) => running.has(iid),

    /** Stops one instance, keeping its folder; the next `local` starts it again. */
    halt: (iid: string) => stop(iid),

    /** Stops every running instance, keeping their folders, once the drops in progress are done. */
    async stop() {
      await Promise.all([...dropping, ...Array.from(running.keys(), stop)])
    },
  }

  /** Stops an instance and deletes its folder: sessions, configuration, tokens. */
  function drop(iid: string) {
    if (!IID.test(iid)) return Promise.resolve()
    configs.delete(iid)
    // A skill write still in progress would otherwise recreate the folder.
    const done = Promise.all([stop(iid), writing.get(iid)]).then(() => {
      rmSync(path.join(input.root, iid), { recursive: true, force: true })
      input.log?.(`Deleted instance ${iid}`)
    })
    dropping.add(done)
    return done.finally(() => dropping.delete(done))
  }

  async function start(instance: Instance): Promise<Running> {
    await writing.get(instance.iid)
    const dirs = directories(input.root, instance.iid)
    secure(input.root)
    secure(dirs.dir)
    const password = randomBytes(32).toString("base64url")
    const inherited = Object.entries(input.env ?? process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !INHERITED.test(entry[0]),
    )
    const [executable, ...args] = input.command
    if (!executable) throw new Error("missing instance command")
    const child = spawn(executable, [...args, "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: input.cwd ?? process.cwd(),
      env: {
        ...Object.fromEntries(inherited),
        XDG_DATA_HOME: dirs.XDG_DATA_HOME,
        XDG_CONFIG_HOME: dirs.XDG_CONFIG_HOME,
        XDG_STATE_HOME: dirs.XDG_STATE_HOME,
        XDG_CACHE_HOME: dirs.XDG_CACHE_HOME,
        OPENCODE_PASSWORD: password,
        ...hubEnv(instance, input.config),
      },
      // The server treats EOF on stdin as the end of its lease: it stops when the agent closes it or dies.
      stdio: ["pipe", "pipe", "pipe"],
    })
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    const errors = { text: "" }
    child.stderr?.on("data", (chunk: Buffer) => (errors.text = (errors.text + chunk.toString()).slice(-2000)))
    const url = await readyURL(child, exited).catch((error: unknown) => {
      child.kill("SIGKILL")
      const detail = errors.text.trim()
      throw new Error(`instance ${instance.iid} did not start: ${String(error)}${detail ? `\n${detail}` : ""}`)
    })
    input.log?.(`Started instance ${instance.iid} on ${url}`)
    return { child, local: { url, password }, key: envKey(instance), exited }
  }

  async function stop(iid: string) {
    const entry = await running.get(iid)?.catch(() => undefined)
    running.delete(iid)
    if (!entry || entry.child.exitCode !== null || entry.child.signalCode !== null) return
    // Closing the lease lets the server shut down cleanly; a server that hangs is killed.
    entry.child.stdin?.end()
    const timer = setTimeout(() => entry.child.kill("SIGKILL"), STOP_TIMEOUT)
    await entry.exited
    clearTimeout(timer)
    input.log?.(`Stopped instance ${iid}`)
  }
}

export type Manager = ReturnType<typeof create>

/** The first stdout line of `serve --stdio` is `{ "url": ... }`; stdout keeps being drained afterwards. */
function readyURL(child: ChildProcess, exited: Promise<void>) {
  const ready = Promise.withResolvers<string>()
  const buffer = { text: "" }
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer.text += chunk.toString()
    const lines = buffer.text.split("\n")
    buffer.text = lines.pop() ?? ""
    lines.forEach((line) => {
      const parsed = Option.getOrUndefined(decodeReady(line))
      if (parsed) ready.resolve(parsed.url)
    })
  })
  void exited.then(() => ready.reject(new Error("exited before it was ready")))
  const timer = setTimeout(() => ready.reject(new Error("timed out")), START_TIMEOUT)
  return ready.promise.finally(() => clearTimeout(timer))
}

function requireIID(iid: string) {
  if (!IID.test(iid)) throw new Error(`invalid instance id ${iid}`)
}

/** Instance folders hold sessions and tokens: owner-only. */
function secure(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}
