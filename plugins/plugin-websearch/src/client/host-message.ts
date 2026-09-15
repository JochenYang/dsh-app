/**
 * Host-message rendering for the settings page.
 *
 * The host never sends prose for anything the user reads (see `HostText` in
 * ../wire.ts): it sends a stable code plus the values the sentence
 * interpolates, and the copy lives in this page's dictionary. This module owns
 * the code → copy tables; it is deliberately React-free so the test suite can
 * exercise it (a `.tsx` cannot be bundled by the plugin's test harness).
 *
 * Every table entry must hand `t` the params its sentence needs. A missing one
 * is not a crash — the locale runtime returns the template as-is — it is a
 * literal `{detail}` on screen, which is exactly the bug the tests here pin.
 *
 * @module @dsh-app/plugin-websearch/client/host-message
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { EngineStatus, HostText } from '../wire.ts'
import { NS, type WebSearchKey } from './locales.ts'

/** The page's translate seat. */
type T = TranslateNS<typeof NS>

/**
 * Render a coded host message.
 *
 * @param value - the host message, if it sent one.
 * @param copy - this build's copy for the codes it knows.
 * @param fallback - line to show when the host sent nothing at all.
 * @returns the copy of the active locale.
 */
export function hostMessage(
  value: HostText | undefined,
  copy: Readonly<Record<string, string>>,
  fallback: string,
): string {
  if (value === undefined) return fallback
  return copy[value.code] ?? value.text ?? fallback
}

/**
 * Why one engine cannot run, in the badge's words.
 * @param status - the host's per-engine status.
 * @param t - the page's translate seat.
 * @returns the copy to show and the badge tone it deserves.
 */
export function statusLabel(status: EngineStatus, t: T): { text: string, tone: 'ok' | 'err' | 'muted' } {
  const blocked = {
    'engine.missingKey': t('ws.status.missingKey'),
    'engine.missingInstance': t('ws.status.missingInstance'),
    'engine.disabled': t('ws.status.disabled'),
    'engine.unknown': t('ws.status.unknownEngine'),
  }
  switch (status.state) {
    case 'ready':
      return { text: t('ws.status.ready'), tone: 'ok' }
    case 'blocked':
      return { text: hostMessage(status.message, blocked, t('ws.status.blocked')), tone: 'err' }
    case 'disabled':
      return { text: t('ws.status.disabled'), tone: 'muted' }
    case 'error':
      return { text: t('ws.status.error'), tone: 'err' }
    default:
      return { text: t('ws.status.unknown'), tone: 'muted' }
  }
}

/**
 * Provider availability copy, same contract as {@link hostMessage}.
 * @param t - the page's translate seat.
 * @param reason - the host's coded reason.
 * @returns the sentence, or an empty string when the host sent nothing.
 */
export function providerReasonCopy(t: T, reason: HostText | undefined): string {
  return hostMessage(reason, {
    'provider.noSeam': t('ws.provider.reason.noSeam'),
    'provider.disabled': t('ws.provider.reason.disabled'),
    'provider.noEngines': t('ws.provider.reason.noEngines'),
    'provider.upstreamUnknown': t('ws.provider.reason.upstreamUnknown'),
    'provider.upstreamUnregistered': t('ws.provider.reason.upstreamUnregistered'),
    'provider.upstreamUnusable': t('ws.provider.reason.upstreamUnusable'),
  }, '')
}

/** Codes whose sentence interpolates the host's own diagnostic. */
const DETAIL_CODES = new Set(['route.writeFailed', 'route.invalidBody'])

/**
 * Save/route failure copy: the validation codes a rejected write can carry plus
 * the transport ones. An unknown code falls back to the host's English
 * diagnostic, never to a blank banner.
 *
 * @param t - the page's translate seat.
 * @param host - the coded failure, if it carried one.
 * @param fallback - line to show when it did not.
 * @returns the sentence of the active locale.
 */
export function routeErrorCopy(t: T, host: HostText | undefined, fallback: string): string {
  // `{detail}` is the host's own diagnostic: it is passed through rather than
  // translated, and it has to reach `t` or the sentence renders a literal
  // placeholder (the failure mode this table is tested against).
  const detail = DETAIL_CODES.has(host?.code ?? '') ? (host?.text ?? '') : ''
  const params = host?.params ?? {}
  const text = (template: string): string => template.replace('{id}', String(params.id ?? ''))
  return hostMessage(host, {
    'config.notObject': t('ws.host.configNotObject'),
    'engines.notArray': t('ws.host.enginesNotArray'),
    'engine.notObject': t('ws.host.engineNotObject'),
    'engine.unknownId': text(t('ws.host.engineUnknownId')),
    'engine.duplicate': text(t('ws.host.engineDuplicate')),
    'engine.keyMasked': text(t('ws.host.engineKeyMasked')),
    'searxng.notArray': t('ws.host.searxngNotArray'),
    'searxng.notHttp': t('ws.host.searxngNotHttp', { url: String(params.url ?? '') }),
    'route.noTestableEngine': t('ws.host.noTestableEngine'),
    'route.bodyTooLarge': t('ws.host.bodyTooLarge'),
    'route.writeFailed': t('ws.host.writeFailed', { detail }),
    'route.invalidBody': t('ws.host.invalidBody', { detail }),
    'selftest.chainExhausted': t('ws.chain.chainExhausted'),
    'selftest.failed': t('ws.chain.selftestFailed'),
  }, fallback)
}
