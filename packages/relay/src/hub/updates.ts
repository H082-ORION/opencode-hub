import { rename } from "node:fs/promises"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import { json, type Current } from "./accounts.js"

export * as Updates from "./updates.js"

/** Where `release.sh` publishes the hub's releases. */
export const REPO = "H082-ORION/opencode-hub"
/** A release version, as the update helper accepts it. */
export const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-pre\.(\d+))?$/
const MAX_AGE = 6 * 60 * 60 * 1000
const TIMEOUT = 15_000
const PER_PAGE = 30
/** The request file is tiny; anything larger is not ours. */
const MAX_REQUEST = 200

export type Options = {
  /** GitHub API base URL; defaults to `https://api.github.com`. */
  api?: string
  fetch?: typeof fetch
  /** Where the update request is written; defaults to `<data>/update`. */
  requestDir?: string
  /** The helper's status file; defaults to `/var/lib/opencode-hub-update/status.json`. */
  statusFile?: string
  /** The systemd unit whose presence means the update helper is installed. */
  installerUnit?: string
  /** How long fetched releases stay fresh, in milliseconds; defaults to 6 hours. */
  maxAge?: number
}

export type Release = {
  version: string
  tag: string
  prerelease: boolean
  publishedAt: string
  notes: string
  url: string
}

export type Status = {
  state: "idle" | "pending" | "running" | "done" | "failed"
  version?: string
  message?: string
  at?: number
}

export type Updates = {
  current: string
  development: boolean
  checkedAt: number | null
  error: string | null
  stable: Release | null
  dev: Release | null
  releases: Release[]
  installer: { available: boolean }
  status: Status
}

const decodeReleases = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({
      tag_name: Schema.String,
      draft: Schema.Boolean,
      prerelease: Schema.Boolean,
      published_at: Schema.NullOr(Schema.String),
      body: Schema.NullOr(Schema.String),
      html_url: Schema.String,
    }),
  ),
)
const decodeStatus = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      state: Schema.Literals(["running", "done", "failed"]),
      version: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      at: Schema.optional(Schema.Number),
    }),
  ),
)
const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ version: Schema.String })))

/**
 * The hub's self-update: its releases on GitHub, and a request file that a root helper installed next to the hub
 * (`opencode-hub-update.path`) picks up to replace the binary and restart the hub, which cannot do either itself.
 */
export function create(input: { version: string; data: string; options?: Options }) {
  const options = input.options ?? {}
  const current = input.version.replace(/^v/, "")
  const development = !VERSION.test(current)
  const requestDir = options.requestDir ?? path.join(input.data, "update")
  const requestFile = path.join(requestDir, "request")
  const statusFile = options.statusFile ?? "/var/lib/opencode-hub-update/status.json"
  const installerUnit = options.installerUnit ?? "/etc/systemd/system/opencode-hub-update.path"
  const maxAge = options.maxAge ?? MAX_AGE
  const cache = {
    releases: [] as Release[],
    checkedAt: null as number | null,
    attemptedAt: null as number | null,
    error: null as string | null,
    inflight: undefined as Promise<void> | undefined,
  }

  return {
    /** Handles `updates…` under `/hub/api/` for a signed-in user; undefined for any other route. */
    async handle(request: Request, route: string, user: Current) {
      if (route !== "updates" && !route.startsWith("updates/")) return undefined
      if (user.user.role !== "admin") return json(403, { error: "Only hub administrators can do this." })
      const method = request.method
      if (route === "updates" && method === "GET") return json(200, await get())
      if (route === "updates/check" && method === "POST") {
        await refresh()
        return json(200, await snapshot())
      }
      if (route === "updates/install" && method === "POST") return install(await request.text())
      return json(404, { error: "Not found." })
    },
    get,
    check: async () => {
      await refresh()
      return snapshot()
    },
  }

  /**
   * Cached releases. A hub that never fetched waits for the first fetch; afterwards a stale cache refreshes in the
   * background. A failed fetch counts as an attempt, so polling the dashboard does not retry GitHub on every request.
   */
  async function get() {
    if (cache.attemptedAt === null) await refresh()
    if (Date.now() - (cache.attemptedAt ?? 0) > maxAge) void refresh()
    return snapshot()
  }

  async function install(body: string) {
    const version = Option.getOrUndefined(decodeRequest(body))?.version
    if (!version || !cache.releases.some((release) => release.version === version))
      return json(400, { error: "Unknown version." })
    if (!(await Bun.file(installerUnit).exists()))
      return json(409, { error: "The update helper is not installed on this server." })
    const status = await readStatus()
    if (status.state === "pending" || status.state === "running")
      return json(409, { error: "An update is already in progress." })
    mkdirSync(requestDir, { recursive: true, mode: 0o700 })
    // Written beside the request and renamed, so the helper never reads a partial file.
    const temp = path.join(requestDir, `request.${crypto.randomUUID()}.tmp`)
    await Bun.write(temp, JSON.stringify({ version }))
    await rename(temp, requestFile)
    return json(200, await snapshot())
  }

  function refresh() {
    cache.attemptedAt = Date.now()
    cache.inflight ??= fetchReleases()
      .then(
        (releases) => {
          cache.releases = releases
          cache.checkedAt = Date.now()
          cache.error = null
        },
        (error: unknown) => {
          cache.error = error instanceof Error ? error.message : String(error)
        },
      )
      .finally(() => {
        cache.inflight = undefined
      })
    return cache.inflight
  }

  async function fetchReleases() {
    const base = (options.api ?? "https://api.github.com").replace(/\/+$/, "")
    const response = await (options.fetch ?? fetch)(`${base}/repos/${REPO}/releases?per_page=${PER_PAGE}`, {
      headers: { "user-agent": `opencode-hub/${current}`, accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(TIMEOUT),
    })
    if (!response.ok) throw new Error(`GitHub answered ${response.status}.`)
    const releases = Option.getOrUndefined(decodeReleases(await response.json()))
    if (!releases) throw new Error("GitHub answered with an unexpected release list.")
    return releases
      .filter((release) => !release.draft && VERSION.test(release.tag_name.replace(/^v/, "")))
      .map((release) => ({
        version: release.tag_name.replace(/^v/, ""),
        tag: release.tag_name,
        prerelease: release.prerelease,
        publishedAt: release.published_at ?? "",
        notes: release.body ?? "",
        url: release.html_url,
      }))
      .toSorted((a, b) => compare(b.version, a.version))
      .slice(0, PER_PAGE)
  }

  async function snapshot(): Promise<Updates> {
    // A development build is older than every release, so any release is offered.
    const newer = (release: Release, than: string | undefined) =>
      than === undefined || compare(release.version, than) > 0
    const base = development ? undefined : current
    const stable = cache.releases.find((release) => !release.prerelease && newer(release, base)) ?? null
    const dev =
      cache.releases.find((release) => release.prerelease && newer(release, base) && newer(release, stable?.version)) ??
      null
    return {
      current,
      development,
      checkedAt: cache.checkedAt,
      error: cache.error,
      stable,
      dev,
      releases: cache.releases,
      installer: { available: await Bun.file(installerUnit).exists() },
      status: await readStatus(),
    }
  }

  /** A request not yet picked up is pending; otherwise whatever the helper last wrote. */
  async function readStatus(): Promise<Status> {
    const request = Bun.file(requestFile)
    if (await request.exists()) {
      const version = Option.getOrUndefined(decodeRequest(await request.slice(0, MAX_REQUEST).text()))?.version
      return version ? { state: "pending", version } : { state: "pending" }
    }
    const status = Bun.file(statusFile)
    if (!(await status.exists())) return { state: "idle" }
    return Option.getOrElse(decodeStatus(await status.text()), (): Status => ({ state: "idle" }))
  }
}

export type Instance = ReturnType<typeof create>

/** Orders release versions: `1.0.0-pre.3` < `1.0.0-pre.10` < `1.0.0` < `1.0.1`; unparsable versions sort first. */
export function compare(a: string, b: string) {
  const left = parts(a)
  const right = parts(b)
  const index = left.findIndex((value, i) => value !== right[i])
  if (index === -1) return 0
  return left[index]! < right[index]! ? -1 : 1
}

function parts(version: string) {
  const match = VERSION.exec(version)
  if (!match) return [-1, -1, -1, -1]
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Infinity : Number(match[4])]
}
