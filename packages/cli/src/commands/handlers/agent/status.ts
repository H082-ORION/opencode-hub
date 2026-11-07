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
        `hub       ${enrollment.url}`,
        `machine   ${enrollment.machine.name} (${enrollment.machine.id})`,
        `file      ${yield* RelayAgent.file()}`,
        // An organization machine keeps each member's instance here; instance tokens live only in memory.
        `instances ${yield* RelayAgent.instancesRoot()}`,
      ].join(EOL) + EOL,
    )
  }),
)
