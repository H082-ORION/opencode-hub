import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Account } from "../src/account.js"
import { AgentSkills } from "../src/agent/skills.js"
import { Instances } from "../src/agent/instances.js"
import { Agent, Hub } from "../src/index.js"
import { Store } from "../src/hub/store.js"
import { Skills } from "../src/skills.js"
import { browser } from "./fixture/browser.js"

// Skills of users and organizations (specs/multi-users.md, step 6): validation, rights, effective skills and their
// conflicts, SKILLS distribution, and the agent writing them next to local skills.

type Page = ReturnType<typeof browser>
type Listed = { id: string; name: string; description: string; files: Skills.File[]; hiddenBy: string | null }
type Overview = { own: Listed[]; inherited: (Listed & { org: { id: string; name: string } })[]; version: string }

const SERVER = [process.execPath, path.join(import.meta.dir, "fixture", "instance-server.ts")]

const dirs: string[] = []
const addresses = { next: 1 }
const state = {} as {
  hub: Awaited<ReturnType<typeof Hub.start>>
  store: Store.Instance
  alice: Page
  bob: Page
  carol: Page
  acme: string
  beta: string
}

beforeAll(async () => {
  const data = tempDir()
  state.hub = await Hub.start({ hostname: "127.0.0.1", port: 0, data, catalog: { fetch: offline } })
  state.store = Store.open(data)
  state.alice = await signUp(state.hub.invite("admin").url, "alice")
  state.bob = await signUp(await invite(), "bob")
  state.carol = await signUp(await invite(), "carol")
  state.acme = (await state.alice.post<{ id: string }>("orgs", { name: "Acme" })).id
  state.beta = (await state.alice.post<{ id: string }>("orgs", { name: "beta" })).id
  await state.alice.post(`orgs/${state.acme}/members`, { user: userID("bob") })
})

afterAll(async () => {
  await state.hub?.stop()
  state.store?.close()
  dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

describe("validation", () => {
  test("accepts a SKILL.md with a frontmatter that names and describes the skill, and extra text files", () => {
    expect(
      Skills.check(skill("review", "Reviews code.", [{ path: "notes/checklist.md", content: "- tests" }])),
    ).toEqual({ description: "Reviews code." })
  })

  test("refuses paths that leave the skill's folder or are not plain relative paths", () => {
    const unsafe = ["../escape.md", "/etc/passwd", "a/../../b.md", "a\\b.md", ".hidden", "a//b.md", "C:/x.md", "a/./b"]
    unsafe.forEach((file) =>
      expect(Skills.check(skill("review", "x", [{ path: file, content: "" }]))).toMatchObject({
        error: expect.stringContaining("Unsafe file path"),
      }),
    )
    expect(Skills.check(skill("review", "x", [{ path: "skill.md", content: "" }]))).toMatchObject({
      error: expect.stringContaining("same path"),
    })
  })

  test("refuses a skill over 256 KiB", () => {
    const big = skill("review", "x", [{ path: "big.txt", content: "x".repeat(Skills.MAX_BYTES) }])
    expect(Skills.check(big)).toMatchObject({ error: expect.stringContaining("256 KiB") })
  })

  test("refuses a missing SKILL.md, or one without a valid frontmatter", () => {
    expect(Skills.check({ name: "review", files: [{ path: "README.md", content: "x" }] })).toMatchObject({
      error: expect.stringContaining("needs a SKILL.md"),
    })
    const entry = (content: string) => Skills.check({ name: "review", files: [{ path: "SKILL.md", content }] })
    expect(entry("# Review\nNo frontmatter.")).toMatchObject({ error: expect.stringContaining("frontmatter") })
    expect(entry("---\nname: review\n---\nNo description.")).toMatchObject({
      error: expect.stringContaining("frontmatter"),
    })
    expect(entry("---\nname: [review\n---\n")).toMatchObject({ error: expect.stringContaining("frontmatter") })
    expect(entry("---\nname: other\ndescription: x\n---\n")).toMatchObject({
      error: expect.stringContaining('"review"'),
    })
    expect(entry("---\nname: review\ndescription: '  '\n---\n")).toMatchObject({
      error: expect.stringContaining("description"),
    })
  })

  test("refuses names that are not one safe folder name", () => {
    ;["Review", "-review", "review-", "re--view", "re_view", "../review", "a".repeat(65), ""].forEach((name) =>
      expect(Skills.check(skill(name, "x"))).toMatchObject({ error: expect.stringContaining("skill name") }),
    )
  })

  test("versions follow the content only, and no skills is the digest of an empty list", () => {
    const a = skill("a", "x", [{ path: "z.md", content: "1" }])
    const b = skill("b", "y")
    expect(Skills.version([a, b])).toBe(Skills.version([b, { ...a, files: a.files.toReversed() }]))
    expect(Skills.version([a, b])).not.toBe(Skills.version([a]))
    expect(Skills.EMPTY_VERSION).toBe(new Bun.CryptoHasher("sha256").update("[]").digest("hex"))
  })
})

describe("rights", () => {
  test("a user creates, updates and deletes their own skills, and cannot reach another user's", async () => {
    const created = await save(state.carol, "skills", skill("notes", "Takes notes."))
    expect(created.status).toBe(200)
    const id = ((await created.json()) as { skill: Listed }).skill.id
    expect((await save(state.carol, `skills/${id}`, skill("notes", "Takes better notes."))).status).toBe(200)
    expect((await overview(state.carol)).own.map((entry) => entry.description)).toEqual(["Takes better notes."])
    expect((await save(state.carol, "skills", skill("notes", "Again."))).status).toBe(409)
    // Another user's skill does not exist for Bob, whatever he tries.
    expect((await save(state.bob, `skills/${id}`, skill("notes", "Mine now."))).status).toBe(404)
    expect((await state.bob.request(`skills/${id}`, { method: "DELETE" })).status).toBe(404)
    expect(
      (await save(state.carol, "skills", { name: "bad", files: [{ path: "SKILL.md", content: "x" }] })).status,
    ).toBe(400)
    expect((await state.carol.request(`skills/${id}`, { method: "DELETE" })).status).toBe(204)
    expect((await overview(state.carol)).own).toEqual([])
  })

  test("only administrators manage an organization's skills; members read them", async () => {
    const created = await save(state.alice, `orgs/${state.acme}/skills`, skill("deploy", "Deploys Acme."))
    expect(created.status).toBe(200)
    const id = ((await created.json()) as { skill: Listed }).skill.id
    // Bob is a member, not an administrator: read-only.
    expect((await save(state.bob, `orgs/${state.acme}/skills`, skill("other", "x"))).status).toBe(403)
    expect((await save(state.bob, `orgs/${state.acme}/skills/${id}`, skill("deploy", "Hijacked."))).status).toBe(403)
    expect((await state.bob.request(`orgs/${state.acme}/skills/${id}`, { method: "DELETE" })).status).toBe(403)
    expect((await state.bob.request(`orgs/${state.acme}/skills`)).status).toBe(403)
    // Carol is neither.
    expect((await save(state.carol, `orgs/${state.acme}/skills`, skill("other", "x"))).status).toBe(403)
    // A skill of one organization cannot be changed through another.
    expect((await save(state.alice, `orgs/${state.beta}/skills/${id}`, skill("deploy", "x"))).status).toBe(404)
    expect((await save(state.alice, `orgs/unknown-org-id/skills`, skill("x", "x"))).status).toBe(404)
    const inherited = (await overview(state.bob)).inherited
    expect(inherited).toMatchObject([{ id, name: "deploy", org: { name: "Acme" }, hiddenBy: null }])
    expect((await overview(state.carol)).inherited).toEqual([])
    expect((await state.alice.request(`orgs/${state.acme}/skills/${id}`, { method: "DELETE" })).status).toBe(204)
  })

  test("an owner has at most 200 skills", async () => {
    const page = await signUp(await invite(), "many")
    const statuses = await Promise.all(
      Array.from({ length: Skills.MAX_PER_OWNER }, (_, index) => save(page, "skills", skill(`s${index}`, "x"))),
    )
    expect(statuses.every((response) => response.status === 200)).toBe(true)
    expect((await save(page, "skills", skill("one-more", "x"))).status).toBe(409)
  })
})

describe("effective skills", () => {
  test("an organization's skill wins over a personal one, and the first organization by name over the others", async () => {
    const page = await signUp(await invite(), "dana")
    await state.alice.post(`orgs/${state.acme}/members`, { user: userID("dana") })
    await state.alice.post(`orgs/${state.beta}/members`, { user: userID("dana") })
    await save(page, "skills", skill("lint", "Dana's lint."))
    await save(page, "skills", skill("solo", "Dana's own."))
    await save(state.alice, `orgs/${state.beta}/skills`, skill("lint", "Beta's lint."))
    await save(state.alice, `orgs/${state.beta}/skills`, skill("ship", "Beta ships."))
    await save(state.alice, `orgs/${state.acme}/skills`, skill("ship", "Acme ships."))

    const view = await overview(page)
    expect(view.own.map((entry) => [entry.name, entry.hiddenBy])).toEqual([
      ["lint", "beta"],
      ["solo", null],
    ])
    expect(view.inherited.map((entry) => [entry.org.name, entry.name, entry.hiddenBy])).toEqual([
      ["Acme", "ship", null],
      ["beta", "lint", null],
      ["beta", "ship", "Acme"],
    ])
    const sent = await connectPersonal(page, "Dana Box")
    expect(sent.skills.at(-1)!.skills.map((entry) => [entry.name, description(entry)])).toEqual([
      ["lint", "Beta's lint."],
      ["ship", "Acme ships."],
      ["solo", "Dana's own."],
    ])
    expect(sent.skills.at(-1)!.version).toBe(view.version)
    await sent.agent.close()
  })
})

describe("distribution", () => {
  test("SKILLS follows INSTANCE with the same version, and only instances whose skills changed get a new one", async () => {
    const erin = await signUp(await invite(), "erin")
    const frank = await signUp(await invite(), "frank")
    await state.alice.post(`orgs/${state.acme}/members`, { user: userID("erin") })
    const e = await connectPersonal(erin, "Erin Box")
    const f = await connectPersonal(frank, "Frank Box")
    expect(e.skills.length).toBe(1)
    expect(e.skills[0]!.version).toBe(e.instances[0]!.skills.version)
    expect(f.skills.length).toBe(1)
    expect(f.skills[0]!.skills).toEqual([])
    expect(f.skills[0]!.version).toBe(Skills.EMPTY_VERSION)

    const created = await save(state.alice, `orgs/${state.acme}/skills`, skill("triage", "Triage issues."))
    const id = ((await created.json()) as { skill: Listed }).skill.id
    await until(() => e.skills.length === 2)
    expect(e.skills[1]!.skills.map((entry) => entry.name)).toContain("triage")
    // The same content again changes no version: nothing is sent.
    await save(state.alice, `orgs/${state.acme}/skills/${id}`, skill("triage", "Triage issues."))
    await save(frank, "skills", skill("mine", "Frank's."))
    await until(() => f.skills.length === 2)
    await barrier(erin, e.enrollment)
    expect(e.skills.length).toBe(2)
    expect(f.skills[1]!.skills.map((entry) => entry.name)).toEqual(["mine"])

    // Leaving the organization takes its skills away from the member's remaining instances.
    await state.alice.request(`orgs/${state.acme}/members/${userID("erin")}`, { method: "DELETE" })
    await until(() => e.skills.length === 3)
    expect(e.skills[2]!.skills.map((entry) => entry.name)).not.toContain("triage")
    await e.agent.close()
    await f.agent.close()
  })

  test("an agent that reconnects gets SKILLS only when its version differs", async () => {
    const page = await signUp(await invite(), "gina")
    await save(page, "skills", skill("first", "First."))
    const first = await connectPersonal(page, "Gina Box")
    const written = first.skills[0]!
    const token = first.instances[0]!.token
    await first.agent.close()

    const same = await connectPersonal(page, undefined, first.enrollment, [
      { iid: written.iid, token, skills: written.version },
    ])
    expect(same.skills).toEqual([])
    await same.agent.close()

    await save(page, "skills", skill("second", "Second."))
    const changed = await connectPersonal(page, undefined, first.enrollment, [
      { iid: written.iid, token, skills: written.version },
    ])
    await until(() => changed.skills.length === 1)
    expect(changed.skills[0]!.skills.map((entry) => entry.name)).toEqual(["first", "second"])
    await changed.agent.close()
  })

  test("an organization machine writes a member's skills before starting their instance, and reloads it on a change", async () => {
    const root = path.join(tempDir(), "hub-instances")
    const manager = Instances.create({ root, command: SERVER, cwd: os.tmpdir() })
    const page = await signUp(await invite(), "hana")
    await state.alice.post(`orgs/${state.acme}/members`, { user: userID("hana") })
    const created = await save(state.alice, `orgs/${state.acme}/skills`, skill("onboard", "Onboards Acme."))
    const id = ((await created.json()) as { skill: Listed }).skill.id
    const code = (await state.bob.post<{ code: string }>("machines/code", { org: state.acme })).code
    const enrollment = await Agent.enroll({ url: state.hub.url, code, name: "Acme Skills" })
    const ready = Promise.withResolvers<void>()
    const agent = Agent.connect({
      enrollment,
      local: (iid) => manager.local(iid),
      onReady: () => ready.resolve(),
      onInstance: (instance) => void manager.configure(instance),
      onSkills: (skills) => manager.skills(skills),
      onDrop: (iid) => void manager.drop(iid),
    })
    await ready.promise
    const open = async () =>
      (await (
        await fetch(`http://${enrollment.machine.id}.localhost:${state.hub.port}/`, {
          headers: { cookie: page.jar.cookie },
        })
      ).json()) as { config: string; reloads: number }
    const first = await open()
    const iid = state.store.instance(enrollment.machine.id, userID("hana"))!.id
    const folder = Instances.skillsFolder(root, iid)
    expect(path.join(first.config, "opencode", "skills")).toBe(folder)
    expect(readFileSync(path.join(folder, "hub-onboard", "SKILL.md"), "utf8")).toContain("Onboards Acme.")
    expect(first.reloads).toBe(0)

    await save(state.alice, `orgs/${state.acme}/skills/${id}`, skill("onboard", "Onboards Acme, v2."))
    await until(() => readFileSync(path.join(folder, "hub-onboard", "SKILL.md"), "utf8").includes("v2"))
    await untilAsync(async () => (await open()).reloads === 1)

    await agent.close()
    await manager.stop()
    await state.alice.request(`orgs/${state.acme}/skills/${id}`, { method: "DELETE" })
  })
})

describe("agent", () => {
  test("writes hub skills as hub-<name> folders and leaves local skills alone", () => {
    const dir = localSkills()
    const result = AgentSkills.write(dir, payload("v1", [skill("review", "R.", [{ path: "ref/a.md", content: "A" }])]))
    expect(result).toEqual({ changed: true, written: ["hub-review"], skipped: [] })
    expect(readFileSync(path.join(dir, "hub-review", "SKILL.md"), "utf8")).toContain(`description: "R."`)
    expect(readFileSync(path.join(dir, "hub-review", "ref", "a.md"), "utf8")).toBe("A")
    expect(readFileSync(path.join(dir, "mine", "SKILL.md"), "utf8")).toBe("local")
    expect(AgentSkills.manifest(dir)).toEqual({ iid: "instance-for-skills", version: "v1", skills: ["hub-review"] })
    expect(readdirSync(dir).filter((name) => name.startsWith(".hub-staging"))).toEqual([])
    expect(AgentSkills.write(dir, payload("v1", [skill("review", "R.")])).changed).toBe(false)
  })

  test("refuses any path or name outside its folder, before writing anything", () => {
    const dir = localSkills()
    const escape = { name: "review", files: [{ path: "../../outside.md", content: "x" }] }
    expect(() => AgentSkills.write(dir, payload("v1", [skill("ok", "x"), escape]))).toThrow("unsafe file path")
    expect(() => AgentSkills.write(dir, payload("v1", [{ name: "../up", files: [] }]))).toThrow("unsafe name")
    expect(() =>
      AgentSkills.write(dir, payload("v1", [{ name: "x", files: [{ path: "/abs", content: "" }] }])),
    ).toThrow("unsafe file path")
    expect(readdirSync(dir).toSorted()).toEqual(["hub-local", "mine"])
    expect(existsSync(path.join(dir, "..", "outside.md"))).toBe(false)
  })

  test("replaces the whole hub set: changed skills are swapped in, missing ones deleted, local ones untouched", () => {
    const dir = localSkills()
    AgentSkills.write(dir, payload("v1", [skill("review", "Old."), skill("gone", "Gone.")]))
    const before = statSync(path.join(dir, "hub-review")).ino
    // A staging folder left by an agent that died mid-write.
    mkdirSync(path.join(dir, ".hub-staging-dead"))
    const result = AgentSkills.write(dir, payload("v2", [skill("review", "New."), skill("local", "Hub's.")]))
    // A local folder that happens to use a hub name is the user's: that hub skill is skipped.
    expect(result).toEqual({ changed: true, written: ["hub-review"], skipped: ["hub-local"] })
    expect(statSync(path.join(dir, "hub-review")).ino).not.toBe(before)
    expect(readFileSync(path.join(dir, "hub-review", "SKILL.md"), "utf8")).toContain("New.")
    expect(existsSync(path.join(dir, "hub-gone"))).toBe(false)
    expect(readFileSync(path.join(dir, "hub-local", "SKILL.md"), "utf8")).toBe("local")
    expect(readFileSync(path.join(dir, "mine", "SKILL.md"), "utf8")).toBe("local")
    expect(readdirSync(dir).toSorted()).toEqual([AgentSkills.MANIFEST, "hub-local", "hub-review", "mine"])
  })

  test("removing deletes only the folders the agent wrote", () => {
    const dir = localSkills()
    AgentSkills.write(dir, payload("v1", [skill("review", "R.")]))
    expect(AgentSkills.remove(dir)).toBe(true)
    expect(readdirSync(dir).toSorted()).toEqual(["hub-local", "mine"])
    expect(AgentSkills.remove(dir)).toBe(false)
  })

  test("a manifest listing something else than hub folders is not trusted", () => {
    const dir = localSkills()
    writeFileSync(
      path.join(dir, AgentSkills.MANIFEST),
      JSON.stringify({ iid: "x", version: "v", skills: ["mine", "../..", "hub-../x"] }),
    )
    AgentSkills.remove(dir)
    expect(readdirSync(dir).toSorted()).toEqual(["hub-local", "mine"])
  })
})

/** Keeps the provider catalog on its built-in list, so tests never reach models.dev. */
const offline = Object.assign(async () => Response.error(), { preconnect: () => {} }) as typeof fetch

function skill(name: string, text: string, files: Skills.File[] = []): Skills.Skill {
  return {
    name,
    files: [
      { path: "SKILL.md", content: `---\nname: ${name}\ndescription: ${JSON.stringify(text)}\n---\n\nBody.\n` },
      ...files,
    ],
  }
}

function description(entry: Skills.Skill) {
  return Skills.frontmatter(entry.files.find((file) => file.path === "SKILL.md")!.content)?.description
}

function payload(version: string, skills: Skills.Skill[]) {
  return { iid: "instance-for-skills", version, skills }
}

/** A skills folder with a local skill and a local folder that happens to start with `hub-`. */
function localSkills() {
  const dir = path.join(tempDir(), "skills")
  ;["mine", "hub-local"].forEach((name) => {
    mkdirSync(path.join(dir, name), { recursive: true })
    writeFileSync(path.join(dir, name, "SKILL.md"), "local")
  })
  return dir
}

function save(page: Page, route: string, body: unknown) {
  return page.request(route, { method: "POST", body })
}

async function overview(page: Page) {
  return (await (await page.request("skills")).json()) as Overview
}

/** A personal machine's agent that records what the hub sends it. */
async function connectPersonal(
  page: Page,
  name: string | undefined,
  known?: Agent.Enrollment,
  instances?: { iid: string; token: string; skills?: string }[],
) {
  const enrollment =
    known ??
    (await Agent.enroll({
      url: state.hub.url,
      code: (await page.post<{ code: string }>("machines/code", {})).code,
      name: name ?? "Box",
    }))
  const received = { instances: [] as Agent.Instance[], skills: [] as Agent.Skills[] }
  const agent = Agent.connect({
    enrollment,
    instances,
    local: async () => ({ url: "http://127.0.0.1:9" }),
    onInstance: (instance) => received.instances.push(instance),
    onSkills: (skills) => void received.skills.push(skills),
  })
  await until(() => received.instances.length > 0)
  await barrier(page, enrollment)
  return { ...received, agent, enrollment }
}

/**
 * Returns once the agent has handled every frame the hub sent it so far: a request to the machine reaches the agent
 * as an OPEN behind them, and its answer (the local server is unreachable here) comes back.
 */
async function barrier(page: Page, enrollment: Agent.Enrollment) {
  const response = await fetch(`http://${enrollment.machine.id}.localhost:${state.hub.port}/`, {
    headers: { cookie: page.jar.cookie },
  })
  await response.arrayBuffer()
}

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opencode-skills-"))
  dirs.push(dir)
  return dir
}

/** Each page signs up from its own client address, so sign-in throttling never crosses tests. */
async function signUp(url: string, login: string) {
  const page = browser(state.hub.url, { "x-forwarded-for": `198.51.100.${addresses.next++}` })
  const invite = new URL(url).searchParams.get("invite") ?? ""
  await Account.register({ post: page.post, invite, login, password: `${login}-password` })
  return page
}

async function invite() {
  return (await state.alice.post<{ url: string }>("invitations", { role: "user" })).url
}

function userID(login: string) {
  return state.store.userByLogin(login)!.id
}

async function until(condition: () => boolean, deadline = Date.now() + 10_000): Promise<void> {
  if (condition()) return
  if (Date.now() > deadline) throw new Error("condition not met in time")
  await Bun.sleep(10)
  return until(condition, deadline)
}

async function untilAsync(condition: () => Promise<boolean>, deadline = Date.now() + 10_000): Promise<void> {
  if (await condition()) return
  if (Date.now() > deadline) throw new Error("condition not met in time")
  await Bun.sleep(10)
  return untilAsync(condition, deadline)
}
