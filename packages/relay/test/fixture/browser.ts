import type { Account } from "../../src/account.js"

/** A refused hub request, with its status and JSON body. */
export class Refused extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`hub answered ${status}: ${JSON.stringify(body)}`)
  }
}

/**
 * A browser on the hub's dashboard: same-origin JSON requests, a cookie jar holding the hub session, and `post` in
 * the shape `Account` expects. `headers` lets a test pose as another client address.
 */
export function browser(hub: string, headers: Record<string, string> = {}) {
  const jar = { cookie: "" }

  const request = async (route: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method ?? "GET"
    const response = await fetch(`${hub}/hub/api/${route}`, {
      method,
      headers: {
        ...(method === "GET" ? {} : { origin: hub, "content-type": "application/json" }),
        ...(jar.cookie ? { cookie: jar.cookie } : {}),
        ...headers,
      },
      body: method === "GET" ? undefined : JSON.stringify(init.body ?? {}),
      redirect: "manual",
    })
    const cookie = response.headers.get("set-cookie")
    if (cookie) jar.cookie = cookie.split(";")[0]
    return response
  }

  const post: Account.Post = async <T>(route: string, body: unknown) => {
    const response = await request(route, { method: "POST", body })
    const json: unknown = await response.json().catch(() => undefined)
    if (!response.ok) throw new Refused(response.status, json)
    // SAFETY: each caller names the shape of the route it calls, as the dashboard does.
    return json as T
  }

  return { jar, request, post }
}
