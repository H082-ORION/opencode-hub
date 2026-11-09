import { Option, Schema } from "effect"
import { json, type Current } from "./accounts.js"
import type { Store } from "./store.js"

export * as ChatMachines from "./chat-machines.js"

const POLL_EVERY = 2000
/** Failed polls in a row before giving up: long enough for a machine to reconnect. */
const MAX_POLL_FAILURES = 150
const MAX_RESULT = 60_000
/** The agent's own route for creating a folder. */
const MKDIR = "/__hub/mkdir"

const MACHINE = /^chat-machines\/([^/]+)\/(projects|directories)$/
const TARGET = /^chat-targets\/([A-Za-z0-9_-]+)$/
const FOLDER_NAME = /^(?!\.{1,2}$)[^/\\\0]{1,255}$/
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
const decodeAdmitted = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: Schema.Struct({ time: Schema.Struct({ created: Schema.Number }) }) })),
)
const Message = Schema.Struct({
  type: Schema.String,
  time: Schema.Struct({ created: Schema.Number }),
  outcome: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }))),
})
const decodeMessages = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ data: Schema.Array(Message) })))
const decodePermissions = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) })),
)

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
  model: (user: string, session: string) => Promise<{ id: string; providerID: string } | undefined>
}) {
  const store = input.store

  return {
    async handle(request: Request, route: string, current: Current) {
      const user = current.user.id
      const machine = MACHINE.exec(route)
      if (machine) return machines(request, user, decodeURIComponent(machine[1]!), machine[2]!)
      const target = TARGET.exec(route)
      if (target) return targets(request, user, target[1]!)
      return undefined
    },

    /** What to tell the model the first time it answers after a target was attached. */
    note(user: string, session: string) {
      const target = store.chatTarget(user, session)
      if (!target || target.announced) return undefined
      store.setChatAnnounced(user, session)
      const machine = store.machine(target.machine_id)
      return `The user attached the machine "${machine?.name ?? target.machine_id}" to this conversation, on the project in ${target.directory}. Use machine_task for requests about that project or machine.`
    },

    run,
  }

  async function machines(request: Request, user: string, machine: string, kind: string) {
    if (kind === "projects" && request.method === "GET") return projects(user, machine)
    if (kind === "directories" && request.method === "GET")
      return directories(user, machine, new URL(request.url).searchParams.get("path") ?? undefined)
    if (kind === "directories" && request.method === "POST") return createDirectory(request, user, machine)
    return json(404, { error: "Not found." })
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

  async function targets(request: Request, user: string, session: string) {
    if (request.method === "GET") {
      const target = store.chatTarget(user, session)
      if (!target) return json(200, { target: null })
      const machine = store.machine(target.machine_id)
      return json(200, {
        target: {
          machine: target.machine_id,
          machineName: machine?.name ?? target.machine_id,
          directory: target.directory,
          online: input.online(target.machine_id),
        },
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

  /** Runs one request in the target's session on the machine and waits for its final message. */
  async function run(task: { user: string; session: string; prompt: string; signal: AbortSignal }) {
    const target = store.chatTarget(task.user, task.session)
    if (!target)
      throw new Error("No machine is attached to this conversation. Ask the user to attach one with the + button.")
    const call = (method: string, path: string, body?: unknown) =>
      input.request({ user: task.user, machine: target.machine_id, method, path, body, signal: task.signal })
    const remote = target.remote_session ?? (await startSession(task, target, call))
    const sent = await call("POST", `/api/session/${remote}/prompt`, { text: task.prompt })
    if (sent.status === 404 && target.remote_session) {
      // The session is gone from the machine: the conversation continues in a new one.
      store.setChatRemoteSession(task.user, task.session, null)
      return run(task)
    }
    if (!sent.ok) throw new Error(await failureText(sent))
    const admitted = Option.getOrUndefined(decodeAdmitted(await sent.text()))
    if (!admitted) throw new Error("The machine did not accept the task.")
    task.signal.addEventListener("abort", () => void interrupt(task, target, remote), { once: true })
    return wait(call, remote, admitted.data.time.created, task.signal)
  }

  async function startSession(
    task: { user: string; session: string },
    target: Store.ChatTarget,
    call: (method: string, path: string, body?: unknown) => Promise<Response>,
  ) {
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

  async function wait(
    call: (method: string, path: string, body?: unknown) => Promise<Response>,
    remote: string,
    since: number,
    signal: AbortSignal,
  ) {
    const failures = { count: 0 }
    while (!signal.aborted) {
      await Bun.sleep(POLL_EVERY)
      const response = await call("GET", `/api/session/${remote}/message?limit=30`).catch(() => undefined)
      const messages = response?.ok ? Option.getOrUndefined(decodeMessages(await response.text())) : undefined
      if (!messages) {
        failures.count += 1
        if (failures.count >= MAX_POLL_FAILURES) throw new Error("The machine stopped answering while it was working.")
        continue
      }
      failures.count = 0
      await rejectPermissions(call, remote)
      const latest = messages.data[0]
      if (latest?.type !== "idle" || latest.time.created < since) continue
      return finalMessage(messages.data, latest.outcome)
    }
    throw new Error("The task was interrupted.")
  }

  /** Nobody can answer a permission prompt from the hub, and an unanswered one would stall the task forever. */
  async function rejectPermissions(
    call: (method: string, path: string, body?: unknown) => Promise<Response>,
    remote: string,
  ) {
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

function finalMessage(messages: readonly (typeof Message.Type)[], outcome: string | undefined) {
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
