import { Option, Schema } from "effect"
import { json, type Current } from "./accounts.js"
import type { Store } from "./store.js"

export * as ChatMachines from "./chat-machines.js"

const MAX_RESULT = 60_000
const MAX_FOUND = 50
/** The agent's own route for creating a folder. */
const MKDIR = "/__hub/mkdir"

const MACHINE = /^chat-machines\/([^/]+)\/(projects|directories|commands|files)$/
const TARGET = /^chat-targets\/([A-Za-z0-9_-]+)$/
const FOLDER_NAME = /^(?!\.{1,2}$)[^/\\\0]{1,255}$/

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
const decodeCommands = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.optional(Schema.String) })),
    }),
  ),
)

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
 * What ties the hub's chat to the machines: the projects and folders of a user's machine, and the machine and folder
 * a chat session is attached to. The tasks that session runs there, `/command` and `!shell` included, are
 * `ChatTasks`. Every call goes through `request`, which checks access to the machine each time.
 */
export function create(input: {
  store: Store.Instance
  request: (request: Request_) => Promise<Response>
  online: (machine: string) => boolean
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

function baseName(file: string) {
  return file.replace(/\/+$/, "").split("/").at(-1) || file
}

function parentOf(directory: string) {
  const trimmed = directory.replace(/\/+$/, "")
  if (!trimmed) return null
  return trimmed.slice(0, trimmed.lastIndexOf("/")) || "/"
}

async function passError(response: Response) {
  return new Response(await response.text(), {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
  })
}
