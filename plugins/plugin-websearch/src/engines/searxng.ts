/**
 * SearXNG — a meta-search front end. This engine talks to the JSON API
 * (`/search?format=json`), which is what makes it usable without HTML
 * scraping.
 *
 * IMPORTANT deployment fact, verified against the public instances: most
 * public SearXNG deployments disable the JSON API (it is off by default
 * upstream, since it makes the instance trivially scrapable). A disabled API
 * answers HTTP 200 with the HTML page, not JSON, so a "successful" request
 * still yields nothing. This engine therefore ships with NO default instance
 * and reports a configuration error until the user supplies one — the
 * alternative (shipping a list of public instances that all return HTML)
 * would produce a permanent "0 results" row in the UI with no visible cause.
 *
 * Users with their own instance add it in the settings page; a self-hosted
 * SearXNG with `search.formats: [json]` is the intended deployment.
 *
 * @module @dsh-app/plugin-websearch/engines/searxng
 */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'
import type { Engine, EngineRequest } from './types.ts'
import { dedupeSources, request, source } from './types.ts'

/** One instance's JSON payload, narrowed defensively (it is untrusted input). */
interface SearxngPayload {
  readonly results?: readonly {
    readonly url?: unknown
    readonly title?: unknown
    readonly content?: unknown
  }[]
}

/**
 * Parse one SearXNG JSON payload into sources. Exported for parser tests.
 * Returns an empty list for a well-formed payload with no results; throws for
 * a payload that is not the API shape at all (the HTML-page case above).
 */
export function parseSearxng(payload: unknown, limit: number): WebSearchSource[] {
  if (typeof payload !== 'object' || payload === null) throw new Error('响应不是 JSON 对象')
  const results = (payload as SearxngPayload).results
  if (!Array.isArray(results)) {
    throw new Error('响应缺少 results 字段（该实例可能未启用 JSON API）')
  }
  const sources: WebSearchSource[] = []
  for (const item of results) {
    if (typeof item.url !== 'string' || item.url === '') continue
    sources.push(source(
      item.url,
      typeof item.title === 'string' ? item.title : undefined,
      typeof item.content === 'string' ? item.content : undefined,
    ))
  }
  return dedupeSources(sources, limit)
}

/**
 * The SearXNG engine over an ordered instance list. Instances are tried in
 * order; the first one that returns results wins. A failing instance never
 * aborts the list — the aggregate error names every instance's reason so a
 * misconfigured list is diagnosable from one message.
 */
export function searxngEngine(instances: readonly string[]): Engine {
  return {
    id: 'searxng',
    async run({ query, maxResults, signal }: EngineRequest): Promise<WebSearchSource[]> {
      if (instances.length === 0) {
        throw new Error('未配置 SearXNG 实例（公共实例多数已禁用 JSON API，请在设置页填入自建实例地址）')
      }
      const failures: string[] = []
      for (const base of instances) {
        const trimmed = base.trim().replace(/\/+$/, '')
        if (trimmed === '') continue
        try {
          const params = new URLSearchParams({ q: query, format: 'json' })
          const payload = await request(`${trimmed}/search?${params}`, {
            headers: { accept: 'application/json' },
            signal,
          }).then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return await response.json() as unknown
          })
          const sources = parseSearxng(payload, maxResults)
          if (sources.length > 0) return sources
          failures.push(`${trimmed}: 0 条结果`)
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') throw error
          failures.push(`${trimmed}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      throw new Error(`所有 SearXNG 实例均失败（${failures.join('；')}）`)
    },
  }
}
