/**
 * Client side of the model connectivity probe.
 *
 * One authenticated POST to the host route, which owns the credential and the
 * request; this module only classifies the answer into a message the page can
 * show in the active language. The host never sends prose it expects the user to
 * read — it sends a stable code, and this table is where those codes become
 * sentences.
 *
 * @module @dsh-app/plugin-client-ui/client/models-advanced/probe
 */

import { PROBE_ROUTE } from '../../probe-wire.ts'
import type { HostText } from '../../probe-wire.ts'
import { message, wireText } from './messages.ts'
import type { PageMessage } from './messages.ts'

/** One probe's outcome: a latency, or a sentence explaining the failure. */
export type ProbeResult =
  | { readonly ok: true; readonly latency: number }
  | { readonly ok: false; readonly failure: PageMessage }

/** Whether a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Map the host's coded failure to this page's dictionary.
 * @param host - the coded message, when the host sent one.
 * @param fallback - the host's English diagnostic, shown for a code this client
 *   does not know yet (an older page beside a newer kernel).
 * @returns the message to render.
 */
function classify(host: HostText | undefined, fallback: string): PageMessage {
  switch (host?.code) {
    case 'probe.http':
      return message('adv.test.http', { status: Number(host.params?.status ?? 0) })
    case 'probe.timeout':
      return message('adv.test.timeout')
    case 'probe.network':
      return message('adv.test.network')
    case 'probe.redirect':
      return message('adv.test.redirect')
    case 'probe.routeUnknown':
      return message('adv.test.routeUnknown')
    case 'probe.apiUnsupported':
      return message('adv.test.apiUnsupported')
    case 'probe.baseUrlMissing':
      return message('adv.test.baseUrlMissing')
    case 'probe.invalidBaseUrl':
      return message('adv.test.invalidBaseUrl')
    case 'probe.modelRequired':
      return message('adv.test.modelRequired')
    case 'probe.invalidHeader':
      return message('adv.test.invalidHeader')
    case 'probe.invalidBody':
    case 'probe.bodyTooLarge':
    case 'probe.routeRequired':
      // The host's diagnostic for these is a parser message that can quote the
      // request body; the page shows its own sentence instead.
      return message('adv.test.invalidRequest')
    default:
      // Body/route-shape refusals carry a parser diagnostic that may quote the
      // request body; the page shows its own sentence for them.
      return host === undefined ? message('adv.test.default') : wireText(host.text ?? fallback)
  }
}

/**
 * Probe one model through the host.
 * @param route - the provider route id.
 * @param model - the model id to send.
 * @returns the latency or the classified failure.
 */
export async function probeModel(route: string, model: string): Promise<ProbeResult> {
  let response: Response
  try {
    response = await fetch(PROBE_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({ route, model }),
    })
  } catch {
    return { ok: false, failure: message('adv.test.network') }
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { ok: false, failure: message('adv.test.default') }
  }
  if (!isRecord(payload)) return { ok: false, failure: message('adv.test.default') }
  if (payload.ok === true && isRecord(payload.value) && typeof payload.value.latency === 'number') {
    return { ok: true, latency: payload.value.latency }
  }
  const error = isRecord(payload.error) ? payload.error : {}
  const rawHost = isRecord(error.host) ? error.host : undefined
  const host: HostText | undefined = rawHost === undefined || typeof rawHost.code !== 'string'
    ? undefined
    : {
      code: rawHost.code,
      ...(isRecord(rawHost.params) ? { params: rawHost.params as Readonly<Record<string, string | number>> } : {}),
      ...(typeof rawHost.text === 'string' ? { text: rawHost.text } : {}),
    }
  const fallback = typeof error.message === 'string' ? error.message : ''
  return { ok: false, failure: classify(host, fallback) }
}
