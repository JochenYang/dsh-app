/**
 * Host API routes for the quarantine manager.
 *
 * Two endpoints on the shared Connection `/api` channel, under
 * `/api/plugins/dsh-app/plugin-rewind` (the registry admits only
 * `[A-Za-z0-9_$.-]` in a path segment, so the npm scope's `@` travels as
 * `dsh-app`):
 *
 *   GET  /quarantine        — list every displaced file, grouped by session
 *   POST /quarantine/purge  — delete the named slots, or all of them
 *
 * ## Why the request carries names, never paths
 *
 * A purge is the only destructive operation this plugin has. The request
 * therefore names a SESSION and a SLOT, and the handler joins them onto a root
 * it computes itself from `$DSH_HOME`. A path in the body could aim the delete
 * anywhere; a name cannot, because `isSafeSegment` refuses `.`, `..`, a
 * separator and a drive prefix before anything is joined.
 *
 * Deletion safety fences, all enforced server-side:
 *   - the root is derived from `$DSH_HOME`, never taken from the request;
 *   - each segment is validated as one ordinary path segment;
 *   - only leaf slot directories are removed, so a malformed pair can never
 *     remove a whole session's quarantine.
 *
 * Trust is the carrier's: the Connection transport applies its Host/Origin fence
 * and browser authentication before a route handler runs, so a route never
 * re-checks them.
 *
 * @module @dsh-app/plugin-rewind/routes
 */

import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { listQuarantine, purgeQuarantine } from './quarantine.ts'
import type { HostText } from './wire.ts'

/** Route namespace on the shared Connection `/api` channel. */
export const ROUTE_PREFIX = '/api/plugins/dsh-app/plugin-rewind'

/** Upper bound on a purge request body (the target list is small; refuse spam). */
const MAX_BODY_BYTES = 1_000_000

/** Upper bound on slots accepted per purge call. */
const MAX_TARGETS_PER_CALL = 5000

/** One JSON answer, in the shape every suite route uses. */
function sendJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A successful answer. */
function ok(value: unknown): Response {
  return sendJson(200, { ok: true, value })
}

/**
 * A failed answer. `code` is the transport-ish category; `host` is the coded
 * message the UI renders in its own language, and the plain `message` stays an
 * English diagnostic for logs.
 */
function fail(status: number, code: string, host: HostText): Response {
  return sendJson(status, { ok: false, error: { code, message: host.text ?? host.code, host } })
}

/**
 * Read a bounded JSON body.
 *
 * @param request - the incoming request.
 * @returns the parsed body, or undefined when it is absent, oversized or not JSON.
 */
async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) return undefined
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The shape of one purge target, as the page sends it. */
interface PurgeTarget {
  readonly sessionId: string
  readonly slot: string
}

/** Narrow one body's `targets`, or undefined when it is malformed. */
function readTargets(body: unknown): readonly PurgeTarget[] | undefined {
  const raw = (body as { targets?: unknown } | null)?.targets
  if (!Array.isArray(raw) || raw.length > MAX_TARGETS_PER_CALL) return undefined
  const out: PurgeTarget[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const { sessionId, slot } = entry as { sessionId?: unknown, slot?: unknown }
    if (typeof sessionId !== 'string' || typeof slot !== 'string') return undefined
    out.push({ sessionId, slot })
  }
  return out
}

/** Whether the body asked for everything, rather than a named set. */
function readPurgeAll(body: unknown): boolean {
  return (body as { all?: unknown } | null)?.all === true
}

/**
 * Register the quarantine routes.
 *
 * @param connectionFetch - the Connection carrier's route registration face.
 * @returns the disposer that unregisters every route.
 */
export function registerQuarantineRoutes(connectionFetch: HostConnectionFetch): () => Promise<void> {
  const listFetch = async (): Promise<Response> => {
    try {
      return ok(await listQuarantine(resolveDshHome()))
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return fail(500, 'list-failed', {
        code: 'rewind.route.listFailed',
        params: { detail },
        text: `could not read the quarantine: ${detail}`,
      })
    }
  }

  const purgeFetch = async (request: Request): Promise<Response> => {
    const body = await readJsonBody(request)
    if (body === undefined) {
      return fail(400, 'bad-request', {
        code: 'rewind.route.badBody',
        text: 'the body must be JSON and within the size limit',
      })
    }
    const dshHome = resolveDshHome()
    try {
      // `all` is what the "clear everything" control sends. It lists first and
      // then purges by NAME, so the same segment validation covers both paths:
      // there is no second, less-guarded delete.
      if (readPurgeAll(body)) {
        const listing = await listQuarantine(dshHome)
        const every = listing.groups.flatMap((group) => group.entries.map((entry) => ({
          sessionId: group.sessionId,
          slot: entry.slot,
        })))
        if (every.length > MAX_TARGETS_PER_CALL) {
          return fail(400, 'too-many', {
            code: 'rewind.route.tooMany',
            params: { max: MAX_TARGETS_PER_CALL },
            text: `more than ${String(MAX_TARGETS_PER_CALL)} slots; purge in batches`,
          })
        }
        const result = await purgeQuarantine(dshHome, every)
        return ok({ ...result, requested: every.length })
      }
      const targets = readTargets(body)
      if (targets === undefined) {
        return fail(400, 'bad-request', {
          code: 'rewind.route.targetsRequired',
          text: 'the body needs a targets array of { sessionId, slot } pairs, or all: true',
        })
      }
      const result = await purgeQuarantine(dshHome, targets)
      return ok({ ...result, requested: targets.length })
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return fail(500, 'purge-failed', {
        code: 'rewind.route.purgeFailed',
        params: { detail },
        text: `could not purge the quarantine: ${detail}`,
      })
    }
  }

  const disposers = [
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/quarantine`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: listFetch,
    }),
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/quarantine/purge`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: purgeFetch,
    }),
  ]
  return async () => {
    for (const dispose of disposers) await dispose()
  }
}
