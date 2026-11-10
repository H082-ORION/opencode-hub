import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Account } from "../src/account.js"
import { Hub } from "../src/index.js"
import { browser } from "./fixture/browser.js"

// A hub at hub.example.test whose machines live directly under example.test, as with a DNS provider that only offers
// a `*.example.test` wildcard. Requests reach the hub over the loopback with the public name in their Host header.

type Setup = Awaited<ReturnType<typeof setup>>

const dirs: string[] = []
const state = {} as { custom: Setup; standard: Setup }

beforeAll(async () => {
  state.custom = await setup("example.test")
  state.standard = await setup(undefined)
})

afterAll(async () => {
  await state.custom?.hub.stop()
  await state.standard?.hub.stop()
  dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

describe("machineDomain", () => {
  test("routes machine hosts under the machine domain, and keeps the hub's own host for the hub", async () => {
    const custom = state.custom
    expect(await (await custom.get("hub.example.test", "/hub/health")).text()).toBe("ok")
    // The machine is not connected, so it answers as an offline machine rather than an unknown one.
    expect((await custom.get(`${custom.machine}.example.test`, "/")).status).toBe(503)
    expect((await custom.get("nobody.example.test", "/")).status).toBe(404)
    // The hub's own domain is no longer where machines live: `laptop.hub` is no machine label.
    expect((await custom.get(`${custom.machine}.hub.example.test`, "/")).status).toBe(404)
  })

  test("the hub's host stays the hub although it sits under the machine domain", async () => {
    const custom = state.custom
    expect(await custom.allowed("hub.example.test")).toBe(200)
    expect(await (await custom.get("hub.example.test", "/hub/health")).text()).toBe("ok")
    expect(await custom.handoff("https://hub.example.test/settings")).toBe("/settings")
  })

  test("tls-allowed answers for the hub and the known machines under the machine domain only", async () => {
    const allowed = state.custom.allowed
    expect(await allowed("hub.example.test")).toBe(200)
    expect(await allowed(`${state.custom.machine}.example.test`)).toBe(200)
    expect(await allowed("nobody.example.test")).toBe(404)
    expect(await allowed(`${state.custom.machine}.hub.example.test`)).toBe(404)
    expect(await allowed("example.test")).toBe(404)
  })

  test("hands off to the machine's origin under the machine domain", async () => {
    const custom = state.custom
    expect(custom.listed).toBe(`/hub/handoff?next=${encodeURIComponent(`https://${custom.machine}.example.test/`)}`)
    expect(await custom.handoff(`https://${custom.machine}.example.test/a?b=1`)).toStartWith(
      `https://${custom.machine}.example.test/auth/hub-session?ticket=`,
    )
    expect(await custom.handoff(`https://${custom.machine}.hub.example.test/`)).toBe("/")
    const login = await custom.get(`${custom.machine}.example.test`, "/x", false)
    expect(login.headers.get("location")).toBe(
      `https://hub.example.test/login?next=${encodeURIComponent(`https://${custom.machine}.example.test/x`)}`,
    )
  })

  test("enforces same-origin against the machine domain's origin", async () => {
    const custom = state.custom
    const sibling = await custom.get(`${custom.machine}.example.test`, "/", true, "https://other.example.test")
    expect(sibling.status).toBe(403)
    const same = await custom.get(`${custom.machine}.example.test`, "/", true, `https://${custom.machine}.example.test`)
    expect(same.status).toBe(503)
  })

  test("defaults to the hub's own host", async () => {
    const standard = state.standard
    expect(standard.listed).toBe(
      `/hub/handoff?next=${encodeURIComponent(`https://${standard.machine}.hub.example.test/`)}`,
    )
    expect((await standard.get(`${standard.machine}.hub.example.test`, "/")).status).toBe(503)
    expect(await standard.allowed(`${standard.machine}.hub.example.test`)).toBe(200)
    expect(await standard.allowed(`${standard.machine}.example.test`)).toBe(404)
  })

  test.each(["https://example.test", "example.test/path", "exa_mple.test", "", "-bad.test"])(
    "rejects %p at start",
    async (machineDomain) => {
      const data = mkdtempSync(path.join(os.tmpdir(), "opencode-machine-domain-invalid-"))
      dirs.push(data)
      await expect(
        Hub.start({ hostname: "127.0.0.1", port: 0, data, url: "https://hub.example.test", machineDomain }),
      ).rejects.toThrow("Invalid machine domain")
    },
  )

  test("accepts a host with a port, in any case", async () => {
    const data = mkdtempSync(path.join(os.tmpdir(), "opencode-machine-domain-port-"))
    dirs.push(data)
    const hub = await Hub.start({
      hostname: "127.0.0.1",
      port: 0,
      data,
      url: "http://hub.localhost:4800",
      machineDomain: "LocalHost:4800",
      catalog: { fetch: offline },
    })
    await hub.stop()
  })
})

/** Keeps the provider catalog on its built-in list, so tests never reach models.dev. */
const offline = Object.assign(async () => Response.error(), { preconnect: () => {} }) as typeof fetch

/** A hub at https://hub.example.test with one user and one machine. */
async function setup(machineDomain: string | undefined) {
  const data = mkdtempSync(path.join(os.tmpdir(), "opencode-machine-domain-"))
  dirs.push(data)
  const hub = await Hub.start({
    hostname: "127.0.0.1",
    port: 0,
    data,
    url: "https://hub.example.test",
    machineDomain,
    catalog: { fetch: offline },
  })
  const loopback = `http://127.0.0.1:${hub.port}`
  const page = browser(loopback, { host: "hub.example.test", origin: hub.url, "x-forwarded-for": "198.51.100.1" })
  const invite = new URL(hub.invite("admin").url).searchParams.get("invite") ?? ""
  await Account.register({ post: page.post, invite, login: "alice", password: "alice-password" })

  const code = (await page.post<{ code: string }>("machines/code", {})).code
  const enrolled = await fetch(`${loopback}/hub/agent/enroll`, {
    method: "POST",
    headers: { host: "hub.example.test", "content-type": "application/json" },
    body: JSON.stringify({ code, name: "Laptop" }),
  })
  const machine = ((await enrolled.json()) as { machine: { id: string } }).machine.id
  const listed = ((await (await page.request("machines")).json()) as { id: string; url: string }[]).find(
    (entry) => entry.id === machine,
  )?.url

  const get = (host: string, pathname: string, signedIn = true, origin?: string) =>
    fetch(`${loopback}${pathname}`, {
      headers: {
        host,
        ...(signedIn ? { cookie: page.jar.cookie } : {}),
        ...(origin ? { origin } : {}),
      },
      redirect: "manual",
    })

  return {
    hub,
    machine,
    listed,
    get,
    /** Where `/hub/handoff` sends the signed-in user for `next`. */
    handoff: async (next: string) =>
      (await get("hub.example.test", `/hub/handoff?next=${encodeURIComponent(next)}`)).headers.get("location") ?? "",
    /** Caddy's on-demand TLS check, by IP address. */
    allowed: (domain: string) =>
      fetch(`${loopback}/hub/tls-allowed?domain=${domain}`).then((response) => response.status),
  }
}
