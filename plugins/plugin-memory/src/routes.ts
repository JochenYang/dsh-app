/**
 * Settings-page API on the shared Connection `/api` channel, under
 * `/api/plugins/dsh-app/plugin-memory`:
 *   GET  /status        — toggle states + global/project stats + global card
 *                         rows (summaries only, no bodies)
 *   GET  /entries?slug= — one store's cards WITH bodies + pin state;
 *                         no slug (or empty) = the global store
 *   GET  /llm-audit     — recent background-LLM cost rows (newest 20)
 *   POST /config        — set toggles (body {enabled?, distill?} booleans)
 *   POST /pin           — pin/unpin one card (body {topic, pinned, scope?, slug?})
 *   POST /forget        — delete cards by topic key or content substring
 *                         (body {match, scope?, slug?})
 *   POST /clear         — {scope:'global'} empties the global store;
 *                         {scope:'project', slug} removes that project directory.
 *
 * Trust is the carrier's: the Connection transport applies its Host/Origin fence
 * and browser authentication before a route handler runs (see
 * `ConnectionFetchRoute.fetch`), and the desktop host's pipe transport has no
 * stranger origin to fence at all — so a route never re-checks them. Every route
 * owns one exact path and its methods; a parameter rides the query string, never
 * a path segment, and another method of that same path falls through to the
 * shared channel's own 404 instead of a route body. The slug is pattern-validated
 * before it ever reaches the filesystem (traversal fence). Writes act on the root
 * the tools, injection, and distiller share, so a toggle flip here is honored by
 * the next prompt assembly / distill window with no restart.
 *
 * @module @dsh-app/plugin-memory/routes
 */

import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import { isValidSlug, isValidTopic, listProjects, removeProject, type MemoryRoot, type MemoryStore, type TopicCard } from './memory-store.ts'
import { ROUTE_PREFIX, type HostText, type MemoryCardRow, type MemoryEntriesResponse, type MemoryLlmAuditResponse, type MemoryStatus } from './types.ts'

/** Route namespace on the shared `/api` channel (single source in types.ts,
 * shared with the browser half). Re-exported so existing importers keep
 * working. */
export { ROUTE_PREFIX }

/** Body cap. The settings payloads are a handful of scalars: anything larger is
 * a caller that is not this page. */
const MAX_BODY_BYTES = 8_192

/**
 * Resolve the target store of a scoped write body (pin/forget).
 * @param root - the two-level memory root.
 * @param body - the request payload.
 * @returns the store to write to, or the refusal to answer with.
 */
function resolveStore(root: MemoryRoot, body: Record<string, unknown>): MemoryStore | Response {
  if (body.scope === undefined || body.scope === 'global') return root.global
  if (body.scope !== 'project') {
    return fail(400, 'bad-request', { code: 'route.scopeRequired', text: 'scope must be global or project' })
  }
  const slug = body.slug
  if (typeof slug !== 'string' || !isValidSlug(slug)) {
    return fail(400, 'bad-request', { code: 'route.slugRequired', text: 'project scope requires a valid slug' })
  }
  const store = root.projectBySlug(slug)
  if (store === undefined) {
    return fail(400, 'bad-request', { code: 'route.projectUnknown', text: 'unknown project slug' })
  }
  return store
}

function sendJson(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function ok(value: unknown): Response {
  return sendJson(200, { ok: true, value })
}

/**
 * Failure answer. `code` is the transport-ish category (kept for the existing
 * client checks); `host` is the coded message the UI renders in its own
 * language. The plain `message` stays an English diagnostic for logs and for a
 * client that does not know the code yet.
 */
function fail(status: number, code: string, host: HostText): Response {
  return sendJson(status, { ok: false, error: { code, message: host.text ?? host.code, host } })
}

/** Wire row for one card; the status list omits bodies, /entries includes them. */
function cardRow(card: TopicCard, pinned: ReadonlySet<string>, withBody: boolean): MemoryCardRow {
  const row: MemoryCardRow = {
    topic: card.name,
    category: card.category,
    summary: card.summary,
    updated: card.updated,
    pinned: pinned.has(card.name),
  }
  if (withBody) row.body = card.body
  return row
}

/**
 * Bounded JSON body read. The carrier has already buffered the bytes (every
 * route declares `requestBody: 'buffered'`) under the channel's own, much larger
 * cap; this route limit is checked before parsing — a declared `content-length`
 * first so an oversized body is refused without decoding it, then the decoded
 * text for a request that declared no length at all (or lied about it).
 *
 * @param request - the buffered request.
 * @returns the parsed payload; `{}` for any non-object JSON.
 */
async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('payload-too-large')
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error('payload-too-large')
  const parsed: unknown = JSON.parse(text)
  return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
}

/**
 * Map a body-read failure onto its answer: 413 past the cap, 400 for anything
 * unparseable. The parse fault is a technical detail, so it rides as a param and
 * the client wraps it in its own sentence.
 *
 * @param error - the rejection from {@link readJsonBody}.
 */
function bodyFailure(error: unknown): Response {
  const message = error instanceof Error ? error.message : 'invalid body'
  if (message === 'payload-too-large') {
    return fail(413, 'payload-too-large', { code: 'route.bodyTooLarge', text: 'request body too large (8 KiB cap)' })
  }
  return fail(400, 'bad-request', { code: 'route.invalidBody', params: { detail: message }, text: message })
}

/**
 * Register the settings-page routes on the Connection exact-Fetch registry.
 *
 * @param connectionFetch - the Connection exact-Fetch registry (`ctx.connection.fetch`).
 * @param root - the two-level memory root.
 * @returns disposer removing all routes.
 */
export function registerMemoryRoutes(connectionFetch: HostConnectionFetch, root: MemoryRoot): () => Promise<void> {
  const disposers = [
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/status`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        const { cards, sizeBytes } = root.global.stats()
        const pinned = root.global.pinnedSet()
        const status: MemoryStatus = {
          enabled: root.global.isEnabled(),
          distill: root.global.isDistillEnabled(),
          cards,
          sizeBytes,
          storePath: root.global.storePath,
          // Bodies stay out of the status payload: the settings list shows
          // summaries, and the entries route serves bodies on demand.
          globalList: root.global.list().map(card => cardRow(card, pinned, false)),
          projects: listProjects(root.dir),
          activity: root.distillActivity(),
        }
        return ok(status)
      },
    }),

    connectionFetch.register({
      path: `${ROUTE_PREFIX}/config`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(request)
        } catch (error) {
          return bodyFailure(error)
        }
        // Accept either toggle, both, or neither (a no-op body is still
        // answered with the current state — the UI reloads from it).
        const enabled = body.enabled
        const distill = body.distill
        if (enabled !== undefined && typeof enabled !== 'boolean') {
          return fail(400, 'bad-request', { code: 'route.enabledNotBoolean', text: 'enabled must be a boolean' })
        }
        if (distill !== undefined && typeof distill !== 'boolean') {
          return fail(400, 'bad-request', { code: 'route.distillNotBoolean', text: 'distill must be a boolean' })
        }
        if (typeof enabled === 'boolean') root.global.setEnabled(enabled)
        if (typeof distill === 'boolean') root.global.setDistillEnabled(distill)
        return ok({
          enabled: root.global.isEnabled(),
          distill: root.global.isDistillEnabled(),
        })
      },
    }),

    connectionFetch.register({
      path: `${ROUTE_PREFIX}/clear`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(request)
        } catch (error) {
          return bodyFailure(error)
        }
        if (body.scope === 'project') {
          const slug = body.slug
          if (typeof slug !== 'string' || !isValidSlug(slug)) {
            return fail(400, 'bad-request', { code: 'route.slugInvalid', text: 'the slug is malformed' })
          }
          try {
            await removeProject(root.dir, slug)
            return ok({ scope: 'project', slug })
          } catch {
            return fail(500, 'io', { code: 'route.clearProjectFailed', text: 'could not clear the project memory' })
          }
        }
        if (body.scope !== 'global' && body.scope !== undefined) {
          return fail(400, 'bad-request', { code: 'route.scopeRequired', text: 'scope must be global or project' })
        }
        try {
          await root.global.clear()
          return ok({ scope: 'global' })
        } catch {
          return fail(500, 'io', { code: 'route.clearGlobalFailed', text: 'could not clear the global memory' })
        }
      },
    }),

    connectionFetch.register({
      path: `${ROUTE_PREFIX}/entries`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const slug = new URL(request.url).searchParams.get('slug')
        // No slug = the global store (the settings page loads global bodies
        // lazily on row expand). projectBySlug validates the slug shape before
        // touching the filesystem, so the traversal fence holds.
        const store = slug === null || slug === '' ? root.global : root.projectBySlug(slug)
        if (store === undefined) {
          return fail(400, 'bad-request', { code: 'route.projectUnknown', text: 'unknown project slug' })
        }
        const pinned = store.pinnedSet()
        const body: MemoryEntriesResponse = {
          cards: store.list().map(card => cardRow(card, pinned, true)),
        }
        return ok(body)
      },
    }),

    connectionFetch.register({
      path: `${ROUTE_PREFIX}/pin`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(request)
        } catch (error) {
          return bodyFailure(error)
        }
        const topic = body.topic
        const pinned = body.pinned
        if (typeof topic !== 'string' || !isValidTopic(topic)) {
          return fail(400, 'bad-request', { code: 'route.topicInvalid', text: 'topic must be a valid topic key (ASCII kebab-case)' })
        }
        if (typeof pinned !== 'boolean') {
          return fail(400, 'bad-request', { code: 'route.pinnedNotBoolean', text: 'pinned must be a boolean' })
        }
        const store = resolveStore(root, body)
        if (store instanceof Response) return store
        // Pinning a card that does not exist is a client bug — say so
        // instead of silently recording a dangling pin.
        if (pinned && store.get(topic) === undefined) {
          return fail(400, 'bad-request', { code: 'route.topicUnknown', text: 'unknown topic' })
        }
        const changed = pinned ? await store.addPin(topic) : await store.removePin(topic)
        return ok({ pinned, changed })
      },
    }),

    connectionFetch.register({
      path: `${ROUTE_PREFIX}/forget`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(request)
        } catch (error) {
          return bodyFailure(error)
        }
        const match = body.match
        if (typeof match !== 'string' || match.trim() === '') {
          return fail(400, 'bad-request', { code: 'route.matchRequired', text: 'match must be a non-empty string' })
        }
        const store = resolveStore(root, body)
        if (store instanceof Response) return store
        // The settings-page delete sends the card's topic key (exact match);
        // the store's substring fallback only fires for hand-typed calls.
        const result = await store.forget(match)
        return ok({ forgotten: result.removed.length, removed: result.removed })
      },
    }),

    connectionFetch.register({
      path: `${ROUTE_PREFIX}/llm-audit`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        const runs = root.llmAudit().slice(0, 20).map(run => ({
          at: run.at,
          source: run.source,
          session: run.session,
          status: run.status,
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          durationMs: run.durationMs,
          ...(run.error === undefined ? {} : { error: run.error }),
        }))
        const body: MemoryLlmAuditResponse = {
          runs,
          totalTokens: runs.reduce((sum, run) => sum + run.inputTokens + run.outputTokens, 0),
        }
        return ok(body)
      },
    }),
  ]
  return async () => { for (const dispose of disposers) await dispose() }
}
