import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Account } from "../src/account.js"
import { Agent, Hub } from "../src/index.js"
import { browser } from "./fixture/browser.js"

// A task through the whole hub: the chat's tools, the tunnel to a machine, and the browser routes. The machine's
// opencode server is a stand-in with an event stream the test writes to.

type Page = ReturnType<typeof browser>
type View = { id: string; status: string; remoteSession: string }

const encoder = new TextEncoder()
const machine = {
  streams: new Set<ReadableStreamDefaultController<Uint8Array>>(),
  opened: 0,
  cancelled: 0,
  emit(type: string, data: Record<string, unknown>) {
    machine.streams.forEach((controller) =>
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, data })}\n\n`)),
    )
  },
}
const local = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/api/event") {
      machine.opened++
      const state = {} as { controller?: ReadableStreamDefaultController<Uint8Array> }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            state.controller = controller
            machine.streams.add(controller)
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`))
          },
          cancel() {
            machine.cancelled++
            if (state.controller) machine.streams.delete(state.controller)
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    if (request.method === "POST" && url.pathname === "/api/session")
      return Response.json({ data: { id: "ses_remote" } })
    if (request.method === "POST" && url.pathname.endsWith("/prompt"))
      return Response.json({ data: { id: "msg_1", time: { created: 1 } } })
    if (url.pathname === "/api/session/active") return Response.json({ data: { ses_remote: {} } })
    if (url.pathname.endsWith("/permission") || url.pathname.endsWith("/form")) return Response.json({ data: [] })
    if (url.pathname.endsWith("/message"))
      return Response.json({
        data: [{ type: "assistant", time: { created: 2 }, content: [{ type: "text", text: "Done" }] }],
      })
    if (url.pathname === "/api/session/ses_remote")
      return Response.json({
        data: {
          id: "ses_remote",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: {},
        },
      })
    return Response.json({})
  },
})

const data = mkdtempSync(path.join(os.tmpdir(), "opencode-chat-tasks-hub-"))
const offline = Object.assign(async () => Response.error(), { preconnect: () => {} }) as typeof fetch
const addresses = { next: 1 }
const state = {} as {
  hub: Awaited<ReturnType<typeof Hub.start>>
  alice: Page
  bob: Page
  agent: ReturnType<typeof Agent.connect>
}

beforeAll(async () => {
  state.hub = await Hub.start({
    hostname: "127.0.0.1",
    port: 0,
    data,
    catalog: { fetch: offline },
    chat: { command: [process.execPath, path.join(import.meta.dir, "fixture", "chat-server.ts")], cwd: os.tmpdir() },
  })
  state.alice = await signUp(state.hub.invite("admin").url, "alice")
  state.bob = await signUp((await state.alice.post<{ url: string }>("invitations", { role: "user" })).url, "bob")
  const code = (await state.alice.post<{ code: string }>("machines/code", {})).code
  const enrollment = await Agent.enroll({ url: state.hub.url, code, name: "Laptop" })
  const ready = Promise.withResolvers<void>()
  state.agent = Agent.connect({
    enrollment,
    local: async () => ({ url: `http://127.0.0.1:${local.port}` }),
    onReady: () => ready.resolve(),
  })
  await ready.promise
})

afterAll(async () => {
  await state.agent?.close()
  await state.hub?.stop()
  local.stop(true)
  rmSync(data, { recursive: true, force: true })
})

describe("a task through the hub", () => {
  test("the chat's tool starts it in the background and answers with its handle", async () => {
    const result = await call("machine_task", { prompt: "Fix it", machine: "laptop", directory: "/home/alice/app" })
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      remoteSession: "ses_remote",
      machine: "Laptop",
      directory: "/home/alice/app",
      status: "running",
    })
    const tasks = await list(state.alice)
    expect(tasks).toHaveLength(1)
  })

  test("its stream to the machine outlives another session's sign-out", async () => {
    await until(() => machine.streams.size === 1)
    const opened = machine.opened
    // Signing out rechecks every proxied stream: the hub's own stream stands for Alice, who still has access.
    await state.bob.request("logout", { method: "POST", body: {} })
    await Bun.sleep(200)
    expect(machine.cancelled).toBe(0)
    expect(machine.opened).toBe(opened)
    const task = (await list(state.alice))[0]!
    machine.emit("session.execution.succeeded", { sessionID: "ses_remote" })
    await until(async () => (await list(state.alice))[0]?.status === "idle")
    expect(task.status).toBe("running")
  })

  test("another user cannot see, follow or stop it", async () => {
    state.bob = await signIn("bob")
    const task = (await list(state.alice))[0]!
    expect(await list(state.bob)).toEqual([])
    for (const route of ["", "/api/event", "/api/session/ses_remote/message"])
      expect((await state.bob.request(`chat-tasks/${task.id}${route}`)).status).toBe(404)
    expect((await state.bob.request(`chat-tasks/${task.id}/run`, { method: "DELETE" })).status).toBe(404)
  })

  test("its read routes refuse every write", async () => {
    const task = (await list(state.alice))[0]!
    const response = await state.alice.request(`chat-tasks/${task.id}/api/session/ses_remote/prompt`, {
      method: "POST",
      body: { text: "x" },
    })
    expect(response.status).toBe(405)
  })
})

async function list(page: Page) {
  // SAFETY: the shape of `GET chat-tasks`.
  return ((await (await page.request("chat-tasks")).json()) as { data: View[] }).data
}

async function call(name: string, args: unknown) {
  // The stand-in chat server echoes the instance token it was started with on every route.
  const token = ((await (await state.alice.request("chat/api/session/ses_chat")).json()) as { token: string }).token
  const response = await fetch(`http://127.0.0.1:${state.hub.port}/hub/chat-tools`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args, _meta: { "ai.opencode/sessionID": "ses_chat" } },
    }),
  })
  // SAFETY: an MCP tool result, as the hub's tools always answer.
  return ((await response.json()) as { result: { content: { text: string }[]; isError?: boolean } }).result
}

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(10)
  }
}

async function signUp(url: string, login: string) {
  const page = browser(state.hub.url, { "x-forwarded-for": `198.51.100.${addresses.next++}` })
  const invite = new URL(url).searchParams.get("invite") ?? ""
  await Account.register({ post: page.post, invite, login, password: `${login}-password` })
  return page
}

async function signIn(login: string) {
  const page = browser(state.hub.url, { "x-forwarded-for": `198.51.100.${addresses.next++}` })
  await Account.login({ post: page.post, login, password: `${login}-password` })
  return page
}
