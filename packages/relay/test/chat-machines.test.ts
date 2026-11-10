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
  /** What the machine answers to a slash command or a shell command. */
  runStatus: 204,
  runBody: "",
  online: true,
  answer(call: Call): Response {
    if (call.method === "POST" && call.path === "/api/session") return Response.json({ data: { id: "ses_remote" } })
    if (call.method === "POST" && (call.path.endsWith("/command") || call.path.endsWith("/shell"))) {
      if (machine.runStatus !== 204) return new Response(machine.runBody, { status: machine.runStatus })
      machine.messages = call.path.endsWith("/command")
        ? [
            { type: "idle", time: { created: 400 }, outcome: "succeeded" },
            { type: "assistant", time: { created: 350 }, content: [{ type: "text", text: "Reviewed" }] },
            ...machine.messages,
          ]
        : [
            {
              id: "msg_shell",
              type: "shell",
              command: "ls",
              status: "exited",
              exit: 0,
              output: { output: "README.md\n", truncated: false },
              time: { created: 400 },
            },
            ...machine.messages,
          ]
      return new Response(null, { status: 204 })
    }
    if (call.path === "/api/session/active") return Response.json({ data: {} })
    if (call.path.startsWith("/api/command?"))
      return Response.json({
        location: { directory: "/home/me/app" },
        data: [{ name: "review", description: "Review the changes", template: "secret" }, { name: "init" }],
      })
    if (call.path.startsWith("/api/fs/find?"))
      return Response.json({
        location: { directory: "/home/me/app" },
        data: [
          { path: "src/app.ts", type: "file" },
          { path: "src", type: "directory" },
        ],
      })
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
  online: () => machine.online,
  model: async () => ({ id: "m", providerID: "p", variant: "high" }),
  files: async () => [{ uri: "data:image/png;base64,AAAA", name: "shot.png" }],
  record: async (user, session, message) => recorded.push({ user, session, ...message }),
  log: (message) => logged.push(message),
  pollEvery: 5,
})
const recorded: ({ user: string; session: string } & ChatMachines.Recorded)[] = []
const logged: string[] = []

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
  machine.runStatus = 204
  machine.runBody = ""
  machine.online = true
  recorded.length = 0
  logged.length = 0
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
        model: { id: "m", providerID: "p", variant: "high" },
        permissions: [{ action: "question", resource: "*", effect: "deny" }],
      },
    })
    expect(machine.calls[1]).toEqual({
      method: "POST",
      path: "/api/session/ses_remote/prompt",
      body: { text: "Do it" },
    })
  })

  test("continues in the same session, switched to the chat's current model", async () => {
    attach()
    await chat.run(task())
    machine.calls = []
    await chat.run(task())
    expect(machine.calls.filter((call) => call.path === "/api/session")).toEqual([])
    expect(machine.calls.slice(0, 2)).toEqual([
      {
        method: "POST",
        path: "/api/session/ses_remote/model",
        body: { model: { id: "m", providerID: "p", variant: "high" } },
      },
      { method: "POST", path: "/api/session/ses_remote/prompt", body: { text: "Do it" } },
    ])
  })

  test("hands over the user's attached files only when asked to", async () => {
    attach()
    await chat.run({ ...task(), images: true })
    expect(machine.calls.find((call) => call.path.endsWith("/prompt"))?.body).toEqual({
      text: "Do it",
      files: [{ uri: "data:image/png;base64,AAAA", name: "shot.png" }],
    })
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

describe("what the attached project offers", () => {
  test("its commands, with nothing but their name and description", async () => {
    const response = await api("chat-machines/m1/commands?directory=%2Fhome%2Fme%2Fapp")
    expect(await response!.json()).toEqual({
      data: [{ name: "review", description: "Review the changes" }, { name: "init" }],
    })
    expect(machine.calls[0]!.path).toBe("/api/command?location%5Bdirectory%5D=%2Fhome%2Fme%2Fapp")
  })

  test("its files matching a query", async () => {
    const response = await api("chat-machines/m1/files?directory=%2Fhome%2Fme%2Fapp&query=app")
    expect(await response!.json()).toEqual({ data: ["src/app.ts"] })
    expect(machine.calls[0]!.path).toBe(
      "/api/fs/find?query=app&type=file&limit=50&location%5Bdirectory%5D=%2Fhome%2Fme%2Fapp",
    )
  })

  test.each(["commands", "files"])("%s need an absolute directory", async (kind) => {
    expect((await api(`chat-machines/m1/${kind}?directory=app`))!.status).toBe(400)
    expect(machine.calls).toEqual([])
  })
})

describe("commands run from the chat", () => {
  const attach = () => store.setChatTarget(USER, SESSION, "m1", "/home/me/app")
  const status = async () =>
    // SAFETY: the shape of `GET chat-targets/:session`.
    (await (await api(`chat-targets/${SESSION}`))!.json()) as { running: boolean; error?: string }
  const settled = async () => {
    const deadline = Date.now() + 3000
    while ((await status()).running && Date.now() < deadline) await Bun.sleep(5)
    return status()
  }

  test("a slash command runs in the target's session and its result joins the conversation", async () => {
    attach()
    const response = await api(`chat-targets/${SESSION}/command`, "POST", { name: "review", arguments: "src" })
    expect(response!.status).toBe(202)
    expect(await response!.json()).toEqual({ running: true })
    expect((await settled()).running).toBe(false)
    expect(machine.calls).toContainEqual({
      method: "POST",
      path: "/api/session/ses_remote/command",
      body: { name: "review", text: "src" },
    })
    expect(recorded).toEqual([
      {
        user: USER,
        session: SESSION,
        description: "/review src — m1",
        text: "/review src — m1\n\nReviewed",
        metadata: {
          source: "hub-machine",
          kind: "command",
          machine: "m1",
          command: "/review src",
          state: "completed",
          output: "Reviewed",
        },
      },
    ])
  })

  test("a shell command is logged, and its exit code and output join the conversation", async () => {
    attach()
    const response = await api(`chat-targets/${SESSION}/shell`, "POST", { command: "ls" })
    expect(response!.status).toBe(202)
    await settled()
    expect(machine.calls).toContainEqual({
      method: "POST",
      path: "/api/session/ses_remote/shell",
      body: { command: "ls" },
    })
    expect(logged).toEqual([expect.stringContaining("ls")])
    expect(recorded[0]!.text).toBe("$ ls — m1\n\nExit code 0.\n\n```\nREADME.md\n\n```")
    // The hub's timeline shows the run as a shell command from this.
    expect(recorded[0]!.metadata).toEqual({
      source: "hub-machine",
      kind: "shell",
      machine: "m1",
      command: "ls",
      state: "completed",
      output: "README.md\n",
      exit: 0,
      truncated: false,
    })
  })

  test("needs an attached machine that is online", async () => {
    expect((await api(`chat-targets/${SESSION}/shell`, "POST", { command: "ls" }))!.status).toBe(404)
    attach()
    machine.online = false
    expect((await api(`chat-targets/${SESSION}/shell`, "POST", { command: "ls" }))!.status).toBe(409)
    expect(machine.calls).toEqual([])
  })

  test("one at a time", async () => {
    attach()
    // The machine never reports this command's end, so it runs until it is stopped.
    const first = await api(`chat-targets/${SESSION}/shell`, "POST", { command: "sleep 10" })
    expect(first!.status).toBe(202)
    expect((await status()).running).toBe(true)
    expect((await api(`chat-targets/${SESSION}/command`, "POST", { name: "review" }))!.status).toBe(409)
    expect((await api(`chat-targets/${SESSION}/run`, "DELETE"))!.status).toBe(204)
    const after = await settled()
    // A run the user stopped is no failure.
    expect(after.running).toBe(false)
    expect(after.error).toBeUndefined()
    expect(machine.calls).toContainEqual({ method: "POST", path: "/api/session/ses_remote/interrupt", body: {} })
    expect(recorded[0]!.text).toContain("Stopped.")
    expect(recorded[0]!.metadata).toMatchObject({ kind: "shell", command: "sleep 10", state: "cancelled" })
  })

  test("an agent without the route is asked to be updated", async () => {
    attach()
    machine.runStatus = 404
    const response = await api(`chat-targets/${SESSION}/command`, "POST", { name: "review" })
    expect(response!.status).toBe(409)
    expect((await status()).running).toBe(false)
  })

  test("an unknown command is refused", async () => {
    attach()
    machine.runStatus = 404
    machine.runBody = JSON.stringify({ _tag: "CommandNotFoundError", command: "nope", message: "nope" })
    expect((await api(`chat-targets/${SESSION}/command`, "POST", { name: "nope" }))!.status).toBe(404)
  })

  test.each([
    ["command", { name: "" }],
    ["command", { name: "/review" }],
    ["command", { name: "two words" }],
    ["shell", { command: "  " }],
  ])("%s %p is refused", async (action, body) => {
    attach()
    expect((await api(`chat-targets/${SESSION}/${action}`, "POST", body))!.status).toBe(400)
  })
})
