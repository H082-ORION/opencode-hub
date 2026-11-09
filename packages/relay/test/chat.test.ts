import { $ } from "bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Account } from "../src/account.js"
import { Hub } from "../src/index.js"
import { browser } from "./fixture/browser.js"

// The hub's chat: a closed list of routes in front of each user's tool-less opencode instance.

type Page = ReturnType<typeof browser>
type Echo = {
  method: string
  path: string
  search: string
  body?: Record<string, unknown>
  pid: number
  token: string
  content: string
  secret?: string
}

const SERVER = [process.execPath, path.join(import.meta.dir, "fixture", "chat-server.ts")]
const CHAT = "chat/api"
const MODEL = { id: "real", providerID: "fake" }
const RULES = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "hub-tools_*", resource: "*", effect: "allow" },
]
const SKILL = (name: string) => `---\nname: ${name}\ndescription: The ${name} skill\n---\nBody of ${name}.\n`
const data = mkdtempSync(path.join(os.tmpdir(), "opencode-chat-"))
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => Response.json({ authorization: request.headers.get("authorization") }),
})
const offline = Object.assign(async () => Response.error(), { preconnect: () => {} }) as typeof fetch
const addresses = { next: 1 }
const state = {} as {
  hub: Awaited<ReturnType<typeof Hub.start>>
  alice: Page
  bob: Page
  archive: Uint8Array
  requested: string[]
}

beforeAll(async () => {
  state.requested = []
  state.archive = await repository()
  process.env.CHAT_TEST_SECRET = "must-not-reach-the-instance"
  state.hub = await Hub.start({
    hostname: "127.0.0.1",
    port: 0,
    data,
    catalog: { fetch: offline },
    chat: {
      command: SERVER,
      cwd: os.tmpdir(),
      fetch: Object.assign(
        async (url: string | URL | Request) => {
          state.requested.push(String(url))
          return new Response(state.archive)
        },
        { preconnect: () => {} },
      ) as typeof fetch,
    },
  })
  state.alice = await signUp(state.hub.invite("admin").url, "alice")
  state.bob = await signUp((await state.alice.post<{ url: string }>("invitations", { role: "user" })).url, "bob")
  await state.alice.post("providers", {
    id: "fake",
    name: "Fake",
    baseURL: `http://127.0.0.1:${upstream.port}/v1`,
    apiKey: "sk-alice",
  })
})

afterAll(async () => {
  delete process.env.CHAT_TEST_SECRET
  await state.hub?.stop()
  upstream.stop(true)
  rmSync(data, { recursive: true, force: true })
})

describe("closed list of routes", () => {
  test.each([
    ["POST", "session/s1/shell"],
    ["POST", "session/s1/command"],
    ["POST", "pty"],
    ["GET", "fs/read"],
    ["GET", "config"],
    ["POST", "location/reload"],
    ["POST", "mcp"],
  ])("%s %s never reaches the instance", async (method, route) => {
    expect((await state.alice.request(`${CHAT}/${route}`, { method })).status).toBe(404)
  })

  test("a signed-out browser gets nothing", async () => {
    expect((await browser(state.hub.url).request(`${CHAT}/session`)).status).toBe(401)
  })

  test("a location in the query never reaches the instance", async () => {
    const echo = await read(state.alice, `${CHAT}/session?limit=5&location=/etc&location%5Bdirectory%5D=/etc`)
    expect(echo.search).toBe("?limit=5")
  })
})

describe("writes are rebuilt by the hub", () => {
  test("a session gets the tool-less agent, whatever the browser asked for", async () => {
    const echo = await send(state.alice, `${CHAT}/session`, {
      id: "ses_1",
      title: "Hello",
      model: MODEL,
      agent: "build",
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      location: { directory: "/etc" },
    })
    expect(echo.body).toEqual({
      id: "ses_1",
      title: "Hello",
      model: MODEL,
      agent: "hub",
      permissions: RULES,
    })
  })

  test("only the user's own providers may answer", async () => {
    const model = { id: "free", providerID: "opencode" }
    expect((await state.alice.request(`${CHAT}/session`, { method: "POST", body: { model } })).status).toBe(403)
    expect((await state.alice.request(`${CHAT}/session/s1/model`, { method: "POST", body: { model } })).status).toBe(
      403,
    )
    expect((await state.bob.request(`${CHAT}/session`, { method: "POST", body: { model: MODEL } })).status).toBe(403)
  })

  test("a prompt carries its text and nothing else", async () => {
    const echo = await send(state.alice, `${CHAT}/session/s1/prompt`, {
      text: "Hello",
      files: [{ uri: "file:///etc/passwd" }],
      skills: [{ name: "x" }],
    })
    expect(echo.body).toEqual({ text: "Hello" })
  })

  test("models are limited to the user's providers", async () => {
    const response = await state.alice.request(`${CHAT}/model`)
    expect(await response.json()).toEqual({ data: [MODEL] })
  })
})

describe("the instance", () => {
  test("has every tool and integration shut, and inherits nothing from the hub", async () => {
    const echo = await read(state.alice, `${CHAT}/session`)
    const config = JSON.parse(echo.content)
    expect(config.permissions).toEqual(RULES)
    expect(config.agents.hub.permissions).toEqual(RULES)
    expect(Object.keys(config.mcp.servers)).toEqual(["hub-tools"])
    expect(config.policies).toContainEqual({ action: "tool.use", resource: "*", effect: "deny" })
    expect(config.policies).toContainEqual({ action: "provider.use", resource: "opencode", effect: "deny" })
    expect(echo.secret).toBeUndefined()
  })

  test("is one per user", async () => {
    expect((await read(state.alice, `${CHAT}/session`)).pid).not.toBe((await read(state.bob, `${CHAT}/session`)).pid)
  })

  test("reaches its user's provider through the proxy with its own token", async () => {
    const echo = await read(state.alice, `${CHAT}/session`)
    const response = await fetch(`http://127.0.0.1:${state.hub.port}/llm/fake/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${echo.token}`, "content-type": "application/json" },
      body: "{}",
    })
    expect(await response.json()).toEqual({ authorization: "Bearer sk-alice" })
  })

  test("a token it does not know opens no provider", async () => {
    const response = await fetch(`http://127.0.0.1:${state.hub.port}/llm/fake/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer nobody", "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(401)
  })
})

describe("the chat's tools", () => {
  test("refuse a token that is not a chat instance's", async () => {
    const response = await rpc("nobody", "tools/list")
    expect(response.status).toBe(401)
  })

  test("offer only the skill tools", async () => {
    // SAFETY: the shape of an MCP `tools/list` answer.
    const body = (await (await rpc(await token(state.alice), "tools/list")).json()) as {
      result: { tools: { name: string }[] }
    }
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "skills_list",
      "skill_read",
      "skill_save",
      "skills_install_github",
    ])
  })

  test("create a skill the user then has, and keep it from being overwritten by accident", async () => {
    const files = [{ path: "SKILL.md", content: SKILL("from-chat") }]
    expect((await call(state.alice, "skill_save", { name: "from-chat", files })).isError).toBeUndefined()
    expect((await call(state.alice, "skill_save", { name: "from-chat", files })).isError).toBe(true)
    expect(await ownSkills(state.alice)).toContain("from-chat")
    expect((await call(state.alice, "skill_read", { name: "from-chat" })).content[0].text).toContain(
      "Body of from-chat",
    )
  })

  test("only touch their user's skills", async () => {
    expect((await call(state.bob, "skill_read", { name: "from-chat" })).isError).toBe(true)
    expect(await ownSkills(state.bob)).not.toContain("from-chat")
  })

  test("refuse a skill the hub would refuse", async () => {
    expect((await call(state.alice, "skill_save", { name: "Bad Name", files: [] })).isError).toBe(true)
  })

  test("install every skill of a GitHub repository, leaving out what a skill cannot hold", async () => {
    const result = await call(state.alice, "skills_install_github", { url: "https://github.com/acme/skills" })
    expect(state.requested.at(-1)).toBe("https://codeload.github.com/acme/skills/tar.gz/HEAD")
    expect(result.isError).toBeUndefined()
    const skills = await ownSkills(state.alice)
    expect(skills).toContain("alpha")
    expect(skills).toContain("beta")
    expect(result.content[0].text).toContain('"skippedFiles": 1')
  })

  test("install from one folder of a branch", async () => {
    await call(state.bob, "skills_install_github", { url: "https://github.com/acme/skills/tree/main/skills/beta" })
    expect(state.requested.at(-1)).toBe("https://codeload.github.com/acme/skills/tar.gz/main")
    expect(await ownSkills(state.bob)).toEqual(["beta"])
  })

  test("keep to github.com", async () => {
    const before = state.requested.length
    const urls = ["https://example.com/acme/skills", "http://github.com/acme/skills", "https://github.com/acme"]
    await Promise.all(
      urls.map(async (url) => expect((await call(state.alice, "skills_install_github", { url })).isError).toBe(true)),
    )
    expect(state.requested.length).toBe(before)
  })
})

/** A GitHub-shaped archive: two skills, under the `<repository>-<commit>/` folder, one with a binary file. */
async function repository() {
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-chat-repo-"))
  const write = (file: string, content: string | Uint8Array) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), content)
  }
  write("skills-abc/README.md", "A repository of skills")
  write("skills-abc/skills/alpha/SKILL.md", SKILL("alpha"))
  write("skills-abc/skills/alpha/notes/usage.md", "Notes")
  write("skills-abc/skills/alpha/logo.png", new Uint8Array([137, 80, 0, 255]))
  write("skills-abc/skills/beta/SKILL.md", SKILL("beta"))
  await $`tar -czf repo.tar.gz skills-abc`.cwd(root).quiet()
  const archive = await Bun.file(path.join(root, "repo.tar.gz")).bytes()
  rmSync(root, { recursive: true, force: true })
  return archive
}

async function token(page: Page) {
  return (await read(page, `${CHAT}/session`)).token
}

function rpc(token: string, method: string, params?: unknown) {
  return fetch(`http://127.0.0.1:${state.hub.port}/hub/chat-tools`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
}

async function call(page: Page, name: string, args: unknown) {
  // SAFETY: an MCP tool result, as the hub's tools always answer.
  const body = (await (await rpc(await token(page), "tools/call", { name, arguments: args })).json()) as {
    result: { content: { text: string }[]; isError?: boolean }
  }
  return body.result
}

async function ownSkills(page: Page) {
  // SAFETY: the shape of `GET skills`.
  const body = (await (await page.request("skills")).json()) as { own: { name: string }[] }
  return body.own.map((skill) => skill.name)
}

/** Each page signs up from its own client address, so sign-in throttling never crosses tests. */
async function signUp(url: string, login: string) {
  const page = browser(state.hub.url, { "x-forwarded-for": `198.51.100.${addresses.next++}` })
  const invite = new URL(url).searchParams.get("invite") ?? ""
  await Account.register({ post: page.post, invite, login, password: `${login}-password` })
  return page
}

async function read(page: Page, route: string) {
  // SAFETY: the stand-in server echoes this shape on every route it does not answer otherwise.
  return (await (await page.request(route)).json()) as Echo
}

async function send(page: Page, route: string, body: unknown) {
  // SAFETY: as in `read`.
  return (await (await page.request(route, { method: "POST", body })).json()) as Echo
}
