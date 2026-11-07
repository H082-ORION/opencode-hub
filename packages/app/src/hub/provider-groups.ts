/**
 * Groups catalog providers by company. The catalog lists one entry per endpoint, so a company with regional hosts or
 * subscription plans (`alibaba-cn`, `minimax-coding-plan`) shows up several times; the picker lists each company once.
 */

type Entry = { id: string; name: string }

export type ProviderGroup<T extends Entry> = { key: string; name: string; entries: T[] }

/** The companies the picker shows before the full list, in this order. */
export const FEATURED = ["anthropic", "openai", "openrouter", "mistral", "moonshotai", "minimax"]

// Id prefixes that belong to another company's group: Kimi is Moonshot AI's product.
const ALIAS = new Map([["kimi", "moonshotai"]])

/** The company an entry belongs to: its id up to the first "-", through the alias map. */
export function groupKey(id: string) {
  const head = id.split("-")[0] ?? id

  return ALIAS.get(head) ?? head
}

/**
 * Groups entries by company, sorted by group name. A group lists the entry whose id is the key first, then the others
 * under the company's own prefix, then those that reach it through an alias, each in catalog order. Its name comes
 * from its first entry, without a trailing parenthetical such as "(minimax.io)" or "(China)".
 */
export function groupProviders<T extends Entry>(entries: T[]): ProviderGroup<T>[] {
  const groups = Map.groupBy(entries, (entry) => groupKey(entry.id))

  return [...groups]
    .map(([key, list]) => {
      const rank = (entry: T) => (entry.id === key ? 0 : entry.id.split("-")[0] === key ? 1 : 2)
      const ordered = list.toSorted((a, b) => rank(a) - rank(b))

      return { key, name: ordered[0]!.name.replace(/\s*\([^()]*\)$/, ""), entries: ordered }
    })
    .toSorted((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
}

/** The featured groups, in `FEATURED` order, skipping any the catalog does not have. */
export function featuredGroups<T extends Entry>(groups: ProviderGroup<T>[]) {
  const byKey = new Map(groups.map((group) => [group.key, group] as const))

  return FEATURED.flatMap((key) => byKey.get(key) ?? [])
}
