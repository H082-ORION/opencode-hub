import { Option, Schema } from "effect"

export * as Protocol from "./protocol.js"

export const VERSION = 2

export const Type = {
  OPEN: 0x01,
  DATA: 0x02,
  END: 0x03,
  RESPONSE: 0x04,
  RESET: 0x05,
  TEXT: 0x06,
  CLOSE: 0x07,
  HELLO: 0x10,
  READY: 0x11,
  // 0x12 was CONFIG in protocol 1; INSTANCE replaces it.
  PING: 0x13,
  PONG: 0x14,
  INSTANCE: 0x15,
  SKILLS: 0x16,
  DROP: 0x17,
} as const

export type Type = (typeof Type)[keyof typeof Type]

export type Frame = {
  type: Type
  stream: number
  payload: Uint8Array
}

const HEADER_SIZE = 5
const MAX_STREAM = 0xffffffff
const types = new Set<number>(Object.values(Type))

export const Header = Schema.Tuple([Schema.String, Schema.String])

/**
 * An instance id: random base64url from the hub. The agent names a directory after it, so anything else (dots,
 * slashes) is refused at decoding.
 */
export const InstanceID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{16,64}$/))

export const OpenHttp = Schema.Struct({
  kind: Schema.Literal("http"),
  /** The instance the stream goes to: the opening user's, on this machine. */
  instance: InstanceID,
  method: Schema.String,
  path: Schema.String,
  headers: Schema.Array(Header),
})
export type OpenHttp = typeof OpenHttp.Type

export const OpenWs = Schema.Struct({
  kind: Schema.Literal("ws"),
  instance: InstanceID,
  path: Schema.String,
  headers: Schema.Array(Header),
  protocols: Schema.Array(Schema.String),
})
export type OpenWs = typeof OpenWs.Type

export const Open = Schema.Union([OpenHttp, OpenWs])
export type Open = typeof Open.Type

export const Response = Schema.Struct({
  status: Schema.Int,
  headers: Schema.optional(Schema.Array(Header)),
  protocol: Schema.optional(Schema.String),
})
export type Response = typeof Response.Type

export const Reset = Schema.Struct({ message: Schema.optional(Schema.String) })
export type Reset = typeof Reset.Type

export const Close = Schema.Struct({ code: Schema.Int, reason: Schema.String })
export type Close = typeof Close.Type

// `protocol` is a plain number so a HELLO from a newer agent still decodes and can be refused with a clear reason.
export const Hello = Schema.Struct({
  protocol: Schema.Number,
  version: Schema.String,
  name: Schema.String,
  platform: Schema.String,
  /**
   * The instances whose token the agent still holds, each with the SHA-256 (hex) of that token, so the hub only sends
   * a new token when the agent lacks the current one. `skills` is the version of the skills it last wrote for that
   * instance, so the hub only sends SKILLS again when they changed.
   */
  instances: Schema.optional(
    Schema.Array(Schema.Struct({ iid: InstanceID, hash: Schema.String, skills: Schema.optional(Schema.String) })),
  ),
})
export type Hello = typeof Hello.Type

export const Provider = Schema.Struct({ id: Schema.String, name: Schema.String })
export type Provider = typeof Provider.Type

export const LlmConfig = Schema.Struct({
  baseURL: Schema.String,
  providers: Schema.Array(Provider),
})
export type LlmConfig = typeof LlmConfig.Type

export const Ready = Schema.Struct({
  machine: Schema.Struct({ id: Schema.String, name: Schema.String }),
  owner: Schema.Literals(["user", "org"]),
  /** Every instance this machine still has: the agent deletes the others (dropped while it was offline). */
  instances: Schema.Array(InstanceID),
})
export type Ready = typeof Ready.Type

export const Connector = Schema.Struct({ id: Schema.String, name: Schema.String })

/**
 * One user's instance on this machine and its configuration. `token` (the instance's LLM token) is only present when
 * the hub issued a new one; without it the agent keeps the token it holds.
 */
export const Instance = Schema.Struct({
  iid: InstanceID,
  token: Schema.optional(Schema.String),
  llm: LlmConfig,
  mcp: Schema.Array(Connector),
  skills: Schema.Struct({ version: Schema.String }),
})
export type Instance = typeof Instance.Type

export const SkillFile = Schema.Struct({ path: Schema.String, content: Schema.String })

/**
 * The effective skills of an instance's user, all of them: the agent replaces the instance's `hub-*` skill folders
 * with these. The agent checks names and paths again before writing (see `Skills`).
 */
export const Skills = Schema.Struct({
  iid: InstanceID,
  version: Schema.String,
  skills: Schema.Array(Schema.Struct({ name: Schema.String, files: Schema.Array(SkillFile) })),
})
export type Skills = typeof Skills.Type

export const Drop = Schema.Struct({ iid: InstanceID })
export type Drop = typeof Drop.Type

export function encode(type: Type, stream: number, payload: Uint8Array = new Uint8Array(0)) {
  if (!Number.isInteger(stream) || stream < 0 || stream > MAX_STREAM)
    throw new RangeError(`invalid stream id ${stream}`)
  const frame = new Uint8Array(HEADER_SIZE + payload.byteLength)
  const view = new DataView(frame.buffer)
  view.setUint8(0, type)
  view.setUint32(1, stream)
  frame.set(payload, HEADER_SIZE)
  return frame
}

export function encodeJson(type: Type, stream: number, value: unknown) {
  return encode(type, stream, new TextEncoder().encode(JSON.stringify(value)))
}

export function encodeText(type: Type, stream: number, text: string) {
  return encode(type, stream, new TextEncoder().encode(text))
}

/** Returns undefined for a message that is not a well-formed frame. */
export function decode(message: ArrayBuffer | ArrayBufferView | string): Frame | undefined {
  if (typeof message === "string") return undefined
  const bytes = ArrayBuffer.isView(message)
    ? new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
    : new Uint8Array(message)
  if (bytes.byteLength < HEADER_SIZE) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const type = view.getUint8(0)
  if (!types.has(type)) return undefined
  return { type: type as Type, stream: view.getUint32(1), payload: bytes.subarray(HEADER_SIZE) }
}

export const decodeOpen = jsonDecoder(Open)
export const decodeResponse = jsonDecoder(Response)
export const decodeReset = jsonDecoder(Reset)
export const decodeClose = jsonDecoder(Close)
export const decodeHello = jsonDecoder(Hello)
export const decodeReady = jsonDecoder(Ready)
export const decodeInstance = jsonDecoder(Instance)
export const decodeSkills = jsonDecoder(Skills)
export const decodeDrop = jsonDecoder(Drop)

/** Builds a decoder for a JSON payload; it returns undefined when the payload does not match the schema. */
function jsonDecoder<S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) {
  const decode = Schema.decodeUnknownOption(Schema.fromJsonString(schema))
  return (payload: Uint8Array): S["Type"] | undefined =>
    Option.getOrUndefined(decode(new TextDecoder().decode(payload)))
}

export function text(payload: Uint8Array) {
  return new TextDecoder().decode(payload)
}

/** Close codes an endpoint may send itself; reserved ones such as 1005 and 1006 become a normal closure. */
export function closeCode(code: number) {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000
}
