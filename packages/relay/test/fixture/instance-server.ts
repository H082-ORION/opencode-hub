// A stand-in for `opencode serve --stdio --port 0`: it reports its URL as the first stdout line, answers with the
// environment it was started with, checks the Basic password like the real server, and stops when stdin closes.
const password = process.env.OPENCODE_PASSWORD ?? ""
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    if (request.headers.get("authorization") !== `Basic ${btoa(`opencode:${password}`)}`)
      return new Response("unauthorized", { status: 401 })
    return Response.json({
      pid: process.pid,
      cwd: process.cwd(),
      args: process.argv.slice(2),
      data: process.env.XDG_DATA_HOME,
      config: process.env.XDG_CONFIG_HOME,
      state: process.env.XDG_STATE_HOME,
      cache: process.env.XDG_CACHE_HOME,
      token: process.env.OPENCODE_HUB_LLM_TOKEN,
      content: process.env.OPENCODE_CONFIG_CONTENT,
      leaked: process.env.OPENCODE_CONFIG_DIR,
    })
  },
})
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}` }))
process.stdin.on("end", () => {
  server.stop(true)
  process.exit(0)
})
process.stdin.resume()
