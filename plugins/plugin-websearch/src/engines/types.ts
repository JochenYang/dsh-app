/**
 * The engine contract every search backend implements, plus the shared HTTP
 * helpers they build on.
 *
 * An engine's job is narrow: turn one query into citeable sources. It does
 * NOT decide which engines run, when to give up, or how to cache — that is
 * `chain.ts`. It also does not own the search timeout budget: it receives a
 * composed `signal` already bounded by the caller and must honor it.
 *
 * Engines throw on failure. A thrown error is the chain's signal to fall
 * through to the next engine, so messages must be short, zh-CN-safe for
 * logging, and must never embed credentials.
 *
 * @module @dsh-app/plugin-websearch/engines/types
 */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'

/** One engine invocation. */
export interface EngineRequest {
  readonly query: string
  readonly maxResults: number
  /**
   * Composed cancellation signal (caller budget + upstream cancellation).
   * Engines must forward it to `fetch` and must not swallow aborts.
   */
  readonly signal: AbortSignal
  /** Resolved key, when the engine is `key` tier. */
  readonly apiKey?: string
}

/** An engine: one id, one function. */
export interface Engine {
  readonly id: string
  run(request: EngineRequest): Promise<WebSearchSource[]>
}

/** Shared request headers. A browser UA is required by the HTML-scraping engines. */
export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/** Bound every surfaced engine error so one failing backend cannot flood the log. */
const MAX_ERROR_CHARS = 200

/** Contain an unknown error into a short, log-safe message. */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message
}

/**
 * Whether an error is the caller's cancellation rather than an engine
 * failure. Aborts must propagate instead of being treated as "this engine is
 * broken, try the next one" — otherwise a cancelled search walks the whole
 * chain before returning.
 */
export function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted'))
}

/**
 * One HTTP request bounded by the caller's signal.
 *
 * The timeout is intentionally NOT applied here: the chain owns the budget
 * and composes it into `signal` before calling. Adding a second timer inside
 * each engine would make the effective deadline depend on which engine ran,
 * which is exactly the ambiguity the single budget exists to remove.
 *
 * Every request asks for an UNCOMPRESSED body, and the caller's own headers are
 * merged rather than replaced. Measured on this machine through the kernel's own
 * dispatcher: the local proxy hands back responses with **no headers at all**
 * (`headers: []`), so a gzip body arrives with no `content-encoding` to explain
 * it and nothing can decode it — the Parallel MCP endpoint answered 50,347 bytes
 * of valid JSON-RPC directly and 10,817 bytes of gzip through that path, which
 * our parser can only report as "no parsable JSON-RPC frame". A host that ignores
 * the header behaves exactly as before.
 */
export async function request(
  url: string,
  init: RequestInit & { readonly signal: AbortSignal },
): Promise<Response> {
  try {
    return await fetch(url, {
      redirect: 'follow',
      ...init,
      headers: { 'accept-encoding': 'identity', ...init.headers },
    })
  } catch (error) {
    if (isAbort(error)) throw error
    throw new Error(`network request failed: ${describeError(error)}`)
  }
}

/** Fetch text, turning a non-2xx status into a short descriptive error. */
export async function requestText(url: string, init: RequestInit & { readonly signal: AbortSignal }): Promise<string> {
  const response = await request(url, init)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.text()
}

/** Fetch JSON, turning a non-2xx status into a short descriptive error. */
export async function requestJson(url: string, init: RequestInit & { readonly signal: AbortSignal }): Promise<unknown> {
  const response = await request(url, init)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  try {
    return await response.json()
  } catch {
    throw new Error('response is not valid JSON')
  }
}

/** Decode the entities the HTML-scraping engines actually encounter. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
}

/** Strip tags and collapse whitespace into a snippet. */
export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
}

/**
 * Drop duplicate URLs and cap the list. Engines over-return freely; this is
 * the single place the cap is applied so every engine's output shape matches.
 */
export function dedupeSources(sources: readonly WebSearchSource[], limit: number): WebSearchSource[] {
  const seen = new Set<string>()
  const out: WebSearchSource[] = []
  for (const source of sources) {
    if (source.url === '' || seen.has(source.url)) continue
    seen.add(source.url)
    out.push(source)
    if (out.length >= limit) break
  }
  return out
}

/** Build a source, omitting absent optional fields (keeps replay byte-identical). */
export function source(url: string, title?: string, snippet?: string, publishedAt?: string): WebSearchSource {
  return {
    url,
    ...title !== undefined && title !== '' ? { title } : {},
    ...snippet !== undefined && snippet !== '' ? { snippet } : {},
    ...publishedAt !== undefined && publishedAt !== '' ? { publishedAt } : {},
  }
}
