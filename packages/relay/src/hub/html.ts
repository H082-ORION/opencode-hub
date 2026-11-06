export * as Html from "./html.js"

// The dashboard is the app's `hub.html`; these plain pages cover machine hosts and a hub without the built web UI.
const STYLE = `
:root { color-scheme: light dark; --bg: #fafafa; --fg: #18181b; --muted: #71717a; --card: #fff; --border: #e4e4e7; }
@media (prefers-color-scheme: dark) { :root { --bg: #080808; --fg: #f4f4f5; --muted: #a1a1aa; --card: #141414; --border: #27272a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, -apple-system, sans-serif; }
main { max-width: 420px; margin: 14vh auto 0; padding: 0 16px; }
section { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 24px; }
h1 { font-size: 18px; margin: 0 0 8px; }
p { color: var(--muted); margin: 8px 0 0; }
a { color: inherit; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
`

export function escape(value: string | number) {
  return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

export function respond(body: string, init?: { status?: number }) {
  return new Response(body, {
    status: init?.status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  })
}

/** A small standalone page; `body` is trusted HTML, so callers escape what they interpolate. */
export function message(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${escape(title)} · opencode hub</title>
<style>${STYLE}</style>
</head>
<body><main><section><h1>${escape(title)}</h1>${body}</section></main></body>
</html>`
}
