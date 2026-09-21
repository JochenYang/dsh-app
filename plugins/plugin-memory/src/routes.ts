/**
 * Settings-page API on the shared Connection `/api` channel, under
 * `/api/plugins/dsh-app/plugin-memory`:
 *   GET  /status        — toggle states + the project list
 *   GET  /entries?slug= — one project store's cards WITH bodies + pin state
 *   GET  /llm-audit     — recent background-LLM cost rows (newest 20)
 *   POST /config        — set toggles (body {enabled?, distill?} booleans)
 *   POST /pin           — pin/unpin one card (body {topic, pinned, scope, slug})
 *   POST /forget        — delete cards by topic key or content substring
 *                         (body {match, scope, slug})
 *   POST /clear         — {scope:'project', slug} removes that project directory
 *
 * Every scoped call NAMES its store, and only a project can be named: the
 * former GLOBAL scope is retired (no session injects it, no tool writes it,
 * and its cards moved into `projects/legacy-global/` at boot), so a body that
 * omits the scope — or asks for `global` — is refused instead of silently
 * addressing the root store. Nothing is lost by the refusal: the retired
 * scope's cards and their archive are an ordinary project directory now,
 * which is what the project list shows and what these routes address.
 *
 * Trust is the carrier's: the Connection transport applies its Host/Origin fence
 * and browser authentication before a route handler runs (see
 * `ConnectionFetchRoute.fetch`), and the desktop host's pipe transport has no
 * stranger origin to fence at all — so a route never re-checks them. Every route
 * owns one exact path and its methods; a parameter rides the query string, never
 * a path segment, and another method of that same path falls through to the
 * shared channel's own 404 instead of a route body. The slug is pattern-validated
 * before it ever reaches the filesystem (traversal fence). Writes act on the root
 * the tools, injection, and curator share, so a toggle flip here is honored by
 * the next prompt assembly / maintenance sweep with no restart.
 *
 * @module @dsh-app/plugin-memory/routes
 */

import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import { isValidSlug, isValidTopic, listProjects, removeProject, type MemoryRoot, type MemoryStore, type TopicCard } from './memory-store.ts'
import { ROUTE_PREFIX, type HostText, type MemoryArchiveResponse, type MemoryArchiveRow, type MemoryCardRow, type MemoryCurateResult, type MemoryEntriesResponse, type MemoryLedgerResponse, type MemoryLlmAuditResponse, type MemoryStatus } from './types.ts'

/** Route namespace on the shared `/api` channel (single source in types.ts,
 * shared with the browser half). Re-exported so existing importers keep
 * working. */
export { ROUTE_PREFIX }

/** Body cap. The settings payloads are a handful of scalars: anything larger is
 * a caller that is not this page. */
const MAX_BODY_BYTES = 8_192

/**
 * Resolve the target store of a scoped write body (pin/forget/restore/…).
 * @param root - the memory root.
 * @param body - the request payload.
 * @returns the store to write to, or the refusal to answer with. The scope is
 *   REQUIRED and only `project` can name a store: the retired global scope —
 *   the root store an omitted scope used to fall back into — is refused here
 *   rather than silently served.
 */
function resolveStore(root: MemoryRoot, body: Record<string, unknown>): MemoryStore | Response {
  if (body.scope !== 'project') {
    return fail(400, 'bad-request', { code: 'route.scopeRequired', text: 'scope must be project' })
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

/** Wire row for one card, body included: only /entries serves rows, and the
 *  expanded row needs the text. */
function cardRow(card: TopicCard, pinned: ReadonlySet<string>): MemoryCardRow {
  return {
    topic: card.name,
    category: card.category,
    summary: card.summary,
    updated: card.updated,
    pinned: pinned.has(card.name),
    body: card.body,
  }
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
 * Host callbacks the settings page needs BEYOND the store itself. The
 * maintenance half mounts LATER than the routes (it needs the agents/llm
 * services), so the hook is read at call time and the route answers a coded
 * `unavailable` while it is missing — the page never sees a silent no-op.
 */
export interface MemoryRouteHooks {
  /**
   * Run ONE maintenance pass for a project, on the user's request.
   * @param slug - the project directory slug the page is showing.
   * @returns what the pass did, in the wire vocabulary the page renders.
   */
  curateNow?: (slug: string) => Promise<MemoryCurateResult>
}

/**
 * Register the settings-page routes on the Connection exact-Fetch registry.
 *
 * @param connectionFetch - the Connection exact-Fetch registry (`ctx.connection.fetch`).
 * @param root - the two-level memory root.
 * @param hooks - the optional host callbacks (see {@link MemoryRouteHooks}).
 * @returns disposer removing all routes.
 */
export function registerMemoryRoutes(
  connectionFetch: HostConnectionFetch,
  root: MemoryRoot,
  hooks: MemoryRouteHooks = {},
): () => Promise<void> {
  const disposers = [
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/status`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        // The payload is exactly what the page renders: the two toggle states
        // and the project list. The retired global block's stats and the
        // extractor's run traces are gone with their surfaces — card bodies
        // are served on demand by /entries.
        const status: MemoryStatus = {
          enabled: root.global.isEnabled(),
          distill: root.global.isDistillEnabled(),
          projects: listProjects(root.dir),
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
        // Only a project names a store, so a body without the scope is refused
        // rather than answered with the root store — clearing is destructive,
        // and it must never be reached by omission.
        if (body.scope !== 'project') {
          return fail(400, 'bad-request', { code: 'route.scopeRequired', text: 'scope must be project' })
        }
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
      },
    }),

    connectionFetch.register({
      path: `${ROUTE_PREFIX}/entries`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const slug = new URL(request.url).searchParams.get('slug')
        // The slug is REQUIRED: with the global scope retired there is no
        // store a missing slug could mean. projectBySlug validates the slug
        // shape before touching the filesystem, so the traversal fence holds.
        if (slug === null || slug === '') {
          return fail(400, 'bad-request', { code: 'route.slugRequired', text: 'project scope requires a valid slug' })
        }
        const store = root.projectBySlug(slug)
        if (store === undefined) {
          return fail(400, 'bad-request', { code: 'route.projectUnknown', text: 'unknown project slug' })
        }
        const pinned = store.pinnedSet()
        const body: MemoryEntriesResponse = {
          cards: store.list().map(card => cardRow(card, pinned)),
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
      path: `${ROUTE_PREFIX}/curate`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(request)
        } catch (error) {
          return bodyFailure(error)
        }
        // resolveStore is the whole validation here: the scope must be
        // `project` and the slug must be pattern-valid AND resolve to a
        // directory. One pass runs on exactly one store — the page names the
        // project it is showing, never "everything".
        const store = resolveStore(root, body)
        if (store instanceof Response) return store
        if (hooks.curateNow === undefined) {
          const unavailable: MemoryCurateResult = { status: 'unavailable', merged: 0, deleted: 0, rewritten: 0, refused: 0 }
          return ok(unavailable)
        }
        // The pass takes as long as its one model call does. The request stays
        // open and answers with what happened, because the page has no push
        // channel: a client that walks away loses the REPORT, not the pass —
        // the ledger records it either way.
        return ok(await hooks.curateNow(String(body.slug)))
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

    connectionFetch.register({
      path: `${ROUTE_PREFIX}/ledger`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        const entries = root.ledgerEntries().slice(0, 50)
        const payload: MemoryLedgerResponse = { entries }
        return ok(payload)
      },
    }),

    connectionFetch.register({
      path: `${ROUTE_PREFIX}/archive`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        // Scope comes from the query string (GET): `?scope=project&slug=…`.
        // WITHOUT one, answer for EVERY PROJECT — that is what the settings
        // page asks for, and reading only one store is how a card deleted from
        // a project became invisible while the delete itself succeeded.
        const params = new URL(request.url).searchParams
        const scope = params.get('scope')
        const slug = params.get('slug')
        const targets: Array<{ slug: string, store: MemoryStore }> = []
        if (scope === null || scope === '' || scope === 'all') {
          // The retired global scope is deliberately NOT among these: its
          // archive was moved into `projects/legacy-global/` at boot, so it is
          // listed (and restored) as that project like any other.
          for (const project of listProjects(root.dir)) {
            const store = root.projectBySlug(project.slug)
            if (store !== undefined) targets.push({ slug: project.slug, store })
          }
        } else {
          if (slug === null || slug === '') {
            return fail(400, 'bad-request', { code: 'route.slugRequired', text: 'project scope requires a valid slug' })
          }
          const store = resolveStore(root, { scope, slug })
          if (store instanceof Response) return store
          targets.push({ slug, store })
        }
        const cards: MemoryArchiveRow[] = []
        for (const target of targets) {
          for (const row of target.store.archivedCards()) {
            cards.push({ ...row, scope: 'project', slug: target.slug })
          }
        }
        // Newest day first, then project, then topic — one stable order across
        // what used to be several separate lists.
        cards.sort((a, b) => b.day.localeCompare(a.day) || a.slug.localeCompare(b.slug) || a.topic.localeCompare(b.topic))
        const payload: MemoryArchiveResponse = { cards, total: cards.length }
        return ok(payload)
      },
    }),

    connectionFetch.register({
      path: `${ROUTE_PREFIX}/restore`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(request)
        } catch (error) {
          return bodyFailure(error)
        }
        const day = body.day
        const file = body.file
        const topic = body.topic
        if (typeof day !== 'string' || typeof file !== 'string' || typeof topic !== 'string') {
          return fail(400, 'bad-request', { code: 'route.restoreArgsRequired', text: 'day, file and topic are required' })
        }
        const store = resolveStore(root, body)
        if (store instanceof Response) return store
        const outcome = await store.restoreArchived(day, file, topic)
        if (outcome === 'restored') return ok({ restored: true, topic })
        // Each failure gets its own code so the client can say WHAT went
        // wrong (the key is taken vs the copy is gone vs the name is bad)
        // instead of a generic failure.
        const code = outcome === 'occupied'
          ? 'route.restoreOccupied'
          : outcome === 'missing'
            ? 'route.restoreMissing'
            : 'route.restoreInvalid'
        const text = outcome === 'occupied'
          ? 'a card with that topic already exists'
          : outcome === 'missing'
            ? 'no archived card for that day and topic'
            : 'malformed day or topic'
        return fail(outcome === 'invalid' ? 400 : 409, outcome, { code, params: { topic }, text })
      },
    }),

    connectionFetch.register({
      path: `${ROUTE_PREFIX}/archive-delete`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(request)
        } catch (error) {
          return bodyFailure(error)
        }
        const day = body.day
        const file = body.file
        if (typeof day !== 'string' || typeof file !== 'string') {
          return fail(400, 'bad-request', { code: 'route.archiveDeleteArgsRequired', text: 'day and file are required' })
        }
        const store = resolveStore(root, body)
        if (store instanceof Response) return store
        const removed = await store.deleteArchived(day, file)
        if (!removed) {
          return fail(409, 'missing', { code: 'route.archiveDeleteMissing', text: 'no archived copy for that day and file' })
        }
        return ok({ deleted: true })
      },
    }),

    connectionFetch.register({
      path: `${ROUTE_PREFIX}/archive-clear`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(request)
        } catch (error) {
          return bodyFailure(error)
        }
        // Same scope rule as GET /archive: no scope = every project, because
        // the panel that offers this button shows every project. The retired
        // global scope is not enumerated (see that route).
        const scope = body.scope
        let cleared = 0
        if (scope === undefined || scope === 'all') {
          for (const project of listProjects(root.dir)) {
            const store = root.projectBySlug(project.slug)
            if (store !== undefined) cleared += await store.clearArchive()
          }
        } else {
          const store = resolveStore(root, body)
          if (store instanceof Response) return store
          cleared = await store.clearArchive()
        }
        return ok({ cleared })
      },
    }),
  ]
  return async () => { for (const dispose of disposers) await dispose() }
}
