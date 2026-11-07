# Remote machines (hub + agents)

One public opencode **hub** (a VPS) gives its users, who sign in with their own accounts, access to N **machines** that
sit behind NAT. Each machine runs its own full local opencode server and keeps an outbound WebSocket tunnel open to the hub. The
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

| Who                               | Credential                                                                                                                                                                                                  | Where it is checked                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| A user (browser)                  | login and password through OPAQUE (the hub never sees the password) -> `opencode_hub` session cookie of that user (host-only, HttpOnly, SameSite=Lax, Secure when the hub URL is https, 30 days, in memory) | hub, on the hub host and on every machine host; the account must exist and be active, and own the machine, on every request |
| A machine's tunnel                | `tunnel token`, issued at enrollment, sent as `Authorization: Bearer` on the WebSocket upgrade                                                                                                              | hub `/hub/agent/connect`                                                                                                    |
| A machine's LLM calls             | `llm token`, issued at enrollment, used as the provider API key on the machine; it stands for the machine, hence its owner                                                                                  | hub `/llm/<provider>/...`                                                                                                   |
| The hub reaching the local server | the local service password (Basic `opencode:<password>`)                                                                                                                                                    | injected by the **agent**, never known to the hub                                                                           |

Tokens are 32 random bytes base64url, stored hashed (sha256) in the hub DB. Revoking a machine deletes both hashes and
closes its tunnel.

Cookie handoff to machine hosts (cookies are host-only, so no `Domain=` attribute is needed and `localhost` works):

1. Unauthenticated request on `<m>.<domain>` -> 302 to `<hub-origin>/login?next=<full url>`.
2. After login (or when already logged in), `GET <hub-origin>/hub/handoff?next=<full url>` validates that `next` is the
   hub or a machine host the user owns, creates a one-time ticket (60 s), and 302s to `<m-origin>/auth/hub-session?ticket=..&next=<path>`.
3. The machine host consumes the ticket, sets its own `opencode_hub` cookie and 302s to `next`.

## Tunnel protocol (WebSocket, binary messages)

Every WebSocket message is one frame: `[type: u8][stream: u32 big-endian][payload]`. JSON payloads are UTF-8 JSON.
Stream 0 is the control stream. Streams are opened only by the hub; ids are allocated by the hub, increasing.

| Type | Name     | Direction               | Payload                                                                                                                                             |
| ---- | -------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0x01 | OPEN     | hub -> agent            | JSON `{ kind: "http", method, path, headers: [k, v][] }` or `{ kind: "ws", path, headers, protocols: string[] }` (`path` includes the query string) |
| 0x02 | DATA     | both                    | raw bytes: request body chunk, response body chunk, or binary WebSocket message                                                                     |
| 0x03 | END      | both                    | empty: the sender will send no more DATA on this stream (half close)                                                                                |
| 0x04 | RESPONSE | agent -> hub            | JSON `{ status, headers: [k, v][] }` for http; for ws, `{ status: 101, protocol? }` on success or a non-101 status on failure                       |
| 0x05 | RESET    | both                    | JSON `{ message? }`: abort the stream, both sides forget it                                                                                         |
| 0x06 | TEXT     | both                    | UTF-8 text WebSocket message                                                                                                                        |
| 0x07 | CLOSE    | both                    | JSON `{ code, reason }`: WebSocket closed                                                                                                           |
| 0x10 | HELLO    | agent -> hub (stream 0) | JSON `{ protocol: 1, version, name, platform }` — first frame after connecting                                                                      |
| 0x11 | READY    | hub -> agent (stream 0) | JSON `{ machine: { id, name }, llm: { baseURL, providers: [{ id, name }] } }`; `providers` are the machine owner's                                  |
| 0x12 | CONFIG   | hub -> agent (stream 0) | same `llm` object as READY, pushed to an owner's machines when that owner's provider list changes                                                   |
| 0x13 | PING     | hub -> agent (stream 0) | empty, every 25 s                                                                                                                                   |
| 0x14 | PONG     | agent -> hub (stream 0) | empty                                                                                                                                               |

Rules:

- A protocol mismatch in HELLO makes the hub close with code 4400 and a reason. A revoked or unknown token is refused at
  the upgrade (401). Hub closes a replaced connection (same machine connects twice) with 4409.
- The agent treats 60 s without PING as a dead connection and reconnects. Reconnect backoff: 1 s doubling to 30 s, ±20%
  jitter, reset after a connection has stayed up 60 s.
- Request bodies stream hub -> agent as DATA then END. Response bodies stream agent -> hub as RESPONSE, DATA\*, END.
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
- Accounts (see `specs/multi-users.md`, step 1): users are created only from single-use invitations (32 random bytes,
  stored as a SHA-256 hash, 7 days by default, 30 at most), with a login and a password registered through OPAQUE
  (`@serenity-kit/opaque`, Argon2id 64 MiB / 3 passes in the browser). Administrators invite, disable and enable users,
  change roles and reset passwords; the hub always keeps one active administrator. `opencode hub invite [--admin]
[--data <dir>]` writes an invitation straight into the database and prints its link; a hub started in a terminal
  without any account prints an administrator invitation itself, and otherwise prints that command.
- Machines (step 2): each machine belongs to the user who created its enrollment code (`owner_user_id`, and
  `enrolled_by`). A user lists (`machines`, `events`), opens (its host, WebSockets included) and gets handoff tickets
  for their own machines only, checked on every request; another user's machine answers exactly like an unknown one
  (404 page on its host, `/` from `/hub/handoff`, 404 on `DELETE`). Owners revoke their machines; administrators
  revoke any machine and list them all with their owner (`admin/machines`), but cannot open them. Signing out,
  disabling or resetting an account also cuts the proxied streams (SSE, WebSockets) its sessions hold open. Machines
  enrolled before owners existed go to the oldest active administrator, at start or as soon as one exists; until
  then nobody can open them. `owner_org_id` is reserved for organization machines (step 4) and stays empty.
- Providers (step 3): each user has their own, keyed `(user_id, id)`, so two users can both have an `anthropic` with
  different keys. Every `providers` route (list, add, `DELETE providers/<id>`, `chatgpt/begin|complete`) acts on the
  signed-in user's providers. Adding a provider or signing in with ChatGPT needs the user key in memory, otherwise
  `423 { error, locked: true }`; removing one does not. The `presets` catalog is shared.
- User key: the browser draws a 32-byte key at registration and stores it wrapped (AES-256-GCM under a key derived from
  the OPAQUE export key) with an HMAC check value. At sign-in the browser unwraps it and sends it; the hub checks it
  against the stored check and keeps it in memory until it stops, the user locks it or the account is disabled or
  reset. It seals the user's secrets (below); the administrators' user list shows `waiting` for a user whose key is
  locked while they have a personal machine and a saved provider, i.e. machines that get 423.
- Sealed secrets (`hub/secrets.ts`): an API key, or a ChatGPT OAuth credential as JSON, is stored as unpadded base64url
  of `1 | nonce (12 bytes) | ciphertext + tag`, AES-256-GCM under the user key, with additional data
  `"opencode-hub/v1|provider|" + provider id + "|" + user id`, so a secret cannot move to another row or user. Only
  `hub/providers.ts` opens them, in memory, per request; nothing logs a secret or a user key.
- Storage: `bun:sqlite` file `<data>/hub.db` with tables `user` (id, login, role, registration_record, wrapped_key,
  key_check, created_at, updated_at, disabled_at), `invitation` (id, code_hash, role, created_by, user_id for a reset,
  created_at, expires_at, used_at), `machine` (id, name, tunnel_token_hash, llm_token_hash, owner_user_id,
  owner_org_id, enrolled_by, created_at, last_seen_at), `provider` (user_id, id, name, base_url, auth `key` or
  `chatgpt`, api_key and oauth sealed, created_at, updated_at; primary key `(user_id, id)`),
  `setting` (key, value; `url` is the public URL the hub last started with, for `hub invite`). The OPAQUE server key lives in `<data>/opaque-server-setup`, outside
  the database. The data dir is `0700`; `hub.db`, its WAL files, `opaque-server-setup` and `catalog.json` are `0600`.
  Sessions, unlocked user keys, OPAQUE attempts, enrollment codes and handoff tickets live in memory.
  The connection runs with `secure_delete` on, so deleted rows are zeroed. A `provider` table without `user_id` (the
  shared, clear-text one of earlier versions) is dropped at start without being read, then checkpointed out of the
  WAL: those providers have to be entered again by each user. An administrator reset deletes the user's providers.
- Routes on the hub host:
  - The dashboard is a second entry of the web app (`packages/app/hub.html`, `packages/app/src/hub/`) built with
    `@opencode/ui`. The CLI passes the embedded app assets to `Hub.start({ ui })`; every non-API GET on the hub host
    serves `hub.html` (including `/login?next=`). Without assets the hub serves a 503 page explaining how to build them.
  - JSON API under `/hub/api/`: `session`, `register/invite`, `register/start`, `register/finish`, `login/start`,
    `login/finish`, `logout`, `account/lock`, `account/password/start`, `account/password/finish`, and for
    administrators `users`, `users/<id>/{disable,enable,role,reset}`, `invitations`, `DELETE invitations/<id>`;
    then `machines`, `events` (SSE, live list of the user's machines),
    `machines/code` (a code tied to the signed-in user), `DELETE machines/<id>` (owner or administrator),
    `admin/machines` (administrators: every machine with its owner), `providers`, `DELETE providers/<id>`, `presets` (provider catalog),
    `providers/chatgpt/begin`, `providers/chatgpt/complete`. Mutations need a JSON body and `Origin` = hub origin.
  - `GET /hub/handoff`.
  - `POST /hub/agent/enroll` JSON `{ code, name }` -> `{ machine: { id, name }, tunnelToken, llmToken, url }`. The
    machine belongs to the code's author; a code whose author was disabled meanwhile is refused (403).
  - `GET /hub/agent/connect` WebSocket upgrade for the tunnel.
  - `ANY /llm/<provider>/<rest>`: LLM proxy (below).
  - `GET /hub/tls-allowed?domain=` -> 200 for the hub host and existing machine hosts, else 404.
  - `GET /hub/health` -> 200.
- Routes on `<m>.<domain>`: `/auth/hub-session` (ticket consumption); everything else requires the cookie of the
  machine's owner and is proxied through the tunnel, including WebSocket upgrades. Without a session -> login redirect
  (401 for upgrades and mutations), whether the machine exists or not. Machine offline -> 503 HTML page with a link
  back to the dashboard. Unknown machine, or another user's -> the same 404.
- Sign-in is rate limited in memory: an exponential delay per client IP after failures, and 15 minutes after 5
  consecutive failures on a login, whether the account exists or not. A sign-in counts as failed from `login/start`
  until `login/finish` succeeds, since a wrong password fails in the browser. An unknown login gets a fake OPAQUE
  answer and a fake wrapped key, stable per login, so accounts cannot be enumerated.
- The page's CSP allows `'wasm-unsafe-eval'` for OPAQUE's WebAssembly.

## LLM proxy

- A provider entry belongs to one user: `{ id, name, baseURL (upstream), apiKey }` or a ChatGPT subscription (`openai`,
  OAuth with token sharing, one sign-in per user; the hub stores and refreshes the token, sealing it again under the
  user key at each refresh, and sends bodies zstd-compressed). The `id` must be the opencode provider id on the
  machine.
- Provider choices come from opencode's own models.dev catalog (`hub/catalog.ts`), fetched daily from
  models.opencode.ai and cached in the data dir, with the base URL derived the way core does (most common URL of the
  first SDK-backed API of each chat model). Templated URLs (Azure, Bedrock, Vertex) are excluded; custom providers
  remain possible.
- Anthropic subscriptions cannot be proxied: opencode only uses them through the local `claude` CLI.
- `<hub>/llm/<id>/<rest>` -> `<baseURL>/<rest>` with the same query string. The machine's llm token is looked for in
  `authorization: Bearer`, `x-api-key`, `x-goog-api-key` and the `key` query parameter; whichever carried it is rewritten
  with the real key, the others are left alone. The token gives the machine, the machine its owner, and the hub uses
  that owner's provider `<id>`, opened with the owner's user key in memory.
- Answers, in this order: no valid llm token, or tokens of two machines -> 401; organization or ownerless machine ->
  403 (fail-closed until step 4); owner disabled or reset, or owner's key not in memory (hub restarted, keys locked,
  never signed in since) -> `423 { error: "Keys locked: sign in to the hub to unlock them." }`; unknown provider of
  that owner -> 404; a secret that does not open -> 500.
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
Hub.start(options: { hostname?: string; port?: number; url: string; data: string })
  -> Promise<{ url: string; port: number; userCount(): number; invite(role): { url, expiresAt };
       createEnrollmentCode(userID): { code, expiresAt }; stop(): Promise<void> }>
Hub.invite(input: { data: string; role: "admin" | "user" }) -> { url: string; expiresAt: number }
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

Per-user instances, organizations (see `specs/multi-users.md`), flow control, a queue for prompts sent while a machine is offline, mTLS, OAuth-based providers in the
LLM proxy.
