import type { FormAnswer } from "@opencode/client/promise"
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

export type HubCloudLimits = { cpu: number; memory_mib: number; disk_gib: number }

export type HubCloudStatus =
  | "creating"
  | "starting"
  | "stopping"
  | "deleting"
  | "running"
  | "stopped"
  | "failed"
  | "missing"

/** A cloud instance: a VM on a cloud server, which becomes one of the user's machines (`machine`) once paired. */
export type HubCloudInstance = {
  id: string
  name: string
  host: { id: string; name: string }
  status: HubCloudStatus
  error: string | null
  limits: HubCloudLimits
  machine: string | null
  /** The handoff link that opens its machine; null until the VM paired. */
  url: string | null
  createdAt: number
  metrics: {
    cpuPercent: number | null
    memoryUsedBytes: number
    memoryTotalBytes: number
    diskUsedBytes: number
    networkRxBytes: number
    networkTxBytes: number
  } | null
}

/** A cloud server as users see it: the most one new instance may get there, null while it is offline. */
export type HubCloudHost = {
  id: string
  name: string
  online: boolean
  max: (HubCloudLimits & { full: boolean }) | null
}

export type HubCloudResource = { total: number; reserved: number; allocated: number; available: number }

/** A cloud server as administrators see it, with what its agent last reported. */
export type HubCloudAdminHost = {
  id: string
  name: string
  online: boolean
  lastSeenAt: number | null
  version: string | null
  lxdVersion: string | null
  capacity: {
    cpu: HubCloudResource
    memory_mib: HubCloudResource
    disk_gib: HubCloudResource
    instances: { count: number; max: number }
    per_instance_max: HubCloudLimits
  } | null
  metrics: {
    cpu_threads: number
    load: number[]
    memory_total_bytes: number
    memory_used_bytes: number
    disk_total_bytes: number
    disk_used_bytes: number
  } | null
  instances: number
}

/** `GET cloud` and the `cloud` event: `admin` is null for users who do not administer the hub. */
export type HubCloud = {
  hosts: HubCloudHost[]
  instances: HubCloudInstance[]
  admin: { hosts: HubCloudAdminHost[]; instances: (HubCloudInstance & { owner: string | null })[] } | null
}

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

/** A release of OpenCode Hub on GitHub; `notes` is its markdown body and `url` its GitHub page. */
export type HubRelease = {
  version: string
  tag: string
  prerelease: boolean
  publishedAt: string
  notes: string
  url: string
}

/**
 * What administrators see of the hub's own updates: `stable` and `dev` are the newest releases newer than `current`
 * (`dev` only when also newer than `stable`), and `status` is the installer's progress.
 */
export type HubUpdates = {
  current: string
  /** The hub runs a local build rather than a release. */
  development: boolean
  checkedAt: number | null
  error: string | null
  stable: HubRelease | null
  dev: HubRelease | null
  releases: HubRelease[]
  installer: { available: boolean }
  status: { state: "idle" | "pending" | "running" | "done" | "failed"; version?: string; message?: string; at?: number }
}

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

/** The machine and project a chat session sends its tasks to. */
export type HubChatTarget = { machine: string; machineName: string; directory: string; online: boolean }
export type HubChatProject = { id: string; name: string; directory: string }
export type HubChatDirectories = { directory: string; parent: string | null; directories: string[] }
/** A chat session's machine and project. */
export type HubChatTargetState = { target: HubChatTarget | null }
export type HubMachineCommand = { name: string; description?: string }

export type HubTaskStatus = "starting" | "running" | "waiting" | "idle" | "failed" | "interrupted" | "offline" | "lost"
/** What a task runs: an agent prompt, a slash command or one shell command. */
export type HubTaskKind = "prompt" | "command" | "shell"
/** A task the hub's chat handed to a machine, as `GET chat-tasks` and its `hub.task.updated` events describe it. */
export type HubTask = {
  id: string
  session: string
  machine: string
  machineName: string
  machineOnline: boolean
  directory: string
  remoteSession: string | null
  title: string
  agent: string | null
  kind: HubTaskKind
  /** `provider/model`, with `#variant` when one is chosen; null for the machine's default. */
  model: string | null
  template: string | null
  /** How many images the task's tools had produced when its last execution ended. */
  images: number
  status: HubTaskStatus
  createdAt: number
  startedAt: number | null
  endedAt: number | null
  outcome: string | null
  error: string | null
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  cost: number
  pending: { permissions: number; questions: number }
}

/** A chat model as the hub lists it for sub-agents. */
export type HubChatModel = {
  id: string
  providerID: string
  name: string
  capabilities: { tools?: boolean; input: string[] }
  variants?: { id: string }[]
}

/** An agent template: a role a sub-agent takes, as a system prompt with a default model. Built-in ones are read-only. */
export type HubTemplate = {
  id: string
  name: string
  description: string
  system: string
  model: string | null
  agent: string | null
  builtin: boolean
}
export type TemplateDraft = {
  name: string
  description: string
  system: string
  model: string | null
  agent: string | null
}

const machineRoute = (machine: string, route: string, query: Record<string, string>) =>
  `chat-machines/${encodeURIComponent(machine)}/${route}?${new URLSearchParams(query)}`

export const hubApi = {
  chatProjects: (machine: string) => request<HubChatProject[]>(`chat-machines/${encodeURIComponent(machine)}/projects`),
  chatDirectories: (machine: string, path?: string) =>
    request<HubChatDirectories>(
      `chat-machines/${encodeURIComponent(machine)}/directories${path === undefined ? "" : `?path=${encodeURIComponent(path)}`}`,
    ),
  createChatDirectory: (machine: string, parent: string, name: string) =>
    request<{ directory: string }>(`chat-machines/${encodeURIComponent(machine)}/directories`, {
      method: "POST",
      body: { parent, name },
    }),
  chatTarget: (session: string) => request<HubChatTargetState>(`chat-targets/${encodeURIComponent(session)}`),
  machineCommands: (machine: string, directory: string) =>
    request<{ data: HubMachineCommand[] }>(machineRoute(machine, "commands", { directory })).then(
      (response) => response.data,
    ),
  machineFiles: (machine: string, directory: string, query: string) =>
    request<{ data: string[] }>(machineRoute(machine, "files", { directory, query })).then((response) => response.data),
  /** Starts a task on the attached machine: a slash command or a shell line from the composer. */
  startTask: (
    session: string,
    body: { kind: "command"; command: { name: string; arguments: string } } | { kind: "shell"; shell: string },
  ) => request<HubTask>("chat-tasks", { method: "POST", body: { session, ...body } }),
  /** The models the user can run, on the hub and on their machines. */
  chatModels: () => request<{ data: HubChatModel[] }>("chat-models").then((response) => response.data),
  templates: () => request<{ data: HubTemplate[] }>("chat-templates").then((response) => response.data),
  saveTemplate: (body: TemplateDraft, id?: string) =>
    request<HubTemplate>(id ? `chat-templates/${encodeURIComponent(id)}` : "chat-templates", {
      method: id ? "PUT" : "POST",
      body,
    }),
  deleteTemplate: (id: string) => request<void>(`chat-templates/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setChatTarget: (session: string, target: Pick<HubChatTarget, "machine" | "directory">) =>
    request<object>(`chat-targets/${encodeURIComponent(session)}`, {
      method: "PUT",
      body: { machine: target.machine, directory: target.directory },
    }),
  clearChatTarget: (session: string) =>
    request<void>(`chat-targets/${encodeURIComponent(session)}`, { method: "DELETE" }),
  tasks: (session?: string) =>
    request<{ data: HubTask[] }>(
      session === undefined ? "chat-tasks" : `chat-tasks?${new URLSearchParams({ session })}`,
    ).then((response) => response.data),
  stopTask: (task: string) => request<void>(`chat-tasks/${encodeURIComponent(task)}/run`, { method: "DELETE" }),
  backgroundTask: (task: string) =>
    request<void>(`chat-tasks/${encodeURIComponent(task)}/background`, { method: "POST" }),
  promptTask: (task: string, text: string, delivery: "steer" | "queue") =>
    request<void>(`chat-tasks/${encodeURIComponent(task)}/prompt`, { method: "POST", body: { text, delivery } }),
  replyTaskPermission: (task: string, permission: string, decision: "once" | "always" | "reject", session: string) =>
    request<void>(`chat-tasks/${encodeURIComponent(task)}/permission/${encodeURIComponent(permission)}`, {
      method: "POST",
      body: { decision, session },
    }),
  answerTask: (task: string, form: string, answer: FormAnswer, session: string) =>
    request<void>(`chat-tasks/${encodeURIComponent(task)}/form/${encodeURIComponent(form)}`, {
      method: "POST",
      body: { answer, session },
    }),
  dismissTask: (task: string, form: string, session: string) =>
    request<void>(`chat-tasks/${encodeURIComponent(task)}/form/${encodeURIComponent(form)}`, {
      method: "DELETE",
      body: { session },
    }),
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
  createCloudInstance: (body: HubCloudLimits & { host: string; name: string }) =>
    post<{ instance: HubCloudInstance }>("cloud/instances", body),
  startCloudInstance: (id: string) => post<object>(`cloud/instances/${encodeURIComponent(id)}/start`, {}),
  stopCloudInstance: (id: string) => post<object>(`cloud/instances/${encodeURIComponent(id)}/stop`, {}),
  deleteCloudInstance: (id: string) => request<void>(`cloud/instances/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** A one-time code an administrator gives `agent-hub-lxd join` on a new cloud server. */
  createHostCode: () => post<EnrollmentCode>("cloud/hosts/code", {}),
  revokeCloudHost: (id: string) => request<void>(`cloud/hosts/${encodeURIComponent(id)}`, { method: "DELETE" }),
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
  updates: () => request<HubUpdates>("updates"),
  checkUpdates: () => post<HubUpdates>("updates/check", {}),
  installUpdate: (version: string) => post<HubUpdates>("updates/install", { version }),
  chatgptBegin: () => request<{ attempt: string; url: string }>("providers/chatgpt/begin", { method: "POST" }),
  chatgptComplete: (attempt: string, callback: string) =>
    request<{ provider?: HubProvider }>("providers/chatgpt/complete", { method: "POST", body: { attempt, callback } }),
}

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : copy.error.unknown
}
