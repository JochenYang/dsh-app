/**
 * The model connectivity probe's plan: URL, headers and body, as pure functions.
 *
 * The host owns the credential and the fetch; this module only decides what to
 * send, so the decisions are testable without a network or a kernel. It is
 * browser-safe (no node builtins) because the client half imports the wire
 * types from the same file.
 *
 * Three rules shape the plan:
 *
 *   - **The endpoint comes from the profile, never from the request body.** The
 *     host resolves `baseURL`/`api`/`headers` out of the provider's settings and
 *     hands them here; a caller cannot point the probe at an arbitrary URL.
 *   - **http(s) only, no userinfo.** A `file:`, `data:` or `ftp:` target would
 *     turn a key-bearing request into a local read or a different protocol.
 *   - **The credential header is ours.** User-configured headers are copied
 *     (gateways require them), but hop-by-hop names and CR/LF values are
 *     dropped, and the auth header is written last so a copied header cannot
 *     redirect the key.
 *
 * @module @dsh-app/plugin-client-ui/probe-wire
 */

/** A user-visible message the host cannot localize, mirroring the suite's wire shape. */
export interface HostText {
  /** Stable message code; the client maps it to its own dictionary. */
  readonly code: string
  /** Values the client's sentence interpolates. */
  readonly params?: Readonly<Record<string, string | number>>
  /** English developer-facing fallback, shown only for an unknown code. */
  readonly text?: string
}

/** Route namespace on the shared Connection `/api` channel (no `@` in a path segment). */
export const PROBE_ROUTE = '/api/plugins/dsh-app/plugin-client-ui/probe'

/** The wire protocols this probe knows how to speak. */
export const PROBE_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const

/** One of {@link PROBE_APIS}. */
export type ProbeApi = (typeof PROBE_APIS)[number]

/** What the host resolved out of the provider's settings. */
export interface ProbePlanInput {
  /** The profile's base URL (already selected by the host). */
  readonly baseURL: string
  /** The resolved wire protocol (route-level or the model's own). */
  readonly api: string
  /** The model id sent in the request body and addressed by the test. */
  readonly model: string
  /** The credential value, when the route names a resolvable one. */
  readonly apiKey?: string
  /** The profile's static request headers, passed through to the probe. */
  readonly headers?: Readonly<Record<string, unknown>>
}

/** What to send, or why nothing can be sent. */
export type ProbePlan =
  | {
    readonly ok: true
    readonly url: string
    readonly headers: Readonly<Record<string, string>>
    readonly body: string
  }
  | { readonly ok: false; readonly code: string; readonly text: string }

/** Hop-by-hop and framing headers a browser refuses or that would corrupt the request. */
const RESERVED_HEADERS = new Set([
  'host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer',
])

/** Anthropic's required API version for `messages`. */
const ANTHROPIC_VERSION = '2023-06-01'

/** Cap on the probe's own timeout; the route and the client both read the same number. */
export const PROBE_TIMEOUT_MS = 20_000

/**
 * Validate a base URL and strip its trailing slashes.
 * @param raw - the profile's baseURL.
 * @returns the trimmed base, or a failure code.
 */
function normalizedBase(raw: string): { ok: true; base: string } | { ok: false; code: string; text: string } {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, code: 'probe.baseUrlMissing', text: 'the provider has no baseURL' }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, code: 'probe.invalidBaseUrl', text: 'the baseURL is not an absolute URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, code: 'probe.invalidBaseUrl', text: `the baseURL protocol ${parsed.protocol} is not http(s)` }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    // A URL carrying credentials would leak them into an error or a log line.
    return { ok: false, code: 'probe.invalidBaseUrl', text: 'the baseURL carries a userinfo section' }
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    // A query or fragment would be joined into the endpoint path by string
    // concatenation; refusing is honest about a shape this probe cannot speak.
    return { ok: false, code: 'probe.invalidBaseUrl', text: 'the baseURL carries a query string or fragment' }
  }
  return { ok: true, base: trimmed.replace(/\/+$/u, '') }
}

/**
 * Build the probe request.
 * @param input - what the host resolved.
 * @returns the URL, headers and body, or a refusal.
 */
export function planProbe(input: ProbePlanInput): ProbePlan {
  const base = normalizedBase(input.baseURL)
  if (!base.ok) return base
  if (!(PROBE_APIS as readonly string[]).includes(input.api)) {
    return { ok: false, code: 'probe.apiUnsupported', text: `the protocol ${input.api || '(none)'} has no probe` }
  }
  const model = input.model.trim()
  if (model === '') return { ok: false, code: 'probe.modelRequired', text: 'the model id is empty' }

  const api = input.api as ProbeApi
  const url = api === 'anthropic-messages'
    // `messages` hangs off the root: a base that already ends in /v1 must not
    // become /v1/v1/messages, which is the mistake the official create form warns
    // about too.
    ? `${base.base.replace(/\/v1$/u, '')}/v1/messages`
    : api === 'openai-responses'
      ? `${base.base}/responses`
      : `${base.base}/chat/completions`

  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (typeof value !== 'string') continue
    const key = name.trim().toLowerCase()
    if (key === '' || RESERVED_HEADERS.has(key)) continue
    if (/[\r\n]/u.test(name) || /[\r\n]/u.test(value)) continue
    headers[key] = value
  }
  headers['content-type'] = 'application/json'
  if (api === 'anthropic-messages') {
    // `messages` requires the version header even when the endpoint needs no
    // key (a local Anthropic-compatible server), so it is never conditional.
    headers['anthropic-version'] = ANTHROPIC_VERSION
  }
  const key = input.apiKey?.trim() ?? ''
  if (key !== '') {
    if (api === 'anthropic-messages') {
      headers['x-api-key'] = key
    } else {
      headers.authorization = `Bearer ${key}`
    }
  }

  const body = JSON.stringify(api === 'anthropic-messages'
    ? { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
    : api === 'openai-responses'
      // Responses rejects a 1-token budget on some models, so 16 is the smallest
      // number that still exercises the path everywhere the adapter is used.
      ? { model, input: 'ping', max_output_tokens: 16, stream: false }
      : { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false })

  // The final gate: a value the HTTP layer would refuse must be refused HERE,
  // as a code, before a credential is anywhere near a thrown diagnostic that
  // could quote the value back.
  try {
    new Headers(headers)
  } catch {
    return { ok: false, code: 'probe.invalidHeader', text: 'a configured header is not a valid HTTP header' }
  }

  return { ok: true, url, headers, body }
}
