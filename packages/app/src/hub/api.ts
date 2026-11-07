import { copy } from "./copy"

export type HubMachine = {
  id: string
  name: string
  /** The organization that owns the machine; null for one of the user's own. */
  org: { id: string; name: string } | null
  online: boolean
  lastSeenAt: number | null
  url: string
  /** Whether this user may revoke it: their own, an organization machine they enrolled, or any for administrators. */
  canRevoke: boolean
}

/**
 * A machine as administrators list it: with its owner's login, or its organization's name in `org` (both null before
 * it has an owner), and no link to open it.
 */
export type HubAdminMachine = {
  id: string
  name: string
  owner: string | null
  org: string | null
  online: boolean
  lastSeenAt: number | null
}

/** An organization the user belongs to. */
export type HubMembership = { id: string; name: string }

/** An organization as administrators manage it. */
export type HubOrg = {
  id: string
  name: string
  createdAt: number
  machines: number
  members: { id: string; login: string }[]
}

export type HubProvider = { id: string; name: string; baseURL: string; auth: "key" | "chatgpt" }

/**
 * A remote MCP server the user's machines reach through the hub, as `server` (`hub-<id>`) in their configuration.
 * `headers` names the injected headers (their values are never sent back); `connected` says whether an OAuth
 * connector has its tokens, and is null for a headers one.
 */
export type HubConnector = {
  id: string
  name: string
  url: string
  auth: "headers" | "oauth"
  headers: string[]
  connected: boolean | null
  server: string
}

export type ConnectorDraft =
  | { name: string; url: string; auth: "headers"; headers: { name: string; value: string }[] }
  | { name: string; url: string; auth: "oauth"; clientID?: string; clientSecret?: string }

/** A provider from opencode's models.dev catalog. */
export type HubPreset = { id: string; name: string; baseURL: string; doc?: string; env: string[] }

export type HubSkillFile = { path: string; content: string }

/** A skill as the hub stores it: `SKILL.md` and any other text files. */
export type HubSkill = {
  id: string
  name: string
  description: string
  files: HubSkillFile[]
  createdAt: number
  updatedAt: number
}

/**
 * The user's skills and those inherited from their organizations. `hiddenBy` names the organization whose skill of
 * the same name wins over this one; null when this one reaches the machines.
 */
export type HubSkills = {
  own: (HubSkill & { hiddenBy: string | null })[]
  inherited: (HubSkill & { org: { id: string; name: string }; hiddenBy: string | null })[]
  version: string
}

export type SkillDraft = { name: string; files: HubSkillFile[] }

export type EnrollmentCode = { code: string; expiresAt: number; command: string }

export type HubRole = "admin" | "user"

export type HubSession = {
  authenticated: true
  user: { id: string; login: string; role: HubRole }
  /** Whether the hub holds this user's key in memory. */
  unlocked: boolean
}

export type HubUser = {
  id: string
  login: string
  role: HubRole
  createdAt: number
  disabled: boolean
  /** Reset by an administrator, waiting for its reset invitation to be used. */
  pending: boolean
  unlocked: boolean
  /** Has machines that rely on providers it saved, while its key is locked: they get 423 until it signs in. */
  waiting: boolean
  self: boolean
}

export type HubInvitation = {
  id: string
  role: HubRole
  createdAt: number
  expiresAt: number
  createdBy: string | null
  /** The login a reset invitation re-registers. */
  reset: string | null
  /** The names of the organizations the new account joins. */
  orgs: string[]
}

/** A newly issued invitation; its link is shown once. */
export type IssuedInvitation = { id: string; url: string; expiresAt: number }

/** A failed hub request; `status` is 0 when the hub could not be reached, 423 when the user's keys are locked. */
export class HubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** Calls `/hub/api/<route>`. Mutations send JSON, which the hub requires together with a same-origin `Origin`. */
export async function request<T>(route: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET"

  const response = await fetch(`/hub/api/${route}`, {
    method,
    headers: method === "GET" ? undefined : { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(init.body ?? {}),
    credentials: "same-origin",
    cache: "no-store",
  }).catch(() => new HubError(copy.error.unreachable, 0))

  if (response instanceof HubError) throw response

  // SAFETY: the routes typed `void` are the ones that answer 204.
  if (response.status === 204) return undefined as T
  const body: unknown = await response.json().catch(() => undefined)

  // SAFETY: the hub is served with this page from the same build, so each route's JSON has the shape `hubApi` names.
  if (response.ok) return body as T

  const message =
    body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : copy.error.status(response.status)

  throw new HubError(message, response.status)
}

/** The account flows of `@opencode/relay/account` send their requests through this. */
export const post = <T>(route: string, body: unknown) => request<T>(route, { method: "POST", body })

export const hubApi = {
  session: () => request<HubSession>("session"),
  logout: () => request<object>("logout", { method: "POST" }),
  lock: () => request<{ unlocked: false }>("account/lock", { method: "POST" }),
  invitationFor: (invite: string) => post<{ role: HubRole; login: string | null }>("register/invite", { invite }),
  users: () => request<HubUser[]>("users"),
  invitations: () => request<HubInvitation[]>("invitations"),
  invite: (body: { role: HubRole; days: number; orgs: string[] }) => post<IssuedInvitation>("invitations", body),
  revokeInvitation: (id: string) => request<void>(`invitations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  disable: (id: string) => post<object>(`users/${encodeURIComponent(id)}/disable`, {}),
  enable: (id: string) => post<object>(`users/${encodeURIComponent(id)}/enable`, {}),
  setRole: (id: string, role: HubRole) => post<object>(`users/${encodeURIComponent(id)}/role`, { role }),
  reset: (id: string) => post<IssuedInvitation>(`users/${encodeURIComponent(id)}/reset`, {}),
  machines: () => request<HubMachine[]>("machines"),
  allMachines: () => request<HubAdminMachine[]>("admin/machines"),
  /** A code for a machine of the user's own, or of the organization `org` they belong to. */
  createCode: (org?: string) => post<EnrollmentCode>("machines/code", org ? { org } : {}),
  memberships: () => request<HubMembership[]>("memberships"),
  orgs: () => request<HubOrg[]>("orgs"),
  createOrg: (name: string) => post<{ id: string; name: string }>("orgs", { name }),
  renameOrg: (id: string, name: string) => post<object>(`orgs/${encodeURIComponent(id)}/rename`, { name }),
  deleteOrg: (id: string) => request<void>(`orgs/${encodeURIComponent(id)}`, { method: "DELETE" }),
  addMember: (org: string, user: string) => post<object>(`orgs/${encodeURIComponent(org)}/members`, { user }),
  removeMember: (org: string, user: string) =>
    request<void>(`orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(user)}`, { method: "DELETE" }),
  revoke: (id: string) => request<void>(`machines/${encodeURIComponent(id)}`, { method: "DELETE" }),
  skills: () => request<HubSkills>("skills"),
  saveSkill: (body: SkillDraft, id?: string) =>
    post<{ skill: HubSkill }>(id ? `skills/${encodeURIComponent(id)}` : "skills", body),
  deleteSkill: (id: string) => request<void>(`skills/${encodeURIComponent(id)}`, { method: "DELETE" }),
  orgSkills: (org: string) => request<HubSkill[]>(`orgs/${encodeURIComponent(org)}/skills`),
  saveOrgSkill: (org: string, body: SkillDraft, id?: string) =>
    post<{ skill: HubSkill }>(`orgs/${encodeURIComponent(org)}/skills${id ? `/${encodeURIComponent(id)}` : ""}`, body),
  deleteOrgSkill: (org: string, id: string) =>
    request<void>(`orgs/${encodeURIComponent(org)}/skills/${encodeURIComponent(id)}`, { method: "DELETE" }),
  providers: () => request<HubProvider[]>("providers"),
  presets: () => request<HubPreset[]>("presets"),
  saveProvider: (body: { id: string; name?: string; baseURL?: string; apiKey: string }) =>
    request<{ provider: HubProvider }>("providers", { method: "POST", body }),
  deleteProvider: (id: string) => request<void>(`providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  connectors: () => request<HubConnector[]>("connectors"),
  saveConnector: (body: ConnectorDraft) => post<{ connector: HubConnector }>("connectors", body),
  deleteConnector: (id: string) => request<void>(`connectors/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** Starts the OAuth sign-in of a connector; the browser goes to `url` and comes back to the dashboard. */
  connectorSignIn: (id: string) => post<{ url: string }>(`connectors/${encodeURIComponent(id)}/oauth/begin`, {}),
  chatgptBegin: () => request<{ attempt: string; url: string }>("providers/chatgpt/begin", { method: "POST" }),
  chatgptComplete: (attempt: string, callback: string) =>
    request<{ provider?: HubProvider }>("providers/chatgpt/complete", { method: "POST", body: { attempt, callback } }),
}

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : copy.error.unknown
}
