/**
 * Settings-page API under `/plugins/@dsh-app/plugin-mcp/api`:
 *   GET  /servers        — sanitized entries + mount status + the file path
 *   POST /server/create  — validate + persist + dynamically mount
 *   POST /server/update  — validate + persist + remount (or unmount when disabled)
 *   POST /server/delete  — persist + unmount
 *   POST /server/import  — bulk-paste mcpServers JSON; per-server failures
 *                          never abort the batch; invalid display-name keys
 *                          are auto-slugged and reported as `renamed`
 *
 * Every route enforces same-origin (403 with a body, never a hung
 * connection). Reads MASK env/header literal values (never returned to the
 * client); an update carrying the mask sentinel keeps the stored value.
 * Dynamic mount/re-unmount runs inline so the UI reflects reality; a mount
 * failure is reported in the entry's status, never as a failed save.
 *
 * @module @dsh-app/plugin-mcp/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { invalidServerNameReason, mapExternalServer, parseMcpServersJson, SERVER_NAME_PATTERN, slugifyServerName } from './wire.ts'
import { McpValidationError, McpStore } from './store.ts'
import type { McpMountManager } from './mount.ts'
import type { McpServerEntry } from './wire.ts'

/** Route namespace on the dsh web server. */
export const ROUTE_PREFIX = '/plugins/@dsh-app/plugin-mcp/api'

/** Mask sentinel for secret-ish values on reads; on writes it means "keep". */
export const VALUE_MASK = '••••••'

/** Structural slice of the webServer service (no full dep on its types). */
interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void
  }): () => void
}

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
  readonly status: { readonly state: string, readonly message?: string, readonly toolCount?: number }
}

export interface McpServersResponse {
  readonly enabled: boolean
  readonly filePath: string
  readonly mountAvailable: boolean
  readonly servers: readonly McpServerView[]
  /** Import report extras (present only on the /server/import response). */
  readonly imported?: readonly string[]
  readonly renamed?: ReadonlyArray<{ readonly from: string, readonly to: string }>
  readonly failed?: ReadonlyArray<{ readonly name: string, readonly reason: string }>
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

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.setHeader('Content-Type', 'application/json')
  res.writeHead(status)
  res.end(JSON.stringify(body))
}

function ok(res: ServerResponse, value: unknown): void {
  sendJson(res, 200, { ok: true, value })
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { ok: false, error: { code, message } })
}

/** Bounded JSON body read (larger cap than swarm: server entries carry env maps). */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 65_536) {
        // Drain instead of destroy: the socket stays alive so the 413 answer
        // actually reaches the client.
        reject(new Error('payload-too-large'))
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {})
      } catch (error) {
        reject(error instanceof Error ? error : new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/** Values the client must never see in plaintext: mask literal env/header values. */
export function maskSecretValues(entry: McpServerEntry): McpServerEntry {
  const mask = (map?: Readonly<Record<string, string>>): Record<string, string> | undefined => {
    if (map === undefined) return undefined
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(map)) {
      out[key] = /^\$ENV:/.test(value) ? value : VALUE_MASK
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
          throw new McpValidationError(`${field}.${key} 是掩码值：请重新输入真实值，或改用 $ENV:VAR 引用`)
        }
        resolved[key] = kept
        continue
      }
      if (typeof value !== 'string') {
        throw new McpValidationError(`${field}.${key} 必须是字符串`)
      }
      resolved[key] = value
    }
    out[field] = resolved
  }
  return out
}

/**
 * Register the MCP manager routes.
 * @param webServer - the dsh web server service.
 * @param store - the servers.json store.
 * @param manager - the dynamic mount manager.
 * @returns disposer removing the routes.
 */
export function registerMcpRoutes(webServer: WebServerLike, store: McpStore, manager: McpMountManager): () => void {
  const respond = async (res: ServerResponse, extra: Record<string, unknown> = {}): Promise<void> => {
    const file = store.load()
    const servers: McpServerView[] = []
    for (const entry of file.servers) {
      servers.push({
        ...maskSecretValues(entry),
        status: manager.statusFor(entry),
      })
    }
    ok(res, {
      enabled: file.enabled,
      filePath: store.filePath,
      mountAvailable: manager.available,
      servers,
      ...extra,
    } satisfies McpServersResponse)
  }

  /** Guarded write: refuse when the master switch is off (read-only mode). */
  const guardWrite = (res: ServerResponse): boolean => {
    if (!store.load().enabled) {
      fail(res, 409, 'disabled', 'MCP 管理已整体停用，请先在配置文件中启用（enabled: true）')
      return false
    }
    return true
  }

  const disposers = [
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/servers`,
      handler: (req, res) => {
        if (!sameOrigin(req)) {
          fail(res, 403, 'forbidden', 'cross-origin request')
          return
        }
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET')
          fail(res, 405, 'method-not-allowed', 'GET only')
          return
        }
        void respond(res)
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/server/create`,
      handler: (req, res) => {
        if (!sameOrigin(req)) {
          fail(res, 403, 'forbidden', 'cross-origin request')
          return
        }
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST')
          fail(res, 405, 'method-not-allowed', 'POST only')
          return
        }
        void readJsonBody(req)
          .then(async (body) => {
            if (!guardWrite(res)) return
            try {
              const entry = store.create(body)
              await manager.syncOne(entry)
            } catch (error) {
              if (error instanceof McpValidationError) {
                fail(res, 400, 'bad-request', error.message)
              } else {
                fail(res, 500, 'io', `写入服务器配置失败：${error instanceof Error ? error.message : String(error)}`)
              }
              return
            }
            await respond(res)
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : 'invalid body'
            if (message === 'payload-too-large') {
              fail(res, 413, 'payload-too-large', 'request body too large (64 KiB cap)')
              return
            }
            fail(res, 400, 'bad-request', message)
          })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/server/update`,
      handler: (req, res) => {
        if (!sameOrigin(req)) {
          fail(res, 403, 'forbidden', 'cross-origin request')
          return
        }
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST')
          fail(res, 405, 'method-not-allowed', 'POST only')
          return
        }
        void readJsonBody(req)
          .then(async (body) => {
            if (!guardWrite(res)) return
            const id = typeof body.id === 'string' ? body.id : ''
            const existing = store.load().servers.find(entry => entry.id === id)
            if (existing === undefined) {
              fail(res, 404, 'not-found', `服务器 ${id} 不存在`)
              return
            }
            try {
              const entry = store.update(id, unmaskSecretValues(body, existing))
              await manager.syncOne(entry)
            } catch (error) {
              if (error instanceof McpValidationError) {
                fail(res, 400, 'bad-request', error.message)
              } else {
                fail(res, 500, 'io', `写入服务器配置失败：${error instanceof Error ? error.message : String(error)}`)
              }
              return
            }
            await respond(res)
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : 'invalid body'
            if (message === 'payload-too-large') {
              fail(res, 413, 'payload-too-large', 'request body too large (64 KiB cap)')
              return
            }
            fail(res, 400, 'bad-request', message)
          })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/server/delete`,
      handler: (req, res) => {
        if (!sameOrigin(req)) {
          fail(res, 403, 'forbidden', 'cross-origin request')
          return
        }
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST')
          fail(res, 405, 'method-not-allowed', 'POST only')
          return
        }
        void readJsonBody(req)
          .then(async (body) => {
            if (!guardWrite(res)) return
            const id = typeof body.id === 'string' ? body.id : ''
            store.remove(id)
            await manager.unmount(id)
            await respond(res)
          })
          .catch((error: unknown) => {
            fail(res, 400, 'bad-request', error instanceof Error ? error.message : 'invalid body')
          })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/server/import`,
      handler: (req, res) => {
        if (!sameOrigin(req)) {
          fail(res, 403, 'forbidden', 'cross-origin request')
          return
        }
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST')
          fail(res, 405, 'method-not-allowed', 'POST only')
          return
        }
        void readJsonBody(req)
          .then(async (body) => {
            if (!guardWrite(res)) return
            const json = typeof body.json === 'string' ? body.json : ''
            let parsed
            try {
              parsed = parseMcpServersJson(json)
            } catch (error) {
              fail(res, 400, 'bad-request', error instanceof Error ? error.message : 'invalid JSON')
              return
            }
            // Per-server independence: one bad definition fails alone (and is
            // reported), the rest of the batch still imports and mounts.
            // Display-name keys that violate the serverName contract are
            // auto-slugged ("Framelink MCP for Figma" → "Framelink_MCP_for_Figma")
            // and surfaced in `renamed` so the rename is never silent.
            const imported: string[] = []
            const renamed: Array<{ from: string, to: string }> = []
            const failed: Array<{ name: string, reason: string }> = []
            for (const { name, def } of parsed) {
              try {
                let serverName = name
                if (!SERVER_NAME_PATTERN.test(name)) {
                  const slug = slugifyServerName(name)
                  if (slug === undefined) throw new McpValidationError(invalidServerNameReason(name))
                  renamed.push({ from: name, to: slug })
                  serverName = slug
                }
                const entry = store.create(mapExternalServer(serverName, def))
                await manager.syncOne(entry)
                imported.push(serverName)
              } catch (error) {
                failed.push({
                  name,
                  reason: error instanceof McpValidationError
                    ? error.message
                    : `写入失败：${error instanceof Error ? error.message : String(error)}`,
                })
              }
            }
            await respond(res, { imported, renamed, failed })
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : 'invalid body'
            if (message === 'payload-too-large') {
              fail(res, 413, 'payload-too-large', 'request body too large (64 KiB cap)')
              return
            }
            fail(res, 400, 'bad-request', message)
          })
      },
    }),
  ]
  return () => { for (const dispose of disposers) dispose() }
}
