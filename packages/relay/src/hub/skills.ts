import { Option, Schema } from "effect"
import { Skills } from "../skills.js"
import { json, type Current } from "./accounts.js"
import type { Store } from "./store.js"

export * as HubSkills from "./skills.js"

const File = Schema.Struct({ path: Schema.String, content: Schema.String })
const decodeSkill = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String, files: Schema.Array(File) })),
)
const decodeFiles = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(File)))

/** A skill an instance receives, with where it comes from. */
export type Effective = Skills.Skill & { org: { id: string; name: string } | null }

/**
 * Skills of users and organizations (specs/multi-users.md, "Skills"). A user manages their own; only hub
 * administrators manage an organization's, which its members see read-only among the skills they inherit.
 */
export function create(input: {
  store: Store.Instance
  /** Called after any change that may change some users' effective skills. */
  changed: () => void
}) {
  const store = input.store

  return {
    effective,

    /** Handles `skills…` and `orgs/<id>/skills…` under `/hub/api/`; undefined for any other route. */
    async handle(request: Request, route: string, current: Current) {
      const method = request.method
      const user = current.user
      if (route === "skills" && method === "GET") return json(200, overview(user.id))
      const own = { kind: "user" as const, id: user.id }
      if (route === "skills" && method === "POST") return save(request, own)
      const mine = /^skills\/([^/]+)$/.exec(route)
      if (mine && method === "POST") return save(request, own, decodeURIComponent(mine[1]))
      if (mine && method === "DELETE") return remove(own, decodeURIComponent(mine[1]))
      const org = /^orgs\/([^/]+)\/skills(?:\/([^/]+))?$/.exec(route)
      if (!org) return undefined
      // Members read their organizations' skills through `GET skills`; managing them is for administrators only.
      if (user.role !== "admin") return json(403, { error: "Only hub administrators can do this." })
      const id = decodeURIComponent(org[1])
      if (!store.org(id)) return json(404, { error: "Unknown organization." })
      const owner = { kind: "org" as const, id }
      const skill = org[2] === undefined ? undefined : decodeURIComponent(org[2])
      if (skill === undefined && method === "GET") return json(200, store.skills(owner).flatMap(present))
      if (skill === undefined && method === "POST") return save(request, owner)
      if (skill !== undefined && method === "POST") return save(request, owner, skill)
      if (skill !== undefined && method === "DELETE") return remove(owner, skill)
      return json(404, { error: "Not found." })
    },
  }

  /**
   * A user's effective skills: their own and those of every organization they belong to. On a name used twice, an
   * organization's skill wins over the user's own, and between organizations the first by name wins; the losers are
   * listed in `hidden`.
   */
  function effective(user: string) {
    const chosen = new Map<string, Effective & { id: string }>()
    const hidden: { id: string; name: string; org: { id: string; name: string } | null; by: string }[] = []
    store.membershipsOf(user).forEach((org) =>
      store.skills({ kind: "org", id: org.id }).forEach((row) => {
        const files = filesOf(row)
        if (!files) return
        const winner = chosen.get(row.name)
        if (winner) return hidden.push({ id: row.id, name: row.name, org, by: winner.org?.name ?? "" })
        chosen.set(row.name, { id: row.id, name: row.name, files, org: { id: org.id, name: org.name } })
      }),
    )
    store.skills({ kind: "user", id: user }).forEach((row) => {
      const files = filesOf(row)
      if (!files) return
      const winner = chosen.get(row.name)
      if (winner) return hidden.push({ id: row.id, name: row.name, org: null, by: winner.org?.name ?? "" })
      chosen.set(row.name, { id: row.id, name: row.name, files, org: null })
    })
    const skills = Skills.canonicalize(Array.from(chosen.values()))
    return { skills, hidden }
  }

  /** What the dashboard shows: the user's skills, then the inherited ones, each marked when another one hides it. */
  function overview(user: string) {
    const result = effective(user)
    const hiddenBy = new Map(result.hidden.map((entry) => [entry.id, entry.by]))
    return {
      own: store
        .skills({ kind: "user", id: user })
        .flatMap((row) => present(row).map((skill) => ({ ...skill, hiddenBy: hiddenBy.get(row.id) ?? null }))),
      inherited: store.membershipsOf(user).flatMap((org) =>
        store.skills({ kind: "org", id: org.id }).flatMap((row) =>
          present(row).map((skill) => ({
            ...skill,
            org: { id: org.id, name: org.name },
            hiddenBy: hiddenBy.get(row.id) ?? null,
          })),
        ),
      ),
      version: Skills.version(result.skills),
    }
  }

  async function save(request: Request, owner: Store.SkillOwner, id?: string) {
    const body = Option.getOrUndefined(decodeSkill(await request.text()))
    if (!body) return json(400, { error: "Expected { name, files: [{ path, content }] }." })
    const skill = { name: body.name.trim(), files: body.files }
    const checked = Skills.check(skill)
    if ("error" in checked) return json(400, { error: checked.error })
    const saved = store.saveSkill({
      owner,
      id,
      name: skill.name,
      description: checked.description,
      files: Skills.canonicalize([skill])[0]!.files,
      limit: Skills.MAX_PER_OWNER,
    })
    if (saved.status !== "ok") return refused(saved.status)
    input.changed()
    const row = store.skill(saved.id)
    return json(200, { skill: row ? present(row)[0] : undefined })
  }

  function remove(owner: Store.SkillOwner, id: string) {
    if (!store.deleteSkill(owner, id)) return json(404, { error: "Unknown skill." })
    input.changed()
    return new Response(null, { status: 204 })
  }
}

export type Instance = ReturnType<typeof create>

/** A stored skill as the dashboard shows it; a row whose files do not decode is left out (fail closed). */
function present(row: Store.SkillRow) {
  const files = filesOf(row)
  if (!files) return []
  return [
    {
      id: row.id,
      name: row.name,
      description: row.description,
      files,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  ]
}

function refused(status: "taken" | "limit" | "unknown") {
  if (status === "unknown") return json(404, { error: "Unknown skill." })
  if (status === "taken") return json(409, { error: "A skill with this name already exists." })
  return json(409, { error: `At most ${Skills.MAX_PER_OWNER} skills per owner.` })
}

function filesOf(row: Store.SkillRow) {
  return Option.getOrUndefined(decodeFiles(row.files))
}
