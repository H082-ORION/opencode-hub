import { EOL, hostname } from "os"
import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { RelayAgent } from "../../../services/relay-agent"
import { prompt } from "../../../ui/prompt"
import { readStdin } from "../../../util/io"

export default Runtime.handler(
  Commands.commands.agent.commands.join,
  Effect.fn("cli.agent.join")(function* (input) {
    const { Agent } = yield* Effect.promise(() => import("@opencode/relay"))
    // Checked before asking for the code, so nobody types it for a hub it would not be sent to.
    if (!input.insecure && !Agent.isSecureURL(input.url)) {
      return yield* Effect.fail(
        new Error(
          `refusing to send the enrollment code in clear text to ${input.url}: use an https:// hub URL, or pass --insecure`,
        ),
      )
    }
    const code = Option.isSome(input.code) ? input.code.value : yield* readCode()
    const enrollment = yield* Effect.tryPromise(() =>
      Agent.enroll({
        url: input.url,
        code,
        name: Option.getOrElse(input.name, () => hostname()),
        insecure: input.insecure,
      }),
    )
    yield* RelayAgent.write(enrollment)
    process.stdout.write(
      `Enrolled as ${enrollment.machine.name} (${enrollment.machine.id}) with ${enrollment.url}${EOL}` +
        `Run \`opencode agent run\` to connect.${EOL}`,
    )
  }),
)

// Without --code, the code stays out of the process list and the shell history: asked without echo on a terminal,
// otherwise read from stdin (`printf '%s\n' "$CODE" | opencode agent join <url>`).
const readCode = Effect.fn("cli.agent.join.code")(function* () {
  if (process.stdin.isTTY) {
    const { password } = yield* Effect.promise(() => import("@clack/prompts"))
    return yield* prompt<string>(() =>
      password({ message: "Enrollment code", validate: (value) => (!value?.trim() ? "Required" : undefined) }),
    )
  }
  const code = (yield* Effect.promise(() => readStdin())).split(/\r?\n/)[0]?.trim()
  if (!code) return yield* Effect.fail(new Error("no enrollment code: pass --code, or write it on stdin"))
  return code
})
