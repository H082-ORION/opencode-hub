import { EOL } from "os"
import { Service } from "@opencode/client/effect/service"
import { Effect, FileSystem, Queue } from "effect"
import { Global } from "@opencode/util/global"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { RelayAgent } from "../../../services/relay-agent"
import { ServiceConfig } from "../../../services/service-config"
import { errorMessage } from "../../../util/error"

export default Runtime.handler(
  Commands.commands.agent.commands.run,
  Effect.fn("cli.agent.run")(function* () {
    const { Agent } = yield* Effect.promise(() => import("@opencode/relay"))
    const enrollment = yield* RelayAgent.read()
    if (!enrollment)
      return yield* Effect.fail(new Error("Not enrolled. Run `opencode agent join <url> --code <code>` first."))
    if ((yield* ServiceConfig.read()).disabled)
      return yield* Effect.fail(
        new Error("The background service is disabled. Run `opencode service set disabled false` first."),
      )
    yield* Service.ensure(yield* ServiceConfig.options())
    const run = Effect.runPromiseWith(yield* Effect.context<FileSystem.FileSystem | Global.Service>())
    // Only the latest provider list matters; applying one may restart the service, so they apply one at a time.
    const configs = yield* Queue.sliding<RelayAgent.LlmConfig>(1)
    const stopped = Promise.withResolvers<string>()
    yield* Queue.take(configs).pipe(
      Effect.flatMap((llm) => RelayAgent.apply(llm, enrollment.llmToken)),
      Effect.tap((changed) => Effect.sync(() => changed && log("Updated the background service's LLM providers"))),
      Effect.catch((error) => Effect.sync(() => log(`Failed to apply LLM providers: ${errorMessage(error)}`))),
      Effect.forever,
      Effect.forkScoped,
    )
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        Agent.connect({
          enrollment,
          // Each call re-reads the saved environment and ensures the service, so a restart or crash is recovered.
          local: () =>
            run(
              ServiceConfig.options().pipe(
                Effect.flatMap(Service.ensure),
                Effect.map((endpoint) => ({ url: endpoint.url, password: endpoint.auth?.password })),
              ),
            ),
          onReady: (ready) => {
            log(`Ready as ${ready.machine.name} (${ready.machine.id})`)
            Queue.offerUnsafe(configs, ready.llm)
          },
          onConfig: (llm) => {
            Queue.offerUnsafe(configs, llm)
          },
          onStatus: (status, detail) => {
            log(detail ? `${status}: ${detail}` : status)
            if (status === "stopped") stopped.resolve(detail ?? "refused by the hub")
          },
        }),
      ),
      (connection) => Effect.promise(() => connection.close()),
    )
    log(`Connecting to ${enrollment.url}`)
    const reason = yield* Effect.promise(() => stopped.promise)
    return yield* Effect.fail(new Error(`The hub stopped this agent: ${reason}`))
  }, Effect.scoped),
)

function log(message: string) {
  process.stdout.write(`${new Date().toISOString()} ${message}${EOL}`)
}
