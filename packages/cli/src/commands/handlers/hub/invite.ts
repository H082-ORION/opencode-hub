import { EOL } from "os"
import path from "path"
import { Effect, Option } from "effect"
import { Global } from "@opencode/util/global"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"

export default Runtime.handler(
  Commands.commands.hub.commands.invite,
  Effect.fn("cli.hub.invite")(function* (input) {
    const { Hub } = yield* Effect.promise(() => import("@opencode/relay"))
    const global = yield* Global.Service
    const invitation = yield* Effect.try(() =>
      Hub.invite({
        data: Option.getOrElse(input.data, () => path.join(global.data, "hub")),
        role: input.admin ? "admin" : "user",
      }),
    )
    const role = input.admin ? "an administrator" : "a user"
    process.stdout.write(
      `Invitation for ${role}, valid once until ${new Date(invitation.expiresAt).toISOString()}:${EOL}` +
        `${invitation.url}${EOL}`,
    )
  }),
)
