/**
 * The SUBAGENT TREE under one session: the root plus every descendant, collected
 * from the kernel's PUBLIC surfaces only.
 *
 * Deleting a parent while its subagent children stay behind is how a session's
 * last record becomes an orphan nobody can see or delete: the child's log sits in
 * `$DSH_HOME/sessions/<project>/<child id>/` with no parent left to name it. So a
 * delete moves the whole tree into ONE trash entry, and a restore puts the whole
 * tree back — `./trash.ts` already stores several members per entry, so a tree is
 * just a member set whose members happen to be related.
 *
 * ## The two public sources, and why both are needed
 *
 * 1. `SubagentRuntime.listDescendants(rootSessionId, signal?)` —
 *    `node_modules/@deepseek-ai/dsh-subagent/lib/types/index.d.ts:245`. The
 *    durable, parent-owned catalog walk: stable pre-order, each row carrying its
 *    catalog parent and its depth. Authoritative when it answers.
 * 2. The persisted session headers `sessionPersistence.list()` already returns,
 *    read for `parentSession` AND `origin === 'subagent'` —
 *    `node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts:72` (`parentSession`)
 *    and `:82` (`origin`). Both fields together are what make this walk sound:
 *    `parentSession` alone is the FORK lineage ("the session this one was forked
 *    from"), so a fork child — a top-level session the user sees in the sidebar —
 *    would be mistaken for a subagent child and deleted with its parent. A
 *    subagent child carries BOTH (`@deepseek-ai/dsh-subagent/lib/index.js:352`
 *    writes `parentSession`, `origin: 'subagent'` and `delegationDepth`), so the
 *    marker is required here and a fork link is ignored.
 *
 * The header walk runs even when the catalog answers, and the two sets are
 * UNIONED: a catalog pruned after a child completed no longer names it, while the
 * child's header still does — and a child left behind is exactly the orphan this
 * module exists to prevent.
 *
 * A catalog that THROWS is not a refusal. It means this deployment exposes no
 * session-query projection for the walk (the `/search` route answers 503 for the
 * same missing service), and the header walk is then the complete answer for every
 * session the kernel can list. The same reasoning covers a `corrupt` /
 * `unavailable` diagnostic row: the header walk names that node and its own
 * descendants independently, so the branch is not invisible to the union.
 *
 * What IS refused is going over a bound, because a truncated set is not a smaller
 * truth — it would move a parent whose grandchild stays behind:
 *
 *   - {@link MAX_TREE_DEPTH} = 8 edges below the root. This kernel line's
 *     `maxDepth` defaults to 1, so 8 already covers delegating-for-delegation;
 *   - {@link MAX_TREE_NODES} = 200 members, so a pathological tree cannot turn one
 *     request into an unbounded walk.
 *
 * A row the catalog answers in a shape its own `.d.ts` does not describe is
 * `tree-unavailable`: that is upstream API drift, and guessing what a renamed
 * field meant is how a plugin silently stops finding children. The whole delete is
 * then refused with nothing moved, which is the only safe answer to "I cannot tell
 * what is in this tree".
 *
 * Every answer here is identity only. Whether a member may actually be MOVED is
 * decided by `./routes.ts` (liveness, the archive set, the trash's existing
 * hold) and by `./trash.ts` (the payload on disk), never by this module.
 *
 * @module @dsh-app/plugin-archives/tree
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** Deepest delegation chain this collector walks, in edges below the root. */
export const MAX_TREE_DEPTH = 8

/** Most members one tree may hold; a larger tree refuses the whole delete. */
export const MAX_TREE_NODES = 200

/**
 * PUBLIC slice of `ctx.subagents` (`SubagentRuntime`).
 *
 * Structural rather than an import: the plugin declares no dependency on
 * `@deepseek-ai/dsh-subagent`, and the peer it would have to declare is a package
 * nothing in this plugin's own `node_modules` installs. The method is the one
 * symbol this walk needs, and `@deepseek-ai/dsh-subagent`'s `SubagentRuntime`
 * satisfies this interface structurally.
 */
export interface SubagentCatalogLike {
  /** Recursively list reachable parent catalogs, in stable pre-order. */
  listDescendants(
    rootSessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<readonly unknown[]>
}

/**
 * The persisted-header fields the fallback walk reads.
 *
 * Deliberately `unknown` on the two optional fields: they arrive from a listing
 * of an arbitrary kernel line, and reading `.origin` off a header that does not
 * carry one must be a type-level "unknown", not a silent `undefined` that reads
 * like a value.
 */
export interface SessionHeaderRow {
  /** Session id. */
  readonly id: string
  /** Fork lineage — NOT the subagent parent; see the module header. */
  readonly parentSession?: unknown
  /** `'subagent'` on a session created as a subagent child. */
  readonly origin?: unknown
}

/** Why a tree could not be collected. Both mean "nothing may move". */
export type SubagentTreeRefusal =
  /** The tree holds more members (or more depth) than this walk will move. */
  | 'tree-too-large'
  /** A catalog answered in a shape its published type does not describe. */
  | 'tree-unavailable'

/** What one tree collection found. */
export type SubagentTree =
  | {
    readonly kind: 'ok'
    /** The root first, then every descendant in discovery order; no duplicates. */
    readonly ids: readonly string[]
    /** Which sources contributed descendants — diagnostics and tests only. */
    readonly sources: readonly ('catalog' | 'headers')[]
  }
  | {
    readonly kind: 'refused'
    readonly reason: SubagentTreeRefusal
    /** English diagnostic for logs; never a sentence shown to a user. */
    readonly detail: string
  }

/** One descendant row, as the catalog's published type describes it. */
interface DescendantRowLike {
  readonly kind?: unknown
  readonly id?: unknown
  readonly depth?: unknown
}

/**
 * Read one response row of `SubagentRuntime.listDescendants`.
 *
 * The published row type is `SubagentListEntry & { parentId, depth }` with
 * `kind: 'child' | 'diagnostic'` (`@deepseek-ai/dsh-subagent/lib/types/list-children.d.ts:12`).
 * A diagnostic row still names a real session id (the candidate whose own catalog
 * could not be read), so it is a member like any other — what it cannot promise is
 * its own subtree, which the header walk covers.
 * @param row - one element of the catalog answer.
 * @returns the row's id and depth, or the drift detail when it does not match.
 */
function readDescendantRow(row: unknown): { readonly id: string; readonly depth: number } | { readonly detail: string } {
  const value = (row ?? {}) as DescendantRowLike
  if (value.kind !== 'child' && value.kind !== 'diagnostic') {
    return { detail: `a descendant row carries kind ${JSON.stringify(value.kind)}; expected 'child' or 'diagnostic'` }
  }
  if (typeof value.id !== 'string' || value.id === '' || value.id === '.' || value.id === '..') {
    return { detail: 'a descendant row carries no usable session id' }
  }
  if (typeof value.depth !== 'number' || !Number.isInteger(value.depth) || value.depth < 1) {
    return { detail: `the descendant row for ${value.id} carries no usable depth` }
  }
  return { id: value.id, depth: value.depth }
}

/**
 * Collect the tree under one session: itself, plus every descendant.
 *
 * The root is always the first id, so a caller can build a member list straight
 * from the answer. Nothing here touches the disk, the archive set or the liveness
 * seam — this is identity collection only, and every fence that decides whether a
 * member may move lives in `./routes.ts`.
 * @param input.rootId - the session being deleted, already branded by the caller.
 * @param input.catalog - `ctx.subagents` when the host exposes it.
 * @param input.headers - the whole persisted listing, read for `parentSession` +
 *   `origin`.
 * @returns the member ids, or the refusal that stops the delete.
 */
export async function collectSubagentTree(input: {
  rootId: SessionId
  catalog: SubagentCatalogLike | undefined
  headers: readonly SessionHeaderRow[]
}): Promise<SubagentTree> {
  const ids = new Set<string>([input.rootId])
  const sources: ('catalog' | 'headers')[] = []

  const refuseTooLarge = (detail: string): SubagentTree => ({ kind: 'refused', reason: 'tree-too-large', detail })
  /** Add one member, refusing the tree as soon as it goes over a bound. */
  const add = (id: string, depth: number): SubagentTree | undefined => {
    if (ids.has(id)) return undefined
    if (depth > MAX_TREE_DEPTH) {
      return refuseTooLarge(`the tree under ${input.rootId} is deeper than ${MAX_TREE_DEPTH} levels (at ${id})`)
    }
    ids.add(id)
    if (ids.size > MAX_TREE_NODES) {
      return refuseTooLarge(`the tree under ${input.rootId} holds more than ${MAX_TREE_NODES} sessions`)
    }
    return undefined
  }

  if (input.catalog !== undefined) {
    let rows: readonly unknown[] | undefined
    try {
      rows = await input.catalog.listDescendants(input.rootId)
    } catch {
      // No reachable catalog projection in this deployment (see the module
      // header): the header walk below is then the whole answer.
      rows = undefined
    }
    if (rows !== undefined) {
      sources.push('catalog')
      for (const row of rows) {
        const parsed = readDescendantRow(row)
        if ('detail' in parsed) return { kind: 'refused', reason: 'tree-unavailable', detail: parsed.detail }
        const refusal = add(parsed.id, parsed.depth)
        if (refusal !== undefined) return refusal
      }
      if (ids.size > MAX_TREE_NODES) {
        return refuseTooLarge(`the tree under ${input.rootId} holds more than ${MAX_TREE_NODES} sessions`)
      }
    }
  }

  // The header walk: a child is a session whose header says `origin: 'subagent'`
  // AND names its parent. One breadth-first pass over the listing, so the depth
  // of every node is known when the bound is checked.
  const children = new Map<string, string[]>()
  for (const header of input.headers) {
    if (header.origin !== 'subagent') continue
    const parent = header.parentSession
    if (typeof parent !== 'string' || parent === '') continue
    if (typeof header.id !== 'string' || header.id === '') continue
    const siblings = children.get(parent)
    if (siblings === undefined) children.set(parent, [header.id])
    else if (!siblings.includes(header.id)) siblings.push(header.id)
  }
  if (children.size > 0) sources.push('headers')
  let frontier: string[] = [input.rootId]
  let depth = 0
  while (frontier.length > 0) {
    depth += 1
    const next: string[] = []
    for (const parent of frontier) {
      for (const child of children.get(parent) ?? []) {
        if (ids.has(child)) continue
        const refusal = add(child, depth)
        if (refusal !== undefined) return refusal
        next.push(child)
      }
    }
    frontier = next
  }
  return { kind: 'ok', ids: [...ids], sources }
}
