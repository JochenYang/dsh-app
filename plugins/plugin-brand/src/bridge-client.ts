/**
 * Client for the shell's desktop bridge — the kernel side of the one hop that
 * can make the shell perform a NATIVE action (`src/main/desktop-bridge.ts` in
 * the APP shell binds it, fences it, and injects its coordinates into the
 * kernel child's environment).
 *
 * Protocol: `POST <url>/bridge/<action>` with `Authorization: Bearer <token>`
 * and a JSON body. Three rules shape this module:
 *
 *   1. Read the environment on EVERY call. A restarted shell re-injects a new
 *      URL and a new per-run token, so a value cached at module load would pin
 *      a dead endpoint and a dead secret for the life of the kernel process.
 *   2. Never send an `Origin` header. The bridge refuses any request carrying
 *      one — that fence is what keeps the app's own renderer and every browser
 *      out — and Node's fetch sends none unless asked.
 *   3. Never surface the token. It is not logged, not echoed in an error, and
 *      redacted out of any downstream message before a caller sees it.
 *
 * A missing environment is not a failure: the shell simply does not set the
 * variables when it could not bind the bridge (a bare `dsh` run, an older
 * shell), which is the stable "this environment has no desktop bridge" case
 * the routes report as `unsupported`.
 */

import type { HostText } from './host-text.js'

/** Injected by the shell's `ensureDesktopBridge` into the kernel child env. */
export const BRIDGE_URL_ENV = 'DSH_APP_BRIDGE_URL'
/** Per-run secret; the shell never persists or logs it. */
export const BRIDGE_TOKEN_ENV = 'DSH_APP_BRIDGE_TOKEN'

/** The actions the bridge exposes. */
export type BridgeAction = 'open-in-folder' | 'notify' | 'save-text-as' | 'pick-directory' | 'open-logs'

/**
 * Deadline for the actions that answer immediately. A shell that accepted the
 * connection but stopped answering must not pin a route forever.
 */
const TIMEOUT_MS = 30_000
/**
 * Deadline for the actions that block on a HUMAN: `save-text-as` and
 * `pick-directory` stay open while the user reads a native dialog. The shell
 * bridge keeps its own connection open for 5 minutes, so this stays below it
 * while leaving room for a slow decision.
 */
const DIALOG_TIMEOUT_MS = 4 * 60_000

/** Longest downstream message a caller is shown. */
const MAX_MESSAGE_CHARS = 300

/**
 * Outcome of one bridge call, deliberately four-way so the route layer can map
 * each to its own status: a caller must be able to tell "this environment has
 * no bridge" from "the action failed".
 *
 * The two failure kinds carry a coded {@link HostText} rather than a sentence:
 * the client owns the language (see `host-text.ts`), and this module's own
 * English diagnostic travels in `host.text`.
 */
export type BridgeOutcome =
  | { readonly kind: 'ok'; readonly payload: Record<string, unknown> }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'invalid'; readonly host: HostText }
  | { readonly kind: 'failed'; readonly host: HostText }

/**
 * Whether the shell injected a bridge endpoint for this session.
 * @returns true when both environment variables are set and non-empty.
 */
export function bridgeConfigured(): boolean {
  return envValue(BRIDGE_URL_ENV) !== '' && envValue(BRIDGE_TOKEN_ENV) !== ''
}

/**
 * Run one action through the shell bridge.
 * @param action - the bridge action to invoke.
 * @param body - already-validated JSON body for that action.
 * @returns the outcome; never throws (a transport failure is `failed`).
 */
export async function callDesktopBridge(action: BridgeAction, body: Record<string, unknown>): Promise<BridgeOutcome> {
  const url = envValue(BRIDGE_URL_ENV)
  const token = envValue(BRIDGE_TOKEN_ENV)
  if (url === '' || token === '') return { kind: 'unsupported' }

  let response: Response
  try {
    response = await fetch(`${url.replace(/\/+$/u, '')}/bridge/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutFor(action)),
    })
  } catch (error) {
    return { kind: 'failed', host: transportHost(error, timeoutFor(action)) }
  }

  const payload = await readPayload(response)
  if (response.ok && payload?.ok === true) {
    const { ok: _ok, ...rest } = payload
    return { kind: 'ok', payload: rest }
  }

  const detail = typeof payload?.error === 'string' ? redact(payload.error, token) : ''
  switch (response.status) {
    case 501:
      // The shell is running but does not offer this action (dev shell, older
      // build): exactly the same stable case as a missing environment.
      return { kind: 'unsupported' }
    case 400:
    case 413:
      return {
        kind: 'invalid',
        host: { code: 'bridge.badRequest', text: `the shell bridge refused the request payload (HTTP ${String(response.status)})` },
      }
    case 401:
    case 403:
      return {
        kind: 'failed',
        host: { code: 'bridge.rejected', text: `the shell bridge refused the caller (HTTP ${String(response.status)})` },
      }
    default:
      // A 500 carries the native action's OWN message (for example
      // `无法打开：…`), which the shell writes in the app's language: it is the
      // actionable detail and travels as a param, because this process cannot
      // translate it and the page keeps its own sentence frame around it.
      // Anything else gets a stable code instead of a raw internal detail.
      return {
        kind: 'failed',
        host: response.status >= 500 && detail !== ''
          ? { code: 'bridge.nativeFailed', params: { detail }, text: `the native action failed (HTTP ${String(response.status)})` }
          : { code: 'bridge.failed', text: `the desktop bridge answered HTTP ${String(response.status)}` },
      }
  }
}

/** Timeout budget for one action. */
function timeoutFor(action: BridgeAction): number {
  return action === 'save-text-as' || action === 'pick-directory' ? DIALOG_TIMEOUT_MS : TIMEOUT_MS
}

/** Read one environment variable, tolerating an unset value. */
function envValue(name: string): string {
  return process.env[name] ?? ''
}

/** Parse a bridge response body without ever throwing on a malformed one. */
async function readPayload(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await response.json()
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** The coded message for a call that never got an answer. */
function transportHost(error: unknown, budgetMs: number): HostText {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return {
      code: 'bridge.timeout',
      params: { seconds: Math.round(budgetMs / 1000) },
      text: `the shell bridge did not answer within ${String(Math.round(budgetMs / 1000))} s`,
    }
  }
  return { code: 'bridge.unreachable', text: 'the shell bridge did not answer' }
}

/**
 * Last-resort guard: a downstream message must never carry the bearer token.
 * The marker is a redaction token inside a diagnostic, not a sentence, so it
 * stays a fixpoint the reader can grep for.
 */
function redact(message: string, token: string): string {
  const scrubbed = token === '' ? message : message.split(token).join('[已隐藏]')
  return scrubbed.length > MAX_MESSAGE_CHARS ? `${scrubbed.slice(0, MAX_MESSAGE_CHARS)}…` : scrubbed
}
