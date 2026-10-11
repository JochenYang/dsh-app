/**
 * The git face's list presentation: how one flat change list becomes the two
 * shapes the user can pick between.
 *
 * Kept out of `git-tab.tsx` and free of React so the suite can pin the two
 * rules that decide whether a tree reads correctly: the grouping depth (one
 * level — the top-level directory, VS Code's SCM tree) and the row label
 * (the path RELATIVE to the group whose header already names the directory,
 * so a row never repeats its own folder).
 *
 * @module @dsh-app/plugin-sidebar/client/git-list
 */

/** The presentation shapes offered for the change list and the file list. */
export type GitListShape = 'tree' | 'flat'

/** One directory group of a list: the top-level key plus its rows. */
export interface GitListGroup<T> {
  /** The top-level directory, or `''` for entries at the repository root. */
  readonly key: string
  /** The group's rows, in their original order. */
  readonly files: readonly T[]
}

/**
 * Group entries by their top-level directory.
 *
 * Root entries (`''`) sort LAST so the directory groups read top-down before
 * the loose files, matching the SCM tree the panel imitates. Entries deeper
 * than one level stay inside their first segment's group: the tree is exactly
 * one level deep, which is what keeps a change list of a hundred paths
 * scannable without indentation drift.
 *
 * @param list - the entries to group, in display order.
 * @returns the groups, directories sorted, root last.
 */
export function groupByTopDir<T extends { readonly path: string }>(list: readonly T[]): GitListGroup<T>[] {
  const byDir = new Map<string, T[]>()
  for (const entry of list) {
    const slash = entry.path.indexOf('/')
    const key = slash === -1 ? '' : entry.path.slice(0, slash)
    const bucket = byDir.get(key) ?? []
    bucket.push(entry)
    byDir.set(key, bucket)
  }
  return [...byDir.entries()]
    .sort(([a], [b]) => (a === '' ? '\uffff' : a).localeCompare(b === '' ? '\uffff' : b))
    .map(([key, files]) => ({ key, files }))
}

/**
 * The label one row carries inside its group.
 *
 * A grouped row shows the path WITHOUT its group's prefix — the header above
 * it already names that directory — so `src/client/panel.tsx` reads
 * `client/panel.tsx` under `src/`. A root row (no group) keeps the full path,
 * and a path that does not actually start with the group key is returned
 * untouched rather than sliced into a lie.
 *
 * @param path - the entry's full repository-relative path.
 * @param groupKey - the group's top-level directory, or `''` for root rows.
 * @returns the label for that row.
 */
export function rowPathOf(path: string, groupKey: string): string {
  if (groupKey === '') return path
  const prefix = `${groupKey}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}
