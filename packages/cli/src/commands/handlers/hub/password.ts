import { EOL } from "os"
import path from "path"
import { Effect, Option } from "effect"
import { Global } from "@opencode/util/global"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"

export default Runtime.handler(
  Commands.commands.hub.commands.password,
  Effect.fn("cli.hub.password")(function* (input) {
    const { Hub } = yield* Effect.promise(() => import("@opencode/relay"))
    const global = yield* Global.Service
    const password = yield* Effect.tryPromise(() =>
      Hub.setPassword({ data: Option.getOrElse(input.data, () => path.join(global.data, "hub")) }),
    )
    process.stdout.write(
      `New hub password: ${password}${EOL}` + `OPENCODE_HUB_PASSWORD, when set, takes precedence over it.${EOL}`,
    )
  }),
)
