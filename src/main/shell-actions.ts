/**
 * The shell's own action seam: the three native capabilities a document in the
 * harness UI cannot perform for itself — reveal the log directory, raise a
 * system notification, and save a text file where the user points a native
 * dialog.
 *
 * Why it is NOT a second loopback server (the retired `desktop-bridge.ts`): a
 * listening socket is reachable by every process on the machine. This seam
 * instead rides the `dsh-app` scheme the window already loads, so it binds no
 * port at all and is served by the main process in the same handler that serves
 * the UI.
 *
 * ## The fence (this module is a privilege boundary; read before changing)
 *
 * The route is mounted on the SAME ORIGIN the harness UI is loaded from
 * ({@link APP_ORIGIN}), which is the one property the shell can enforce with the
 * browser rather than with a check of its own:
 *
 *   - Cross-origin reach is refused BY CHROMIUM, before this handler runs. A
 *     fetch from another origin to a second host in this scheme fails with
 *     "Cross origin requests are only supported for protocol schemes: chrome,
 *     chrome-extension, chrome-untrusted, data, http, https" (measured on
 *     Electron 44), and this scheme is deliberately NOT registered as
 *     CORS-enabled — that privilege would make custom-scheme POSTs reach
 *     handlers from any origin in the session (custom-scheme requests are not
 *     preflighted), leaving only an unreadable response as the barrier.
 *   - `Origin` and `Referer` are NOT visible to a `protocol.handle` request
 *     (measured: the handler sees only accept / user-agent / content-type), so
 *     the initiator cannot be read off the request. The shell therefore STAMPS
 *     it: {@link installShellActionStamps} installs a `webRequest` hook that
 *     overwrites three headers on every request below this prefix with values
 *     Chromium knows and the page does not — the initiating frame's URL, the
 *     initiating `webContents` id, and the secret of the last bullet below.
 *     {@link initiatorVerdict} requires the frame to be the app's own origin and
 *     the webContents to be the window this shell currently manages; a request
 *     that never passed the hook carries no stamp and is refused. Any
 *     page-supplied copy of those headers is dropped by the hook.
 *   - The stamp belongs to the TOP frame or to nobody. A frame's document URL
 *     alone says nothing about its origin: a sandboxed iframe has an opaque
 *     origin and yet reports the very URL the window was loaded from, so a rule
 *     that only compares the URL would trust a frame the page itself planted.
 *     Hence `details.frame.parent` must be null — a subframe is left unstamped
 *     and refused. INVARIANT: a document served from {@link APP_ORIGIN} is never
 *     placed in a sandbox frame — or in any other frame (`AGENTS.md` §4).
 *   - The stamp is VERIFIED, not merely present. `webRequest` does not report a
 *     frame for a request a worker makes (measured: such a request reaches the
 *     handler with the page's own header values, untouched), so "the header
 *     exists" cannot be the evidence — the page can write it. The hook therefore
 *     also writes {@link STAMP_HEADER}, a per-process secret minted here and
 *     readable from nowhere else: the page cannot put it on a request, and it
 *     cannot read the headers of the requests it makes. A request that arrives
 *     without it never passed the hook, whatever it claims.
 *
 * Everything else is allowlist and shape: three action names, POST only (so a
 * stray navigation or prefetch cannot fire a native action), an
 * `application/json` body (a `no-cors` caller can only smuggle JSON as
 * `text/plain`, so anything else is a 415), per-field type and
 * length caps, and one byte cap on the body. The write target of `save-text-as`
 * is ONLY ever the path the user picks in the native dialog — the page supplies
 * a suggested base name, which is validated as a bare file name and used for
 * nothing but that suggestion. Failures answer a stable code plus shell copy
 * (the module itself carries no Han characters — see `shared/locale.ts`); the
 * internal detail goes to the shell log, never over the wire.
 *
 * @module dsh-app/main/shell-actions
 */
import { randomBytes } from 'node:crypto'
import type { Session, WebFrameMain } from 'electron'
import { APP_ORIGIN, type DshAppRoute } from './desktop-host'
import { t, type MessageKey } from '../shared/locale'

/**
 * Environment variable the shell publishes to the kernel child. Its VALUE is the
 * base URL of this seam, so the kernel-side plugin (and through it the page)
 * never hardcodes a path: a shell that does not set it has no desktop actions,
 * which is what `plugin-brand`'s status route reports as `bridge: false`.
 */
export const SHELL_ACTIONS_ENV = 'DSH_APP_SHELL_ACTIONS'

/** Path prefix this module owns inside the app host. Never forwarded to the kernel. */
export const SHELL_ACTION_PREFIX = '/__dsh-app/'

/** Prefix the action names hang off. */
export const SHELL_ACTION_ROUTE = `${SHELL_ACTION_PREFIX}action/`

/** Base URL published to the kernel: `dsh-app://app/__dsh-app/action`. */
export const SHELL_ACTIONS_BASE = `${APP_ORIGIN}${SHELL_ACTION_ROUTE.replace(/\/$/u, '')}`

/** Request header carrying the initiating frame's URL. Stamped, never read from the page. */
export const INITIATOR_HEADER = 'x-dsh-app-initiator'
/** Request header carrying the initiating `webContents` id. Stamped likewise. */
export const WINDOW_HEADER = 'x-dsh-app-window'
/** Request header carrying {@link STAMP_SECRET}. Stamped likewise; a page cannot know it. */
export const STAMP_HEADER = 'x-dsh-app-stamp'

/**
 * The secret {@link installShellActionStamps} writes on every request it stamps
 * and {@link initiatorVerdict} requires. It never leaves this process: it is not
 * logged, not sent to the kernel, and not readable from a response — the page
 * therefore cannot put it on a request, which is what turns "a stamp is present"
 * into "the browser's own hook wrote this stamp". Minted once per process.
 */
const STAMP_SECRET = randomBytes(32).toString('hex')

/** Every header this module stamps. A page-supplied copy of any of them is dropped. */
const STAMP_HEADERS = [INITIATOR_HEADER, WINDOW_HEADER, STAMP_HEADER]

/** The action names this seam performs. Anything else is a 404. */
export const SHELL_ACTIONS = ['open-logs', 'notify', 'save-text-as'] as const

/** One of {@link SHELL_ACTIONS}. */
export type ShellAction = (typeof SHELL_ACTIONS)[number]

/** Longest notification title accepted. */
const MAX_TITLE = 200
/** Longest notification body accepted. */
const MAX_BODY = 1_000
/** Longest suggested file name accepted. */
const MAX_NAME = 128
/** Longest file payload accepted, in BYTES (a JS string length would let 8M chars through as 24 MB of UTF-8). */
const MAX_CONTENT_BYTES = 8 * 1024 * 1024
/** Request-body cap: the content cap plus room for the JSON envelope. */
const MAX_REQUEST_BYTES = MAX_CONTENT_BYTES + 64 * 1024

/** Characters Windows refuses in a file name, plus control characters. */
const UNSAFE_NAME = /[\\/:*?"<>|\u0000-\u001f]/u

/**
 * Windows device names. The OS resolves these to a device even with an extension
 * attached, so a save the user confirmed would report success and discard the
 * content; the name before the first dot is therefore refused.
 */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu

/** The native capabilities this seam drives. Injected so the module stays testable without a GUI. */
export interface ShellActionDeps {
  /** Absolute log directory the shell owns (`resolveLogDir()`). */
  logDir(): string
  /** `webContents` id of the window this seam serves, or undefined while none exists. */
  windowId(): number | undefined
  /**
   * Reveal one path in the OS file manager.
   * @returns '' on success, else the platform's own error text (logged, not sent).
   */
  openPath(target: string): Promise<string>
  /** Raise a system notification. */
  notify(title: string, body: string): void
  /**
   * Ask the user where to save the file.
   * @param suggestedName - a validated bare file name.
   * @returns the chosen absolute path, or null when the user cancelled.
   */
  saveAs(suggestedName: string): Promise<string | null>
  /** Write the saved file. */
  writeFile(file: string, text: string): Promise<void>
  /** One shell log line (English, log-only). */
  log?(line: string): void
}

/** Whether a string names one of {@link SHELL_ACTIONS}. */
export function isShellAction(value: string): value is ShellAction {
  return (SHELL_ACTIONS as readonly string[]).includes(value)
}

/**
 * The slice of a `webRequest` request the stamp reads.
 * `Electron.OnBeforeSendHeadersListenerDetails` satisfies it.
 */
interface InitiatorRequest {
  /** The frame that issued the request, absent when no document did. */
  readonly frame?: WebFrameMain | null
  /** `webContents` the request is traveling in. */
  readonly webContentsId?: number
}

/**
 * The document URL a request may be stamped with: the TOP frame's, or null when
 * the request came from a subframe or from no document at all.
 *
 * `frame.parent` is null only for the top frame, and a frame reports the URL it
 * was loaded from whatever its origin ended up being — so this, and not the URL
 * itself, is what separates the app's own page from a frame it embedded.
 *
 * @param details - the request's frame descriptors.
 */
function topFrameUrl(details: InitiatorRequest): string | null {
  try {
    const frame = details.frame ?? null
    if (frame === null || frame.parent !== null) return null
    return frame.url
  } catch {
    // Reading a frame that navigated or was destroyed between the request and
    // this hook throws: such a request is not one the app's page made.
    return null
  }
}

/**
 * Install the initiator stamp on every request below {@link SHELL_ACTION_PREFIX}.
 *
 * `webRequest` runs inside the browser and therefore sees what a protocol
 * handler cannot: which frame, in which `webContents`, issued the request. The
 * values are written AFTER the page's own headers, so a page-supplied copy is
 * replaced rather than trusted — measured: a request carrying
 * `x-dsh-app-initiator: dsh-app://evil` reaches the handler stamped with its real
 * frame URL. Only a request from the window's top frame is stamped, and it also
 * carries {@link STAMP_HEADER}: a subframe leaves with an empty pair and no
 * secret, which {@link initiatorVerdict} refuses.
 *
 * Requests this hook never sees — a worker's (measured: `webRequest` reports no
 * frame for one, and the page's own headers arrive untouched, so the page CAN
 * present the pair itself) — are exactly why the secret exists: it is the one
 * value a caller cannot write for itself.
 *
 * @param session - the session the app window lives in (chromium's default).
 */
export function installShellActionStamps(session: Session): void {
  session.webRequest.onBeforeSendHeaders(
    { urls: [`${APP_ORIGIN}${SHELL_ACTION_PREFIX}*`] },
    (details, callback) => {
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(details.requestHeaders)) {
        const lower = name.toLowerCase()
        if (STAMP_HEADERS.includes(lower)) continue
        headers[name] = value
      }
      // A subframe (or a request no frame issued at all — a worker; `webRequest`
      // reports nothing for one) leaves with no secret and an empty pair, so the
      // verdict refuses it for the caller it is, not for a missing hook.
      const top = topFrameUrl(details)
      headers[INITIATOR_HEADER] = top ?? ''
      headers[WINDOW_HEADER] = top === null ? '-1' : String(details.webContentsId ?? -1)
      if (top !== null) headers[STAMP_HEADER] = STAMP_SECRET
      callback({ requestHeaders: headers })
    },
  )
}

/** The verdict on one request's stamped initiator. */
export interface InitiatorVerdict {
  readonly ok: boolean
  /** Why it was refused; logged by the caller, never sent. */
  readonly reason: string
}

/** `dsh-app://app` taken apart once, for the origin comparisons below. */
const APP_ORIGIN_PARTS = new URL(APP_ORIGIN)

/**
 * Whether a URL string belongs to the app's own origin.
 *
 * Scheme and host are compared rather than `URL.origin`: Node resolves a
 * non-special scheme's origin to the opaque string `null` (the renderer, where
 * the scheme is registered as standard, says `dsh-app://app`), and a check that
 * only holds inside Electron is not a check.
 *
 * @param value - an absolute URL or an `Origin` header value.
 */
export function isAppOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === APP_ORIGIN_PARTS.protocol && url.hostname === APP_ORIGIN_PARTS.hostname
  } catch {
    // An unparsable value is not this origin, and `null` (an opaque origin)
    // lands here too.
    return false
  }
}

/**
 * Decide whether a stamped request came from the app's own page.
 *
 * Every rule fails closed: a stamp the hook did not write (an empty initiator, or
 * a missing {@link STAMP_HEADER} — the secret only this process can put there), a
 * foreign frame origin, or a `webContents` other than the window this shell
 * manages is a refusal. The order is the order of what a log reader needs to tell
 * apart: a subframe is refused for its empty initiator, a request the hook never
 * saw (a worker's) for the secret it cannot carry.
 *
 * `origin`, `referer` and `sec-fetch-site` are deliberately NOT read. A
 * `protocol.handle` request carries none of them (measured — see the module
 * header), so a check on them could only ever be dead weight that reads like a
 * fence; the stamped trio is the whole of it.
 *
 * @param headers - the request headers, stamped or not.
 * @param windowId - the window this seam serves, undefined while none exists.
 * @returns the verdict and, on refusal, the reason to log.
 */
export function initiatorVerdict(headers: Headers, windowId: number | undefined): InitiatorVerdict {
  const stamped = headers.get(INITIATOR_HEADER) ?? ''
  if (stamped === '') return { ok: false, reason: 'no initiator stamp (the hook wrote none for this caller)' }
  if (!isAppOrigin(stamped)) return { ok: false, reason: `initiator ${stamped}` }
  if (headers.get(STAMP_HEADER) !== STAMP_SECRET) {
    return { ok: false, reason: 'no stamp secret (the request did not pass the shell webRequest hook)' }
  }

  const stampedWindow = Number(headers.get(WINDOW_HEADER) ?? '')
  if (windowId === undefined) return { ok: false, reason: 'no app window is open' }
  if (!Number.isInteger(stampedWindow) || stampedWindow !== windowId) {
    return { ok: false, reason: `webContents ${String(stampedWindow)} is not the app window (${String(windowId)})` }
  }
  return { ok: true, reason: '' }
}

/** A parsed JSON body, or the response that refuses it. */
type BodyOutcome =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response }

/**
 * Build the handler the app-host protocol gives every `dsh-app://app/__dsh-app/…`
 * request to. It answers that whole prefix — a path below it that is not an
 * action is a 404 rather than a forward, so nothing the kernel serves can ever
 * hide behind it.
 *
 * @param deps - the native capabilities and the window the fence checks against.
 * @returns the route; null for every request that is not below the prefix.
 */
export function createShellActionHandler(deps: ShellActionDeps): DshAppRoute {
  return async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return null
    }
    if (url.protocol !== 'dsh-app:' || url.hostname !== 'app' || !url.pathname.startsWith(SHELL_ACTION_PREFIX)) return null

    const action = url.pathname.slice(SHELL_ACTION_ROUTE.length)
    if (!url.pathname.startsWith(SHELL_ACTION_ROUTE) || !isShellAction(action)) {
      return fail(404, 'shellAction.unknown')
    }
    if (request.method !== 'POST') return fail(405, 'shellAction.method')

    const verdict = initiatorVerdict(request.headers, deps.windowId())
    if (!verdict.ok) {
      deps.log?.(`[shell-action] refused ${action}: ${verdict.reason}`)
      return fail(403, 'shellAction.forbidden')
    }

    try {
      return await dispatch(action, request, deps)
    } catch (error) {
      // The action's own failure detail is for the log: over the wire it would
      // describe this machine's layout to a caller that cannot act on it.
      deps.log?.(`[shell-action] ${action} failed: ${error instanceof Error ? error.message : String(error)}`)
      return fail(500, 'shellAction.failed')
    }
  }
}

/** Run one allowlisted action. */
async function dispatch(action: ShellAction, request: Request, deps: ShellActionDeps): Promise<Response> {
  switch (action) {
    case 'open-logs': {
      // The body is deliberately not read: nothing about this action depends on
      // it, and a caller cannot make the shell buffer bytes it will not use.
      const dir = deps.logDir()
      const failure = await deps.openPath(dir)
      if (failure !== '') {
        deps.log?.(`[shell-action] open-logs could not open ${dir}: ${failure}`)
        return fail(500, 'shellAction.failed')
      }
      deps.log?.(`[shell-action] open-logs revealed ${dir}`)
      return sendJson(200, { ok: true })
    }
    case 'notify': {
      const body = await readJsonBody(request)
      if (!body.ok) return body.response
      const title = textField(body.value, 'title', MAX_TITLE)
      const text = textField(body.value, 'body', MAX_BODY)
      if (title === null || text === null) return fail(400, 'shellAction.params')
      deps.notify(title, text)
      // The title and body are the caller's content: the log records that a
      // notification was raised, never what it said.
      deps.log?.('[shell-action] notify raised')
      return sendJson(200, { ok: true })
    }
    case 'save-text-as': {
      const body = await readJsonBody(request)
      if (!body.ok) return body.response
      const name = textField(body.value, 'name', MAX_NAME)
      const content = body.value.content
      if (name === null || !isSafeFileName(name) || typeof content !== 'string') return fail(400, 'shellAction.params')
      if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) return fail(413, 'shellAction.tooLarge')
      // The ONLY path this seam ever writes is the one the user picked in the
      // native dialog; `name` is a suggestion it starts from.
      const target = await deps.saveAs(name)
      if (target === null || target === undefined || target === '') return sendJson(200, { ok: true, path: null })
      await deps.writeFile(target, content)
      deps.log?.(`[shell-action] save-text-as wrote ${target}`)
      return sendJson(200, { ok: true, path: target })
    }
    default:
      action satisfies never
      return fail(404, 'shellAction.unknown')
  }
}

/** One string field: present, a string, non-empty and inside its cap. */
function textField(body: Record<string, unknown>, name: string, max: number): string | null {
  const value = body[name]
  if (typeof value !== 'string' || value === '' || value.length > max) return null
  return value
}

/**
 * Whether a suggested file name is a bare, writable name: no path separator, no
 * character Windows refuses, no control character, no trailing dot or space,
 * neither `.` nor `..`, and not a device name (`NUL`, `COM1`, `LPT1.txt`) — a
 * device the OS redirects the write to, which would answer success and keep
 * nothing. It only shapes the dialog's suggestion — the write target still comes
 * from the dialog alone — so the rule is deliberately conservative.
 *
 * @param name - the caller's suggested name.
 */
export function isSafeFileName(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false
  if (UNSAFE_NAME.test(name) || WINDOWS_DEVICE_NAME.test(name)) return false
  return !name.endsWith('.') && !name.endsWith(' ')
}

/**
 * Whether a `content-type` header declares JSON. Only the media type is compared,
 * so `application/json; charset=utf-8` passes while `text/plain` — the content
 * type a `no-cors` caller is limited to — does not. An absent header is a refusal:
 * this seam parses JSON or nothing.
 *
 * @param value - the header as the request delivered it.
 */
function isJsonContentType(value: string | null): boolean {
  if (value === null) return false
  return value.split(';', 1)[0].trim().toLowerCase() === 'application/json'
}

/** Read and parse the JSON body under a byte cap. */
async function readJsonBody(request: Request): Promise<BodyOutcome> {
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return { ok: false, response: fail(415, 'shellAction.contentType') }
  }
  let text: string
  try {
    text = await readCappedBody(request.body)
  } catch {
    return { ok: false, response: fail(413, 'shellAction.tooLarge') }
  }
  if (text === '') return { ok: false, response: fail(400, 'shellAction.params') }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, response: fail(400, 'shellAction.params') }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, response: fail(400, 'shellAction.params') }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

/**
 * Read a request body, refusing anything past the cap instead of buffering it.
 * `content-length` is only a hint (it can be absent or lie), so the counter
 * applies to the bytes actually read.
 *
 * @param stream - the request body, or null when there is none.
 * @throws when the body exceeds {@link MAX_REQUEST_BYTES}.
 */
async function readCappedBody(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (stream === null) return ''
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error('request body too large')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

/**
 * One failure answer: a stable code plus the shell's copy for it. The code is
 * the locale key, so a client can branch on it without reading prose.
 */
function fail(status: number, key: MessageKey, params?: Record<string, string>): Response {
  return sendJson(status, { ok: false, code: key, message: t(key, params) })
}

function sendJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
