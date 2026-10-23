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
import { createHash } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { gitHead, indexProject, isStale } from './indexer.ts'
import { parseFile } from './tree-sitter.ts'
import { LANGUAGES, bundledGrammarDir, downloadGrammar, grammarPath, type GrammarPaths } from './languages.ts'
import {
  calledBy,
  callsOf,
  documentsFor,
  dropUndefined,
  findSymbols,
  formatSymbol,
  freshnessNote,
  importsOf,
  referencesTo,
  resolveSymbol,
  symbolsInFile,
  type ContextResult,
  type FindResult,
  type Freshness,
  type ImpactResult,
} from './query.ts'
import { createIndexQueue, type IndexQueue } from './queue.ts'
import { registerCodegraphRoutes } from './routes.ts'
import { fileNodeId, openGraph, readProjectMeta, type Graph } from './store.ts'

export const name = 'plugin-codegraph'

/**
 * Services this plugin cannot work without.
 *
 * `connection` is required because the settings routes ride its exact-Fetch
 * registry; `tools` because the three tools are the plugin's whole point.
 */
export const inject = ['tools', 'connection']

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
      if (language === undefined) return { symbols: [], calls: [], imports: [], hasError: false, unsupported: true }
      const paths = grammarPaths()
      const grammar = grammarPath(language, paths)
      if (grammar === undefined) return { symbols: [], calls: [], imports: [], hasError: false, unsupported: true }
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
      'Find where a symbol is declared in this project. Returns each match with its kind, file and line. '
      + 'Use this before reading files to answer "where is X implemented" or "what does this project call it". '
      + 'An exact name match wins over a substring match; if no name matches exactly, it falls back to a '
      + 'case-insensitive substring search. The answer says whether the graph is current, so a "not found" '
      + 'while the graph is rebuilding or stale means "ask again", not "it does not exist".',
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
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const result = value as FindResult
        const lines = result.symbols.map(symbol => `- ${formatSymbol(symbol)}`)
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
      'Answer "who is affected if I change this". Resolves a symbol by id or by an unambiguous name, then '
      + 'lists the files that reference it and the files its own file imports. References are resolved by '
      + 'NAME, so a call through an interface or a dynamic dispatch may be missing — treat an empty list as '
      + '"no direct calls found", not as "safe to change". An ambiguous name answers no target rather than '
      + 'picking one, because describing the wrong symbol would look correct.',
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
        },
      },
      render: (_args, value) => {
        const result = value as ImpactResult
        if (result.target === undefined) {
          return [{ type: 'text', text: `codegraph_impact: no unambiguous symbol matched${result.note === undefined ? '' : `\nnote: ${result.note}`}` }]
        }
        const lines = [
          `codegraph_impact: ${formatSymbol(result.target)}`,
          ...(result.note === undefined ? [] : [`note: ${result.note}`]),
          `referenced from ${String(result.referencing.length)} file(s):`,
          ...result.referencing.map(ref => `- ${ref.path}:${String(ref.line)}`),
          ...(result.imports.length === 0 ? [] : ['its file imports:', ...result.imports.map(path => `- ${path}`)]),
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
        return dropUndefined({ freshness, note, target: undefined, referencing: [], imports: [] }) satisfies ImpactResult
      }
      return dropUndefined({
        freshness,
        note,
        target,
        referencing: referencesTo(graph, target.id, MAX_ROWS),
        imports: importsOf(graph, target.path, MAX_ROWS),
      }) satisfies ImpactResult
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'codegraph_context',
    description:
      'Read one symbol\u2019s neighbourhood in a single call: its declaration, the other symbols declared in '
      + 'the same file, the calls it makes, what references it, what its file imports, and the project '
      + 'documents that name it. Use this instead of several codegraph_find calls when you need to '
      + 'understand how a piece fits before changing it. A call is attributed to the enclosing declaration '
      + 'when it sits inside one, and to the file otherwise, so `calls` is this symbol\u2019s own calls plus '
      + 'any file-level call; targets are resolved by name, so a name declared in more than one place '
      + 'produces no edge rather than a guess.',
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
        },
      },
      render: (_args, value) => {
        const result = value as ContextResult
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
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const cwd = requireCwd(exec.agent)
      const { freshness, note } = await freshnessOf(cwd)
      const graph = graphFor(cwd)
      const symbol = resolveSymbol(graph, args.symbol)
      if (symbol === undefined) {
        return dropUndefined({ freshness, note, symbol: undefined, siblings: [], calls: [], calledBy: [], imports: [], documents: [] }) satisfies ContextResult
      }
      return dropUndefined({
        freshness,
        note,
        symbol,
        siblings: symbolsInFile(graph, symbol.path, MAX_ROWS),
        // The symbol's OWN calls, plus whatever its file calls at file scope.
        // Before W11b this was the file's calls for every symbol in it, so a
        // 40-function file answered with the same 40-entry list 40 times.
        calls: [...callsOf(graph, symbol.id, MAX_ROWS), ...callsOf(graph, fileNodeId(symbol.path), MAX_ROWS)],
        calledBy: calledBy(graph, symbol.id, MAX_ROWS),
        imports: importsOf(graph, symbol.path, MAX_ROWS),
        documents: documentsFor(graph, symbol.id, MAX_ROWS),
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
  }))

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
