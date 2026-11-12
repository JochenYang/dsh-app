/**
 * Settings-page API on the shared Connection `/api` channel, under
 * `/api/plugins/dsh-app/plugin-mcp`:
 *   GET  /servers        — sanitized entries + mount status + the file path
 *   POST /server/create  — validate + persist into the mcp-manager row
 *   POST /server/update  — validate + replace that row's entry
 *   POST /server/delete  — remove the row's entry
 *   POST /server/import  — bulk-paste mcpServers JSON; per-server failures
 *                          never abort the batch; invalid display-name keys
 *                          are auto-slugged and reported as `renamed`
 *
 * Trust is the carrier's: the Connection transport applies its Host/Origin
 * fence and browser authentication before a route handler runs (see
 * `ConnectionFetchRoute.fetch`), so a route never re-checks them — and the
 * registry admits GET/HEAD/POST only, so a request with another method falls
 * through to the shared channel's 404 instead of reaching a handler. Reads
 * MASK env/header literal values (never returned to the client); an update
 * carrying the mask sentinel keeps the stored value. Dynamic mount/re-unmount
 * runs inline so the UI reflects reality; a mount failure is reported in the
 * entry's status, never as a failed save.
 *
 * Isolation note: the small transport helpers below intentionally mirror
 * plugin-hooks' routes.ts instead of being shared — each suite plugin bundles
 * standalone (esbuild, no cross-plugin runtime imports), so a shared util
 * would be a new package for ~30 lines.
 *
 * @module @dsh-app/plugin-mcp/routes
 */

import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import { invalidServerNameError, mapExternalServer, parseMcpServersJson, SERVER_NAME_PATTERN, slugifyServerName } from './wire.ts'
import { McpValidationError, McpStore } from './store.ts'
import type { McpFleetStatus } from './status.ts'
import type { HostText, McpMountStatus, McpServerEntry } from './wire.ts'

/**
 * Route namespace on the shared Connection `/api` channel (mirrors the client
 * half). The registry admits only path segments matching `[A-Za-z0-9_$.-]`, so
 * the npm scope's `@` cannot appear in the URL: `@dsh-app/plugin-mcp` travels
 * as `dsh-app/plugin-mcp`.
 */
export const ROUTE_PREFIX = '/api/plugins/dsh-app/plugin-mcp'

/** Mask sentinel for secret-ish values on reads; on writes it means "keep". */
export const VALUE_MASK = '••••••'

/**
 * A value that names a credential instead of carrying one: either reference
 * syntax reads back in plaintext, so the user can see what is stored.
 */
const REFERENCE_VALUE = /^(?:\$ENV:|\$\{credential:)/u

/** The client-facing view of one entry: fields + mount status, values masked. */
export interface McpServerView {
  readonly id: string
  readonly serverName: string
  readonly transport: string
  readonly enabled: boolean
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly toolCallTimeoutMs?: number
  readonly status: McpMountStatus
}

export interface McpServersResponse {
  readonly enabled: boolean
  readonly filePath: string
  readonly mountAvailable: boolean
  readonly servers: readonly McpServerView[]
  /** Import report extras (present only on the /server/import response). */
  readonly imported?: readonly string[]
  readonly renamed?: ReadonlyArray<{ readonly from: string, readonly to: string }>
  readonly failed?: ReadonlyArray<{ readonly name: string, readonly reason: HostText }>
}

/** Cap on one request body (larger than swarm's: server entries carry env maps). */
const MAX_BODY_BYTES = 65_536

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
 * reach the store.
 */
async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('payload-too-large')
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error('payload-too-large')
  const parsed: unknown = JSON.parse(text)
  return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
}

/** Values the client must never see in plaintext: mask literal env/header values. */
export function maskSecretValues(entry: McpServerEntry): McpServerEntry {
  const mask = (map?: Readonly<Record<string, string>>): Record<string, string> | undefined => {
    if (map === undefined) return undefined
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(map)) {
      // A reference is not a secret. `$ENV:NAME` was this plugin's own syntax
      // before the fleet moved to the kernel manager, `${credential:NAME}` is the
      // manager's template, and either way the user has to read back WHICH
      // reference is stored — masking it would leave nothing to edit.
      out[key] = REFERENCE_VALUE.test(value) ? value : VALUE_MASK
    }
    return out
  }
  return { ...entry, env: mask(entry.env), headers: mask(entry.headers) }
}

/** Re-attach stored values where the client sent the mask sentinel back. */
export function unmaskSecretValues(raw: Record<string, unknown>, existing: McpServerEntry | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw }
  for (const field of ['env', 'headers'] as const) {
    const incoming = out[field]
    if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) continue
    const stored = existing?.[field] as Readonly<Record<string, string>> | undefined
    const resolved: Record<string, string> = {}
    for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
      if (value === VALUE_MASK) {
        const kept = stored?.[key]
        if (kept === undefined) {
          throw new McpValidationError('secret.masked', { field: `${field}.${key}` })
        }
        resolved[key] = kept
        continue
      }
      if (typeof value !== 'string') {
        throw new McpValidationError('field.stringValue', { field: `${field}.${key}` })
      }
      resolved[key] = value
    }
    out[field] = resolved
  }
  return out
}

/** Body-read failure: `invalid body`, or the JSON parser's own text. */
function invalidBody(error: unknown): HostText {
  const detail = error instanceof Error ? error.message : 'invalid body'
  return { code: 'route.invalidBody', params: { detail }, text: detail }
}

/** Body-read rejection: the 64 KiB cap answers 413, anything else 400. */
function bodyRejection(error: unknown): Response {
  if (error instanceof Error && error.message === 'payload-too-large') {
    return fail(413, 'payload-too-large', { code: 'route.bodyTooLarge', text: 'request body too large (64 KiB cap)' })
  }
  return fail(400, 'bad-request', invalidBody(error))
}

/**
 * Register the MCP manager routes on the Connection exact-Fetch registry.
 * @param connectionFetch - the registry (`ctx.connection.fetch`).
 * @param store - the fleet store (the `mcp-manager` row's config).
 * @param fleet - the kernel manager's live status view.
 * @returns disposer removing the routes.
 */
export function registerMcpRoutes(
  connectionFetch: HostConnectionFetch,
  store: McpStore,
  fleet: McpFleetStatus,
): () => Promise<void> {
  const respond = async (extra: Record<string, unknown> = {}): Promise<Response> => {
    let file
    try {
      file = store.load()
    } catch (error) {
      // `store.unreadable`: the row is there but its config could not be read.
      // Reporting an empty fleet here would hide servers the manager is running.
      return writeRejection(error)
    }
    const servers: McpServerView[] = []
    for (const entry of file.servers) {
      servers.push({
        ...maskSecretValues(entry),
        status: fleet.statusFor(entry),
      })
    }
    return ok({
      enabled: file.enabled,
      filePath: store.filePath,
      mountAvailable: fleet.available,
      servers,
      ...extra,
    } satisfies McpServersResponse)
  }

  /** Guarded write: the master switch off answers 409 (read-only mode). */
  const guardWrite = (): Response | undefined => (store.load().enabled
    ? undefined
    : fail(409, 'disabled', { code: 'route.disabled' }))

  /** Write-store failure: the reason is a technical detail, so the client's
   * copy owns the sentence and the detail rides as the code's English text. */
  const writeFailed = (error: unknown): HostText => {
    const detail = error instanceof Error ? error.message : String(error)
    return { code: 'route.writeFailed', params: { detail }, text: detail }
  }

  /** Validation rejection vs a store failure, both for the same mutate step. */
  const writeRejection = (error: unknown): Response => (error instanceof McpValidationError
    ? fail(400, 'bad-request', error.hostText())
    : fail(500, 'io', writeFailed(error)))

  /** One entry write: a body read, the master-switch guard, then the mutation. */
  const create = async (request: Request): Promise<Response> => {
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(request)
    } catch (error) {
      return bodyRejection(error)
    }
    const denied = guardWrite()
    if (denied !== undefined) return denied
    try {
      // A mask sentinel with nothing behind it is a copy/paste mistake, not a
      // secret: refuse it here rather than persisting `••••••` as the token.
      await store.create(unmaskSecretValues(body, undefined))
    } catch (error) {
      return writeRejection(error)
    }
    return await respond()
  }

  /** One entry rewrite: the stored entry supplies the values behind the mask. */
  const update = async (request: Request): Promise<Response> => {
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(request)
    } catch (error) {
      return bodyRejection(error)
    }
    const denied = guardWrite()
    if (denied !== undefined) return denied
    const id = typeof body.id === 'string' ? body.id : ''
    try {
      // The mask sentinel is resolved against the entry as it is AT WRITE TIME
      // (`withLive`), not against the copy this request read: another writer may
      // have rotated that secret in between.
      await store.update(id, body, (live) => unmaskSecretValues(body, live as McpServerEntry | undefined))
    } catch (error) {
      // The store resolves the key inside the write now, so "no such server" is
      // raised there; the client keys its own copy on 404.
      if (error instanceof McpValidationError && error.code === 'server.notFound') {
        return fail(404, 'not-found', error.hostText())
      }
      return writeRejection(error)
    }
    return await respond()
  }

  /** One entry removal: the row is the truth and the manager unmounts it. */
  const remove = async (request: Request): Promise<Response> => {
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(request)
    } catch (error) {
      return fail(400, 'bad-request', invalidBody(error))
    }
    const denied = guardWrite()
    if (denied !== undefined) return denied
    const id = typeof body.id === 'string' ? body.id : ''
    try {
      await store.remove(id)
    } catch (error) {
      return writeRejection(error)
    }
    return await respond()
  }

  /** Bulk import: per-server independence, with the rename report attached. */
  const importServers = async (request: Request): Promise<Response> => {
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(request)
    } catch (error) {
      return bodyRejection(error)
    }
    const denied = guardWrite()
    if (denied !== undefined) return denied
    const json = typeof body.json === 'string' ? body.json : ''
    let parsed
    try {
      parsed = parseMcpServersJson(json)
    } catch (error) {
      return fail(400, 'bad-request', error instanceof McpValidationError ? error.hostText() : invalidBody(error))
    }
    // Per-server independence: one bad definition fails alone (and is
    // reported), the rest of the batch still imports and mounts.
    // Display-name keys that violate the serverName contract are
    // auto-slugged ("Framelink MCP for Figma" → "Framelink_MCP_for_Figma")
    // and surfaced in `renamed` so the rename is never silent.
    const imported: string[] = []
    const renamed: Array<{ from: string, to: string }> = []
    const failed: Array<{ name: string, reason: HostText }> = []
    for (const { name, def } of parsed) {
      try {
        let serverName = name
        if (!SERVER_NAME_PATTERN.test(name)) {
          const slug = slugifyServerName(name)
          if (slug === undefined) throw invalidServerNameError(name)
          renamed.push({ from: name, to: slug })
          serverName = slug
        }
        await store.create(unmaskSecretValues(mapExternalServer(serverName, def), undefined))
        imported.push(serverName)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        failed.push({
          name,
          reason: error instanceof McpValidationError
            ? error.hostText()
            : { code: 'import.writeFailed', params: { detail }, text: detail },
        })
      }
    }
    return await respond({ imported, renamed, failed })
  }

  const disposers = [
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/servers`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => await respond(),
    }),
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/server/create`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: create,
    }),
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/server/update`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: update,
    }),
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/server/delete`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: remove,
    }),
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/server/import`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: importServers,
    }),
  ]
  return async () => { for (const dispose of disposers) await dispose() }
}
