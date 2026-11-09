import { EOL } from "os"
import path from "path"
import { Effect, Option } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { load } from "../../../app-assets"
import { selfCommand } from "../../../util/process"
import { OPENCODE_VERSION } from "../../../version"

export default Runtime.handler(
  Commands.commands.hub,
  Effect.fn("cli.hub")(function* (input) {
    const { Hub } = yield* Effect.promise(() => import("@opencode/relay"))
    const global = yield* Global.Service
    // A source checkout without a built app still starts; the hub then explains how to build the dashboard.
    const assets = yield* load().pipe(Effect.option)
    const ui = Option.map(assets, (loaded) => ({
      file(key: string) {
        const body = loaded.files[key]
        return body === undefined ? undefined : { body, type: FSUtil.mimeType(key) }
      },
    }))
    const data = Option.getOrElse(input.data, () => path.join(global.data, "hub"))
    const self = selfCommand()
    const hub = yield* Effect.acquireRelease(
      Effect.tryPromise(() =>
        Hub.start({
          hostname: input.hostname,
          port: input.port,
          url: Option.getOrElse(input.url, () => `http://localhost:${input.port}`),
          data,
          ui: Option.getOrUndefined(ui),
          version: OPENCODE_VERSION,
          mcp: { privateNetworks: input.mcpPrivateNetwork },
          // A source checkout runs through Bun, which reads the CLI's bunfig.toml from the working directory.
          chat: { command: [...self, "serve"], cwd: self.length > 1 ? process.cwd() : undefined },
        }),
      ),
      (hub) => Effect.promise(() => hub.stop()),
    )
    process.stdout.write(`Hub listening on ${hub.url}${EOL}`)
    // A hub without accounts needs its first administrator. In a terminal the invitation link is printed; elsewhere
    // (a systemd service writing to the journal) only the command that creates one, so no live link lands in a log.
    if (hub.userCount() === 0)
      process.stdout.write(
        process.stdout.isTTY
          ? `No account yet. Open this one-time link to create the first administrator:${EOL}${hub.invite("admin").url}${EOL}`
          : `No account yet. Create the first administrator's invitation with: opencode hub invite --admin --data ${data}${EOL}`,
      )
    return yield* Effect.never
  }, Effect.scoped),
)
