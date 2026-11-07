import { copy } from "./copy"

export type HubMachine = { id: string; name: string; online: boolean; lastSeenAt: number | null; url: string }

export type HubProvider = { id: string; name: string; baseURL: string; auth: "key" | "chatgpt" }

/** A provider from opencode's models.dev catalog. */
export type HubPreset = { id: string; name: string; baseURL: string; doc?: string; env: string[] }

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
}

/** A newly issued invitation; its link is shown once. */
export type IssuedInvitation = { id: string; url: string; expiresAt: number }

/** A failed hub request; `status` is 0 when the hub could not be reached. */
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
  invite: (body: { role: HubRole; days: number }) => post<IssuedInvitation>("invitations", body),
  revokeInvitation: (id: string) => request<void>(`invitations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  disable: (id: string) => post<object>(`users/${encodeURIComponent(id)}/disable`, {}),
  enable: (id: string) => post<object>(`users/${encodeURIComponent(id)}/enable`, {}),
  setRole: (id: string, role: HubRole) => post<object>(`users/${encodeURIComponent(id)}/role`, { role }),
  reset: (id: string) => post<IssuedInvitation>(`users/${encodeURIComponent(id)}/reset`, {}),
  machines: () => request<HubMachine[]>("machines"),
  createCode: () => request<EnrollmentCode>("machines/code", { method: "POST" }),
  revoke: (id: string) => request<void>(`machines/${encodeURIComponent(id)}`, { method: "DELETE" }),
  providers: () => request<HubProvider[]>("providers"),
  presets: () => request<HubPreset[]>("presets"),
  saveProvider: (body: { id: string; name?: string; baseURL?: string; apiKey: string }) =>
    request<{ provider: HubProvider }>("providers", { method: "POST", body }),
  deleteProvider: (id: string) => request<void>(`providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  chatgptBegin: () => request<{ attempt: string; url: string }>("providers/chatgpt/begin", { method: "POST" }),
  chatgptComplete: (attempt: string, callback: string) =>
    request<{ provider?: HubProvider }>("providers/chatgpt/complete", { method: "POST", body: { attempt, callback } }),
}

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : copy.error.unknown
}
