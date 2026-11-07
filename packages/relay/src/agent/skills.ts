import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import type { Protocol } from "../protocol.js"
import { Skills } from "../skills.js"
import type { Local } from "./index.js"

export * as AgentSkills from "./skills.js"

/**
 * The hub's skills on a machine: written into an instance's `skills` folder as `hub-<name>/`, next to the skills the
 * user keeps there, which are never touched. A manifest, hidden from opencode's scan like every dotfile, lists the
 * folders the agent wrote, so it only ever replaces or deletes those.
 */
export const MANIFEST = ".hub-skills.json"

const STAGING = ".hub-staging-"

const Manifest = Schema.Struct({ iid: Schema.String, version: Schema.String, skills: Schema.Array(Schema.String) })
type Manifest = typeof Manifest.Type
const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest))

/** The folder opencode loads skills from, in a configuration folder (`<XDG_CONFIG_HOME>/opencode`). */
export function folder(config: string) {
  return path.join(config, "skills")
}

/** The manifest of a skills folder, if the agent wrote one there. */
export function manifest(dir: string) {
  const text = readText(path.join(dir, MANIFEST))
  return text === undefined ? undefined : Option.getOrUndefined(decodeManifest(text))
}

/**
 * Replaces the hub's skills in `dir` with `payload`'s: each skill is written in full into a staging folder inside
 * `dir`, then renamed into place, and the hub folders that are no longer listed are deleted. A local folder that
 * happens to be called `hub-<name>` is left alone and that skill is skipped. Anything with an unsafe name or path is
 * refused before a single file is written. Returns the folders written and skipped, or `changed: false` when `dir`
 * already holds this version.
 */
export function write(dir: string, payload: Protocol.Skills) {
  const skills = payload.skills.map(requireSafe)
  const previous = manifest(dir)
  const owned = new Set((previous?.skills ?? []).filter(isHubFolder))
  if (
    previous?.iid === payload.iid &&
    previous.version === payload.version &&
    Array.from(owned).every((name) => exists(path.join(dir, name)))
  )
    return { changed: false, written: [] as string[], skipped: [] as string[] }
  mkdirSync(dir, { recursive: true })
  // Staging folders left by an agent that died mid-write.
  readdirSync(dir)
    .filter((name) => name.startsWith(STAGING))
    .forEach((name) => rmSync(path.join(dir, name), { recursive: true, force: true }))
  // Inside `dir`, so every rename stays on one file system; its leading dot hides it from opencode's scan.
  const staging = mkdtempSync(path.join(dir, STAGING))
  try {
    skills.forEach((skill) => stage(staging, skill))
    const names = skills.map((skill) => `${Skills.PREFIX}${skill.name}`)
    const written = names.filter((name) => owned.has(name) || !exists(path.join(dir, name)))
    const skipped = names.filter((name) => !written.includes(name))
    // Listed first with everything the swap may leave behind, so an interrupted swap is cleaned up by the next one.
    saveManifest(dir, { iid: payload.iid, version: "", skills: Array.from(new Set([...owned, ...written])) })
    const trash = path.join(staging, ".trash")
    mkdirSync(trash)
    written.forEach((name) => {
      const target = path.join(dir, name)
      if (exists(target)) renameSync(target, path.join(trash, name))
      renameSync(path.join(staging, name), target)
    })
    Array.from(owned)
      .filter((name) => !names.includes(name) && exists(path.join(dir, name)))
      .forEach((name) => renameSync(path.join(dir, name), path.join(trash, name)))
    saveManifest(dir, { iid: payload.iid, version: payload.version, skills: written })
    return { changed: true, written, skipped }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** Deletes the hub folders the manifest lists, and the manifest; nothing else. Returns whether it found one. */
export function remove(dir: string) {
  const previous = manifest(dir)
  if (!previous) return false
  previous.skills.filter(isHubFolder).forEach((name) => rmSync(path.join(dir, name), { recursive: true, force: true }))
  rmSync(path.join(dir, MANIFEST), { force: true })
  return true
}

/**
 * Asks a running opencode server to reload its configuration (`POST /api/location/reload`), which rescans its skill
 * folders. Sessions keep running; pending permission prompts are cancelled, which is why it is only asked for when
 * the skills really changed.
 */
export async function reload(local: Local) {
  const response = await fetch(`${local.url.replace(/\/+$/, "")}/api/location/reload`, {
    method: "POST",
    headers:
      local.password === undefined
        ? undefined
        : { authorization: `Basic ${Buffer.from(`opencode:${local.password}`).toString("base64")}` },
  })
  if (!response.ok) throw new Error(`the local server answered ${response.status} to a configuration reload`)
}

function stage(staging: string, skill: Skills.Skill) {
  const root = path.join(staging, `${Skills.PREFIX}${skill.name}`)
  mkdirSync(root)
  skill.files.forEach((file) => {
    const target = path.resolve(root, file.path)
    // Checked once more on the resolved path: nothing is written outside the skill's own folder.
    if (!target.startsWith(root + path.sep)) throw new Error(`refusing skill file outside its folder: ${file.path}`)
    mkdirSync(path.dirname(target), { recursive: true })
    // `wx`: the staging folder is new, so an existing file (or a link planted in it) is an error, never followed.
    writeFileSync(target, file.content, { flag: "wx" })
  })
}

function requireSafe(skill: Protocol.Skills["skills"][number]) {
  if (!Skills.isName(skill.name)) throw new Error(`refusing skill with an unsafe name: ${skill.name}`)
  const unsafe = skill.files.find((file) => !Skills.isSafePath(file.path))
  if (unsafe) throw new Error(`refusing skill ${skill.name}: unsafe file path ${unsafe.path}`)
  return skill
}

function isHubFolder(name: string) {
  return name.startsWith(Skills.PREFIX) && Skills.isName(name.slice(Skills.PREFIX.length))
}

function saveManifest(dir: string, value: Manifest) {
  const file = path.join(dir, MANIFEST)
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + "\n")
  renameSync(`${file}.tmp`, file)
}

function exists(target: string) {
  return lstatSync(target, { throwIfNoEntry: false }) !== undefined
}

function readText(file: string) {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}
