import { toHeaders, withoutDecodedHeaders, withoutHopByHop } from "../headers.js"
import { Connectors } from "./connectors.js"
import { Egress } from "./egress.js"
import { NO_ACCESS } from "./llm.js"
import { McpOAuth } from "./mcp-oauth.js"
import { Providers } from "./providers.js"
import type { Store } from "./store.js"

export * as Mcp from "./mcp.js"

// Headers about the instance's connection to the hub, or its hub credential: never sent to the MCP server.
const DROPPED_REQUEST = new Set([
  "host",
  "cookie",
  "origin",
  "referer",
  "authorization",
  "content-length",
  "accept-encoding",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
])

export type Deps = {
  store: Store.Instance
  connectors: Connectors.Instance
  oauth: McpOAuth.Instance
  egress: Egress.Instance
  /** Whether a user may still open a machine: the account is active, and owns it or belongs to its organization. */
  allowed: (user: string, machine: Store.Machine) => boolean
  /** The hub's public origin, to point a same-server redirect back at the relay. */
  origin: string
}

/**
 * Forwards `/mcp/<connector>/<rest>` to that connector **of the instance's user**: the instance token, in
 * `Authorization: Bearer`, names one user's instance on one machine. The token is removed; the connector's headers
 * (opened with the user's key in memory, else 423), or its OAuth access token, are added. Bodies are sent whole (MCP
 * messages are small) and answers stream back as they come, SSE included; the MCP session headers pass both ways.
 */
export async function proxy(request: Request, url: URL, deps: Deps) {
  const match = /^\/mcp\/([^/]+)(\/.*)?$/.exec(url.pathname)
  if (!match) return json(404, "Unknown connector.")
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
  const instance = token ? deps.store.instanceByToken(token) : undefined
  if (!instance) return json(401, "Invalid instance token.")
  const machine = deps.store.machine(instance.machine_id)
  if (!machine) return json(401, "Invalid instance token.")
  // Checked on every call, besides the instance being deleted when access ends: fail closed.
  if (!deps.allowed(instance.user_id, machine)) return json(403, NO_ACCESS)
  const user = instance.user_id
  // Ids are plain lowercase words and dashes, so the segment is never percent-encoded.
  const id = match[1]
  const opened = Connectors.ID.test(id) ? await deps.connectors.open(user, id) : { kind: "unknown" as const }
  if (opened.kind === "unknown") return json(404, "Unknown connector.")
  if (opened.kind === "locked") return json(423, Providers.LOCKED)
  if (opened.kind === "unreadable") return json(500, "This connector's saved secrets are unreadable: save it again.")
  const connector = opened.connector

  const base = new URL(connector.url)
  // Resolving the rest against a placeholder normalizes dot segments, so a request cannot climb above the base path.
  const rest = match[2] === undefined ? "" : new URL(match[2].slice(1), "http://placeholder/").pathname
  const target = new URL(base)
  target.pathname = rest ? `${base.pathname.replace(/\/+$/, "")}${rest}` : base.pathname
  new URLSearchParams(url.search).forEach((value, name) => target.searchParams.append(name, value))
  const headers = toHeaders(
    withoutHopByHop(request.headers).filter((entry) => !DROPPED_REQUEST.has(entry[0].toLowerCase())),
  )
  connector.headers.forEach((entry) => headers.set(entry[0], entry[1]))
  const body =
    request.method === "GET" || request.method === "HEAD" ? undefined : new Uint8Array(await request.arrayBuffer())

  const send = async (force: boolean) => {
    if (connector.auth === "oauth") {
      const access = await deps.oauth.accessToken(user, connector, opened.key, force).then(
        (value) => value,
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      )
      // Not connected yet, or the sign-in expired: only the user can fix it, from the dashboard.
      if (access instanceof Error) return json(409, access.message)
      headers.set("authorization", `Bearer ${access}`)
    }
    return deps.egress
      .fetch(target, { method: request.method, headers, body, signal: request.signal })
      .catch((error: unknown) =>
        error instanceof Egress.RefusedError
          ? json(502, `The connector's address is refused: ${error.message}`)
          : json(502, `The MCP server could not be reached: ${error instanceof Error ? error.message : String(error)}`),
      )
  }
  const first = await send(false)
  // A refused access token is refreshed once, then the request is sent again (the body is in memory).
  const retry = first.status === 401 && connector.auth === "oauth" && connector.oauth?.tokens?.refresh !== undefined
  if (retry) await first.body?.cancel()
  const response = retry ? await send(true) : first
  if (response.status >= 300 && response.status < 400 && response.headers.has("location"))
    return redirected(response, base, connector.id, deps.origin)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: toHeaders(
      withoutDecodedHeaders(response.headers).filter((entry) => entry[0].toLowerCase() !== "set-cookie"),
    ),
  })
}

/**
 * Redirects are not followed. One that stays under the connector's URL is pointed back at the relay, so the instance
 * follows it through the hub; any other (another host, or elsewhere on the server) is answered 502.
 */
async function redirected(response: Response, base: URL, id: string, origin: string) {
  await response.body?.cancel()
  const location = URL.parse(response.headers.get("location") ?? "", base.href)
  const prefix = base.pathname.replace(/\/+$/, "")
  const inside =
    location !== null &&
    location.origin === base.origin &&
    (location.pathname === prefix || location.pathname.startsWith(`${prefix}/`))
  if (!location || !inside) return json(502, "The MCP server redirected elsewhere; the hub does not follow redirects.")
  const relayed = new URL(`/mcp/${encodeURIComponent(id)}${location.pathname.slice(prefix.length)}`, origin)
  relayed.search = location.search
  return new Response(null, { status: response.status, headers: { location: relayed.toString() } })
}

function json(status: number, error: string) {
  return Response.json({ error }, { status })
}
