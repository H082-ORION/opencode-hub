import { $ } from "bun"
import path from "node:path"
import { promisify } from "node:util"
import { brotliCompress, constants } from "node:zlib"
import { AppArchive } from "../src/app-archive"
import { collectFiles } from "./files"

export async function buildAppArchive(channel: string, version: string, options?: { skipBuild?: boolean }) {
  if (options?.skipBuild) return AppArchive.encode([])
  const quality = brotliQuality(channel)
  const root = path.resolve(import.meta.dirname, "../../app")
  const built = stage("building the web UI")
  await $`bun run build`.cwd(root).env({
    ...process.env,
    OPENCODE_CHANNEL: channel,
    VITE_OPENCODE_SERVER_MODE: "origin",
    VITE_OPENCODE_VERSION: version,
  })
  built()
  const compressed = stage(`compressing the web UI (brotli quality ${quality})`)
  const archive = AppArchive.encode(
    await Promise.all(
      (await collectFiles(path.join(root, "dist")))
        .map((key) => key.replaceAll(path.sep, "/"))
        .filter((key) => !key.endsWith(".map"))
        .toSorted()
        .map(async (key) => {
          const body = Buffer.from(await Bun.file(path.join(root, "dist", key)).arrayBuffer())
          // Independent entries let the server materialize only assets the browser requests.
          return [key, await compress(body, quality)] as const
        }),
    ),
  )
  compressed()
  return archive
}

/** Logs that a build stage started; the returned function logs how long it took. */
export function stage(label: string) {
  console.log(label)
  const start = performance.now()
  return () => console.log(`${label}: ${((performance.now() - start) / 1000).toFixed(1)}s`)
}

// The assets compress once per release, so they take brotli's best quality: about 11% smaller than quality 6 for the
// web UI. Each runs on the thread pool, which keeps the build to about a minute. Beta builds on every push and only
// bundles the CLI into the desktop app, so it keeps quality 6, which takes a few seconds. OPENCODE_BROTLI_QUALITY
// overrides both, for local builds that value time over size.
function brotliQuality(channel: string) {
  const override = process.env.OPENCODE_BROTLI_QUALITY
  if (!override) return channel === "beta" ? 6 : 11
  const quality = Number(override)
  if (Number.isInteger(quality) && quality >= 0 && quality <= 11) return quality
  throw new Error(`OPENCODE_BROTLI_QUALITY must be an integer from 0 to 11, got: ${override}`)
}

function compress(body: Buffer, quality: number) {
  return promisify(brotliCompress)(body, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: quality,
      [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
    },
  })
}
