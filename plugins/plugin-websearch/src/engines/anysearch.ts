/**
 * AnySearch — anonymous JSON API (`https://api.anysearch.com/v1/search`), no
 * key. Verified against the live endpoint: it answers a bare POST with
 * `{code, message, data: {results: [...]}}` and needs no registration.
 *
 * This is the chain's second engine by default. It is a plain JSON API rather
 * than an HTML scrape, so it does not break when a search page is redesigned,
 * and it is reachable from mainland China without a proxy — the two
 * properties that put it ahead of the engines it replaced.
 *
 * The envelope carries a business-level `code` that is 0 on success, so a
 * non-zero code is a failure even when HTTP says 200. Checking only the HTTP
 * status would let a rate-limited or invalid request surface as "0 results".
 *
 * @module @dsh-app/plugin-websearch/engines/anysearch
 */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'
import type { Engine, EngineRequest } from './types.ts'
import { dedupeSources, request, source } from './types.ts'

const ENDPOINT = 'https://api.anysearch.com/v1/search'

/** One result row, narrowed defensively (the payload is untrusted input). */
interface AnySearchResult {
  readonly url?: unknown
  readonly title?: unknown
  readonly snippet?: unknown
  readonly content?: unknown
}

/** The API envelope. */
interface AnySearchPayload {
  readonly code?: unknown
  readonly message?: unknown
  readonly data?: { readonly results?: unknown }
}

/**
 * Parse one AnySearch payload into sources. Exported for parser tests.
 * Throws for a non-zero business code (the API's own failure signal) and for
 * a payload that is not the documented shape.
 */
export function parseAnySearch(payload: unknown, limit: number): WebSearchSource[] {
  if (typeof payload !== 'object' || payload === null) throw new Error('response is not a JSON object')
  const envelope = payload as AnySearchPayload
  if (envelope.code !== undefined && envelope.code !== 0) {
    const message = typeof envelope.message === 'string' ? envelope.message : String(envelope.code)
    throw new Error(`AnySearch returned an error: ${message}`)
  }
  const results = envelope.data?.results
  if (!Array.isArray(results)) throw new Error('AnySearch response has no data.results')
  const sources: WebSearchSource[] = []
  for (const raw of results as readonly AnySearchResult[]) {
    if (typeof raw.url !== 'string' || raw.url === '') continue
    // `snippet` is the short form; `content` is the longer body and is used
    // only when no snippet exists, so a source never carries a wall of text.
    const snippet = typeof raw.snippet === 'string' && raw.snippet.trim() !== ''
      ? raw.snippet
      : typeof raw.content === 'string' ? raw.content : undefined
    sources.push(source(
      raw.url,
      typeof raw.title === 'string' ? raw.title : undefined,
      snippet === undefined ? undefined : snippet.slice(0, 300),
    ))
  }
  return dedupeSources(sources, limit)
}

/** The AnySearch engine. */
export function anySearchEngine(): Engine {
  return {
    id: 'anysearch',
    async run({ query, maxResults, signal }: EngineRequest): Promise<WebSearchSource[]> {
      const response = await request(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query, max_results: maxResults }),
        signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json().catch(() => {
        throw new Error('response is not valid JSON')
      }) as unknown
      return parseAnySearch(payload, maxResults)
    },
  }
}
