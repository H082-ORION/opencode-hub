import { gunzipSync } from "node:zlib"
import { Option, Schema } from "effect"
import { Skills } from "../skills.js"
import type { HubSkills } from "./skills.js"

export * as ChatTools from "./chat-tools.js"

/** Where the chat instances reach these tools, as the MCP server `hub-tools`. */
export const PATH = "/hub/chat-tools"

const MAX_ARCHIVE = 32 * 1024 * 1024
const MAX_UNPACKED = 128 * 1024 * 1024
const DOWNLOAD_TIMEOUT = 60_000
const PROTOCOL = "2025-06-18"

const Request_ = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(Request_))
const decodeCall = Schema.decodeUnknownOption(
  Schema.Struct({
    name: Schema.String,
    arguments: Schema.optional(Schema.Unknown),
    _meta: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
)
const decodeTask = Schema.decodeUnknownOption(
  Schema.Struct({ prompt: Schema.String, images: Schema.optional(Schema.Boolean) }),
)
const decodeName = Schema.decodeUnknownOption(Schema.Struct({ name: Schema.String }))
const decodeNames = Schema.decodeUnknownOption(Schema.Struct({ names: Schema.Array(Schema.String) }))
const decodeSave = Schema.decodeUnknownOption(
  Schema.Struct({
    name: Schema.String,
    files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
    replace: Schema.optional(Schema.Boolean),
  }),
)
const decodeInstall = Schema.decodeUnknownOption(
  Schema.Struct({ url: Schema.String, replace: Schema.optional(Schema.Boolean) }),
)

/** Where the engine names the session calling a tool. */
const SESSION_META = "ai.opencode/sessionID"

const TOOLS = [
  {
    name: "machine_task",
    description:
      "Hand a request to the coding agent on the machine and project attached to this conversation, and wait for its final message. It works in its own session: pass the whole request and any context it needs.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The complete request for the agent on the machine." },
        images: {
          type: "boolean",
          description:
            "Also hand over the images and PDFs attached to the user's last message, when the request is about them.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "skills_list",
    description: "List the user's skills on the hub: their own and those inherited from their organizations.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "skill_read",
    description: "Read the files of one of the user's skills, their own or one inherited from an organization.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The skill's name." } },
      required: ["name"],
    },
  },
  {
    name: "skill_save",
    description: `Create one of the user's skills, or replace it with replace=true. It reaches all of their machines. The files need a ${Skills.ENTRY} at the root, starting with a YAML frontmatter block giving the same name and a description. A name is lowercase words joined by single hyphens.`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
        replace: { type: "boolean", description: "Replace a skill of this name instead of refusing." },
      },
      required: ["name", "files"],
    },
  },
  {
    name: "skill_delete",
    description:
      "Delete some of the user's own skills, which also removes them from all of their machines. Only on the user's explicit request, after listing the skills to confirm the names. Skills of an organization cannot be deleted here.",
    inputSchema: {
      type: "object",
      properties: { names: { type: "array", items: { type: "string" }, description: "The skills' names." } },
      required: ["names"],
    },
  },
  {
    name: "skills_install_github",
    description: `Install the skills of a public GitHub repository among the user's skills: every folder with a ${Skills.ENTRY}, optionally under one path. They reach all of the user's machines.`,
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "https://github.com/<owner>/<repository>, optionally followed by /tree/<branch>/<path>.",
        },
        replace: { type: "boolean", description: "Replace skills that already have these names." },
      },
      required: ["url"],
    },
  },
]

/**
 * The tools of the hub's chat, a minimal MCP server over HTTP: requests are authenticated with the token of a chat
 * instance, and only ever touch that instance's user's own skills.
 */
export function create(input: {
  owner: (token: string) => string | undefined
  skills: HubSkills.Instance
  /** Runs a request on the machine attached to a chat session and resolves to its final message. */
  runTask: (input: {
    user: string
    session: string
    prompt: string
    images?: boolean
    signal: AbortSignal
  }) => Promise<string>
  fetch?: typeof fetch
}) {
  return {
    async handle(request: Request) {
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
      const user = token ? input.owner(token) : undefined
      if (!user) return Response.json({ error: "Invalid instance token." }, { status: 401 })
      const message = Option.getOrUndefined(decodeRequest(await request.text()))
      if (!message) return rpcError(null, -32700, "Invalid JSON-RPC message.")
      if (message.id === undefined) return new Response(null, { status: 202 })
      const id = message.id
      if (message.method === "initialize")
        return rpcResult(id, {
          protocolVersion:
            typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "opencode-hub", version: "1" },
        })
      if (message.method === "ping") return rpcResult(id, {})
      if (message.method === "tools/list") return rpcResult(id, { tools: TOOLS })
      if (message.method !== "tools/call") return rpcError(id, -32601, "Unknown method.")
      const call = Option.getOrUndefined(decodeCall(message.params))
      if (!call) return rpcError(id, -32602, "Expected { name, arguments }.")
      const context = { session: call._meta?.[SESSION_META], signal: request.signal }
      const result = await run(user, call.name, call.arguments, context).catch((error: unknown) =>
        failure(describe(error)),
      )
      return rpcResult(id, result)
    },
  }

  async function run(user: string, name: string, args: unknown, context: { session: unknown; signal: AbortSignal }) {
    if (name === "machine_task") {
      const parsed = Option.getOrUndefined(decodeTask(args))
      if (!parsed) return failure("Expected { prompt, images? }.")
      if (typeof context.session !== "string") return failure("This tool needs a chat session.")
      return text(
        await input.runTask({
          user,
          session: context.session,
          prompt: parsed.prompt,
          images: parsed.images === true,
          signal: context.signal,
        }),
      )
    }
    if (name === "skills_list") return list(user)
    if (name === "skill_read") {
      const parsed = Option.getOrUndefined(decodeName(args))
      if (!parsed) return failure("Expected { name }.")
      const skill = input.skills.find(user, parsed.name)
      return skill ? text(skill.files) : failure(`The user has no skill named ${parsed.name}.`)
    }
    if (name === "skill_delete") {
      const parsed = Option.getOrUndefined(decodeNames(args))
      if (!parsed || parsed.names.length === 0) return failure("Expected { names: [name, ...] }.")
      const results = input.skills.removeOwn(user, parsed.names)
      const report = results.map((result) => {
        if ("deleted" in result) return `Deleted ${result.name}.`
        if ("organization" in result)
          return `${result.name} belongs to the organization ${result.organization}: only a hub administrator can delete it.`
        return `The user has no skill named ${result.name}.`
      })
      return results.some((result) => "deleted" in result) ? text(report.join("\n")) : failure(report.join("\n"))
    }
    if (name === "skill_save") {
      const parsed = Option.getOrUndefined(decodeSave(args))
      if (!parsed) return failure("Expected { name, files: [{ path, content }], replace? }.")
      const saved = input.skills.saveOwn(user, { name: parsed.name, files: parsed.files }, parsed.replace === true)
      return "error" in saved ? failure(saved.error) : text(`Saved the skill ${parsed.name}.`)
    }
    if (name === "skills_install_github") {
      const parsed = Option.getOrUndefined(decodeInstall(args))
      if (!parsed) return failure("Expected { url, replace? }.")
      return install(user, parsed.url, parsed.replace === true)
    }
    return failure(`Unknown tool ${name}.`)
  }

  function list(user: string) {
    const overview = input.skills.overview(user)
    const entry = (skill: { name: string; description: string; hiddenBy: string | null }) => ({
      name: skill.name,
      description: skill.description,
      ...(skill.hiddenBy === null ? {} : { hiddenByOrganization: skill.hiddenBy }),
    })
    return text({
      own: overview.own.map(entry),
      fromOrganizations: overview.inherited.map((skill) => ({ ...entry(skill), organization: skill.org.name })),
    })
  }

  async function install(user: string, url: string, replace: boolean) {
    const repository = parseRepository(url)
    if (!repository) return failure("Expected https://github.com/<owner>/<repository>[/tree/<branch>/<path>].")
    const files = untar(await download(repository, input.fetch ?? fetch))
    const found = findSkills(files, repository.path)
    if (found.length === 0) return failure(`No folder with a ${Skills.ENTRY} found in this repository.`)
    const report = found.map((skill) => {
      if ("error" in skill) return { folder: skill.folder, error: skill.error }
      const saved = input.skills.saveOwn(user, skill, replace)
      return "error" in saved
        ? { folder: skill.folder, name: skill.name, error: saved.error }
        : { folder: skill.folder, name: skill.name, installed: true, skippedFiles: skill.skipped }
    })
    return text(report)
  }
}

export type Instance = ReturnType<typeof create>

function text(value: unknown) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] }
}

function failure(message: string) {
  return { content: [{ type: "text", text: message }], isError: true }
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function rpcResult(id: string | number, result: unknown) {
  return Response.json({ jsonrpc: "2.0", id, result })
}

function rpcError(id: string | number | null, code: number, message: string) {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } })
}

type Repository = { owner: string; name: string; ref: string; path: string }

/** Only github.com URLs of a repository, so the tool cannot be pointed at anything else the hub can reach. */
export function parseRepository(input: string): Repository | undefined {
  const url = URL.canParse(input) ? new URL(input) : undefined
  if (!url || url.protocol !== "https:" || url.hostname !== "github.com") return undefined
  const match =
    /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/tree\/([A-Za-z0-9_.-]+)((?:\/[^/]+)*))?\/?$/.exec(
      url.pathname,
    )
  if (!match) return undefined
  const path = (match[4] ?? "").replace(/^\//, "")
  if (path.split("/").some((segment) => segment === ".." || segment === ".")) return undefined
  return { owner: match[1]!, name: match[2]!, ref: match[3] ?? "HEAD", path }
}

async function download(repository: Repository, fetcher: typeof fetch) {
  const response = await fetcher(
    `https://codeload.github.com/${repository.owner}/${repository.name}/tar.gz/${repository.ref}`,
    { redirect: "error", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) },
  )
  if (!response.ok || !response.body)
    throw new Error(`GitHub answered ${response.status}: check that the repository is public and the branch exists.`)
  const chunks: Uint8Array[] = []
  const received = { bytes: 0 }
  for await (const chunk of response.body) {
    received.bytes += chunk.byteLength
    if (received.bytes > MAX_ARCHIVE)
      throw new Error(`The repository's archive is over ${MAX_ARCHIVE / 1024 / 1024} MiB.`)
    chunks.push(chunk)
  }
  return gunzipSync(Buffer.concat(chunks), { maxOutputLength: MAX_UNPACKED })
}

/** The regular files of a tar archive by path, without GitHub's leading `<repository>-<commit>/` folder. */
function untar(archive: Buffer) {
  const files = new Map<string, Buffer>()
  const longName = { value: undefined as string | undefined }
  const cursor = { offset: 0 }
  while (cursor.offset + 512 <= archive.length && archive[cursor.offset] !== 0) {
    const header = archive.subarray(cursor.offset, cursor.offset + 512)
    const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8)
    const type = String.fromCharCode(header[156]!)
    const body = archive.subarray(cursor.offset + 512, cursor.offset + 512 + size)
    cursor.offset += 512 + Math.ceil(size / 512) * 512
    if (type === "x") longName.value = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(`\n${body.toString("utf8")}`)?.[1]
    if (type !== "0" && type !== "\0") continue
    const prefix = field(header, 345, 155)
    const full = longName.value ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100))
    longName.value = undefined
    const relative = full.slice(full.indexOf("/") + 1)
    if (relative) files.set(relative, body)
  }
  return files
}

function field(header: Buffer, start: number, length: number) {
  const end = header.indexOf(0, start)
  return header.subarray(start, end === -1 || end > start + length ? start + length : end).toString("utf8")
}

/**
 * The skills of a repository: each folder under `root` with a `SKILL.md`. Files that a skill cannot hold (binary, or
 * with an unsafe path such as a hidden file) are left out and counted; a nested skill's files stay with that skill.
 */
function findSkills(files: ReadonlyMap<string, Buffer>, root: string) {
  const inside = (file: string) => !root || file === root || file.startsWith(`${root}/`)
  const entries = Array.from(files.keys()).filter(
    (file) => inside(file) && (file === Skills.ENTRY || file.endsWith(`/${Skills.ENTRY}`)),
  )
  const folders = entries.map((entry) => entry.slice(0, -Skills.ENTRY.length).replace(/\/$/, ""))
  return folders.map((folder) => {
    const prefix = folder ? `${folder}/` : ""
    const nested = folders.filter((other) => other !== folder && (folder === "" || other.startsWith(prefix)))
    const own = Array.from(files).flatMap(([file, body]) => {
      if (!file.startsWith(prefix) || nested.some((other) => file.startsWith(`${other}/`))) return []
      return [{ path: file.slice(prefix.length), body }]
    })
    const usable = own.flatMap((file) => {
      const content = file.body.toString("utf8")
      if (!Skills.isSafePath(file.path) || content.includes("\0") || content.includes("�")) return []
      return [{ path: file.path, content }]
    })
    const name = Skills.frontmatter(usable.find((file) => file.path === Skills.ENTRY)?.content ?? "")?.name
    if (!name) return { folder: folder || "/", error: `${Skills.ENTRY} has no name in its frontmatter.` }
    return { folder: folder || "/", name, files: usable, skipped: own.length - usable.length }
  })
}
