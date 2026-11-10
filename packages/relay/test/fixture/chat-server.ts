// A stand-in for the opencode server behind the hub's chat: it reports its URL as the first stdout line, echoes what
// the hub forwarded with the environment it was started with, lists one model of the hub's provider and one that is
// not, and stops when stdin closes. Each echo also lists the writes received before it, oldest first.
const password = process.env.OPENCODE_PASSWORD ?? ""
const writes: { method: string; path: string; body: unknown }[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.headers.get("authorization") !== `Basic ${btoa(`opencode:${password}`)}`)
      return new Response("unauthorized", { status: 401 })
    const url = new URL(request.url)
    if (url.pathname === "/api/model")
      return Response.json({
        data: [
          { id: "real", providerID: "fake" },
          { id: "free", providerID: "opencode" },
        ],
      })
    const body = request.method === "GET" ? undefined : await request.json().catch(() => undefined)
    const history = writes.slice()
    if (request.method !== "GET") writes.push({ method: request.method, path: url.pathname, body })
    return Response.json({
      method: request.method,
      path: url.pathname,
      search: url.search,
      body,
      history,
      pid: process.pid,
      token: process.env.OPENCODE_HUB_LLM_TOKEN,
      content: process.env.OPENCODE_CONFIG_CONTENT,
      secret: process.env.CHAT_TEST_SECRET,
    })
  },
})
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}` }))
process.stdin.on("end", () => {
  server.stop(true)
  process.exit(0)
})
process.stdin.resume()
