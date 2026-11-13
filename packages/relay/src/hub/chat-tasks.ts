import { Option, Schema } from "effect"
import { json, type Current } from "./accounts.js"
import { finalMessage, type Recorded } from "./chat-machines.js"
import type { ChatWatch } from "./chat-watch.js"
import type { Store } from "./store.js"

export * as ChatTasks from "./chat-tasks.js"

/**
 * Tasks the hub's chat hands to machines.
 *
 * A task is one session on a machine, created in the folder asked for and given the prompt; the call that starts it
 * returns as soon as the machine admitted the prompt. From then on the hub follows the session through the user's
 * event stream on that machine (`ChatWatch`), filtered to the task's sessions:
 *
 * - `starting` until the machine admitted the prompt, then `running`; `waiting` while a permission or a question is
 *   pending; `offline` while the machine is unreachable, and `lost` once it stayed so for `LOST_AFTER`, or when its
 *   session disappeared.
 * - An execution ends as `idle`, `failed` or `interrupted`. Its end is told once to the chat's model, as a queued
 *   synthetic message whose id is chosen and stored first, so a retry, after a hub restart included, never tells it
 *   twice. A tool call that waited for the end gets it as its result instead.
 * - A message sent to the task afterwards (steer or queue) starts a new execution in the same session.
 * - Every row is in the hub's database: a restarted hub follows the active ones again, reconciles them with what the
 *   machine says once its stream is back, and retries the notifications it could not deliver.
 *
 * Browsers follow a task through `chat-tasks/<id>/api/event`, the task's slice of that stream, and read its session
 * through `chat-tasks/<id>/api/...`, a closed list of reads limited to the task's sessions. Writes go through the
 * routes of this module, which rebuild every body.
 */

/** A machine that stays unreachable this long loses its running tasks. */
const LOST_AFTER = 30 * 60 * 1000
/** Active tasks one user may have at a time. */
const MAX_ACTIVE = 8
/** Browsers following one task at a time. */
const MAX_FOLLOWERS = 8
const MAX_DIGEST = 20_000
const MAX_TITLE = 80
const MAX_EXCERPT = 500
const MAX_IMAGE = 5 * 1024 * 1024
const MAX_WAIT = 600
const KEEPALIVE = 15_000
const SWEEP_EVERY = 60_000
/** Ended tasks are forgotten after this long. */
const KEEP = 30 * 24 * 60 * 60 * 1000
/** A browser this far behind is cut, and reads the session again when it reconnects. */
const MAX_BACKLOG = 8 * 1024 * 1024
const RECORD_SOURCE = "hub-machine"
const ACTIVE = new Set<Store.ChatTaskStatus>(["starting", "running", "waiting", "offline"])
const PERMISSION_ID = /^per[A-Za-z0-9_]{1,80}$/
const FORM_ID = /^[A-Za-z0-9_-]{1,100}$/
const MEDIA_HASH = /^[0-9a-f]{64}$/
const IMAGE_URI = /^data:(image\/[A-Za-z0-9.+-]+);base64,/i

const SESSION = "[A-Za-z0-9_-]+"
const ROUTE = /^chat-tasks\/(tsk_[A-Za-z0-9]+)(?:\/(.*))?$/
const SESSION_READ = new RegExp(
  `^api/session/(${SESSION})(?:/message(?:/${SESSION})?|/inbox|/permission|/form(?:/${SESSION})?)?$`,
)
const MEDIA = /^api\/experimental\/media\/([0-9a-f]{64})$/

const Tokens = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  reasoning: Schema.Number,
  cache: Schema.Struct({ read: Schema.Number, write: Schema.Number }),
})
type Tokens = typeof Tokens.Type
const Usage = Schema.Struct({ cost: Schema.Number, tokens: Tokens })
const decodeUsage = Schema.decodeUnknownOption(Usage)
const decodeSession = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        cost: Schema.optional(Schema.Number),
        tokens: Schema.optional(Tokens),
        outcome: Schema.optional(Schema.String),
        time: Schema.optional(
          Schema.Struct({ busy: Schema.optional(Schema.Number), idle: Schema.optional(Schema.Number) }),
        ),
      }),
    }),
  ),
)
const decodeCreated = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })),
)
const decodeActive = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: Schema.Record(Schema.String, Schema.Unknown) })),
)
const decodePendingList = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) })),
)
const decodeId = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }))
const decodeFormEvent = Schema.decodeUnknownOption(Schema.Struct({ form: Schema.Struct({ id: Schema.String }) }))
const decodeSettled = Schema.decodeUnknownOption(
  Schema.Struct({ id: Schema.optional(Schema.String), requestID: Schema.optional(Schema.String) }),
)
const decodeError = Schema.decodeUnknownOption(
  Schema.Struct({ error: Schema.Struct({ message: Schema.optional(Schema.String) }) }),
)
const Part = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  state: Schema.optional(
    Schema.Struct({
      status: Schema.optional(Schema.String),
      input: Schema.optional(Schema.Unknown),
      error: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) })),
      content: Schema.optional(
        Schema.Array(
          Schema.Struct({
            type: Schema.String,
            text: Schema.optional(Schema.String),
            uri: Schema.optional(Schema.String),
            mime: Schema.optional(Schema.String),
            name: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
  ),
})
const Message = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  time: Schema.Struct({ created: Schema.Number }),
  text: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Array(Part)),
  command: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  exit: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.Struct({ output: Schema.String, truncated: Schema.optional(Schema.Boolean) })),
})
type Message = typeof Message.Type
const decodeMessages = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ data: Schema.Array(Message) })))
const Delivery = Schema.Literals(["steer", "queue"])
const decodePrompt = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ text: Schema.String, delivery: Schema.optional(Delivery) })),
)
const Decision = Schema.Literals(["once", "always", "reject"])
const decodeDecision = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ decision: Decision, session: Schema.optional(Schema.String) })),
)
const FormValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Array(Schema.String)])
const FormAnswer = Schema.Record(Schema.String, FormValue)
const decodeAnswer = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ answer: FormAnswer, session: Schema.optional(Schema.String) })),
)
const decodeFormSession = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ session: Schema.optional(Schema.String) })),
)
const decodeStart = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      session: Schema.String,
      prompt: Schema.String,
      machine: Schema.optional(Schema.String),
      directory: Schema.optional(Schema.String),
      agent: Schema.optional(Schema.String),
    }),
  ),
)
const isString = Schema.is(Schema.String)

export type Decision = typeof Decision.Type
export type Answer = typeof FormAnswer.Type

type Request_ = {
  user: string
  machine: string
  method: string
  path: string
  body?: unknown
  headers?: [string, string][]
  signal?: AbortSignal
}

/** A browser following a task's events. */
type Follower = { send: (text: string) => boolean; close: () => void }

/** What the hub knows of a followed task beyond its row: its sessions, their usage, what waits for an answer. */
type Live = {
  id: string
  user: string
  machine: string
  sessions: Set<string>
  usage: Map<string, typeof Usage.Type>
  permissions: Map<string, string>
  forms: Map<string, string>
  followers: Set<Follower>
  /** Tool calls waiting for the end of the current execution, which then get its result. */
  waiters: Set<(result: string) => void>
  /** Who stopped the current execution: a stop the chat's model asked for needs no notification. */
  stopped?: "model" | "user"
  lost?: ReturnType<typeof setTimeout>
  unsubscribe?: () => void
}

/** A task as browsers and the chat's model see it. */
export type View = ReturnType<ReturnType<typeof create>["view"]>

export function create(input: {
  store: Store.Instance
  request: (request: Request_) => Promise<Response>
  watch: ChatWatch.Instance
  online: (machine: string) => boolean
  /** The machines a user may open, with their names and whether they are connected. */
  machines: (user: string) => readonly { id: string; name: string; online: boolean }[]
  model: (user: string, session: string) => Promise<{ id: string; providerID: string; variant?: string } | undefined>
  /** The data-URI files of the last user message of a chat session. */
  files: (user: string, session: string) => Promise<readonly { uri: string; name?: string }[]>
  /** Adds a message to a chat session. */
  record: (user: string, session: string, message: Recorded) => Promise<unknown>
  log?: (message: string) => void
}) {
  const store = input.store
  const lives = new Map<string, Live>()
  /** Browsers following all of a user's tasks, by user. */
  const watchers = new Map<string, Set<Follower>>()

  // A restarted hub follows its active tasks again and retries the notifications it could not send.
  store.pendingChatTasks().forEach((task) => {
    if (task.status === "starting" && !task.remote_session)
      return store.updateChatTask(task.id, {
        status: "failed",
        error: "The hub restarted before the task started.",
        ended_at: Date.now(),
      })
    if (ACTIVE.has(task.status)) return void follow(task)
    void notify(task)
  })
  const sweep = setInterval(() => {
    store.purgeChatTasks(Date.now() - KEEP)
    store
      .pendingChatTasks()
      .filter((task) => !ACTIVE.has(task.status))
      .forEach((task) => void notify(task))
  }, SWEEP_EVERY)
  sweep.unref?.()

  return {
    handle,
    view,
    start,
    list: (user: string, session?: string) => store.chatTasks(user, session).map(view),
    /** A task of the chat session, or undefined: tools only act on their own conversation's tasks. */
    find: (user: string, session: string, id: string) => {
      const task = store.chatTask(user, id)
      return task && task.session_id === session ? task : undefined
    },
    status,
    read,
    send,
    stop,
    pending,
    replyPermission,
    answer,
    images,
    image,
    /** Forgets a deleted chat session's tasks. */
    forget(user: string, session: string) {
      store
        .chatTasks(user, session)
        .forEach((task) => lives.get(task.id) && release(lives.get(task.id)!, { force: true }))
      store.deleteChatTasks(user, session)
    },
    close: () => {
      clearInterval(sweep)
      lives.forEach((live) => release(live, { force: true }))
      watchers.forEach((set) => set.forEach((follower) => follower.close()))
    },
  }

  function view(task: Store.ChatTask) {
    const live = lives.get(task.id)
    return {
      id: task.id,
      session: task.session_id,
      machine: task.machine_id,
      machineName: store.machine(task.machine_id)?.name ?? task.machine_id,
      machineOnline: input.online(task.machine_id),
      directory: task.directory,
      remoteSession: task.remote_session,
      title: task.title,
      agent: task.agent,
      status: task.status,
      createdAt: task.created_at,
      startedAt: task.started_at,
      endedAt: task.ended_at,
      outcome: task.outcome,
      error: task.error,
      tokens: {
        input: task.tokens_input,
        output: task.tokens_output,
        reasoning: task.tokens_reasoning,
        cache: { read: task.tokens_cache_read, write: task.tokens_cache_write },
      },
      cost: task.cost,
      pending: { permissions: live?.permissions.size ?? 0, questions: live?.forms.size ?? 0 },
    }
  }

  async function handle(request: Request, route: string, current: Current) {
    const user = current.user.id
    const method = request.method
    if (route === "chat-tasks" && method === "GET") {
      const session = new URL(request.url).searchParams.get("session") ?? undefined
      return json(200, { data: store.chatTasks(user, session).map(view) })
    }
    if (route === "chat-tasks" && method === "POST") {
      const body = Option.getOrUndefined(decodeStart(await request.text()))
      if (!body) return json(400, { error: "Expected { session, prompt, machine?, directory?, agent? }." })
      const started = await start({ user, ...body }).catch((error: unknown) => new Refusal(502, describe(error)))
      if (started instanceof Refusal) return json(started.status, { error: started.message })
      return json(200, view(started))
    }
    if (route === "chat-tasks/events" && method === "GET") return userEvents(request, user)
    const match = ROUTE.exec(route)
    if (!match) return undefined
    const task = store.chatTask(user, match[1]!)
    // Another user's task answers like one that does not exist.
    if (!task) return json(404, { error: "Unknown task." })
    const rest = match[2] ?? ""
    if (rest === "" && method === "GET") return json(200, view(task))
    if (rest === "api/event" && method === "GET") return taskEvents(request, task)
    if (rest.startsWith("api/"))
      return method === "GET" ? proxy(request, task, rest) : json(405, { error: "Read only." })
    if (rest === "run" && method === "DELETE") return respond(stop(task, "user"))
    if (rest === "background" && method === "POST") return respond(background(task))
    if (rest === "prompt" && method === "POST") {
      const body = Option.getOrUndefined(decodePrompt(await request.text()))
      if (!body || !body.text.trim()) return json(400, { error: "Expected { text, delivery? }." })
      return respond(send(task, body.text, body.delivery))
    }
    const permission = /^permission\/([^/]+)$/.exec(rest)
    if (permission && method === "POST") {
      const body = Option.getOrUndefined(decodeDecision(await request.text()))
      if (!body) return json(400, { error: "Expected { decision, session? }." })
      return respond(replyPermission(task, permission[1]!, body.decision, body.session, "user"))
    }
    const form = /^form\/([^/]+)$/.exec(rest)
    if (form && method === "POST") {
      const body = Option.getOrUndefined(decodeAnswer(await request.text()))
      if (!body) return json(400, { error: "Expected { answer, session? }." })
      return respond(answer(task, form[1]!, body.answer, body.session, "user"))
    }
    if (form && method === "DELETE") {
      const body = Option.getOrUndefined(decodeFormSession((await request.text()) || "{}"))
      return respond(answer(task, form[1]!, undefined, body?.session, "user"))
    }
    const shot = /^image\/(\d{1,3})$/.exec(rest)
    if (shot && method === "GET") {
      const found = await image(task, Number(shot[1]))
      if (found instanceof Refusal) return json(found.status, { error: found.message })
      return new Response(found.bytes, {
        headers: {
          "content-type": found.mime,
          "cache-control": "private, max-age=3600",
          "x-content-type-options": "nosniff",
        },
      })
    }
    return json(404, { error: "Not found." })
  }

  /** Starts a task, or sends the prompt to an existing one with `continue`; resolves once the machine admitted it. */
  async function start(request: {
    user: string
    session: string
    prompt: string
    images?: boolean
    machine?: string
    directory?: string
    agent?: string
    continue?: string
  }) {
    if (request.continue !== undefined) {
      const existing = store.chatTask(request.user, request.continue)
      if (!existing || existing.session_id !== request.session) throw new Refusal(404, "Unknown task.")
      const sent = await send(existing, request.prompt, "queue")
      if (sent instanceof Refusal) throw sent
      return store.chatTask(request.user, existing.id)!
    }
    const target = store.chatTarget(request.user, request.session)
    const machine = resolveMachine(request.user, request.machine ?? target?.machine_id)
    if (!machine)
      throw new Refusal(
        404,
        request.machine === undefined
          ? "No machine is attached to this conversation. Name one, or ask the user to attach one with the + button."
          : `The user has no machine named ${request.machine}.`,
      )
    const directory = request.directory ?? (target?.machine_id === machine.id ? target.directory : undefined)
    if (!directory?.startsWith("/")) throw new Refusal(400, "Name the absolute folder to work in on that machine.")
    if (!input.online(machine.id)) throw new Refusal(409, `${machine.name} is not connected to the hub.`)
    const active = store.chatTasks(request.user).filter((task) => ACTIVE.has(task.status)).length
    if (active >= MAX_ACTIVE)
      throw new Refusal(429, `At most ${MAX_ACTIVE} tasks run at a time: wait for one to end, or stop one.`)
    const task = store.createChatTask({
      id: ascendingID("tsk_"),
      user: request.user,
      session: request.session,
      machine: machine.id,
      directory,
      title: titleOf(request.prompt),
      prompt: request.prompt.slice(0, MAX_EXCERPT),
      agent: request.agent,
    })
    const live = follow(task)
    broadcast(task)
    const failed = (message: string) => {
      store.updateChatTask(task.id, { status: "failed", error: message, ended_at: Date.now() })
      broadcast(task)
      release(live)
      return new Refusal(502, message)
    }
    const call = caller(task)
    const model = await input.model(request.user, request.session)
    const created = await call("POST", "/api/session", {
      title: task.title,
      location: { directory },
      ...(model ? { model } : {}),
      ...(request.agent ? { agent: request.agent } : {}),
    }).catch((error: unknown) => error as Error)
    if (created instanceof Error) throw failed(created.message)
    if (!created.ok) throw failed(await failureText(created))
    const remote = Option.getOrUndefined(decodeCreated(await created.text()))?.data.id
    if (!remote) throw failed("The machine did not create a session.")
    live.sessions.add(remote)
    store.updateChatTask(task.id, { remote_session: remote })
    const files = request.images ? await input.files(request.user, request.session) : []
    const sent = await call("POST", `/api/session/${remote}/prompt`, {
      text: request.prompt,
      ...(files.length > 0 ? { files } : {}),
    }).catch((error: unknown) => error as Error)
    if (sent instanceof Error) throw failed(sent.message)
    if (!sent.ok) throw failed(await failureText(sent))
    const now = store.chatTask(request.user, task.id)!
    // The stream may already have reported the execution.
    if (now.status === "starting") store.updateChatTask(task.id, { status: "running", started_at: Date.now() })
    broadcast(task)
    return store.chatTask(request.user, task.id)!
  }

  /** Waits up to `seconds` for the task's execution to end: its final message, or undefined if it still runs. */
  function wait(task: Store.ChatTask, seconds: number) {
    const live = lives.get(task.id)
    if (!live || seconds <= 0 || !ACTIVE.has(store.chatTask(task.user_id, task.id)?.status ?? "idle"))
      return Promise.resolve(undefined)
    const done = Promise.withResolvers<string | undefined>()
    const resolve = (result: string) => done.resolve(result)
    live.waiters.add(resolve)
    const timer = setTimeout(() => done.resolve(undefined), Math.min(seconds, MAX_WAIT) * 1000)
    return done.promise.finally(() => {
      clearTimeout(timer)
      live.waiters.delete(resolve)
    })
  }

  /** The task's state, what waits for an answer, and its latest activity, for the chat's model. */
  async function status(task: Store.ChatTask, waitSeconds = 0) {
    const ended = await wait(task, waitSeconds)
    const current = store.chatTask(task.user_id, task.id) ?? task
    const shown = view(current)
    const waiting = await pending(current)
    return {
      ...shown,
      ...(ended === undefined ? {} : { result: ended }),
      waitingFor: waiting,
    }
  }

  /** A bounded digest of the task's latest messages, oldest first. */
  async function read(task: Store.ChatTask, limit = 20) {
    if (!task.remote_session) return "The task has no session yet."
    const messages = await readMessages(task, Math.min(Math.max(limit, 1), 100))
    if (!messages) return "The machine did not answer."
    const lines = messages
      .toReversed()
      .flatMap((message) => digest(message))
      .join("\n\n")
    return lines.length > MAX_DIGEST
      ? `[Earlier messages cut]\n${lines.slice(-MAX_DIGEST)}`
      : lines || "No messages yet."
  }

  async function send(task: Store.ChatTask, text: string, delivery: "steer" | "queue" | undefined) {
    if (!task.remote_session) return new Refusal(409, "The task has not started yet.")
    if (!input.online(task.machine_id)) return new Refusal(409, "The machine is not connected to the hub.")
    const live = follow(task)
    live.stopped = undefined
    const response = await caller(task)("POST", `/api/session/${task.remote_session}/prompt`, {
      text,
      ...(delivery ? { delivery } : {}),
    }).catch((error: unknown) => error as Error)
    if (response instanceof Error) return new Refusal(502, response.message)
    if (response.status === 404) {
      markLost(task, "The task's session is gone from the machine.")
      return new Refusal(404, "The task's session is gone from the machine.")
    }
    if (!response.ok) return new Refusal(502, await failureText(response))
    if (!ACTIVE.has(task.status))
      store.updateChatTask(task.id, {
        status: "running",
        ended_at: null,
        outcome: null,
        error: null,
        notify_id: null,
        notified_at: null,
      })
    broadcast(task)
    return undefined
  }

  async function stop(task: Store.ChatTask, by: "model" | "user") {
    if (!task.remote_session) return new Refusal(409, "The task has not started yet.")
    if (!input.online(task.machine_id)) return new Refusal(409, "The machine is not connected to the hub.")
    const live = lives.get(task.id)
    if (live) live.stopped = by
    const response = await caller(task)("POST", `/api/session/${task.remote_session}/interrupt`, {}).catch(
      (error: unknown) => error as Error,
    )
    if (response instanceof Error) return new Refusal(502, response.message)
    if (!response.ok && response.status !== 404) return new Refusal(502, await failureText(response))
    return undefined
  }

  async function background(task: Store.ChatTask) {
    if (!task.remote_session) return new Refusal(409, "The task has not started yet.")
    const response = await caller(task)("POST", `/api/session/${task.remote_session}/background`, {}).catch(
      (error: unknown) => error as Error,
    )
    if (response instanceof Error) return new Refusal(502, response.message)
    if (!response.ok) return new Refusal(502, await failureText(response))
    return undefined
  }

  /** The permissions and questions the task's sessions wait on, as the machine lists them. */
  async function pending(task: Store.ChatTask) {
    const live = lives.get(task.id)
    const sessions = live ? Array.from(live.sessions) : task.remote_session ? [task.remote_session] : []
    if (!ACTIVE.has(task.status) || sessions.length === 0) return { permissions: [], questions: [] }
    const call = caller(task)
    const lists = await Promise.all(
      sessions.map(async (session) => {
        const [permissions, forms] = await Promise.all([
          listOf(call, `/api/session/${session}/permission`),
          listOf(call, `/api/session/${session}/form`),
        ])
        return {
          permissions: permissions.map((entry) => ({ session, ...entry })),
          questions: forms.map((entry) => ({ session, ...entry })),
        }
      }),
    )
    return {
      permissions: lists.flatMap((entry) => entry.permissions),
      questions: lists.flatMap((entry) => entry.questions),
    }
  }

  async function replyPermission(
    task: Store.ChatTask,
    request: string,
    decision: Decision,
    session: string | undefined,
    by: "model" | "user",
  ) {
    const target = sessionOf(task, session)
    if (!target || !PERMISSION_ID.test(request)) return new Refusal(404, "Unknown permission request.")
    const response = await caller(task)("POST", `/api/session/${target}/permission/${request}/reply`, {
      decision,
    }).catch((error: unknown) => error as Error)
    if (response instanceof Error) return new Refusal(502, response.message)
    if (response.status === 404) return new Refusal(404, "Unknown permission request.")
    if (!response.ok) return new Refusal(502, await failureText(response))
    input.log?.(
      `hub chat: ${by === "model" ? "the chat's model" : "the user"} answered ${decision} to ${request} of task ${task.id} for ${task.user_id}`,
    )
    return undefined
  }

  /** Answers a question form, or dismisses it without an answer. */
  async function answer(
    task: Store.ChatTask,
    form: string,
    value: Answer | undefined,
    session: string | undefined,
    by: "model" | "user",
  ) {
    const target = sessionOf(task, session)
    if (!target || !FORM_ID.test(form)) return new Refusal(404, "Unknown question.")
    const response = await (
      value === undefined
        ? caller(task)("DELETE", `/api/session/${target}/form/${form}`)
        : caller(task)("POST", `/api/session/${target}/form/${form}/reply`, { answer: value })
    ).catch((error: unknown) => error as Error)
    if (response instanceof Error) return new Refusal(502, response.message)
    if (response.status === 404) return new Refusal(404, "Unknown question.")
    if (!response.ok) return new Refusal(response.status === 400 ? 400 : 502, await failureText(response))
    input.log?.(
      `hub chat: ${by === "model" ? "the chat's model" : "the user"} ${value === undefined ? "dismissed" : "answered"} question ${form} of task ${task.id} for ${task.user_id}`,
    )
    return undefined
  }

  /** The images the task's tools returned (screenshots and the like), newest first. */
  async function images(task: Store.ChatTask) {
    if (!task.remote_session) return []
    const messages = (await readMessages(task, 50)) ?? []
    return messages.flatMap((message) =>
      (message.content ?? []).flatMap((part) =>
        part.type === "tool"
          ? (part.state?.content ?? []).flatMap((item) => {
              const mime = item.uri?.startsWith("data:") ? IMAGE_URI.exec(item.uri)?.[1] : item.mime
              if (item.type !== "file" || !item.uri || !mime?.startsWith("image/")) return []
              return [{ uri: item.uri, mime, name: item.name ?? part.name ?? "image", tool: part.name ?? "" }]
            })
          : [],
      ),
    )
  }

  /** The bytes of one of the task's images, by its place in `images`. */
  async function image(task: Store.ChatTask, index: number) {
    const found = (await images(task))[index]
    if (!found) return new Refusal(404, "No such image.")
    const inline = IMAGE_URI.exec(found.uri)
    if (inline) {
      const bytes = Buffer.from(found.uri.slice(inline[0].length), "base64")
      if (bytes.byteLength > MAX_IMAGE) return new Refusal(413, "The image is over 5 MB.")
      return { bytes: new Uint8Array(bytes), mime: inline[1]!.toLowerCase(), name: found.name }
    }
    const hash = /^media:([0-9a-f]{64})$/.exec(found.uri)?.[1]
    if (!hash || !MEDIA_HASH.test(hash)) return new Refusal(404, "No such image.")
    const response = await caller(task)("GET", `/api/experimental/media/${hash}`).catch(() => undefined)
    if (!response?.ok) return new Refusal(502, "The machine did not send the image.")
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_IMAGE) return new Refusal(413, "The image is over 5 MB.")
    return { bytes, mime: found.mime, name: found.name }
  }

  /** Follows a task: its sessions' events, until it ends and no browser follows it. */
  function follow(task: Store.ChatTask) {
    const known = lives.get(task.id)
    if (known) return known
    const live: Live = {
      id: task.id,
      user: task.user_id,
      machine: task.machine_id,
      sessions: new Set(task.remote_session ? [task.remote_session] : []),
      usage: new Map(),
      permissions: new Map(),
      forms: new Map(),
      followers: new Set(),
      waiters: new Set(),
    }
    lives.set(task.id, live)
    live.unsubscribe = input.watch.subscribe(task.user_id, task.machine_id, {
      event: (event) => receive(live, event),
      status: (connected) => connection(live, connected),
    })
    return live
  }

  /** Stops following a task that ended, unless browsers still do. */
  function release(live: Live, options: { force?: boolean } = {}) {
    const task = store.chatTask(live.user, live.id)
    if (!options.force && (live.followers.size > 0 || (task && ACTIVE.has(task.status)))) return
    clearTimeout(live.lost)
    live.unsubscribe?.()
    live.followers.forEach((follower) => follower.close())
    lives.delete(live.id)
  }

  function receive(live: Live, event: ChatWatch.Event) {
    if (event.type === "server.connected") {
      forward(live, event.json)
      return void reconcile(live)
    }
    if (event.type === "session.created" && event.parent && live.sessions.has(event.parent) && event.session)
      live.sessions.add(event.session)
    if (!event.session || !live.sessions.has(event.session)) return
    forward(live, event.json)
    const task = store.chatTask(live.user, live.id)
    if (!task) return
    const root = event.session === task.remote_session
    if (event.type === "session.execution.started" && root) {
      store.updateChatTask(task.id, {
        status: live.permissions.size + live.forms.size > 0 ? "waiting" : "running",
        started_at: task.started_at ?? Date.now(),
        ...(ACTIVE.has(task.status)
          ? {}
          : { ended_at: null, outcome: null, error: null, notify_id: null, notified_at: null }),
      })
      return broadcast(task)
    }
    if (event.type === "session.execution.succeeded" && root) return void finish(live, "succeeded")
    if (event.type === "session.execution.interrupted" && root) return void finish(live, "interrupted")
    if (event.type === "session.execution.failed" && root)
      return void finish(live, "failed", Option.getOrUndefined(decodeError(event.data))?.error.message)
    if (event.type === "session.deleted" && root)
      return markLost(task, "The task's session was deleted on the machine.")
    if (event.type === "session.usage.updated") {
      const usage = Option.getOrUndefined(decodeUsage(event.data))
      if (!usage) return
      live.usage.set(event.session, usage)
      store.updateChatTask(task.id, totals(live))
      return broadcast(task)
    }
    if (event.type === "permission.asked") {
      const id = Option.getOrUndefined(decodeId(event.data))?.id
      if (id) live.permissions.set(id, event.session)
      return settle(live)
    }
    if (event.type === "form.created") {
      const id = Option.getOrUndefined(decodeFormEvent(event.data))?.form.id
      if (id) live.forms.set(id, event.session)
      return settle(live)
    }
    if (event.type === "permission.replied" || event.type === "form.replied" || event.type === "form.cancelled") {
      const settled = Option.getOrUndefined(decodeSettled(event.data))
      if (settled?.requestID) live.permissions.delete(settled.requestID)
      if (settled?.id) live.forms.delete(settled.id)
      return settle(live)
    }
  }

  /** `waiting` while anything waits for an answer, `running` again once nothing does. */
  function settle(live: Live) {
    const task = store.chatTask(live.user, live.id)
    if (!task || !ACTIVE.has(task.status)) return broadcast({ user_id: live.user, id: live.id })
    const next = live.permissions.size + live.forms.size > 0 ? "waiting" : "running"
    if (task.status !== next && task.status !== "starting") store.updateChatTask(task.id, { status: next })
    broadcast(task)
  }

  function connection(live: Live, connected: boolean) {
    const task = store.chatTask(live.user, live.id)
    if (!task) return
    if (connected) {
      clearTimeout(live.lost)
      live.lost = undefined
      return
    }
    if (!ACTIVE.has(task.status)) return
    store.updateChatTask(task.id, { status: "offline" })
    broadcast(task)
    clearTimeout(live.lost)
    live.lost = setTimeout(() => {
      const current = store.chatTask(live.user, live.id)
      if (current?.status === "offline") markLost(current, "The machine stayed unreachable.")
    }, LOST_AFTER)
    live.lost.unref?.()
  }

  /**
   * Brings a task in line with the machine once its stream is (back) up: what waits for an answer, its usage, and
   * whether the execution it was following ended meanwhile.
   */
  async function reconcile(live: Live) {
    const task = store.chatTask(live.user, live.id)
    if (!task?.remote_session) return
    const call = caller(task)
    const response = await call("GET", `/api/session/${task.remote_session}`).catch(() => undefined)
    if (!response) return
    if (response.status === 404) return markLost(task, "The task's session is gone from the machine.")
    if (!response.ok) return
    const session = Option.getOrUndefined(decodeSession(await response.text()))?.data
    if (session?.tokens && session.cost !== undefined)
      live.usage.set(task.remote_session, { cost: session.cost, tokens: session.tokens })
    const [active, lists] = await Promise.all([
      call("GET", "/api/session/active")
        .then(async (result) =>
          result.ok ? Option.getOrUndefined(decodeActive(await result.text()))?.data : undefined,
        )
        .catch(() => undefined),
      pendingIDs(call, Array.from(live.sessions)),
    ])
    live.permissions = lists.permissions
    live.forms = lists.forms
    const current = store.chatTask(live.user, live.id)
    if (!current) return
    store.updateChatTask(current.id, totals(live))
    const busy = active === undefined ? undefined : task.remote_session in active
    if (busy === true || !ACTIVE.has(current.status)) return settle(live)
    if (busy === false && current.status !== "starting") {
      const outcome = session?.outcome ?? "succeeded"
      return void finish(live, outcome === "failed" || outcome === "interrupted" ? outcome : "succeeded")
    }
    settle(live)
  }

  async function finish(live: Live, outcome: "succeeded" | "failed" | "interrupted", error?: string) {
    const task = store.chatTask(live.user, live.id)
    if (!task?.remote_session || !ACTIVE.has(task.status)) return
    const stopped = live.stopped
    live.stopped = undefined
    // A tool call that waited for this end gets the result itself; a stop the model asked for needs no report.
    const silent = live.waiters.size > 0 || stopped === "model"
    // Claimed before reading anything, so a repeated or concurrent end is ignored.
    store.updateChatTask(task.id, {
      status: outcome === "succeeded" ? "idle" : outcome,
      outcome,
      ended_at: Date.now(),
      ...(error ? { error } : {}),
      ...totals(live),
      ...(silent
        ? { notified_at: Date.now(), notify_id: null }
        : { notify_id: ascendingID("msg_"), notified_at: null }),
    })
    broadcast(task)
    const messages = await readMessages(task, 30)
    const result = messages ? finalMessage(messages, outcome) : "The task ended; its messages could not be read."
    live.waiters.forEach((resolve) => resolve(result))
    if (!silent) await notify(store.chatTask(live.user, live.id)!, result)
    release(live)
  }

  function markLost(task: Store.ChatTask, reason: string) {
    if (!ACTIVE.has(task.status)) return
    store.updateChatTask(task.id, {
      status: "lost",
      error: reason,
      ended_at: Date.now(),
      notify_id: ascendingID("msg_"),
      notified_at: null,
    })
    lives.get(task.id)?.waiters.forEach((resolve) => resolve(reason))
    broadcast(task)
    void notify(store.chatTask(task.user_id, task.id)!, reason)
    const live = lives.get(task.id)
    if (live) release(live)
  }

  /** Tells the chat's model how the task's last execution ended, once: the engine ignores a message id it knows. */
  async function notify(task: Store.ChatTask, result?: string) {
    if (!task.notify_id || task.notified_at !== null) return
    const machine = store.machine(task.machine_id)?.name ?? task.machine_id
    const state = task.status === "idle" ? "completed" : task.status === "interrupted" ? "cancelled" : "error"
    const ended =
      task.status === "idle"
        ? "finished"
        : task.status === "interrupted"
          ? "was stopped"
          : task.status === "lost"
            ? "was lost"
            : "failed"
    const shots = result === undefined ? 0 : (await images(task).catch(() => [])).length
    const body =
      result ??
      (task.error
        ? task.error
        : "Its final message could not be read when it ended: read it with machine_task_read before relying on it.")
    const recorded = await input
      .record(task.user_id, task.session_id, {
        id: task.notify_id,
        description: `${task.title} — ${machine}`,
        text: `Task ${task.id} on ${machine} ${ended}.${shots > 0 ? ` It produced ${shots} image(s): machine_task_image shows them.` : ""}\n\n${body}`,
        metadata: {
          source: RECORD_SOURCE,
          kind: "task",
          task: task.id,
          machine,
          title: task.title,
          state,
          ...(shots > 0 ? { images: Math.min(shots, 4) } : {}),
        },
        delivery: "queue",
        resume: true,
      })
      .then(
        (response) => !(response instanceof Response) || response.ok || response.status === 409,
        () => false,
      )
    if (recorded) store.updateChatTask(task.id, { notified_at: Date.now() })
  }

  function forward(live: Live, text: string) {
    const frame = `data: ${text}\n\n`
    live.followers.forEach((follower) => {
      if (follower.send(frame)) return
      // Too far behind: cut it with a reason, it reads the session again when it reconnects.
      follower.send(`data: ${JSON.stringify({ type: "hub.task.resync", data: { task: live.id } })}\n\n`)
      follower.close()
    })
  }

  /** Tells the task's followers, and the browsers following all of its user's tasks, where it stands now. */
  function broadcast(task: { user_id: string; id: string }) {
    const row = store.chatTask(task.user_id, task.id)
    if (!row) return
    const frame = `data: ${JSON.stringify({ type: "hub.task.updated", data: view(row) })}\n\n`
    lives.get(row.id)?.followers.forEach((follower) => follower.send(frame))
    watchers.get(row.user_id)?.forEach((follower) => follower.send(frame))
  }

  /** `chat-tasks/<id>/api/event`: the task's events, preceded by `server.connected` and its current state. */
  function taskEvents(request: Request, task: Store.ChatTask) {
    const live = follow(task)
    if (live.followers.size >= MAX_FOLLOWERS) return json(429, { error: "Too many viewers of this task." })
    return stream(
      request,
      live.followers,
      () => {
        release(live)
      },
      [
        `data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`,
        `data: ${JSON.stringify({ type: "hub.task.updated", data: view(store.chatTask(task.user_id, task.id) ?? task) })}\n\n`,
      ],
    )
  }

  /** `chat-tasks/events`: every change to the user's tasks. */
  function userEvents(request: Request, user: string) {
    const set = watchers.get(user) ?? new Set<Follower>()
    watchers.set(user, set)
    return stream(
      request,
      set,
      () => {
        if (set.size === 0) watchers.delete(user)
      },
      [`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`],
    )
  }

  function stream(request: Request, set: Set<Follower>, closed: () => void, first: string[]) {
    const encoder = new TextEncoder()
    const state = {} as { follower?: Follower; timer?: ReturnType<typeof setInterval>; open: boolean }
    state.open = true
    const cleanup = () => {
      if (!state.open) return
      state.open = false
      clearInterval(state.timer)
      if (state.follower) set.delete(state.follower)
      closed()
    }
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          state.follower = {
            send(text) {
              if (!state.open) return true
              controller.enqueue(encoder.encode(text))
              return (controller.desiredSize ?? 0) > -MAX_BACKLOG
            },
            close() {
              if (!state.open) return
              cleanup()
              controller.close()
            },
          }
          set.add(state.follower)
          first.forEach((text) => controller.enqueue(encoder.encode(text)))
          state.timer = setInterval(() => state.follower?.send(": heartbeat\n\n"), KEEPALIVE)
        },
        cancel: cleanup,
      },
      new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }),
    )
    request.signal.addEventListener("abort", cleanup, { once: true })
    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" },
    })
  }

  /**
   * The reads a browser needs to show the task's session with OpenCode's own components: the task's sessions, their
   * messages, inbox, permissions and questions, the media they reference, which sessions run, and the machine's agents.
   */
  async function proxy(request: Request, task: Store.ChatTask, route: string) {
    if (!task.remote_session) return json(404, { error: "The task has no session yet." })
    const live = lives.get(task.id)
    const sessions = live?.sessions ?? new Set([task.remote_session])
    const search = new URL(request.url).searchParams
    const capabilities = request.headers.get("x-opencode-capabilities")
    const headers: [string, string][] =
      capabilities === "experimental-media-uri" ? [["x-opencode-capabilities", capabilities]] : []
    const forward = async (path: string) => {
      const response = await caller(task)("GET", path, undefined, headers).catch(() => undefined)
      if (!response) return json(502, { error: "The machine did not answer." })
      return new Response(response.body, {
        status: response.status,
        headers: {
          "content-type": response.headers.get("content-type") ?? "application/json",
          "cache-control": "no-store",
        },
      })
    }
    if (route === "api/session/active") {
      const response = await caller(task)("GET", "/api/session/active").catch(() => undefined)
      const active = response?.ok ? Option.getOrUndefined(decodeActive(await response.text()))?.data : undefined
      if (!active) return json(502, { error: "The machine did not answer." })
      return json(200, Object.fromEntries(Object.entries(active).filter((entry) => sessions.has(entry[0]))))
    }
    const session = SESSION_READ.exec(route)
    if (session) {
      if (!sessions.has(session[1]!)) return json(404, { error: "Unknown session." })
      const query = new URLSearchParams(
        ["limit", "order", "cursor", "type"].flatMap((key): [string, string][] => {
          const value = search.get(key)
          return value === null ? [] : [[key, value]]
        }),
      )
      return forward(`/${route}${query.size ? `?${query}` : ""}`)
    }
    if (route === "api/session") {
      const parent = search.get("parentID")
      if (!parent || !sessions.has(parent)) return json(404, { error: "Not found." })
      return forward(`/api/session?${new URLSearchParams({ parentID: parent, limit: search.get("limit") ?? "200" })}`)
    }
    if (MEDIA.test(route)) return forward(`/${route}`)
    // Where the task runs, never anywhere else on the machine.
    const located = `location%5Bdirectory%5D=${encodeURIComponent(task.directory)}`
    if (route === "api/location" || route === "api/vcs") return forward(`/${route}?${located}`)
    if (route === "api/agent") return forward(`/api/agent?${located}`)
    return json(404, { error: "Not found." })
  }

  function sessionOf(task: Store.ChatTask, session: string | undefined) {
    const target = session ?? task.remote_session ?? undefined
    if (!target) return undefined
    const live = lives.get(task.id)
    return target === task.remote_session || live?.sessions.has(target) ? target : undefined
  }

  function resolveMachine(user: string, name: string | undefined) {
    if (name === undefined) return undefined
    const key = name.toLowerCase()
    const machines = input.machines(user)
    return (
      machines.find((machine) => machine.id === name) ?? machines.find((machine) => machine.name.toLowerCase() === key)
    )
  }

  function caller(task: Store.ChatTask) {
    return (method: string, path: string, body?: unknown, headers?: [string, string][]) =>
      input.request({ user: task.user_id, machine: task.machine_id, method, path, body, headers })
  }

  async function readMessages(task: Store.ChatTask, limit: number) {
    if (!task.remote_session) return undefined
    const response = await caller(task)("GET", `/api/session/${task.remote_session}/message?limit=${limit}`).catch(
      () => undefined,
    )
    return response?.ok ? Option.getOrUndefined(decodeMessages(await response.text()))?.data : undefined
  }
}

export type Instance = ReturnType<typeof create>

/** A refusal answered to the browser or the model with this status. */
export class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function respond(result: Promise<Refusal | undefined>) {
  return result.then((refused) =>
    refused ? json(refused.status, { error: refused.message }) : new Response(null, { status: 204 }),
  )
}

function totals(live: Live) {
  const all = Array.from(live.usage.values())
  const sum = (pick: (usage: typeof Usage.Type) => number) => all.reduce((total, usage) => total + pick(usage), 0)
  return {
    tokens_input: sum((usage) => usage.tokens.input),
    tokens_output: sum((usage) => usage.tokens.output),
    tokens_reasoning: sum((usage) => usage.tokens.reasoning),
    tokens_cache_read: sum((usage) => usage.tokens.cache.read),
    tokens_cache_write: sum((usage) => usage.tokens.cache.write),
    cost: sum((usage) => usage.cost),
  }
}

async function listOf(call: (method: string, path: string) => Promise<Response>, path: string) {
  const response = await call("GET", path).catch(() => undefined)
  return response?.ok ? (Option.getOrUndefined(decodePendingList(await response.text()))?.data ?? []) : []
}

async function pendingIDs(call: (method: string, path: string) => Promise<Response>, sessions: string[]) {
  const lists = await Promise.all(
    sessions.map(async (session) => ({
      session,
      permissions: await listOf(call, `/api/session/${session}/permission`),
      forms: await listOf(call, `/api/session/${session}/form`),
    })),
  )
  const ids = (pick: (entry: (typeof lists)[number]) => readonly Record<string, unknown>[]) =>
    new Map(
      lists.flatMap((entry) =>
        pick(entry).flatMap((item) => (isString(item.id) ? [[item.id, entry.session] as const] : [])),
      ),
    )
  return { permissions: ids((entry) => entry.permissions), forms: ids((entry) => entry.forms) }
}

/** One message of a task, as lines the chat's model reads. */
function digest(message: Message): string[] {
  if (message.type === "user") return [`User: ${message.text ?? ""}`]
  if (message.type === "synthetic") return [`Note: ${message.description ?? message.text ?? ""}`]
  if (message.type === "shell")
    return [
      `$ ${message.command ?? ""} (${message.exit === undefined ? (message.status ?? "running") : `exit ${message.exit}`})${message.output?.output ? `\n${message.output.output.slice(-2000)}` : ""}`,
    ]
  if (message.type !== "assistant") return []
  return (message.content ?? []).flatMap((part) => {
    if (part.type === "text" && part.text) return [`Agent: ${part.text}`]
    if (part.type !== "tool") return []
    const files = (part.state?.content ?? []).filter((item) => item.type === "file").length
    const error = part.state?.error?.message
    return [
      `Tool ${part.name ?? "?"} (${part.state?.status ?? "?"})${files > 0 ? `, ${files} file(s)` : ""}${error ? `: ${error}` : ""}`,
    ]
  })
}

function titleOf(prompt: string) {
  const line = prompt.trim().split("\n")[0]?.trim() ?? ""
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line || "Task"
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function failureText(response: Response) {
  const text = await response.text().catch(() => "")
  return `The machine answered ${response.status}${text ? `: ${text.slice(0, 300)}` : "."}`
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const clock = { last: 0, counter: 0 }

/** An id that sorts by creation time, in opencode's format: `<prefix>` then 12 hex digits of time and 14 random characters. */
export function ascendingID(prefix: string) {
  const now = Date.now()
  clock.counter = now === clock.last ? clock.counter + 1 : 0
  clock.last = now
  const time = (BigInt(now) * 0x1000n + BigInt(clock.counter)).toString(16).padStart(12, "0").slice(-12)
  const random = Array.from(crypto.getRandomValues(new Uint8Array(14)), (byte) => BASE62[byte % 62]).join("")
  return `${prefix}${time}${random}`
}
