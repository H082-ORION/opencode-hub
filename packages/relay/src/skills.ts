import { createHash } from "node:crypto"
import { Option, Schema } from "effect"

export * as Skills from "./skills.js"

/**
 * Skills shared by the hub and the agent (specs/multi-users.md, "Skills"): a skill is a set of text files with a
 * `SKILL.md` at its root, whose YAML frontmatter names it and describes it the way opencode reads it. The hub checks
 * everything here when a skill is saved; the agent checks the names and paths again before it writes anything.
 */

export type File = { path: string; content: string }
export type Skill = { name: string; files: readonly File[] }

/** Bytes of one skill: its paths and contents, UTF-8. */
export const MAX_BYTES = 256 * 1024
/** Skills of one user or one organization. */
export const MAX_PER_OWNER = 200
export const MAX_FILES = 100
const MAX_PATH = 255
const MAX_DEPTH = 6
const MAX_NAME = 64
const MAX_DESCRIPTION = 1024
export const ENTRY = "SKILL.md"
/** The agent writes a skill `<name>` into the `hub-<name>` folder of the instance's `skills` folder. */
export const PREFIX = "hub-"

// Lowercase words joined by single hyphens: a safe folder name on every platform, like opencode's own skill names.
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// One path segment: no separators, no leading dot (hidden files, `.` and `..`), nothing a shell or Windows treats
// specially.
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
// Other keys (opencode's `metadata`, ...) are allowed and kept in the file.
const decodeFrontmatter = Schema.decodeUnknownOption(Schema.Struct({ name: Schema.String, description: Schema.String }))

/** The skills of an instance's user that no file can exist for: the digest of `[]`, as INSTANCE announces it. */
export const EMPTY_VERSION = version([])

export function isName(name: string) {
  return name.length <= MAX_NAME && NAME.test(name)
}

/** A relative path made of safe segments: no absolute path, no `..`, no backslash, no hidden file. */
export function isSafePath(file: string) {
  if (file.length === 0 || file.length > MAX_PATH) return false
  const segments = file.split("/")
  return segments.length <= MAX_DEPTH && segments.every((segment) => SEGMENT.test(segment))
}

/**
 * Checks a skill before the hub stores it and returns its description, or the reason it is refused. The frontmatter
 * of `SKILL.md` must name the skill exactly and describe it, since opencode lists skills by that description.
 */
export function check(skill: Skill): { description: string } | { error: string } {
  if (!isName(skill.name))
    return { error: "A skill name has 1 to 64 lowercase letters or digits, in words joined by single hyphens." }
  if (skill.files.length > MAX_FILES) return { error: `A skill has at most ${MAX_FILES} files.` }
  const unsafe = skill.files.find((file) => !isSafePath(file.path))
  if (unsafe)
    return {
      error: `Unsafe file path "${unsafe.path}": use relative paths of letters, digits, dots, dashes and underscores, without "..".`,
    }
  const paths = new Set(skill.files.map((file) => file.path.toLowerCase()))
  if (paths.size !== skill.files.length) return { error: "Two files of the skill have the same path." }
  if (skill.files.some((file) => file.content.includes("\0"))) return { error: "Skill files must be text." }
  if (size(skill) > MAX_BYTES) return { error: `A skill takes at most ${MAX_BYTES / 1024} KiB.` }
  const entry = skill.files.find((file) => file.path === ENTRY)
  if (!entry) return { error: `A skill needs a ${ENTRY} file at its root.` }
  const meta = frontmatter(entry.content)
  if (!meta)
    return {
      error: `${ENTRY} must start with a YAML frontmatter block (between "---" lines) with a name and a description.`,
    }
  if (meta.name !== skill.name) return { error: `The name in ${ENTRY} must be "${skill.name}".` }
  const description = meta.description.trim()
  if (!description || description.length > MAX_DESCRIPTION)
    return { error: `The description in ${ENTRY} has 1 to ${MAX_DESCRIPTION} characters.` }
  return { description }
}

/** The `name` and `description` of a `SKILL.md` frontmatter, when both are strings; undefined otherwise. */
export function frontmatter(content: string) {
  const block = FRONTMATTER.exec(content)?.[1]
  if (block === undefined) return undefined
  return Option.getOrUndefined(decodeFrontmatter(parseYaml(block)))
}

export function size(skill: Skill) {
  return skill.files.reduce((total, file) => total + Buffer.byteLength(file.path) + Buffer.byteLength(file.content), 0)
}

/**
 * The version of a set of skills: SHA-256 (hex) of their canonical JSON, skills by name and files by path, so the
 * same content always gives the same version, and no skills gives the digest of `[]`.
 */
export function version(skills: readonly Skill[]) {
  const canonical = canonicalize(skills)
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
}

/** Skills sorted by name, with their files sorted by path: the order in which they are hashed and sent. */
export function canonicalize(skills: readonly Skill[]): Skill[] {
  return skills
    .map((skill) => ({
      name: skill.name,
      files: skill.files
        .map((file) => ({ path: file.path, content: file.content }))
        .toSorted((a, b) => compare(a.path, b.path)),
    }))
    .toSorted((a, b) => compare(a.name, b.name))
}

function compare(a: string, b: string) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function parseYaml(text: string): unknown {
  try {
    return Bun.YAML.parse(text)
  } catch {
    return undefined
  }
}
