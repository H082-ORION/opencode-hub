import { EOL } from "os"
import path from "path"
import { Effect, Option } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { load } from "../../../app-assets"
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
    const hub = yield* Effect.acquireRelease(
      Effect.tryPromise(() =>
        Hub.start({
          hostname: input.hostname,
          port: input.port,
          url: Option.getOrElse(input.url, () => `http://localhost:${input.port}`),
          data: Option.getOrElse(input.data, () => path.join(global.data, "hub")),
          ui: Option.getOrUndefined(ui),
          version: OPENCODE_VERSION,
        }),
      ),
      (hub) => Effect.promise(() => hub.stop()),
    )
    process.stdout.write(`Hub listening on ${hub.url}${EOL}`)
    return yield* Effect.never
  }, Effect.scoped),
)
