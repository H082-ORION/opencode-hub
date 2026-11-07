import { describe, expect, test } from "bun:test"
import { Protocol } from "../src/protocol.js"

const IID = "AbCdEfGhIjKlMnOpQrStUv"

describe("frame codec", () => {
  test("round trips every frame type with its stream id and payload", () => {
    Object.values(Protocol.Type).forEach((type, index) => {
      const payload = new Uint8Array([index, 0, 255, 7])
      const frame = Protocol.decode(Protocol.encode(type, 0xffffffff - index, payload))
      expect(frame?.type).toBe(type)
      expect(frame?.stream).toBe(0xffffffff - index)
      expect(Array.from(frame?.payload ?? [])).toEqual(Array.from(payload))
    })
  })

  test("uses a 5 byte big-endian header", () => {
    const bytes = Protocol.encode(Protocol.Type.DATA, 0x01020304, new Uint8Array([9]))
    expect(Array.from(bytes)).toEqual([0x02, 0x01, 0x02, 0x03, 0x04, 9])
  })

  test("decodes frames from an ArrayBuffer and from a view with an offset", () => {
    const bytes = Protocol.encode(Protocol.Type.END, 3)
    expect(Protocol.decode(bytes.buffer)).toMatchObject({ type: Protocol.Type.END, stream: 3 })
    const padded = new Uint8Array(bytes.byteLength + 2)
    padded.set(bytes, 2)
    expect(Protocol.decode(padded.subarray(2))).toMatchObject({ type: Protocol.Type.END, stream: 3 })
  })

  test("rejects malformed frames", () => {
    expect(Protocol.decode(new Uint8Array([0x01, 0, 0, 0]))).toBeUndefined()
    expect(Protocol.decode(new Uint8Array(0))).toBeUndefined()
    expect(Protocol.decode(new Uint8Array([0x7f, 0, 0, 0, 1]))).toBeUndefined()
    expect(Protocol.decode(new Uint8Array([0x00, 0, 0, 0, 1]))).toBeUndefined()
    expect(Protocol.decode("not binary")).toBeUndefined()
  })

  test("refuses stream ids outside u32", () => {
    expect(() => Protocol.encode(Protocol.Type.DATA, -1)).toThrow()
    expect(() => Protocol.encode(Protocol.Type.DATA, 2 ** 32)).toThrow()
    expect(() => Protocol.encode(Protocol.Type.DATA, 1.5)).toThrow()
  })
})

describe("JSON payloads", () => {
  const payload = (value: unknown) => Protocol.encodeJson(Protocol.Type.OPEN, 1, value).subarray(5)

  test("decodes http and ws OPEN payloads with their instance", () => {
    const http: Protocol.Open = {
      kind: "http",
      instance: IID,
      method: "POST",
      path: "/a?b=1",
      headers: [["x", "y"]],
    }
    expect(Protocol.decodeOpen(payload(http))).toEqual(http)
    const ws: Protocol.Open = { kind: "ws", instance: IID, path: "/ws", headers: [], protocols: ["chat"] }
    expect(Protocol.decodeOpen(payload(ws))).toEqual(ws)
  })

  test("rejects invalid payloads", () => {
    expect(Protocol.decodeOpen(payload({ kind: "ftp", path: "/" }))).toBeUndefined()
    expect(
      Protocol.decodeOpen(payload({ kind: "http", instance: IID, method: "GET", path: "/", headers: [["only-name"]] })),
    ).toBeUndefined()
    // Protocol 1 OPEN frames had no instance.
    expect(Protocol.decodeOpen(payload({ kind: "http", method: "GET", path: "/", headers: [] }))).toBeUndefined()
    expect(Protocol.decodeOpen(new TextEncoder().encode("{not json"))).toBeUndefined()
    expect(Protocol.decodeOpen(new Uint8Array([0xff, 0xfe]))).toBeUndefined()
    expect(Protocol.decodeResponse(payload({ status: "200" }))).toBeUndefined()
    expect(Protocol.decodeClose(payload({ code: 1000 }))).toBeUndefined()
  })

  test("refuses instance ids that could name another directory", () => {
    ;["../../etc", "a/b", "short", ".".repeat(20), "x".repeat(65), ""].forEach((iid) => {
      expect(Protocol.decodeDrop(payload({ iid }))).toBeUndefined()
      expect(
        Protocol.decodeOpen(payload({ kind: "ws", instance: iid, path: "/", headers: [], protocols: [] })),
      ).toBeUndefined()
    })
  })

  test("decodes a HELLO from another protocol version so the hub can refuse it", () => {
    const hello = { protocol: 1, version: "9.9.9", name: "box", platform: "linux" }
    expect(Protocol.decodeHello(payload(hello))).toEqual(hello)
  })

  test("speaks protocol 2: HELLO announces the instance tokens the agent holds", () => {
    expect(Protocol.VERSION).toBe(2)
    const hello = { protocol: 2, version: "1", name: "box", platform: "linux", instances: [{ iid: IID, hash: "ab" }] }
    expect(Protocol.decodeHello(payload(hello))).toEqual(hello)
  })

  test("decodes READY with the owner kind and the instances that still exist", () => {
    const ready: Protocol.Ready = { machine: { id: "box", name: "Box" }, owner: "org", instances: [IID] }
    expect(Protocol.decodeReady(payload(ready))).toEqual(ready)
    expect(Protocol.decodeReady(payload({ ...ready, owner: "team" }))).toBeUndefined()
    // The protocol 1 READY carried an llm block and no owner.
    expect(
      Protocol.decodeReady(payload({ machine: ready.machine, llm: { baseURL: "https://hub/llm", providers: [] } })),
    ).toBeUndefined()
  })

  test("encodes and decodes INSTANCE, SKILLS and DROP", () => {
    const instance = {
      iid: IID,
      token: "secret",
      llm: { baseURL: "https://hub.example.com/llm", providers: [{ id: "openai", name: "OpenAI" }] },
      mcp: [],
      skills: { version: "v" },
    }
    const frame = (type: Protocol.Type, value: unknown) => Protocol.decode(Protocol.encodeJson(type, 0, value))!
    const decoded = frame(Protocol.Type.INSTANCE, instance)
    expect(Array.from(Protocol.encode(Protocol.Type.INSTANCE, 0).subarray(0, 1))).toEqual([0x15])
    expect(decoded.type).toBe(Protocol.Type.INSTANCE)
    expect(Protocol.decodeInstance(decoded.payload)).toEqual(instance)
    // Without a token, the agent keeps the one it holds.
    const { token: _token, ...refresh } = instance
    expect(Protocol.decodeInstance(frame(Protocol.Type.INSTANCE, refresh).payload)).toEqual(refresh)

    const skills = { iid: IID, version: "v", skills: [{ name: "x", files: [{ path: "SKILL.md", content: "# x" }] }] }
    const skillsFrame = frame(Protocol.Type.SKILLS, skills)
    expect(Array.from(Protocol.encode(Protocol.Type.SKILLS, 0).subarray(0, 1))).toEqual([0x16])
    expect(Protocol.decodeSkills(skillsFrame.payload)).toEqual(skills)

    const drop = frame(Protocol.Type.DROP, { iid: IID })
    expect(Array.from(Protocol.encode(Protocol.Type.DROP, 0).subarray(0, 1))).toEqual([0x17])
    expect(Protocol.decodeDrop(drop.payload)).toEqual({ iid: IID })
  })

  test("CONFIG (0x12) is gone", () => {
    expect(Protocol.decode(new Uint8Array([0x12, 0, 0, 0, 0]))).toBeUndefined()
  })
})
