import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ChatMachines } from "../src/hub/chat-machines.js"
import { ChatTasks } from "../src/hub/chat-tasks.js"
import { ChatWatch } from "../src/hub/chat-watch.js"
import { Store } from "../src/hub/store.js"

// Tasks the hub's chat hands to machines. The machine stands in for a user's instance at the boundary where the hub
// reaches it through the tunnel, with an event stream the test writes to: what is under test is the hub's side.

const USER = "user-1"
const SESSION = "ses_chat"
const dir = mkdtempSync(path.join(os.tmpdir(), "opencode-chat-tasks-"))
const TOKENS = { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 0 } }

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
  const tasks = ChatTasks.create({
    store,
    request,
    watch,
    online: () => machine.online,
    machines: () => [{ id: "m1", name: "Laptop", online: machine.online }],
    model: async () => ({ id: "m", providerID: "p" }),
    files: async () => [{ uri: "data:image/png;base64,AAAA", name: "shot.png" }],
    record: async (user, session, message) => {
      if (record.fail) throw new Error("engine down")
      recorded.push({ user, session, ...message })
      return new Response(null, { status: 200 })
    },
  })
  return {
    tasks,
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
const api = (route: string, init: { method?: string; body?: unknown; user?: string; signal?: AbortSignal } = {}) =>
  state.hub.tasks.handle(
    new Request(`http://hub/${route}`, {
      method: init.method ?? "GET",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    }),
    route.split("?")[0]!,
    current(init.user),
  )
const start = (prompt = "Fix the tests") => state.hub.tasks.start({ user: USER, session: SESSION, prompt })
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
    await state.hub.tasks.start({
      user: USER,
      session: SESSION,
      prompt: "Plan it",
      machine: "laptop",
      directory: "/srv/site",
      agent: "plan",
    })
    expect(machine.calls[0]!.body).toMatchObject({ location: { directory: "/srv/site" }, agent: "plan" })
    await expect(state.hub.tasks.start({ user: USER, session: SESSION, prompt: "x", machine: "nope" })).rejects.toThrow(
      "no machine named nope",
    )
    await expect(
      state.hub.tasks.start({ user: USER, session: SESSION, prompt: "x", directory: "relative" }),
    ).rejects.toThrow("absolute folder")
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
