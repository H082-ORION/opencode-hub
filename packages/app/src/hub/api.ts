import { copy } from "./copy"

export type HubMachine = { id: string; name: string; online: boolean; lastSeenAt: number | null; url: string }

export type HubProvider = { id: string; name: string; baseURL: string; auth: "key" | "chatgpt" }

/** A provider from opencode's models.dev catalog. */
export type HubPreset = { id: string; name: string; baseURL: string; doc?: string; env: string[] }

export type EnrollmentCode = { code: string; expiresAt: number; command: string }

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

export const hubApi = {
  session: () => request<{ authenticated: boolean }>("session"),
  login: (password: string, next: string | undefined) =>
    request<{ redirect: string }>("login", { method: "POST", body: { password, next } }),
  logout: () => request<object>("logout", { method: "POST" }),
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
