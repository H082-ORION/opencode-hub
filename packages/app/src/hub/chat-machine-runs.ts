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

/** The tool the hub's chat starts a task on a machine with, as the engine names it. */
const TASK_TOOL = "hub-tools_machine_task"
const decodeHandle = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ task: Schema.String })))
const decodeTaskInput = Schema.decodeUnknownOption(
  Schema.Struct({ prompt: Schema.optional(Schema.String), machine: Schema.optional(Schema.String) }),
)
// What the relay records once a task's execution ended, for the model (packages/relay/src/hub/chat-tasks.ts).
const decodeTaskEnd = Schema.decodeUnknownOption(
  Schema.Struct({
    source: Schema.Literal("hub-machine"),
    kind: Schema.Literal("task"),
    task: Schema.String,
    machine: Schema.String,
    title: Schema.String,
    state: Schema.Literals(["completed", "error", "cancelled"]),
  }),
)

/** How a task's card reads: its agent line, the line under it, and the images its tools produced, by URL. */
export type TaskLabel = { agent: string; description: string; images?: readonly { uri: string; name?: string }[] }

/**
 * For display only, OpenCode's subagent card stands for a task handed to a machine: the same card, progress and
 * click, pointing at the task (its id takes the place of the subagent's session), so the hub opens the task's panel.
 * The images the task produced show under the card as a tool's images do. The message that tells the model a task
 * ended becomes the subagent's compact outcome notice, which opens it too.
 */
export function showMachineTasks(
  messages: readonly SessionMessageInfo[],
  label: (task: string | undefined, fallback: TaskLabel) => TaskLabel,
) {
  return messages.map((message): SessionMessageInfo => {
    if (message.type === "synthetic") {
      const ended = Option.getOrUndefined(decodeTaskEnd(message.metadata))
      if (!ended) return message
      return {
        ...message,
        description: ended.title,
        metadata: { source: "subagent", agent: ended.machine, state: ended.state, childID: ended.task },
      }
    }
    if (
      message.type !== "assistant" ||
      !message.content.some((part) => part.type === "tool" && part.name === TASK_TOOL)
    )
      return message
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool" || part.name !== TASK_TOOL) return part
        if (part.state.status === "streaming") return { ...part, name: "subagent" }
        const input = Option.getOrUndefined(decodeTaskInput(part.state.input))
        const text =
          part.state.status === "running" ? undefined : part.state.content?.find((item) => item.type === "text")
        const task = text?.type === "text" ? Option.getOrUndefined(decodeHandle(text.text))?.task : undefined
        const shown = label(task, {
          agent: input?.machine ?? "",
          description: input?.prompt?.trim().split("\n")[0] ?? "",
        })
        const state = { ...part.state, input: { agent: shown.agent, description: shown.description } }
        if (state.status === "running") return { ...part, name: "subagent", state }
        const metadata: Record<string, string> = task ? { sessionID: task } : {}
        const images = (shown.images ?? []).map((image) => ({ type: "file" as const, mime: "image/*", ...image }))
        if (!state.content || images.length === 0) return { ...part, name: "subagent", state: { ...state, metadata } }
        return { ...part, name: "subagent", state: { ...state, metadata, content: [...state.content, ...images] } }
      }),
    }
  })
}
