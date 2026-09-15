/**
 * Host routes under `/plugins/@dsh-app/plugin-brand/api`: the kernel-side
 * doorway through which the app's UI asks the Electron shell for a native
 * action (reveal a folder, notify, save-as, pick a directory, reveal logs).
 *
 * The routes forward to the shell's own desktop bridge over loopback HTTP —
 * the shell already owns the fences, the bearer token and the Electron dialogs
 * (`src/main/desktop-bridge.ts`), so this layer adds exactly two things: the
 * browser-trust fence the rest of the suite uses, and a stable contract.
 *
 * Client contract (all bodies JSON):
 *
 *   GET  /status
 *     → 200 `{ ok: true, bridge: boolean }`  — `bridge` is false when the
 *       environment has no bridge (dev / older shell), so the settings page can
 *       show the desktop-feature status without a probe request.
 *   POST /desktop/open-in-folder   `{ path }`           → 200 `{ ok: true }`
 *   POST /desktop/notify           `{ title, body }`    → 200 `{ ok: true }`
 *   POST /desktop/save-text-as     `{ name, content }`  → 200 `{ ok: true, path: string | null }`
 *   POST /desktop/pick-directory   `{}`                 → 200 `{ ok: true, path: string | null }`
 *   POST /desktop/open-logs        `{}`                 → 200 `{ ok: true }`
 *   GET  /diagnostics/log-tail?lines=N
 *     → 200 `{ ok: true, path: string, lines: string[] }` — the tail of the
 *       NEWEST server log in the directory the shell injected, at most N lines
 *       (default 200, ceiling 1000, read from the end; see `log-tail.ts`).
 *       The lines were redacted when the shell wrote them.
 *   POST /diagnostics/export
 *     → 200 `{ ok: true, name, generatedAt, shellVersion, kernelVersion,
 *              kernelChannel, logDir, log }` — the FACTS behind the plain-text
 *       diagnostics package (see `diagnostics-facts.ts`). The host does not
 *       assemble the file: the page renders these facts in the UI's language
 *       and sends the text back through `/desktop/save-text-as`, which is the
 *       route that validates a write. The request BODY is ignored: every fact
 *       comes from the environment the shell injected and from the log files,
 *       so there is no caller input to validate.
 *
 *   `path: null` means the user cancelled — a success with no path, never an
 *   error.
 *
 * Failure contract, worded so a caller can tell the two classes apart without
 * parsing prose:
 *
 *   - environment cannot do it (no bridge vars, the shell answered 501, or the
 *     log directory is missing/not injected)
 *     → 200 `{ ok: false, unsupported: true, error, host }`, code
 *       `route.unsupported`
 *   - the action itself failed (shell down, native call threw, a `lines` value
 *     that is not a positive integer, an unreadable log file)
 *     → 400 / 404 / 413 / 500 / 502 `{ ok: false, unsupported: false, error, host }`
 *   - fence refusal → 403, wrong method → 405
 *
 * `host` is the coded message the client renders in its own language
 * (see `host-text.ts`); `error` repeats its English diagnostic so a reader
 * that does not know the code still gets a line. The one exception is the
 * per-field validation of the four desktop actions: no client calls them yet,
 * so their labels have no dictionary to live in and stay in this file.
 *
 * @module @dsh-app/plugin-brand/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { bridgeConfigured, callDesktopBridge, type BridgeAction } from './bridge-client.js'
import {
  exportFileName,
  EXPORT_TAIL_LINES,
  KERNEL_CHANNEL_ENV,
  KERNEL_VERSION_ENV,
  SHELL_VERSION_ENV,
  type LogSection,
} from './diagnostics-facts.js'
import { LOG_DIR_ENV, parseTailLines, readLogTail, type LogTailResult } from './log-tail.js'
import type { HostText } from './host-text.js'
import { passesTrustFence } from './trust-fence.js'

/**
 * This plugin's route prefix. Like the other suite plugins it lives under an
 * `/api` segment inside the plugin's route namespace: the package root belongs
 * to the client-modules loader.
 */
export const ROUTE_PREFIX = '/plugins/@dsh-app/plugin-brand/api'

/**
 * "This environment has no desktop bridge" — the stable answer for a dev run
 * or an older shell. The client renders `route.unsupported` in its own
 * language; the English line is the diagnostic for a reader that does not
 * know the code.
 */
export const UNSUPPORTED_HOST: HostText = {
  code: 'route.unsupported',
  text: 'this environment has no desktop bridge',
}

/**
 * Refusal answer for a request that fails the browser-trust fence (cross-site
 * Origin, or a Host that is not loopback). The dsh page itself never sees it —
 * a browser page cannot read a fenced answer — so the code exists for
 * completeness rather than for the 诊断 page.
 */
export const TRUST_FENCE_HOST: HostText = {
  code: 'route.trustFence',
  text: 'the request did not pass the loopback trust fence',
}

/** The only surface this module needs from the host web server. */
interface WebServerLike {
  register(route: WebRoute): () => void
}

/** Request body cap: the shell's content cap plus JSON overhead. */
const MAX_BODY_BYTES = 8 * 1024 * 1024 + 64 * 1024

/**
 * One forwarded field: name, the label its refusal message names, and the
 * shell's own cap.
 */
interface FieldSpec {
  readonly name: string
  readonly label: string
  readonly max: number
  /** An empty string is a legitimate value for `content` (an empty file). */
  readonly allowEmpty?: boolean
}

const SAVE_TEXT_FIELDS: readonly FieldSpec[] = [
  { name: 'name', label: '文件名', max: 255 },
  { name: 'content', label: '文本内容', max: 8 * 1024 * 1024, allowEmpty: true },
]

/**
 * Per-action forward list. Only the fields named here reach the shell, so a
 * caller cannot smuggle extra properties into the bridge, and the bounds are
 * the shell's own (`src/main/desktop-bridge.ts`) so bad input is refused here
 * with an actionable message instead of traveling one hop to produce another.
 *
 * The labels below are the ONE place this module still writes prose: no client
 * calls these four actions (the 诊断 page uses `open-logs` alone), so their
 * sentences have no dictionary to live in yet. The 诊断 page's own routes
 * above are fully coded.
 */
const FORWARD_FIELDS: Record<BridgeAction, readonly FieldSpec[]> = {
  'open-in-folder': [{ name: 'path', label: '路径', max: 4_096 }],
  notify: [
    { name: 'title', label: '标题', max: 200 },
    { name: 'body', label: '通知内容', max: 1_000 },
  ],
  'save-text-as': SAVE_TEXT_FIELDS,
  'pick-directory': [],
  'open-logs': [],
}

/** Which method each route answers. */
const GET = 'GET'
const POST = 'POST'

const ACTIONS: readonly BridgeAction[] = ['open-in-folder', 'notify', 'save-text-as', 'pick-directory', 'open-logs']

/**
 * Register the plugin's routes.
 * @param webServer - the host web server route registrar (structural: only
 *   `register` is used, which keeps this module testable without a host).
 * @returns the disposer removing every route it registered.
 */
export function registerDesktopRoutes(webServer: WebServerLike): () => void {
  const disposers = [
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/status`,
      handler: (req, res) => { handleStatus(req, res) },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/diagnostics/log-tail`,
      handler: (req, res) => { void handleLogTail(req, res) },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/diagnostics/export`,
      handler: (req, res) => { void handleExport(req, res) },
    }),
    ...ACTIONS.map((action) => webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/desktop/${action}`,
      handler: (req, res) => { void handleAction(req, res, action) },
    })),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Availability probe for the client's settings page. Reads the environment per
 * call (a restarted shell re-injects it), so the answer is live.
 */
function handleStatus(req: IncomingMessage, res: ServerResponse): void {
  if (!passesTrustFence(req)) { fail(res, 403, TRUST_FENCE_HOST); return }
  if (req.method !== GET) { denyMethod(res, GET); return }
  // "Available" means the shell injected a bridge endpoint for this session,
  // not that the shell is healthy: a hung shell still answers true here and
  // reports its own failure from the action route.
  sendJson(res, 200, { ok: true, bridge: bridgeConfigured() })
}

/**
 * The kernel-side half of the diagnostics page: the tail of the newest server
 * log. Reads the environment and the directory per call, so a log directory
 * that appears after boot (or a shell that restarted with a new one) is picked
 * up without a plugin reload.
 */
async function handleLogTail(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!passesTrustFence(req)) { fail(res, 403, TRUST_FENCE_HOST); return }
  if (req.method !== GET) { denyMethod(res, GET); return }

  // Split off the query by hand rather than through `new URL`: the value is a
  // single integer and a malformed request URL must not throw here.
  const query = (req.url ?? '').split('?')[1] ?? ''
  const lines = parseTailLines(new URLSearchParams(query).get('lines'))
  if (lines === undefined) {
    fail(res, 400, { code: 'log.linesInvalid', text: 'the lines parameter must be a positive integer' })
    return
  }

  let outcome: LogTailResult
  try {
    outcome = await readLogTail(process.env[LOG_DIR_ENV], lines)
  } catch {
    // No detail: the path and the errno would name this machine's layout
    // without telling the user anything they can act on.
    fail(res, 500, { code: 'log.readFailed', text: 'the log file could not be read' })
    return
  }
  if (!outcome.ok) {
    if (outcome.reason === 'unsupported') {
      failUnsupported(res)
      return
    }
    fail(res, 404, { code: 'log.fileMissing', text: 'the log directory holds no kernel log file' })
    return
  }
  sendJson(res, 200, { ok: true, path: outcome.file, lines: [...outcome.lines] })
}

/**
 * Publish the diagnostics package's facts.
 *
 * Everything here comes from an allowlist — the three version variables the
 * shell publishes, the log directory, and the newest log's tail. The bridge
 * token is never read on this path, so it cannot be written out even by
 * accident; see `diagnostics-facts.ts`.
 *
 * The host does NOT assemble the file any more: the page that offers the button
 * renders these facts in the UI's own language and hands the text back through
 * `/desktop/save-text-as`. Before that split the file was always Chinese, even
 * for a user running the UI in English.
 *
 * The bridge is still checked BEFORE the log is read: without one there is
 * nowhere for the page to put the file, and a 500-line tail read would be pure
 * work for nothing. The page reads that answer as "export unavailable".
 */
async function handleExport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!passesTrustFence(req)) { fail(res, 403, TRUST_FENCE_HOST); return }
  if (req.method !== POST) { denyMethod(res, POST); return }
  if (!bridgeConfigured()) {
    failUnsupported(res)
    return
  }

  const now = new Date()
  sendJson(res, 200, {
    ok: true,
    name: exportFileName(now),
    generatedAt: now.toISOString(),
    shellVersion: readEnv(SHELL_VERSION_ENV),
    kernelVersion: readEnv(KERNEL_VERSION_ENV),
    kernelChannel: readEnv(KERNEL_CHANNEL_ENV),
    logDir: readEnv(LOG_DIR_ENV),
    logDirEnv: LOG_DIR_ENV,
    log: await collectLogSection(),
  })
}

/**
 * The tail for the export, or the reason there is none. A read failure becomes
 * part of the report instead of an error status: a user reaches for the export
 * precisely when something is broken, and "the log could not be read" is itself
 * a useful line to hand over.
 */
async function collectLogSection(): Promise<LogSection> {
  try {
    const outcome = await readLogTail(process.env[LOG_DIR_ENV], EXPORT_TAIL_LINES)
    if (outcome.ok) return { kind: 'ok', file: outcome.file, lines: outcome.lines }
    return { kind: 'unavailable', reason: outcome.reason }
  } catch {
    // No detail, matching the log-tail route: errno text would describe this
    // machine's layout without telling the user anything they can act on.
    return { kind: 'unavailable', reason: 'unreadable' }
  }
}

/** Read one environment variable, tolerating an unset value. */
function readEnv(name: string): string {
  return process.env[name] ?? ''
}

/** Forward one action, mapping every outcome to the contract above. */
async function handleAction(req: IncomingMessage, res: ServerResponse, action: BridgeAction): Promise<void> {
  if (!passesTrustFence(req)) { fail(res, 403, TRUST_FENCE_HOST); return }
  if (req.method !== POST) { denyMethod(res, POST); return }

  let body: Record<string, unknown>
  try {
    body = await readJsonBody(req)
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === 'payload-too-large'
    fail(res, tooLarge ? 413 : 400, tooLarge
      ? { code: 'route.bodyTooLarge', text: `request body larger than the ${String(MAX_BODY_BYTES)} byte cap` }
      : { code: 'route.invalidJson', text: 'request body is not valid JSON' })
    return
  }

  const validated = validate(action, body)
  if (!validated.ok) {
    sendJson(res, 400, { ok: false, unsupported: false, error: validated.message })
    return
  }

  const outcome = await callDesktopBridge(action, validated.value)
  switch (outcome.kind) {
    case 'ok':
      sendJson(res, 200, { ok: true, ...outcome.payload })
      return
    case 'unsupported':
      // 200 with a flag, not an error status: nothing failed, this environment
      // simply has no desktop bridge. The caller branches on `unsupported`.
      failUnsupported(res)
      return
    case 'invalid':
      fail(res, 400, outcome.host)
      return
    case 'failed':
      fail(res, 502, outcome.host)
      return
  }
}

type Validation =
  | { readonly ok: true; readonly value: Record<string, string> }
  | { readonly ok: false; readonly message: string }

/** Check and narrow the caller's body to exactly the fields the shell accepts. */
function validate(action: BridgeAction, body: Record<string, unknown>): Validation {
  const value: Record<string, string> = {}
  for (const field of FORWARD_FIELDS[action]) {
    const raw = body[field.name]
    if (typeof raw !== 'string') return { ok: false, message: `${field.label}不合法，需要文本` }
    if (raw === '' && field.allowEmpty !== true) return { ok: false, message: `${field.label}不能为空` }
    if (raw.length > field.max) return { ok: false, message: `${field.label}过长（上限 ${field.max} 字符）` }
    value[field.name] = raw
  }
  return { ok: true, value }
}

/** Read and parse the JSON body, capped so a local caller cannot exhaust memory. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
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

/**
 * One failure body for every non-2xx answer. The coded `host` is what the
 * client renders (in its own language); `error` repeats the host's English
 * diagnostic so a reader that does not know the code still gets a line.
 */
function fail(res: ServerResponse, status: number, host: HostText): void {
  sendJson(res, status, { ok: false, unsupported: false, error: host.text ?? host.code, host })
}

/**
 * The "environment cannot do it" answer: 200 with a flag, never an error
 * status, because nothing failed — this run simply has no desktop bridge.
 */
function failUnsupported(res: ServerResponse): void {
  sendJson(res, 200, {
    ok: false,
    unsupported: true,
    error: UNSUPPORTED_HOST.text,
    host: UNSUPPORTED_HOST,
  })
}

/** Refuse a method without leaving the caller guessing which one works. */
function denyMethod(res: ServerResponse, allowed: string): void {
  res.setHeader('Allow', allowed)
  fail(res, 405, { code: 'route.methodOnly', params: { method: allowed }, text: `${allowed} only` })
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}
