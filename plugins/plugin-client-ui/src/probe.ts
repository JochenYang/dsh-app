/**
 * The model connectivity probe — host half.
 *
 * One authenticated POST route on the Connection exact-Fetch channel:
 *
 *   POST /api/plugins/dsh-app/plugin-client-ui/probe
 *   body { route, model } → { ok: true, value: { latency } } | { ok: false, error }
 *
 * Why it lives on the host: a probe has to send the provider's credential, and
 * the credential service is host-side only — the browser never receives a key
 * (the page only ever sees whether one resolves). The endpoint, protocol and
 * static headers are read from the same settings namespace the adapter reads,
 * so a caller cannot aim the probe at a URL of its own choosing; the request
 * body carries only the route id and the model id.
 *
 * Safety rails, each with its failure mode as a stable code:
 *
 *   - the URL must be http(s) with no userinfo (`probe.invalidBaseUrl`);
 *   - redirects are NOT followed — a cross-origin hop would hand the key to
 *     another host (`probe.redirect`);
 *   - one 20 s timeout (`probe.timeout`) and a hard response-body cancellation
 *     (nothing from the answer is read back, so nothing can be echoed);
 *   - failures carry an English diagnostic, never a header value, a URL query
 *     with a secret, or a response body.
 *
 * The route itself carries no Host/Origin fence: the Connection carrier applies
 * its own trust and browser authentication before a handler runs.
 *
 * @module @dsh-app/plugin-client-ui/probe
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import { planProbe, PROBE_ROUTE, PROBE_TIMEOUT_MS, type HostText } from './probe-wire.ts'

/** The settings namespace the pi-ai adapter reads its providers from. */
const ROUTE_SETTINGS_NS = 'llm-pi-ai'

/** Cap on one request body: a route id and a model id. */
const MAX_BODY = 4_096

/** Structural slice of the settings service (no import of its implementation). */
interface SettingsLike {
  describe(options?: { redactSecrets?: boolean }): ReadonlyArray<{ ns: string; value: unknown }>
}

/** Structural slice of the credentials service. */
interface CredentialsLike {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

/** Structural slice of the llm directory: the adapter's own route defaults. */
interface LlmDirectoryLike {
  listConfigurableProviders(): ReadonlyArray<{
    readonly provider: string
    readonly defaultBaseURL?: string
    readonly nativeAuth?: { readonly env?: readonly string[] }
  }>
}

function sendJson(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function ok(value: unknown): Response {
  return sendJson(200, { ok: true, value })
}

/**
 * Failure answer in the suite's route envelope: `code` is the transport-ish
 * category, `host` is the coded message the client localizes, and `message`
 * stays an English diagnostic for logs and for an older client.
 */
function fail(status: number, kind: string, host: HostText): Response {
  return sendJson(status, { ok: false, error: { code: kind, message: host.text ?? host.code, host } })
}

/** Bounded JSON body read (the carrier already buffered it under its own cap). */
async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BODY) throw new Error('payload-too-large')
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY) throw new Error('payload-too-large')
  const parsed: unknown = JSON.parse(text)
  return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
}

/** Whether a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-empty string field, or undefined. */
function stringAt(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Read one provider's probe-relevant profile out of the settings mirror.
 * @param ctx - the plugin context (settings + credentials are resolved lazily).
 * @param route - the provider route id.
 * @param model - the model id, for a per-model protocol override.
 * @returns the profile, or a refusal code.
 */
async function resolveTarget(
  ctx: Context,
  route: string,
  model: string,
): Promise<
  | { ok: true; baseURL: string; api: string; headers: Record<string, unknown>; apiKey?: string }
  | { ok: false; host: HostText }
> {
  const settings = ctx.get('settings') as SettingsLike | undefined
  // No redaction: this module reads the profile in the host process and never
  // returns it, so redacting would only drop fields the adapter itself would
  // send (and turn a working route into a false 401).
  const descriptor = settings?.describe().find(entry => entry.ns === ROUTE_SETTINGS_NS)
  const providers = isRecord(descriptor?.value) ? descriptor.value.providers : undefined
  const profile = isRecord(providers) && isRecord(providers[route]) ? providers[route] as Record<string, unknown> : undefined
  if (profile === undefined) {
    return { ok: false, host: { code: 'probe.routeUnknown', text: 'no provider profile for that route' } }
  }
  // A shipped route may take its endpoint and credential name from the adapter
  // rather than the profile; the directory is the only place those are declared.
  const directory = ctx.get('llm') as LlmDirectoryLike | undefined
  const entry = directory?.listConfigurableProviders().find(candidate => candidate.provider === route)

  // A model entry may override the route's protocol; that is the protocol the
  // adapter would actually use for this model.
  const models = Array.isArray(profile.models) ? profile.models : []
  const modelEntry = models.find(candidate => isRecord(candidate) && stringAt(candidate, 'id') === model)
  const api = (isRecord(modelEntry) ? stringAt(modelEntry, 'api') : undefined) ?? stringAt(profile, 'api')
  if (api === undefined) {
    return { ok: false, host: { code: 'probe.apiUnsupported', text: 'the provider declares no api protocol' } }
  }
  const baseURL = stringAt(profile, 'baseURL') ?? entry?.defaultBaseURL
  if (baseURL === undefined || baseURL.trim() === '') {
    return { ok: false, host: { code: 'probe.baseUrlMissing', text: 'the provider has no baseURL' } }
  }

  const headers = isRecord(profile.headers) ? profile.headers : {}
  // The adapter's native authentication applies ONLY when the profile names no
  // credential reference: a declared-but-unresolved variable must not silently
  // authenticate with a different key (that would make a probe pass for a
  // request the adapter would send unauthenticated).
  const ownRef = stringAt(profile, 'apiKeyEnv')
  const references = ownRef !== undefined ? [ownRef] : (entry?.nativeAuth?.env ?? [])
  let apiKey: string | undefined
  for (const reference of references) {
    if (reference === '') continue
    const credentials = ctx.get('credentials') as CredentialsLike | undefined
    try {
      const resolved = (await credentials?.resolve(reference))?.value
      if (typeof resolved === 'string' && resolved !== '') {
        apiKey = resolved
        break
      }
    } catch {
      // A throwing resolver is a missing key, not a failed probe: the request
      // goes out unauthenticated and the endpoint's 401 is the answer.
    }
  }
  return { ok: true, baseURL, api, headers, ...apiKey === undefined ? {} : { apiKey } }
}

/**
 * Handle one probe request.
 * @param ctx - the plugin context.
 * @param request - the authenticated request.
 * @returns the route answer.
 */
async function handleProbe(ctx: Context, request: Request): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = await readJsonBody(request)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid body'
    if (detail === 'payload-too-large') {
      return fail(413, 'payload-too-large', { code: 'probe.bodyTooLarge', text: `request body too large (${MAX_BODY} byte cap)` })
    }
    return fail(400, 'bad-request', { code: 'probe.invalidBody', params: { detail }, text: detail })
  }
  const route = typeof body.route === 'string' ? body.route.trim() : ''
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (route === '' || route.length > 128 || /[\u0000-\u001f\u007f]/u.test(route)) {
    return fail(400, 'bad-request', { code: 'probe.routeRequired', text: 'route must be a short provider id' })
  }
  if (model === '' || model.length > 256 || /[\u0000-\u001f\u007f]/u.test(model)) {
    return fail(400, 'bad-request', { code: 'probe.modelRequired', text: 'model must be a non-empty model id' })
  }

  const target = await resolveTarget(ctx, route, model)
  if (!target.ok) return fail(404, 'unknown-route', target.host)

  const plan = planProbe({
    baseURL: target.baseURL,
    api: target.api,
    model,
    ...target.apiKey === undefined ? {} : { apiKey: target.apiKey },
    headers: target.headers,
  })
  if (!plan.ok) return fail(400, 'bad-request', { code: plan.code, text: plan.text })

  const started = Date.now()
  let response: Response
  try {
    response = await fetch(plan.url, {
      method: 'POST',
      headers: plan.headers,
      body: plan.body,
      // A redirect would carry the credential header to wherever Location
      // points; refusing every hop is the only cross-origin-safe rule.
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      return fail(504, 'timeout', { code: 'probe.timeout', params: { seconds: PROBE_TIMEOUT_MS / 1000 }, text: `the probe timed out after ${PROBE_TIMEOUT_MS} ms` })
    }
    // The transport's message can interpolate a header VALUE (undici's own
    // diagnostics do), and a header value can be a credential. Never forward it.
    return fail(502, 'network', { code: 'probe.network', text: 'the probe request failed before a response arrived' })
  }
  const latency = Date.now() - started
  // Nothing from the answer is read back: the probe reports reachability, and a
  // provider body can echo account or request details.
  void response.body?.cancel().catch(() => undefined)

  if (response.status >= 300 && response.status < 400) {
    return fail(502, 'redirect', { code: 'probe.redirect', params: { status: response.status }, text: `the endpoint redirected (HTTP ${response.status}); redirects are not followed` })
  }
  if (!response.ok) {
    return fail(502, 'http', { code: 'probe.http', params: { status: response.status }, text: `the endpoint answered HTTP ${response.status}` })
  }
  return ok({ latency })
}

/**
 * Register the probe route on the Connection exact-Fetch registry.
 * @param connectionFetch - the Connection exact-Fetch registry.
 * @param ctx - the plugin context.
 * @returns disposer removing the route with the plugin's fiber.
 */
export function registerProbeRoute(connectionFetch: HostConnectionFetch, ctx: Context): () => Promise<void> {
  return connectionFetch.register({
    path: PROBE_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request: Request) => handleProbe(ctx, request),
  })
}
