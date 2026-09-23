/**
 * Settings-page API on the shared Connection `/api` channel, under
 * `/api/plugins/dsh-app/plugin-swarm`:
 *   GET  /config — the deployment defaults, the values this profile changes,
 *                  the effective values, and the patch document they live in
 *   POST /config — write a partial patch through the kernel's config editor
 *                  (a field set to null clears the override)
 *
 * The page edits the ten fields the plugin declares as volatile config
 * (`src/index.ts`): the kernel's config editor stores them in the profile's
 * `cordis.patch.yml`, so this plugin owns no configuration file. `defaults` is
 * what the composing layers alone yield, `effective` is what the running
 * plugin is using, and `overrides` — the difference between the two — is the
 * set the page badges as customized and the set "reset" acts on.
 *
 * Trust is the carrier's: the Connection transport applies its Host/Origin
 * fence and browser authentication before a route handler runs (see
 * `ConnectionFetchRoute.fetch`), so a route never re-checks them. Writes are
 * validated field-by-field and then handed to the kernel editor, which
 * persists them and reconciles the loader; volatile fields are committed into
 * the running plugin's references, so a scheduling edit applies to the next
 * swarm call with no restart. Every failure crosses as a coded `HostText` (see
 * wire.ts) — the settings page owns the wording, in either language.
 *
 * @module @dsh-app/plugin-swarm/routes
 */

import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import { projectSwarmConfig, SWARM_CONFIG_FIELDS, SwarmConfigValidationError, validateSwarmConfigPatch, type SwarmConfigValues } from './user-config.ts'
import type { HostText } from './wire.ts'

/**
 * Route namespace on the shared Connection `/api` channel. The registry admits
 * only path segments matching `[A-Za-z0-9_$.-]`, so the npm scope's `@` cannot
 * appear in the URL: `@dsh-app/plugin-swarm` travels as `dsh-app/plugin-swarm`.
 */
export const ROUTE_PREFIX = '/api/plugins/dsh-app/plugin-swarm'

/**
 * The subset of the kernel's `configEditor` service this plugin uses.
 *
 * Declared structurally, like every other optional-service face in the suite
 * (`SessionsLike`, `ToolsLike`): the host half then compiles without a runtime
 * dependency on the package that provides the service, and a host whose
 * profile carries no editor simply has none.
 */
export interface SwarmConfigEditor {
  /**
   * Persist the config a change callback derives.
   * @param entry - the loader entry to write for.
   * @param change - derives the next raw config from the entry's current
   *   config and the layer-only config the entry would inherit.
   */
  edit(
    entry: unknown,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
  /** Inherited layer values per addressable entry (the kernel's `configuration()`). */
  configuration?(): readonly { readonly entry: unknown, readonly inherited: Record<string, unknown> }[]
  /** The patch document edits are written into. */
  readonly documentPath?: string
}

/** Everything the settings routes read from the host half. */
export interface SwarmSettingsDeps {
  /** Current effective values, read per request. */
  live(): SwarmConfigValues
  /** The config the composing layers alone yield, or undefined when unknown. */
  layerDefaults(): Record<string, unknown> | undefined
  /** The loader entry this plugin's row is; read per write, since a reload replaces it. */
  entry(): unknown
  /** The kernel's config editor; absent on a host whose profile has none. */
  readonly editor?: SwarmConfigEditor
}

/** GET/POST response payload: defaults, overrides, and the merged result. */
export interface SwarmConfigResponse {
  readonly defaults: Record<string, number | boolean>
  readonly overrides: Record<string, number | boolean>
  readonly effective: Record<string, number | boolean>
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
 * reach the config editor.
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
 * Register the swarm settings route on the Connection exact-Fetch registry.
 *
 * The route owns its exact path and its methods; another method of the same
 * path falls through to the shared channel's own 404 rather than a route body.
 *
 * @param connectionFetch - the Connection exact-Fetch registry (`ctx.connection.fetch`).
 * @param deps - the host half's readers and the kernel config editor.
 * @returns disposer removing the route.
 */
export function registerSwarmRoutes(
  connectionFetch: HostConnectionFetch,
  deps: SwarmSettingsDeps,
): () => Promise<void> {
  /** The view the page renders: layer defaults, the user's changes, the result. */
  const respond = (): Response => {
    const effective: Record<string, number | boolean> = { ...deps.live() }
    const defaults: Record<string, number | boolean> = { ...effective }
    for (const [field, value] of Object.entries(deps.layerDefaults() ?? {})) {
      if (SWARM_CONFIG_FIELDS.includes(field) && (typeof value === 'number' || typeof value === 'boolean')) {
        defaults[field] = value
      }
    }
    const overrides: Record<string, number | boolean> = {}
    for (const field of SWARM_CONFIG_FIELDS) {
      if (effective[field] !== defaults[field]) overrides[field] = effective[field]
    }
    const value: SwarmConfigResponse = {
      defaults,
      overrides,
      effective,
      filePath: deps.editor?.documentPath ?? '',
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
        const patch = validateSwarmConfigPatch(body)
        const editor = deps.editor
        const entry = deps.entry()
        if (editor === undefined || entry === undefined) {
          return fail(503, 'unavailable', {
            code: 'route.noEditor',
            text: 'this host has no configuration editor, so the value cannot be persisted',
          })
        }
        // Read live at write time: the projection needs the entry's current
        // state, not the state this request arrived with.
        await editor.edit(entry, (current, inherited) => projectSwarmConfig(current, inherited, patch, deps.live()))
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
