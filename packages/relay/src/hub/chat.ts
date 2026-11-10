import { createHash, randomBytes } from "node:crypto"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import type { Local } from "../agent/index.js"
import { Instances } from "../agent/instances.js"
import { json, type Current } from "./accounts.js"
import { Store } from "./store.js"

export * as Chat from "./chat.js"

/** The agent of every hub chat session: it answers, and can only act on the user's skills. */
export const AGENT = "hub"
const SYSTEM = `You are the assistant of an opencode hub. You answer the user's questions in the conversation.
You cannot read or change files, run commands or browse the web, and the hub is not a place to write code in. When a
request needs that, say so and suggest opening one of the user's machines from the hub.
Your tools manage the user's skills on the hub, which reach all of their machines: list them, read one, create or
update one, and install them from a GitHub repository. A skill changes how agents behave on those machines: before
installing from a repository, make sure the user asked for that exact repository, and report what was installed.
When the conversation has a machine attached, machine_task hands a request to the coding agent running on it, which can
read and change that project. Pass the whole request, and any context it needs, since that agent sees nothing else
from this conversation. When the agent needs the images or PDFs the user attached to their last message, pass images=true.
It returns that agent's final message: summarize it for the user or relay it.`

const IDLE_AFTER = 15 * 60 * 1000
const SWEEP_EVERY = 60 * 1000

/** The hub's own tools, as the engine names the ones of the `hub-tools` MCP server. */
const OWN_TOOLS = "hub-tools_*"
const RULES = [
  { action: "*", resource: "*", effect: "deny" },
  { action: OWN_TOOLS, resource: "*", effect: "allow" },
]
/** How long a task on a machine may run before the engine stops waiting for it. */
const TASK_TIMEOUT = 6 * 60 * 60 * 1000

/** Tool and integration access is shut twice over, but for the hub's own tools; only the hub's providers may answer. */
export const config = (tools: string) => ({
  permissions: RULES,
  policies: [
    ...["tool.use", "mcp.use", "skill.use", "plugin.use", "websearch.use", "integration.connect"].map((action) => ({
      action,
      resource: "*",
      effect: "deny",
    })),
    // Statements are read last to first: these two let through the hub's own tools and nothing else.
    { action: "tool.use", resource: OWN_TOOLS, effect: "allow" },
    { action: "mcp.use", resource: "hub-tools", effect: "allow" },
    // Its free models would send the conversation to opencode.ai instead of through the hub's proxy.
    { action: "provider.use", resource: "opencode", effect: "deny" },
  ],
  agents: { [AGENT]: { mode: "primary", system: SYSTEM, permissions: RULES } },
  mcp: {
    servers: {
      "hub-tools": {
        type: "remote",
        url: tools,
        headers: { Authorization: `Bearer {env:${Instances.TOKEN}}` },
        oauth: false,
        timeout: { execution: TASK_TIMEOUT },
      },
    },
  },
  snapshots: false,
})

const Model = Schema.Struct({
  id: Schema.String,
  providerID: Schema.String,
  variant: Schema.optional(Schema.String),
})
const decodeCreate = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ id: Schema.optional(Schema.String), title: Schema.optional(Schema.String), model: Model }),
  ),
)
const decodeTitle = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ title: Schema.String })))
const PromptFile = Schema.Struct({ uri: Schema.String, mime: Schema.String, name: Schema.optional(Schema.String) })
const decodePrompt = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      text: Schema.String,
      delivery: Schema.optional(Schema.Literals(["steer", "queue"])),
      files: Schema.optional(Schema.Array(PromptFile)),
    }),
  ),
)
const decodeUserMessages = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Array(
        Schema.Struct({
          type: Schema.String,
          files: Schema.optional(
            Schema.Array(Schema.Struct({ uri: Schema.String, name: Schema.optional(Schema.String) })),
          ),
        }),
      ),
    }),
  ),
)
const decodeModel = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ model: Model })))
const decodeList = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) })),
)
const decodeDefault = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: Schema.NullOr(Schema.Struct({ providerID: Schema.String })) })),
)
const decodeSession = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: Schema.Struct({ model: Schema.optional(Model) }) })),
)
const decodeActive = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: Schema.Record(Schema.String, Schema.Unknown) })),
)

const SESSION = "[A-Za-z0-9_-]+"
const SESSION_ID = new RegExp(`^${SESSION}$`)
const MESSAGES = new RegExp(`^api/session/${SESSION}/message(?:/${SESSION})?$`)
const READS = new RegExp(`^api/(?:location|project|vcs|session(?:/active|/${SESSION}(?:/inbox|/form)?)?)$`)
const ONE = new RegExp(`^api/session/(${SESSION})$`)
const PROMPT = new RegExp(`^api/session/${SESSION}/prompt$`)
const INTERRUPT = new RegExp(`^api/session/${SESSION}/interrupt$`)
const SWITCH = new RegExp(`^api/session/${SESSION}/model$`)
/** Files travel inline, as data URIs: a `file://` or any other URI would be read from the hub's or a machine's disk. */
const DATA_URI = /^data:(image\/[A-Za-z0-9.+-]+|application\/pdf)(;base64)?,/i
const MAX_FILE = 5 * 1024 * 1024
const MAX_FILES = 20 * 1024 * 1024

/**
 * One opencode instance per active user, restricted to the hub's own tools, behind a closed list of routes. The browser never reaches the
 * instance: its API can run shell commands whatever the permissions say, so only what the chat needs is forwarded, and
 * every field of a write is rebuilt here.
 */
export function create(input: {
  store: Store.Instance
  /** Where the instances keep their conversations. */
  root: string
  command: readonly string[]
  /** Where they start; defaults to an empty folder. */
  cwd?: string
  /** The hub's `/llm` base URL, as the instances reach it. */
  llm: string
  /** The hub's chat tools, as the instances reach them. */
  tools: string
  /** What to tell a session's model before a prompt, once, when its target has changed. */
  note?: (user: string, session: string) => string | undefined
  log?: (message: string) => void
}) {
  Store.secureDirectory(input.root)
  const workspace = path.join(input.root, "workspace")
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  const manager = Instances.create({
    root: input.root,
    command: input.command,
    cwd: input.cwd ?? workspace,
    // Only what a process needs to run: whatever else the hub was started with stays out of the instances.
    env: {
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      TMPDIR: process.env.TMPDIR,
      HOME: workspace,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    },
    config: config(input.tools),
    log: input.log,
  })
  const iidOf = (user: string) => createHash("sha256").update(`chat|${user}`).digest("base64url").slice(0, 32)
  const tokens = new Map<string, string>()
  const owners = new Map<string, string>()
  const activity = new Map<string, { last: number; streams: number }>()

  void manager.prune(input.store.users().map((user) => iidOf(user.id)))
  const sweep = setInterval(() => void stopIdle(), SWEEP_EVERY)
  sweep.unref?.()

  return {
    /** The active user an instance token belongs to; only their providers answer it. */
    owner(token: string) {
      const user = owners.get(token)
      if (!user) return undefined
      const account = input.store.user(user)
      return account && account.disabled_at === null ? user : undefined
    },

    async handle(request: Request, route: string, current: Current) {
      if (!route.startsWith("chat/")) return undefined
      return dispatch(request, route.slice("chat/".length), current.user.id)
    },

    /** The model a user's chat session uses, for the tasks it starts on machines. */
    async sessionModel(user: string, session: string) {
      if (!SESSION_ID.test(session)) return undefined
      const response = await forward(await instance(user), "GET", `api/session/${session}`, "")
      return response.ok ? Option.getOrUndefined(decodeSession(await response.text()))?.data.model : undefined
    },

    /** The inline files of the last user message of a chat session, for a task that hands them to a machine. */
    async lastFiles(user: string, session: string) {
      if (!SESSION_ID.test(session)) return []
      const response = await forward(await instance(user), "GET", `api/session/${session}/message`, "?limit=20")
      if (!response.ok) return []
      const messages = Option.getOrUndefined(decodeUserMessages(await response.text()))?.data ?? []
      return (messages.find((message) => message.type === "user")?.files ?? [])
        .filter((file) => DATA_URI.test(file.uri))
        .map((file) => ({ uri: file.uri, name: file.name }))
    },

    /** Adds a message to a chat session for the model to read at its next prompt, without starting it. */
    async record(user: string, session: string, message: { text: string; description: string }) {
      if (!SESSION_ID.test(session)) return json(400, { error: "Invalid session." })
      return forward(await instance(user), "POST", `api/session/${session}/synthetic`, "", {
        text: message.text,
        description: message.description,
        resume: false,
      })
    },

    async stop() {
      clearInterval(sweep)
      await manager.stop()
    },
  }

  async function dispatch(request: Request, route: string, user: string) {
    const method = request.method
    const allowed = new Set(input.store.providerSummaries(user).map((provider) => provider.id))
    const body = method === "GET" ? undefined : await request.text()
    const search = new URL(request.url).searchParams
    // A location names a folder of the hub's disk, in `location` or `location[directory]`: instances keep to their own.
    Array.from(search.keys())
      .filter((key) => key.startsWith("location"))
      .forEach((key) => search.delete(key))
    const query = search.size ? `?${search}` : ""
    const local = () => instance(user)

    if (method === "GET" && route === "api/event") return stream(request, user, await local())
    if (method === "GET" && route === "api/model")
      return filter(await forward(await local(), method, route, query), "providerID", allowed)
    if (method === "GET" && route === "api/provider")
      return filter(await forward(await local(), method, route, query), "id", allowed)
    if (method === "GET" && route === "api/model/default") {
      const response = await forward(await local(), method, route, query)
      if (!response.ok) return response
      const text = await response.text()
      const parsed = Option.getOrUndefined(decodeDefault(text))
      if (!parsed?.data || allowed.has(parsed.data.providerID)) return respond(response, text)
      return json(200, { data: null })
    }
    if (method === "GET" && (READS.test(route) || MESSAGES.test(route)))
      return forward(await local(), method, route, query)

    if (method === "POST" && route === "api/session") {
      const payload = Option.getOrUndefined(decodeCreate(body ?? ""))
      if (!payload) return json(400, { error: "Expected { model, id?, title? }." })
      if (!allowed.has(payload.model.providerID)) return json(403, { error: "This provider is not available here." })
      return forward(await local(), method, route, "", {
        id: payload.id,
        title: payload.title,
        model: payload.model,
        agent: AGENT,
        permissions: RULES,
      })
    }
    if (method === "POST" && PROMPT.test(route)) {
      const payload = Option.getOrUndefined(decodePrompt(body ?? ""))
      if (!payload) return json(400, { error: "Expected { text }." })
      const files = promptFiles(payload.files ?? [])
      if (!files)
        return json(400, {
          error: "Files must be images or PDFs as data URIs, at most 5 MB each and 20 MB in all.",
        })
      const note = input.note?.(user, route.split("/")[2]!)
      if (note)
        await forward(await local(), method, route.replace(/prompt$/, "synthetic"), "", { text: note, resume: false })
      return forward(await local(), method, route, "", {
        id: payload.id,
        text: payload.text,
        delivery: payload.delivery,
        files: files.length > 0 ? files : undefined,
      })
    }
    if (method === "POST" && INTERRUPT.test(route)) return forward(await local(), method, route, "", {})
    if (method === "POST" && SWITCH.test(route)) {
      const payload = Option.getOrUndefined(decodeModel(body ?? ""))
      if (!payload) return json(400, { error: "Expected { model }." })
      if (!allowed.has(payload.model.providerID)) return json(403, { error: "This provider is not available here." })
      return forward(await local(), method, route, "", payload)
    }
    if (method === "PATCH" && ONE.test(route)) {
      const payload = Option.getOrUndefined(decodeTitle(body ?? ""))
      if (!payload) return json(400, { error: "Expected { title }." })
      return forward(await local(), method, route, "", payload)
    }
    if (method === "DELETE" && ONE.test(route)) return forward(await local(), method, route, "")

    return json(404, { error: "Not found." })
  }

  async function instance(user: string) {
    touch(user).last = Date.now()
    const iid = iidOf(user)
    const token = tokens.get(user) ?? randomBytes(32).toString("base64url")
    tokens.set(user, token)
    owners.set(token, user)
    await manager.configure({
      iid,
      token,
      llm: {
        baseURL: input.llm,
        providers: input.store.providerSummaries(user).map((provider) => ({ id: provider.id, name: provider.name })),
      },
      mcp: [],
      skills: { version: "" },
    })
    return manager.local(iid)
  }

  function touch(user: string) {
    const known = activity.get(user)
    if (known) return known
    const entry = { last: Date.now(), streams: 0 }
    activity.set(user, entry)
    return entry
  }

  async function forward(local: Local, method: string, route: string, query: string, body?: unknown) {
    const response = await fetch(`${local.url.replace(/\/+$/, "")}/${route}${query}`, {
      method,
      headers: { ...authorization(local), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch((error: unknown) => error as Error)
    if (response instanceof Error) return json(502, { error: `The chat engine did not answer: ${response.message}` })
    return response.status === 204 ? new Response(null, { status: 204 }) : respond(response, await response.text())
  }

  async function stream(request: Request, user: string, local: Local) {
    const upstream = await fetch(`${local.url.replace(/\/+$/, "")}/api/event`, {
      headers: authorization(local),
      signal: request.signal,
    }).catch((error: unknown) => error as Error)
    if (upstream instanceof Error) return json(502, { error: `The chat engine did not answer: ${upstream.message}` })
    if (!upstream.ok || !upstream.body) return json(502, { error: "The chat engine refused the event stream." })
    const entry = touch(user)
    entry.streams += 1
    const state = { open: true }
    const closed = () => {
      if (!state.open) return
      state.open = false
      entry.streams -= 1
      entry.last = Date.now()
    }
    request.signal.addEventListener("abort", closed, { once: true })
    return new Response(upstream.body.pipeThrough(new TransformStream({ flush: closed })), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    })
  }

  async function stopIdle() {
    const now = Date.now()
    await Promise.all(
      Array.from(activity, async ([user, entry]) => {
        const iid = iidOf(user)
        if (!manager.running(iid) || entry.streams > 0 || now - entry.last < IDLE_AFTER) return
        const local = await manager.local(iid).catch(() => undefined)
        if (!local) return
        const active = await fetch(`${local.url.replace(/\/+$/, "")}/api/session/active`, {
          headers: authorization(local),
        })
          .then((response) => response.text())
          .catch(() => "")
        // A session still answering keeps its instance, whoever is watching.
        if (Object.keys(Option.getOrUndefined(decodeActive(active))?.data ?? {}).length > 0) return
        await manager.halt(iid)
      }),
    )
  }
}

export type Instance = ReturnType<typeof create>

function authorization(local: Local) {
  return { authorization: `Basic ${btoa(`opencode:${local.password}`)}` }
}

function respond(response: Response, text: string) {
  return new Response(text, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  })
}

/** The prompt's files rebuilt for the instance, or undefined when one is not an inline image or PDF, or they are too large. */
function promptFiles(files: readonly (typeof PromptFile.Type)[]) {
  const sizes = files.map((file) => {
    const match = DATA_URI.exec(file.uri)
    if (!match || match[1]!.toLowerCase() !== file.mime.toLowerCase()) return undefined
    const payload = file.uri.length - match[0].length
    return match[2] ? Math.floor((payload * 3) / 4) : payload
  })
  if (sizes.some((size) => size === undefined || size > MAX_FILE)) return undefined
  if (sizes.reduce((total: number, size) => total + (size ?? 0), 0) > MAX_FILES) return undefined
  return files.map((file) => ({ uri: file.uri, name: file.name }))
}

/** Keeps only the entries of a `{ data: [...] }` list that come from the user's own providers. */
async function filter(response: Response, key: string, allowed: ReadonlySet<string>) {
  if (!response.ok) return response
  const text = await response.text()
  const parsed = Option.getOrUndefined(decodeList(text))
  if (!parsed) return respond(response, text)
  return json(200, {
    data: parsed.data.filter((entry) => {
      const value = entry[key]
      return typeof value === "string" && allowed.has(value)
    }),
  })
}
