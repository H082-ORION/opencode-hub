import { Option, Schema } from "effect"
import { json, type Current } from "./accounts.js"
import { Store } from "./store.js"

export * as Orgs from "./orgs.js"

const decodeName = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ name: Schema.String })))
const decodeMember = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ user: Schema.String })))

const NAME_RULE = "An organization name has 1 to 64 characters."

/**
 * Organizations and their members (specs/multi-users.md, "Organisations"). Only hub administrators create, rename and
 * delete them or change their members; an administrator is not a member unless added like anyone else.
 */
export function create(input: {
  store: Store.Instance
  /** Called with the users whose memberships just changed, so their access and machines follow at once. */
  changed: (users: string[]) => void
}) {
  const store = input.store

  return {
    /** Handles `memberships` and `orgs…` under `/hub/api/` for a signed-in user; undefined for any other route. */
    async handle(request: Request, route: string, current: Current) {
      const method = request.method
      if (route === "memberships" && method === "GET")
        return json(
          200,
          store.membershipsOf(current.user.id).map((org) => ({ id: org.id, name: org.name })),
        )
      if (route !== "orgs" && !route.startsWith("orgs/")) return undefined
      if (current.user.role !== "admin") return json(403, { error: "Only hub administrators can do this." })
      if (route === "orgs" && method === "GET") return json(200, list())
      if (route === "orgs" && method === "POST") {
        const name = await readName(request)
        if (!name) return json(400, { error: NAME_RULE })
        const org = store.createOrg(name)
        if (!org) return json(409, { error: "An organization with this name already exists." })
        return json(200, { id: org.id, name: org.name, createdAt: org.created_at })
      }
      const rename = /^orgs\/([^/]+)\/rename$/.exec(route)
      if (rename && method === "POST") {
        const name = await readName(request)
        if (!name) return json(400, { error: NAME_RULE })
        const result = store.renameOrg(decodeURIComponent(rename[1]), name)
        if (result === "unknown") return unknownOrg()
        if (result === "taken") return json(409, { error: "An organization with this name already exists." })
        // Members' dashboards group machines under the organization's name.
        input.changed([])
        return json(200, {})
      }
      const org = /^orgs\/([^/]+)$/.exec(route)
      if (org && method === "DELETE") {
        const result = store.deleteOrg(decodeURIComponent(org[1]))
        if (result === "unknown") return unknownOrg()
        if (result === "has-machines")
          return json(409, { error: "This organization still has machines. Revoke them first." })
        return new Response(null, { status: 204 })
      }
      const members = /^orgs\/([^/]+)\/members$/.exec(route)
      if (members && method === "POST") {
        const body = Option.getOrUndefined(decodeMember(await request.text()))
        if (!body) return json(400, { error: "Expected { user }." })
        const result = store.addMember(decodeURIComponent(members[1]), body.user)
        if (result === "unknown-org") return unknownOrg()
        if (result === "unknown-user") return json(404, { error: "Unknown user." })
        input.changed([body.user])
        return json(200, {})
      }
      const member = /^orgs\/([^/]+)\/members\/([^/]+)$/.exec(route)
      if (member && method === "DELETE") {
        const user = decodeURIComponent(member[2])
        if (!store.removeMember(decodeURIComponent(member[1]), user)) return json(404, { error: "Unknown member." })
        input.changed([user])
        return new Response(null, { status: 204 })
      }
      return json(404, { error: "Not found." })
    },
  }

  function list() {
    const members = Map.groupBy(store.members(), (member) => member.org_id)
    return store.orgs().map((org) => ({
      id: org.id,
      name: org.name,
      createdAt: org.created_at,
      machines: org.machines,
      members: (members.get(org.id) ?? []).map((member) => ({ id: member.user_id, login: member.login })),
    }))
  }
}

export type Instance = ReturnType<typeof create>

async function readName(request: Request) {
  const body = Option.getOrUndefined(decodeName(await request.text()))
  return body ? Store.orgName(body.name) : undefined
}

function unknownOrg() {
  return json(404, { error: "Unknown organization." })
}
