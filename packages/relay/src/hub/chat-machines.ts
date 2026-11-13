import { Option, Schema } from "effect"
import { json, type Current } from "./accounts.js"
import type { Store } from "./store.js"

export * as ChatMachines from "./chat-machines.js"

const POLL_EVERY = 2000
/** Failed polls in a row before giving up: long enough for a machine to reconnect. */
const MAX_POLL_FAILURES = 150
const MAX_RESULT = 60_000
const MAX_SHELL_OUTPUT = 20_000
const MAX_FOUND = 50
/** `metadata.source` of the messages that record a command or shell command run on a machine from the hub's chat. */
const RECORD_SOURCE = "hub-machine"
/** How long a shell command has to be refused before it is reported as running: the machine answers when it ends. */
const SHELL_GRACE = 1000
/** Polls in a row without the remote session working before a command that started no agent run counts as done. */
const SETTLED_POLLS = 2
/** The agent's own route for creating a folder. */
const MKDIR = "/__hub/mkdir"

const MACHINE = /^chat-machines\/([^/]+)\/(projects|directories|commands|files)$/
const TARGET = /^chat-targets\/([A-Za-z0-9_-]+)(?:\/(command|shell|run))?$/
const FOLDER_NAME = /^(?!\.{1,2}$)[^/\\\0]{1,255}$/
const COMMAND_NAME = /^[^\s/]\S{0,199}$/
const DENIED_REPLY =
  "No one can approve this from the hub. Carry on without it, or say what you need in your final message."

const decodeTarget = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ machine: Schema.String, directory: Schema.String })),
)
const decodeNewFolder = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ parent: Schema.String, name: Schema.String })),
)
const decodeLocation = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.optional(Schema.Struct({ directory: Schema.String })),
      directory: Schema.optional(Schema.String),
    }),
  ),
)
const decodeEntries = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ data: Schema.Array(Schema.Struct({ path: Schema.String, type: Schema.String })) }),
  ),
)
const Project = Schema.Struct({ id: Schema.String, canonical: Schema.String, name: Schema.optional(Schema.String) })
const decodeProjects = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([Schema.Array(Project), Schema.Struct({ data: Schema.Array(Project) })])),
)
const decodeCreated = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })),
)
const Message = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  time: Schema.Struct({ created: Schema.Number }),
  outcome: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }))),
  command: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  exit: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.Struct({ output: Schema.String, truncated: Schema.optional(Schema.Boolean) })),
})
const decodeMessages = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ data: Schema.Array(Message) })))
const decodePermissions = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) })),
)
const decodeCommands = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.optional(Schema.String) })),
    }),
  ),
)
const decodeCommandRun = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String, arguments: Schema.optional(Schema.String) })),
)
const decodeShellRun = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ command: Schema.String })))
const decodeActive = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: Schema.Record(Schema.String, Schema.Unknown) })),
)
const decodeTag = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ _tag: Schema.String })))

type Call = (method: string, path: string, body?: unknown) => Promise<Response>
type Task = { user: string; session: string; signal: AbortSignal }
/**
 * A message the hub adds to a chat session. Without `resume` it waits for the user's next prompt; with it, the model
 * answers it now, after anything already queued when `delivery` is `queue`. A known `id` is not added twice.
 */
export type Recorded = {
  text: string
  description: string
  metadata: Record<string, unknown>
  id?: string
  delivery?: "steer" | "queue"
  resume?: boolean
}

type Request_ = {
  user: string
  machine: string
  method: string
  path: string
  body?: unknown
  signal?: AbortSignal
}

/**
 * What ties the hub's chat to the machines: the projects and folders of a user's machine, the machine and folder a chat
 * session is attached to, and the tasks that session runs there. Every call goes through `request`, which checks access
 * to the machine each time.
 */
export function create(input: {
  store: Store.Instance
  request: (request: Request_) => Promise<Response>
  online: (machine: string) => boolean
  model: (user: string, session: string) => Promise<{ id: string; providerID: string; variant?: string } | undefined>
  /** Adds a message to a chat session without starting the model. */
  record: (user: string, session: string, message: Recorded) => Promise<unknown>
  log?: (message: string) => void
  /** Milliseconds between polls of a machine's session; tests shorten it. */
  pollEvery?: number
}) {
  const store = input.store
  const pollEvery = input.pollEvery ?? POLL_EVERY
  /** Commands and shell commands running from a chat session, by user and session. */
  const runs = new Map<string, AbortController>()
  /** Why the last one failed, by user and session, until the next one starts. */
  const failures = new Map<string, string>()

  return {
    async handle(request: Request, route: string, current: Current) {
      const user = current.user.id
      const machine = MACHINE.exec(route)
      if (machine) return machines(request, user, decodeURIComponent(machine[1]!), machine[2]!)
      const target = TARGET.exec(route)
      if (target) return targets(request, user, target[1]!, target[2])
      return undefined
    },

    /** What to tell the model the first time it answers after a target was attached. */
    note(user: string, session: string) {
      const target = store.chatTarget(user, session)
      if (!target || target.announced) return undefined
      store.setChatAnnounced(user, session)
      const machine = store.machine(target.machine_id)
      return `The user attached the machine "${machine?.name ?? target.machine_id}" to this conversation, on the project in ${target.directory}. Use machine_task for requests about that project or machine: it works there by default.`
    },
  }

  async function machines(request: Request, user: string, machine: string, kind: string) {
    if (kind === "projects" && request.method === "GET") return projects(user, machine)
    if (kind === "directories" && request.method === "GET")
      return directories(user, machine, new URL(request.url).searchParams.get("path") ?? undefined)
    if (kind === "directories" && request.method === "POST") return createDirectory(request, user, machine)
    if (kind === "commands" && request.method === "GET") return commands(request, user, machine)
    if (kind === "files" && request.method === "GET") return files(request, user, machine)
    return json(404, { error: "Not found." })
  }

  async function commands(request: Request, user: string, machine: string) {
    const directory = new URL(request.url).searchParams.get("directory")
    if (!directory?.startsWith("/")) return json(400, { error: "Expected an absolute directory." })
    const response = await input.request({
      user,
      machine,
      method: "GET",
      path: `/api/command?${new URLSearchParams({ "location[directory]": directory })}`,
    })
    if (!response.ok) return passError(response)
    const parsed = Option.getOrUndefined(decodeCommands(await response.text()))
    return json(200, {
      data: (parsed?.data ?? []).map((command) => ({
        name: command.name,
        ...(command.description === undefined ? {} : { description: command.description }),
      })),
    })
  }

  async function files(request: Request, user: string, machine: string) {
    const search = new URL(request.url).searchParams
    const directory = search.get("directory")
    if (!directory?.startsWith("/")) return json(400, { error: "Expected an absolute directory." })
    const query = new URLSearchParams({
      query: search.get("query") ?? "",
      type: "file",
      limit: String(MAX_FOUND),
      "location[directory]": directory,
    })
    const response = await input.request({ user, machine, method: "GET", path: `/api/fs/find?${query}` })
    if (!response.ok) return passError(response)
    const parsed = Option.getOrUndefined(decodeEntries(await response.text()))
    return json(200, {
      data: (parsed?.data ?? [])
        .filter((entry) => entry.type === "file")
        .map((entry) => entry.path)
        .slice(0, MAX_FOUND),
    })
  }

  async function projects(user: string, machine: string) {
    const response = await input.request({ user, machine, method: "GET", path: "/api/project" })
    if (!response.ok) return passError(response)
    const parsed = Option.getOrUndefined(decodeProjects(await response.text()))
    const list = parsed === undefined ? [] : "data" in parsed ? parsed.data : parsed
    // The global project stands for folders that belong to no repository: there is nothing to pick.
    return json(
      200,
      list
        .filter((project) => project.canonical !== "/")
        .map((project) => ({
          id: project.id,
          name: project.name ?? baseName(project.canonical),
          directory: project.canonical,
        })),
    )
  }

  async function directories(user: string, machine: string, requested: string | undefined) {
    const directory = requested ?? (await startingFolder(user, machine))
    if (directory === undefined) return json(502, { error: "The machine did not say where to start." })
    const response = await input.request({
      user,
      machine,
      method: "GET",
      path: `/api/fs/list?path=${encodeURIComponent(directory)}`,
    })
    if (!response.ok) return passError(response)
    const parsed = Option.getOrUndefined(decodeEntries(await response.text()))
    return json(200, {
      directory,
      parent: parentOf(directory),
      directories: (parsed?.data ?? [])
        .filter((entry) => entry.type === "directory")
        .map((entry) => baseName(entry.path))
        .filter((name) => !name.startsWith("."))
        .toSorted((a, b) => a.localeCompare(b)),
    })
  }

  async function startingFolder(user: string, machine: string) {
    const response = await input.request({ user, machine, method: "GET", path: "/api/location" })
    if (!response.ok) return undefined
    const parsed = Option.getOrUndefined(decodeLocation(await response.text()))
    return parsed?.directory ?? parsed?.data?.directory
  }

  async function createDirectory(request: Request, user: string, machine: string) {
    const body = Option.getOrUndefined(decodeNewFolder(await request.text()))
    if (!body || !body.parent.startsWith("/") || !FOLDER_NAME.test(body.name))
      return json(400, { error: "Expected { parent, name } with a plain folder name." })
    const directory = `${body.parent.replace(/\/+$/, "")}/${body.name}`
    const response = await input.request({ user, machine, method: "POST", path: MKDIR, body: { path: directory } })
    if (response.status === 404) return json(409, { error: "Update the agent on this machine to create folders." })
    if (!response.ok) return passError(response)
    return json(200, { directory })
  }

  async function targets(request: Request, user: string, session: string, action: string | undefined) {
    if (action === "run" && request.method === "DELETE") return stop(user, session)
    if (action !== undefined && request.method === "POST") return launch(request, user, session, action)
    if (action !== undefined) return json(404, { error: "Not found." })
    if (request.method === "GET") {
      const target = store.chatTarget(user, session)
      const failure = failures.get(runKey(user, session))
      const state = { running: runs.has(runKey(user, session)), ...(failure === undefined ? {} : { error: failure }) }
      if (!target) return json(200, { target: null, ...state })
      const machine = store.machine(target.machine_id)
      return json(200, {
        target: {
          machine: target.machine_id,
          machineName: machine?.name ?? target.machine_id,
          directory: target.directory,
          online: input.online(target.machine_id),
        },
        ...state,
      })
    }
    if (request.method === "PUT") {
      const body = Option.getOrUndefined(decodeTarget(await request.text()))
      if (!body || !body.directory.startsWith("/")) return json(400, { error: "Expected { machine, directory }." })
      // The same check as any request to the machine: an inaccessible one answers 404.
      const check = await input.request({ user, machine: body.machine, method: "GET", path: "/api/location" })
      if (!check.ok) return passError(check)
      store.setChatTarget(user, session, body.machine, body.directory)
      return json(200, { ok: true })
    }
    if (request.method === "DELETE") {
      store.deleteChatTarget(user, session)
      return new Response(null, { status: 204 })
    }
    return json(404, { error: "Not found." })
  }

  /**
   * Starts a slash command or a shell command in the background and answers once the machine has taken it: 202, or
   * the refusal. Its result is added to the hub's conversation when it ends.
   */
  async function launch(request: Request, user: string, session: string, action: string) {
    const body = await request.text()
    const command = action === "command" ? Option.getOrUndefined(decodeCommandRun(body)) : undefined
    const shell = action === "shell" ? Option.getOrUndefined(decodeShellRun(body))?.command.trim() : undefined
    if (action === "command" && !(command && COMMAND_NAME.test(command.name)))
      return json(400, { error: "Expected { name, arguments }." })
    if (action === "shell" && !shell) return json(400, { error: "Expected { command }." })
    const target = store.chatTarget(user, session)
    if (!target) return json(404, { error: "No machine is attached to this conversation." })
    if (!input.online(target.machine_id)) return json(409, { error: "This machine is not connected to the hub." })
    const key = runKey(user, session)
    if (runs.has(key)) return json(409, { error: "Something is already running in this conversation." })
    const controller = new AbortController()
    runs.set(key, controller)
    failures.delete(key)
    const machine = store.machine(target.machine_id)?.name ?? target.machine_id
    const task = { user, session, signal: controller.signal }
    const accepted = Promise.withResolvers<void>()
    const invoked = command ? `/${[command.name, command.arguments?.trim()].filter(Boolean).join(" ")}` : (shell ?? "")
    const title = command ? `${invoked} — ${machine}` : `$ ${invoked} — ${machine}`
    if (shell) input.log?.(`hub chat: ${user} runs a shell command on ${machine} in ${target.directory}: ${shell}`)
    const settled = (
      command
        ? runCommand(task, command, accepted.resolve).then((text) => ({ text, shown: { output: text } }))
        : runShell(task, shell ?? "", accepted.resolve).then((message) => ({
            text: shellText(message),
            shown: { exit: message.exit, ...shellOutput(message) },
          }))
    ).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    )
    const early = await Promise.race([accepted.promise.then(() => undefined), settled])
    if (early && "error" in early) {
      runs.delete(key)
      return json(early.error instanceof Refusal ? early.error.status : 502, { error: describe(early.error) })
    }
    void settled.then(async (outcome) => {
      const stopped = controller.signal.aborted
      if ("error" in outcome && !stopped) failures.set(key, describe(outcome.error))
      const failed = "error" in outcome ? `Failed: ${describe(outcome.error)}` : undefined
      const text = stopped ? "Stopped." : (failed ?? ("result" in outcome ? outcome.result.text : ""))
      // The model reads the text; the hub's timeline shows the run from the metadata.
      const metadata = {
        source: RECORD_SOURCE,
        kind: command ? "command" : "shell",
        machine,
        command: invoked,
        state: stopped ? "cancelled" : failed ? "error" : "completed",
        ...("result" in outcome && !stopped ? outcome.result.shown : { output: text }),
      }
      await input
        .record(user, session, { description: title, text: `${title}\n\n${text}`, metadata })
        .catch(() => undefined)
      runs.delete(key)
    })
    return json(202, { running: true })
  }

  async function stop(user: string, session: string) {
    const controller = runs.get(runKey(user, session))
    const target = store.chatTarget(user, session)
    if (controller) controller.abort()
    if (!controller && target?.remote_session) await interrupt({ user }, target, target.remote_session)
    return new Response(null, { status: 204 })
  }

  async function runCommand(task: Task, command: { name: string; arguments?: string }, accept: () => void) {
    const target = requireTarget(task)
    const call = caller(task, target)
    const remote = await prepareSession(task, target, call)
    const since = await latestTime(call, remote)
    const sent = await call("POST", `/api/session/${remote}/command`, {
      name: command.name,
      text: command.arguments ?? "",
    })
    if (sent.status === 404) {
      const tag = Option.getOrUndefined(decodeTag(await sent.text()))?._tag
      if (tag === "CommandNotFoundError") throw new Refusal(404, `The machine has no command /${command.name}.`)
      if (tag === "SessionNotFoundError" && target.remote_session) {
        store.setChatRemoteSession(task.user, task.session, null)
        return runCommand(task, command, accept)
      }
      throw new Refusal(409, "Update the agent on this machine to run commands from the hub.")
    }
    if (!sent.ok) throw new Refusal(502, await failureText(sent))
    accept()
    task.signal.addEventListener("abort", () => void interrupt(task, target, remote), { once: true })
    // A command may only run a callback and start no agent run: then it is done once the session stays quiet.
    return wait(call, remote, since + 1, task.signal, true)
  }

  async function runShell(task: Task, command: string, accept: () => void): Promise<typeof Message.Type> {
    const target = requireTarget(task)
    const call = caller(task, target)
    const remote = target.remote_session ?? (await startSession(task, target, call))
    const before = await shellIDs(call, remote)
    const posting = call("POST", `/api/session/${remote}/shell`, { command })
    // The machine answers once the command has ended, so only a quick answer can be a refusal.
    const early = await Promise.race([posting, Bun.sleep(SHELL_GRACE)])
    if (early && early.status === 404) {
      const tag = Option.getOrUndefined(decodeTag(await early.text()))?._tag
      if (tag === "SessionNotFoundError" && target.remote_session) {
        store.setChatRemoteSession(task.user, task.session, null)
        return runShell(task, command, accept)
      }
      throw new Refusal(409, "Update the agent on this machine to run shell commands from the hub.")
    }
    if (early && !early.ok) throw new Refusal(502, await failureText(early))
    accept()
    task.signal.addEventListener("abort", () => void interrupt(task, target, remote), { once: true })
    const sent = early ?? (await posting)
    if (!sent.ok) throw new Error(await failureText(sent))
    return shellResult(call, remote, command, before, task.signal)
  }

  function requireTarget(task: Task) {
    const target = store.chatTarget(task.user, task.session)
    if (!target)
      throw new Error("No machine is attached to this conversation. Ask the user to attach one with the + button.")
    return target
  }

  function caller(task: Task, target: Store.ChatTarget): Call {
    return (method, path, body) =>
      input.request({ user: task.user, machine: target.machine_id, method, path, body, signal: task.signal })
  }

  /** The target's session on the machine, created on first use, otherwise switched to the chat's current model. */
  async function prepareSession(task: Task, target: Store.ChatTarget, call: Call) {
    if (!target.remote_session) return startSession(task, target, call)
    const model = await input.model(task.user, task.session)
    // Best effort: a session that is gone answers the prompt that follows with 404.
    if (model) await call("POST", `/api/session/${target.remote_session}/model`, { model }).catch(() => undefined)
    return target.remote_session
  }

  async function startSession(task: { user: string; session: string }, target: Store.ChatTarget, call: Call) {
    const model = await input.model(task.user, task.session)
    const response = await call("POST", "/api/session", {
      title: "Hub task",
      location: { directory: target.directory },
      ...(model ? { model } : {}),
      // Nobody is at that machine to answer it.
      permissions: [{ action: "question", resource: "*", effect: "deny" }],
    })
    if (!response.ok) throw new Error(await failureText(response))
    const created = Option.getOrUndefined(decodeCreated(await response.text()))
    if (!created) throw new Error("The machine did not create a session.")
    store.setChatRemoteSession(task.user, task.session, created.data.id)
    return created.data.id
  }

  function interrupt(task: { user: string }, target: Store.ChatTarget, remote: string) {
    return input
      .request({
        user: task.user,
        machine: target.machine_id,
        method: "POST",
        path: `/api/session/${remote}/interrupt`,
        body: {},
      })
      .catch(() => undefined)
  }

  async function wait(call: Call, remote: string, since: number, signal: AbortSignal, settle: boolean) {
    const counts = { missed: 0, quiet: 0 }
    while (!signal.aborted) {
      await Bun.sleep(pollEvery)
      const messages = await readMessages(call, remote)
      if (!messages) {
        counts.missed += 1
        if (counts.missed >= MAX_POLL_FAILURES) throw new Error("The machine stopped answering while it was working.")
        continue
      }
      counts.missed = 0
      await rejectPermissions(call, remote)
      const latest = messages[0]
      if (latest?.type === "idle" && latest.time.created >= since) return finalMessage(messages, latest.outcome)
      if (!settle) continue
      counts.quiet = (await isActive(call, remote)) ? 0 : counts.quiet + 1
      if (counts.quiet >= SETTLED_POLLS)
        return finalMessage(
          messages.filter((message) => message.time.created >= since),
          undefined,
        )
    }
    throw new Error("The task was interrupted.")
  }

  async function shellResult(call: Call, remote: string, command: string, before: Set<string>, signal: AbortSignal) {
    const counts = { missed: 0 }
    while (!signal.aborted) {
      const messages = await readMessages(call, remote)
      counts.missed = messages ? 0 : counts.missed + 1
      if (counts.missed >= MAX_POLL_FAILURES) throw new Error("The machine stopped answering while it was working.")
      const shell = messages?.find(
        (message) => message.type === "shell" && message.command === command && !before.has(message.id ?? ""),
      )
      if (shell && shell.status !== "running") return shell
      await Bun.sleep(pollEvery)
    }
    throw new Error("The command was interrupted.")
  }

  async function shellIDs(call: Call, remote: string) {
    const messages = await readMessages(call, remote)
    return new Set(messages?.flatMap((message) => (message.type === "shell" && message.id ? [message.id] : [])))
  }

  async function latestTime(call: Call, remote: string) {
    const response = await call("GET", `/api/session/${remote}/message?limit=1`)
    if (!response.ok && response.status !== 404) throw new Refusal(502, await failureText(response))
    const messages = response.ok ? Option.getOrUndefined(decodeMessages(await response.text())) : undefined
    return messages?.data[0]?.time.created ?? 0
  }

  async function readMessages(call: Call, remote: string) {
    const response = await call("GET", `/api/session/${remote}/message?limit=30`).catch(() => undefined)
    return response?.ok ? Option.getOrUndefined(decodeMessages(await response.text()))?.data : undefined
  }

  async function isActive(call: Call, remote: string) {
    const response = await call("GET", "/api/session/active").catch(() => undefined)
    const active = response?.ok ? Option.getOrUndefined(decodeActive(await response.text())) : undefined
    // Unknown counts as working, so a machine that does not answer never ends a command early.
    return active === undefined || remote in active.data
  }

  /** Nobody can answer a permission prompt from the hub, and an unanswered one would stall the task forever. */
  async function rejectPermissions(call: Call, remote: string) {
    const response = await call("GET", `/api/session/${remote}/permission`).catch(() => undefined)
    if (!response?.ok) return
    const pending = Option.getOrUndefined(decodePermissions(await response.text()))
    await Promise.all(
      (pending?.data ?? []).map((request) =>
        call("POST", `/api/session/${remote}/permission/${request.id}/reply`, {
          decision: "reject",
          message: DENIED_REPLY,
        }).catch(() => undefined),
      ),
    )
  }
}

export type Instance = ReturnType<typeof create>

/** What an agent's run on a machine came to: its last text, or why it stopped, bounded for the model. */
export function finalMessage(messages: readonly (typeof Message.Type)[], outcome: string | undefined) {
  const text = messages
    .find(
      (message) => message.type === "assistant" && message.content?.some((part) => part.type === "text" && part.text),
    )
    ?.content?.flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("")
  if (outcome !== undefined && outcome !== "succeeded")
    return `The agent stopped before finishing (${outcome}).${text ? ` Its last message:\n\n${text}` : ""}`
  if (!text) return "The agent finished without a final message."
  return text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n\n[Truncated]` : text
}

function shellText(message: typeof Message.Type) {
  const status = message.exit === undefined ? `Ended: ${message.status ?? "unknown"}.` : `Exit code ${message.exit}.`
  const shown = shellOutput(message)
  if (!shown.output) return status
  return `${status}\n\n${shown.truncated ? "[Truncated]\n" : ""}\`\`\`\n${shown.output}\n\`\`\``
}

/** The end of a shell command's output, at most `MAX_SHELL_OUTPUT` characters. */
function shellOutput(message: typeof Message.Type) {
  const output = message.output?.output ?? ""
  return {
    output: output.length > MAX_SHELL_OUTPUT ? output.slice(-MAX_SHELL_OUTPUT) : output,
    truncated: output.length > MAX_SHELL_OUTPUT || message.output?.truncated === true,
  }
}

function runKey(user: string, session: string) {
  return `${user}\n${session}`
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/** A run the machine refused before it started, answered to the browser with this status. */
class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function baseName(file: string) {
  return file.replace(/\/+$/, "").split("/").at(-1) || file
}

function parentOf(directory: string) {
  const trimmed = directory.replace(/\/+$/, "")
  if (!trimmed) return null
  return trimmed.slice(0, trimmed.lastIndexOf("/")) || "/"
}

async function failureText(response: Response) {
  const text = await response.text().catch(() => "")
  return `The machine answered ${response.status}${text ? `: ${text.slice(0, 300)}` : "."}`
}

async function passError(response: Response) {
  return new Response(await response.text(), {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
  })
}
