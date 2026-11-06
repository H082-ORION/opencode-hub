import { describe, expect, test } from "bun:test"
import { Protocol } from "../src/protocol.js"

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

  test("decodes http and ws OPEN payloads", () => {
    const http: Protocol.Open = { kind: "http", method: "POST", path: "/a?b=1", headers: [["x", "y"]] }
    expect(Protocol.decodeOpen(payload(http))).toEqual(http)
    const ws: Protocol.Open = { kind: "ws", path: "/ws", headers: [], protocols: ["chat"] }
    expect(Protocol.decodeOpen(payload(ws))).toEqual(ws)
  })

  test("rejects invalid payloads", () => {
    expect(Protocol.decodeOpen(payload({ kind: "ftp", path: "/" }))).toBeUndefined()
    expect(
      Protocol.decodeOpen(payload({ kind: "http", method: "GET", path: "/", headers: [["only-name"]] })),
    ).toBeUndefined()
    expect(Protocol.decodeOpen(new TextEncoder().encode("{not json"))).toBeUndefined()
    expect(Protocol.decodeOpen(new Uint8Array([0xff, 0xfe]))).toBeUndefined()
    expect(Protocol.decodeResponse(payload({ status: "200" }))).toBeUndefined()
    expect(Protocol.decodeClose(payload({ code: 1000 }))).toBeUndefined()
  })

  test("decodes a HELLO from another protocol version so the hub can refuse it", () => {
    const hello = { protocol: 2, version: "9.9.9", name: "box", platform: "linux" }
    expect(Protocol.decodeHello(payload(hello))).toEqual(hello)
  })

  test("decodes READY", () => {
    const ready = {
      machine: { id: "box", name: "Box" },
      llm: { baseURL: "https://hub.example.com/llm", providers: [{ id: "openai", name: "OpenAI" }] },
    }
    expect(Protocol.decodeReady(payload(ready))).toEqual(ready)
  })
})
