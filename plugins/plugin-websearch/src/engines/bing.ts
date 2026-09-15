/**
 * Bing — scrapes the public results page. Free, no key, and the best Chinese
 * result quality of the keyless engines, which makes it the default first
 * engine in the chain.
 *
 * Scraping contract: `li.b_algo` is Bing's result container. The parser is
 * deliberately tolerant (a missing title or snippet yields a source without
 * it rather than dropping the result), because Bing's markup varies by market
 * and A/B bucket. When Bing changes the container class the parser returns an
 * empty list and the chain falls through — that failure mode is visible in
 * the settings page's probe, not silent.
 *
 * @module @dsh-app/plugin-websearch/engines/bing
 */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'
import type { Engine, EngineRequest } from './types.ts'
import { dedupeSources, requestText, source, stripTags, USER_AGENT } from './types.ts'

const ENDPOINT = 'https://www.bing.com/search'

/** Bing market + Accept-Language pairs. `mkt` drives result localization. */
const LANG_PROFILES: Readonly<Record<string, { readonly market: string, readonly acceptLang: string }>> = {
  zh: { market: 'zh-CN', acceptLang: 'zh-CN,zh;q=0.9,en;q=0.8' },
  en: { market: 'en-US', acceptLang: 'en-US,en;q=0.9' },
  ja: { market: 'ja-JP', acceptLang: 'ja-JP,ja;q=0.9,en;q=0.8' },
}

/**
 * Parse one Bing result page into sources. Exported for the parser tests:
 * they run against a saved fixture, so a Bing markup change fails a test
 * instead of silently emptying every search.
 */
export function parseBing(html: string, limit: number): WebSearchSource[] {
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? []
  const sources: WebSearchSource[] = []
  for (const block of blocks) {
    const href = /<a[^>]*href="(https?:\/\/[^"]+)"/.exec(block)
    if (href === null) continue
    const title = /<h2[^>]*>[\s\S]*?<a[^>]*>(.*?)<\/a>[\s\S]*?<\/h2>/.exec(block)
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block)
    sources.push(source(
      href[1],
      title === null ? undefined : stripTags(title[1]),
      snippet === null ? undefined : stripTags(snippet[1]),
    ))
  }
  return dedupeSources(sources, limit)
}

/** Bing's public page rejects the anonymous fetch UA, so a browser UA is required. */
function headers(lang: string): Record<string, string> {
  const profile = LANG_PROFILES[lang] ?? LANG_PROFILES.zh
  return { 'user-agent': USER_AGENT, 'accept-language': profile.acceptLang }
}

/** The Bing engine. `lang` selects the market profile. */
export function bingEngine(lang = 'zh'): Engine {
  const profile = LANG_PROFILES[lang] ?? LANG_PROFILES.zh
  return {
    id: 'bing',
    async run({ query, maxResults, signal }: EngineRequest): Promise<WebSearchSource[]> {
      const params = new URLSearchParams({ q: query, mkt: profile.market, adlt: 'off' })
      const html = await requestText(`${ENDPOINT}?${params}`, { headers: headers(lang), signal })
      return parseBing(html, maxResults)
    },
  }
}
