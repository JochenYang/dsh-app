/**
 * The git face's list presentation: how one flat change list becomes the tree
 * the panel draws.
 *
 * Kept out of `git-tab.tsx` and free of React so the suite can pin the three
 * rules that decide whether a tree reads correctly:
 *
 *   - the sort — directories before files at every level, each by name, which
 *     is the SCM tree the panel imitates;
 *   - the compaction — a directory whose only child is another directory
 *     collapses into ONE header (`apps/api/src/modules/agent`), so a deep path
 *     never renders as a column of single-child rows;
 *   - the row label — a file shows its own name, because every directory above
 *     it is already a header.
 *
 * @module @dsh-app/plugin-sidebar/client/git-list
 */

/** The presentation shapes offered for the change list and the file list. */
export type GitListShape = 'tree' | 'flat'

/** One file leaf. */
export interface GitTreeFile<T> {
  /** The file's own segment, which is what its row shows. */
  readonly name: string
  /** The full repository-relative path (the tooltip and the request key). */
  readonly path: string
  readonly entry: T
}

/** One directory node, its single-child chain already compacted. */
export interface GitTreeDir<T> {
  /** The header text, e.g. `apps/api/src/modules/agent`. */
  readonly name: string
  /** The deepest directory the header names — the collapse key. */
  readonly path: string
  readonly dirs: readonly GitTreeDir<T>[]
  readonly files: readonly GitTreeFile<T>[]
  /** Files at or below this node: the count badge on its header. */
  readonly fileCount: number
}

/** The tree's two roots — directories, then the repository's own loose files. */
export interface GitTree<T> {
  readonly dirs: readonly GitTreeDir<T>[]
  readonly files: readonly GitTreeFile<T>[]
}

/** Mutable build-time shape; `compact` turns it into the public node. */
interface MutableDir<T> {
  readonly name: string
  readonly path: string
  readonly dirs: Map<string, MutableDir<T>>
  readonly files: GitTreeFile<T>[]
}

/** Name order, compared by code unit so the tree never depends on a locale. */
function byName(left: { readonly name: string }, right: { readonly name: string }): number {
  if (left.name < right.name) return -1
  return left.name > right.name ? 1 : 0
}

/**
 * Collapse a single-child chain, then compact its subtree.
 *
 * A directory that holds no files of its own and exactly one subdirectory is
 * merged into it, repeatedly, so `apps` → `api` → `src` becomes one header
 * reading `apps/api/src`. The merge stops at the first level that holds a file
 * or a second directory, which is where the header would otherwise hide a
 * sibling.
 *
 * @param dir - the mutable node to compact.
 * @returns the immutable node, its chain merged.
 */
function compact<T>(dir: MutableDir<T>): GitTreeDir<T> {
  let name = dir.name
  let path = dir.path
  let current = dir
  while (current.files.length === 0 && current.dirs.size === 1) {
    const only = [...current.dirs.values()][0] as MutableDir<T>
    name = `${name}/${only.name}`
    path = only.path
    current = only
  }
  const dirs = [...current.dirs.values()].sort(byName).map(compact)
  const files = [...current.files].sort(byName)
  return {
    name,
    path,
    dirs,
    files,
    fileCount: files.length + dirs.reduce((total, child) => total + child.fileCount, 0),
  }
}

/**
 * Build the directory tree for one entry list.
 *
 * Each entry is split on `/`; every segment but the last becomes a directory
 * node and the last becomes the file's own label. An entry with no usable
 * segment (an empty path) is skipped rather than rendered as a nameless row.
 *
 * @param list - the entries to lay out, in any order.
 * @returns the tree, directories compacted and both roots sorted.
 */
export function buildPathTree<T extends { readonly path: string }>(list: readonly T[]): GitTree<T> {
  const root: MutableDir<T> = { name: '', path: '', dirs: new Map(), files: [] }
  for (const entry of list) {
    const segments = entry.path.split('/').filter(segment => segment !== '')
    const name = segments.pop()
    if (name === undefined) continue
    let cursor = root
    for (const segment of segments) {
      const known = cursor.dirs.get(segment)
      if (known !== undefined) {
        cursor = known
        continue
      }
      const next: MutableDir<T> = {
        name: segment,
        path: cursor.path === '' ? segment : `${cursor.path}/${segment}`,
        dirs: new Map(),
        files: [],
      }
      cursor.dirs.set(segment, next)
      cursor = next
    }
    cursor.files.push({ name, path: entry.path, entry })
  }
  return {
    dirs: [...root.dirs.values()].sort(byName).map(compact),
    files: [...root.files].sort(byName),
  }
}
