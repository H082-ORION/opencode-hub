import { EOL, hostname } from "os"
import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { RelayAgent } from "../../../services/relay-agent"

export default Runtime.handler(
  Commands.commands.agent.commands.join,
  Effect.fn("cli.agent.join")(function* (input) {
    const { Agent } = yield* Effect.promise(() => import("@opencode/relay"))
    const enrollment = yield* Effect.tryPromise(() =>
      Agent.enroll({ url: input.url, code: input.code, name: Option.getOrElse(input.name, () => hostname()) }),
    )
    yield* RelayAgent.write(enrollment)
    process.stdout.write(
      `Enrolled as ${enrollment.machine.name} (${enrollment.machine.id}) with ${enrollment.url}${EOL}` +
        `Run \`opencode agent run\` to connect.${EOL}`,
    )
  }),
)
