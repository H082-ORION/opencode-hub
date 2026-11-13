import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { showMachineTasks } from "./chat-machine-runs"

// A `machine_task` call as the hub's engine records it: the MCP tool's text is the handle the relay answers with.
const call = (state: Record<string, unknown>) =>
  ({
    id: "msg_a",
    type: "assistant",
    agent: "hub",
    model: { id: "m", providerID: "p" },
    content: [
      { type: "text", text: "Starting it." },
      { type: "tool", id: "call_1", name: "hub-tools_machine_task", state, time: { created: 1 } },
    ],
    time: { created: 1 },
  }) as unknown as SessionMessageInfo

const label = (task: string | undefined, fallback: { agent: string; description: string }) =>
  task === "tsk_1" ? { agent: "Laptop", description: "Fix the tests · $0.12" } : fallback

describe("tasks in the hub's timeline", () => {
  test("a started task shows as a subagent card that opens it", () => {
    const [message] = showMachineTasks(
      [
        call({
          status: "completed",
          input: { prompt: "Fix the tests\nAll of them", machine: "laptop" },
          content: [{ type: "text", text: JSON.stringify({ task: "tsk_1", status: "running" }) }],
        }),
      ],
      label,
    )
    expect(message!.type === "assistant" ? message!.content : []).toEqual([
      { type: "text", text: "Starting it." },
      {
        type: "tool",
        id: "call_1",
        name: "subagent",
        state: {
          status: "completed",
          input: { agent: "Laptop", description: "Fix the tests · $0.12" },
          content: [{ type: "text", text: JSON.stringify({ task: "tsk_1", status: "running" }) }],
          metadata: { sessionID: "tsk_1" },
        },
        time: { created: 1 },
      },
    ])
  })

  test("a call still running, or refused, keeps what the model asked for", () => {
    const [running, refused] = showMachineTasks(
      [
        call({ status: "running", input: { prompt: "Fix it", machine: "laptop" }, metadata: {} }),
        call({ status: "error", input: { prompt: "Fix it" }, error: { type: "tool", message: "No machine" } }),
      ],
      label,
    )
    const tool = (message: SessionMessageInfo | undefined) =>
      message?.type === "assistant" ? message.content[1] : undefined
    expect(tool(running)).toMatchObject({
      name: "subagent",
      state: { input: { agent: "laptop", description: "Fix it" } },
    })
    expect(tool(refused)).toMatchObject({ name: "subagent", state: { status: "error", metadata: {} } })
  })

  test("the end told to the model shows as the subagent's outcome, which opens the task", () => {
    const [notice] = showMachineTasks(
      [
        {
          id: "msg_n",
          type: "synthetic",
          text: "Task tsk_1 on Laptop finished.\n\nDone",
          description: "Fix the tests — Laptop",
          metadata: {
            source: "hub-machine",
            kind: "task",
            task: "tsk_1",
            machine: "Laptop",
            title: "Fix the tests",
            state: "completed",
          },
          time: { created: 2 },
        } as SessionMessageInfo,
      ],
      label,
    )
    expect(notice).toMatchObject({
      type: "synthetic",
      description: "Fix the tests",
      metadata: { source: "subagent", agent: "Laptop", state: "completed", childID: "tsk_1" },
    })
  })
})
