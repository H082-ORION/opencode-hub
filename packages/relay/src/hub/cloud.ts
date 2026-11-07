import { Option, Schema } from "effect"
import { json, type Current } from "./accounts.js"
import type { Auth } from "./auth.js"
import { Store } from "./store.js"

export * as Cloud from "./cloud.js"

/** The version of the host protocol (agent-hub-lxd `docs/protocol.md`) this hub speaks. */
export const PROTOCOL = 1
const PING_INTERVAL = 25_000
const HELLO_TIMEOUT = 10_000
const MAX_MESSAGE = 1024 * 1024
const MAX_NAME = 64
const INVALID_CODE = "invalid or expired enrollment code"

const Limits = Schema.Struct({ cpu: Schema.Number, memory_mib: Schema.Number, disk_gib: Schema.Number })
type Limits = typeof Limits.Type
const Resource = Schema.Struct({
  total: Schema.Number,
  reserved: Schema.Number,
  allocated: Schema.Number,
  available: Schema.Number,
})
const Capacity = Schema.Struct({
  cpu: Resource,
  memory_mib: Resource,
  disk_gib: Resource,
  instances: Schema.Struct({ count: Schema.Number, max: Schema.Number }),
  per_instance_max: Limits,
})
export type Capacity = typeof Capacity.Type
const HostInstance = Schema.Struct({ instance: Schema.String, status: Schema.String, limits: Limits })
const HostMetrics = Schema.Struct({
  cpu_threads: Schema.Number,
  load: Schema.Array(Schema.Number),
  memory_total_bytes: Schema.Number,
  memory_used_bytes: Schema.Number,
  disk_total_bytes: Schema.Number,
  disk_used_bytes: Schema.Number,
})
type HostMetrics = typeof HostMetrics.Type
const InstanceMetrics = Schema.Struct({
  instance: Schema.String,
  status: Schema.String,
  cpu_usage_ns: Schema.Number,
  memory_usage_bytes: Schema.Number,
  memory_total_bytes: Schema.Number,
  disk_usage_bytes: Schema.Number,
  network_rx_bytes: Schema.Number,
  network_tx_bytes: Schema.Number,
})
type InstanceMetrics = typeof InstanceMetrics.Type
const Hello = Schema.Struct({
  type: Schema.Literal("hello"),
  protocol: Schema.Number,
  version: Schema.String,
  name: Schema.String,
  platform: Schema.Struct({
    os: Schema.String,
    arch: Schema.String,
    lxd_version: Schema.String,
    project: Schema.String,
  }),
  capacity: Capacity,
  instances: Schema.Array(HostInstance),
})
type Hello = typeof Hello.Type
const Message = Schema.Union([
  Hello,
  Schema.Struct({ type: Schema.Literal("pong") }),
  Schema.Struct({
    type: Schema.Literal("result"),
    id: Schema.String,
    ok: Schema.Boolean,
    instance: Schema.optional(HostInstance),
    error: Schema.optional(Schema.Struct({ code: Schema.String, message: Schema.String })),
  }),
  Schema.Struct({
    type: Schema.Literal("metrics"),
    host: HostMetrics,
    capacity: Capacity,
    instances: Schema.Array(InstanceMetrics),
  }),
])
type Message = typeof Message.Type
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(Message))
const decodeEnroll = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ code: Schema.String, name: Schema.String })),
)
const decodeCreate = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      host: Schema.String,
      name: Schema.String,
      cpu: Schema.Number,
      memory_mib: Schema.Number,
      disk_gib: Schema.Number,
    }),
  ),
)

/** What the hub can do with a host's WebSocket; the server's socket type is wider. */
type Socket = { send(text: string): unknown; close(code?: number, reason?: string): void }

/** A host's WebSocket as `Bun.serve` carries it: the host it authenticated as, then its connection after `hello`. */
export type SocketData = { kind: "host"; host: Store.CloudHost; connection?: Connection }

type Operation = "create" | "start" | "stop" | "delete"

/** A sample of an instance's metrics, with its CPU use since the previous one. */
type Sample = { metrics: InstanceMetrics; at: number; cpuPercent: number | null }

type Connection = {
  socket: Socket
  host: string
  hello: Hello
  capacity: Capacity
  metrics?: HostMetrics
  samples: Map<string, Sample>
  /** Requests sent on this connection, by request id; an answer lost with the connection is reconciled at `hello`. */
  pending: Map<string, { instance: string; operation: Operation; previous: Store.CloudStatus }>
  ping: Timer
  next: number
}

/**
 * Cloud hosts and the cloud instances users create on them (specs/cloud.md). Administrators enroll hosts; every user
 * may create instances on a connected host. The hub keeps what it asked for and what each host last answered: a host
 * that reconnects lists its instances in `hello`, which settles the requests whose answers were lost.
 */
export function create(input: {
  store: Store.Instance
  auth: Auth.Instance
  origin: string
  pingInterval?: number
  /** The link that opens a machine through the hub. */
  machineURL: (machine: string) => string
  /** A host, an instance or its metrics changed: dashboards refresh their cloud view. */
  changed: () => void
  /** Revokes the machine a deleted instance had become, as revoking it from the dashboard does. */
  revokeMachine: (machine: string) => void
}) {
  const store = input.store
  const connections = new Map<string, Connection>()

  return {
    /** Handles `cloud…` under `/hub/api/` for a signed-in user; undefined for any other route. */
    async handle(request: Request, route: string, current: Current) {
      if (route !== "cloud" && !route.startsWith("cloud/")) return undefined
      const method = request.method
      const user = current.user
      if (route === "cloud" && method === "GET") return json(200, view(user))
      if (route === "cloud/instances" && method === "POST") return createInstance(request, user)
      const action = /^cloud\/instances\/([^/]+)\/(start|stop)$/.exec(route)
      if (action && method === "POST") return changeState(user, decodeURIComponent(action[1]), action[2] as Operation)
      const instance = /^cloud\/instances\/([^/]+)$/.exec(route)
      if (instance && method === "DELETE") return deleteInstance(user, decodeURIComponent(instance[1]))
      if (user.role !== "admin") return json(403, { error: "Only hub administrators can do this." })
      if (route === "cloud/hosts/code" && method === "POST") {
        const code = input.auth.createHostCode(user.id)
        // `join` asks for the code without echo, so it stays out of the shell history.
        return json(200, { ...code, command: `agent-hub-lxd join ${input.origin}` })
      }
      const host = /^cloud\/hosts\/([^/]+)$/.exec(route)
      if (host && method === "DELETE") return revokeHost(decodeURIComponent(host[1]))
      return json(404, { error: "Not found." })
    },

    /** `POST /hub/host/enroll`: trades an administrator's host code for a host token. */
    async enroll(request: Request, client: string) {
      if (request.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 })
      if (input.auth.throttled(client) > 0) return Response.json({ error: "too many attempts" }, { status: 429 })
      const body = Option.getOrUndefined(decodeEnroll(await request.text()))
      const name = body?.name.trim().slice(0, 100)
      if (!body || !name) return Response.json({ error: "expected { code, name }" }, { status: 400 })
      const code = input.auth.consumeCode(body.code)
      if (!code || code.kind !== "host") {
        input.auth.fail(client)
        return Response.json({ error: INVALID_CODE }, { status: 403 })
      }
      // Only while its author is still an active administrator.
      const author = store.user(code.user)
      if (!author || author.disabled_at !== null || author.role !== "admin")
        return Response.json({ error: INVALID_CODE }, { status: 403 })
      const enrolled = store.createCloudHost({ name, createdBy: author.id })
      input.changed()
      return Response.json({ ...enrolled, url: input.origin })
    },

    /** The host a `/hub/host/connect` upgrade authenticates as, from its bearer token. */
    authenticate(request: Request) {
      const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
      return token ? store.cloudHostByToken(token) : undefined
    },

    open(socket: Socket, data: SocketData) {
      setTimeout(() => {
        if (!data.connection) socket.close(4400, "expected hello")
      }, HELLO_TIMEOUT)
    },

    message(socket: Socket, data: SocketData, message: string | Buffer) {
      if (typeof message !== "string" || message.length > MAX_MESSAGE) return socket.close(1003, "expected JSON text")
      const decoded = Option.getOrUndefined(decodeMessage(message))
      if (!data.connection) return hello(socket, data, decoded)
      // Unknown or malformed messages are ignored, so hosts can add some without breaking older hubs.
      if (!decoded) return
      const connection = data.connection
      if (decoded.type === "pong") return void store.touchCloudHost(connection.host)
      if (decoded.type === "result") return result(connection, decoded)
      if (decoded.type === "metrics") return metrics(connection, decoded)
    },

    close(data: SocketData) {
      const connection = data.connection
      if (!connection) return
      clearInterval(connection.ping)
      if (connections.get(connection.host) !== connection) return
      connections.delete(connection.host)
      store.touchCloudHost(connection.host)
      input.changed()
    },

    /**
     * Links the machine a cloud instance's VM just enrolled as; false when the code's instance is gone, belongs to
     * someone else or already has its machine.
     */
    linkable(cloud: string, user: string) {
      const instance = store.cloudInstance(cloud)
      return instance !== undefined && instance.user_id === user && instance.machine_id === null
    },
    link(cloud: string, machine: string) {
      store.updateCloudInstance(cloud, { machine })
      input.changed()
    },
    /** The cloud instance a machine is, if any: such a machine goes away with its instance. */
    instanceOf: (machine: string) => store.cloudInstanceByMachine(machine),

    view,

    stop() {
      connections.forEach((connection) => {
        clearInterval(connection.ping)
        connection.socket.close(1001, "hub stopping")
      })
    },
  }

  function hello(socket: Socket, data: SocketData, message: Message | undefined) {
    if (message?.type !== "hello") return socket.close(4400, "expected hello")
    if (message.protocol !== PROTOCOL)
      return socket.close(4400, `unsupported protocol ${message.protocol}; this hub speaks protocol ${PROTOCOL}`)
    const host = store.cloudHost(data.host.id)
    if (!host) return socket.close(4401, "host revoked")
    connections.get(host.id)?.socket.close(4409, "replaced by a new connection")
    const connection: Connection = {
      socket,
      host: host.id,
      hello: message,
      capacity: message.capacity,
      samples: new Map(),
      pending: new Map(),
      ping: setInterval(() => send(connection, { type: "ping" }), input.pingInterval ?? PING_INTERVAL),
      next: 1,
    }
    data.connection = connection
    connections.set(host.id, connection)
    store.touchCloudHost(host.id)
    send(connection, { type: "ready", host: { id: host.id, name: host.name } })
    reconcile(connection, message)
    input.changed()
  }

  /**
   * Brings the hub's records in line with what a host that just connected runs. A listed instance takes the host's
   * status; one the hub was deleting is deleted again. An unlisted one was never created (`failed`), is gone after a
   * delete (forgotten), or disappeared (`missing`). Instances the hub does not know are left alone.
   */
  function reconcile(connection: Connection, message: Hello) {
    const listed = new Map(message.instances.map((instance) => [instance.instance, instance]))
    store.cloudInstancesOn(connection.host).forEach((instance) => {
      const found = listed.get(instance.id)
      if (instance.status === "deleting") {
        if (found) return submit(connection, instance, "delete")
        return remove(instance)
      }
      if (found)
        return void store.updateCloudInstance(instance.id, { status: hostStatus(found.status), limits: found.limits })
      if (instance.status === "creating")
        return void store.updateCloudInstance(instance.id, {
          status: "failed",
          error: "The cloud server lost the connection before the instance was ready.",
        })
      if (instance.status !== "failed") store.updateCloudInstance(instance.id, { status: "missing" })
    })
  }

  function result(connection: Connection, message: Extract<Message, { type: "result" }>) {
    const pending = connection.pending.get(message.id)
    if (!pending) return
    connection.pending.delete(message.id)
    const instance = store.cloudInstance(pending.instance)
    if (!instance) return
    if (pending.operation === "delete" && (message.ok || message.error?.code === "not_found")) {
      remove(instance)
      return input.changed()
    }
    if (message.ok) {
      store.updateCloudInstance(instance.id, {
        status: message.instance ? hostStatus(message.instance.status) : instance.status,
        limits: message.instance?.limits,
        error: null,
      })
      return input.changed()
    }
    // A failed create leaves nothing behind on the host; another failure leaves the instance as it was.
    store.updateCloudInstance(instance.id, {
      status: pending.operation === "create" ? "failed" : pending.previous,
      error: message.error?.message ?? "The cloud server refused the request.",
    })
    input.changed()
  }

  function metrics(connection: Connection, message: Extract<Message, { type: "metrics" }>) {
    const now = Date.now()
    connection.capacity = message.capacity
    connection.metrics = message.host
    const samples = new Map(
      message.instances.map((metrics) => {
        const previous = connection.samples.get(metrics.instance)
        const limit = store.cloudInstance(metrics.instance)?.cpu ?? 0
        const elapsed = previous ? (now - previous.at) * 1e6 : 0
        // Nanoseconds of CPU used per nanosecond elapsed, over the instance's CPUs.
        const cpuPercent =
          previous && elapsed > 0 && limit > 0 && metrics.cpu_usage_ns >= previous.metrics.cpu_usage_ns
            ? Math.min(100, ((metrics.cpu_usage_ns - previous.metrics.cpu_usage_ns) / elapsed / limit) * 100)
            : null
        return [metrics.instance, { metrics, at: now, cpuPercent }] as const
      }),
    )
    connection.samples = samples
    input.changed()
  }

  async function createInstance(request: Request, user: Store.User) {
    const body = Option.getOrUndefined(decodeCreate(await request.text()))
    if (!body) return json(400, { error: "Expected { host, name, cpu, memory_mib, disk_gib }." })
    const name = instanceName(body.name)
    if (!name) return json(400, { error: `An instance name has 1 to ${MAX_NAME} characters.` })
    const connection = connections.get(body.host)
    if (!connection) return json(409, { error: "This cloud server is not connected right now." })
    const limits = { cpu: body.cpu, memory_mib: body.memory_mib, disk_gib: body.disk_gib }
    const refused = checkLimits(limits, connection.capacity)
    if (refused) return json(409, { error: refused })
    const instance = store.createCloudInstance({ host: connection.host, user: user.id, name, limits })
    const code = input.auth.createCloudCode(user.id, instance.id)
    submit(connection, instance, "create", { limits, pairing: { code: code.code } })
    input.changed()
    return json(202, { instance: instanceView(store.cloudInstance(instance.id) ?? instance) })
  }

  function changeState(user: Store.User, id: string, operation: Operation) {
    const instance = store.cloudInstance(id)
    if (!instance || !mayManage(user, instance)) return unknownInstance()
    const connection = connections.get(instance.host_id)
    if (!connection) return json(409, { error: "This cloud server is not connected right now." })
    if (!["running", "stopped", "missing"].includes(instance.status))
      return json(409, { error: "Wait for the current operation on this instance to finish." })
    submit(connection, instance, operation)
    input.changed()
    return json(202, { instance: instanceView(store.cloudInstance(id) ?? instance) })
  }

  function deleteInstance(user: Store.User, id: string) {
    const instance = store.cloudInstance(id)
    if (!instance || !mayManage(user, instance)) return unknownInstance()
    const connection = connections.get(instance.host_id)
    // A failed instance left nothing on its host; anything else needs the host to delete its VM.
    if (!connection) {
      if (instance.status !== "failed") return json(409, { error: "This cloud server is not connected right now." })
      remove(instance)
      input.changed()
      return new Response(null, { status: 204 })
    }
    if (instance.status === "deleting") return json(202, { instance: instanceView(instance) })
    if (instance.status === "creating")
      return json(409, { error: "Wait for the instance to be ready, or to fail, before deleting it." })
    submit(connection, instance, "delete")
    input.changed()
    return json(202, { instance: instanceView(store.cloudInstance(id) ?? instance) })
  }

  function revokeHost(id: string) {
    const result = store.deleteCloudHost(id)
    if (result === "unknown") return json(404, { error: "Unknown cloud server." })
    if (result === "has-instances")
      return json(409, { error: "This cloud server still has instances. Delete them first." })
    const connection = connections.get(id)
    connections.delete(id)
    if (connection) {
      clearInterval(connection.ping)
      connection.socket.close(4401, "host revoked")
    }
    input.changed()
    return new Response(null, { status: 204 })
  }

  /** Sends an operation and records it, with the status to go back to if the host refuses it. */
  function submit(
    connection: Connection,
    instance: Store.CloudInstanceRow,
    operation: Operation,
    extra: Record<string, unknown> = {},
  ) {
    const id = `r${connection.next++}`
    connection.pending.set(id, { instance: instance.id, operation, previous: instance.status })
    const status = ({ create: "creating", start: "starting", stop: "stopping", delete: "deleting" } as const)[operation]
    store.updateCloudInstance(instance.id, { status, error: null })
    send(connection, { type: operation, id, instance: instance.id, ...extra })
  }

  /** Forgets an instance and revokes the machine its VM became. */
  function remove(instance: Store.CloudInstanceRow) {
    store.deleteCloudInstance(instance.id)
    if (instance.machine_id !== null) input.revokeMachine(instance.machine_id)
  }

  function send(connection: Connection, message: Record<string, unknown>) {
    connection.socket.send(JSON.stringify(message))
  }

  function mayManage(user: Store.User, instance: Store.CloudInstanceRow) {
    return instance.user_id === user.id || user.role === "admin"
  }

  /**
   * What a user sees: the hosts they may create instances on (only what they can still get, not the host's details),
   * their own instances, and for administrators every host and every instance.
   */
  function view(user: Store.User) {
    const hosts = store.cloudHosts()
    return {
      hosts: hosts.map((host) => {
        const capacity = connections.get(host.id)?.capacity
        return {
          id: host.id,
          name: host.name,
          online: capacity !== undefined,
          max: capacity ? limitsOf(capacity) : null,
        }
      }),
      instances: store.cloudInstancesOf(user.id).map(instanceView),
      admin:
        user.role === "admin"
          ? {
              hosts: hosts.map((host) => {
                const connection = connections.get(host.id)
                return {
                  id: host.id,
                  name: host.name,
                  online: connection !== undefined,
                  lastSeenAt: host.last_seen_at,
                  version: connection?.hello.version ?? null,
                  lxdVersion: connection?.hello.platform.lxd_version ?? null,
                  capacity: connection?.capacity ?? null,
                  metrics: connection?.metrics ?? null,
                  instances: store.cloudInstancesOn(host.id).length,
                }
              }),
              instances: store.cloudInstances().map((instance) => ({
                ...instanceView(instance),
                owner: store.user(instance.user_id)?.login ?? null,
              })),
            }
          : null,
    }
  }

  function instanceView(instance: Store.CloudInstanceRow) {
    const host = store.cloudHost(instance.host_id)
    const sample = connections.get(instance.host_id)?.samples.get(instance.id)
    return {
      id: instance.id,
      name: instance.name,
      host: { id: instance.host_id, name: host?.name ?? instance.host_id },
      status: instance.status,
      error: instance.error,
      limits: { cpu: instance.cpu, memory_mib: instance.memory_mib, disk_gib: instance.disk_gib },
      machine: instance.machine_id,
      url: instance.machine_id === null ? null : input.machineURL(instance.machine_id),
      createdAt: instance.created_at,
      metrics: sample
        ? {
            cpuPercent: sample.cpuPercent,
            memoryUsedBytes: sample.metrics.memory_usage_bytes,
            memoryTotalBytes: sample.metrics.memory_total_bytes,
            diskUsedBytes: sample.metrics.disk_usage_bytes,
            networkRxBytes: sample.metrics.network_rx_bytes,
            networkTxBytes: sample.metrics.network_tx_bytes,
          }
        : null,
    }
  }
}

export type Instance = ReturnType<typeof create>

/** The most one new instance may have on a host: its per-instance maximum, within what is still available. */
function limitsOf(capacity: Capacity) {
  return {
    cpu: Math.min(capacity.per_instance_max.cpu, capacity.cpu.available),
    memory_mib: Math.min(capacity.per_instance_max.memory_mib, capacity.memory_mib.available),
    disk_gib: Math.min(capacity.per_instance_max.disk_gib, capacity.disk_gib.available),
    full: capacity.instances.count >= capacity.instances.max,
  }
}

/** Checked again by the host, which has the last word; this only spares a request that cannot succeed. */
function checkLimits(limits: Limits, capacity: Capacity) {
  if (![limits.cpu, limits.memory_mib, limits.disk_gib].every(Number.isSafeInteger))
    return "CPU, memory and disk are whole numbers."
  if (limits.cpu < 1 || limits.memory_mib < 256 || limits.disk_gib < 1)
    return "An instance needs at least 1 CPU, 256 MiB of memory and 1 GiB of disk."
  const max = limitsOf(capacity)
  if (max.full) return "This cloud server runs its maximum number of instances."
  if (limits.cpu > max.cpu || limits.memory_mib > max.memory_mib || limits.disk_gib > max.disk_gib)
    return `This cloud server can give a new instance at most ${max.cpu} CPU, ${max.memory_mib} MiB of memory and ${max.disk_gib} GiB of disk.`
  return undefined
}

/** The statuses a host reports for a VM, as the hub records them. */
function hostStatus(status: string): Store.CloudStatus {
  if (status === "running") return "running"
  if (status === "stopped") return "stopped"
  return "missing"
}

function instanceName(input: string) {
  const name = input.normalize("NFKC").trim().replace(/\s+/g, " ")
  if (!name || name.length > MAX_NAME || /\p{Cc}/u.test(name)) return undefined
  return name
}

function unknownInstance() {
  return json(404, { error: "Unknown cloud instance." })
}
