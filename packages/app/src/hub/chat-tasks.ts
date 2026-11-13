import { Option, Schema } from "effect"
import { onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { hubApi, type HubTask, type HubTaskStatus } from "./api"

const STATUSES = ["starting", "running", "waiting", "idle", "failed", "interrupted", "offline", "lost"] as const
const ACTIVE = new Set<HubTaskStatus>(["starting", "running", "waiting", "offline"])

// The envelope of the hub's task events (packages/relay/src/hub/chat-tasks.ts). The task itself has the shape
// `GET chat-tasks` answers with, from the same build.
const TaskEvent = Schema.Struct({
  type: Schema.Literal("hub.task.updated"),
  data: Schema.Struct({ id: Schema.String, status: Schema.Literals(STATUSES) }),
})
const isTaskEvent = Schema.is(TaskEvent)
const isConnected = Schema.is(Schema.Struct({ type: Schema.Literal("server.connected") }))
const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** A `hub.task.updated` event's task, from an event of the panel's stream; undefined for any other event. */
export function taskUpdate(event: unknown) {
  if (!isTaskEvent(event)) return undefined
  // SAFETY: a `hub.task.updated` event carries the whole task, as `GET chat-tasks` lists it.
  return event.data as HubTask
}

export const isActiveTask = (task: HubTask) => ACTIVE.has(task.status)

/**
 * Every task of the user, kept live by the hub's `chat-tasks/events` stream: read whole when it (re)connects, then
 * updated one task at a time. `listen` hears each update with the task's previous state.
 */
export function createTaskFeed(input: { onError: (error: unknown) => void }) {
  const [tasks, setTasks] = createStore<Record<string, HubTask>>({})
  const listeners = new Set<(task: HubTask, previous: HubTask | undefined) => void>()

  const refresh = () =>
    hubApi
      .tasks()
      .then((list) => setTasks(reconcile(Object.fromEntries(list.map((task) => [task.id, task])))), input.onError)

  // EventSource reconnects by itself; each connection starts with `server.connected`, after which the list is read again.
  const source = new EventSource("/hub/api/chat-tasks/events")
  source.onmessage = (message) => {
    const event = Option.getOrUndefined(decodeFrame(message.data))
    if (isConnected(event)) return void refresh()
    const task = taskUpdate(event)
    if (!task) return
    const previous = tasks[task.id] ? { ...tasks[task.id]! } : undefined
    setTasks(task.id, reconcile(task))
    listeners.forEach((listener) => listener(task, previous))
  }
  onCleanup(() => source.close())

  return {
    get: (id: string) => tasks[id],
    /** Every task, newest first. */
    list: () => Object.values(tasks).toSorted((a, b) => b.createdAt - a.createdAt),
    listen(listener: (task: HubTask, previous: HubTask | undefined) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    /** Takes in a task read elsewhere, such as the panel's own stream. */
    put: (task: HubTask) => setTasks(task.id, reconcile(task)),
  }
}

export type TaskFeed = ReturnType<typeof createTaskFeed>
