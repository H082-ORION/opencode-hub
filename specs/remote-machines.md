# Remote machines (hub + agents)

One public opencode **hub** (a VPS) gives a single user, behind a password, access to N **machines** that sit behind
NAT. Each machine runs its own full local opencode server and keeps an outbound WebSocket tunnel open to the hub. The
hub reverse-proxies the machine's whole web UI and API through that tunnel. The hub also proxies LLM traffic so provider
keys never leave the hub.

Core, Protocol and Server are not modified. Everything lives in `packages/relay` (`@opencode/relay`) plus CLI commands.

## Topology

```
browser ──https──> Caddy ──http──> opencode hub (127.0.0.1:4800)
                                     │  hub.example.com          dashboard, login, enrollment, LLM proxy
                                     │  <machine>.hub.example.com  reverse proxy to that machine
                                     ▼
                              WebSocket tunnel (outbound from the machine)
                                     ▼
            machine: opencode agent ──http/ws──> local opencode background service (127.0.0.1:<port>)
```

- Machines are addressed by **subdomain**, `<machine-id>.<domain>`. The web UI is then served by the machine's own
  server at `/`, so UI and API versions always match and the app needs no path-prefix support.
- Locally, `domain` is `localhost:<port>` and machines are `<machine-id>.localhost:<port>` (browsers resolve
  `*.localhost` to loopback). No TLS locally; Caddy terminates TLS in production.
- Caddy uses on-demand TLS for `*.<domain>` and asks the hub `GET /hub/tls-allowed?domain=<host>` before issuing.

## Identities

| Who | Credential | Where it is checked |
|---|---|---|
| The user (browser) | hub password -> `opencode_hub` session cookie (host-only, HttpOnly, SameSite=Lax, Secure when the hub URL is https) | hub, on the hub host and on every machine host |
| A machine's tunnel | `tunnel token`, issued at enrollment, sent as `Authorization: Bearer` on the WebSocket upgrade | hub `/hub/agent/connect` |
| A machine's LLM calls | `llm token`, issued at enrollment, used as the provider API key on the machine | hub `/llm/<provider>/...` |
| The hub reaching the local server | the local service password (Basic `opencode:<password>`) | injected by the **agent**, never known to the hub |

Tokens are 32 random bytes base64url, stored hashed (sha256) in the hub DB. Revoking a machine deletes both hashes and
closes its tunnel.

Cookie handoff to machine hosts (cookies are host-only, so no `Domain=` attribute is needed and `localhost` works):

1. Unauthenticated request on `<m>.<domain>` -> 302 to `<hub-origin>/login?next=<full url>`.
2. After login (or when already logged in), `GET <hub-origin>/hub/handoff?next=<full url>` validates that `next` is the
   hub or a machine host, creates a one-time ticket (60 s), and 302s to `<m-origin>/__hub/session?ticket=..&next=<path>`.
3. The machine host consumes the ticket, sets its own `opencode_hub` cookie and 302s to `next`.

## Tunnel protocol (WebSocket, binary messages)

Every WebSocket message is one frame: `[type: u8][stream: u32 big-endian][payload]`. JSON payloads are UTF-8 JSON.
Stream 0 is the control stream. Streams are opened only by the hub; ids are allocated by the hub, increasing.

| Type | Name | Direction | Payload |
|---|---|---|---|
| 0x01 | OPEN | hub -> agent | JSON `{ kind: "http", method, path, headers: [k, v][] }` or `{ kind: "ws", path, headers, protocols: string[] }` (`path` includes the query string) |
| 0x02 | DATA | both | raw bytes: request body chunk, response body chunk, or binary WebSocket message |
| 0x03 | END | both | empty: the sender will send no more DATA on this stream (half close) |
| 0x04 | RESPONSE | agent -> hub | JSON `{ status, headers: [k, v][] }` for http; for ws, `{ status: 101, protocol? }` on success or a non-101 status on failure |
| 0x05 | RESET | both | JSON `{ message? }`: abort the stream, both sides forget it |
| 0x06 | TEXT | both | UTF-8 text WebSocket message |
| 0x07 | CLOSE | both | JSON `{ code, reason }`: WebSocket closed |
| 0x10 | HELLO | agent -> hub (stream 0) | JSON `{ protocol: 1, version, name, platform }` — first frame after connecting |
| 0x11 | READY | hub -> agent (stream 0) | JSON `{ machine: { id, name }, llm: { baseURL, providers: [{ id, name }] } }` |
| 0x12 | CONFIG | hub -> agent (stream 0) | same `llm` object as READY, pushed when the provider list changes |
| 0x13 | PING | hub -> agent (stream 0) | empty, every 25 s |
| 0x14 | PONG | agent -> hub (stream 0) | empty |

Rules:
- A protocol mismatch in HELLO makes the hub close with code 4400 and a reason. A revoked or unknown token is refused at
  the upgrade (401). Hub closes a replaced connection (same machine connects twice) with 4409.
- The agent treats 60 s without PING as a dead connection and reconnects. Reconnect backoff: 1 s doubling to 30 s, ±20%
  jitter, reset after a connection has stayed up 60 s.
- Request bodies stream hub -> agent as DATA then END. Response bodies stream agent -> hub as RESPONSE, DATA*, END.
  SSE (`/api/event`) is just a long response body and must be streamed without buffering.
- No flow control in protocol 1: senders rely on WebSocket buffering. Known limitation.
- Header hygiene, applied by the **agent** before calling the local server: drop `host`, `origin`, `cookie`,
  `authorization`, `connection`, `upgrade`, `keep-alive`, `transfer-encoding`, `te`, `trailer`,
  `proxy-authorization`, `proxy-connection`, every `sec-websocket-*` for http, and add
  `authorization: Basic base64("opencode:" + password)`. On responses drop `set-cookie` and hop-by-hop headers.
  The **hub** strips its own `opencode_hub` cookie and any `authorization` header before opening a stream.

## Hub

`opencode hub [--hostname 127.0.0.1] [--port 4800] [--url http://localhost:4800] [--data <dir>]`

- `--url` is the public base URL (`https://hub.example.com` in production). Its host is the `domain` used for routing.
- Password: `OPENCODE_HUB_PASSWORD` env var; otherwise one is generated on first start, stored (hashed with
  `Bun.password`) in the data dir and printed once. `opencode hub password` resets it.
- Storage: `bun:sqlite` file `<data>/hub.db` with tables `machine` (id, name, tunnel_token_hash, llm_token_hash,
  created_at, last_seen_at), `provider` (id, name, base_url, api_key, created_at), `setting` (key, value). Enrollment
  codes and handoff tickets live in memory.
- Routes on the hub host:
  - The dashboard is a second entry of the web app (`packages/app/hub.html`, `packages/app/src/hub/`) built with
    `@opencode/ui`. The CLI passes the embedded app assets to `Hub.start({ ui })`; every non-API GET on the hub host
    serves `hub.html` (including `/login?next=`). Without assets the hub serves a 503 page explaining how to build them.
  - JSON API under `/hub/api/`: `session`, `login`, `logout`, `machines`, `events` (SSE, live machine list),
    `machines/code`, `DELETE machines/<id>`, `providers`, `DELETE providers/<id>`, `presets` (provider catalog),
    `providers/chatgpt/begin`, `providers/chatgpt/complete`. Mutations need a JSON body and `Origin` = hub origin.
  - `GET /hub/handoff`.
  - `POST /hub/agent/enroll` JSON `{ code, name }` -> `{ machine: { id, name }, tunnelToken, llmToken, url }`.
  - `GET /hub/agent/connect` WebSocket upgrade for the tunnel.
  - `ANY /llm/<provider>/<rest>`: LLM proxy (below).
  - `GET /hub/tls-allowed?domain=` -> 200 for the hub host and existing machine hosts, else 404.
  - `GET /hub/health` -> 200.
- Routes on `<m>.<domain>`: `/__hub/session` (ticket consumption); everything else requires the cookie and is proxied
  through the tunnel, including WebSocket upgrades. Machine offline -> 503 HTML page with a link back to the dashboard.
  Unknown machine -> 404.
- Login is rate limited in memory (exponential delay per client IP after failures).

## LLM proxy

- A provider entry is `{ id, name, baseURL (upstream), apiKey }` or a ChatGPT subscription (`openai`, OAuth with token
  sharing; the hub stores and refreshes the token and sends bodies zstd-compressed). The `id` must be the opencode
  provider id on the machine.
- Provider choices come from opencode's own models.dev catalog (`hub/catalog.ts`), fetched daily from
  models.opencode.ai and cached in the data dir, with the base URL derived the way core does (most common URL of the
  first SDK-backed API of each chat model). Templated URLs (Azure, Bedrock, Vertex) are excluded; custom providers
  remain possible.
- Anthropic subscriptions cannot be proxied: opencode only uses them through the local `claude` CLI.
- `<hub>/llm/<id>/<rest>` -> `<baseURL>/<rest>` with the same query string. The machine's llm token is looked for in
  `authorization: Bearer`, `x-api-key`, `x-goog-api-key` and the `key` query parameter; whichever carried it is rewritten
  with the real key, the others are left alone. No valid llm token -> 401. Unknown provider -> 404.
- Responses (including SSE) are streamed back unchanged except hop-by-hop headers.

## Agent

- `opencode agent join <hub-url> --code <code> [--name <name>]`: enrolls and stores
  `{ url, machine, tunnelToken, llmToken }` in `<global data>/agent.json` (mode 0600).
- `opencode agent run`: ensures the local background service (same mechanism as `opencode service start`), applies the
  LLM config, then keeps the tunnel open forever (reconnecting). It re-resolves the local service endpoint when a local
  request fails to connect.
- `opencode agent status`, `opencode agent leave` (forget local enrollment).
- LLM config: the agent makes the local service use `<hub>/llm/<id>` as base URL and the llm token as API key for every
  provider listed in READY/CONFIG, through the service's saved environment (`opencode service set env ...` mechanism),
  and restarts the service only when that environment actually changes.

## Library API (`@opencode/relay`)

```ts
Hub.start(options: { hostname?: string; port?: number; url: string; data: string; password?: string })
  -> Promise<{ url: string; port: number; stop(): Promise<void> }>
Agent.enroll(input: { url: string; code: string; name: string }) -> Promise<Enrollment>
Agent.connect(input: {
  enrollment: Enrollment
  local: () => Promise<{ url: string; password?: string }>
  onReady?: (ready: Ready) => void
  onConfig?: (llm: LlmConfig) => void
  onStatus?: (status: "connecting" | "connected" | "disconnected", detail?: string) => void
}) -> { close(): Promise<void> }
```

## Out of scope for the first version

Multiple users, flow control, a queue for prompts sent while a machine is offline, mTLS, OAuth-based providers in the
LLM proxy.
