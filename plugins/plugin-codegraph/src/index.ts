/**
 * DSH APP code graph — host half.
 *
 * One incrementally maintained knowledge graph per project, parsed with
 * tree-sitter and stored in the kernel's own `node:sqlite`, exposed as three
 * model tools. The design and its deferred parts:
 * `docs/plans/plugin-codegraph.md`.
 *
 * Why the graph exists. Two questions a coding agent asks constantly are
 * unanswerable from the file it is looking at: "what does this project consist
 * of" and "who is affected if I change this". Grep answers neither precisely —
 * a name search cannot tell a caller from a same-named unrelated function — and
 * reading every file to answer is exactly the cost the graph removes.
 *
 * Scope discipline, deliberate:
 *   - **Syntax, not types.** tree-sitter gives one grammar per language and no
 *     type resolution, so a reference is "this name appears here", not "this
 *     binding". That buys 36 languages for ~15 MB instead of one language and a
 *     compiler. Precision is the trade, and `codegraph_impact` reports the
 *     candidates rather than pretending to be a compiler.
 *   - **Calls, not data flow.** `references` edges come from call expressions
 *     only. Variable-level flow costs an order of magnitude more to compute and
 *     answers a question this plugin is not for.
 *   - **One database per project.** A corrupt graph cannot take another project
 *     with it, and deleting a project is one directory. Cross-project queries
 *     are impossible by construction — see the plan's out-of-scope list.
 *   - **Freshness is always reported.** Every tool answer carries whether the
 *     graph matches the working tree. A graph that answers from a stale snapshot
 *     without saying so is worse than one that refuses: the model cannot tell
 *     "no callers" from "we did not look".
 *
 * Stability: no global side effects beyond the registrations below. A kernel
 * without the services this needs never mounts anything.
 *
 * @module @dsh-app/plugin-codegraph
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Type-only: pulls the Connection Context merge (ctx.connection) into scope, so
// the settings routes register on ctx.connection.fetch rather than webServer.
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: pulls the systemPrompt Context merge (ctx.systemPrompt) and the
// AssembleContext.agent augmentation into scope, so the overview can be pushed as
// runtime context and read the session's cwd.
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gitHead, indexProject, isStale } from './indexer.ts'
import { parseFile } from './tree-sitter.ts'
import { LANGUAGES, bundledGrammarDir, downloadGrammar, grammarPath, type GrammarPaths } from './languages.ts'
import {
  ambiguousCandidates,
  calledBy,
  callsOf,
  documentsFor,
  dropUndefined,
  findSymbols,
  fileOutline,
  formatSymbol,
  freshnessNote,
  importsOf,
  projectOverview,
  referencesTo,
  relatedTo,
  resolveSymbol,
  symbolsInFile,
  type ContextResult,
  type FindResult,
  type Freshness,
  type ImpactResult,
} from './query.ts'
import { createIndexQueue, type IndexQueue } from './queue.ts'
import { overviewContextText } from './prompt.ts'
import { removeTree } from './remove-tree.ts'
import { registerCodegraphRoutes } from './routes.ts'
import { fileNodeId, openGraph, readProjectMeta, type Graph, type ProjectMeta } from './store.ts'

export const name = 'plugin-codegraph'

/**
 * Services this plugin cannot work without.
 *
 * `connection` is required because the settings routes ride its exact-Fetch
 * registry; `tools` because the three tools are the plugin's whole point;
 * `systemPrompt` because the project overview is pushed as runtime context — the
 * one mechanism that does not depend on the model choosing to look.
 */
export const inject = ['tools', 'connection', 'systemPrompt']

/** How many rows one tool answer may carry before it reports truncation. */
const MAX_ROWS = 40

/**
 * Where one project's graph lives.
 *
 * Derived from the cwd's sha256, never from a request body: a caller-chosen path
 * here would be an arbitrary file create/overwrite inside the storage root.
 */
export function graphFileFor(root: string): string {
  const key = createHash('sha256').update(root).digest('hex').slice(0, 32)
  return join(graphStorageRoot(), 'projects', key, 'graph.db')
}

/** The storage root this plugin owns under the kernel's home. */
function graphStorageRoot(): string {
  return join(resolveDshHome(), 'storages', 'dsh-app-plugin-codegraph')
}

/** The grammar directories this plugin reads and writes. */
function grammarPaths(): GrammarPaths {
  return {
    bundledDir: bundledGrammarDir(),
    downloadDir: join(resolveDshHome(), 'storages', 'dsh-app-plugin-codegraph', 'grammars'),
  }
}

/**
 * The tree-sitter runtime wasm this plugin ships.
 *
 * It lives beside the grammars in `grammars/` (asserted by the language suite),
 * so `Parser.init` resolves it from the plugin rather than the module layout of
 * whichever `web-tree-sitter` happened to be installed at build time.
 */
function runtimeWasm(): string {
  return join(bundledGrammarDir(), 'web-tree-sitter.wasm')
}

/**
 * The projects this machine already has a graph for.
 *
 * The queue keeps its project list in memory, so without this a restart shows
 * only the project a session happens to open — the five graphs on disk were
 * invisible until each was visited again. The directory NAME is a hash of the
 * project root and cannot be reversed, so the root is read out of each graph's
 * own `meta` row: the file is opened read-only, its metadata read, and the handle
 * closed before anything else touches the file.
 *
 * A directory with no readable metadata is skipped rather than reported: it is
 * either a half-written graph from a killed pass (the next visit rebuilds it) or
 * a leftovers directory, and neither is a fact a user can act on.
 *
 * @param storageRoot - the plugin's storage root, which holds `projects/`.
 * @returns one `{ cwd, meta }` per graph that carries metadata.
 */
export function knownProjects(storageRoot: string): { cwd: string, meta: ProjectMeta }[] {
  const projectsDir = join(storageRoot, 'projects')
  if (!existsSync(projectsDir)) return []
  const found: { cwd: string, meta: ProjectMeta }[] = []
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(projectsDir, entry.name, 'graph.db')
    if (!existsSync(file)) continue
    let graph: Graph | undefined
    try {
      graph = openGraph(file)
      const meta = readProjectMeta(graph.db)
      if (meta !== undefined && meta.cwd !== '') found.push({ cwd: meta.cwd, meta })
    } catch {
      // Unreadable graph: skipped, and the next pass for that project rebuilds it.
    } finally {
      try { graph?.close() } catch { /* already closed */ }
    }
  }
  return found
}

export function apply(ctx: Context): void {
  /** Open graphs by project root; a graph stays open for the plugin's lifetime. */
  const graphs = new Map<string, Graph>()
  const queue: IndexQueue = createIndexQueue(async (cwd) => {
    const graph = graphFor(cwd)
    return await indexProject(graph, cwd, async (source, path, languageId) => {
      // A grammar is resolved per file rather than per pass: an unsupported or
      // not-yet-installed language answers `unsupported` and the file is still
      // recorded, so the next pass skips it on the cheap comparison.
      const language = LANGUAGES.find(entry => entry.id === languageId)
      if (language === undefined) return { symbols: [], calls: [], imports: [], heritage: [], typeRefs: [], exports: [], hasError: false, unsupported: 'missing' as const }
      const paths = grammarPaths()
      const grammar = grammarPath(language, paths)
      if (grammar === undefined) return { symbols: [], calls: [], imports: [], heritage: [], typeRefs: [], exports: [], hasError: false, unsupported: 'missing' as const }
      return await parseFile(grammar, runtimeWasm(), source, path, languageId)
    })
  })

  /** The open graph for a project, opening and adopting it on first use. */
  const graphFor = (cwd: string): Graph => {
    const existing = graphs.get(cwd)
    if (existing !== undefined) return existing
    const opened = openGraph(graphFileFor(cwd))
    graphs.set(cwd, opened)
    queue.adopt(cwd, readProjectMeta(opened.db))
    return opened
  }

  /**
   * Delete one project's graph from disk and from this process's bookkeeping.
   *
   * Order matters and each step is here for a measured reason:
   *   1. close the open handle FIRST — Windows refuses to delete a file another
   *      handle holds, so deleting before closing fails with EBUSY;
   *   2. drop the queue entry, or the settings list keeps showing the project and
   *      the next `graphFor` re-creates an empty database from the same path;
   *   3. remove the project's DIRECTORY, not just `graph.db` — the WAL and SHM
   *      sidecars live beside it, and a leftover `-wal` holding pages of a deleted
   *      database is exactly the kind of thing that looks clean and is not.
   *
   * The directory comes from `graphFileFor`, which hashes the cwd, so a caller
   * cannot name the path to delete.
   *
   * @param cwd - the project whose graph goes away.
   */
  const forgetProject = async (cwd: string): Promise<void> => {
    const open = graphs.get(cwd)
    if (open !== undefined) {
      graphs.delete(cwd)
      try { open.close() } catch { /* already closed is the desired state */ }
    }
    queue.forget(cwd)
    await removeTree(dirname(graphFileFor(cwd)))
  }

  // Restore the project list from disk, once, at activation.
  //
  // The queue's project list is in memory, so without this a restart shows only
  // the project a session happens to open: measured on this machine, five graphs
  // were on disk and one was visible. `knownProjects` reads each graph's own
  // `meta.cwd` (the directory name is a hash and cannot be reversed) and adopts
  // it, which is exactly what `graphFor` does on first use — this just does it for
  // every project that already has a graph.
  //
  // WHY THIS IS DEFERRED. The first version ran `knownProjects` inline, and that
  // takes an exclusive SQLite lock per database (`journal_mode = WAL` does), so on
  // a machine whose graph was mid-pass it blocked the KERNEL's event loop inside
  // activation: the whole UI went dead — an empty settings pane and a code-graph
  // view stuck on "loading" — until the lock cleared. Restoring a LIST is not worth
  // one millisecond of that, so it happens after activation, and a failure to read
  // one graph cannot stop the plugin from loading.
  ctx.effect(() => {
    const timer = setTimeout(() => {
      try {
        for (const project of knownProjects(join(resolveDshHome(), 'storages', 'dsh-app-plugin-codegraph'))) {
          queue.adopt(project.cwd, project.meta)
        }
      } catch {
        // A storage root this process cannot read is not a reason to fail to load:
        // the list stays empty and each project is adopted on first use instead.
      }
    }, 0)
    return () => { clearTimeout(timer) }
  }, 'plugin-codegraph: restore the project list')

  /** The freshness of one project's graph, as every tool answer reports it. */
  const freshnessOf = async (cwd: string): Promise<{ freshness: Freshness, note: string | undefined }> => {
    const status = queue.status(cwd)
    const meta = readProjectMeta(graphFor(cwd).db)
    if (status?.state === 'failed') {
      // A structural failure is terminal until something explicit retries it.
      // Re-queueing here would re-run the whole pass on EVERY tool call and still
      // report `indexing` — the spin the queue's own header forbids, reintroduced
      // by the caller. The failure message goes to the model so it can act.
      return {
        freshness: 'indexing',
        note: `The last index pass for this project failed and will not retry on its own: ${status.failure ?? 'unknown error'}. Re-index from the code graph settings to try again.`,
      }
    }
    if (status?.state === 'indexing') {
      return { freshness: 'indexing', note: freshnessNote('indexing', meta?.truncated ?? false, meta?.removalSkipped ?? false) }
    }
    if (meta === undefined) {
      // A project touched for the first time has no graph. "All projects get a
      // graph" (the plan's premise) means this call must START the pass, not just
      // report the absence forever — otherwise the first tool call on a fresh
      // project returns nothing and nothing ever schedules it. The answer is still
      // empty (there is nothing to return), but it is reported as `indexing`, the
      // honest state once a pass is queued, and the next call sees rows.
      queue.request(cwd).catch(() => { /* recorded on the queue's status */ })
      return { freshness: 'indexing', note: freshnessNote('indexing', false, false) }
    }
    // Reading the working tree's HEAD is the only way to know the graph is
    // behind; doing it per call keeps the answer honest without a background
    // timer that would re-index projects nobody is looking at.
    const head = await gitHead(cwd)
    if (isStale(meta, head)) {
      queue.markStale(cwd)
      // A stale graph is still useful, so the answer is served AND the rebuild
      // is requested. The next call reports `indexing` or `current`.
      void queue.request(cwd).catch(() => { /* recorded on the queue's status */ })
      return { freshness: 'stale', note: freshnessNote('stale', meta.truncated, meta.removalSkipped) }
    }
    return { freshness: 'current', note: freshnessNote('current', meta.truncated, meta.removalSkipped) }
  }

  // Sync tool disposers and the routes' async disposer share one list. The type
  // has to admit both: a `() => Promise<void>` assigned to a `() => void` slot
  // type-checks, so an unawaited route teardown would only show up as a route
  // still registered after unload.
  const disposers: (() => void | Promise<void>)[] = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'codegraph_find',
    description:
      'Locate a symbol in this project WITHOUT reading files: answers "where is X declared / defined" with '
      + 'its kind, file and line, in one call. Use it as the first step of almost any question about the '
      + 'codebase — before opening files, grepping, or guessing a path — because the graph already holds '
      + 'every declaration in the project. '
      + 'Matching: an exact name wins over a substring; with no exact match it falls back to a '
      + 'case-insensitive substring search, so a partial name still finds candidates. '
      + 'The answer carries the graph\'s freshness: a "not found" while it reports stale or indexing means '
      + '"ask again in a moment", not "it does not exist".',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'A symbol name to look for. Exact names are preferred; a partial name falls back to a substring search.',
      },
      limit: {
        type: 'number',
        description: `Maximum matches to return (default ${String(MAX_ROWS)}).`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          freshness: { type: 'string', required: true, enum: ['current', 'stale', 'indexing'] },
          note: { type: 'string' },
          truncated: { type: 'boolean', required: true },
          symbols: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                path: { type: 'string', required: true },
                line: { type: 'number', required: true },
                parent: { type: 'string' },
                references: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const result = value as FindResult
        // The count goes ON the row, and the advice goes LAST. A caller count is what
        // tells the model whether the next question is cheap or expensive: at 7
        // matches a text search is the right tool, at 482 it costs ~15k tokens and a
        // judgement per line. Measured: without the count the model reached for grep
        // on both, because nothing in the answer said how large the question was.
        const lines = result.symbols.map((symbol) => {
          const row = `- ${formatSymbol(symbol)} — ${String(symbol.references)} call site(s)`
          return symbol.references > 20
            ? `${row} (large: \`codegraph_impact("${symbol.id}")\` is cheaper than searching)`
            : row
        })
        const head = `codegraph_find: ${String(result.symbols.length)} match(es)${result.truncated ? ' (truncated)' : ''}`
        return [{ type: 'text', text: [head, ...(result.note === undefined ? [] : [`note: ${result.note}`]), ...lines].join('\n') }]
      },
    },
    async execute(args, exec) {
      const cwd = requireCwd(exec.agent)
      const { freshness, note } = await freshnessOf(cwd)
      const found = findSymbols(graphFor(cwd), args.query, clampLimit(args.limit))
      return dropUndefined({ freshness, note, symbols: found.symbols, truncated: found.truncated }) satisfies FindResult
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'codegraph_impact',
    description:
      'Answer "what else does this touch before I change it" in ONE call: resolves a symbol, then lists '
      + 'every place that references it plus the files its own file imports. Use it before editing anything '
      + 'shared — a utility, a type, a public function — so the change does not surprise a caller you did '
      + 'not see. This is the reverse direction of codegraph_find: that one goes from a name to its '
      + 'declaration, this one from a declaration to its users. '
      + 'References are resolved by NAME, so a call through an interface or a dynamic dispatch may be '
      + 'missing — an empty list means "no direct calls found", never "safe to change". An ambiguous name '
      + 'answers no target rather than picking one, because describing the wrong symbol would look correct.',
    parameters: {
      symbol: {
        type: 'string',
        required: true,
        description: 'A symbol id from codegraph_find, or a name that is unique in this project.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          freshness: { type: 'string', required: true, enum: ['current', 'stale', 'indexing'] },
          note: { type: 'string' },
          target: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              name: { type: 'string', required: true },
              kind: { type: 'string', required: true },
              path: { type: 'string', required: true },
              line: { type: 'number', required: true },
              parent: { type: 'string' },
            },
          },
          referencing: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                line: { type: 'number', required: true },
                kind: { type: 'string', required: true },
                // The calling SYMBOL's name. W11b made `referencesTo` answer it,
                // and `additionalProperties: false` means an undeclared field is
                // an INVALID_TOOL_OUTPUT for the whole answer — so this row is
                // what keeps "who calls this" from failing the tool that asks.
                // Absent (not null) for a reference at file scope, which is why
                // it is optional rather than required.
                name: { type: 'string' },
              },
            },
          },
          imports: { type: 'array', required: true, items: { type: 'string' } },
          truncated: { type: 'boolean', required: true },
          total: { type: 'number', required: true },
          ambiguity: { type: 'number' },
          candidates: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                path: { type: 'string', required: true },
                line: { type: 'number', required: true },
                parent: { type: 'string' },
              },
            },
          },
          related: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                rows: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      path: { type: 'string', required: true },
                      line: { type: 'number', required: true },
                      kind: { type: 'string', required: true },
                      name: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const result = value as ImpactResult
        if (result.target === undefined) {
          // THREE different situations, and they must not read alike:
          //   - the name is not declared anywhere;
          //   - the name is declared several times, so no edge was ever built for it;
          //   - something else went wrong (a failure note is carried).
          if (result.candidates.length > 0) {
            const lines = [
              `codegraph_impact: "${String((_args as { symbol?: string }).symbol ?? '')}" is declared ${String(result.ambiguity)} time(s), so no reference edges were built for it. Pass one of these ids:`,
              ...result.candidates.map(candidate => `- ${formatSymbol(candidate)} (id: ${candidate.id})`),
              'An ambiguous name is not an absent one: this answer says nothing about how many callers exist. Verify with a text search before changing it.',
            ]
            return [{ type: 'text', text: lines.join('\n') }]
          }
          return [{ type: 'text', text: `codegraph_impact: no symbol named that in this project${result.note === undefined ? '' : `\nnote: ${result.note}`}` }]
        }
        // TWO numbers, each labelled with what it actually counts.
        //
        // This line used to read `referenced from ${referencing.length} file(s)`,
        // and `referencing` is one row per EDGE — so a symbol with 664 call sites
        // across 110 files was announced as "664 file(s)". That is the same defect
        // the overview had (203 distinct callers vs 664 call sites): a label that
        // names a different quantity than the number beside it. The count is call
        // sites, the file count is deduplicated from the rows.
        const referrerFiles = new Set(result.referencing.map(ref => ref.path)).size
        const lines = [
          `codegraph_impact: ${formatSymbol(result.target)}`,
          ...(result.note === undefined ? [] : [`note: ${result.note}`]),
          // The TOTAL leads when the list was cut, because the sample is not the
          // answer: "664 reference(s), 40 shown" tells the reader the size of what
          // they are looking at, which "40 reference(s) (truncated)" does not.
          ...(result.truncated
            ? [
                `referenced from ${String(result.total)} reference(s) — ${String(result.referencing.length)} shown, across ${String(referrerFiles)} file(s):`,
                ...result.referencing.map(ref => `- ${ref.path}:${String(ref.line)}`),
                `TRUNCATED: ${String(result.total - result.referencing.length)} more reference(s) exist. This is a SAMPLE, not the complete list — verify with a text search before concluding anything about callers.`,
              ]
            : [
                `referenced from ${String(result.total)} reference(s) across ${String(referrerFiles)} file(s):`,
                ...result.referencing.map(ref => `- ${ref.path}:${String(ref.line)}`),
              ]),
          ...(result.imports.length === 0 ? [] : ['its file imports:', ...result.imports.map(path => `- ${path}`)]),
          // The other relationships, each under its own heading. A class that
          // implements an interface does not call it, so these are not callers — and
          // "who implements this" is the question a reader has about an interface.
          ...result.related.flatMap(group => [
            `${group.kind === 'type_refs' ? 'mentioned in a signature' : group.kind === 'extends' ? 'derived from this' : 'implements this'} (${String(group.rows.length)}):`,
            ...group.rows.map(row => `- ${row.path}:${String(row.line)}${row.name === undefined ? '' : ` (${row.name})`}`),
          ]),
          // An empty list is the one answer that reads as "safe to change", and it is
          // also the answer name-only resolution produces for a call through an
          // interface, a dynamic dispatch, or a variable forwarding path. Said every
          // time, not only when something was truncated.
          ...(result.referencing.length === 0 && result.total === 0
            ? ['No direct callers found. That is NOT "safe to change": a call through an interface, a dynamic dispatch or a variable holds no name to resolve, so it leaves no edge. Verify with a text search.']
            : []),
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const cwd = requireCwd(exec.agent)
      const { freshness, note } = await freshnessOf(cwd)
      const graph = graphFor(cwd)
      const target = resolveSymbol(graph, args.symbol)
      if (target === undefined) {
        // An ambiguous name must not render like an absent one. `resolveSymbol`
        // answers undefined for both, and the previous version said "no unambiguous
        // symbol matched" with nothing to act on — measured: `streamWithDeltas` is
        // declared twice, every edge to it is dropped as ambiguous, and the answer
        // read as "no callers".
        const shared = ambiguousCandidates(graph, args.symbol, 5)
        return dropUndefined({
          freshness,
          note,
          target: undefined,
          referencing: [],
          imports: [],
          related: [],
          truncated: false,
          total: 0,
          candidates: shared.candidates,
          ambiguity: shared.total,
        }) satisfies ImpactResult
      }
      const referencing = referencesTo(graph, target.id, MAX_ROWS)
      const imports = importsOf(graph, target.path, MAX_ROWS)
      // Heritage and type references, kept in their own groups. Merging them into
      // `referencing` would make "who calls this" wrong — a class that implements an
      // interface does not call it, and an interface's reader is usually asking
      // exactly that question.
      const related = relatedTo(graph, target.id, MAX_ROWS)
      return dropUndefined({
        freshness,
        note,
        target,
        referencing: referencing.rows,
        imports: imports.rows,
        related: related.groups.map(group => ({ kind: group.kind, rows: group.rows })),
        // Every list in this answer reports whether it was cut: an incomplete list
        // of callers read as complete is the one failure that silently produces
        // wrong code rather than a wrong answer.
        truncated: referencing.truncated || imports.truncated || related.truncated,
        total: referencing.total,
        candidates: [],
      }) satisfies ImpactResult
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'codegraph_context',
    description:
      'Read one symbol\u2019s whole neighbourhood in a single call — its declaration, the other symbols in '
      + 'the same file, the calls it makes, what references it, what its file imports, and the project '
      + 'documents that mention it. Use it when you need to UNDERSTAND a piece before changing it: one '
      + 'call replaces several codegraph_find calls plus the file reads they would lead to. '
      + 'OMIT `symbol` to get the project OVERVIEW instead — file/symbol/edge counts, the language split, '
      + 'the files nothing imports (entry points, or a library\u2019s public surface) and the most-referenced '
      + 'symbols. Call it with no argument whenever you are asked what a project IS, where it starts, how '
      + 'it is organised, or how to begin in an unfamiliar repo, BEFORE listing directories or reading '
      + 'files: the graph already holds that shape. '
      + 'PASS A FILE PATH (any path the project holds, with or without ./) to get that file\u2019S OUTLINE: '
      + 'every symbol it declares, in line order, each with its own call-site count. That answers "what '
      + 'does this file define", "which methods does this class have" and "what is this module\u2019s public '
      + 'surface" — questions keyword search answers badly, because a method definition does not name its '
      + 'class and a symbol is not a keyword. '
      + 'A call is attributed to the enclosing declaration when it sits inside one, and to the file '
      + 'otherwise, so `calls` is this symbol\u2019s own calls plus any file-level call. Targets are resolved '
      + 'by name, so a name declared in more than one place produces no edge rather than a guess.',
    parameters: {
      symbol: {
        type: 'string',
        description: 'A symbol id from codegraph_find, a name unique in this project, or a project file path for its outline. Omit it to get the project overview.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          freshness: { type: 'string', required: true, enum: ['current', 'stale', 'indexing'] },
          note: { type: 'string' },
          symbol: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              name: { type: 'string', required: true },
              kind: { type: 'string', required: true },
              path: { type: 'string', required: true },
              line: { type: 'number', required: true },
              parent: { type: 'string' },
            },
          },
          siblings: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                path: { type: 'string', required: true },
                line: { type: 'number', required: true },
                parent: { type: 'string' },
              },
            },
          },
          calls: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                line: { type: 'number', required: true },
                path: { type: 'string' },
                name: { type: 'string' },
              },
            },
          },
          calledBy: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                line: { type: 'number', required: true },
                path: { type: 'string' },
                name: { type: 'string' },
              },
            },
          },
          imports: { type: 'array', required: true, items: { type: 'string' } },
          truncated: { type: 'boolean', required: true },
          documents: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                line: { type: 'number', required: true },
              },
            },
          },
          file: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              symbols: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                    kind: { type: 'string', required: true },
                    path: { type: 'string', required: true },
                    line: { type: 'number', required: true },
                    parent: { type: 'string' },
                    references: { type: 'number', required: true },
                    exported: { type: 'boolean', required: true },
                  },
                },
              },
              reExports: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
          overview: {
            type: 'object',
            additionalProperties: false,
            properties: {
              files: { type: 'number', required: true },
              symbols: { type: 'number', required: true },
              edges: { type: 'number', required: true },
              truncated: { type: 'boolean', required: true },
              byLanguage: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    lang: { type: 'string', required: true },
                    files: { type: 'number', required: true },
                  },
                },
              },
              entryCandidates: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string', required: true },
                    symbols: { type: 'number', required: true },
                    symbol: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        id: { type: 'string', required: true },
                        name: { type: 'string', required: true },
                        kind: { type: 'string', required: true },
                        path: { type: 'string', required: true },
                        line: { type: 'number', required: true },
                        parent: { type: 'string' },
                      },
                    },
                  },
                },
              },
              hubs: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    references: { type: 'number', required: true },
                    symbol: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        id: { type: 'string', required: true },
                        name: { type: 'string', required: true },
                        kind: { type: 'string', required: true },
                        path: { type: 'string', required: true },
                        line: { type: 'number', required: true },
                        parent: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const result = value as ContextResult
        if (result.file !== undefined) {
          // The outline, rendered as an outline: one line per declaration with its
          // caller count, so "which of these is the public surface" is readable
          // without asking again.
          const lines = [
            `codegraph_context: ${result.file.path} declares ${String(result.file.symbols.length)} symbol(s)${result.truncated ? ' (TRUNCATED — more exist)' : ''}`,
            ...(result.note === undefined ? [] : [`note: ${result.note}`]),
            // Exported first (the query orders them so) and marked, because "what
            // does this module expose" is the question this branch exists for.
            ...result.file.symbols.map(entry => {
              const parent = entry.parent === undefined ? '' : `${entry.parent}.`
              const mark = entry.exported ? ' [exported]' : ''
              return `- ${entry.kind} ${parent}${entry.name}:${String(entry.line)} — ${String(entry.references)} call site(s)${mark}`
            }),
            ...(result.file.reExports.length === 0
              ? []
              : ['re-exports these modules whole:', ...result.file.reExports.map(path => `- ${path}`)]),
            ...(result.imports.length === 0 ? [] : ['imports:', ...result.imports.map(path => `- ${path}`)]),
            'Pass any id above as `symbol` to expand it, or use `codegraph_impact` for what a change would touch.',
          ]
          return [{ type: 'text', text: lines.join('\n') }]
        }
        if (result.overview !== undefined) {
          const o = result.overview
          const lines = [
            `codegraph_context: project overview — ${String(o.files)} files, ${String(o.symbols)} symbols, ${String(o.edges)} edges${o.truncated ? ' (lists truncated)' : ''}`,
            ...(result.note === undefined ? [] : [`note: ${result.note}`]),
            `languages: ${o.byLanguage.map(entry => `${entry.lang} ${String(entry.files)}`).join(', ')}`,
            `entry candidates (${String(o.entryCandidates.length)}) — nothing imports these:`,
            ...o.entryCandidates.map(entry => `- ${entry.path} (${String(entry.symbols)} symbol(s))${entry.symbol === undefined ? '' : ` starts at ${entry.symbol.kind} ${entry.symbol.name}:${String(entry.symbol.line)}`}`),
            `most referenced (${String(o.hubs.length)}):`,
            ...o.hubs.map(hub => `- ${formatSymbol(hub.symbol)} — ${String(hub.references)} referrer(s)`),
            'Pass `symbol` (an id or a unique name) to expand any one of these.',
          ]
          return [{ type: 'text', text: lines.join('\n') }]
        }
        if (result.symbol === undefined) {
          return [{ type: 'text', text: `codegraph_context: no unambiguous symbol matched${result.note === undefined ? '' : `\nnote: ${result.note}`}` }]
        }
        const lines = [
          `codegraph_context: ${formatSymbol(result.symbol)}`,
          ...(result.note === undefined ? [] : [`note: ${result.note}`]),
          `same file (${String(result.siblings.length)}):`,
          ...result.siblings.map(symbol => `- ${formatSymbol(symbol)}`),
          ...(result.calls.length === 0 ? [] : ['calls made from here:', ...result.calls.map(edge => `- ${edge.name ?? '?'} at line ${String(edge.line)}`)]),
          ...(result.calledBy.length === 0 ? [] : ['called by:', ...result.calledBy.map(edge => `- ${edge.path ?? '?'}:${String(edge.line)}`)]),
          ...(result.imports.length === 0 ? [] : ['imports:', ...result.imports.map(path => `- ${path}`)]),
          ...(result.documents.length === 0 ? [] : ['described in:', ...result.documents.map(doc => `- ${doc.path}:${String(doc.line)}`)]),
          ...(result.truncated === true ? [`TRUNCATED: at least one list was cut at ${String(MAX_ROWS)} rows. Treat these as a sample, not the whole neighbourhood.`] : []),
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const cwd = requireCwd(exec.agent)
      const { freshness, note } = await freshnessOf(cwd)
      const graph = graphFor(cwd)
      // No selector: answer the question no symbol name can, from the graph's
      // own shape. This is the branch that makes the plugin reachable at all for
      // "where does this project start", which names nothing.
      if (args.symbol === undefined || args.symbol.trim() === '') {
        const shape = projectOverview(graph, MAX_ROWS)
        return dropUndefined({
          freshness,
          note,
          siblings: [],
          calls: [],
          calledBy: [],
          imports: [],
          documents: [],
          // The overview's own lists are bounded and it reports its own
          // `truncated`; the symbol-shaped fields here are all empty.
          truncated: false,
          // The query layer types its lists `readonly`; the tool's output schema
          // describes mutable arrays because that is what the JSON snapshot
          // carries. One cast at the boundary, where the shape is known equal.
          overview: shape as unknown as NonNullable<ContextResult['overview']>,
        }) satisfies ContextResult
      }
      // A FILE PATH: the outline, which is a structural question no keyword search
      // answers well. Measured (structural/semantic taxonomy): 6.5% accuracy for
      // "list the methods of class X" and 0-10% for "list the symbols in this file",
      // because a method definition does not mention its class and a symbol is not a
      // keyword. `symbolsInFile` already existed but was only reachable THROUGH a
      // symbol the model had to name first, which inverted the question.
      const asFile = fileOutline(graph, args.symbol.replace(/^\.\//u, '').replace(/\\/gu, '/'), MAX_ROWS)
      if (asFile.symbols.length > 0) {
        return dropUndefined({
          freshness,
          note,
          siblings: [],
          calls: [],
          calledBy: [],
          imports: importsOf(graph, asFile.path, MAX_ROWS).rows,
          documents: [],
          truncated: asFile.truncated,
          file: {
            path: asFile.path,
            symbols: asFile.symbols.map(entry => ({
              id: entry.symbol.id,
              name: entry.symbol.name,
              kind: entry.symbol.kind,
              path: entry.symbol.path,
              line: entry.symbol.line,
              parent: entry.symbol.parent,
              references: entry.references,
              // The public surface first, and marked: an exported symbol with no
              // internal caller is still the API, and that is the row a reader
              // asking "what does this module expose" wants.
              exported: entry.exported,
            })),
            reExports: asFile.starReExports,
          },
        } satisfies ContextResult)
      }
      const symbol = resolveSymbol(graph, args.symbol)
      if (symbol === undefined) {
        return dropUndefined({ freshness, note, symbol: undefined, siblings: [], calls: [], calledBy: [], imports: [], documents: [], truncated: false }) satisfies ContextResult
      }
      const symbolCalls = callsOf(graph, symbol.id, MAX_ROWS)
      const fileCalls = callsOf(graph, fileNodeId(symbol.path), MAX_ROWS)
      const called = calledBy(graph, symbol.id, MAX_ROWS)
      const imported = importsOf(graph, symbol.path, MAX_ROWS)
      const docs = documentsFor(graph, symbol.id, MAX_ROWS)
      return dropUndefined({
        freshness,
        note,
        symbol,
        siblings: symbolsInFile(graph, symbol.path, MAX_ROWS),
        // The symbol's OWN calls, plus whatever its file calls at file scope.
        // Before W11b this was the file's calls for every symbol in it, so a
        // 40-function file answered with the same 40-entry list 40 times.
        calls: [...symbolCalls.rows, ...fileCalls.rows],
        calledBy: called.rows,
        imports: imported.rows,
        documents: docs.rows,
        truncated: symbolCalls.truncated || fileCalls.truncated || called.truncated
          || imported.truncated || docs.truncated,
      }) satisfies ContextResult
    },
  })))

  disposers.push(registerCodegraphRoutes(ctx.connection.fetch, {
    statuses: () => queue.statuses(),
    grammarPaths,
    installLanguage: async (id) => {
      const spec = LANGUAGES.find(language => language.id === id)
      if (spec === undefined) throw new Error(`no language "${id}"`)
      await downloadGrammar(spec, grammarPaths())
    },
    removeLanguage: async (id) => {
      const spec = LANGUAGES.find(language => language.id === id)
      if (spec === undefined) throw new Error(`no language "${id}"`)
      const file = grammarPath(spec, grammarPaths())
      // Only a downloaded grammar is removable; a bundled one lives in the
      // plugin and is never in the download directory. `unlinkSync` on the one
      // exact file, not a recursive delete: this is a single .wasm, and a sync
      // recursive call is the shape that follows a junction (see the guard in
      // test/recursive-delete-guard.test.mjs).
      if (file === undefined || spec.bundled) return
      try { unlinkSync(file) } catch { /* absent is the already-removed case */ }
    },
    reindex: async (cwd) => { await queue.request(cwd) },
    forgetProject,
    graphFor,
  }))

  // THE ONE MECHANISM THAT DOES NOT DEPEND ON THE MODEL LOOKING.
  //
  // Measured, twice, on real sessions with a current graph and a correct tool
  // description: the model wrote "I should use codegraph_find / codegraph_context"
  // in its reasoning and then planned `glob` + `read` anyway, eight times. A
  // description is an instruction, and an instruction loses to the "explore =
  // list directories, read files" prior at the moment the plan is made.
  //
  // The overview is the ANSWER rather than an instruction, and it arrives before
  // that plan exists: "what is this project, where does it start" is already
  // answered, so the explore chain has nothing left to fetch. This is a push where
  // the tools were a pull — the plugin's output moves to where the decision is
  // made instead of waiting to be asked.
  //
  // Evaluated per assembly (`text` as a function), so a fresh graph, a re-index or
  // a new session all land without a restart. The `agent` in the assembly context
  // is the session whose cwd names the project, exactly as plugin-memory does for
  // its own per-session text.
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'dsh-app:codegraph:overview',
    // After the kernel's own operational context (cwd, sandbox) and beside the
    // suite's other per-session blocks: the model reads the project's shape after
    // it knows where it is, not before.
    order: 60,
    text: (assembly) => {
      const cwd = assembly.agent?.session.header.cwd
      if (cwd === undefined || cwd === '') return ''
      const status = queue.status(cwd)
      // A project with no entry in the queue has no graph yet. Queueing a pass
      // here would start an index on every assembly; `session/created` already
      // does it once, which is the right moment.
      if (status === undefined) return ''
      // Everything below is I/O; the DECISION lives in `overviewContextText`, so the
      // five states are testable without a Context, a queue or a database.
      let overview
      let meta
      if (status.state !== 'indexing' && status.state !== 'failed') {
        try {
          const graph = graphFor(cwd)
          overview = projectOverview(graph, MAX_ROWS)
          meta = readProjectMeta(graph.db)
        } catch {
          // A graph this process cannot read is not a reason to break the prompt:
          // the tools report the failure when they are called.
          return ''
        }
      }
      return overviewContextText({
        state: status.state === 'unindexed' ? 'indexing' : status.state,
        failure: status.failure,
        overview,
        truncated: meta?.truncated ?? false,
        removalSkipped: meta?.removalSkipped ?? false,
      })
    },
  }), 'plugin-codegraph: project overview as runtime context')

  ctx.effect(() => async () => {
    // Awaited, in order: the routes' disposer is async, and a route left
    // registered after unload collides on the next mount — a failure that lands
    // on the boot audit rather than on a warning. Queue first, so no pass is
    // still writing when the graphs close underneath it (P2-2).
    queue.dispose()
    for (const dispose of disposers.splice(0)) await dispose()
    for (const graph of graphs.values()) {
      try { graph.close() } catch { /* already closed */ }
    }
    graphs.clear()
  }, 'plugin-codegraph: tools, routes and graphs')

  /**
   * Build a project's graph when a session enters it, without being asked.
   *
   * The graph used to appear only after a session called one of the tools, which
   * made the settings page and the view empty for every project the user had not
   * queried — the index existed but only ever ran on demand. `session/created`
   * fires when a session is entered and announced, so it covers BOTH a new
   * session and a resumed one: an old session reopened after this plugin was
   * installed still gets its project indexed, which is the promise.
   *
   * `queue.request` is idempotent while a project is queued or running, so the
   * several events one project produces cost one pass, and a failure is recorded
   * on the project rather than thrown into the session's creation path.
   */
  ctx.on('session/created', (session) => {
    const cwd = session.header.cwd
    if (typeof cwd !== 'string' || cwd === '') return
    void queue.request(cwd).catch(() => {
      // Deliberately swallowed HERE and nowhere else: this listener runs inside
      // session creation, and a rejected promise there would surface as a broken
      // session. The failure is not lost — `request` records it on the project,
      // which the settings page reports.
    })
  })
}

/** The session's cwd, or a throw the model can act on. */
function requireCwd(agent: { session?: { header?: { cwd?: unknown } } } | undefined): string {
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd === '') {
    throw new Error('codegraph needs a session working directory; this turn has none')
  }
  return cwd
}

/** Clamp a requested row limit into a sane range. */
function clampLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return MAX_ROWS
  return Math.max(1, Math.min(Math.floor(requested), 200))
}
