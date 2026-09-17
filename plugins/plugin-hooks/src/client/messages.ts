/**
 * The Hooks page's message currency (no React, no framework runtime): the
 * coded host message → display string mapping, and the classification of
 * whatever the transport throws.
 *
 * The host never sends prose for anything the user reads (see `HostText` in
 * ../wire.ts): it sends a stable code plus the values its sentence
 * interpolates, and {@link hostMessage} renders this page's copy for it. Text
 * that arrives already written (a bare `HTTP 500`) is shown as it is. Keeping
 * the mapping here rather than in the section component lets it be tested
 * without a DOM.
 *
 * @module @dsh-app/plugin-hooks/client/messages
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { HostText } from '../wire.ts'
import type { HooksKey } from './locales.ts'
import { NS } from './locales.ts'

/**
 * One message the page shows: a key of this page's dictionary, a coded host
 * message that renders through the same dictionary, or text written elsewhere
 * and shown as it arrived (a bare `HTTP 500`).
 */
export type Notice =
  | { readonly source: 'key'; readonly key: HooksKey; readonly params?: Record<string, unknown> }
  | { readonly source: 'host'; readonly host: HostText; readonly fallback: string }
  | { readonly source: 'text'; readonly text: string }

/**
 * Copy for the host codes this build knows, keyed by the code itself. The
 * convention is the code with its namespace dot folded into the key
 * (`bridge.badId` → `hooks.host.bridgeBadId`).
 *
 * One kind of code is deliberately absent: `mount.failed`, whose whole message
 * is the kernel loader's opaque diagnostic — for it the host's English `text`
 * IS the message, and {@link hostMessage} renders it, never a blank. (The
 * `route.crossOrigin` / `route.methodOnly` codes went with the web-server
 * guards: trust and method ownership are the Connection carrier's now, and it
 * answers its own 404 before a route body is involved.)
 */
const HOST_KEYS: Readonly<Record<string, HooksKey>> = {
  'bridge.notObject': 'hooks.host.bridgeNotObject',
  'bridge.badId': 'hooks.host.bridgeBadId',
  'bridge.notFound': 'hooks.host.bridgeNotFound',
  'dialect.invalid': 'hooks.host.dialectInvalid',
  'configSource.invalid': 'hooks.host.configSourceInvalid',
  'config.inlineEmpty': 'hooks.host.configInlineEmpty',
  'configPath.required': 'hooks.host.configPathRequired',
  'configPath.notAbsolute': 'hooks.host.configPathNotAbsolute',
  'model.codexOnly': 'hooks.host.modelCodexOnly',
  'field.notPositive': 'hooks.host.fieldNotPositive',
  'native.noExternalFile': 'hooks.host.nativeNoExternalFile',
  'native.jsonParseFailed': 'hooks.host.nativeJsonParseFailed',
  'native.notObject': 'hooks.host.nativeNotObject',
  'native.rulesRequired': 'hooks.host.nativeRulesRequired',
  'native.ruleNotObject': 'hooks.host.nativeRuleNotObject',
  'native.onInvalid': 'hooks.host.nativeOnInvalid',
  'native.actionInvalid': 'hooks.host.nativeActionInvalid',
  'native.actionUnsupported': 'hooks.host.nativeActionUnsupported',
  'native.messageRequired': 'hooks.host.nativeMessageRequired',
  'native.matcherRequired': 'hooks.host.nativeMatcherRequired',
  'native.matcherInvalid': 'hooks.host.nativeMatcherInvalid',
  'native.matcherBadRegex': 'hooks.host.nativeMatcherBadRegex',
  'native.matcherTooLong': 'hooks.host.nativeMatcherTooLong',
  'route.disabled': 'hooks.host.routeDisabled',
  'route.writeFailed': 'hooks.host.writeFailed',
  'route.bodyTooLarge': 'hooks.host.bodyTooLarge',
  'route.invalidBody': 'hooks.host.invalidBody',
  'mount.unavailable': 'hooks.host.mountUnavailable',
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

/** A failure carrying the host's coded message, when the answer had one. */
export class HostError extends Error {
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
 * Classify an unexpected failure: a coded host answer keeps its code, anything
 * else (a network error) is shown as written.
 * @param failure - the caught value.
 * @returns the classified message.
 */
export function wireNotice(failure: unknown): Notice {
  if (failure instanceof HostError && failure.host !== undefined) {
    return { source: 'host', host: failure.host, fallback: failure.message }
  }
  return { source: 'text', text: failure instanceof Error ? failure.message : String(failure) }
}

/**
 * Render a notice in the active locale.
 * @param notice - the classified message.
 * @param t - the page's namespace-bound translate seat.
 * @returns the display text.
 */
export function noticeText(notice: Notice, t: TranslateNS<typeof NS>): string {
  switch (notice.source) {
    case 'key':
      return t(notice.key, notice.params)
    case 'host':
      return hostMessage(notice.host, t, notice.fallback)
    case 'text':
      return notice.text
  }
}
