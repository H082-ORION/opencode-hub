import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client/promise"
import { Option, Schema } from "effect"

// What the relay records in a synthetic message's metadata once a command or shell command run on the attached machine
// ends (packages/relay/src/hub/chat-machines.ts). The model reads the message's text.
const Run = Schema.Struct({
  source: Schema.Literal("hub-machine"),
  kind: Schema.Literals(["shell", "command"]),
  command: Schema.String,
  state: Schema.Literals(["completed", "error", "cancelled"]),
  output: Schema.String,
  exit: Schema.optional(Schema.Number),
  truncated: Schema.optional(Schema.Boolean),
})
const decodeRun = Schema.decodeUnknownOption(Run)

/**
 * The timeline shows a synthetic message as a one-line notice, which would hide what a run on the machine printed. For
 * display only, a shell command becomes a shell message, like OpenCode's own `!command`, and a slash command becomes
 * the user's command followed by the machine's answer.
 */
export function showMachineRuns(messages: readonly SessionMessageInfo[]) {
  return messages.flatMap((message, index): SessionMessageInfo[] => {
    if (message.type !== "synthetic") return [message]
    const run = Option.getOrUndefined(decodeRun(message.metadata))
    if (!run) return [message]
    const time = message.time.created
    if (run.kind === "shell")
      return [
        {
          id: message.id,
          type: "shell",
          shellID: message.id,
          command: run.command,
          status: run.state === "cancelled" ? "killed" : "exited",
          exit: run.exit,
          output: {
            output: run.output,
            cursor: run.output.length,
            size: run.output.length,
            truncated: !!run.truncated,
          },
          time: { created: time, completed: time },
        },
      ]
    // The answer is credited to the agent and model of the conversation's last answer.
    const last = messages.slice(0, index).findLast((item): item is SessionMessageAssistant => item.type === "assistant")
    return [
      { id: message.id, type: "user", text: run.command, time: { created: time } },
      {
        id: `${message.id}-answer`,
        type: "assistant",
        agent: last?.agent ?? "build",
        model: last?.model ?? { id: "", providerID: "" },
        content: [{ type: "text", text: run.output }],
        finish: "stop",
        time: { created: time, completed: time },
      },
    ]
  })
}
