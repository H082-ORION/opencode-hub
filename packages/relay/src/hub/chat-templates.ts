import { Option, Schema } from "effect"
import { json, type Current } from "./accounts.js"
import type { Store } from "./store.js"

export * as ChatTemplates from "./chat-templates.js"

/**
 * Agent templates: a named system prompt the hub's chat hands to a task's agent on a machine, with a default model.
 * Three are built in (plan, build, review); a user's own template of the same name replaces the built-in one. The
 * prompt reaches the machine as a synthetic message before the task's request, so it works on any machine as is.
 */

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_NAME = 48
const MAX_DESCRIPTION = 300
const MAX_SYSTEM = 20_000
const MAX_TEMPLATES = 50
const MODEL_REF = /^[^/\s#]+\/[^\s#]+(#[^\s#]+)?$/
const ROUTE = /^chat-templates(?:\/(tpl_[A-Za-z0-9]+))?$/

export type Template = {
  id: string
  name: string
  description: string
  system: string
  model: string | null
  agent: string | null
  builtin: boolean
}

export const BUILTIN: readonly Template[] = [
  {
    id: "builtin:plan",
    name: "plan",
    description: "Explores the code and writes a precise implementation plan without changing anything.",
    system: `You are a planning agent. Read the code that matters, then write a precise, ordered implementation plan:
the files to change and why, the public surface that moves, the tests to add or adapt, and the risks. Ask the
decisive questions only if the answer changes the plan; otherwise state your assumption. Do not edit files or run
commands that change the project. End with the plan itself, ready to hand to an implementer.`,
    model: null,
    agent: "plan",
    builtin: true,
  },
  {
    id: "builtin:build",
    name: "build",
    description: "Implements a given plan or request end to end, with tests, and reports what changed.",
    system: `You are an implementation agent. Carry out the request or plan you are given completely: change the code,
keep to the project's conventions, add or adapt the tests, run the relevant checks and fix what you broke. Do not
widen the scope. Report what you changed, file by file, what you verified and how, and anything left open.`,
    model: null,
    agent: null,
    builtin: true,
  },
  {
    id: "builtin:review",
    name: "review",
    description: "Reviews a change for correctness, regressions and style, and lists findings with severity.",
    system: `You are a code review agent. Review the change you are pointed at: read the diff and the code around it,
look for bugs, regressions, missing tests, security issues and departures from the project's conventions. Do not
edit files. Report an ordered list of findings, each with its severity, location and a concrete fix, then a verdict:
ready, ready with small fixes, or not ready, with why.`,
    model: null,
    agent: null,
    builtin: true,
  },
]

const Draft = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  system: Schema.String,
  model: Schema.optional(Schema.NullOr(Schema.String)),
  agent: Schema.optional(Schema.NullOr(Schema.String)),
})
const decodeDraft = Schema.decodeUnknownOption(Schema.fromJsonString(Draft))

export function create(input: {
  store: Store.Instance
  /** Whether a model reference names a model the user can use. */
  model: (user: string, reference: string) => Promise<boolean>
}) {
  const store = input.store
  return { list, find, handle }

  /** Every template the user can name: their own, then the built-in ones they have not replaced. */
  function list(user: string): Template[] {
    const own = store.chatTemplates(user).map(view)
    const names = new Set(own.map((template) => template.name))
    return [...own, ...BUILTIN.filter((template) => !names.has(template.name))]
  }

  function find(user: string, name: string) {
    return list(user).find((template) => template.name === name)
  }

  async function handle(request: Request, route: string, current: Current) {
    const match = ROUTE.exec(route)
    if (!match) return undefined
    const user = current.user.id
    const id = match[1]
    if (id === undefined && request.method === "GET") return json(200, { data: list(user) })
    if (id === undefined && request.method === "POST") return save(request, user, `tpl_${randomID()}`)
    if (id === undefined) return json(404, { error: "Not found." })
    const existing = store.chatTemplate(user, id)
    if (!existing) return json(404, { error: "Unknown template." })
    if (request.method === "PUT") return save(request, user, id)
    if (request.method === "DELETE") {
      store.deleteChatTemplate(user, id)
      return new Response(null, { status: 204 })
    }
    return json(404, { error: "Not found." })
  }

  async function save(request: Request, user: string, id: string) {
    const draft = Option.getOrUndefined(decodeDraft(await request.text()))
    if (!draft) return json(400, { error: "Expected { name, description, system, model?, agent? }." })
    const name = draft.name.trim()
    if (!NAME.test(name) || name.length > MAX_NAME)
      return json(400, { error: "A template's name is lowercase words joined by single hyphens." })
    const description = draft.description.trim()
    const system = draft.system.trim()
    if (!description || description.length > MAX_DESCRIPTION)
      return json(400, { error: `A description is needed, of ${MAX_DESCRIPTION} characters at most.` })
    if (!system || system.length > MAX_SYSTEM)
      return json(400, { error: `A system prompt is needed, of ${MAX_SYSTEM} characters at most.` })
    const model = draft.model?.trim() || undefined
    if (model !== undefined && (!MODEL_REF.test(model) || !(await input.model(user, model))))
      return json(400, { error: `No model ${model} is available with the user's providers.` })
    const agent = draft.agent?.trim() || undefined
    if (agent !== undefined && !NAME.test(agent)) return json(400, { error: "An agent name is lowercase words." })
    const own = store.chatTemplates(user)
    if (own.some((template) => template.name === name && template.id !== id))
      return json(409, { error: `A template named ${name} already exists.` })
    if (!own.some((template) => template.id === id) && own.length >= MAX_TEMPLATES)
      return json(429, { error: `At most ${MAX_TEMPLATES} templates.` })
    return json(200, view(store.saveChatTemplate({ id, user, name, description, system, model, agent })))
  }
}

export type Instance = ReturnType<typeof create>

function view(row: Store.ChatTemplate): Template {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    system: row.system,
    model: row.model,
    agent: row.agent,
    builtin: false,
  }
}

/** The template as the task's agent reads it, before the request itself. */
export function instructions(template: Template) {
  return `<agent_template name="${template.name}">\n${template.system}\n</agent_template>`
}

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

function randomID() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => ALPHABET[byte % 62]).join("")
}
