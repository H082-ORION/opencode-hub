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
  online: true,
  answer(call: Call): Response {
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
})

const current = { session: "s", user: { id: USER } } as unknown as Parameters<typeof chat.handle>[2]
const api = (route: string, method = "GET", body?: unknown) =>
  chat.handle(
    new Request(`http://hub/${route}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
    route.split("?")[0]!,
    current,
  )
beforeEach(() => {
  machine.calls = []
  machine.online = true
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

