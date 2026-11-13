import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ChatMachines } from "../src/hub/chat-machines.js"
import { ChatTasks } from "../src/hub/chat-tasks.js"
import { ChatTemplates } from "../src/hub/chat-templates.js"
import { ChatWatch } from "../src/hub/chat-watch.js"
import { Store } from "../src/hub/store.js"

// Tasks the hub's chat hands to machines. The machine stands in for a user's instance at the boundary where the hub
// reaches it through the tunnel, with an event stream the test writes to: what is under test is the hub's side.

const USER = "user-1"
const SESSION = "ses_chat"
const dir = mkdtempSync(path.join(os.tmpdir(), "opencode-chat-tasks-"))
const TOKENS = { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 0 } }
/** The models the user's providers give, as the chat engine lists them. */
const MODELS = [
  {
    id: "m",
    providerID: "p",
    name: "Model M",
    capabilities: { tools: true, input: ["text", "image"] },
    variants: [{ id: "high" }],
    cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }],
    limit: { context: 200_000, output: 32_000 },
  },
  { id: "small", providerID: "p", name: "Small", capabilities: { tools: true, input: ["text"] }, variants: [] },
]

type Call = { method: string; path: string; body?: unknown; headers?: [string, string][] }
type Recorded = { user: string; session: string } & ChatMachines.Recorded

const machine = {
  calls: [] as Call[],
  online: true,
  sessions: 0,
  active: new Set<string>(),
  outcome: undefined as string | undefined,
  missing: new Set<string>(),
  permissions: [] as { id: string; sessionID: string; action: string }[],
  messages: [] as unknown[],
  streams: new Set<ReadableStreamDefaultController<Uint8Array>>(),
  opened: 0,
  emit(type: string, data: Record<string, unknown>) {
    const frame = new TextEncoder().encode(`data: ${JSON.stringify({ id: "evt", type, data })}\n\n`)
    machine.streams.forEach((controller) => controller.enqueue(frame))
  },
  /** Cuts every open event stream, as a dropped tunnel does. */
  drop() {
    machine.streams.forEach((controller) => controller.error(new Error("machine disconnected")))
    machine.streams.clear()
  },
  answer(call: Call): Response {
    if (!machine.online) return Response.json({ error: "This machine is not connected to the hub." }, { status: 503 })
    if (call.path.startsWith("/api/event")) {
      machine.opened++
      const state = {} as { controller?: ReadableStreamDefaultController<Uint8Array> }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          state.controller = controller
          machine.streams.add(controller)
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`),
          )
        },
        cancel() {
          if (state.controller) machine.streams.delete(state.controller)
        },
      })
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }
    if (call.method === "POST" && call.path === "/api/session") {
      machine.sessions++
      return Response.json({ data: { id: `ses_remote${machine.sessions}` } })
    }
    const session = /^\/api\/session\/(ses_[a-z0-9]+)/.exec(call.path)?.[1]
    if (session && machine.missing.has(session)) return Response.json({ _tag: "SessionNotFoundError" }, { status: 404 })
    if (call.method === "POST" && call.path.endsWith("/prompt")) {
      machine.active.add(session!)
      return Response.json({ data: { id: "msg_1", time: { created: 100 } } })
    }
    if (call.path === "/api/session/active")
      return Response.json({ data: Object.fromEntries(Array.from(machine.active, (id) => [id, {}])) })
    if (call.path.endsWith("/permission"))
      return Response.json({ data: machine.permissions.filter((request) => call.path.includes(request.sessionID)) })
    if (call.path.endsWith("/form")) return Response.json({ data: [] })
    if (call.path.includes("/message")) return Response.json({ data: machine.messages })
    if (call.method === "GET" && session)
      return Response.json({
        data: { id: session, cost: 0.5, tokens: TOKENS, outcome: machine.outcome, time: { created: 1 } },
      })
    if (call.method === "POST") return new Response(null, { status: 204 })
    return Response.json({})
  },
}

const recorded: Recorded[] = []
const record = { fail: false }
const opened = { store: Store.open(dir) }

function create(store = opened.store) {
  const request = async (input: Call & { user: string; machine: string }) => {
    const call = {
      method: input.method,
      path: input.path,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.headers?.length ? { headers: input.headers } : {}),
    }
    if (!input.path.startsWith("/api/event")) machine.calls.push(call)
    return machine.answer(call)
  }
  const watch = ChatWatch.create({ request, retry: 10 })
  const templates = ChatTemplates.create({
    store,
    model: async (_, reference) => MODELS.some((entry) => `${entry.providerID}/${entry.id}` === reference),
  })
  const tasks = ChatTasks.create({
    store,
    request,
    watch,
    online: () => machine.online,
    machines: () => [{ id: "m1", name: "Laptop", online: machine.online }],
    model: async () => ({ id: "m", providerID: "p" }),
    models: async () => MODELS,
    templates,
    files: async () => [{ uri: "data:image/png;base64,AAAA", name: "shot.png" }],
    record: async (user, session, message) => {
      if (record.fail) throw new Error("engine down")
      recorded.push({ user, session, ...message })
      return new Response(null, { status: 200 })
    },
  })
  return {
    tasks,
    templates,
    close() {
      tasks.close()
      watch.stop()
    },
  }
}

const state = {} as { hub: ReturnType<typeof create> }

beforeEach(() => {
  machine.calls = []
  machine.online = true
  machine.sessions = 0
  machine.active.clear()
  machine.outcome = undefined
  machine.missing.clear()
  machine.permissions = []
  machine.messages = [{ type: "assistant", time: { created: 150 }, content: [{ type: "text", text: "All done" }] }]
  machine.opened = 0
  recorded.length = 0
  record.fail = false
  opened.store.setChatTarget(USER, SESSION, "m1", "/home/me/app")
  state.hub = create()
})

afterEach(() => {
  state.hub.close()
  machine.drop()
  opened.store.deleteChatTasks(USER, SESSION)
  opened.store.deleteChatTasks("user-2", SESSION)
})

afterAll(() => {
  opened.store.close()
  rmSync(dir, { recursive: true, force: true })
})

const current = (user = USER) =>
  ({ session: "s", user: { id: user } }) as unknown as Parameters<ChatTasks.Instance["handle"]>[2]
const api = (route: string, init: { method?: string; body?: unknown; user?: string; signal?: AbortSignal } = {}) => {
  const request = new Request(`http://hub/${route}`, {
    method: init.method ?? "GET",
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  })
  const handler = route.startsWith("chat-templates") ? state.hub.templates : state.hub.tasks
  return handler.handle(request, route.split("?")[0]!, current(init.user))
}
const start = (prompt = "Fix the tests", extra: Partial<Parameters<ChatTasks.Instance["start"]>[0]> = {}) =>
  state.hub.tasks.start({ user: USER, session: SESSION, prompt, by: "model", ...extra })
const task = (id: string) => opened.store.chatTask(USER, id)!

/** Polls until `check` holds, or fails after two seconds. */
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

/** Reads a browser's event stream: every frame's JSON, as they arrive. */
function frames(response: Response) {
  const reader = response.body!.getReader()
  const received: { type: string; data: Record<string, unknown> }[] = []
  const buffer = { text: "" }
  void (async () => {
    while (true) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }))
      if (chunk.done) return
      buffer.text += new TextDecoder().decode(chunk.value)
      const blocks = buffer.text.split("\n\n")
      buffer.text = blocks.pop() ?? ""
      blocks.filter((block) => block.startsWith("data: ")).forEach((block) => received.push(JSON.parse(block.slice(6))))
    }
  })()
  return { received, close: () => reader.cancel() }
}

describe("starting a task", () => {
  test("answers once the machine admitted the prompt, in a new session titled after it", async () => {
    const started = await start("Fix the tests\nThey fail on CI.")
    expect(started.status).toBe("running")
    expect(started.remote_session).toBe("ses_remote1")
    expect(machine.calls.slice(0, 2)).toEqual([
      {
        method: "POST",
        path: "/api/session",
        body: { title: "Fix the tests", location: { directory: "/home/me/app" }, model: { id: "m", providerID: "p" } },
      },
      { method: "POST", path: "/api/session/ses_remote1/prompt", body: { text: "Fix the tests\nThey fail on CI." } },
    ])
  })

  test("each task gets its own session, and they run side by side", async () => {
    const first = await start()
    const second = await start("Write the docs")
    expect([first.remote_session, second.remote_session]).toEqual(["ses_remote1", "ses_remote2"])
    expect(state.hub.tasks.list(USER, SESSION).map((entry) => entry.status)).toEqual(["running", "running"])
  })

  test("on another folder or machine, with the agent asked for", async () => {
    await start("Plan it", { machine: "laptop", directory: "/srv/site", agent: "plan" })
    expect(machine.calls[0]!.body).toMatchObject({ location: { directory: "/srv/site" }, agent: "plan" })
    await expect(start("x", { machine: "nope" })).rejects.toThrow("no machine named nope")
    await expect(start("x", { directory: "relative" })).rejects.toThrow("absolute folder")
  })

  test("a machine that refuses the session fails the task at once", async () => {
    machine.missing.add("ses_remote1")
    await expect(start()).rejects.toThrow("The machine answered 404")
    expect(state.hub.tasks.list(USER, SESSION)[0]).toMatchObject({ status: "failed" })
  })
})

describe("following a task", () => {
  test("its browsers hear its own sessions and their subagents, and nothing else", async () => {
    const started = await start()
    await until(() => machine.streams.size === 1)
    const stream = frames((await api(`chat-tasks/${started.id}/api/event`))!)
    await until(() => stream.received.length >= 2)
    expect(stream.received.map((event) => event.type)).toEqual(["server.connected", "hub.task.updated"])
    machine.emit("session.text.delta", { sessionID: "ses_remote1", delta: "Hello" })
    machine.emit("session.text.delta", { sessionID: "ses_other", delta: "Private" })
    machine.emit("session.created", { sessionID: "ses_child", parentID: "ses_remote1" })
    machine.emit("session.text.delta", { sessionID: "ses_child", delta: "From the subagent" })
    await until(() => stream.received.length >= 5)
    await Bun.sleep(20)
    expect(stream.received.slice(2).map((event) => event.data.delta ?? event.type)).toEqual([
      "Hello",
      "session.created",
      "From the subagent",
    ])
    await stream.close()
  })

  test("adds up the usage of its session and its subagents", async () => {
    const started = await start()
    await until(() => machine.streams.size === 1)
    machine.emit("session.created", { sessionID: "ses_child", parentID: "ses_remote1" })
    machine.emit("session.usage.updated", { sessionID: "ses_remote1", cost: 0.25, tokens: TOKENS })
    machine.emit("session.usage.updated", { sessionID: "ses_child", cost: 0.5, tokens: TOKENS })
    machine.emit("session.usage.updated", { sessionID: "ses_other", cost: 9, tokens: TOKENS })
    await until(() => task(started.id).cost === 0.75)
    expect(task(started.id).tokens_input).toBe(20)
  })

  test("waits while a permission is pending, and runs again once it is answered", async () => {
    const started = await start()
    await until(() => machine.streams.size === 1)
    machine.emit("permission.asked", { id: "per_1", sessionID: "ses_remote1", action: "shell", resources: ["*"] })
    await until(() => task(started.id).status === "waiting")
    const reply = await api(`chat-tasks/${started.id}/permission/per_1`, { method: "POST", body: { decision: "once" } })
    expect(reply!.status).toBe(204)
    expect(machine.calls).toContainEqual({
      method: "POST",
      path: "/api/session/ses_remote1/permission/per_1/reply",
      body: { decision: "once" },
    })
    machine.emit("permission.replied", { sessionID: "ses_remote1", requestID: "per_1", reply: "once" })
    await until(() => task(started.id).status === "running")
  })

  test("steers it and queues a follow-up in its own session", async () => {
    const started = await start()
    expect(
      (await api(`chat-tasks/${started.id}/prompt`, { method: "POST", body: { text: "Faster", delivery: "steer" } }))!
        .status,
    ).toBe(204)
    expect(
      (await api(`chat-tasks/${started.id}/prompt`, {
        method: "POST",
        body: { text: "Then docs", delivery: "queue" },
      }))!.status,
    ).toBe(204)
    expect(machine.calls.filter((call) => call.path === "/api/session/ses_remote1/prompt").slice(1)).toEqual([
      { method: "POST", path: "/api/session/ses_remote1/prompt", body: { text: "Faster", delivery: "steer" } },
      { method: "POST", path: "/api/session/ses_remote1/prompt", body: { text: "Then docs", delivery: "queue" } },
    ])
  })
})

describe("the end of a task", () => {
  test("is told to the chat's model once, queued, with an id it keeps", async () => {
    const started = await start()
    await until(() => machine.streams.size === 1)
    machine.active.clear()
    machine.emit("session.execution.succeeded", { sessionID: "ses_remote1" })
    machine.emit("session.execution.succeeded", { sessionID: "ses_remote1" })
    await until(() => task(started.id).notified_at !== null)
    await Bun.sleep(20)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      user: USER,
      session: SESSION,
      id: task(started.id).notify_id!,
      delivery: "queue",
      resume: true,
      metadata: { source: "hub-machine", kind: "task", task: started.id, machine: "m1", state: "completed" },
    })
    expect(recorded[0]!.id).toStartWith("msg_")
    expect(recorded[0]!.text).toContain("All done")
    expect(task(started.id)).toMatchObject({ status: "idle", outcome: "succeeded" })
  })

  test("goes to a tool call that waited for it instead", async () => {
    const started = await start()
    await until(() => machine.streams.size === 1)
    const waiting = state.hub.tasks.status(started, 5)
    machine.active.clear()
    machine.emit("session.execution.succeeded", { sessionID: "ses_remote1" })
    expect(await waiting).toMatchObject({ status: "idle", result: "All done" })
    await Bun.sleep(20)
    expect(recorded).toEqual([])
  })

  test("a stop the model asked for interrupts the session and is not reported back", async () => {
    const started = await start()
    await until(() => machine.streams.size === 1)
    expect(await state.hub.tasks.stop(started, "model")).toBeUndefined()
    expect(machine.calls).toContainEqual({ method: "POST", path: "/api/session/ses_remote1/interrupt", body: {} })
    machine.active.clear()
    machine.emit("session.execution.interrupted", { sessionID: "ses_remote1", reason: "user" })
    await until(() => task(started.id).status === "interrupted")
    await Bun.sleep(20)
    expect(recorded).toEqual([])
  })

  test("a notification the engine missed is sent again, with the same id, after a restart", async () => {
    const started = await start()
    await until(() => machine.streams.size === 1)
    record.fail = true
    machine.active.clear()
    machine.emit("session.execution.failed", { sessionID: "ses_remote1", error: { message: "Out of credit" } })
    await until(() => task(started.id).status === "failed")
    const id = task(started.id).notify_id
    expect(task(started.id).notified_at).toBeNull()
    state.hub.close()
    record.fail = false
    state.hub = create(opened.store)
    await until(() => recorded.length === 1)
    expect(recorded[0]).toMatchObject({ id: id!, metadata: { state: "error" } })
    expect(task(started.id).error).toBe("Out of credit")
  })
})

describe("robustness", () => {
  test("a restarted hub follows a running task again, and finishes it if it ended meanwhile", async () => {
    const started = await start()
    state.hub.close()
    machine.drop()
    machine.active.clear()
    machine.outcome = "succeeded"
    state.hub = create(Store.open(dir))
    await until(() => task(started.id).status === "idle")
    await until(() => recorded.length === 1)
    expect(recorded[0]!.metadata).toMatchObject({ task: started.id, state: "completed" })
  })

  test("goes offline with its machine, and runs again once it is back", async () => {
    const started = await start()
    await until(() => machine.streams.size === 1)
    machine.online = false
    machine.drop()
    await until(() => task(started.id).status === "offline")
    machine.online = true
    await until(() => task(started.id).status === "running")
    expect(recorded).toEqual([])
  })

  test("is lost when its session disappears from the machine", async () => {
    const started = await start()
    await until(() => machine.streams.size === 1)
    machine.missing.add("ses_remote1")
    machine.drop()
    await until(() => task(started.id).status === "lost")
    await until(() => recorded.length === 1)
    expect(recorded[0]!.metadata).toMatchObject({ state: "error" })
  })
})

describe("what browsers reach", () => {
  test("another user's task answers like an unknown one", async () => {
    const started = await start()
    for (const route of ["", "/api/event", "/api/session/ses_remote1/message"])
      expect((await api(`chat-tasks/${started.id}${route}`, { user: "user-2" }))!.status).toBe(404)
    expect((await api(`chat-tasks/${started.id}/run`, { method: "DELETE", user: "user-2" }))!.status).toBe(404)
    expect(machine.calls.filter((call) => call.path.endsWith("/interrupt"))).toEqual([])
  })

  test("reads only the task's own sessions, and never writes through the read routes", async () => {
    const started = await start()
    machine.calls = []
    expect((await api(`chat-tasks/${started.id}/api/session/ses_remote1/message?limit=5&location=/etc`))!.status).toBe(
      200,
    )
    expect(machine.calls).toEqual([{ method: "GET", path: "/api/session/ses_remote1/message?limit=5" }])
    expect((await api(`chat-tasks/${started.id}/api/session/ses_other/message`))!.status).toBe(404)
    for (const route of ["api/session/ses_remote1/prompt", "api/session/ses_remote1/shell", "api/pty"])
      expect((await api(`chat-tasks/${started.id}/${route}`, { method: "POST", body: { text: "x" } }))!.status).toBe(
        405,
      )
    for (const route of ["api/fs/read/etc/passwd", "api/config", "api/provider", "api/pty"])
      expect((await api(`chat-tasks/${started.id}/${route}`))!.status).toBe(404)
    expect(machine.calls.length).toBe(1)
  })

  test("sees only the task's sessions among those running", async () => {
    const started = await start()
    machine.active.add("ses_other")
    const response = await api(`chat-tasks/${started.id}/api/session/active`)
    expect(await response!.json()).toEqual({ ses_remote1: {} })
  })
})

describe("choosing a sub-agent's model", () => {
  test("the model and variant asked for go to the session, and the task shows them", async () => {
    const started = await start("Fix", { model: "p/m", variant: "high" })
    expect(machine.calls[0]!.body).toMatchObject({ model: { id: "m", providerID: "p", variant: "high" } })
    expect(started.model).toBe("p/m#high")
    expect(state.hub.tasks.view(started).model).toBe("p/m#high")
  })

  test("a model the user's providers do not give is refused, naming the tool that lists them", async () => {
    await expect(start("Fix", { model: "p/huge" })).rejects.toThrow("models_list")
    await expect(start("Fix", { model: "p/m", variant: "max" })).rejects.toThrow("no variant max")
    await expect(start("Fix", { model: "nonsense" })).rejects.toThrow("provider/model")
    expect(machine.calls).toEqual([])
  })

  test("a follow-up can switch the session's model first", async () => {
    const started = await start()
    const model = await state.hub.tasks.resolveModel(USER, "p/small", undefined)
    expect(await state.hub.tasks.send(started, "Go on", "queue", "model", model)).toBeUndefined()
    expect(machine.calls.slice(-2)).toEqual([
      { method: "POST", path: "/api/session/ses_remote1/model", body: { model: { id: "small", providerID: "p" } } },
      { method: "POST", path: "/api/session/ses_remote1/prompt", body: { text: "Go on", delivery: "queue" } },
    ])
    expect(task(started.id).model).toBe("p/small")
  })

  test("lists the user's models with what matters to pick one", async () => {
    expect(await state.hub.tasks.models(USER)).toEqual([
      {
        model: "p/m",
        name: "Model M",
        provider: "p",
        vision: true,
        tools: true,
        variants: ["high"],
        context: 200_000,
        maxOutput: 32_000,
        pricePerMillion: { input: 3, output: 15, currency: "USD" },
      },
      { model: "p/small", name: "Small", provider: "p", vision: false, tools: true, variants: [] },
    ])
  })
})

describe("agent templates", () => {
  test("a built-in template's instructions reach the sub-agent before the request, with its agent", async () => {
    const started = await start("Plan the migration", { template: "plan" })
    expect(started.template).toBe("plan")
    expect(machine.calls.map((call) => call.path)).toEqual([
      "/api/session",
      "/api/session/ses_remote1/synthetic",
      "/api/session/ses_remote1/prompt",
    ])
    expect(machine.calls[0]!.body).toMatchObject({ agent: "plan" })
    expect(machine.calls[1]!.body).toMatchObject({
      description: "Template plan",
      resume: false,
      text: expect.stringContaining('<agent_template name="plan">'),
    })
    expect(machine.calls[2]!.body).toEqual({ text: "Plan the migration" })
  })

  test("an unknown template is refused before anything reaches the machine", async () => {
    await expect(start("x", { template: "nope" })).rejects.toThrow("templates_list")
    expect(machine.calls).toEqual([])
  })

  test("the user's own template replaces the built-in one of the same name and brings its model", async () => {
    const created = await api("chat-templates", {
      method: "POST",
      body: { name: "plan", description: "My planner", system: "Plan carefully.", model: "p/small" },
    })
    expect(created!.status).toBe(200)
    const names = state.hub.templates.list(USER).map((template) => [template.name, template.builtin])
    expect(names).toEqual([
      ["plan", false],
      ["build", true],
      ["review", true],
    ])
    const started = await start("Plan it", { template: "plan" })
    expect(machine.calls[0]!.body).toMatchObject({ model: { id: "small", providerID: "p" } })
    expect(machine.calls[0]!.body).not.toHaveProperty("agent")
    expect(machine.calls[1]!.body).toMatchObject({ text: expect.stringContaining("Plan carefully.") })
    // The model asked for still wins over the template's.
    const other = await start("Plan it again", { template: "plan", model: "p/m" })
    expect(other.model).toBe("p/m")
    expect(started.model).toBe("p/small")
    const id = ((await (await api("chat-templates"))!.json()) as { data: { id: string }[] }).data[0]!.id
    expect((await api(`chat-templates/${id}`, { method: "DELETE" }))!.status).toBe(204)
    expect(state.hub.templates.find(USER, "plan")?.builtin).toBe(true)
  })

  test("a template needs a valid name, a description, a prompt and a known model", async () => {
    const save = (body: unknown) => api("chat-templates", { method: "POST", body }).then((response) => response!.status)
    expect(await save({ name: "Bad Name", description: "d", system: "s" })).toBe(400)
    expect(await save({ name: "ok", description: "", system: "s" })).toBe(400)
    expect(await save({ name: "ok", description: "d", system: "s", model: "p/huge" })).toBe(400)
    expect(await save({ name: "ok", description: "d", system: "s" })).toBe(200)
    expect(await save({ name: "ok", description: "d", system: "s" })).toBe(409)
    // Another user sees nothing of it.
    expect(
      ((await (await api("chat-templates", { user: "user-2" }))!.json()) as { data: unknown[] }).data,
    ).toHaveLength(3)
    const own = ((await (await api("chat-templates"))!.json()) as { data: { id: string }[] }).data
    for (const template of own.filter((entry) => !entry.id.startsWith("builtin:")))
      await api(`chat-templates/${template.id}`, { method: "DELETE" })
  })
})

describe("waiting for several tasks", () => {
  test("any answers at the first end, with that task's result, and all waits for every one", async () => {
    const first = await start("One")
    const second = await start("Two")
    await until(() => machine.streams.size === 1)
    const any = state.hub.tasks.wait([first, second], "any", 5)
    machine.active.delete("ses_remote2")
    machine.emit("session.execution.succeeded", { sessionID: "ses_remote2" })
    const result = await any
    expect(result.stillRunning).toBe(1)
    expect(result.tasks).toEqual([
      expect.objectContaining({ task: first.id, status: "running" }),
      expect.objectContaining({ task: second.id, status: "idle", result: "All done" }),
    ])
    // The end that answered a waiter is not reported to the model again.
    await Bun.sleep(20)
    expect(recorded).toEqual([])
    const all = await state.hub.tasks.wait([first, second], "all", 0.05)
    expect(all.stillRunning).toBe(1)
    expect(all.tasks[0]).not.toHaveProperty("result")
    expect(all.tasks[1]).toMatchObject({ status: "idle" })
  })
})

describe("who hears of the end", () => {
  test("a follow-up the user wrote from the panel is recorded without waking the model", async () => {
    const started = await start()
    await until(() => machine.streams.size === 1)
    machine.active.clear()
    machine.emit("session.execution.succeeded", { sessionID: "ses_remote1" })
    await until(() => recorded.length === 1)
    expect(recorded[0]!.resume).toBe(true)
    expect((await api(`chat-tasks/${started.id}/prompt`, { method: "POST", body: { text: "More" } }))!.status).toBe(204)
    machine.emit("session.execution.started", { sessionID: "ses_remote1" })
    await until(() => task(started.id).status === "running")
    machine.emit("session.execution.succeeded", { sessionID: "ses_remote1" })
    await until(() => recorded.length === 2)
    expect(recorded[1]!.resume).toBe(false)
    // The model's own message takes the task back.
    expect(await state.hub.tasks.send(task(started.id), "Then this", "queue", "model")).toBeUndefined()
    machine.emit("session.execution.started", { sessionID: "ses_remote1" })
    await until(() => task(started.id).status === "running")
    machine.emit("session.execution.succeeded", { sessionID: "ses_remote1" })
    await until(() => recorded.length === 3)
    expect(recorded[2]!.resume).toBe(true)
  })

  test("the images a task produced are counted, told to the model and shown on the task", async () => {
    const started = await start()
    await until(() => machine.streams.size === 1)
    machine.messages = [
      {
        type: "assistant",
        time: { created: 150 },
        content: [
          { type: "text", text: "Here is the page" },
          {
            type: "tool",
            name: "screenshot",
            state: {
              status: "completed",
              content: [
                { type: "file", uri: "data:image/png;base64,AAAA", name: "home.png" },
                { type: "file", uri: "media:" + "a".repeat(64), mime: "image/jpeg" },
              ],
            },
          },
        ],
      },
    ]
    machine.active.clear()
    machine.emit("session.execution.succeeded", { sessionID: "ses_remote1" })
    await until(() => recorded.length === 1)
    expect(task(started.id).images).toBe(2)
    expect(state.hub.tasks.view(task(started.id)).images).toBe(2)
    expect(recorded[0]!.metadata).toMatchObject({ kind: "task", images: 2, model: "p/m" })
    expect(recorded[0]!.text).toContain("2 image(s)")
    const shot = await api(`chat-tasks/${started.id}/image/0`)
    expect(shot!.headers.get("content-type")).toBe("image/png")
  })
})

describe("commands as tasks", () => {
  test("a shell command runs in its own session and its output joins the conversation as a shell run", async () => {
    const response = await api("chat-tasks", { method: "POST", body: { session: SESSION, kind: "shell", shell: "ls" } })
    expect(response!.status).toBe(200)
    const started = (await response!.json()) as { id: string; title: string; kind: string; status: string }
    expect(started).toMatchObject({ kind: "shell", title: "$ ls", status: "running" })
    expect(machine.calls).toContainEqual({
      method: "POST",
      path: "/api/session/ses_remote1/shell",
      body: { command: "ls" },
    })
    await until(() => machine.streams.size === 1)
    machine.messages = [
      {
        id: "msg_shell",
        type: "shell",
        command: "ls",
        status: "exited",
        exit: 0,
        output: { output: "README.md\n", truncated: false },
        time: { created: 400 },
      },
    ]
    machine.emit("session.shell.ended", { sessionID: "ses_remote1", shell: { id: "sh" }, output: {} })
    await until(() => task(started.id).status === "idle")
    await until(() => recorded.length === 1)
    expect(recorded[0]!.resume).toBe(false)
    expect(recorded[0]!.text).toContain("Exit code 0.")
    expect(recorded[0]!.metadata).toEqual({
      source: "hub-machine",
      task: started.id,
      machine: "m1",
      state: "completed",
      kind: "shell",
      command: "ls",
      exit: 0,
      output: "README.md\n",
      truncated: false,
    })
    // A shell command takes no follow-up.
    expect((await api(`chat-tasks/${started.id}/prompt`, { method: "POST", body: { text: "x" } }))!.status).toBe(409)
  })

  test("a slash command runs as a task too, ended by the agent run it started", async () => {
    const response = await api("chat-tasks", {
      method: "POST",
      body: { session: SESSION, kind: "command", command: { name: "review", arguments: "src" } },
    })
    expect(response!.status).toBe(200)
    const started = (await response!.json()) as { id: string; title: string }
    expect(started.title).toBe("/review src")
    expect(machine.calls).toContainEqual({
      method: "POST",
      path: "/api/session/ses_remote1/command",
      body: { name: "review", text: "src" },
    })
    await until(() => machine.streams.size === 1)
    machine.emit("session.execution.started", { sessionID: "ses_remote1" })
    machine.emit("session.execution.succeeded", { sessionID: "ses_remote1" })
    await until(() => recorded.length === 1)
    expect(recorded[0]!.metadata).toMatchObject({ kind: "command", command: "/review src", output: "All done" })
    expect(
      await api("chat-tasks", {
        method: "POST",
        body: { session: SESSION, kind: "command", command: { name: "two words" } },
      }).then((r) => r!.status),
    ).toBe(400)
  })
})

describe("a browser that is behind", () => {
  test("gets consecutive deltas of one part merged into one frame", async () => {
    const started = await start()
    await until(() => machine.streams.size === 1)
    const response = await api(`chat-tasks/${started.id}/api/event`)
    // Nothing reads the stream: the first large delta exhausts its buffer, so the ones after it are held and merged.
    machine.emit("session.text.delta", {
      sessionID: "ses_remote1",
      messageID: "m1",
      partID: "p1",
      delta: "x".repeat(70_000),
    })
    await Bun.sleep(5)
    for (const delta of ["a", "b", "c"])
      machine.emit("session.text.delta", { sessionID: "ses_remote1", messageID: "m1", partID: "p1", delta })
    machine.emit("session.text.delta", { sessionID: "ses_remote1", messageID: "m1", partID: "p2", delta: "d" })
    await Bun.sleep(80)
    const read = frames(response!)
    await until(() => read.received.filter((frame) => frame.type === "session.text.delta").length === 3)
    const deltas = read.received.filter((frame) => frame.type === "session.text.delta").map((frame) => frame.data.delta)
    expect(deltas).toEqual(["x".repeat(70_000), "abc", "d"])
    read.close()
  })
})
