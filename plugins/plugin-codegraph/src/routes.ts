/**
 * The settings routes: index status, language packs, and a manual re-index.
 *
 * Everything rides the Connection exact-Fetch registry
 * (`ctx.connection.fetch`), never `webServer`: the desktop host disables that
 * row on purpose (`docs/agents/security-invariants.md`), and a plugin that waits
 * for it never activates. The carrier applies its own Host/Origin fence and
 * browser auth before a handler runs, so a route carries no fence of its own.
 *
 * Why the routes exist at all. The three model tools answer questions; a user
 * still needs to see WHICH projects have a graph, how far behind each one is, and
 * which language packs are installed. Without a surface for that, the failure
 * mode is invisible staleness — the one this plugin is built to avoid.
 *
 * @module @dsh-app/plugin-codegraph/host/routes
 */

import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import type { ProjectStatus } from './queue.ts'
import { LANGUAGES, languageStatuses, type GrammarPaths, type LanguageStatus } from './languages.ts'
import { SUPPORTED_LANGUAGE_IDS } from './parse.ts'
import { fileGraph, symbolGraph, type FileGraph, type SymbolGraph } from './graph-view.ts'
import type { Graph } from './store.ts'

/** Everything the routes read, supplied by the plugin. */
export interface CodegraphRoutesOptions {
  /** Every project the queue has seen. */
  readonly statuses: () => readonly ProjectStatus[]
  /** Grammar directories, for the language list. */
  readonly grammarPaths: () => GrammarPaths
  /** Install one on-demand language. */
  readonly installLanguage: (id: string) => Promise<void>
  /** Remove one on-demand language. */
  readonly removeLanguage: (id: string) => Promise<void>
  /** Ask for a pass on one project. */
  readonly reindex: (cwd: string) => Promise<void>
  /**
   * Open one project's graph, for the view.
   *
   * Injected rather than opened here: the plugin owns the handle cache (one open
   * database per project, closed on unload), and a route that opened its own would
   * be a second connection to a file SQLite already has open in this process.
   */
  readonly graphFor: (cwd: string) => Graph
}

/** The path prefix every route in this plugin owns. */
export const ROUTE_PREFIX = '/api/plugins/dsh-app/codegraph'

/**
 * What `GET /graph` answers.
 *
 * A tagged union rather than two optional fields: the view switches on `kind`, and
 * a shape with both `files` and `symbols` possibly-present would make "the
 * overview came back empty" indistinguishable from "the detail did".
 */
export type GraphAnswer =
  | { readonly kind: 'files', readonly files: FileGraph }
  | { readonly kind: 'symbols', readonly symbols: SymbolGraph }
  /**
   * The project has no graph yet and a pass was just queued.
   *
   * A distinct answer rather than a 404: opening the view IS the request to build
   * one, so the client shows "building" and asks again instead of rendering an
   * error the user cannot act on.
   */
  | { readonly kind: 'indexing' }

/**
 * The languages this plugin has extraction rules for, as a set.
 *
 * The LIST is `parse.ts`'s `SUPPORTED_LANGUAGE_IDS`, derived from the extraction
 * table itself. This file used to hold its own copy to keep the parser out of
 * the request path — but `parse.ts` is a table plus pure functions and loads no
 * tree-sitter, so importing it costs nothing, while a second copy could drift:
 * a language in one table and not the other makes the settings page say "no
 * extraction rules" for a language that works, or promise one that reads
 * nothing, and neither is a red test.
 */
const SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set(SUPPORTED_LANGUAGE_IDS)

/** One project row as the settings page renders it. */
export interface ProjectRow {
  readonly cwd: string
  readonly name: string
  readonly state: string
  readonly indexedAt: number
  readonly queued: boolean
  readonly failure: string | undefined
  /** Present when a pass has completed at least once. */
  readonly lastOutcome: {
    readonly parsed: number
    readonly skipped: number
    readonly removed: number
    readonly truncated: boolean
    readonly missingLanguage: number
    readonly noRules: number
    readonly parseErrors: number
    readonly tooLarge: number
    readonly durationMs: number
    readonly removalSkipped: boolean
  } | undefined
}

/**
 * A coded message the CLIENT renders in its own language.
 *
 * The host never sends user-visible prose: `code` is a stable key the client maps
 * to its dictionary, `params` interpolate into that sentence, and `text` is an
 * ENGLISH developer-facing fallback shown only for a code an older client does
 * not know. Matching on a localized sentence across the boundary is what once let
 * a kernel-side classifier misread one failure as another.
 */
export interface HostText {
  readonly code: string
  readonly params?: Readonly<Record<string, string | number>>
  readonly text?: string
}

/** `Response.json` sets the status but this makes the content type explicit. */
function sendJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * Failure answer. `code` is the transport-ish category (kept for any client
 * branch that still switches on it); `host` is the coded message the UI renders in
 * its own language.
 */
function fail(status: number, code: string, host: HostText): Response {
  return sendJson(status, { ok: false, error: { code, message: host.text ?? host.code, host } })
}

/** A successful answer. */
function ok(value: unknown): Response {
  return sendJson(200, { ok: true, value })
}

/** Read a JSON body, tolerating an empty one. */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const text = await request.text()
    if (text.trim() === '') return {}
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** Project rows, newest first, with the queue's live state. */
function projectRows(options: CodegraphRoutesOptions): ProjectRow[] {
  return options.statuses()
    .map(status => ({
      cwd: status.cwd,
      name: status.name,
      state: status.state,
      indexedAt: status.indexedAt,
      queued: status.queued,
      failure: status.failure,
      lastOutcome: status.lastOutcome,
    }))
    .sort((left, right) => right.indexedAt - left.indexedAt)
}

/** One language row as the settings page renders it. */
export interface LanguageRow extends LanguageStatus {
  /** True when the language has extraction rules; a grammar alone reads nothing. */
  readonly supported: boolean
  readonly extensions: readonly string[]
}

/**
 * Register the routes.
 *
 * @param connectionFetch - the Connection exact-Fetch registry.
 * @param options - what the handlers read.
 * @returns a disposer removing every route.
 */
export function registerCodegraphRoutes(connectionFetch: HostConnectionFetch, options: CodegraphRoutesOptions): () => Promise<void> {
  const disposers: (() => Promise<void>)[] = []

  const statusFetch = async (): Promise<Response> => {
    try {
      return ok({
        projects: projectRows(options),
      })
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return fail(500, 'status-failed', { code: 'route.statusFailed', params: { detail }, text: `could not read the code graph status: ${detail}` })
    }
  }

  const languagesFetch = async (): Promise<Response> => {
    try {
      const statuses = languageStatuses(options.grammarPaths())
      const rows: LanguageRow[] = statuses.map(status => {
        const spec = LANGUAGES.find(language => language.id === status.id)
        return {
          ...status,
          // A grammar with no extraction shape parses to nothing; saying so here
          // is what keeps "installed" from implying "indexed".
          supported: spec !== undefined && SUPPORTED_LANGUAGES.has(spec.id),
          extensions: spec?.extensions ?? [],
        }
      })
      return ok({ languages: rows })
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return fail(500, 'languages-failed', { code: 'route.languagesFailed', params: { detail }, text: `could not read the grammar list: ${detail}` })
    }
  }

  const actionFetch = async (request: Request): Promise<Response> => {
    const body = await readBody(request)
    const action = body.action
    try {
      if (action === 'install' || action === 'remove') {
        const id = body.id
        if (typeof id !== 'string' || id === '') {
          return fail(400, 'id-required', { code: 'route.idRequired', text: 'this action needs a language id' })
        }
        const spec = LANGUAGES.find(language => language.id === id)
        if (spec === undefined) return fail(404, 'unknown-language', { code: 'route.unknownLanguage', params: { id }, text: `no language "${id}" in this plugin's table` })
        if (spec.bundled) {
          // A bundled grammar ships inside the plugin; removing it would make the
          // plugin disagree with its own manifest.
          return fail(409, 'bundled-language', { code: 'route.bundledLanguage', params: { id, action }, text: `"${id}" ships with the plugin; there is nothing to ${action}` })
        }
        if (action === 'install') await options.installLanguage(id)
        else await options.removeLanguage(id)
        return ok({ action, id })
      }
      if (action === 'reindex') {
        const cwd = body.cwd
        if (typeof cwd !== 'string' || cwd === '') {
          return fail(400, 'cwd-required', { code: 'route.cwdRequired', text: 'this action needs a project directory' })
        }
        // The cwd is checked against the projects the queue already knows: a
        // route that indexed any path a caller named would let a request choose
        // what this process reads.
        if (!options.statuses().some(status => status.cwd === cwd)) {
          return fail(404, 'unknown-project', { code: 'route.unknownProject', params: { cwd }, text: `no graph has been opened for "${cwd}"` })
        }
        await options.reindex(cwd)
        return ok({ action, cwd })
      }
      return fail(400, 'unknown-action', { code: 'route.unknownAction', params: { action: String(action) }, text: 'action must be install, remove or reindex' })
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return fail(500, 'action-failed', { code: 'route.actionFailed', params: { action: String(action), detail }, text: `the ${String(action)} action failed: ${detail}` })
    }
  }

  /**
   * The graph view's data: the file overview, or one file's symbols.
   *
   * Two levels through ONE route because they are one picture at two zooms, and
   * because the overview is what the view asks for first: a separate route for the
   * detail would either duplicate the "is this project known" check or skip it.
   *
   * The cwd is checked against the queue's known projects, exactly as `reindex`
   * does: a route that opened a graph for any path a caller named would let a
   * request choose what this process reads off disk.
   */
  const graphFetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const cwd = url.searchParams.get('cwd')
    if (cwd === null || cwd === '') {
      return fail(400, 'cwd-required', { code: 'route.cwdRequired', text: 'this request needs a project directory' })
    }
    // A project the queue has never seen is NOT an error: opening the view is the
    // user asking for that project's graph, and answering "no graph has been
    // opened" would leave the page permanently empty for every session that
    // predates this plugin — `session/created` fires once, so an existing session
    // never queues its project on its own.
    //
    // So: queue it and answer `indexing`. The view polls, the first pass lands,
    // and the same request then answers the graph. `reindex` is idempotent while a
    // pass is queued or running, so a poll loop costs one pass, not one per tick.
    if (!options.statuses().some(status => status.cwd === cwd)) {
      void options.reindex(cwd).catch(() => {
        // Recorded on the project by the queue; the next poll reports it.
      })
      return ok({ kind: 'indexing' } satisfies GraphAnswer)
    }
    try {
      const graph = options.graphFor(cwd)
      const path = url.searchParams.get('path')
      if (path !== null && path !== '') {
        return ok({ kind: 'symbols', symbols: symbolGraph(graph, path) } satisfies GraphAnswer)
      }
      return ok({ kind: 'files', files: fileGraph(graph) } satisfies GraphAnswer)
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return fail(500, 'graph-failed', { code: 'route.graphFailed', params: { detail }, text: `could not read the graph: ${detail}` })
    }
  }

  disposers.push(connectionFetch.register({
    path: `${ROUTE_PREFIX}/status`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: statusFetch,
  }))
  disposers.push(connectionFetch.register({
    path: `${ROUTE_PREFIX}/languages`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: languagesFetch,
  }))
  disposers.push(connectionFetch.register({
    path: `${ROUTE_PREFIX}/graph`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: graphFetch,
  }))
  disposers.push(connectionFetch.register({
    path: `${ROUTE_PREFIX}/action`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: actionFetch,
  }))

  return async () => {
    for (const dispose of disposers.splice(0)) await dispose()
  }
}

