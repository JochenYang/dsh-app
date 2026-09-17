/**
 * Settings-page API on the shared Connection `/api` channel, under
 * `/api/plugins/dsh-app/plugin-swarm`:
 *   GET  /config — overlay defaults + validated user overrides + effective
 *                  values + the config file path
 *   POST /config — merge a partial override set into the user config file
 *                  (a field set to null clears that override)
 *
 * Trust is the carrier's: the Connection transport applies its Host/Origin
 * fence and browser authentication before a route handler runs (see
 * `ConnectionFetchRoute.fetch`), so a route never re-checks them. Writes are
 * validated field-by-field against the loader's own rules and persisted
 * atomically; scheduling fields apply to the next swarm call with no restart
 * (the tool re-reads the file per execution). Every failure crosses as a coded
 * `HostText` (see wire.ts) — the settings page owns the wording, in either
 * language.
 *
 * @module @dsh-app/plugin-swarm/routes
 */

import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import { loadSwarmUserConfig, SwarmConfigValidationError, writeSwarmUserConfig, type SwarmUserConfig } from './user-config.ts'
import type { HostText } from './wire.ts'

/**
 * Route namespace on the shared Connection `/api` channel. The registry admits
 * only path segments matching `[A-Za-z0-9_$.-]`, so the npm scope's `@` cannot
 * appear in the URL: `@dsh-app/plugin-swarm` travels as `dsh-app/plugin-swarm`.
 */
export const ROUTE_PREFIX = '/api/plugins/dsh-app/plugin-swarm'

/** The swarm overlay config slice the settings page edits. */
export interface SwarmOverlaySlice {
  /** Overlay always boots enabled; only the user file can disable. */
  readonly enabled: boolean
  readonly defaultConcurrency: number
  readonly maxConcurrency: number
  readonly maxItems: number
  readonly startStaggerMs: number
  readonly itemMaxRetries: number
  readonly itemRetryDelayMs: number
  readonly perItemOutputLimit: number
  readonly tokenBudget: number
  readonly adaptive: boolean
}

/** GET/POST response payload: defaults, overrides, and the merged result. */
export interface SwarmConfigResponse {
  readonly defaults: SwarmOverlaySlice
  readonly overrides: SwarmUserConfig
  readonly effective: SwarmOverlaySlice
  readonly filePath: string
}

/** Cap on one request body: a config patch is a handful of small fields. */
const MAX_BODY_BYTES = 8_192

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
 * Failure answer. `kind` is the transport-ish category (kept for the existing
 * client checks); `host` is the coded message the UI renders in its own
 * language. The plain `message` stays an English diagnostic for logs and for a
 * client that does not know the code yet.
 */
function fail(status: number, kind: string, host: HostText): Response {
  return sendJson(status, { ok: false, error: { code: kind, message: host.text ?? host.code, host } })
}

/**
 * Bounded JSON body read. The carrier has already buffered the body (the route
 * declares `requestBody: 'buffered'`) under the channel's own cap; this much
 * smaller route limit is checked before parsing so an oversized body can never
 * reach the config writer.
 */
async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('payload-too-large')
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error('payload-too-large')
  const parsed: unknown = JSON.parse(text)
  return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
}

/** Merge user overrides over the overlay slice into the effective view. */
function effectiveConfig(defaults: SwarmOverlaySlice, overrides: SwarmUserConfig): SwarmOverlaySlice {
  return { ...defaults, ...overrides }
}

/**
 * Register the swarm settings route on the Connection exact-Fetch registry.
 *
 * The route owns its exact path and its methods; another method of the same
 * path falls through to the shared channel's own 404 rather than a route body.
 *
 * @param connectionFetch - the Connection exact-Fetch registry (`ctx.connection.fetch`).
 * @param defaults - the overlay (loader) config the plugin booted with.
 * @param filePath - absolute path of the user config file.
 * @returns disposer removing the route.
 */
export function registerSwarmRoutes(
  connectionFetch: HostConnectionFetch,
  defaults: SwarmOverlaySlice,
  filePath: string,
): () => Promise<void> {
  const respond = (): Response => {
    const overrides = loadSwarmUserConfig(filePath, () => {})
    const value: SwarmConfigResponse = {
      defaults,
      overrides,
      effective: effectiveConfig(defaults, overrides),
      filePath,
    }
    return ok(value)
  }

  const dispose = connectionFetch.register({
    path: `${ROUTE_PREFIX}/config`,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') return respond()
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(request)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'invalid body'
        if (message === 'payload-too-large') {
          return fail(413, 'payload-too-large', { code: 'route.bodyTooLarge', text: 'request body too large (8 KiB cap)' })
        }
        return fail(400, 'bad-request', { code: 'route.invalidBody', params: { detail: message }, text: message })
      }
      try {
        writeSwarmUserConfig(filePath, body)
      } catch (error: unknown) {
        if (error instanceof SwarmConfigValidationError) {
          return fail(400, 'bad-request', error.hostText())
        }
        return fail(500, 'io', {
          code: 'route.writeFailed',
          text: error instanceof Error ? error.message : String(error),
        })
      }
      return respond()
    },
  })
  return async () => { await dispose() }
}
