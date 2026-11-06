import { EOL } from "os"
import path from "path"
import { Effect, Option } from "effect"
import { Global } from "@opencode/util/global"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"

export default Runtime.handler(
  Commands.commands.hub,
  Effect.fn("cli.hub")(function* (input) {
    const { Hub } = yield* Effect.promise(() => import("@opencode/relay"))
    const global = yield* Global.Service
    const hub = yield* Effect.acquireRelease(
      Effect.tryPromise(() =>
        Hub.start({
          hostname: input.hostname,
          port: input.port,
          url: Option.getOrElse(input.url, () => `http://localhost:${input.port}`),
          data: Option.getOrElse(input.data, () => path.join(global.data, "hub")),
        }),
      ),
      (hub) => Effect.promise(() => hub.stop()),
    )
    process.stdout.write(`Hub listening on ${hub.url}${EOL}`)
    return yield* Effect.never
  }, Effect.scoped),
)
