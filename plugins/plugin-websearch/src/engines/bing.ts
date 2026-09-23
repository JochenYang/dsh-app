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
import { dedupeSources, request, source, stripTags, USER_AGENT } from './types.ts'

const ENDPOINT = 'https://www.bing.com/search'

/**
 * Where the zh market's request ends up, measured rather than guessed:
 * `www.bing.com/search?…&mkt=zh-CN` answers `302 → cn.bing.com/search?…`.
 *
 * That redirect is why the settings page's probe can report a bare "HTTP 302"
 * while the page is perfectly reachable — measured on this machine, the local
 * proxy returns responses with NO headers at all, so `Location` is gone, undici
 * has nothing to follow, and the engine gives up on the 302. Direct, the same
 * request is 200 with ten result blocks. The retry below is the host Bing itself
 * named.
 */
const ZH_REDIRECT_HOST = 'https://cn.bing.com/search'

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
      const first = await request(`${ENDPOINT}?${params}`, { headers: headers(lang), signal })
      if (first.ok) return parseBing(await first.text(), maxResults)
      // A redirect we could not follow — see {@link ZH_REDIRECT_HOST}. Only the zh
      // market has a measured target, so the others report the status as before.
      if (first.status >= 300 && first.status < 400 && lang === 'zh') {
        const second = await request(`${ZH_REDIRECT_HOST}?${params}`, { headers: headers(lang), signal })
        if (second.ok) return parseBing(await second.text(), maxResults)
        throw new Error(`HTTP ${second.status}`)
      }
      throw new Error(`HTTP ${first.status}`)
    },
  }
}
