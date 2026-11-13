import { gunzipSync } from "node:zlib"
import { Option, Schema } from "effect"
import { Skills } from "../skills.js"
import { Refusal, type ChatTasks } from "./chat-tasks.js"
import type { ChatTemplates } from "./chat-templates.js"
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
const WaitSeconds = Schema.optional(Schema.Number)
const decodeTask = Schema.decodeUnknownOption(
  Schema.Struct({
    prompt: Schema.String,
    images: Schema.optional(Schema.Boolean),
    machine: Schema.optional(Schema.String),
    directory: Schema.optional(Schema.String),
    agent: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
    variant: Schema.optional(Schema.String),
    template: Schema.optional(Schema.String),
    continue: Schema.optional(Schema.String),
    wait_seconds: WaitSeconds,
  }),
)
const decodeWait = Schema.decodeUnknownOption(
  Schema.Struct({
    tasks: Schema.Array(Schema.String),
    mode: Schema.optional(Schema.Literals(["any", "all"])),
    seconds: Schema.optional(Schema.Number),
  }),
)
const decodeScope = Schema.decodeUnknownOption(
  Schema.Struct({ scope: Schema.optional(Schema.Literals(["session", "all"])) }),
)
const decodeTaskRef = Schema.decodeUnknownOption(Schema.Struct({ task: Schema.String, wait_seconds: WaitSeconds }))
const decodeRead = Schema.decodeUnknownOption(
  Schema.Struct({ task: Schema.String, limit: Schema.optional(Schema.Number) }),
)
const decodeSend = Schema.decodeUnknownOption(
  Schema.Struct({
    task: Schema.String,
    text: Schema.String,
    delivery: Schema.optional(Schema.Literals(["steer", "queue"])),
    model: Schema.optional(Schema.String),
    variant: Schema.optional(Schema.String),
  }),
)
const decodeReply = Schema.decodeUnknownOption(
  Schema.Struct({
    task: Schema.String,
    request: Schema.String,
    decision: Schema.Literals(["once", "always", "reject"]),
    session: Schema.optional(Schema.String),
  }),
)
const decodeAnswer = Schema.decodeUnknownOption(
  Schema.Struct({
    task: Schema.String,
    question: Schema.String,
    answer: Schema.optional(
      Schema.Record(
        Schema.String,
        Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Array(Schema.String)]),
      ),
    ),
    session: Schema.optional(Schema.String),
  }),
)
const decodeImage = Schema.decodeUnknownOption(
  Schema.Struct({ task: Schema.String, index: Schema.optional(Schema.Number) }),
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

const TASK = { type: "string", description: "The task's id, as machine_task or machine_tasks_list gave it." }
const MODEL = {
  type: "string",
  description:
    "The model the task's agent runs, as provider/model from models_list (optionally provider/model#variant). The conversation's own model otherwise.",
}
const VARIANT = {
  type: "string",
  description: "The model's variant (effort level), one of those models_list gives it.",
}
const WAIT = {
  type: "number",
  description:
    "Seconds to wait for the task's execution to end before answering, 0 to 600. Leave it out to answer at once.",
}

const TOOLS = [
  {
    name: "machine_task",
    description:
      "Delegate a request to a sub-agent: the coding agent on one of the user's machines. It starts a task in its own session there and answers at once with the task's handle; the task runs in the background, and you are told when it ends (or use machine_tasks_wait). By default it works on the machine and project attached to this conversation, with this conversation's model; choose another with model (see models_list) and a role with template (see templates_list). The sub-agent sees nothing of this conversation: pass the whole request and any context it needs. Start several tasks to work in parallel, on other folders or machines.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The complete request for the agent on the machine." },
        model: MODEL,
        variant: VARIANT,
        template: {
          type: "string",
          description:
            "An agent template by name (plan, build, review, or one of the user's): its instructions reach the sub-agent before the request, and its default model applies unless model is given.",
        },
        images: {
          type: "boolean",
          description:
            "Also hand over the images and PDFs attached to the user's last message, when the request is about them.",
        },
        machine: { type: "string", description: "Another machine of the user, by name or id (see machines_list)." },
        directory: { type: "string", description: "The absolute folder to work in; needed on another machine." },
        agent: {
          type: "string",
          description:
            "The opencode agent to run on the machine, such as build or plan; the machine's default otherwise.",
        },
        continue: {
          type: "string",
          description: "An earlier task's id, to send this prompt to the same session instead of starting a new one.",
        },
        wait_seconds: WAIT,
      },
      required: ["prompt"],
    },
  },
  {
    name: "machine_tasks_wait",
    description:
      "Wait for tasks of this conversation to end: the first of them with mode any (the default), every one with mode all, for at most seconds (0 to 600, 120 by default). Answers each task's status, with the final message of those that ended. Use it to chain work: wait, read the results, then start the next tasks.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: { type: "array", items: TASK, description: "The tasks to wait for." },
        mode: { type: "string", enum: ["any", "all"] },
        seconds: { type: "number" },
      },
      required: ["tasks"],
    },
  },
  {
    name: "models_list",
    description:
      "List the models the user can run, on the hub and on their machines alike: provider/model, whether it reads images (vision) and uses tools, its variants, context size and price when known. Use it to pick a model for a sub-agent.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "templates_list",
    description:
      "List the agent templates: the built-in plan, build and review, and the user's own. Each is a role (a system prompt) a sub-agent can take, with a default model.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "machine_tasks_list",
    description:
      "List the tasks handed to machines, from this conversation (default) or from all of the user's conversations.",
    inputSchema: {
      type: "object",
      properties: { scope: { type: "string", enum: ["session", "all"] } },
    },
  },
  {
    name: "machine_task_status",
    description:
      "Where a task of this conversation stands: its status, its tokens and cost, and the permissions and questions it waits on. Check it before telling the user a task is done.",
    inputSchema: { type: "object", properties: { task: TASK, wait_seconds: WAIT }, required: ["task"] },
  },
  {
    name: "machine_task_read",
    description: "Read a task's latest messages: what its agent said, the tools it ran and their outcomes.",
    inputSchema: {
      type: "object",
      properties: { task: TASK, limit: { type: "number", description: "How many messages, 1 to 100; 20 by default." } },
      required: ["task"],
    },
  },
  {
    name: "machine_task_send",
    description:
      "Send a message to a task's agent: steer it while it works (delivery steer, the default while it runs), or queue a follow-up for when it is done (queue). A task that ended starts again.",
    inputSchema: {
      type: "object",
      properties: {
        task: TASK,
        text: { type: "string" },
        delivery: { type: "string", enum: ["steer", "queue"] },
        model: {
          ...MODEL,
          description: "Switch the task's session to this model first (provider/model from models_list).",
        },
        variant: VARIANT,
      },
      required: ["task", "text"],
    },
  },
  {
    name: "machine_task_stop",
    description: "Stop a task's current execution. Its session stays, and machine_task_send starts it again.",
    inputSchema: { type: "object", properties: { task: TASK }, required: ["task"] },
  },
  {
    name: "machines_list",
    description:
      "List the user's machines, with whether each is connected to the hub, and the machine and folder attached to this conversation.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "machine_task_permissions",
    description: "List the permission requests and questions a task's agent waits on.",
    inputSchema: { type: "object", properties: { task: TASK }, required: ["task"] },
  },
  {
    name: "machine_task_reply_permission",
    description:
      "Answer a permission request of a task's agent. Only when the user asked you to pilot that task or to answer its requests; otherwise tell the user it waits for them.",
    inputSchema: {
      type: "object",
      properties: {
        task: TASK,
        request: { type: "string", description: "The request's id, from machine_task_permissions." },
        decision: { type: "string", enum: ["once", "always", "reject"] },
        session: { type: "string", description: "The session the request belongs to, when it is a subagent's." },
      },
      required: ["task", "request", "decision"],
    },
  },
  {
    name: "machine_task_answer",
    description:
      "Answer a question of a task's agent, or dismiss it by leaving out answer. Only when the user asked you to pilot that task or to answer its questions.",
    inputSchema: {
      type: "object",
      properties: {
        task: TASK,
        question: { type: "string", description: "The question's id, from machine_task_permissions." },
        answer: {
          type: "object",
          description: "The answer, by field key: a string, or for a multiple choice an array of the chosen values.",
        },
        session: { type: "string", description: "The session the question belongs to, when it is a subagent's." },
      },
      required: ["task", "question"],
    },
  },
  {
    name: "machine_task_images",
    description: "List the images a task's tools produced, such as screenshots, newest first.",
    inputSchema: { type: "object", properties: { task: TASK }, required: ["task"] },
  },
  {
    name: "machine_task_image",
    description:
      "Look at one of a task's images, by its index in machine_task_images (0, the newest, by default). Only a model that reads images sees it; otherwise you get its description.",
    inputSchema: {
      type: "object",
      properties: { task: TASK, index: { type: "number" } },
      required: ["task"],
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
  tasks: ChatTasks.Instance
  templates: ChatTemplates.Instance
  /** The machines a user may open, with the machine and folder attached to a chat session. */
  machines: (user: string, session: string) => unknown
  /** Whether a chat session's model reads images. */
  vision: (user: string, session: string) => Promise<boolean>
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
      // A task outlives the call that started it: closing the call never stops it.
      const context = { session: call._meta?.[SESSION_META] }
      const result = await run(user, call.name, call.arguments, context).catch((error: unknown) =>
        failure(describe(error)),
      )
      return rpcResult(id, result)
    },
  }

  async function run(user: string, name: string, args: unknown, context: { session: unknown }) {
    if (name === "models_list") return text(await input.tasks.models(user))
    if (name === "templates_list")
      return text(
        input.templates.list(user).map((template) => ({
          name: template.name,
          description: template.description,
          ...(template.model ? { model: template.model } : {}),
          ...(template.agent ? { agent: template.agent } : {}),
          builtin: template.builtin,
        })),
      )
    if (name.startsWith("machine")) {
      if (typeof context.session !== "string") return failure("This tool needs a chat session.")
      return machine(user, context.session, name, args).catch((error: unknown) => failure(describe(error)))
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

  async function machine(user: string, session: string, name: string, args: unknown) {
    const tasks = input.tasks
    if (name === "machine_task") {
      const parsed = Option.getOrUndefined(decodeTask(args))
      if (!parsed)
        return failure(
          "Expected { prompt, model?, variant?, template?, images?, machine?, directory?, agent?, continue?, wait_seconds? }.",
        )
      const task = await tasks.start({
        user,
        session,
        prompt: parsed.prompt,
        images: parsed.images === true,
        machine: parsed.machine,
        directory: parsed.directory,
        agent: parsed.agent,
        model: parsed.model,
        variant: parsed.variant,
        template: parsed.template,
        continue: parsed.continue,
        by: "model",
      })
      const state = await tasks.status(task, parsed.wait_seconds ?? 0)
      return text({
        task: task.id,
        remoteSession: task.remote_session,
        machine: state.machineName,
        directory: task.directory,
        ...(task.model ? { model: task.model } : {}),
        ...(task.template ? { template: task.template } : {}),
        status: state.status,
        ...("result" in state
          ? { result: state.result }
          : {
              note: "The task runs in the background. You will be told when it ends; to block on it, use machine_tasks_wait.",
            }),
      })
    }
    if (name === "machine_tasks_wait") {
      const parsed = Option.getOrUndefined(decodeWait(args))
      if (!parsed || parsed.tasks.length === 0) return failure("Expected { tasks: [id, ...], mode?, seconds? }.")
      const found = parsed.tasks.map((id) => tasks.find(user, session, id))
      const missing = parsed.tasks.filter((_, index) => !found[index])
      if (missing.length > 0) return failure(`This conversation has no task ${missing.join(", ")}.`)
      return text(
        await tasks.wait(
          found.filter((task) => task !== undefined),
          parsed.mode ?? "any",
          parsed.seconds ?? 120,
        ),
      )
    }

    if (name === "machine_tasks_list") {
      const parsed = Option.getOrUndefined(decodeScope(args ?? {}))
      return text(
        tasks.list(user, parsed?.scope === "all" ? undefined : session).map((task) => ({
          task: task.id,
          title: task.title,
          kind: task.kind,
          machine: task.machineName,
          directory: task.directory,
          ...(task.model ? { model: task.model } : {}),
          ...(task.template ? { template: task.template } : {}),
          status: task.status,
          ...(task.session === session ? {} : { otherConversation: true }),
          cost: task.cost,
        })),
      )
    }
    if (name === "machines_list") return text(input.machines(user, session))
    if (name === "machine_task_reply_permission") {
      const parsed = Option.getOrUndefined(decodeReply(args))
      if (!parsed) return failure("Expected { task, request, decision, session? }.")
      const task = tasks.find(user, session, parsed.task)
      if (!task) return failure(`This conversation has no task ${parsed.task}.`)
      return done(
        await tasks.replyPermission(task, parsed.request, parsed.decision, parsed.session, "model"),
        "Answered.",
      )
    }
    if (name === "machine_task_answer") {
      const parsed = Option.getOrUndefined(decodeAnswer(args))
      if (!parsed) return failure("Expected { task, question, answer?, session? }.")
      const task = tasks.find(user, session, parsed.task)
      if (!task) return failure(`This conversation has no task ${parsed.task}.`)
      return done(
        await tasks.answer(task, parsed.question, parsed.answer, parsed.session, "model"),
        parsed.answer ? "Answered." : "Dismissed.",
      )
    }
    if (name === "machine_task_read") {
      const parsed = Option.getOrUndefined(decodeRead(args))
      if (!parsed) return failure("Expected { task, limit? }.")
      const task = tasks.find(user, session, parsed.task)
      if (!task) return failure(`This conversation has no task ${parsed.task}.`)
      return text(await tasks.read(task, parsed.limit))
    }
    if (name === "machine_task_send") {
      const parsed = Option.getOrUndefined(decodeSend(args))
      if (!parsed || !parsed.text.trim()) return failure("Expected { task, text, delivery?, model?, variant? }.")
      const task = tasks.find(user, session, parsed.task)
      if (!task) return failure(`This conversation has no task ${parsed.task}.`)
      const model =
        parsed.model === undefined ? undefined : await tasks.resolveModel(user, parsed.model, parsed.variant)
      return done(await tasks.send(task, parsed.text, parsed.delivery, "model", model), "Sent.")
    }
    if (name === "machine_task_image") {
      const parsed = Option.getOrUndefined(decodeImage(args))
      if (!parsed) return failure("Expected { task, index? }.")
      const task = tasks.find(user, session, parsed.task)
      if (!task) return failure(`This conversation has no task ${parsed.task}.`)
      const found = await tasks.image(task, parsed.index ?? 0)
      if (found instanceof Refusal) return failure(found.message)
      const described = `Image ${parsed.index ?? 0} of task ${task.id}: ${found.name} (${found.mime}, ${found.bytes.byteLength} bytes).`
      // Only a model that reads images gets the bytes; the others would choke on them.
      if (!(await input.vision(user, session)))
        return text(
          `${described} This conversation's model does not read images: describe it to the user from the task's messages, or ask them to look at it in the task's panel.`,
        )
      return {
        content: [
          { type: "text", text: described },
          { type: "image", data: Buffer.from(found.bytes).toString("base64"), mimeType: found.mime },
        ],
      }
    }
    const parsed = Option.getOrUndefined(decodeTaskRef(args))
    if (!parsed) return failure("Expected { task }.")
    const task = tasks.find(user, session, parsed.task)
    if (!task) return failure(`This conversation has no task ${parsed.task}.`)
    if (name === "machine_task_status") return text(await tasks.status(task, parsed.wait_seconds ?? 0))
    if (name === "machine_task_stop") return done(await tasks.stop(task, "model"), "Stopping.")
    if (name === "machine_task_permissions") return text(await tasks.pending(task))
    if (name === "machine_task_images")
      return text(
        (await tasks.images(task)).map((image, index) => ({
          index,
          name: image.name,
          mime: image.mime,
          tool: image.tool,
        })),
      )
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

function done(refused: Refusal | undefined, message: string) {
  return refused ? failure(refused.message) : text(message)
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
