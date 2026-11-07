import { EOL } from "os"
import { Service } from "@opencode/client/effect/service"
import { Effect, FileSystem, Queue } from "effect"
import { Global } from "@opencode/util/global"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { RelayAgent } from "../../../services/relay-agent"
import { ServiceConfig } from "../../../services/service-config"
import { errorMessage } from "../../../util/error"
import { selfCommand } from "../../../util/process"

/** A change to the personal instance, which is the background service itself. */
type Change = { kind: "apply"; instance: RelayAgent.Instance } | { kind: "clear"; iid: string }

export default Runtime.handler(
  Commands.commands.agent.commands.run,
  Effect.fn("cli.agent.run")(function* () {
    const { Agent } = yield* Effect.promise(() => import("@opencode/relay"))
    const { Instances } = yield* Effect.promise(() => import("@opencode/relay/agent/instances"))
    const enrollment = yield* RelayAgent.read()
    if (!enrollment)
      return yield* Effect.fail(new Error("Not enrolled. Run `opencode agent join <url> --code <code>` first."))
    if ((yield* ServiceConfig.read()).disabled)
      return yield* Effect.fail(
        new Error("The background service is disabled. Run `opencode service set disabled false` first."),
      )
    yield* Service.ensure(yield* ServiceConfig.options())
    const run = Effect.runPromiseWith(yield* Effect.context<FileSystem.FileSystem | Global.Service>())
    // An organization machine runs one opencode server per member, children of this agent; they stop with it.
    const instances = yield* Effect.acquireRelease(
      Effect.map(RelayAgent.instancesRoot(), (root) =>
        Instances.create({ root, command: [...selfCommand(), "serve"], log }),
      ),
      (manager) => Effect.promise(() => manager.stop()),
    )
    const owner = { kind: undefined as "user" | "org" | undefined }
    // Only the latest change matters; applying one may restart the service, so they apply one at a time.
    const changes = yield* Queue.sliding<Change>(1)
    const stopped = Promise.withResolvers<string>()
    yield* Queue.take(changes).pipe(
      Effect.flatMap((change) =>
        change.kind === "apply" ? RelayAgent.apply(change.instance) : RelayAgent.clear(change.iid),
      ),
      Effect.tap((changed) => Effect.sync(() => changed && log("Updated the background service's hub configuration"))),
      Effect.catch((error) => Effect.sync(() => log(`Failed to apply the hub configuration: ${errorMessage(error)}`))),
      Effect.forever,
      Effect.forkScoped,
    )
    const report = (action: string) => (error: unknown) => log(`Failed to ${action}: ${errorMessage(error)}`)
    yield* Effect.acquireRelease(
      Effect.map(RelayAgent.held(), (held) =>
        Agent.connect({
          enrollment,
          instances: held,
          local: (iid) =>
            owner.kind === "org"
              ? instances.local(iid)
              : // The personal instance is the background service. Each call re-reads the saved environment and
                // ensures the service, so a restart or crash is recovered.
                run(
                  ServiceConfig.options().pipe(
                    Effect.flatMap(Service.ensure),
                    Effect.map((endpoint) => ({ url: endpoint.url, password: endpoint.auth?.password })),
                  ),
                ),
          onReady: (ready) => {
            owner.kind = ready.owner
            log(
              `Ready as ${ready.machine.name} (${ready.machine.id}), ${ready.owner === "org" ? "organization" : "personal"} machine`,
            )
            // Instance folders the hub no longer knows, e.g. members removed while this agent was offline.
            instances.prune(ready.instances).catch(report("delete stale instances"))
          },
          onInstance: (instance) => {
            if (owner.kind === "org") return void instances.configure(instance).catch(report("configure an instance"))
            Queue.offerUnsafe(changes, { kind: "apply", instance })
          },
          onDrop: (iid) => {
            log(`Dropping instance ${iid}`)
            if (owner.kind === "org") return void instances.drop(iid).catch(report("delete an instance"))
            Queue.offerUnsafe(changes, { kind: "clear", iid })
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
