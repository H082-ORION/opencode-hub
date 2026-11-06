import { PRESETS } from "./llm.js"
import type { Machine, Provider } from "./store.js"

export * as Html from "./html.js"

const STYLE = `
:root { color-scheme: light dark; --bg: #fafafa; --fg: #18181b; --muted: #71717a; --card: #fff; --border: #e4e4e7;
  --accent: #18181b; --accent-fg: #fff; --danger: #b91c1c; --ok: #15803d; }
@media (prefers-color-scheme: dark) { :root { --bg: #0b0b0c; --fg: #f4f4f5; --muted: #a1a1aa; --card: #18181b;
  --border: #27272a; --accent: #f4f4f5; --accent-fg: #18181b; --danger: #f87171; --ok: #4ade80; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 32px 16px 64px; }
header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
h1 { font-size: 20px; margin: 0; } h2 { font-size: 16px; margin: 0 0 12px; }
section { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin-bottom: 20px; }
table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 8px 6px; border-top: 1px solid var(--border); vertical-align: middle; }
th { font-weight: 600; color: var(--muted); font-size: 13px; border-top: 0; }
.muted { color: var(--muted); } .ok { color: var(--ok); } .error { color: var(--danger); }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
pre { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
form.inline { display: inline; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; align-items: end; }
label { display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
input, select { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 7px 9px; width: 100%; }
button, .button { font: inherit; cursor: pointer; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-fg);
  border-radius: 6px; padding: 7px 12px; text-decoration: none; display: inline-block; }
button.secondary { background: transparent; color: var(--fg); border-color: var(--border); }
button.danger { background: transparent; color: var(--danger); border-color: var(--border); }
.code { font-size: 28px; letter-spacing: 3px; font-weight: 700; margin: 4px 0 12px; }
.center { max-width: 380px; margin: 12vh auto 0; }
`

export function escape(value: string | number) {
  return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`
}

export function respond(body: string, init?: { status?: number }) {
  return new Response(body, {
    status: init?.status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" },
  })
}

export function login(input: { next?: string; error?: string }) {
  return page(
    "Sign in · opencode hub",
    `<section class="center">
  <h1>opencode hub</h1>
  <p class="muted">Enter the hub password to continue.</p>
  ${input.error ? `<p class="error">${escape(input.error)}</p>` : ""}
  <form method="post" action="/login">
    <input type="hidden" name="next" value="${escape(input.next ?? "")}">
    <label>Password <input type="password" name="password" autocomplete="current-password" autofocus required></label>
    <p><button type="submit">Sign in</button></p>
  </form>
</section>`,
  )
}

type MachineList = {
  machines: Machine[]
  online: (id: string) => boolean
  machineURL: (id: string) => string
}

/** The machines table alone; the dashboard polls it so enrollments and connections show up without a reload. */
export function machines(input: MachineList) {
  return input.machines.length
    ? `<table>
  <tr><th>Name</th><th>ID</th><th>Status</th><th>Last seen</th><th></th></tr>
  ${input.machines
    .map(
      (machine) => `<tr>
    <td>${escape(machine.name)}</td>
    <td><code>${escape(machine.id)}</code></td>
    <td>${input.online(machine.id) ? `<span class="ok">online</span>` : `<span class="muted">offline</span>`}</td>
    <td class="muted">${machine.last_seen_at ? escape(formatTime(machine.last_seen_at)) : "never"}</td>
    <td>
      <a class="button" href="/hub/handoff?next=${escape(encodeURIComponent(input.machineURL(machine.id)))}">Open</a>
      <form class="inline" method="post" action="/machines/${escape(encodeURIComponent(machine.id))}/revoke"
        onsubmit="return confirm('Revoke this machine? It will be disconnected and must join again.')">
        <button class="danger" type="submit">Revoke</button>
      </form>
    </td>
  </tr>`,
    )
    .join("")}
</table>`
    : `<p class="muted">No machines yet.</p>`
}

export function dashboard(
  input: MachineList & {
    url: string
    providers: Provider[]
    code?: { code: string; expiresAt: number }
    error?: string
  },
) {
  const code = input.code
    ? `<p>One-time code, valid until ${escape(formatTime(input.code.expiresAt))}:</p>
<div class="code">${escape(input.code.code)}</div>
<p>Run this on the machine:</p>
<pre>opencode agent join ${escape(input.url)} --code ${escape(input.code.code)}</pre>`
    : `<form method="post" action="/machines/code"><button type="submit">Add machine</button></form>`

  const providers = input.providers.length
    ? `<table>
  <tr><th>ID</th><th>Name</th><th>Upstream</th><th></th></tr>
  ${input.providers
    .map(
      (provider) => `<tr>
    <td><code>${escape(provider.id)}</code></td>
    <td>${escape(provider.name)}</td>
    <td class="muted">${escape(provider.base_url)}</td>
    <td><form class="inline" method="post" action="/providers/${escape(encodeURIComponent(provider.id))}/delete">
      <button class="danger" type="submit">Delete</button></form></td>
  </tr>`,
    )
    .join("")}
</table>`
    : `<p class="muted">No providers. Machines keep using their own provider configuration.</p>`

  return page(
    "opencode hub",
    `<header>
  <h1>opencode hub</h1>
  <form method="post" action="/logout"><button class="secondary" type="submit">Sign out</button></form>
</header>
${input.error ? `<section><p class="error">${escape(input.error)}</p></section>` : ""}
<section>
  <h2>Machines</h2>
  <div id="machines">${machines(input)}</div>
</section>
<section>
  <h2>Add a machine</h2>
  ${code}
</section>
<section>
  <h2>LLM providers</h2>
  <p class="muted">Machines call providers through the hub, so API keys never leave it. The id must match the opencode provider id.</p>
  ${providers}
  <h2 style="margin-top:20px">Add or replace a provider</h2>
  <form method="post" action="/providers" class="grid">
    <label>Preset
      <select name="preset">
        ${PRESETS.map((preset) => `<option value="${escape(preset.id)}">${escape(preset.name)}</option>`).join("")}
        <option value="">Custom</option>
      </select>
    </label>
    <label>ID (custom) <input name="id" placeholder="my-provider"></label>
    <label>Name (optional) <input name="name"></label>
    <label>Upstream base URL (custom) <input name="baseURL" placeholder="https://api.example.com/v1"></label>
    <label>API key <input name="apiKey" type="password" autocomplete="off" required></label>
    <div><button type="submit">Save provider</button></div>
  </form>
</section>
<script>
// Manual redirects keep an expired session from swapping the login page into the table.
const state = { last: "" }
setInterval(async () => {
  const response = await fetch("/hub/machines", { cache: "no-store", redirect: "manual" }).catch(() => undefined)
  if (!response || !response.ok) return
  const html = await response.text()
  if (html === state.last) return
  state.last = html
  document.getElementById("machines").innerHTML = html
}, 3000)
</script>`,
  )
}

export function message(title: string, body: string) {
  return page(title, `<section class="center"><h1>${escape(title)}</h1>${body}</section>`)
}

function formatTime(time: number) {
  return `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`
}
