import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Account } from "../src/account.js"
import { Hub } from "../src/index.js"
import { Updates } from "../src/hub/updates.js"
import { browser } from "./fixture/browser.js"

// The hub's self-update, against a local stand-in for the GitHub releases API.

type Page = ReturnType<typeof browser>
type GitHubRelease = { tag_name: string; draft: boolean; prerelease: boolean; body: string | null }

const github = {
  releases: [] as GitHubRelease[],
  status: 200,
  requests: [] as { path: string; agent: string | null; accept: string | null }[],
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    github.requests.push({
      path: `${url.pathname}${url.search}`,
      agent: request.headers.get("user-agent"),
      accept: request.headers.get("accept"),
    })
    if (github.status !== 200) return new Response("nope", { status: github.status })
    return Response.json(
      github.releases.map((release) => ({
        ...release,
        published_at: release.draft ? null : "2026-11-01T00:00:00Z",
        html_url: `https://github.com/H082-ORION/opencode-hub/releases/tag/${release.tag_name}`,
        assets: [],
      })),
    )
  },
})

const root = mkdtempSync(path.join(os.tmpdir(), "opencode-updates-"))
const counter = { next: 0 }

const release = (tag: string, extra: Partial<GitHubRelease> = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: tag.includes("-pre."),
  body: `Notes for ${tag}`,
  ...extra,
})

/** A fresh hub data dir, status file and installer unit (present unless told otherwise). */
function setup(version: string, installer = true) {
  const dir = path.join(root, `case-${counter.next++}`)
  mkdirSync(dir)
  const options = {
    api: `http://127.0.0.1:${server.port}`,
    statusFile: path.join(dir, "status.json"),
    installerUnit: path.join(dir, "opencode-hub-update.path"),
  }
  if (installer) writeFileSync(options.installerUnit, "")
  return { dir, options, updates: Updates.create({ version, data: dir, options }) }
}

const install = (updates: Updates.Instance, body: unknown) =>
  updates.handle(
    new Request("http://hub/hub/api/updates/install", { method: "POST", body: JSON.stringify(body) }),
    "updates/install",
    { session: "s", user: { role: "admin" } } as unknown as Parameters<Updates.Instance["handle"]>[2],
  )

beforeEach(() => {
  github.releases = [
    release("v1.0.0-pre.3"),
    release("v1.0.1"),
    release("v1.1.0-pre.2"),
    release("v1.0.0"),
    release("v1.1.0-pre.10"),
    release("v2.0.0", { draft: true }),
    release("nightly"),
  ]
  github.status = 200
  github.requests = []
})

afterAll(() => {
  server.stop(true)
  rmSync(root, { recursive: true, force: true })
})

describe("versions", () => {
  test("a prerelease comes before its release, and prerelease numbers compare as numbers", () => {
    const ordered = ["0.9.9", "1.0.0-pre.3", "1.0.0-pre.10", "1.0.0", "1.0.1", "1.10.0"]
    expect(["1.0.1", "1.0.0-pre.10", "1.10.0", "0.9.9", "1.0.0", "1.0.0-pre.3"].toSorted(Updates.compare)).toEqual(
      ordered,
    )
    expect(ordered.toReversed().toSorted((a, b) => Updates.compare(a, b))).toEqual(ordered)
    expect(Updates.compare("1.0.0", "1.0.0")).toBe(0)
  })
})

describe("releases", () => {
  test("are fetched with the hub's version, newest first, without drafts or foreign tags", async () => {
    const result = await setup("v1.0.0").updates.get()
    expect(github.requests).toEqual([
      {
        path: "/repos/H082-ORION/opencode-hub/releases?per_page=30",
        agent: "opencode-hub/1.0.0",
        accept: "application/vnd.github+json",
      },
    ])
    expect(result.releases.map((entry) => entry.version)).toEqual([
      "1.1.0-pre.10",
      "1.1.0-pre.2",
      "1.0.1",
      "1.0.0",
      "1.0.0-pre.3",
    ])
    expect(result.releases[0]).toEqual({
      version: "1.1.0-pre.10",
      tag: "v1.1.0-pre.10",
      prerelease: true,
      publishedAt: "2026-11-01T00:00:00Z",
      notes: "Notes for v1.1.0-pre.10",
      url: "https://github.com/H082-ORION/opencode-hub/releases/tag/v1.1.0-pre.10",
    })
    expect(result.current).toBe("1.0.0")
    expect(result.development).toBe(false)
    expect(result.checkedAt).toBeNumber()
    expect(result.error).toBeNull()
  })

  test("offer the newest stable release, and a newer prerelease as the dev version", async () => {
    const result = await setup("1.0.0").updates.get()
    expect(result.stable?.version).toBe("1.0.1")
    expect(result.dev?.version).toBe("1.1.0-pre.10")
  })

  test("offer no dev version older than the stable one", async () => {
    github.releases = [release("v1.0.0-pre.5"), release("v1.0.1"), release("v1.0.1-pre.1")]
    const result = await setup("0.9.0").updates.get()
    expect(result.stable?.version).toBe("1.0.1")
    expect(result.dev).toBeNull()
  })

  test("offer nothing to the newest version", async () => {
    const result = await setup("1.1.0-pre.10").updates.get()
    expect(result.stable).toBeNull()
    expect(result.dev).toBeNull()
  })

  test("a prerelease is offered the release it leads to", async () => {
    const result = await setup("1.0.1-pre.4").updates.get()
    expect(result.stable?.version).toBe("1.0.1")
  })

  test("a development build is offered every release", async () => {
    const result = await setup("0.0.0-dev-202611101200").updates.get()
    expect(result.development).toBe(true)
    expect(result.stable?.version).toBe("1.0.1")
    expect(result.dev?.version).toBe("1.1.0-pre.10")
  })

  test("come from the cache until a check forces a fetch", async () => {
    const updates = setup("1.0.0").updates
    await updates.get()
    await updates.get()
    expect(github.requests).toHaveLength(1)
    github.releases = [release("v3.0.0")]
    expect((await updates.check()).stable?.version).toBe("3.0.0")
    expect(github.requests).toHaveLength(2)
  })

  test("a failed fetch is reported and keeps the last releases", async () => {
    const updates = setup("1.0.0").updates
    const before = await updates.get()
    github.status = 500
    const after = await updates.check()
    expect(after.error).toContain("500")
    expect(after.releases).toEqual(before.releases)
    expect(after.checkedAt).toBe(before.checkedAt)
  })
})

describe("installing", () => {
  test("writes the request for the update helper, which then reads as pending", async () => {
    const context = setup("1.0.0")
    await context.updates.get()
    const response = await install(context.updates, { version: "1.0.1" })
    expect(response!.status).toBe(200)
    expect(await Bun.file(path.join(context.dir, "update", "request")).json()).toEqual({ version: "1.0.1" })
    expect(readdirSync(path.join(context.dir, "update"))).toEqual(["request"])
    expect(((await response!.json()) as Updates.Updates).status).toEqual({ state: "pending", version: "1.0.1" })
  })

  test("refuses a version that is not a release", async () => {
    const context = setup("1.0.0")
    await context.updates.get()
    expect((await install(context.updates, { version: "2.0.0" }))!.status).toBe(400)
    expect((await install(context.updates, { version: "../../etc" }))!.status).toBe(400)
    expect((await install(context.updates, {}))!.status).toBe(400)
    expect(existsSync(path.join(context.dir, "update"))).toBe(false)
  })

  test("needs the update helper", async () => {
    const context = setup("1.0.0", false)
    const result = await context.updates.get()
    expect(result.installer).toEqual({ available: false })
    expect((await install(context.updates, { version: "1.0.1" }))!.status).toBe(409)
  })

  test("refuses a second update while one is pending or running", async () => {
    const context = setup("1.0.0")
    await context.updates.get()
    expect((await install(context.updates, { version: "1.0.1" }))!.status).toBe(200)
    expect((await install(context.updates, { version: "1.1.0-pre.10" }))!.status).toBe(409)
    rmSync(path.join(context.dir, "update", "request"))
    writeFileSync(context.options.statusFile, JSON.stringify({ state: "running", version: "1.0.1", at: 1 }))
    expect((await install(context.updates, { version: "1.1.0-pre.10" }))!.status).toBe(409)
  })
})

describe("status", () => {
  test("is idle without a request or a status file", async () => {
    expect((await setup("1.0.0").updates.get()).status).toEqual({ state: "idle" })
  })

  test("is what the helper last wrote", async () => {
    const context = setup("1.0.0")
    const written: Updates.Status = {
      state: "failed",
      version: "1.0.1",
      message: "checksum mismatch",
      at: 1_700_000_000_000,
    }
    writeFileSync(context.options.statusFile, JSON.stringify(written))
    expect((await context.updates.get()).status).toEqual(written)
  })

  test("ignores a status file it cannot read", async () => {
    const context = setup("1.0.0")
    writeFileSync(context.options.statusFile, JSON.stringify({ state: "exploded" }))
    expect((await context.updates.get()).status).toEqual({ state: "idle" })
  })
})

describe("over the hub API", () => {
  const data = path.join(root, "hub")
  const state = {} as { hub: Awaited<ReturnType<typeof Hub.start>>; alice: Page; bob: Page }

  beforeAll(async () => {
    mkdirSync(data)
    writeFileSync(path.join(data, "opencode-hub-update.path"), "")
    state.hub = await Hub.start({
      hostname: "127.0.0.1",
      port: 0,
      data,
      version: "1.0.0",
      catalog: { fetch: offline },
      updates: {
        api: `http://127.0.0.1:${server.port}`,
        statusFile: path.join(data, "status.json"),
        installerUnit: path.join(data, "opencode-hub-update.path"),
      },
    })
    state.alice = await signUp(state.hub.url, state.hub.invite("admin").url, "alice")
    const invitation = await state.alice.post<{ url: string }>("invitations", { role: "user" })
    state.bob = await signUp(state.hub.url, invitation.url, "bob")
  })

  afterAll(async () => {
    await state.hub?.stop()
  })

  test("only administrators see or start updates", async () => {
    expect((await state.bob.request("updates")).status).toBe(403)
    expect((await state.bob.request("updates/check", { method: "POST" })).status).toBe(403)
    expect((await state.bob.request("updates/install", { method: "POST", body: { version: "1.0.1" } })).status).toBe(
      403,
    )
    expect(existsSync(path.join(data, "update"))).toBe(false)
  })

  test("an administrator checks and installs", async () => {
    const listed = (await (await state.alice.request("updates")).json()) as Updates.Updates
    expect(listed.current).toBe("1.0.0")
    expect(listed.stable?.version).toBe("1.0.1")
    const checked = await state.alice.post<Updates.Updates>("updates/check", {})
    expect(checked.installer).toEqual({ available: true })
    const installed = await state.alice.post<Updates.Updates>("updates/install", { version: "1.0.1" })
    expect(installed.status).toEqual({ state: "pending", version: "1.0.1" })
    expect(await Bun.file(path.join(data, "update", "request")).json()).toEqual({ version: "1.0.1" })
  })
})

const offline = Object.assign(async () => Response.error(), { preconnect: () => {} }) as typeof fetch

/** Each page signs up from its own client address, so sign-in throttling never crosses tests. */
async function signUp(hub: string, url: string, login: string) {
  const page = browser(hub, { "x-forwarded-for": `198.51.100.${counter.next++}` })
  const invite = new URL(url).searchParams.get("invite") ?? ""
  await Account.register({ post: page.post, invite, login, password: `${login}-password` })
  return page
}
