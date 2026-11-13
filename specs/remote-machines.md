# Remote machines (hub + agents)

One public opencode **hub** (a VPS) gives its users, who sign in with their own accounts, access to N **machines** that
sit behind NAT. Each machine runs its own full local opencode server and keeps an outbound WebSocket tunnel open to the hub. The
hub reverse-proxies the machine's whole web UI and API through that tunnel. The hub also proxies LLM traffic so provider
keys never leave the hub.

Core, Protocol and Server are not modified. Everything lives in `packages/relay` (`@opencode/relay`) plus CLI commands.

## Topology

```
browser ──https──> Caddy ──http──> opencode hub (127.0.0.1:4800)
                                     │  hub.example.com          dashboard, login, enrollment, LLM and MCP proxy
                                     │  <machine>.hub.example.com  reverse proxy to that machine
                                     ▼
                              WebSocket tunnel (outbound from the machine)
                                     ▼
            machine: opencode agent ──http/ws──> the opening user's opencode instance (127.0.0.1:<port>)
```

- Each user who opens a machine has their own **instance** there (`specs/multi-users.md`, step 5): on a personal
  machine, the owner's instance is the account's usual background service; on an organization machine, each member
  gets their own opencode server, started on demand by the agent.

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
| An instance's LLM and MCP calls   | `instance token`, issued by the hub in INSTANCE, used as the provider API key and the MCP bearer by that instance only; it stands for one user on one machine                                               | hub `/llm/<provider>/...` and `/mcp/<connector>/...`, which also check that the user may still open the machine             |
| The hub reaching the local server | the local service password (Basic `opencode:<password>`)                                                                                                                                                    | injected by the **agent**, never known to the hub                                                                           |

Tokens are 32 random bytes base64url, stored hashed (sha256) in the hub DB. Revoking a machine deletes its tunnel token
and its instances (and their tokens), sends DROP for each instance, then closes its tunnel.

Cookie handoff to machine hosts (cookies are host-only, so no `Domain=` attribute is needed and `localhost` works):

1. Unauthenticated request on `<m>.<domain>` -> 302 to `<hub-origin>/login?next=<full url>`.
2. After login (or when already logged in), `GET <hub-origin>/hub/handoff?next=<full url>` validates that `next` is the
   hub or a machine host the user owns, creates a one-time ticket (60 s), and 302s to `<m-origin>/auth/hub-session?ticket=..&next=<path>`.
3. The machine host consumes the ticket, sets its own `opencode_hub` cookie and 302s to `next`.

## Tunnel protocol (WebSocket, binary messages)

Every WebSocket message is one frame: `[type: u8][stream: u32 big-endian][payload]`. JSON payloads are UTF-8 JSON.
Stream 0 is the control stream. Streams are opened only by the hub; ids are allocated by the hub, increasing.

| Type | Name     | Direction               | Payload                                                                                                                                                                                                                                    |
| ---- | -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0x01 | OPEN     | hub -> agent            | JSON `{ kind: "http", instance, method, path, headers: [k, v][] }` or `{ kind: "ws", instance, path, headers, protocols: string[] }` (`path` includes the query string; `instance` is the opening user's iid)                              |
| 0x02 | DATA     | both                    | raw bytes: request body chunk, response body chunk, or binary WebSocket message                                                                                                                                                            |
| 0x03 | END      | both                    | empty: the sender will send no more DATA on this stream (half close)                                                                                                                                                                       |
| 0x04 | RESPONSE | agent -> hub            | JSON `{ status, headers: [k, v][] }` for http; for ws, `{ status: 101, protocol? }` on success or a non-101 status on failure                                                                                                              |
| 0x05 | RESET    | both                    | JSON `{ message? }`: abort the stream, both sides forget it                                                                                                                                                                                |
| 0x06 | TEXT     | both                    | UTF-8 text WebSocket message                                                                                                                                                                                                               |
| 0x07 | CLOSE    | both                    | JSON `{ code, reason }`: WebSocket closed                                                                                                                                                                                                  |
| 0x10 | HELLO    | agent -> hub (stream 0) | JSON `{ protocol: 2, version, name, platform, instances?: [{ iid, hash, skills? }] }` — first frame after connecting; `instances` are the instance tokens the agent still holds, as SHA-256 hex, with the skills version it wrote for each |
| 0x11 | READY    | hub -> agent (stream 0) | JSON `{ machine: { id, name }, owner: "user" \| "org", instances: iid[] }`: every instance the machine still has                                                                                                                           |
| 0x13 | PING     | hub -> agent (stream 0) | empty, every 25 s                                                                                                                                                                                                                          |
| 0x14 | PONG     | agent -> hub (stream 0) | empty                                                                                                                                                                                                                                      |
| 0x15 | INSTANCE | hub -> agent (stream 0) | JSON `{ iid, token?, llm: { baseURL, providers: [{ id, name }] }, mcp: [{ id, name, url }], skills: { version } }`: an instance's configuration (its user's providers and connectors, the version of its user's effective skills)          |
| 0x16 | SKILLS   | hub -> agent (stream 0) | JSON `{ iid, version, skills: [{ name, files: [{ path, content }] }] }`: every effective skill of the instance's user, sent after INSTANCE when the agent lacks this version                                                               |
| 0x17 | DROP     | hub -> agent (stream 0) | JSON `{ iid }`: stop the instance and delete it                                                                                                                                                                                            |

Rules:

- This is protocol 2. 0x12 (CONFIG in protocol 1) is gone. A protocol mismatch in HELLO, protocol 1 included, makes the
  hub close with code 4400 and a reason. A revoked or unknown token is refused at
  the upgrade (401). Hub closes a replaced connection (same machine connects twice) with 4409.
- The agent treats 60 s without PING as a dead connection and reconnects. Reconnect backoff: 1 s doubling to 30 s, ±20%
  jitter, reset after a connection has stayed up 60 s.
- Request bodies stream hub -> agent as DATA then END. Response bodies stream agent -> hub as RESPONSE, DATA\*, END.
  SSE (`/api/event`) is just a long response body and must be streamed without buffering.
- Instances (`specs/multi-users.md`, "Instances"): an iid is 16 to 64 base64url characters (the agent names a folder
  after it; anything else fails to decode). The hub creates a user's instance at their first request to the machine
  (a personal machine's owner instance at connection), and sends INSTANCE before the first OPEN for it on a
  connection, then again whenever that user's providers or connectors change. `token` is present only when the hub issued a new
  one, which replaces the previous hash: the agent announces in HELLO the tokens it still holds, and the hub omits
  `token` for an instance whose hash matches. The agent keeps instance tokens in memory and in each instance's own
  configuration only, never in `agent.json`. When a user loses access (removed from the organization, disabled,
  reset) or the machine is revoked, the hub deletes the instance and sends DROP; an agent that was offline learns it
  from READY, whose `instances` omits it, and deletes it too. OPEN for an instance the agent was not given is reset.
- Skills (`specs/multi-users.md`, "Skills"): `skills.version` is the SHA-256 (hex) of the canonical JSON of the user's
  effective skills (skills by name, files by path; no skills is the digest of `[]`). The hub sends SKILLS, with all of
  them, right after INSTANCE whenever the agent does not have that version (announced in HELLO, or last sent on this
  connection), and to every instance the agent holds when a change (a skill of the user or of one of their
  organizations, joining or leaving one, an organization renamed or deleted) gives its user a new version. SKILLS for
  an instance the agent was not given is ignored. The agent checks every name (`[a-z0-9]+(-[a-z0-9]+)*`, 64 at most)
  and path (relative, segments `[A-Za-z0-9_][A-Za-z0-9._-]*`, no `..`, no hidden file, 6 levels) before writing
  anything, and announces a version only once it is written.
- No flow control: senders rely on WebSocket buffering. Known limitation (the hub chat's task streams cut a browser
  that falls too far behind, see "Hub chat").
- Header hygiene, applied by the **agent** before calling the local server: drop `host`, `origin`, `cookie`,
  `authorization`, `connection`, `upgrade`, `keep-alive`, `transfer-encoding`, `te`, `trailer`,
  `proxy-authorization`, `proxy-connection`, every `sec-websocket-*` for http, and add
  `authorization: Basic base64("opencode:" + password)`. On responses drop `set-cookie` and hop-by-hop headers.
  The **hub** strips its own `opencode_hub` cookie and any `authorization` header before opening a stream.

## Hub

`opencode hub [--hostname 127.0.0.1] [--port 4800] [--url http://localhost:4800] [--data <dir>] [--mcp-private-network]`

- `--url` is the public base URL (`https://hub.example.com` in production). Its host is the `domain` used for routing.
- Accounts (see `specs/multi-users.md`, step 1): users are created only from single-use invitations (32 random bytes,
  stored as a SHA-256 hash, 7 days by default, 30 at most), with a login and a password registered through OPAQUE
  (`@serenity-kit/opaque`, Argon2id 64 MiB / 3 passes in the browser). Administrators invite, disable and enable users,
  change roles and reset passwords; the hub always keeps one active administrator. `opencode hub invite [--admin]
[--org <name>]... [--data <dir>]` writes an invitation straight into the database and prints its link (an unknown
  organization name fails and writes nothing); a hub started in a terminal without any account prints an
  administrator invitation itself, and otherwise prints that command.
- Machines (step 2): each machine belongs to the user who created its enrollment code (`owner_user_id`, and
  `enrolled_by`). A user lists (`machines`, `events`), opens (its host, WebSockets included) and gets handoff tickets
  for their own machines only, checked on every request; another user's machine answers exactly like an unknown one
  (404 page on its host, `/` from `/hub/handoff`, 404 on `DELETE`). Owners revoke their machines; administrators
  revoke any machine and list them all with their owner (`admin/machines`), but cannot open them. Signing out,
  disabling or resetting an account also cuts the proxied streams (SSE, WebSockets) its sessions hold open. Machines
  enrolled before owners existed go to the oldest active administrator, at start or as soon as one exists; until
  then nobody can open them.
- Organizations (step 4): administrators create, rename (`orgs/<id>/rename`) and delete organizations (names unique,
  case-insensitive, 1 to 64 characters) and add or remove members (routes below); every other user gets 403 on all `orgs` routes. An administrator is a member only once
  added. Deleting an organization that owns machines is refused (409). An invitation may name organizations
  (`invitations { role, days?, orgs? }`); the new account joins those that still exist in the transaction that
  creates it. A member creates an enrollment code for the organization (`machines/code { org }`); membership is
  checked when the code is created and again at enrollment (403 otherwise, with the same message as an invalid code).
  The machine then has `owner_org_id` (and no `owner_user_id`) and `enrolled_by`. Every current member lists, follows,
  opens and gets tickets for it, checked on every request; removing a member cuts their open streams at once, as a
  disabled account does, and deletes their instance there (DROP). Each member uses their own instance. A machine
  belonging to an organization is revoked by the member who enrolled it (while still a member) or by an
  administrator; another member gets 403, a non-member 404.
- Skills (step 6): a user's own, and each organization's, managed by administrators only. A skill is `SKILL.md`
  (YAML frontmatter with `name`, equal to the skill's name, and a non-empty `description`) plus text files at safe
  relative paths, 256 KiB in all, 200 per owner (409 beyond, and for a name already used by that owner; 400 for
  anything invalid). A user's effective skills are their own plus their organizations'; on a name used twice, the
  organization's wins, and between organizations the first by name (case-insensitive); the losers are listed with
  `hiddenBy`. They reach every instance of the user (see "Tunnel").
- Providers (step 3): each user has their own, keyed `(user_id, id)`, so two users can both have an `anthropic` with
  different keys. Every `providers` route (list, add, `DELETE providers/<id>`, `chatgpt/begin|complete`) acts on the
  signed-in user's providers. Adding a provider or signing in with ChatGPT needs the user key in memory, otherwise
  `423 { error, locked: true }`; removing one does not. The `presets` catalog is shared.
- Connectors (step 7): each user's remote MCP servers, keyed `(user_id, id)` like providers (see "MCP proxy").
  `connectors` lists them (`{ id, name, url, auth, headers: names only, connected, server: "hub-<id>" }`), `POST
connectors { name, url, id?, auth?: "headers" | "oauth", headers?: [{ name, value }], clientID?, clientSecret?,
scope? }` adds one (409 for an id already used or beyond 50), `POST connectors/<id> { name?, url?, headers?,
clientID?, clientSecret?, scope? }` changes one (headers left out are kept; a new URL or client drops OAuth tokens),
  `DELETE connectors/<id>` removes one, `POST connectors/<id>/oauth/begin` starts an OAuth sign-in. Adding, changing and
  signing in need the user key in memory (423 otherwise); removing does not. The id is lowercase words joined by
  dashes (48 characters at most), derived from the name when left out. A change is pushed to the user's instances in
  INSTANCE.
- User key: the browser draws a 32-byte key at registration and stores it wrapped (AES-256-GCM under a key derived from
  the OPAQUE export key) with an HMAC check value. At sign-in the browser unwraps it and sends it; the hub checks it
  against the stored check and keeps it in memory until it stops, the user locks it or the account is disabled or
  reset. It seals the user's secrets (below); the administrators' user list shows `waiting` for a user whose key is
  locked while they have a saved provider or connector and at least one instance, i.e. instances that get 423.
- Sealed secrets (`hub/secrets.ts`): an API key, or a ChatGPT OAuth credential as JSON, is stored as unpadded base64url
  of `1 | nonce (12 bytes) | ciphertext + tag`, AES-256-GCM under the user key, with additional data
  `"opencode-hub/v1|provider|" + provider id + "|" + user id`, so a secret cannot move to another row or user. Only
  `hub/providers.ts` opens them, in memory, per request; nothing logs a secret or a user key. A connector's headers
  (JSON `[name, value][]`) or OAuth state (JSON: the client entered or registered, then the tokens) are sealed the same
  way with `"opencode-hub/v1|connector|" + connector id + "|" + user id`; only `hub/connectors.ts` opens them.
- Storage: `bun:sqlite` file `<data>/hub.db` with tables `user` (id, login, role, registration_record, wrapped_key,
  key_check, created_at, updated_at, disabled_at), `invitation` (id, code_hash, role, created_by, user_id for a reset,
  created_at, expires_at, used_at), `invitation_org` (invitation_id, org_id: the organizations a new account joins),
  `org` (id, name unique without case, created_at), `membership` (org_id, user_id, created_at), `machine` (id, name,
  tunnel_token_hash, owner_user_id, owner_org_id, enrolled_by, created_at, last_seen_at; a table from protocol 1 is
  rebuilt without its `llm_token_hash`), `instance` (id: the iid, machine_id, user_id, token_hash null until first
  sent, created_at, token_issued_at; unique `(machine_id, user_id)`), `connector` (user_id, id, name, url, auth `headers` or `oauth`, header_names in clear, headers and oauth sealed,
  connected_at, created_at, updated_at; primary key `(user_id, id)`), `provider` (user_id, id, name, base_url, auth `key` or
  `chatgpt`, api_key and oauth sealed, created_at, updated_at; primary key `(user_id, id)`), `skill` (id, owner_kind
  `user` or `org`, owner_id, name, description, files as JSON `[{ path, content }]` in clear, created_at, updated_at;
  unique `(owner_kind, owner_id, name)`; an organization's go with it),
  `chat_target` and `chat_task` (see "Hub chat"), `setting` (key, value; `url` is the public URL the hub last started with, for `hub invite`). The OPAQUE server key lives in `<data>/opaque-server-setup`, outside
  the database. The data dir is `0700`; `hub.db`, its WAL files, `opaque-server-setup` and `catalog.json` are `0600`.
  Sessions, unlocked user keys, OPAQUE attempts, enrollment codes and handoff tickets live in memory.
  The connection runs with `secure_delete` on, so deleted rows are zeroed. A `provider` table without `user_id` (the
  shared, clear-text one of earlier versions) is dropped at start without being read, then checkpointed out of the
  WAL: those providers have to be entered again by each user. An administrator reset deletes the user's providers and connectors.
- Routes on the hub host:
  - The hub chat's routes (`chat/…`, `chat-machines/…`, `chat-targets/…`, `chat-tasks/…`) are described in "Hub
    chat".
  - The dashboard is a second entry of the web app (`packages/app/hub.html`, `packages/app/src/hub/`) built with
    `@opencode/ui`. The CLI passes the embedded app assets to `Hub.start({ ui })`; every non-API GET on the hub host
    serves `hub.html` (including `/login?next=`). Without assets the hub serves a 503 page explaining how to build them.
  - JSON API under `/hub/api/`: `session`, `register/invite`, `register/start`, `register/finish`, `login/start`,
    `login/finish`, `logout`, `account/lock`, `account/password/start`, `account/password/finish`, and for
    administrators `users`, `users/<id>/{disable,enable,role,reset}`, `invitations`, `DELETE invitations/<id>`,
    `orgs`, `orgs/<id>/rename`, `DELETE orgs/<id>`, `orgs/<id>/members`, `DELETE orgs/<id>/members/<user>`;
    then `memberships` (the user's organizations), `machines`, `events` (SSE, live list of the user's machines,
    personal then grouped by organization, each with `org` and `canRevoke`), `machines/code { org? }` (a code tied to
    the signed-in user, and to one of their organizations), `DELETE machines/<id>` (see Organizations),
    `admin/machines` (administrators: every machine with its owner or organization), `providers`, `DELETE providers/<id>`, `presets` (provider catalog),
    `providers/chatgpt/begin`, `providers/chatgpt/complete`, `connectors`, `connectors/<id>` (POST, DELETE),
    `connectors/<id>/oauth/begin`, `skills` (GET: `{ own, inherited, version }`, each skill
    with `hiddenBy`, the organization whose skill of the same name wins; POST `{ name, files }` creates),
    `skills/<id>` (POST replaces, DELETE), and for administrators `orgs/<id>/skills` (GET, POST) and
    `orgs/<id>/skills/<skill>` (POST, DELETE); members get 403 there and read their organizations' skills through
    `skills`. Mutations need a JSON body and `Origin` = hub origin.
  - `GET /hub/handoff`.
  - `POST /hub/agent/enroll` JSON `{ code, name }` -> `{ machine: { id, name }, tunnelToken, url }`. The
    machine belongs to the code's author, or to the organization the code names; a code whose author was disabled
    meanwhile, or left that organization, is refused (403).
  - `GET /hub/agent/connect` WebSocket upgrade for the tunnel.
  - `ANY /llm/<provider>/<rest>`: LLM proxy (below).
  - `ANY /mcp/<connector>/<rest>`: MCP proxy (below); `GET /hub/oauth/callback`: where an authorization server sends
    the browser back after a connector's OAuth sign-in.
  - `GET /hub/tls-allowed?domain=` -> 200 for the hub host and existing machine hosts, else 404.
  - `GET /hub/health` -> 200.
- Routes on `<m>.<domain>`: `/auth/hub-session` (ticket consumption); everything else requires the cookie of the
  machine's owner, or of a member of its organization, and is proxied through the tunnel, including WebSocket upgrades. Without a session -> login redirect
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
- `<hub>/llm/<id>/<rest>` -> `<baseURL>/<rest>` with the same query string. The instance token is looked for in
  `authorization: Bearer`, `x-api-key`, `x-goog-api-key` and the `key` query parameter; whichever carried it is rewritten
  with the real key, the others are left alone. The token gives the instance, hence one user on one machine, and the hub
  uses **that user's** provider `<id>`, opened with their user key in memory.
- Answers, in this order: no valid instance token, tokens of two instances, or a machine that no longer exists -> 401;
  the user may no longer open the machine (account disabled or reset, no longer its owner or a member of its
  organization) -> 403 `This account no longer has access to this machine.`, a fail-closed check on every call besides
  the instance being deleted; the user's key not in memory (hub restarted, keys locked, never signed in since) ->
  `423 { error: "Keys locked: sign in to the hub to unlock them." }` (after the provider lookup, so an unknown provider
  of a locked user is 404); unknown provider of that user -> 404; a secret that does not open -> 500.
- Responses (including SSE) are streamed back unchanged except hop-by-hop headers.

## MCP proxy

- A connector belongs to one user: a remote MCP server (`url`, HTTP "streamable" or SSE) with either headers to inject
  (`headers`, e.g. an API key) or an OAuth sign-in run by the hub (`oauth`). Only remote servers go through the hub: a
  local one (`type: "local"`, a command) stays configured on the machine.
- The instance reaches it as the remote MCP server `hub-<id>` (prefix so it never replaces a server configured on the
  machine) at `<hub>/mcp/<id>`, with `Authorization: Bearer <instance token>` and opencode's own OAuth off
  (`oauth: false`).
- `<hub>/mcp/<id>/<rest>` -> `<url>/<rest>` (dot segments resolved, so it cannot climb above the connector's path),
  with the request's query string appended to the URL's. Answers, in this order: no valid instance token in
  `Authorization: Bearer`, or a machine that no longer exists -> 401; the user may no longer open the machine -> 403
  (as the LLM proxy); unknown connector of that user -> 404; the user's key not in memory -> 423 with the LLM proxy's
  message; secrets that do not open -> 500; an `oauth` connector not signed in, or whose sign-in expired without a
  refresh token -> 409 (the user signs in again from the dashboard); a destination the network guard refuses, a
  redirect elsewhere, or an unreachable server -> 502.
- Headers: the instance's `Authorization`, cookies, `Host`, `Origin`, `Referer`, forwarding and hop-by-hop headers are
  dropped; the connector's headers are set (they win over the instance's), or `Authorization: Bearer <access token>`
  for OAuth. Everything else passes, the MCP session (`Mcp-Session-Id`, `MCP-Protocol-Version`, `Last-Event-ID`)
  included, both ways. Request bodies are read whole (MCP messages are small, and an OAuth retry needs them); answers,
  SSE included, are streamed without buffering, minus hop-by-hop headers and `Set-Cookie`. Closing the instance's
  request aborts the request to the server.
- Redirects are never followed. One that stays under the connector's URL comes back as the same status with a
  `Location` on the hub (`<hub>/mcp/<id>/...`), so the instance follows it through the proxy; any other is 502.
- Network guard (`hub/egress.ts`), on every request the hub sends for a connector (the MCP requests, and OAuth
  discovery, registration and token requests), checked when a connector is saved and again before each request, on
  every address its name resolves to:
  - always refused: the hub's own host name and every machine host under it, the hub's port on any loopback, unspecified
    or local interface address, link-local addresses (`169.254.0.0/16`, `fe80::/10`: cloud metadata services), the
    metadata addresses outside them (`100.100.100.200`, `fd00:ec2::254`), unspecified, multicast, broadcast, reserved,
    documentation ranges, and IPv6 ranges that embed an IPv4 address (NAT64, 6to4, Teredo); URLs
    with a user name or password;
  - private addresses (loopback, RFC 1918, CGNAT `100.64.0.0/10`, `198.18.0.0/15`, `fc00::/7`, `::1`): refused unless
    the hub runs with `--mcp-private-network` (`Hub.start({ mcp: { privateNetworks: true } })`), for connectors on the
    hub's own network;
  - plain `http://` only to private addresses (so only with that flag): a public connector is HTTPS, since the hub
    sends it the user's secrets;
  - the request then goes to the address that was checked (the `Host` header and, for HTTPS, the certificate check and
    SNI keep the name), so a name that resolves elsewhere between the check and the connection (DNS rebinding) cannot
    redirect it.
- OAuth (`hub/mcp-oauth.ts`), following the MCP authorization specification: the hub sends an unauthenticated
  `initialize` and reads `resource_metadata` from the 401 `WWW-Authenticate` challenge, else tries
  `/.well-known/oauth-protected-resource<path>` then `/.well-known/oauth-protected-resource` (RFC 9728; the metadata's
  `resource` must be on the connector's origin; without any, the server's origin is its own authorization server).
  Then the authorization server's metadata (RFC 8414 `oauth-authorization-server`, else OpenID Connect discovery, with
  the path insertion rules), whose `issuer` must match and which must list `S256` PKCE. The client is the one the user
  entered (with its secret, sent as HTTP Basic unless the server only lists `client_secret_post`), else one the hub
  registers (RFC 7591, a public client with `token_endpoint_auth_method: "none"`); without a registration endpoint the
  user must enter a client id. The dashboard sends the browser to the authorization URL (`response_type=code`, PKCE
  S256, `state`, `resource` = the protected resource (RFC 8707), `scope` = the one entered or the resource's
  `scopes_supported`), which comes back to `GET /hub/oauth/callback`. The attempt is in memory, 10 minutes, single use,
  bound to the user who started it and to the connector's URL then; another user's session (or none) gets the same
  answer as an expired one. An `iss` parameter must name the issuer (RFC 9207). The tokens are sealed under the user
  key; then the browser returns to `/?connector=<id>`. The proxy refreshes the access token when it expires within a
  minute, or once when the server answers 401, with the refresh token (rotated or kept), and seals the result again
  under the key the connector was opened with; concurrent requests share one refresh.

## Agent

- `opencode agent join <hub-url> --code <code> [--name <name>]`: enrolls and stores
  `{ url, machine, tunnelToken }` in `<global data>/agent.json` (mode 0600). An `agent.json` from protocol 1 still
  loads; its `llmToken` is ignored and dropped from the file the next time it is read.
- `opencode agent run`: ensures the local background service, then keeps the tunnel open forever (reconnecting). What
  it serves depends on READY's `owner`:
  - **Personal machine**: its only instance, the owner's, is the background service (same mechanism as `opencode
service start`), so the owner's existing sessions stay visible. INSTANCE is applied to the service's saved
    environment (`OPENCODE_HUB_INSTANCE`, `OPENCODE_HUB_LLM_TOKEN`, and `OPENCODE_CONFIG_CONTENT` that points every
    provider at `<hub>/llm/<id>` with the token as API key, and declares every connector as
    `mcp.servers["hub-<id>"]`, a remote server at `<hub>/mcp/<id>` whose `Authorization` header reads the token
    from `{env:OPENCODE_HUB_LLM_TOKEN}`, with `oauth: false`), and the service restarts only when that environment
    actually changes. At start the agent reads the instance and token back from there to announce them in HELLO.
    DROP removes those three entries (the account's own data stays). SKILLS goes into the account's own skills folder
    (`<global config>/skills/hub-<name>/`, e.g. `~/.config/opencode/skills/hub-*`), next to the skills already there;
    a manifest (`.hub-skills.json`, hidden from opencode's scan) lists the `hub-*` folders the agent wrote, and only
    those are ever replaced or deleted (a local folder that happens to be called `hub-<name>` is left alone and that
    skill skipped). DROP, an instance missing from READY and `agent leave` remove them.
  - **Organization machine**: one opencode server per member's instance, started at its first OPEN as
    `opencode serve --stdio --hostname 127.0.0.1 --port 0` with its own `XDG_DATA_HOME`, `XDG_CONFIG_HOME`,
    `XDG_STATE_HOME` and `XDG_CACHE_HOME` under `<global data>/hub-instances/<iid>/` (folders `0700`), a random local
    password, and the same three variables. All run under the agent's system account. A configuration change stops
    the instance, which starts again with it at the next request. SKILLS goes into the instance's own
    `<XDG_CONFIG_HOME>/opencode/skills/hub-<name>/`, written before the instance starts. DROP stops it and deletes its folder; READY deletes
    the folders of instances it does not list. The servers hold their stdin as a lease: stopping the agent stops them
    (they also exit if it dies), their folders stay.
    It re-resolves an instance's local endpoint when a local request fails to connect or its configuration changes.
- Writing skills: each skill is written in full into a staging folder inside `skills/` (`.hub-staging-*`, hidden from
  opencode), then renamed into place, replacing the previous `hub-<name>` folder; `hub-*` folders the hub no longer
  lists are deleted. Each skill is replaced atomically; the set as a whole is not (a scan in between may see some
  skills already new). A running instance is then asked to reload its configuration (`POST /api/location/reload`,
  the API behind `opencode reload`), which rescans its skill folders; a server that starts later reads them anyway.
- `opencode agent status`, `opencode agent leave` (forget local enrollment, remove the hub's entries from the
  service environment and the hub's skills from its skills folder).

## Hub chat

The hub's own chat (`Hub.start({ chat })`) runs one opencode server per active user on the hub (`hub/chat.ts`),
restricted to the hub's tools (the `hub-tools` MCP server at `/hub/chat-tools`, authenticated with that instance's
token) and behind a closed list of browser routes under `/hub/api/chat/`. It reaches the user's machines only through
`machineRequest`, which checks `mayOpen(user, machine)` on every call, like a browser request.

The chat's model is an **orchestrator**: its system prompt tells it to plan, delegate to sub-agents (tasks on the
user's machines), choose their model and role, wait only when the next step needs a result, verify, and report.

- **Target** (`chat_target`, `hub/chat-machines.ts`): the machine and folder attached to a chat session, told to the
  model once. `/command` and `!shell` from the composer run there as tasks (`kind`, below).
- **Tasks** (`chat_task`, `hub/chat-tasks.ts`): `machine_task` starts one session per task on a machine (by default
  the target; or `machine`, `directory`, `agent`), titled after the prompt, and answers as soon as the machine admitted
  the prompt with `{ task, remoteSession, machine, directory, model?, template?, status }`; `continue: <task>` sends
  the prompt to an earlier task's session instead; `wait_seconds` (0 to 600) waits for the end. The row is created
  before the first request to the machine. Statuses: `starting`, `running`, `waiting` (a permission or question
  pending), `offline` (the machine's stream is down), then `idle`, `failed`, `interrupted` or `lost` (offline 30
  minutes, or its session gone; a lost session is never recreated). A message sent to a task that ended starts it again
  in the same session. At most 8 active tasks per user. Stopping the chat's own answer never stops tasks; the UI has an
  explicit "Stop all tasks".
- **Model** (`model`, `variant`): `provider/model` (or `provider/model#variant`) among the models the user's providers
  give, the same list on the hub and on the machines since both reach providers through the hub's proxy (`Chat.models`,
  the engine's `api/model` kept to the user's providers; `models_list` for the model, `GET chat-models` for the
  browser). An unknown model or variant is refused before anything reaches the machine, naming `models_list`. Without
  one, the task runs the conversation's own model (or the template's default). The chosen model goes to
  `POST /api/session` and, for a follow-up (`machine_task_send { model }`, `continue`), to `POST …/model` first; it is
  stored on the row as `provider/model#variant` and shown on the card, the strip and the panel.
- **Templates** (`chat_template`, `hub/chat-templates.ts`): a role for a sub-agent, as a system prompt with a
  description (for the model), a default model and optionally the machine's agent. Three are built in (`plan`, with
  the machine's `plan` agent; `build`; `review`); a user's own template of the same name replaces the built-in one.
  `machine_task { template }` sends the template's text as a synthetic message (`<agent_template name="…">`,
  description `Template <name>`, `resume: false`) to the new session right before the request, so it works on any
  machine as is and shows apart from the request in the panel; with `continue` it is prefixed to the follow-up. The
  machine's own agent definitions are not written; a template that names `agent` picks one that exists there.
  Routes: `GET chat-templates` (own, then the built-in ones not replaced), `POST chat-templates { name, description,
system, model?, agent? }`, `PUT|DELETE chat-templates/<id>`. Names are lowercase hyphenated words; 50 templates per
  user. The settings page "Agent templates" edits them.
- **Waiting** (`machine_tasks_wait { tasks, mode: any | all, seconds }`, 120 by default, 600 at most): blocks until
  the first (or every) task of this conversation ends, and answers each task's status, with the final message of those
  that ended meanwhile, how many still run, and how long it waited. A result handed to a waiter is not reported to
  the model again.
- **Commands** (`kind`: `prompt`, `command`, `shell`): `POST chat-tasks { session, kind: "command", command: { name,
arguments? } }` runs a slash command (`POST …/command`), `{ kind: "shell", shell }` one shell command (`POST
…/shell`, which answers when the command ends, so only a quick answer counts as a refusal), each in its own new
  session, titled `/name args` or `$ cmd`. A shell task ends on `session.shell.ended` (or, on reconciliation, when its
  shell message is no longer running); a slash command on the agent run it started, or once the session stays quiet 4
  seconds without one. A shell task takes no follow-up. Their end is recorded in the shape of the hub's earlier command
  records (`kind: shell | command`, `command`, `output`, `exit`), which the timeline shows as a shell message or a
  command and its answer.
- **Following** (`hub/chat-watch.ts`): one `GET /api/event?types=…` stream per user and machine through the tunnel,
  shared by every task and browser following that user's sessions there, open while anyone follows it, reconnecting
  with a backoff (1 s doubling to 30 s), unfiltered if the machine refuses the type list. `/api/event` cannot filter by
  session, so each task keeps the events of its session and of the subagent sessions created under it
  (`session.created` with a known `parentID`). Each (re)connection starts with `server.connected`, after which a task
  reconciles with the machine: its session (404 means `lost`), usage, pending permissions and questions, and whether
  the execution it followed ended meanwhile. Hub streams are tagged `hub-user:<id>` in the tunnel, so a recheck keeps
  them as long as that user may open the machine (a browser session's tag is checked against the session).
- **End**: on `session.execution.succeeded|failed|interrupted` of the task's session, the end is claimed first (status
  written before anything is read, so a repeated end is ignored), then the final text (60 000 characters at most) is
  read, the task's images counted (`images`), and the end told once to the chat's model: a synthetic message with
  `delivery: queue`, metadata `{ source: "hub-machine", kind: "task", task, machine, title, model?, state, images? }`
  and an id (`msg_…`) chosen and stored in `notify_id` before sending, so a retry after a failure or a hub restart is
  ignored by the engine if it already got it. `notified_at` marks delivery. No notification when a tool call was
  waiting for that end (it gets the result) or when the model itself stopped the task.
- **Who hears of it**: the message carries `resume: true` only when the chat's model started or last wrote to the task
  (`machine_task`, `machine_task_send`, `continue`); then the model answers it at once. An execution the user started
  from the task's panel (its composer) or from the hub's composer (`/command`, `!shell`) is recorded with
  `resume: false`: the model reads it at its next turn instead of being woken by every follow-up the user types. The
  origin is kept in memory per task (`model` after a restart).
- **Restart**: at start the hub follows every `starting`/`running`/`waiting`/`offline` task again (a task still
  `starting` without a session fails), and every minute retries undelivered notifications and forgets tasks ended more
  than 30 days ago. Deleting a chat session forgets its tasks and target.
- **Usage**: `session.usage.updated` of the task's sessions (cumulative per session) are summed into `tokens_*` and
  `cost`. Exact metering in the LLM proxy, and quotas, are not done.
- **Tools** (`hub/chat-tools.ts`), all limited to the calling conversation's tasks: `machine_task { prompt, model?,
  variant?, template?, images?, machine?, directory?, agent?, continue?, wait_seconds? }`, `machine_tasks_wait`,
  `models_list`, `templates_list`, `machine_tasks_list { scope?: session | all }`, `machine_task_status { task, wait_seconds? }` (status, usage, pending
  permissions and questions), `machine_task_read { task, limit? }` (a digest of the latest messages, 20 000 characters),
  `machine_task_send { task, text, delivery?, model?, variant? }`, `machine_task_stop`, `machines_list`, `machine_task_permissions`,
  `machine_task_reply_permission { task, request, decision, session? }`, `machine_task_answer { task, question,
answer?, session? }` (the system prompt allows these two only when the user asked the model to pilot the task; each
  answer is logged), `machine_task_images` and `machine_task_image { task, index? }` (an MCP image, 5 MB at most, only
  for a chat model whose capabilities include image input; otherwise a description). The engine's MCP timeout is 15
  minutes.
- **Routes** (`/hub/api/`, the user's own tasks only; another user's answer 404):

  | Route                                                                                                             | What                                                                                                                                                                                                                                                                                                                        |
  | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `GET chat-tasks?session=`                                                                                         | tasks, newest first, of one chat session or all                                                                                                                                                                                                                                                                             |
  | `POST chat-tasks { session, prompt \| command \| shell, kind?, machine?, directory?, agent?, model?, template? }` | starts a task (a prompt, a slash command or one shell command), as the user                                                                                                                                                                                                                                                 |
  | `GET chat-models`                                                                                                 | the models the user can run, as the engine lists them, kept to their providers                                                                                                                                                                                                                                              |
  | `GET\|POST chat-templates`, `PUT\|DELETE chat-templates/<id>`                                                     | the user's agent templates                                                                                                                                                                                                                                                                                                  |
  | `GET chat-tasks/events`                                                                                           | SSE: `server.connected`, then `hub.task.updated { data: task }` for every change                                                                                                                                                                                                                                            |
  | `GET chat-tasks/<id>`                                                                                             | the task                                                                                                                                                                                                                                                                                                                    |
  | `GET chat-tasks/<id>/api/event`                                                                                   | SSE: `server.connected`, `hub.task.updated`, then the task's slice of the machine's events, unchanged (another `server.connected` when the machine's stream came back)                                                                                                                                                      |
  | `GET chat-tasks/<id>/api/…`                                                                                       | closed list of reads: `session/<s>` and its `message`, `message/<m>`, `inbox`, `permission`, `form`, `form/<f>` for the task's sessions only; `session/active` filtered to them; `session?parentID=`; `experimental/media/<hash>`; `location`, `vcs`, `agent` at the task's folder. Anything else 404; any other method 405 |
  | `DELETE chat-tasks/<id>/run`, `POST …/background`                                                                 | interrupt the task's session, move its tools to the background                                                                                                                                                                                                                                                              |
  | `POST chat-tasks/<id>/prompt { text, delivery? }`                                                                 | steer or queue                                                                                                                                                                                                                                                                                                              |
  | `POST chat-tasks/<id>/permission/<request> { decision, session? }`                                                | answer a permission (`once`, `always`, `reject`)                                                                                                                                                                                                                                                                            |
  | `POST chat-tasks/<id>/form/<form> { answer, session? }`, `DELETE … { session? }`                                  | answer or dismiss a question                                                                                                                                                                                                                                                                                                |
  | `GET chat-tasks/<id>/image/<n>`                                                                                   | the task's n-th image, newest first                                                                                                                                                                                                                                                                                         |

  Bodies are rebuilt field by field; `session` must be one of the task's sessions. A browser's stream sends frames as
  they come while it keeps up; once it is behind (its `ReadableStream` buffer exhausted), consecutive `session.text.delta`,
  `session.reasoning.delta` and `session.tool.input.delta` of one part are merged into one frame flushed every 50 ms,
  and any other frame flushes what is held first, so order is kept. A browser more than 8 MB behind gets
  `hub.task.resync` and is cut (it reconnects and reads again); 8 browsers per task at most. The tunnel itself still
  has no flow control.

- **Browser** (`packages/app/src/hub/`): the `machine_task` call shows as OpenCode's subagent card (machine, model
  and template on its first line, title and cost on the second, then thumbnails of up to 4 of the task's images served
  by `chat-tasks/<id>/image/<n>`), and the end notification as the subagent's outcome notice; both open the task's
  right panel. The hub's timeline keeps `subagents: separate` whatever the user's detail level, so the cards never
  fold into a tool group. A strip above the composer lists the conversation's running tasks (status, machine, model,
  cost; a click opens the panel) with "Stop all tasks". `/command` and `!shell` start a task and open its panel. The
  panel (`chat-task-panel.tsx`): an `OpenCode` client on `chat-tasks/<id>`, `createClientConnection` on its event
  route, `createData` and `SessionTimeline` with tool images kept, the permission dock and a question dock driven by
  OpenCode's question machine, a composer (Enter sends with the follow-up setting, Mod+Enter steers, Alt+Enter
  queues; none for a shell task), Stop, Background, a link to the machine, status, model and usage. A subagent card
  in the panel opens that child session in place, with a Back button (the panel keeps a stack). Its connection is
  the machine in `task-panel-machine.ts`. Running tasks of every conversation are listed in the sidebar; a task that
  ends, fails or waits is announced like a session. Below 768 px the panel covers the chat, with its own close
  button. Settings has an "Agent templates" page.

## Library API (`@opencode/relay`)

```ts
Hub.start(options: { hostname?: string; port?: number; url: string; data: string; mcp?: { privateNetworks?: boolean } })
  -> Promise<{ url: string; port: number; userCount(): number; invite(role): { url, expiresAt };
       createEnrollmentCode(userID, orgID?): { code, expiresAt }; stop(): Promise<void> }>
Hub.invite(input: { data: string; role: "admin" | "user"; orgs?: string[] /* names */ }) -> { url: string; expiresAt: number }
Agent.enroll(input: { url: string; code: string; name: string }) -> Promise<Enrollment>
Agent.connect(input: {
  enrollment: Enrollment
  instances?: { iid: string; token: string; skills?: string }[] // tokens already held and skills written, for HELLO
  local: (iid: string) => Promise<{ url: string; password?: string }>
  onReady?: (ready: Ready) => void
  onInstance?: (instance: Instance /* token always set */) => void
  onSkills?: (skills: Skills) => Promise<void> | void // the version is announced once it resolves
  onDrop?: (iid: string) => void
  onStatus?: (status: "connecting" | "connected" | "disconnected", detail?: string) => void
}) -> { close(): Promise<void> }
Instances.create(input: { root: string; command: string[]; env?; cwd?; log? }) // `@opencode/relay/agent/instances`
  -> { configure(instance), local(iid), skills(payload), drop(iid), prune(validIids), running(iid), stop() }
AgentSkills.write(dir, payload) / remove(dir) / manifest(dir) / reload(local) // `@opencode/relay/agent/skills`
```

## Out of scope for the first version

Flow control in the tunnel, a queue for prompts sent while a machine is offline, mTLS, OAuth-based providers in the
LLM proxy. In the hub chat: usage metered in the LLM proxy and quotas, a task's inbox, an automatic answer to a
permission nobody answered, agent templates written as agent definitions on the machines (they travel as a message
today), and keeping a task's origin (model or user) across a hub restart.
