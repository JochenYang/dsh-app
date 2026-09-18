/**
 * Host routes under `/api/plugins/dsh-app/plugin-brand`: the kernel-side doorway
 * through which the app's UI asks for a desktop action (reveal a folder, notify,
 * save-as, pick a directory, reveal logs) and reads the diagnostics facts.
 *
 * The transport is the Connection exact-Fetch registry
 * (`ctx.connection.fetch`), not the dsh web server: under the desktop host the
 * `webserver` row is disabled and every request arrives over the Electron byte
 * pipe, so an `inject: ['webServer']` plugin never activates at all. Route paths
 * are exact, every parameter travels in the query string, and only GET/HEAD/POST
 * exist (a PUT would fall through to the shared channel's own 404).
 *
 * Trust belongs to the carrier: the Connection transport applies its Host/Origin
 * fence and browser authentication before a route handler runs, and the desktop
 * pipe carries no untrusted origin, so a handler never re-checks either. The one
 * hop that authenticates itself is the shell's action route, which the CLIENT
 * calls — see below.
 *
 * Client contract (all bodies JSON; every failure carries a coded `host`
 * message the client renders in its own language):
 *
 *   GET  /status
 *     → 200 `{ ok: true, bridge: boolean }`  — `bridge` answers "can a desktop
 *       action be performed at all in this environment": true when the shell
 *       published its action route (`DSH_APP_SHELL_ACTIONS`), false for a bare
 *       `dsh` run or an older shell. The settings page shows the desktop-feature
 *       status from this without a probe of its own.
 *   POST /desktop/open-in-folder   `{ path }`           → 200 `{ ok: true }`
 *     — served by the KERNEL: `session.openWorkspacePath({ path, action:
 *       'reveal' })` spawns Explorer / Finder / the Linux file manager. No
 *       desktop on this host → 200 `unsupported`.
 *   POST /desktop/pick-directory   `{}`                 → 200 `{ ok: true, path: string | null }`
 *     — served by the KERNEL's `directoryPicker` (`native` backend only).
 *   POST /desktop/notify           `{ title, body }`    → 200 `{ ok: true, delegate: { url, method } }`
 *   POST /desktop/save-text-as     `{ name, content }`  → 200 `{ ok: true, delegate: { url, method } }`
 *   POST /desktop/open-logs        `{}`                 → 200 `{ ok: true, delegate: { url, method } }`
 *   POST /desktop/office-payload-state    `{}`          → 200 `{ ok: true, delegate: { url, method } }`
 *   POST /desktop/office-payload-download `{}`          → 200 `{ ok: true, delegate: { url, method } }`
 *   POST /desktop/office-payload-cancel   `{}`          → 200 `{ ok: true, delegate: { url, method } }`
 *     — the SHELL performs these six, but this process cannot call it: the
 *       route is on the `dsh-app` scheme, which only Electron resolves. So these
 *       routes validate the payload and hand the client the exact coordinates
 *       (`client/diagnostics/api.ts` then calls that URL, which is the seam's
 *       real fence: the shell stamps the initiator and refuses anything that did
 *       not come from the app's own page). See `shell-actions.ts`.
 *       The three payload actions answer `{ ok: true, payload: { supported,
 *       required, installed, phase, progress, error } }` — the settings row
 *       renders that shape, and the download itself reports through repeated
 *       state calls (a payload is ~115 MiB).
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
 *       and hands the text to the shell's `save-text-as` route. The request BODY
 *       is ignored: every fact comes from the environment the shell injected and
 *       from the log files, so there is no caller input to validate.
 *
 *   `path: null` means the user cancelled — a success with no path, never an
 *   error.
 *
 * Failure contract, worded so a caller can tell the two classes apart without
 * parsing prose:
 *
 *   - environment cannot do it (no shell action route published, no kernel
 *     opener/picker, or the log directory is missing/not injected)
 *     → 200 `{ ok: false, unsupported: true, error, host }`, code
 *       `route.unsupported`
 *   - the action itself failed (the native call threw or timed out, a `lines`
 *     value that is not a positive integer, an unreadable log file)
 *     → 400 / 404 / 413 / 500 `{ ok: false, unsupported: false, error, host }`
 *   - unknown path, or a method this route does not declare → the shared
 *     channel's 404 (the registry owns methods, not this module)
 *
 * `host` is the coded message the client renders in its own language
 * (see `host-text.ts`); `error` repeats its English diagnostic so a reader that
 * does not know the code still gets a line. The one exception is the per-field
 * validation of the desktop actions: no client calls them with a bad payload by
 * design, so their labels have no dictionary to live in and stay in this file.
 *
 * @module @dsh-app/plugin-brand/routes
 */

import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import {
  exportFileName,
  EXPORT_TAIL_LINES,
  KERNEL_CHANNEL_ENV,
  KERNEL_VERSION_ENV,
  SHELL_VERSION_ENV,
  type LogSection,
} from './diagnostics-facts.js'
import { LOG_DIR_ENV, parseTailLines, readLogTail, type LogTailResult } from './log-tail.js'
import { pickDirectory, revealInFileManager, type NativeOutcome, type NativeSeams } from './native-actions.js'
import { shellActionUrl, shellActionsAvailable, type ShellAction } from './shell-actions.js'
import type { HostText } from './host-text.js'

/**
 * This plugin's route prefix on the shared `/api` channel. The registry admits
 * only path segments matching `[A-Za-z0-9_$.-]`, so the npm scope's `@` cannot
 * appear in the URL: `@dsh-app/plugin-brand` travels as `dsh-app/plugin-brand`.
 */
export const ROUTE_PREFIX = '/api/plugins/dsh-app/plugin-brand'

/**
 * "This environment has no desktop action route" — the stable answer for a bare
 * `dsh` run or an older shell. The client renders `route.unsupported` in its own
 * language; the English line is the diagnostic for a reader that does not know
 * the code.
 */
export const UNSUPPORTED_HOST: HostText = {
  code: 'route.unsupported',
  text: 'this environment has no desktop action route',
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

/**
 * The actions the SHELL performs, addressed by its own route. `open-in-folder`
 * and `pick-directory` are not here: the kernel performs both itself (see
 * `native-actions.ts`), so there is nothing to delegate.
 *
 * The three `office-payload-*` names are one feature split by gesture — show
 * the state, start the download, stop it. None of them takes a field: which
 * payload version is needed is the shell's own knowledge (the active kernel
 * manifest), so the client cannot ask for a different one than this kernel runs.
 */
const DELEGATED_ACTIONS = [
  'notify',
  'save-text-as',
  'open-logs',
  'office-payload-state',
  'office-payload-download',
  'office-payload-cancel',
] as const satisfies readonly ShellAction[]

/** One of {@link DELEGATED_ACTIONS}. */
type DelegatedAction = (typeof DELEGATED_ACTIONS)[number]

/**
 * Per-action validation for the delegated actions. Only the fields named here
 * are read, and the bounds are the shell's own
 * (`src/main/shell-actions.ts`) so bad input is refused here with an actionable
 * message instead of traveling one hop to produce another.
 *
 * The labels below are the ONE place this module still writes prose: the page
 * sends these actions well-formed by construction, so their sentences have no
 * dictionary to live in yet.
 */
const DELEGATED_FIELDS: Record<DelegatedAction, readonly FieldSpec[]> = {
  notify: [
    { name: 'title', label: '标题', max: 200 },
    { name: 'body', label: '通知内容', max: 1_000 },
  ],
  'save-text-as': [
    { name: 'name', label: '文件名', max: 128 },
    { name: 'content', label: '文本内容', max: 8 * 1024 * 1024, allowEmpty: true },
  ],
  'open-logs': [],
  // The payload actions carry no field at all: the shell reads which payload
  // this kernel needs from the active manifest, so there is nothing for a
  // caller to pass and nothing to validate.
  'office-payload-state': [],
  'office-payload-download': [],
  'office-payload-cancel': [],
}

/** The only desktop action whose body carries a path. */
const OPEN_FOLDER_FIELDS: readonly FieldSpec[] = [{ name: 'path', label: '路径', max: 4_096 }]

/** One search parameter of a request URL, or null when it is absent. */
function searchParam(url: string, name: string): string | null {
  try {
    return new URL(url).searchParams.get(name)
  } catch {
    // A malformed request URL is not worth a status of its own: the value is
    // then simply absent, which every caller already handles.
    return null
  }
}

/**
 * Register the plugin's routes on the Connection exact-Fetch registry.
 *
 * Every route owns its exact path (a parameter rides the query string, never a
 * path segment) and its single method; another method of the same path falls
 * through to the shared channel's own 404 rather than a route body.
 *
 * @param connectionFetch - the Connection exact-Fetch registry (`ctx.connection.fetch`).
 * @param seams - resolvers for the kernel's native-action seams.
 * @returns disposer removing every route it registered.
 */
export function registerDesktopRoutes(
  connectionFetch: HostConnectionFetch,
  seams: NativeSeams,
): () => Promise<void> {
  const disposers = [
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/status`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => handleStatus(),
    }),
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/diagnostics/log-tail`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => handleLogTail(request),
    }),
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/diagnostics/export`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => handleExport(),
    }),
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/desktop/open-in-folder`,
      methods: ['POST'],
      requestBody: 'buffered',
      // `validate` refuses a missing/empty path, so the field is present here.
      fetch: async (request) => handleKernelAction(request, OPEN_FOLDER_FIELDS,
        (value) => revealInFileManager(seams, value.path ?? '')),
    }),
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/desktop/pick-directory`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => handleKernelAction(request, [], () => pickDirectory(seams)),
    }),
    ...DELEGATED_ACTIONS.map((action) => connectionFetch.register({
      path: `${ROUTE_PREFIX}/desktop/${action}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => handleDelegatedAction(request, action),
    })),
  ]
  return async () => {
    for (const dispose of disposers) await dispose()
  }
}

/**
 * Availability probe for the client's settings page. Reads the environment per
 * call (a restarted shell re-publishes its action route), so the answer is live.
 */
function handleStatus(): Response {
  // "Available" means the shell published a desktop action route for this
  // session, not that the shell is healthy: a hung shell is refused by the
  // action route itself, with its own coded answer.
  return sendJson(200, { ok: true, bridge: shellActionsAvailable() })
}

/**
 * The kernel-side half of the diagnostics page: the tail of the newest server
 * log. Reads the environment and the directory per call, so a log directory
 * that appears after boot (or a shell that restarted with a new one) is picked
 * up without a plugin reload.
 */
async function handleLogTail(request: Request): Promise<Response> {
  const lines = parseTailLines(searchParam(request.url, 'lines'))
  if (lines === undefined) {
    return fail(400, { code: 'log.linesInvalid', text: 'the lines parameter must be a positive integer' })
  }

  let outcome: LogTailResult
  try {
    outcome = await readLogTail(process.env[LOG_DIR_ENV], lines)
  } catch {
    // No detail: the path and the errno would name this machine's layout
    // without telling the user anything they can act on.
    return fail(500, { code: 'log.readFailed', text: 'the log file could not be read' })
  }
  if (!outcome.ok) {
    if (outcome.reason === 'unsupported') return failUnsupported()
    return fail(404, { code: 'log.fileMissing', text: 'the log directory holds no kernel log file' })
  }
  return sendJson(200, { ok: true, path: outcome.file, lines: [...outcome.lines] })
}

/**
 * Publish the diagnostics package's facts.
 *
 * Everything here comes from an allowlist — the three version variables the
 * shell publishes, the log directory, and the newest log's tail. Nothing is
 * enumerated from the environment on this path, so a value that is not part of
 * the allowlist (the shell's action URL included) cannot be written out even by
 * accident; see `diagnostics-facts.ts`.
 *
 * The host does NOT assemble the file any more: the page that offers the button
 * renders these facts in the UI's own language and hands the text to the shell's
 * `save-text-as` action. Before that split the file was always Chinese, even
 * for a user running the UI in English.
 *
 * The shell seam is still checked BEFORE the log is read: without one there is
 * nowhere for the page to put the file, and a 500-line tail read would be pure
 * work for nothing. The page reads that answer as "export unavailable".
 */
async function handleExport(): Promise<Response> {
  if (!shellActionsAvailable()) return failUnsupported()

  const now = new Date()
  return sendJson(200, {
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

/**
 * One kernel-performed action: read the body, validate this action's fields,
 * run the seam, map its outcome to the failure contract.
 * @param request - the POST carrying the action's fields.
 * @param fields - the fields this action accepts (empty for a pathless one).
 * @param run - the seam call, given the validated fields.
 */
async function handleKernelAction(
  request: Request,
  fields: readonly FieldSpec[],
  run: (value: Record<string, string>) => Promise<NativeOutcome>,
): Promise<Response> {
  const body = await readActionBody(request)
  if (!body.ok) return body.response

  const validated = validate(fields, body.value)
  if (!validated.ok) return sendJson(400, { ok: false, unsupported: false, error: validated.message })

  const outcome = await run(validated.value)
  switch (outcome.kind) {
    case 'ok':
      return sendJson(200, { ok: true, ...outcome.payload })
    case 'unsupported':
      // 200 with a flag, not an error status: nothing failed, this environment
      // simply cannot perform the action. The caller branches on `unsupported`.
      return failUnsupported()
    case 'failed':
      return fail(502, outcome.host)
  }
}

/**
 * One delegated action: read the body, validate this action's fields, and answer
 * the coordinates the CLIENT must call.
 *
 * Nothing is performed here, and that is the whole shape of this hop: the shell's
 * action route lives on the `dsh-app` scheme, which this process cannot resolve
 * (see `shell-actions.ts`), so the call has to come from the page — which is
 * already in that origin. What this route guarantees before handing the client
 * anywhere is that the environment HAS such a route and that the payload is
 * shaped the way the shell accepts it.
 */
async function handleDelegatedAction(request: Request, action: DelegatedAction): Promise<Response> {
  const body = await readActionBody(request)
  if (!body.ok) return body.response

  const validated = validate(DELEGATED_FIELDS[action], body.value)
  if (!validated.ok) return sendJson(400, { ok: false, unsupported: false, error: validated.message })

  if (!shellActionsAvailable()) {
    // 200 with a flag, not an error status: nothing failed — this environment
    // simply has no desktop actions. The caller branches on `unsupported`.
    return failUnsupported()
  }
  // The exact URL, not a path the client could get wrong: the shell publishes
  // it, this process never re-derives it, and the page calls it from the origin
  // that URL belongs to.
  return sendJson(200, { ok: true, delegate: { url: shellActionUrl(action), method: 'POST' } })
}

/** One parsed request body, or the response that refuses it. */
type BodyOutcome =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response }

/** Read and parse the JSON body, mapping every failure to its status. */
async function readActionBody(request: Request): Promise<BodyOutcome> {
  try {
    return { ok: true, value: await readJsonBody(request) }
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === 'payload-too-large'
    return {
      ok: false,
      response: fail(tooLarge ? 413 : 400, tooLarge
        ? { code: 'route.bodyTooLarge', text: `request body larger than the ${String(MAX_BODY_BYTES)} byte cap` }
        : { code: 'route.invalidJson', text: 'request body is not valid JSON' }),
    }
  }
}

type Validation =
  | { readonly ok: true; readonly value: Record<string, string> }
  | { readonly ok: false; readonly message: string }

/** Check and narrow the caller's body to exactly the fields the action accepts. */
function validate(fields: readonly FieldSpec[], body: Record<string, unknown>): Validation {
  const value: Record<string, string> = {}
  for (const field of fields) {
    const raw = body[field.name]
    if (typeof raw !== 'string') return { ok: false, message: `${field.label}不合法，需要文本` }
    if (raw === '' && field.allowEmpty !== true) return { ok: false, message: `${field.label}不能为空` }
    if (raw.length > field.max) return { ok: false, message: `${field.label}过长（上限 ${field.max} 字符）` }
    value[field.name] = raw
  }
  return { ok: true, value }
}

/**
 * Read and parse the JSON body, capped so a caller cannot exhaust memory. The
 * carrier has already buffered the body (the route declares
 * `requestBody: 'buffered'`) under the channel's own — much larger — cap, so
 * this route limit is checked before parsing rather than while streaming.
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
 * One failure body for every non-2xx answer. The coded `host` is what the
 * client renders (in its own language); `error` repeats the host's English
 * diagnostic so a reader that does not know the code still gets a line.
 */
function fail(status: number, host: HostText): Response {
  return sendJson(status, { ok: false, unsupported: false, error: host.text ?? host.code, host })
}

/**
 * The "environment cannot do it" answer: 200 with a flag, never an error
 * status, because nothing failed — this run simply has no desktop actions.
 */
function failUnsupported(): Response {
  return sendJson(200, {
    ok: false,
    unsupported: true,
    error: UNSUPPORTED_HOST.text,
    host: UNSUPPORTED_HOST,
  })
}

function sendJson(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
