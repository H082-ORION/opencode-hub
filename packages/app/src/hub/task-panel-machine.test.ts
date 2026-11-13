import { describe, expect, test } from "bun:test"
import {
  CLOSED_TASK_PANEL,
  transitionTaskPanel,
  viewTaskPanel,
  type TaskPanelEvent,
  type TaskPanelState,
} from "./task-panel-machine"

const run = (events: TaskPanelEvent[], state: TaskPanelState = CLOSED_TASK_PANEL) =>
  events.reduce((current, event) => transitionTaskPanel(current, event).state, state)

describe("task panel", () => {
  test("loads, goes live once its stream is up, and reads the session then", () => {
    const loading = run([{ type: "open", task: "tsk_1" }])
    expect(viewTaskPanel(loading)).toMatchObject({ open: true, connecting: true, working: false })
    const live = transitionTaskPanel(loading, { type: "connection", attempt: 1, connected: true })
    expect(live.effects).toEqual([{ type: "sync", attempt: 1 }])
    expect(viewTaskPanel(live.state)).toMatchObject({ connecting: false, working: true, canStop: true })
  })

  test("reads the session again after every reconnection, and after the machine's stream came back", () => {
    const live = run([
      { type: "open", task: "tsk_1" },
      { type: "connection", attempt: 1, connected: true },
    ])
    const down = transitionTaskPanel(live, { type: "connection", attempt: 1, connected: false })
    expect(viewTaskPanel(down.state)).toMatchObject({ connecting: true, working: false, notice: "reconnecting" })
    expect(transitionTaskPanel(down.state, { type: "connection", attempt: 1, connected: true }).effects).toEqual([
      { type: "sync", attempt: 1 },
    ])
    expect(transitionTaskPanel(live, { type: "resync", attempt: 1 }).effects).toEqual([{ type: "sync", attempt: 1 }])
  })

  test("follows what the task does, from the hub's updates", () => {
    const live = run([
      { type: "open", task: "tsk_1" },
      { type: "connection", attempt: 1, connected: true },
    ])
    const waiting = run([{ type: "update", attempt: 1, task: "tsk_1", status: "waiting" }], live)
    expect(viewTaskPanel(waiting)).toMatchObject({ working: false, canStop: true, notice: "waiting" })
    const offline = run([{ type: "update", attempt: 1, task: "tsk_1", status: "offline" }], waiting)
    expect(viewTaskPanel(offline)).toMatchObject({ canStop: false, canSend: false, notice: "offline" })
    const ended = run([{ type: "update", attempt: 1, task: "tsk_1", status: "idle" }], offline)
    expect(viewTaskPanel(ended)).toMatchObject({ working: false, canStop: false, canSend: true, notice: undefined })
  })

  test("ignores what belongs to a task it no longer shows", () => {
    const first = run([
      { type: "open", task: "tsk_1" },
      { type: "connection", attempt: 1, connected: true },
    ])
    const second = run([{ type: "open", task: "tsk_2" }], first)
    expect(second).toMatchObject({ status: "loading", task: "tsk_2", attempt: 2 })
    expect(transitionTaskPanel(second, { type: "connection", attempt: 1, connected: true }).state).toBe(second)
    expect(transitionTaskPanel(second, { type: "update", attempt: 2, task: "tsk_1", status: "lost" }).state).toBe(
      second,
    )
  })

  test("opening the task it shows again changes nothing, and closing stops everything", () => {
    const live = run([
      { type: "open", task: "tsk_1" },
      { type: "connection", attempt: 1, connected: true },
    ])
    expect(transitionTaskPanel(live, { type: "open", task: "tsk_1" }).state).toBe(live)
    const closed = run([{ type: "close" }], live)
    expect(viewTaskPanel(closed).open).toBe(false)
    expect(transitionTaskPanel(closed, { type: "connection", attempt: 1, connected: true }).state).toBe(closed)
  })
})
