/**
 * The incremental index pass: walk a project, parse what changed, forget what is
 * gone.
 *
 * The contract with `store.ts` is narrow on purpose. This module decides WHICH
 * files to parse; `replaceFile` / `forgetFile` decide what the graph says about
 * them. Nothing here writes SQL, and nothing in `store.ts` reads the disk.
 *
 * Why the pass is bounded. A first index of a real repository reads tens of
 * thousands of files, and doing that without limits turns a background task into
 * a memory spike and a UI that looks hung. The walk therefore stops at
 * {@link MAX_FILES} and reports `truncated`, which the tools surface — a graph
 * that covers 90% of a project and says so is useful; one that silently covers
 * 60% is not.
 *
 * What counts as changed. `mtime` + `size` first, because that is one `stat` per
 * file and catches every ordinary edit. A same-size rewrite with a preserved
 * mtime (a checkout, a restore from backup, some editors) slips past both, so a
 * file whose `mtime`+`size` match is re-hashed only when its recorded hash is
 * absent — otherwise the pass would hash every file on every run, which is the
 * cost this comparison exists to avoid. `hash` is still stored, so a future
 * `--verify` mode can use it.
 *
 * @module @dsh-app/plugin-codegraph/host/indexer
 */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { languageForPath } from './languages.ts'
import { DOCUMENT_EXTENSIONS, documentMentions, knownNames } from './docs.ts'
import { callEdges, relationEdges, type ParsedFile } from './parse.ts'
import {
  allRows,
  fileNodeId,
  forgetFile,
  graphStats,
  readFiles,
  replaceFile,
  symbolsOf,
  writeProjectMeta,
  type FileRecord,
  type Graph,
  type ProjectMeta,
  type SymbolRecord,
} from './store.ts'

const execFileAsync = promisify(execFile)

/** How many files one pass will consider. */
export const MAX_FILES = 20_000

/** Directories never worth walking: dependency trees, build output, VCS metadata. */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'vendor',
  '.next', '.nuxt', '.cache', '.turbo', '.venv', 'venv', '__pycache__',
  'coverage', '.test-dist', 'lib', 'release', 'runtime-dist', 'bundled-kernel',
  // .NET build output. Measured on a real WPF project: `obj/Release/net9.0-windows`
  // and its `win-x64` variant contributed ten files that declare nothing, and the
  // view listed them as two blocks of "0 symbols" under a path nobody wrote. A
  // generated file has no place in a graph of the source.
  'obj', 'bin',
])

/** A file that is large enough to be generated rather than written. */
const MAX_FILE_BYTES = 1_500_000

/** What one pass did. */
export interface IndexOutcome {
  /** Files parsed in this pass. */
  readonly parsed: number
  /** Files whose `mtime`/`size` matched the graph, so they were skipped. */
  readonly skipped: number
  /** Paths removed from the graph because they are no longer on disk. */
  readonly removed: number
  /** True when {@link MAX_FILES} stopped the walk before the tree was exhausted. */
  readonly truncated: boolean
  /** Files skipped because their grammar is NOT INSTALLED (a download fixes it). */
  readonly missingLanguage: number
  /** Files skipped because this plugin has no extraction rules for an installed grammar. */
  readonly noRules: number
  /** Files whose parse produced an ERROR node; their symbols are partial. */
  readonly parseErrors: number
  /** Files present but not indexed because they exceed the size limit. */
  readonly tooLarge: number
  /** Wall time of the pass. */
  readonly durationMs: number
  /**
   * True when the removal pass did NOT run.
   *
   * Deleting from the graph is only safe when the scan is trustworthy: a
   * truncated walk or an unreadable root both produce a SHORTER file list than
   * the disk really has, and treating that as "these files are gone" would
   * silently drop most of a project. The pass then reports `removalSkipped` and
   * keeps the old rows — a graph that is stale is recoverable, a graph that
   * deleted half a repository is not.
   */
  readonly removalSkipped: boolean
}

/** `git rev-parse HEAD` in a directory, or '' when it is not a repository. */
export async function gitHead(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd,
      windowsHide: true,
      timeout: 10_000,
    })
    return stdout.trim()
  } catch {
    // Not a repository, or no commits yet. Both mean "no HEAD to compare",
    // which the stale check treats as "cannot prove freshness".
    return ''
  }
}

/** What one file the walk found, before parsing. */
interface Candidate {
  readonly path: string
  readonly mtime: number
  readonly size: number
  /**
   * True when this is a DOCUMENT (prose that names symbols) rather than source.
   *
   * The distinction has to be carried out of the walk rather than re-derived
   * later: both kinds end up as rows in `files`, and a second `languageForPath`
   * call at the use site is how a document would one day be handed to a parser.
   */
  readonly document: boolean
}

/** A path's extension, lower case, with its dot; empty when it has none. */
function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.')
  const slash = path.lastIndexOf('/')
  if (dot <= slash || dot < 0) return ''
  return path.slice(dot).toLowerCase()
}

/** What a walk produced, including the facts that decide whether deletion is safe. */
export interface ScanResult {
  readonly files: Candidate[]
  /** True when {@link MAX_FILES} cut the walk short. */
  readonly truncated: boolean
  /** Files that exist but were skipped for size; never candidates for deletion. */
  readonly tooLarge: string[]
  /**
   * True when the ROOT itself could not be read.
   *
   * An unreadable subdirectory is tolerable (it may be a permission quirk), but
   * an unreadable root means the scan learned nothing, and the caller must not
   * treat its empty result as "everything is gone".
   */
  readonly rootUnreadable: boolean
}

/**
 * Walk a project for parseable files.
 *
 * @param root - the absolute project root.
 * @param limit - the file budget.
 * @returns the candidates plus the facts that decide whether removal is safe.
 */
export function scanProject(root: string, limit = MAX_FILES): ScanResult {
  const files: Candidate[] = []
  const tooLarge: string[] = []
  let truncated = false

  const walk = (dir: string): void => {
    if (truncated) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      // An unreadable SUBdirectory is skipped; the root is checked below.
      return
    }
    for (const entry of entries) {
      if (truncated) return
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        walk(join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const absolute = join(dir, entry.name)
      const relativePath = relative(root, absolute).split(sep).join('/')
      // A document is walked for its own sake, not parsed. It carries no symbols
      // and no imports; what it contributes is the list of symbols it NAMES
      // (`docs.ts`), which the second phase turns into `documents` edges.
      const isDocument = DOCUMENT_EXTENSIONS.includes(extensionOf(relativePath))
      if (!isDocument && languageForPath(relativePath) === undefined) continue
      let stat
      try {
        stat = statSync(absolute)
      } catch {
        continue
      }
      if (stat.size > MAX_FILE_BYTES) {
        // Recorded, never silently dropped: a file that grew past the limit is
        // still on disk, so the removal pass must not treat it as gone.
        tooLarge.push(relativePath)
        continue
      }
      if (files.length >= limit) {
        truncated = true
        return
      }
      files.push({ path: relativePath, mtime: Math.floor(stat.mtimeMs), size: stat.size, document: isDocument })
    }
  }

  let rootUnreadable = false
  try {
    readdirSync(root)
  } catch {
    rootUnreadable = true
  }
  if (!rootUnreadable) walk(root)
  return { files, truncated, tooLarge, rootUnreadable }
}

/**
 * Resolve one import specifier to a project-relative path, or undefined.
 *
 * Deliberately minimal, and honest about it: relative specifiers resolve against
 * the importing file; a bare specifier (`react`, `@deepseek-ai/…`) is a package
 * and has no file in this project, so it resolves to nothing rather than to a
 * guess. Extension completion tries the exact path first, then the common
 * additions, then `index.*` — the three shapes a real import takes.
 *
 * A resolver that guesses would turn "this package is external" into "this file
 * depends on some other file with a similar name", which is worse than no edge.
 *
 * @param from - the importing file's project-relative path.
 * @param specifier - the raw specifier.
 * @param exists - predicate for "is this path in the project".
 * @returns the target path, or undefined.
 */
export function resolveImport(
  from: string,
  specifier: string,
  exists: (path: string) => boolean,
): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = from.split('/').slice(0, -1)
  const parts = specifier.split('/')
  const stack = [...base]
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  const joined = stack.join('/')
  const candidates = [
    joined,
    `${joined}.ts`, `${joined}.tsx`, `${joined}.js`, `${joined}.mjs`, `${joined}.cjs`,
    `${joined}.py`, `${joined}.go`, `${joined}.java`, `${joined}.cs`, `${joined}.c`, `${joined}.cpp`,
    `${joined}/index.ts`, `${joined}/index.tsx`, `${joined}/index.js`,
  ]
  return candidates.find(candidate => exists(candidate))
}

/**
 * The name→ids table for the whole project, read once.
 *
 * Project-wide rather than pass-local, and that part is load-bearing: the callee
 * may be declared in a file this pass SKIPPED (unchanged since the last run), so a
 * map built only from the files just parsed would make every reference into an
 * unchanged file vanish.
 *
 * Read in ONE query for the same reason: the first version ran a `SELECT` per call
 * edge inside the phase-2 transaction, and on a 1613-file project that resolved
 * tens of thousands of times and held the kernel's event loop for 251 seconds.
 *
 * @param graph - the open graph.
 * @returns name → every id carrying it (an ambiguous name stays ambiguous, which
 *   is what `callEdges` checks before drawing an edge).
 */
function namesIndex(graph: Graph): (name: string) => readonly string[] {
  const byName = new Map<string, string[]>()
  for (const row of allRows<{ id: string, name: string }>(graph.db, 'SELECT id, name FROM symbols')) {
    const list = byName.get(row.name)
    if (list === undefined) byName.set(row.name, [row.id])
    else list.push(row.id)
  }
  return (name) => byName.get(name) ?? []
}

/**
 * Drop the stat-cache row of every file a failed phase left without its edges.
 *
 * Phase 1 commits each file's `mtime`/`size`/`hash` before phase 2 builds its
 * edges, so a phase 2 failure would otherwise leave the graph claiming those files
 * are unchanged — the next pass skips them and the edges never come back. With no
 * `files` row the next pass re-parses the file, which is the only way to rebuild
 * the edges phase 1's range delete already removed.
 *
 * Only the `files` row goes: the symbols stay, so the graph still answers
 * `codegraph_find` for these files while the next pass repairs their edges.
 *
 * @param graph - the open graph.
 * @param entries - the files whose edges are missing, at minimum their `path`.
 */
function forgetStatCache(graph: Graph, entries: readonly { readonly path: string }[]): void {
  if (entries.length === 0) return
  const drop = graph.db.prepare('DELETE FROM files WHERE path = ?')
  graph.db.exec('BEGIN')
  try {
    for (const entry of entries) drop.run(entry.path)
    graph.db.exec('COMMIT')
  } catch (error) {
    try { graph.db.exec('ROLLBACK') } catch { /* already rolled back */ }
    // A failure here must not mask the phase error the caller is already carrying;
    // the next pass still re-reads these files because their mtime never moved on.
    void error
  }
}

/**
 * Run one incremental pass over a project.
 *
 * `parse` is injected rather than imported so this module stays free of
 * tree-sitter: the parse itself needs the grammar loader and the wasm runtime,
 * and a test that only cares about the diffing should not have to load either.
 *
 * @param graph - the open graph for this project.
 * @param root - the absolute project root.
 * @param parse - turns a source string into symbols and edges for one file.
 * @param now - clock, injectable for tests.
 * @returns what the pass did.
 */
export async function indexProject(
  graph: Graph,
  root: string,
  parse: (source: string, path: string, languageId: string) => ParsedFile | Promise<ParsedFile>,
  now: () => number = Date.now,
  limit = MAX_FILES,
): Promise<IndexOutcome> {
  const started = now()
  const known = readFiles(graph.db)
  const scan = scanProject(root, limit)
  const seen = new Set<string>(scan.tooLarge)

  let parsed = 0
  let skipped = 0
  let missingLanguage = 0
  let noRules = 0
  let parseErrors = 0
  /**
   * Whether phase 3 has to re-derive document edges this pass.
   *
   * Set by anything that can change the answer: a document whose bytes changed, or
   * a source file that contributed or retired symbols (a mention resolves against
   * the symbol table, so a new declaration makes an old paragraph point somewhere
   * new). When neither happened the previous pass's edges are still correct, and
   * re-deriving them costs a full re-read of every document — measured at 64
   * seconds on a real project before the fan-out was capped, and still the single
   * most expensive step afterwards.
   */
  let documentsDirty = false
  let symbolsChanged = false

  // Two phases, because a call edge needs the CALLEE to be in the graph already
  // and the walk order is arbitrary: `a.ts` calling `beta` must resolve whether
  // `b.ts` was parsed before or after it. Phase 1 writes every changed file's
  // symbols and contains edges; phase 2 resolves the calls against the finished
  // symbol table.
  const pending: { path: string, fileId: string, parsed: ParsedFile }[] = []

  /**
   * Yield to the event loop, so a long pass does not freeze the kernel.
   *
   * BY TIME, not by a file count. The first version yielded every 64 files, which
   * reads as "bounded" and is not: 64 files that each need a full tree-sitter parse
   * and a transaction is seconds of a blocked event loop, and the kernel serves the
   * whole UI from it — measured on a 1930-file project, the window went dead with an
   * empty settings pane and a graph view stuck on "loading".
   *
   * A time budget is what actually bounds the stall: 8ms of work then one turn of
   * the loop, whatever the files weigh.
   */
  const BREATHE_MS = 8
  let lastBreathe = Date.now()
  const breatheIfDue = async (): Promise<void> => {
    if (Date.now() - lastBreathe < BREATHE_MS) return
    await new Promise<void>(resolve => { setImmediate(resolve) })
    lastBreathe = Date.now()
  }

  for (const candidate of scan.files) {
    seen.add(candidate.path)
    const previous = known.get(candidate.path)
    if (previous !== undefined && previous.mtime === candidate.mtime && previous.size === candidate.size) {
      skipped += 1
      continue
    }
    // Documents take their own path: their row is stored (so the stat cache stops
    // a re-read every pass), and they are never handed to a parser and never
    // declare a symbol. Their TEXT is re-read in phase 3, which scans every known
    // document — see the comment there for why that is not just this pass's
    // changed ones.
    if (candidate.document) {
      let docHash: string
      try {
        const bytes = readFileSync(join(root, candidate.path))
        docHash = createHash('sha256').update(bytes).digest('hex')
      } catch {
        // Vanished between the scan and the read; `seen` already holds it, so the
        // removal pass leaves its old rows for the next run.
        continue
      }
      if (previous !== undefined && previous.hash === docHash) {
        graph.db.prepare('UPDATE files SET mtime = ?, size = ? WHERE path = ?')
          .run(candidate.mtime, candidate.size, candidate.path)
        skipped += 1
        continue
      }
      replaceFile(graph.db, { path: candidate.path, mtime: candidate.mtime, size: candidate.size, hash: docHash, lang: 'document' }, [], [])
      documentsDirty = true
      continue
    }
    const language = languageForPath(candidate.path)
    if (language === undefined) continue
    let source: string
    let hash: string
    try {
      const bytes = readFileSync(join(root, candidate.path))
      // One read: the hash comes from the same bytes the parse sees, so a file
      // edited between two reads cannot record a hash that describes neither.
      hash = createHash('sha256').update(bytes).digest('hex')
      source = bytes.toString('utf8')
    } catch {
      // Vanished between the scan and the read. It stays in `seen`, so the
      // removal pass leaves its old rows for the next run to settle.
      continue
    }
    if (previous !== undefined && previous.hash === hash) {
      // Same bytes, new timestamp: a checkout, a stash, a touch. Record the new
      // stamp, or every later pass re-reads and re-hashes this file forever.
      graph.db.prepare('UPDATE files SET mtime = ?, size = ? WHERE path = ?')
        .run(candidate.mtime, candidate.size, candidate.path)
      skipped += 1
      continue
    }
    const result = await parse(source, candidate.path, language.id)
    if (result.unsupported !== false) {
      // The file row is still written: it is the stat cache, and without it this
      // file is re-read and re-parsed on every pass forever. `lang` records what
      // it would need, which is what the settings page counts.
      if (result.unsupported === 'missing') missingLanguage += 1
      else noRules += 1
      graph.db.prepare('INSERT INTO files (path, mtime, size, hash, lang) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, hash = excluded.hash, lang = excluded.lang')
        .run(candidate.path, candidate.mtime, candidate.size, hash, language.id)
      continue
    }
    if (result.hasError) parseErrors += 1
    const record: FileRecord = {
      path: candidate.path,
      mtime: candidate.mtime,
      size: candidate.size,
      hash,
      lang: language.id,
    }
    const fileId = fileNodeId(candidate.path)
    // Phase 1: symbols plus the `contains` edges that need nothing but this file.
    replaceFile(graph.db, record, result.symbols, result.symbols.map(symbol => ({
      from: fileId,
      to: symbol.id,
      kind: 'contains' as const,
      line: symbol.line,
    })))
    pending.push({ path: candidate.path, fileId, parsed: result })
    symbolsChanged = true
    parsed += 1
    // After EVERY file, decided by elapsed time rather than a file count: the call
    // is cheap when it is not due, and it is the only thing standing between a
    // 2000-file pass and a kernel that cannot answer the UI.
    await breatheIfDue()
  }

  // Phase 2: the calls and imports, now that every changed file's symbols are
  // present.
  //
  // WHY THE FILES ROWS ARE DELETED ON FAILURE. Phase 1 already committed each
  // file's `mtime`/`size`/`hash` (inside `replaceFile`), and phase 2 runs in
  // BATCHES of `FILES_PER_COMMIT` so a large pass can yield to the event loop. A
  // failure therefore rolls back only the batch in flight: every earlier batch
  // stays committed, and — worse — the `files` rows from phase 1 stay too. The
  // next pass then skips those files by mtime, `pending` is empty, and the
  // `references` edges phase 1's range delete removed are never rebuilt. The graph
  // reports `current` while under-reporting every caller of those files.
  //
  // So a failure deletes the `files` rows for everything still pending: without a
  // stat-cache row the next pass re-parses the file and rebuilds its edges. This
  // is the invariant the old single-transaction version got for free and the
  // batched version has to restore explicitly.
  if (pending.length > 0) {
    const insert = graph.db.prepare('INSERT OR IGNORE INTO edges (src, dst, kind, line) VALUES (?, ?, ?, ?)')
    // `imports` targets are project-relative paths; the graph's file nodes are
    // keyed the same way, so membership in the known set is the resolution test.
    const knownPaths = new Set<string>([...known.keys(), ...seen])
    // ONE query for the whole name table, not one per call edge.
    //
    // `resolveName` used to run a SELECT per edge, inside this transaction, and
    // that is what made a real pass unusable: a 1613-file project resolves tens of
    // thousands of edges, and measured end to end the pass held the kernel's event
    // loop for 251 SECONDS — the window went dead, the settings pane emptied, and
    // "new session" did nothing until it finished. The table is a few thousand rows,
    // so reading it once costs milliseconds and turns N queries into 1.
    const resolveOnce = namesIndex(graph)
    /**
     * Files per transaction, and the yield between them.
     *
     * The phase used to be one transaction with no yield, so a 1600-file project
     * held the kernel's event loop for its whole duration (measured: seconds of a
     * dead window). A file's edges are independent of the next file's, so batching
     * them costs nothing and gives the loop a turn between batches.
     */
    const FILES_PER_COMMIT = 50
    let inBatch = 0
    graph.db.exec('BEGIN')
    try {
      for (const entry of pending) {
        for (const edge of callEdges(entry.parsed, entry.fileId, resolveOnce)) {
          insert.run(edge.from, edge.to, edge.kind, edge.line)
        }
        // Heritage and type references, resolved the same way calls are. These are
        // the edges that let `impact` answer "who implements this interface" and
        // "which signatures name this type" — neither is a call, so `callEdges`
        // could never produce them.
        for (const edge of relationEdges(
          entry.parsed,
          entry.fileId,
          resolveOnce,
          // The same resolver `imports` uses: a re-export and an import name a path
          // in exactly the same way, so a star edge points at the node the rest of the
          // graph uses instead of at a `./`-relative string that joins to nothing.
          specifier => resolveImport(entry.path, specifier, path => knownPaths.has(path)),
        )) {
          insert.run(edge.from, edge.to, edge.kind, edge.line)
        }
        for (const specifier of entry.parsed.imports) {
          const target = resolveImport(entry.path, specifier.specifier, path => knownPaths.has(path))
          if (target === undefined) continue
          insert.run(entry.fileId, fileNodeId(target), 'imports', specifier.line)
        }
        inBatch += 1
        if (inBatch >= FILES_PER_COMMIT) {
          graph.db.exec('COMMIT')
          inBatch = 0
          await new Promise<void>(resolve => { setImmediate(resolve) })
          graph.db.exec('BEGIN')
        }
      }
      graph.db.exec('COMMIT')
    } catch (error) {
      try { graph.db.exec('ROLLBACK') } catch { /* already rolled back */ }
      forgetStatCache(graph, pending)
      throw error
    }
  }

  // Phase 3: the documents. Deliberately AFTER phase 2, because a `documents`
  // edge targets a symbol and a document may name one declared in a file the walk
  // reached later.
  //
  // TWO decisions here, each fixing a defect the first version shipped:
  //
  //   - The edge targets `file:<docpath>`, with the LINE in the `line` column,
  //     instead of a `doc:<path>#<line>` pseudo-node. A doc node is in no table,
  //     so nothing that reclaims a path knew to reclaim it: deleting a document
  //     left its edges as permanent orphans. A file node is what `forgetFile`
  //     already sweeps, and the primary key `(src, dst, kind, line)` keeps the
  //     same document's several mentions apart.
  //   - The scan covers EVERY known document on every pass, not only the ones
  //     whose bytes changed. `replaceFile` deletes every outgoing edge of a file's
  //     symbols, so editing `a.ts` removed the edges INTO a.ts's symbols from
  //     documents that had not changed — and only a changed document was ever
  //     rescanned, so they never came back. Rescanning all of them costs a few
  //     hundred file reads; tracking which name appears in which document costs a
  //     second index and a new way to be wrong.
  const documentPaths = allRows<{ path: string }>(graph.db, 'SELECT path FROM files WHERE lang = ?', 'document')
  // Re-derived only when the answer can have changed: a document whose bytes moved,
  // or a source file that added or retired symbols (a mention resolves against the
  // symbol table). When neither happened the previous edges are still correct, and
  // re-reading every document is the most expensive step of the pass.
  if (documentPaths.length > 0 && (documentsDirty || symbolsChanged)) {
    // The mention scan matches by NAME, but an edge needs a NODE id, and one name
    // can be declared in several places (a `render` in each component, an `open`
    // per class). Every declaration of a mentioned name gets the edge: guessing
    // which one a paragraph meant is exactly the confident-but-wrong edge this
    // plugin exists to avoid.
    const byName = new Map<string, SymbolRecord[]>()
    const declared: SymbolRecord[] = []
    for (const symbol of symbolsOf(graph.db)) {
      declared.push(symbol)
      const existing = byName.get(symbol.name)
      if (existing === undefined) byName.set(symbol.name, [symbol])
      else existing.push(symbol)
    }
    const known2 = knownNames(declared)
    /**
     * How many declarations ONE mention may point at.
     *
     * This number is the whole cost of phase 3, and it was measured rather than
     * guessed. A real project's documents produced 103,334 mentions, and at 20
     * targets each that is two million inserts — 64 seconds inside one phase,
     * which froze the kernel. The scan itself is cheap (117ms for the same 127
     * documents); the fan-out is what costs.
     *
     * ONE. A paragraph that names `index` does not describe 300 unrelated
     * declarations, and a reader following the edge wants the one the author meant.
     * With a single target the phase is linear in mentions instead of
     * mentions × duplicates, and the answer stays useful: `context` still shows
     * the documents that name a symbol, which is the feature.
     */
    const MAX_TARGETS_PER_MENTION = 1
    // DELETE then INSERT inside one transaction. The delete is per DOCUMENT, not
    // per symbol, so a mention the author removed stops being an edge — the first
    // version only inserted, so a deleted paragraph kept its edge for ever.
    const clear = graph.db.prepare("DELETE FROM edges WHERE kind = 'documents' AND dst = ?")
    const insert = graph.db.prepare('INSERT OR IGNORE INTO edges (src, dst, kind, line) VALUES (?, ?, ?, ?)')
    /**
     * Documents per transaction, and the yield between them.
     *
     * This loop used to run inside ONE transaction with no yield, which is what
     * made a real project freeze the whole kernel: measured on a 1771-file project,
     * phase 3 alone ran past 200 seconds with the event loop held the entire time —
     * the window stopped answering, the settings pane came up empty, and "new
     * session" did nothing. The cost of the scan is not the problem; running it
     * without ever returning to the loop is.
     *
     * 25 is small enough that one batch is milliseconds and large enough that the
     * commit overhead stays negligible against the file reads.
     */
    const DOCS_PER_COMMIT = 25
    let inBatch = 0
    graph.db.exec('BEGIN')
    try {
      for (const row of documentPaths) {
        const target = fileNodeId(row.path)
        clear.run(target)
        let text: string
        try {
          text = readFileSync(join(root, row.path)).toString('utf8')
        } catch {
          // Gone between the walk and this read; `seen` already covered it, so the
          // removal pass settles the file row on the next run.
          continue
        }
        for (const mention of documentMentions({ path: row.path, text }, known2)) {
          // The edge points FROM the symbol TO the document: "this code is
          // described here", which is what `context` reads.
          const targets = byName.get(mention.name) ?? []
          const keep = targets.length > MAX_TARGETS_PER_MENTION ? targets.slice(0, MAX_TARGETS_PER_MENTION) : targets
          for (const symbol of keep) {
            insert.run(symbol.id, target, 'documents', mention.line)
          }
        }
        inBatch += 1
        if (inBatch >= DOCS_PER_COMMIT) {
          // Commit, then give the loop a turn. A batch that fails leaves the
          // documents before it committed and the rest for the next pass, which is
          // the same recovery the phase already has: the documents' file rows are
          // written, so a re-run re-derives their edges.
          graph.db.exec('COMMIT')
          inBatch = 0
          await new Promise<void>(resolve => { setImmediate(resolve) })
          graph.db.exec('BEGIN')
        }
      }
      graph.db.exec('COMMIT')
    } catch (error) {
      try { graph.db.exec('ROLLBACK') } catch { /* already rolled back */ }
      // Same recovery as phase 2, and for the same reason: a document whose edges
      // were cleared but not rewritten must be re-scanned. Its `files` row does not
      // decide that here (this phase re-reads every document when the pass is dirty),
      // but dropping it keeps one rule for both phases instead of two.
      forgetStatCache(graph, documentPaths.map(row => ({ path: row.path })))
      throw error
    }
  }

  const removalSkipped = scan.truncated || scan.rootUnreadable
  let removed = 0
  if (!removalSkipped) {
    for (const path of known.keys()) {
      if (seen.has(path)) continue
      forgetFile(graph.db, path)
      removed += 1
      symbolsChanged = true
    }
  }

  const stats = graphStats(graph.db)
  const meta: ProjectMeta = {
    cwd: root,
    name: root.split(/[\\/]/u).filter(part => part !== '').pop() ?? root,
    head: await gitHead(root),
    indexedAt: now(),
    fileCount: stats.files,
    symbolCount: stats.symbols,
    edgeCount: stats.edges,
    truncated: scan.truncated,
    removalSkipped,
    missingLanguage,
    noRules,
    parseErrors,
  }
  writeProjectMeta(graph.db, meta)

  return {
    parsed,
    skipped,
    removed,
    truncated: scan.truncated,
    missingLanguage,
    noRules,
    parseErrors,
    tooLarge: scan.tooLarge.length,
    durationMs: now() - started,
    removalSkipped,
  }
}

/**
 * Whether a stored HEAD still describes the working tree.
 *
 * Three states, not two. `undefined` (never indexed) and a stored HEAD that
 * differs are both stale. An UNPROVABLE comparison — no repository, or no git on
 * PATH, which both answer `''` — is NOT stale: a graph that reports stale
 * forever would re-index on every query and never converge, because re-indexing
 * writes `''` again.
 *
 * @param meta - the stored metadata, or undefined.
 * @param head - the working tree's HEAD, or '' when it could not be read.
 * @returns true only when the graph is provably out of date.
 */
export function isStale(meta: ProjectMeta | undefined, head: string): boolean {
  if (meta === undefined) return true
  // No HEAD on either side: the project is not a repository (or git is absent),
  // so freshness cannot be judged by HEAD. The mtime comparison still governs
  // which files get re-parsed, so this is not a blind spot in practice.
  if (meta.head === '' && head === '') return false
  // A project that became a repository after indexing: the stored '' cannot
  // describe the new HEAD.
  if (meta.head === '') return true
  return meta.head !== head
}
