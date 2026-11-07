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
    const invitation = yield* Effect.try({
      try: () =>
        Hub.invite({
          data: Option.getOrElse(input.data, () => path.join(global.data, "hub")),
          role: input.admin ? "admin" : "user",
          orgs: input.org,
        }),
      // An unknown organization name is the user's mistake: report its message, not a wrapped stack.
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    })
    const role = input.admin ? "an administrator" : "a user"
    const orgs = input.org.length > 0 ? ` joining ${input.org.join(", ")}` : ""
    process.stdout.write(
      `Invitation for ${role}${orgs}, valid once until ${new Date(invitation.expiresAt).toISOString()}:${EOL}` +
        `${invitation.url}${EOL}`,
    )
  }),
)
