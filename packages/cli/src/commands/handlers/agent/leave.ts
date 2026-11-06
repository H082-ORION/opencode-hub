import { EOL } from "os"
import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { RelayAgent } from "../../../services/relay-agent"

export default Runtime.handler(
  Commands.commands.agent.commands.leave,
  Effect.fn("cli.agent.leave")(function* () {
    const removed = yield* RelayAgent.remove()
    // Stop routing the background service's LLM calls through the hub.
    yield* RelayAgent.apply({ baseURL: "", providers: [] }, "")
    process.stdout.write(
      (removed
        ? "Forgot this machine's enrollment. Revoke it from the hub dashboard to invalidate its tokens."
        : "Not enrolled.") + EOL,
    )
  }),
)
