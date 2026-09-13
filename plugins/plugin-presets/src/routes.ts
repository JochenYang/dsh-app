/**
 * Settings-page API under `/plugins/@dsh-app/plugin-presets/api`:
 *   GET  /presets        — exportable presets in the managed root (name, files, bytes)
 *   GET  /export?entry=  — the preset as `.dshpreset` archive bytes (attachment)
 *   POST /import         — archive bytes as body; validates + writes into the
 *                          managed root; an existing entry answers 409 unless the
 *                          caller explicitly re-posts with `?overwrite=1`
 *   GET  /config-export  — the whole config backup as a zip (attachment): the
 *                          profile patch layer + manifest, the market source
 *                          list, and whitelisted suite-plugin store files
 *                          (credential-named files never enter; collected
 *                          content is scanned and a secret-shaped hit refuses
 *                          the export)
 *   POST /config-import  — backup zip as body; validates (manifest kind/version,
 *                          containment, caps) then restores; differing existing
 *                          targets answer 409 with the conflict list unless the
 *                          caller re-posts with `?overwrite=1` (or `true`; the
 *                          restore is staged and rolled back on failure, and
 *                          the profile patch layer is copied aside before an
 *                          overwrite)
 *
 * Safety: every request passes the same-origin + loopback fences; the upload
 * body is capped at the archive limit (drained, not destroyed, so the 413
 * answer reaches the client); all archive-level rules (manifest, containment,
 * caps) are enforced by wire/pack/backup before anything touches the disk. The
 * managed root never reaches the client as an absolute path — the list route
 * reports the symbolic harness-home display form only.
 *
 * Isolation note: the HTTP helpers below intentionally mirror the other suite
 * plugins' routes.ts instead of being shared — each suite plugin bundles
 * standalone (esbuild, no cross-plugin runtime imports).
 *
 * @module @dsh-app/plugin-presets/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { MAX_ZIP_BYTES, PresetPackageError, entryNameProblem } from './wire.ts'
import { MAX_BACKUP_ZIP_BYTES, packConfigBackup, restoreConfigBackup, unpackConfigBackup } from './backup.ts'
import { PresetStore } from './store.ts'
import type { PresetSummary } from './store.ts'

/** Route namespace on the dsh web server. */
export const ROUTE_PREFIX = '/plugins/@dsh-app/plugin-presets/api'

/** Structural slice of the webServer service (no full dep on its types). */
interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void
  }): () => void
}

/** Payload the list route answers with; `root` is a display form, '' = hidden. */
export interface PresetsResponse {
  readonly root: string
  readonly presets: readonly PresetSummary[]
}

/** Same-origin fence (compare host parts; Origin carries the scheme). */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/**
 * Loopback-host fence: admit only requests whose Host names this machine's
 * loopback interface, so a rebinding/cross-site request carrying an
 * attacker's Host is refused even when it forges a matching Origin.
 */
function passesFence(req: IncomingMessage): boolean {
  const raw = req.headers.host
  if (typeof raw !== 'string' || raw === '') return false
  let hostname: string
  try {
    hostname = new URL(`http://${raw}`).hostname
  } catch {
    return false
  }
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const octets = hostname.split('.')
  return octets.length === 4
    && octets[0] === '127'
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.setHeader('Content-Type', 'application/json')
  res.writeHead(status)
  res.end(JSON.stringify(body))
}

function ok(res: ServerResponse, value: unknown): void {
  sendJson(res, 200, { ok: true, value })
}

function fail(res: ServerResponse, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
  sendJson(res, status, { ok: false, error: { code, message, ...extra } })
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

/** Answer a PresetPackageError with its mapped status, message and details. */
function failPackage(res: ServerResponse, error: PresetPackageError): void {
  fail(res, statusForCode(error.code), error.code, error.message, error.details)
}

/** Parse the request URL's query (req.url is path?query against any host). */
function queryOf(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', 'http://localhost').searchParams
}

/**
 * Bounded binary body read for the import uploads. On overflow the stream is
 * drained (not destroyed) so the 413 answer actually reaches the client.
 */
function readBinaryBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > cap) {
        reject(new Error('payload-too-large'))
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks)) })
    req.on('error', reject)
  })
}

/** Same-origin + loopback fence and the method check, shared by both route groups. */
function guarded(req: IncomingMessage, res: ServerResponse, method: 'GET' | 'POST'): boolean {
  if (!sameOrigin(req) || !passesFence(req)) {
    fail(res, 403, 'forbidden', 'cross-origin request')
    return false
  }
  if (req.method !== method) {
    res.setHeader('Allow', method)
    fail(res, 405, 'method-not-allowed', `${method} only`)
    return false
  }
  return true
}

/**
 * Register the preset-package routes.
 * @param webServer - the dsh web server service.
 * @param store - the preset-root store.
 * @param rootDisplay - symbolic root description for the client ('' hides it).
 * @returns disposer removing the routes.
 */
export function registerPresetRoutes(webServer: WebServerLike, store: PresetStore, rootDisplay: string): () => void {
  const disposers = [
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/presets`,
      handler: (req, res) => {
        if (!guarded(req, res, 'GET')) return
        void store.list()
          .then(presets => ok(res, { root: rootDisplay, presets } satisfies PresetsResponse))
          .catch((error: unknown) => {
            if (error instanceof PresetPackageError) { failPackage(res, error); return }
            fail(res, 500, 'io', '读取预设列表失败')
          })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/export`,
      handler: (req, res) => {
        if (!guarded(req, res, 'GET')) return
        const entry = queryOf(req).get('entry') ?? ''
        const problem = entryNameProblem(entry)
        if (problem !== undefined) {
          fail(res, 400, 'entry-invalid', `预设名不合法：${problem}`)
          return
        }
        void store.exportZip(entry)
          .then((bytes) => {
            // The whitelist guarantees an ASCII filename; no RFC 5987 needed.
            res.setHeader('Content-Type', 'application/zip')
            res.setHeader('Content-Disposition', `attachment; filename="${entry}.dshpreset"`)
            res.setHeader('Content-Length', String(bytes.byteLength))
            res.writeHead(200)
            res.end(Buffer.from(bytes))
          })
          .catch((error: unknown) => {
            if (error instanceof PresetPackageError) { failPackage(res, error); return }
            fail(res, 500, 'io', '导出预设失败')
          })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/import`,
      handler: (req, res) => {
        if (!guarded(req, res, 'POST')) return
        const overwrite = ['1', 'true'].includes(queryOf(req).get('overwrite') ?? '')
        void readBinaryBody(req, MAX_ZIP_BYTES)
          .then(data => store.importZip(data, overwrite))
          .then(({ entry, files }) => { ok(res, { entry, files }) })
          .catch((error: unknown) => {
            if (error instanceof Error && error.message === 'payload-too-large') {
              fail(res, 413, 'payload-too-large', `预设包超过 ${String(Math.floor(MAX_ZIP_BYTES / 1024 / 1024))}MB 上限`)
              return
            }
            if (error instanceof PresetPackageError) { failPackage(res, error); return }
            fail(res, 400, 'bad-request', '导入失败：请求内容无法识别')
          })
      },
    }),
  ]
  return () => { for (const dispose of disposers) dispose() }
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
 * All archive rules live in backup.ts; here is only HTTP framing.
 * @param webServer - the dsh web server service.
 * @param deps - home root and profile.
 * @returns disposer removing the routes.
 */
export function registerBackupRoutes(webServer: WebServerLike, deps: BackupRouteDeps): () => void {
  const disposers = [
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/config-export`,
      handler: (req, res) => {
        if (!guarded(req, res, 'GET')) return
        void packConfigBackup(deps.home, deps.profile)
          .then((bytes) => {
            // The client names the file with a date stamp; the header carries
            // the plain fallback name.
            res.setHeader('Content-Type', 'application/zip')
            res.setHeader('Content-Disposition', 'attachment; filename="dsh-config-backup.zip"')
            res.setHeader('Content-Length', String(bytes.byteLength))
            res.writeHead(200)
            res.end(Buffer.from(bytes))
          })
          .catch((error: unknown) => {
            if (error instanceof PresetPackageError) { failPackage(res, error); return }
            fail(res, 500, 'io', '导出配置备份失败')
          })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/config-import`,
      handler: (req, res) => {
        if (!guarded(req, res, 'POST')) return
        // Same values the preset import route accepts ('1' | 'true').
        const overwrite = ['1', 'true'].includes(queryOf(req).get('overwrite') ?? '')
        void readBinaryBody(req, MAX_BACKUP_ZIP_BYTES)
          .then(data => restoreConfigBackup(deps.home, deps.profile, unpackConfigBackup(data), overwrite))
          .then((outcome) => {
            ok(res, {
              written: outcome.written,
              unchanged: outcome.unchanged,
              files: outcome.files,
              backups: outcome.backups,
            })
          })
          .catch((error: unknown) => {
            if (error instanceof Error && error.message === 'payload-too-large') {
              fail(res, 413, 'payload-too-large', `配置备份超过 ${BACKUP_CAP_TEXT} 上限`)
              return
            }
            if (error instanceof PresetPackageError) { failPackage(res, error); return }
            fail(res, 400, 'bad-request', '导入失败：请求内容无法识别')
          })
      },
    }),
  ]
  return () => { for (const dispose of disposers) dispose() }
}
