/**
 * The diagnostics page's view of plugin-brand's host routes.
 *
 * Every call goes over the normal dsh API seam (`fetch` against the server
 * that served this page), so there is no preload, no IPC and no second
 * transport. The brand routes answer with their own envelope — `{ ok: true,
 * … }`, `{ ok: false, unsupported: true, … }` or `{ ok: false, error }` —
 * rather than the remotes `{ ok, value }` wrapper, and the three cases stay
 * distinct all the way to the caller: "this environment cannot do it" is a
 * normal state the page explains, not an error the page throws.
 *
 * Messages cross this boundary as a {@link RouteNotice}: the host's user-facing
 * messages arrive as a coded {@link HostText} (it never sends prose — see
 * plugin-brand's `src/host-text.ts`), and this page's dictionary owns the
 * wording. Text the wire carries verbatim is only ever a diagnostic, and this
 * module's own fallbacks are dictionary keys the page resolves through its `t`
 * seat. Nothing here builds a sentence, so the transport stays free of both
 * React and locale state.
 *
 * @module @dsh-app/plugin-client-ui/client/diagnostics/api
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS, type DiagnosticsKey } from './locales.ts'

/** plugin-brand's route prefix (its host half owns these paths). */
export const BRAND_API = '/plugins/@dsh-app/plugin-brand/api'

/** Lines read per tail request — the route's own default. */
export const TAIL_LINES = 200

/** Key of the local answer for "this environment has no desktop bridge". */
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

/** `GET /status`: whether the shell injected a bridge for this session. */
export interface BrandStatus extends RouteEnvelope {
  readonly bridge?: boolean
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

/** `POST /desktop/save-text-as`: where the file landed, null when cancelled. */
export interface SaveAnswer extends RouteEnvelope {
  readonly path?: string | null
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
    // The host's "no desktop bridge" is exactly the condition this page's own
    // unsupported answer describes, so both render the same sentence.
    'route.unsupported': t('diag.message.unsupported'),
    'route.trustFence': t('diag.host.trustFence'),
    'route.methodOnly': t('diag.host.methodOnly', { method: String(params.method ?? '') }),
    'log.linesInvalid': t('diag.host.linesInvalid'),
    'log.readFailed': t('diag.host.logReadFailed'),
    'log.fileMissing': t('diag.host.logFileMissing'),
    'route.bodyTooLarge': t('diag.host.bodyTooLarge'),
    'route.invalidJson': t('diag.host.invalidJson'),
    'bridge.badRequest': t('diag.host.bridgeBadRequest'),
    'bridge.rejected': t('diag.host.bridgeRejected'),
    'bridge.failed': t('diag.host.bridgeFailed'),
    'bridge.timeout': t('diag.host.bridgeTimeout'),
    'bridge.unreachable': t('diag.host.bridgeUnreachable'),
    // The shell's own message — it localizes its own half — is the actionable
    // detail, so it arrives as a param and this page only frames it.
    'bridge.nativeFailed': t('diag.host.nativeDetail', { detail: String(params.detail ?? '') }),
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

/** `GET /status` — the desktop bridge availability probe. */
export function fetchBrandStatus(): Promise<RouteOutcome<BrandStatus>> {
  return callBrandRoute<BrandStatus>('/status')
}

/** `GET /diagnostics/log-tail` — the newest server log's tail. */
export function fetchLogTail(lines: number = TAIL_LINES): Promise<RouteOutcome<LogTail>> {
  return callBrandRoute<LogTail>(`/diagnostics/log-tail?lines=${String(lines)}`)
}

/** `POST /desktop/open-logs` — ask the shell to reveal its log directory. */
export function openLogDirectory(): Promise<RouteOutcome<RouteEnvelope>> {
  // The action routes read a JSON body, so an empty object is the request: a
  // body-less POST would be refused as malformed before reaching the shell.
  return callBrandRoute<RouteEnvelope>('/desktop/open-logs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
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
 * `POST /desktop/save-text-as` — ask the shell to write `content` where the
 * user points a native save dialog.
 *
 * The host validates both fields against the shell's own caps before forwarding
 * them, so an over-long name or body is refused with a coded message rather
 * than traveling one hop further to fail there.
 *
 * @param name - suggested file name (no directory part).
 * @param content - the file body.
 * @returns `path` is null when the user cancelled — a normal outcome the page
 * stays quiet about, not a failure.
 */
export function saveTextAs(name: string, content: string): Promise<RouteOutcome<SaveAnswer>> {
  return callBrandRoute<SaveAnswer>('/desktop/save-text-as', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, content }),
  })
}
