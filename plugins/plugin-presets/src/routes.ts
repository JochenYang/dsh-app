/**
 * Settings-page API on the shared Connection `/api` channel, under
 * `/api/plugins/dsh-app/plugin-presets` (the registry admits only
 * `[A-Za-z0-9_$.-]` in a path segment, so the npm scope travels as `dsh-app`;
 * a parameter rides the query string, never a path segment):
 *   GET  /presets        — exportable presets in the managed root (name, files, bytes)
 *   GET  /export?entry=  — the preset as `.dshpreset` archive bytes (attachment)
 *   POST /import         — archive bytes as body; validates + writes into the
 *                          managed root; an existing entry answers 409 unless the
 *                          caller explicitly re-posts with `?overwrite=1`
 *   GET  /config-export  — the whole config backup as a zip (attachment): the
 *                          host settings file, the home patch layer, the
 *                          credential store, the profile patch layer +
 *                          manifest, the market source list, and whitelisted
 *                          suite-plugin store files. Credential-named files
 *                          never enter outside the store's exact path;
 *                          collected content is scanned and every
 *                          secret-shaped hit rides the answer as an
 *                          `x-dsh-backup-warnings` header (base64 JSON of
 *                          `{ rel, rule }`), because the archive carries
 *                          plaintext key material by design
 *   POST /config-import  — backup zip as body; validates (manifest kind/version,
 *                          containment, caps) then restores; differing existing
 *                          targets answer 409 with the conflict list unless the
 *                          caller re-posts with `?overwrite=1` (or `true`; the
 *                          restore is staged and rolled back on failure, and
 *                          the profile patch layer, the host settings file and
 *                          the credential store are copied aside before an
 *                          overwrite)
 *
 * Trust is the carrier's: the Connection transport applies its Host/Origin
 * fence and browser authentication before a route handler runs, and the desktop
 * host's pipe carrier is reachable only by the shell that spawned it, so a
 * route never re-checks them. A method a route does not own falls through to
 * the shared channel's own 404.
 *
 * Safety: the upload body is capped at the archive limit while it streams in;
 * all archive-level rules (manifest, containment, caps) are enforced by
 * wire/pack/backup before anything touches the disk. The managed root never
 * reaches the client as an absolute path — the list route reports the symbolic
 * harness-home display form only.
 *
 * Isolation note: the transport helpers below intentionally mirror the other
 * suite plugins' routes.ts instead of being shared — each suite plugin bundles
 * standalone (esbuild, no cross-plugin runtime imports).
 *
 * @module @dsh-app/plugin-presets/routes
 */

import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import { MAX_ZIP_BYTES, PresetPackageError, entryNameProblem, type HostText } from './wire.ts'
import { MAX_BACKUP_ZIP_BYTES, packConfigBackup, restoreConfigBackup, unpackConfigBackup } from './backup.ts'
import { PresetStore } from './store.ts'
import type { PresetSummary } from './store.ts'

/** Route namespace on the shared Connection `/api` channel. */
export const ROUTE_PREFIX = '/api/plugins/dsh-app/plugin-presets'

/** Payload the list route answers with; `root` is a display form, '' = hidden. */
export interface PresetsResponse {
  readonly root: string
  readonly presets: readonly PresetSummary[]
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

function fail(status: number, code: string, host: HostText, extra: Record<string, unknown> = {}): Response {
  return sendJson(status, { ok: false, error: { code, message: host.text ?? host.code, host, ...extra } })
}

/** HTTP status for a package-level failure code. */
function statusForCode(code: string): number {
  switch (code) {
    case 'unknown-entry': return 404
    case 'conflict': return 409
    case 'too-large':
    case 'too-many-files': return 413
    case 'io': return 500
    default: return 400
  }
}

/** Answer a PresetPackageError with its mapped status, coded message and details. */
function failPackage(error: PresetPackageError): Response {
  return fail(statusForCode(error.code), error.code, error.hostText(), error.details)
}

/** Parse the request URL's query (request.url is absolute on the carrier). */
function queryOf(request: Request): URLSearchParams {
  return new URL(request.url).searchParams
}

/**
 * Bounded binary body read for the import uploads. The cap is enforced while
 * the body streams in — an over-cap upload stops being read (the carrier
 * discards the unconsumed frames once the response is written) and the 413
 * answer is the only thing the caller sees.
 */
async function readBinaryBody(request: Request, cap: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > cap) throw new Error('payload-too-large')
  if (request.body === null) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > cap) {
      await reader.cancel().catch(() => undefined)
      throw new Error('payload-too-large')
    }
    chunks.push(value)
  }
  const data = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.byteLength
  }
  return data
}

/** One archive answer: the bytes as an attachment the client saves. */
function zipResponse(bytes: Uint8Array, filename: string): Response {
  // BodyInit wants a plain ArrayBuffer-backed source; an archive is a few MB at
  // most, so the exact byte range is copied rather than cast.
  const body = Uint8Array.from(bytes).buffer
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${filename}"`,
      'content-length': String(bytes.byteLength),
    },
  })
}

/**
 * Register the preset-package routes on the Connection exact-Fetch registry.
 *
 * Every route owns its exact path and its methods; another method of the same
 * path falls through to the shared channel's own 404 rather than a route body.
 *
 * @param connectionFetch - the Connection exact-Fetch registry (`ctx.connection.fetch`).
 * @param store - the preset-root store.
 * @param rootDisplay - symbolic root description for the client ('' hides it).
 * @returns disposer removing the routes.
 */
export function registerPresetRoutes(connectionFetch: HostConnectionFetch, store: PresetStore, rootDisplay: string): () => Promise<void> {
  const disposers = [
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/presets`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          const presets = await store.list()
          return ok({ root: rootDisplay, presets } satisfies PresetsResponse)
        } catch (error: unknown) {
          if (error instanceof PresetPackageError) return failPackage(error)
          return fail(500, 'io', { code: 'route.listFailed', text: 'cannot read the preset list' })
        }
      },
    }),
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/export`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const entry = queryOf(request).get('entry') ?? ''
        const problem = entryNameProblem(entry)
        if (problem !== undefined) {
          return fail(400, 'entry-invalid', {
            code: 'preset.entryInvalid',
            params: { reason: problem.code },
            text: `invalid preset name: ${problem.text ?? problem.code}`,
          })
        }
        try {
          const bytes = await store.exportZip(entry)
          // The whitelist guarantees an ASCII filename; no RFC 5987 needed.
          return zipResponse(bytes, `${entry}.dshpreset`)
        } catch (error: unknown) {
          if (error instanceof PresetPackageError) return failPackage(error)
          return fail(500, 'io', { code: 'route.exportFailed', text: 'cannot export the preset' })
        }
      },
    }),
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/import`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const overwrite = ['1', 'true'].includes(queryOf(request).get('overwrite') ?? '')
        try {
          const data = await readBinaryBody(request, MAX_ZIP_BYTES)
          const { entry, files } = await store.importZip(data, overwrite)
          return ok({ entry, files })
        } catch (error: unknown) {
          if (error instanceof Error && error.message === 'payload-too-large') {
            const mb = Math.floor(MAX_ZIP_BYTES / 1024 / 1024)
            return fail(413, 'payload-too-large', {
              code: 'route.presetTooLarge',
              params: { mb },
              text: `the preset package exceeds the ${String(mb)} MB cap`,
            })
          }
          if (error instanceof PresetPackageError) return failPackage(error)
          return fail(400, 'bad-request', { code: 'route.importUnreadable', text: 'import failed: the request content could not be recognized' })
        }
      },
    }),
  ]
  return async () => { for (const dispose of disposers) await dispose() }
}

/** Collaborators of the config-backup routes, injectable for tests. */
export interface BackupRouteDeps {
  /** The dsh home root the backup reads from and restores into. */
  readonly home: string
  /** The profile the profile-block members apply to. */
  readonly profile: string
}

/** Upload cap text for the config-import 413 answer. */
const BACKUP_CAP_TEXT = `${String(Math.floor(MAX_BACKUP_ZIP_BYTES / 1024 / 1024))}MB`

/**
 * Register the config-backup routes (the settings section's "配置备份" block).
 * All archive rules live in backup.ts; here is only transport framing.
 * @param connectionFetch - the Connection exact-Fetch registry (`ctx.connection.fetch`).
 * @param deps - home root and profile.
 * @returns disposer removing the routes.
 */
export function registerBackupRoutes(connectionFetch: HostConnectionFetch, deps: BackupRouteDeps): () => Promise<void> {
  const disposers = [
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/config-export`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          const { bytes, warnings } = await packConfigBackup(deps.home, deps.profile)
          // Secret-shaped content no longer refuses the export — the
          // credential store rides on purpose — so the scan hits travel with
          // the answer: base64 JSON in a header, decoded by the client into
          // the "this archive holds plaintext key material" notice.
          const response = zipResponse(bytes, 'dsh-config-backup.zip')
          if (warnings.length > 0) {
            response.headers.set(
              'x-dsh-backup-warnings',
              Buffer.from(JSON.stringify(warnings), 'utf8').toString('base64'),
            )
          }
          return response
        } catch (error: unknown) {
          if (error instanceof PresetPackageError) return failPackage(error)
          return fail(500, 'io', { code: 'route.backupExportFailed', text: 'cannot export the configuration backup' })
        }
      },
    }),
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/config-import`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        // Same values the preset import route accepts ('1' | 'true').
        const overwrite = ['1', 'true'].includes(queryOf(request).get('overwrite') ?? '')
        try {
          const data = await readBinaryBody(request, MAX_BACKUP_ZIP_BYTES)
          const outcome = await restoreConfigBackup(deps.home, deps.profile, unpackConfigBackup(data), overwrite)
          return ok({
            written: outcome.written,
            unchanged: outcome.unchanged,
            files: outcome.files,
            backups: outcome.backups,
          })
        } catch (error: unknown) {
          if (error instanceof Error && error.message === 'payload-too-large') {
            return fail(413, 'payload-too-large', {
              code: 'route.backupTooLarge',
              params: { mb: BACKUP_CAP_TEXT },
              text: `the configuration backup exceeds the ${BACKUP_CAP_TEXT} cap`,
            })
          }
          if (error instanceof PresetPackageError) return failPackage(error)
          return fail(400, 'bad-request', { code: 'route.importUnreadable', text: 'import failed: the request content could not be recognized' })
        }
      },
    }),
  ]
  return async () => { for (const dispose of disposers) await dispose() }
}
