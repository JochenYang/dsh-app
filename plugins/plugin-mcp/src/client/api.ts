/**
 * The MCP page's view of its host half's routes, plus the failure currency the
 * page renders.
 *
 * Every call goes over the normal dsh API seam (`fetch` against the Connection
 * `/api` channel the window's own origin serves), so there is no preload, no
 * IPC and no second transport. The host never sends prose for anything the user
 * reads (see `HostText` in ../wire.ts): it sends a stable code plus the values
 * its sentence interpolates, and {@link hostMessage} renders this page's copy
 * for it. A failure is therefore a {@link Failure}: a key of this page's
 * dictionary, a coded message that renders through that same dictionary, or
 * text written elsewhere (a bare `HTTP 500`) shown as it arrived. Nothing here
 * builds a sentence, so the transport stays free of both React and locale
 * state.
 *
 * @module @dsh-app/plugin-mcp/client/api
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { McpValidationError, type HostText } from '../wire.ts'
import { NS, type McpKey } from './locales.ts'

/**
 * This plugin's route prefix (its host half owns these paths). The Connection
 * registry admits no `@` in a path segment, so the npm scope travels as
 * `dsh-app`.
 */
export const ROUTE = '/api/plugins/dsh-app/plugin-mcp'

/**
 * Copy for the host codes this build knows, keyed by the code itself. The
 * convention is the code with its namespace dot folded into the key
 * (`entry.badId` → `mcp.host.entryBadId`).
 *
 * One kind of code is deliberately absent: `mount.failed` carries the kernel
 * loader's opaque diagnostic as its whole message, so the host's English `text`
 * IS the message and {@link hostMessage} renders it, never a blank.
 */
const HOST_KEYS: Readonly<Record<string, McpKey>> = {
  'entry.notObject': 'mcp.host.entryNotObject',
  'entry.badId': 'mcp.host.entryBadId',
  'serverName.invalid': 'mcp.host.serverNameInvalid',
  'serverName.pattern': 'mcp.host.serverNamePattern',
  'serverName.duplicate': 'mcp.host.serverNameDuplicate',
  'transport.invalid': 'mcp.host.transportInvalid',
  'stdio.commandRequired': 'mcp.host.stdioCommandRequired',
  'stdio.argsNotArray': 'mcp.host.stdioArgsNotArray',
  'stdio.cwdRequired': 'mcp.host.stdioCwdRequired',
  'http.urlInvalid': 'mcp.host.httpUrlInvalid',
  'timeout.notPositive': 'mcp.host.timeoutNotPositive',
  'field.keyValue': 'mcp.host.fieldKeyValue',
  'field.stringValue': 'mcp.host.fieldStringValue',
  'json.parseFailed': 'mcp.host.jsonParseFailed',
  'json.notObject': 'mcp.host.jsonNotObject',
  'json.noServers': 'mcp.host.jsonNoServers',
  'json.serverNotObject': 'mcp.host.jsonServerNotObject',
  'type.sse': 'mcp.host.typeSse',
  'type.unknown': 'mcp.host.typeUnknown',
  'server.noConnectionField': 'mcp.host.serverNoConnectionField',
  'server.missingCommand': 'mcp.host.serverMissingCommand',
  'server.argsNotArray': 'mcp.host.serverArgsNotArray',
  'server.fieldKeyValue': 'mcp.host.serverFieldKeyValue',
  'server.fieldStringValue': 'mcp.host.serverFieldStringValue',
  'server.missingUrl': 'mcp.host.serverMissingUrl',
  'server.urlNotHttp': 'mcp.host.serverUrlNotHttp',
  'server.timeoutNotPositive': 'mcp.host.serverTimeoutNotPositive',
  'server.notFound': 'mcp.host.serverNotFound',
  'secret.masked': 'mcp.host.secretMasked',
  'route.disabled': 'mcp.host.routeDisabled',
  'route.writeFailed': 'mcp.host.writeFailed',
  'route.bodyTooLarge': 'mcp.host.bodyTooLarge',
  'route.invalidBody': 'mcp.host.invalidBody',
  'import.writeFailed': 'mcp.host.importWriteFailed',
  'mount.unavailable': 'mcp.host.mountUnavailable',
  'env.inlineRef': 'mcp.host.envInlineRef',
  'env.missing': 'mcp.host.envMissing',
}

/**
 * Render one coded host message.
 * @param value - the host's message.
 * @param t - the page's namespace-bound translate seat.
 * @param fallback - line to show when the code has no copy here and the host
 *   sent no diagnostic; the code itself is the final net, so a message from a
 *   newer kernel degrades to readable text rather than a blank banner.
 * @returns the copy of the active locale.
 */
export function hostMessage(value: HostText, t: TranslateNS<typeof NS>, fallback?: string): string {
  const key = HOST_KEYS[value.code]
  return (key === undefined ? undefined : t(key, value.params)) ?? value.text ?? fallback ?? value.code
}

/**
 * Render a list of coded host messages. The host deliberately does not join
 * them: the separator between two warnings is part of the language.
 * @param values - the host's messages, in the order it listed them.
 * @param t - the page's namespace-bound translate seat.
 * @returns the joined display text; '' when there is nothing worth showing.
 */
export function hostListText(values: readonly HostText[], t: TranslateNS<typeof NS>): string {
  return values
    .map(value => hostMessage(value, t))
    .filter(text => text !== '')
    .join(t('mcp.warnSeparator'))
}

/**
 * One failure the page shows: a key of this page's dictionary with its
 * template params, a coded message (the host answered with one, or the wire
 * parser threw one in this process), or text written elsewhere and shown as it
 * arrived.
 */
export type Failure =
  | { readonly source: 'key'; readonly key: McpKey; readonly params?: Record<string, unknown> }
  | { readonly source: 'host'; readonly host: HostText; readonly fallback: string }
  | { readonly source: 'text'; readonly text: string }

/**
 * Render a failure in the active locale.
 * @param failure - the classified message.
 * @param t - the page's namespace-bound translate seat.
 * @returns the display text.
 */
export function failureText(failure: Failure, t: TranslateNS<typeof NS>): string {
  switch (failure.source) {
    case 'key':
      return t(failure.key, failure.params)
    case 'host':
      return hostMessage(failure.host, t, failure.fallback)
    case 'text':
      return failure.text
  }
}

/** An error thrown by this page's own validation, carrying the display form. */
export class PageError extends Error {
  /** What the banner shows; the message is only a readable stand-in for logs. */
  readonly failure: Failure

  /** @param failure - the classified message to show. */
  constructor(failure: Failure) {
    super(failure.source === 'key' ? failure.key : failure.source === 'text' ? failure.text : failure.host.code)
    this.failure = failure
  }
}

/** A failure carrying the host's coded message, when the answer had one. */
class HostError extends Error {
  /**
   * @param host - the coded message the host sent, when it sent one.
   * @param fallback - the line to show when it did not: the host's own plain
   *   `message`, or a bare `HTTP 500` from the transport.
   */
  constructor(readonly host: HostText | undefined, fallback: string) {
    super(fallback)
  }
}

/**
 * Classify anything thrown into a {@link Failure}: this page's own
 * pre-classified errors keep their classification, a coded host message keeps
 * its code, and everything else (a network error) is shown as written.
 * @param cause - the caught value.
 * @returns the classified message.
 */
export function failureOf(cause: unknown): Failure {
  if (cause instanceof PageError) return cause.failure
  if (cause instanceof HostError && cause.host !== undefined) {
    return { source: 'host', host: cause.host, fallback: cause.message }
  }
  // The wire parser is imported by BOTH halves — the JSON editor validates in
  // this process before posting — so its coded rejection is the same currency
  // as a code that arrived over the wire.
  if (cause instanceof McpValidationError) {
    return { source: 'host', host: cause.hostText(), fallback: cause.code }
  }
  return { source: 'text', text: cause instanceof Error ? cause.message : String(cause) }
}

/**
 * Call one route and unwrap the `{ ok, value }` envelope.
 * @param path - route path below {@link ROUTE}, query included.
 * @param init - fetch options (method, body).
 * @returns the route's `value`; throws on any non-ok answer.
 */
export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${ROUTE}${path}`, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = (await response.json()) as {
    ok: boolean
    value?: T
    error?: { code?: string, message?: string, host?: HostText }
  }
  if (!response.ok || body.ok !== true) {
    // The host's coded message is rendered in the active locale; its plain
    // `message` is the last-resort line when no code came with the answer.
    throw new HostError(body.error?.host, body.error?.message ?? `HTTP ${response.status}`)
  }
  return body.value as T
}
