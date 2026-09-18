/**
 * The diagnostics page's view of plugin-brand's host routes.
 *
 * Every call goes over the normal dsh API seam (`fetch` against the server that
 * served this page), so there is no preload, no IPC and no second transport —
 * with one deliberate exception: the three actions the SHELL performs
 * (`open-logs`, `notify`, `save-text-as`) live on the app's own origin, which is
 * this page's origin too, so this module calls them DIRECTLY with the URL the
 * host hands back. The kernel child cannot make that call (a custom scheme is
 * resolved by Electron's network stack, not by Node), which is why the call is
 * the page's job; the shell fences it by stamping the initiator (see
 * `src/main/shell-actions.ts` in the app).
 *
 * The brand routes answer with their own envelope — `{ ok: true, … }`,
 * `{ ok: false, unsupported: true, … }` or `{ ok: false, error }` — rather than
 * the remotes `{ ok, value }` wrapper, and the three cases stay distinct all the
 * way to the caller: "this environment cannot do it" is a normal state the page
 * explains, not an error the page throws.
 *
 * Messages cross this boundary as a {@link RouteNotice}: the host's user-facing
 * messages arrive as a coded {@link HostText} (it never sends prose — see
 * plugin-brand's `src/host-text.ts`), and this page's dictionary owns the
 * wording. The shell's action route is the one writer that localizes ITS own
 * half (`shared/locale.ts`): it answers a stable code plus its own sentence, and
 * this page keys its copy on the code, falling back to that sentence for a code
 * this build does not know. Text the wire carries verbatim is only ever a
 * diagnostic, and this module's own fallbacks are dictionary keys the page
 * resolves through its `t` seat. Nothing here builds a sentence, so the
 * transport stays free of both React and locale state.
 *
 * @module @dsh-app/plugin-client-ui/client/diagnostics/api
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS, type DiagnosticsKey } from './locales.ts'

/**
 * plugin-brand's route prefix (its host half owns these paths; the Connection
 * carrier serves the suite's plugins under `/api/plugins/dsh-app/<plugin>`).
 */
export const BRAND_API = '/api/plugins/dsh-app/plugin-brand'

/**
 * The only origin the shell's action route can live on. The host validates the
 * URL it publishes; this page re-checks it before sending anything, so a value
 * that was tampered with in between cannot turn the user's diagnostics file into
 * a request to somewhere else.
 */
const SHELL_ACTION_ORIGIN = 'dsh-app://app/'

/** Lines read per tail request — the route's own default. */
export const TAIL_LINES = 200

/** Key of the local answer for "this environment has no desktop actions". */
const UNSUPPORTED_KEY = 'diag.message.unsupported' satisfies DiagnosticsKey

/** Key of the local answer shown when the host server cannot be reached at all. */
const UNREACHABLE_KEY = 'diag.message.unreachable' satisfies DiagnosticsKey

/**
 * A user-visible message the host cannot localize.
 *
 * Mirrors plugin-brand's `HostText` structurally on purpose: a suite plugin
 * bundles standalone (esbuild, no cross-plugin imports), so the shape is
 * repeated rather than imported. The host sends a stable code plus the values
 * its sentence interpolates; `text` is its ENGLISH diagnostic, used only for a
 * code this build does not know.
 */
export interface HostText {
  readonly code: string
  readonly params?: Readonly<Record<string, string | number>>
  /** English developer-facing fallback; shown only for an unknown code. */
  readonly text?: string
}

/** Shared envelope of every brand route answer. */
interface RouteEnvelope {
  readonly ok?: boolean
  readonly unsupported?: boolean
  readonly error?: string
  /** The coded message to render; absent only on a host that predates it. */
  readonly host?: HostText
}

/** `GET /status`: whether this environment can perform desktop actions at all. */
export interface BrandStatus extends RouteEnvelope {
  /** True when the shell published its desktop action route for this session. */
  readonly bridge?: boolean
}

/**
 * `POST /desktop/<action>` for the three actions the SHELL performs: the host's
 * answer names where the page must send them.
 */
export interface DelegateAnswer extends RouteEnvelope {
  readonly delegate?: { readonly url?: string, readonly method?: string }
}

/**
 * What the shell's action route answers. `ok` plus a path (null when the user
 * cancelled) on success; a stable code plus the shell's own sentence on failure.
 */
export interface ShellActionAnswer extends RouteEnvelope {
  readonly code?: string
  readonly message?: string
  readonly path?: string | null
}

/** `GET /diagnostics/log-tail`: one log file's tail. */
export interface LogTail extends RouteEnvelope {
  readonly path?: string
  readonly lines?: readonly string[]
}

/**
 * `POST /diagnostics/export`: the FACTS behind the package. The host does not
 * build the file — this page renders it (see `report.ts`) and then asks the
 * shell to save it through `/desktop/save-text-as`.
 */
export interface ExportFactsAnswer extends RouteEnvelope {
  readonly name?: string
  readonly generatedAt?: string
  readonly shellVersion?: string
  readonly kernelVersion?: string
  readonly kernelChannel?: string
  readonly logDir?: string
  readonly log?: { readonly kind?: string, readonly file?: string, readonly lines?: readonly string[], readonly reason?: string }
}

/**
 * `POST /desktop/save-text-as`: where the file landed, null when cancelled.
 */
export interface SaveAnswer extends RouteEnvelope {
  readonly path?: string | null
}

/**
 * One shell answer about the office payload (state, download, cancel).
 *
 * The shell owns the shape — see `OfficePayloadStatus` in
 * `src/kernel/office-payload.ts`: `supported` says whether this kernel declares
 * a payload at all, `required` is the version it needs, `installed` the version
 * on disk that satisfies it, and `phase`/`progress` carry the download.
 */
export interface OfficePayloadState {
  readonly supported?: boolean
  readonly required?: string | null
  readonly installed?: string | null
  readonly phase?: 'idle' | 'downloading' | 'installing' | 'failed'
  readonly progress?: number | null
  readonly error?: { readonly code?: string, readonly message?: string } | null
}

/** `POST /desktop/office-payload-*`: the payload's state. */
export interface OfficePayloadAnswer extends RouteEnvelope {
  readonly payload?: OfficePayloadState
}

/**
 * One message the page shows: a key of this page's dictionary, a coded message
 * from the host (rendered through the same dictionary), or text the wire
 * carries verbatim (an English diagnostic, or a bare `HTTP 500`).
 */
export type RouteNotice =
  | { readonly source: 'key'; readonly key: DiagnosticsKey }
  | { readonly source: 'host'; readonly host: HostText }
  | { readonly source: 'text'; readonly text: string }

/** The "no answer at all" fallback, exported for callers that must substitute it. */
export const UNREACHABLE_NOTICE: RouteNotice = { source: 'key', key: UNREACHABLE_KEY }

/**
 * Render one coded host message.
 *
 * The host never sends prose for anything the user reads (see {@link HostText}):
 * it sends a code plus the values the sentence interpolates, and the copy is
 * the dictionary's. `text` is the host's own English diagnostic and is used
 * only for a code this build does not know, so a newer kernel beside an older
 * UI degrades to a readable line instead of a blank notice.
 *
 * @param host - the coded message the route answered with.
 * @param t - the page's namespace-bound translate seat.
 * @returns the copy of the active locale, or '' when the code is unknown and
 * the host sent no diagnostic.
 */
function hostMessage(host: HostText, t: TranslateNS<typeof NS>): string {
  const params = host.params ?? {}
  const copy: Readonly<Record<string, string>> = {
    // The host's "no desktop actions here" is exactly the condition this page's
    // own unsupported answer describes, so both render the same sentence.
    'route.unsupported': t('diag.message.unsupported'),
    'route.trustFence': t('diag.host.trustFence'),
    'route.methodOnly': t('diag.host.methodOnly', { method: String(params.method ?? '') }),
    'log.linesInvalid': t('diag.host.linesInvalid'),
    'log.readFailed': t('diag.host.logReadFailed'),
    'log.fileMissing': t('diag.host.logFileMissing'),
    'route.bodyTooLarge': t('diag.host.bodyTooLarge'),
    'route.invalidJson': t('diag.host.invalidJson'),
    // The kernel's own native actions (open-in-folder, pick-directory) answer
    // with the native layer's sentence as a param — it is the actionable detail
    // and this page only frames it.
    'native.failed': t('diag.host.nativeDetail', { detail: String(params.detail ?? '') }),
    'native.timeout': t('diag.host.actionTimeout', { seconds: String(params.seconds ?? '') }),
    // The shell's action route (its codes are its own locale keys).
    'shellAction.forbidden': t('diag.host.actionForbidden'),
    'shellAction.unknown': t('diag.host.actionUnknown'),
    'shellAction.method': t('diag.host.actionMethod'),
    'shellAction.params': t('diag.host.actionParams'),
    'shellAction.tooLarge': t('diag.host.bodyTooLarge'),
    'shellAction.failed': t('diag.host.actionFailed'),
    // The office-payload actions (`office-payload-state|download|cancel`). Their
    // codes are the shell's locale keys; these are the same conditions in this
    // page's own wording, and the shell's sentence is the fallback.
    'officePayload.artifactMissing': t('diag.payload.errorMissing'),
    'officePayload.manifestMismatch': t('diag.payload.errorMismatch'),
    'officePayload.downloadFailed': t('diag.payload.errorDownload'),
    'officePayload.installFailed': t('diag.payload.errorInstall'),
  }
  return copy[host.code] ?? host.text ?? ''
}

/**
 * Render a notice in the active locale.
 * @param notice - the classified message.
 * @param t - the page's namespace-bound translate seat.
 * @returns the display text.
 */
export function noticeText(notice: RouteNotice, t: TranslateNS<typeof NS>): string {
  if (notice.source === 'key') return t(notice.key)
  if (notice.source === 'host') return hostMessage(notice.host, t)
  return notice.text
}

/**
 * Outcome of one route call, split so the page can react to each case. */
export type RouteOutcome<T> =
  | { readonly kind: 'ok'; readonly body: T }
  | { readonly kind: 'unsupported'; readonly notice: RouteNotice }
  | { readonly kind: 'failed'; readonly notice: RouteNotice }

/**
 * Attach the route's diagnostic to a coded message that carries none.
 *
 * A newer kernel can legitimately send a code this build does not know; the
 * notice would then render as an empty string, which reads as a broken page
 * rather than as an unknown failure. The envelope's `error` line, and failing
 * that the HTTP status, is always a usable diagnostic.
 *
 * @param host - the coded message the route answered with.
 * @param error - the envelope's `error` field.
 * @param status - the HTTP status of the answer.
 * @returns the host message, with `text` filled in when it was missing.
 */
function withDiagnostic(host: HostText, error: unknown, status: number): HostText {
  if (host.text !== undefined && host.text !== '') return host
  if (typeof error === 'string' && error !== '') return { ...host, text: error }
  return { ...host, text: `HTTP ${String(status)}` }
}

/**
 * Call one brand route and classify the answer.
 * @param pathname - route path below {@link BRAND_API}, query included.
 * @param init - fetch options (method, body).
 * @returns the outcome; never throws — an unreachable host server is `failed`.
 */
export async function callBrandRoute<T extends RouteEnvelope>(
  pathname: string,
  init?: RequestInit,
): Promise<RouteOutcome<T>> {
  let response: Response
  try {
    response = await fetch(`${BRAND_API}${pathname}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
    })
  } catch {
    return { kind: 'failed', notice: UNREACHABLE_NOTICE }
  }
  let body: T
  try {
    body = await response.json() as T
  } catch {
    // A truncated or non-JSON answer is a transport-level problem, and the
    // status is the only actionable thing left to show.
    return { kind: 'failed', notice: { source: 'text', text: `HTTP ${String(response.status)}` } }
  }
  if (body.unsupported === true) {
    // "This environment cannot do it" is a normal state, not an error: the
    // host's own code (when it sent one) describes it, else this page's key.
    return {
      kind: 'unsupported',
      notice: body.host !== undefined
        ? { source: 'host', host: withDiagnostic(body.host, body.error, response.status) }
        : { source: 'key', key: UNSUPPORTED_KEY },
    }
  }
  if (!response.ok || body.ok !== true) {
    // The coded message wins; the plain `error` string is the host's English
    // diagnostic and is only shown by a host that predates the code.
    return {
      kind: 'failed',
      notice: body.host !== undefined
        ? { source: 'host', host: withDiagnostic(body.host, body.error, response.status) }
        : { source: 'text', text: typeof body.error === 'string' && body.error !== '' ? body.error : `HTTP ${String(response.status)}` },
    }
  }
  return { kind: 'ok', body }
}

/**
 * Call one action on the SHELL's route — the page is the caller because this
 * route lives in the page's own origin.
 *
 * @param url - the URL the host handed back (already checked to be the app's).
 * @param body - the action's JSON body, shaped exactly like the plugin route's.
 * @returns the outcome; never throws — a route that does not answer is `failed`.
 */
async function callShellAction<T extends ShellActionAnswer>(url: string, body: unknown): Promise<RouteOutcome<T>> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    })
  } catch {
    return { kind: 'failed', notice: UNREACHABLE_NOTICE }
  }
  let answer: ShellActionAnswer
  try {
    answer = await response.json() as ShellActionAnswer
  } catch {
    return { kind: 'failed', notice: { source: 'text', text: `HTTP ${String(response.status)}` } }
  }
  if (!response.ok || answer.ok !== true) {
    // The shell localizes its own half and answers a stable code with it: this
    // page renders its copy for a code it knows, and the shell's sentence for
    // one it does not (see {@link hostMessage}).
    const code = typeof answer.code === 'string' ? answer.code : ''
    const text = typeof answer.message === 'string' && answer.message !== ''
      ? answer.message
      : `HTTP ${String(response.status)}`
    return { kind: 'failed', notice: { source: 'host', host: { code, text } } }
  }
  return { kind: 'ok', body: answer as T }
}

/**
 * The coordinates the host handed back, or the outcome that refused them.
 * Narrowed to the URL alone, so no caller can be tempted to call something the
 * checks below did not pass.
 */
type DelegateOutcome =
  | { readonly kind: 'ok'; readonly url: string }
  | { readonly kind: 'unsupported'; readonly notice: RouteNotice }
  | { readonly kind: 'failed'; readonly notice: RouteNotice }

/**
 * Ask the host where one shell-performed action lives, and refuse an answer that
 * points anywhere but the app.
 *
 * The host validates the URL it publishes; this page re-checks the origin before
 * sending anything to it, so a value tampered with in between cannot turn the
 * user's diagnostics text into a request to somewhere else.
 *
 * @param pathname - the plugin route below {@link BRAND_API}.
 * @param body - the action's fields, validated by the host.
 * @returns the URL to call, or the outcome that refuses it.
 */
async function delegateAction(pathname: string, body: unknown): Promise<DelegateOutcome> {
  const answer = await callBrandRoute<DelegateAnswer>(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (answer.kind !== 'ok') return answer
  const url = answer.body.delegate?.url
  if (typeof url !== 'string' || !url.startsWith(SHELL_ACTION_ORIGIN)) {
    // A host that answered `ok` without usable coordinates is not followable:
    // guessing a path is exactly what this seam's fence exists to prevent.
    return { kind: 'failed', notice: UNREACHABLE_NOTICE }
  }
  return { kind: 'ok', url }
}

/** `GET /status` — the desktop-action availability probe. */
export function fetchBrandStatus(): Promise<RouteOutcome<BrandStatus>> {
  return callBrandRoute<BrandStatus>('/status')
}

/** `GET /diagnostics/log-tail` — the newest server log's tail. */
export function fetchLogTail(lines: number = TAIL_LINES): Promise<RouteOutcome<LogTail>> {
  return callBrandRoute<LogTail>(`/diagnostics/log-tail?lines=${String(lines)}`)
}

/**
 * Ask the shell to reveal its log directory.
 *
 * Two hops, one gesture: the host confirms the environment has a shell action
 * route (and answers `unsupported` when it does not), then this page calls that
 * route — which is the only place the action can be performed from.
 */
export async function openLogDirectory(): Promise<RouteOutcome<RouteEnvelope>> {
  const delegate = await delegateAction('/desktop/open-logs', {})
  if (delegate.kind !== 'ok') return delegate
  // The action routes read a JSON body, so an empty object is the request: a
  // body-less POST would be refused as malformed before reaching the action.
  return callShellAction<RouteEnvelope>(delegate.url, {})
}

/**
 * `POST /diagnostics/export` — collect the facts the package is written from.
 *
 * No body: every fact comes from what the shell injected, so there is nothing
 * for this page to send. The page renders the text (in its own language) and
 * then calls {@link saveTextAs}.
 */
export function fetchExportFacts(): Promise<RouteOutcome<ExportFactsAnswer>> {
  return callBrandRoute<ExportFactsAnswer>('/diagnostics/export', { method: 'POST' })
}

/**
 * Ask the shell to write `content` where the user points a native save dialog.
 *
 * The host validates both fields against the shell's own caps first, so an
 * over-long name or body is refused with a coded message rather than traveling
 * one hop further to fail there; the shell re-validates and, more importantly,
 * decides the path — from the dialog alone.
 *
 * @param name - suggested file name (no directory part).
 * @param content - the file body.
 * @returns `path` is null when the user cancelled — a normal outcome the page
 * stays quiet about, not a failure.
 */
export async function saveTextAs(name: string, content: string): Promise<RouteOutcome<SaveAnswer>> {
  const delegate = await delegateAction('/desktop/save-text-as', { name, content })
  if (delegate.kind !== 'ok') return delegate
  return callShellAction<SaveAnswer>(delegate.url, { name, content })
}

/**
 * One office-payload action: ask the host where the shell performs it, then
 * call that URL. Shared by the three wrappers below, which differ only in the
 * action name — the shell decides everything else (which payload this kernel
 * needs, whether it is installed, whether a transfer is running).
 *
 * @param action - the shell action name below `/desktop/`.
 * @returns the payload state, or the outcome that refused the call.
 */
async function officePayloadAction(action: string): Promise<RouteOutcome<OfficePayloadAnswer>> {
  const delegate = await delegateAction(`/desktop/${action}`, {})
  if (delegate.kind !== 'ok') return delegate
  return callShellAction<OfficePayloadAnswer>(delegate.url, {})
}

/** `POST /desktop/office-payload-state` — the row's read, never touches the network. */
export function fetchOfficePayload(): Promise<RouteOutcome<OfficePayloadAnswer>> {
  return officePayloadAction('office-payload-state')
}

/**
 * `POST /desktop/office-payload-download` — start (or join) the download. It
 * returns the immediate state; the transfer reports through further
 * {@link fetchOfficePayload} calls, because it is ~115 MiB.
 */
export function downloadOfficePayload(): Promise<RouteOutcome<OfficePayloadAnswer>> {
  return officePayloadAction('office-payload-download')
}

/** `POST /desktop/office-payload-cancel` — stop the transfer in flight. */
export function cancelOfficePayload(): Promise<RouteOutcome<OfficePayloadAnswer>> {
  return officePayloadAction('office-payload-cancel')
}
