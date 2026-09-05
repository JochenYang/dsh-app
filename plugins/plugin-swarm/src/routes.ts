/**
 * Settings-page API under `/plugins/@dsh-app/plugin-swarm/api`:
 *   GET  /config — overlay defaults + validated user overrides + effective
 *                  values + the config file path
 *   POST /config — merge a partial override set into the user config file
 *                  (a field set to null clears that override)
 *
 * Same-origin enforced on both routes (403 with a body, never a hung
 * connection). Writes are validated field-by-field against the loader's own
 * rules and persisted atomically; scheduling fields apply to the next swarm
 * call with no restart (the tool re-reads the file per execution).
 *
 * @module @dsh-app/plugin-swarm/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadSwarmUserConfig, SwarmConfigValidationError, writeSwarmUserConfig, type SwarmUserConfig } from './user-config.ts'

/** Route namespace on the dsh web server. */
export const ROUTE_PREFIX = '/plugins/@dsh-app/plugin-swarm/api'

/** Structural slice of the webServer service (no full dep on its types). */
interface WebServerLike {
  register(route: { path: string, handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
}

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

/** Browser Origin carries the scheme (`http://host:port`), so a raw string
 *  compare against the Host header can never pass for browser requests —
 *  compare the host parts. A missing Origin is a non-browser caller (curl,
 *  in-process): allowed. Exported for tests. */
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

/** Bounded JSON body read (same discipline as the memory routes). */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 8_192) {
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

/** Merge user overrides over the overlay slice into the effective view. */
function effectiveConfig(defaults: SwarmOverlaySlice, overrides: SwarmUserConfig): SwarmOverlaySlice {
  return { ...defaults, ...overrides }
}

/**
 * Register the swarm settings routes.
 * @param webServer - the dsh web server service.
 * @param defaults - the overlay (loader) config the plugin booted with.
 * @param filePath - absolute path of the user config file.
 * @returns disposer removing the routes.
 */
export function registerSwarmRoutes(webServer: WebServerLike, defaults: SwarmOverlaySlice, filePath: string): () => void {
  const respond = (res: ServerResponse): void => {
    const overrides = loadSwarmUserConfig(filePath, () => {})
    const value: SwarmConfigResponse = {
      defaults,
      overrides,
      effective: effectiveConfig(defaults, overrides),
      filePath,
    }
    ok(res, value)
  }

  const disposers = [
    webServer.register({
      path: `${ROUTE_PREFIX}/config`,
      handler: (req, res) => {
        if (!sameOrigin(req)) {
          fail(res, 403, 'forbidden', 'cross-origin request')
          return
        }
        if (req.method === 'GET') {
          respond(res)
          return
        }
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'GET, POST')
          fail(res, 405, 'method-not-allowed', 'GET or POST only')
          return
        }
        void readJsonBody(req)
          .then((body) => {
            try {
              writeSwarmUserConfig(filePath, body)
            } catch (error) {
              if (error instanceof SwarmConfigValidationError) {
                fail(res, 400, 'bad-request', error.message)
              } else {
                fail(res, 500, 'io', `写入配置失败：${error instanceof Error ? error.message : String(error)}`)
              }
              return
            }
            respond(res)
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : 'invalid body'
            if (message === 'payload-too-large') {
              fail(res, 413, 'payload-too-large', 'request body too large (8 KiB cap)')
              return
            }
            fail(res, 400, 'bad-request', message)
          })
      },
    }),
  ]
  return () => { for (const dispose of disposers) dispose() }
}
