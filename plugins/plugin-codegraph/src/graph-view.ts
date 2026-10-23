/**
 * The graph view's data: a reading of the store sized for a picture.
 *
 * A picture has a budget a query does not. `find` answers one question with a
 * dozen rows; a view draws EVERYTHING it is handed, so handing it a project's
 * 20 000 symbols produces a thousand-nanometre blob that no one can read. This
 * module therefore does not expose the graph — it exposes a PROJECTION of it, at
 * two levels, each bounded:
 *
 *   - **files** — one node per file, edges being cross-file imports and calls.
 *     This is the overview: how a project is carved up and which files talk to
 *     which. A repository's file count is what fits on a screen.
 *   - **symbols of one file** — asked for by path, so the detail view costs one
 *     file's worth of rows rather than the project's.
 *
 * Both levels report what they left out (`truncated`). A view that silently drew
 * a fraction of the graph would be the same failure as a tool that answered "no
 * callers" from a stale snapshot: the reader cannot tell the picture from the
 * truth.
 *
 * @module @dsh-app/plugin-codegraph/host/graph-view
 */

import {
  allRows,
  fileNodeId,
  type Graph,
} from './store.ts'

/** How many file nodes one overview draws. */
export const MAX_VIEW_FILES = 400

/** How many symbols one file's detail view draws. */
export const MAX_VIEW_SYMBOLS = 200

/** How many edges one view returns. */
export const MAX_VIEW_EDGES = 1_200

/** One node in the overview: a file, with what it holds. */
export interface ViewFileNode {
  readonly id: string
  readonly path: string
  /** The file's own name, for the label. */
  readonly name: string
  /** Symbols the file declares. */
  readonly symbols: number
}

/** One edge between two files. */
export interface ViewEdge {
  /** Source node id. */
  readonly from: string
  /** Target node id. */
  readonly to: string
  /** `imports` or `references` (a call that crossed files). */
  readonly kind: string
}

/** The overview payload. */
export interface FileGraph {
  readonly nodes: readonly ViewFileNode[]
  readonly edges: readonly ViewEdge[]
  /** True when the file budget cut the picture short. */
  readonly truncated: boolean
  /** Files in the graph, before the budget. */
  readonly totalFiles: number
}

/** One node in a file's detail view: a symbol. */
export interface ViewSymbolNode {
  readonly id: string
  readonly name: string
  readonly kind: string
  /** 1-based line in the file. */
  readonly line: number
  /** The enclosing declaration's name, when there is one. */
  readonly parent?: string
}

/** The detail payload: one file and what its symbols reference elsewhere. */
export interface SymbolGraph {
  readonly path: string
  readonly nodes: readonly ViewSymbolNode[]
  /** `contains` edges from the file, plus calls between these symbols. */
  readonly edges: readonly ViewEdge[]
  readonly truncated: boolean
  /** Symbols in the file, before the budget. */
  readonly totalSymbols: number
}

/** A file's own name from its path. */
function baseName(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? path : path.slice(slash + 1)
}

/**
 * The overview: files as nodes, cross-file relations as edges.
 *
 * Files with the most symbols come first, because a picture's value is in the
 * substantial part of the tree: a repo's `src/` earns its space before its thirty
 * one-line fixtures. The order is stable (symbol count, then path) so the same
 * graph always draws the same picture.
 *
 * @param graph - the open graph.
 * @param limit - how many file nodes to draw.
 * @returns the bounded projection.
 */
export function fileGraph(graph: Graph, limit = MAX_VIEW_FILES): FileGraph {
  const rows = allRows<{ path: string, n: number }>(
    graph.db,
    // Documents are excluded: they hold no symbols and no outgoing relations, so
    // a node for each would be a dot on the edge of the picture with nothing to
    // say — the prose is reachable from `codegraph_context` instead.
    `SELECT f.path AS path, COUNT(s.id) AS n
     FROM files f LEFT JOIN symbols s ON s.path = f.path
     WHERE f.lang <> 'document'
     GROUP BY f.path
     ORDER BY n DESC, f.path ASC`,
  )
  const total = rows.length
  const kept = rows.slice(0, limit)
  const known = new Set(kept.map(row => row.path))
  // An edge is drawn only when BOTH ends are drawn: a line to a node that is not
  // in the picture reads as a rendering bug, not as a truncation.
  const edges = allRows<{ src: string, dst: string, kind: string }>(
    graph.db,
    `SELECT DISTINCT src, dst, kind FROM edges
     WHERE kind IN ('imports', 'references') AND src LIKE 'file:%' AND dst LIKE 'file:%'
     LIMIT ?`,
    MAX_VIEW_EDGES,
  )
    .map(row => ({ from: row.src, to: row.dst, kind: row.kind }))
    .filter(edge => known.has(edge.from.replace(/^file:/u, '')) && known.has(edge.to.replace(/^file:/u, '')))
  return {
    nodes: kept.map(row => ({
      id: fileNodeId(row.path),
      path: row.path,
      name: baseName(row.path),
      symbols: row.n,
    })),
    edges,
    truncated: total > kept.length,
    totalFiles: total,
  }
}

/**
 * One file's symbols, and the calls between them.
 *
 * The edges are the `references` whose source AND target are symbols of THIS
 * file: the picture answers "what does this file's own code call", which is what
 * a reader opening one file wants. A call that leaves the file is already an edge
 * in the overview.
 *
 * @param graph - the open graph.
 * @param path - the project-relative file path.
 * @param limit - how many symbols to draw.
 * @returns the bounded projection.
 */
export function symbolGraph(graph: Graph, path: string, limit = MAX_VIEW_SYMBOLS): SymbolGraph {
  // Paged in SQL rather than filtered in memory: `symbolsOf` reads the whole
  // table, and a 400-file project holds tens of thousands of rows the view does
  // not draw.
  const total = (graph.db.prepare('SELECT COUNT(*) AS n FROM symbols WHERE path = ?').get(path) as { n: number }).n
  const all = allRows<{ id: string, name: string, kind: string, line: number, parent: string | null }>(
    graph.db,
    'SELECT id, name, kind, line, parent FROM symbols WHERE path = ? ORDER BY line LIMIT ?',
    path, limit,
  )
  const known = new Set(all.map(symbol => symbol.id))
  const edges = allRows<{ src: string, dst: string, kind: string }>(
    graph.db,
    `SELECT DISTINCT src, dst, kind FROM edges
     WHERE kind = 'references' AND src LIKE ? AND dst LIKE ?
     LIMIT ?`,
    `${path}#%`, `${path}#%`, MAX_VIEW_EDGES,
  )
    .map(row => ({ from: row.src, to: row.dst, kind: row.kind }))
    .filter(edge => known.has(edge.from) && known.has(edge.to))
  return {
    path,
    nodes: all.map(symbol => ({
      id: symbol.id,
      name: symbol.name,
      kind: symbol.kind,
      line: symbol.line,
      // `null` from SQL becomes an ABSENT key, not `undefined`: the route answers
      // through the suite envelope, and a property holding `undefined` is not
      // lossless JSON — the same rule `dropUndefined` enforces on tool output.
      ...symbol.parent === null ? {} : { parent: symbol.parent },
    })),
    edges,
    truncated: total > all.length,
    totalSymbols: total,
  }
}
