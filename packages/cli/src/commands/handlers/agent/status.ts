import { EOL } from "os"
import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { RelayAgent } from "../../../services/relay-agent"

export default Runtime.handler(
  Commands.commands.agent.commands.status,
  Effect.fn("cli.agent.status")(function* () {
    const enrollment = yield* RelayAgent.read()
    if (!enrollment) {
      process.stdout.write(`Not enrolled. Run \`opencode agent join <url> --code <code>\`.${EOL}`)
      return
    }
    process.stdout.write(
      [
        `hub      ${enrollment.url}`,
        `machine  ${enrollment.machine.name} (${enrollment.machine.id})`,
        `file     ${yield* RelayAgent.file()}`,
      ].join(EOL) + EOL,
    )
  }),
)
