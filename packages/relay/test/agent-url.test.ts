import { afterAll, describe, expect, test } from "bun:test"
import { Agent } from "../src/index.js"

// Answers enrollments like a hub whose public URL (its --url) is `announced.url`.
const announced = { url: "" }
const requests = { count: 0 }
const hub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    requests.count++
    return Response.json({
      url: announced.url,
      machine: { id: "box", name: "Box" },
      tunnelToken: "tunnel",
      llmToken: "llm",
    })
  },
})
const local = `http://127.0.0.1:${hub.port}`

afterAll(() => hub.stop(true))

describe("isSecureURL", () => {
  test.each([
    ["https://hub.example.com", true],
    ["http://localhost:4800", true],
    ["http://box.localhost:4800", true],
    ["http://127.0.0.1:4800", true],
    ["http://127.12.0.3", true],
    ["http://[::1]:4800", true],
    ["http://hub.example.com", false],
    ["http://192.168.1.10:4800", false],
    ["http://localhost.example.com", false],
    ["http://127.0.0.1.example.com", false],
    ["ftp://hub.example.com", false],
  ])("%s → %p", (url, secure) => {
    expect(Agent.isSecureURL(url)).toBe(secure)
  })
})

describe("enroll", () => {
  test("refuses a plain HTTP hub on another machine before sending anything", async () => {
    await expect(Agent.enroll({ url: "http://hub.example.com", code: "ABCD-EFGH", name: "Box" })).rejects.toThrow(
      "refusing to send the enrollment code in clear text",
    )
  })

  test("refuses a hub that announces a plain HTTP URL for the tunnel", async () => {
    announced.url = "http://hub.example.com"
    const before = requests.count
    await expect(Agent.enroll({ url: local, code: "ABCD-EFGH", name: "Box" })).rejects.toThrow(
      "the hub announces the plain HTTP URL http://hub.example.com",
    )
    expect(requests.count).toBe(before + 1)
  })

  test("accepts an HTTPS announcement, and plain HTTP when insecure", async () => {
    announced.url = "https://hub.example.com"
    expect((await Agent.enroll({ url: local, code: "ABCD-EFGH", name: "Box" })).url).toBe("https://hub.example.com")
    announced.url = "http://hub.example.com"
    expect((await Agent.enroll({ url: local, code: "ABCD-EFGH", name: "Box", insecure: true })).url).toBe(
      "http://hub.example.com",
    )
  })
})
