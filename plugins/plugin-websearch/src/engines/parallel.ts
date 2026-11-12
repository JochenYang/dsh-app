/**
 * Parallel — hosted MCP endpoint (`https://mcp.parallel.ai/mcp`).
 *
 * Anonymous calls are free at a lower rate limit and report per-call usage in
 * the response `_meta`; a user key (`x-api-key`) bills to their account with a
 * higher ceiling, which is why the settings page probes it like any other
 * engine.
 *
 * The host moved from `search.parallel.ai` to `mcp.parallel.ai` (the address
 * Parallel's own MCP documentation gives as of 2026-11). Both answered 200
 * with an identical payload when measured, and both reject a bad key with
 * HTTP 401 `{"code":16,"message":"Invalid API key (C.1)"}` — the new one is
 * used because it is the documented address.
 *
 * Response shape (verified against the live endpoint): the MCP text block is
 * itself a JSON document — `{ search_id, results: [{ url, title,
 * publish_date, excerpts: [...] }] }` — so this engine parses a nested JSON
 * string rather than the `Title:`/`URL:` text layout Exa uses. The new host
 * frames it as SSE (`event: message` + `data: {...}`), which the shared
 * transport already parses; `search.parallel.ai` answered with plain JSON.
 *
 * The tool requires both `objective` and `search_queries`. With only one
 * query available at this layer, the query serves as both: `objective` wants
 * a natural-language statement of intent and a search query is an acceptable
 * (if terse) one, whereas omitting either field is a hard schema failure.
 *
 * @module @dsh-app/plugin-websearch/engines/parallel
 */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'
import type { Engine, EngineRequest } from './types.ts'
import { callMcpTool } from './mcp.ts'
import { dedupeSources, source } from './types.ts'

const ENDPOINT = 'https://mcp.parallel.ai/mcp'
const TOOL = 'web_search'

/**
 * Free-tier rate limiting is keyed on this value, so it must stay stable for
 * the life of the process — a per-call value would present every search as a
 * new client and defeat the accounting the endpoint applies.
 */
const SESSION_ID = `dsh-app-${process.pid.toString(36)}-${Date.now().toString(36)}`

/** One result row of Parallel's payload, narrowed defensively. */
interface ParallelResult {
  readonly url?: unknown
  readonly title?: unknown
  readonly publish_date?: unknown
  readonly excerpts?: unknown
}

/**
 * Parse Parallel's nested JSON payload into sources. Exported for parser
 * tests. A payload that is not the documented object shape is an error (the
 * transport contract changed) rather than an empty result, so the failure
 * surfaces in the probe instead of looking like "no matches".
 */
export function parseParallel(text: string, limit: number): WebSearchSource[] {
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('Parallel did not return valid JSON')
  }
  if (typeof payload !== 'object' || payload === null) throw new Error('Parallel returned an unexpected shape')
  const results = (payload as { readonly results?: unknown }).results
  if (!Array.isArray(results)) throw new Error('Parallel response has no results field')
  const sources: WebSearchSource[] = []
  for (const raw of results as readonly ParallelResult[]) {
    if (typeof raw.url !== 'string' || raw.url === '') continue
    // `excerpts` is an array of strings; the first non-empty one is the
    // snippet, and a longer one would blow the source budget downstream.
    const excerpt = Array.isArray(raw.excerpts)
      ? raw.excerpts.find(item => typeof item === 'string' && item.trim() !== '')
      : undefined
    const published = typeof raw.publish_date === 'string' ? raw.publish_date : undefined
    sources.push(source(
      raw.url,
      typeof raw.title === 'string' ? raw.title : undefined,
      typeof excerpt === 'string' ? excerpt.slice(0, 300) : undefined,
      published,
    ))
  }
  return dedupeSources(sources, limit)
}

/** The Parallel engine. */
export function parallelEngine(): Engine {
  return {
    id: 'parallel',
    async run({ query, maxResults, signal, apiKey }: EngineRequest): Promise<WebSearchSource[]> {
      const text = await callMcpTool(
        ENDPOINT,
        TOOL,
        {
          objective: query,
          search_queries: [query],
          session_id: SESSION_ID,
        },
        signal,
        apiKey === undefined ? undefined : { 'x-api-key': apiKey },
      )
      return parseParallel(text, maxResults)
    },
  }
}
