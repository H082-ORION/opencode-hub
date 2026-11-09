import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { ChatMachines } from "../src/hub/chat-machines.js"
import { Store } from "../src/hub/store.js"

// The machine behind these calls stands in for a user's instance, at the boundary where the hub reaches it through the
// tunnel: what is under test is the hub's side of the conversation.

const USER = "user-1"
const SESSION = "ses_chat"
const dir = mkdtempSync(path.join(os.tmpdir(), "opencode-chat-machines-"))
const store = Store.open(dir)

type Call = { method: string; path: string; body?: unknown }

const machine = {
  calls: [] as Call[],
  messages: [] as unknown[],
  permissions: [] as { id: string }[],
  promptStatus: 200,
  answer(call: Call): Response {
    if (call.method === "POST" && call.path === "/api/session") return Response.json({ data: { id: "ses_remote" } })
    if (call.method === "POST" && call.path.endsWith("/prompt")) {
      if (machine.promptStatus !== 200) return new Response("gone", { status: machine.promptStatus })
      return Response.json({ data: { time: { created: 100 } } })
    }
    if (call.path.includes("/message?")) return Response.json({ data: machine.messages })
    if (call.method === "GET" && call.path.endsWith("/permission")) return Response.json({ data: machine.permissions })
    if (call.path === "/api/project")
      return Response.json([
        { id: "global", canonical: "/" },
        { id: "p1", canonical: "/home/me/app" },
        { id: "p2", canonical: "/home/me/site", name: "Site" },
      ])
    if (call.path === "/api/location") return Response.json({ directory: "/home/me" })
    if (call.path.startsWith("/api/fs/list"))
      return Response.json({
        data: [
          { path: "src", type: "directory" },
          { path: ".git", type: "directory" },
          { path: "README.md", type: "file" },
          { path: "docs", type: "directory" },
        ],
      })
    return Response.json({})
  },
}

const chat = ChatMachines.create({
  store,
  request: async (request) => {
    const call = { method: request.method, path: request.path, body: request.body }
    machine.calls.push(call)
    return machine.answer(call)
  },
  online: () => true,
  model: async () => ({ id: "m", providerID: "p" }),
})

const current = { session: "s", user: { id: USER } } as unknown as Parameters<typeof chat.handle>[2]
const api = (route: string, method = "GET", body?: unknown) =>
  chat.handle(
    new Request(`http://hub/${route}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
    route.split("?")[0]!,
    current,
  )
const finished = (text: string, outcome = "succeeded") => [
  { type: "idle", time: { created: 200 }, outcome },
  { type: "assistant", time: { created: 150 }, content: [{ type: "text", text }] },
]
const task = (signal = new AbortController().signal) => ({ user: USER, session: SESSION, prompt: "Do it", signal })

beforeEach(() => {
  machine.calls = []
  machine.messages = finished("All done")
  machine.permissions = []
  machine.promptStatus = 200
  store.deleteChatTarget(USER, SESSION)
})

afterAll(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("what a machine offers", () => {
  test("its projects, without the global one, named after their folder", async () => {
    const response = await api("chat-machines/m1/projects")
    expect(await response!.json()).toEqual([
      { id: "p1", name: "app", directory: "/home/me/app" },
      { id: "p2", name: "Site", directory: "/home/me/site" },
    ])
  })

  test("its visible folders, sorted, from where the agent runs", async () => {
    const response = await api("chat-machines/m1/directories")
    expect(await response!.json()).toEqual({ directory: "/home/me", parent: "/home", directories: ["docs", "src"] })
  })

  test("a new folder is created under its parent", async () => {
    const response = await api("chat-machines/m1/directories", "POST", { parent: "/home/me/", name: "new-app" })
    expect(await response!.json()).toEqual({ directory: "/home/me/new-app" })
    expect(machine.calls.at(-1)).toEqual({ method: "POST", path: "/__hub/mkdir", body: { path: "/home/me/new-app" } })
  })

  test.each(["..", ".", "a/b", "a\\b", ""])("a folder cannot be named %p", async (name) => {
    const response = await api("chat-machines/m1/directories", "POST", { parent: "/home/me", name })
    expect(response!.status).toBe(400)
    expect(machine.calls).toEqual([])
  })
})

describe("attaching a machine", () => {
  test("is told to the model once", async () => {
    await api(`chat-targets/${SESSION}`, "PUT", { machine: "m1", directory: "/home/me/app" })
    expect(chat.note(USER, SESSION)).toContain("/home/me/app")
    expect(chat.note(USER, SESSION)).toBeUndefined()
  })

  test("is told again when the target changes, and starts a new remote session", async () => {
    await api(`chat-targets/${SESSION}`, "PUT", { machine: "m1", directory: "/a" })
    chat.note(USER, SESSION)
    store.setChatRemoteSession(USER, SESSION, "old")
    await api(`chat-targets/${SESSION}`, "PUT", { machine: "m1", directory: "/b" })
    expect(chat.note(USER, SESSION)).toContain("/b")
    expect(store.chatTarget(USER, SESSION)?.remote_session).toBeNull()
  })

  test("needs an absolute folder", async () => {
    expect((await api(`chat-targets/${SESSION}`, "PUT", { machine: "m1", directory: "app" }))!.status).toBe(400)
  })
})

describe("a task", () => {
  const attach = () => store.setChatTarget(USER, SESSION, "m1", "/home/me/app")

  test("needs an attached machine", async () => {
    await expect(chat.run(task())).rejects.toThrow("No machine is attached")
  })

  test("runs in a session in the target folder, with the chat's model, and returns the final message", async () => {
    attach()
    expect(await chat.run(task())).toBe("All done")
    expect(machine.calls[0]).toEqual({
      method: "POST",
      path: "/api/session",
      body: {
        title: "Hub task",
        location: { directory: "/home/me/app" },
        model: { id: "m", providerID: "p" },
        permissions: [{ action: "question", resource: "*", effect: "deny" }],
      },
    })
    expect(machine.calls[1]).toEqual({
      method: "POST",
      path: "/api/session/ses_remote/prompt",
      body: { text: "Do it" },
    })
  })

  test("continues in the same session", async () => {
    attach()
    await chat.run(task())
    machine.calls = []
    await chat.run(task())
    expect(machine.calls.filter((call) => call.path === "/api/session")).toEqual([])
  })

  test("refuses permission prompts nobody could answer", async () => {
    attach()
    machine.permissions = [{ id: "per_1" }]
    await chat.run(task())
    expect(machine.calls).toContainEqual({
      method: "POST",
      path: "/api/session/ses_remote/permission/per_1/reply",
      body: expect.objectContaining({ decision: "reject" }),
    })
  })

  test("reports an agent that stopped early", async () => {
    attach()
    machine.messages = finished("Partial", "failed")
    expect(await chat.run(task())).toContain("stopped before finishing")
  })

  test("does not mistake an earlier run's end for this one's", async () => {
    attach()
    machine.messages = [{ type: "idle", time: { created: 50 }, outcome: "succeeded" }]
    const controller = new AbortController()
    const running = chat.run(task(controller.signal))
    setTimeout(() => controller.abort(), 2500)
    await expect(running).rejects.toThrow("interrupted")
    expect(machine.calls).toContainEqual({ method: "POST", path: "/api/session/ses_remote/interrupt", body: {} })
  })
})
