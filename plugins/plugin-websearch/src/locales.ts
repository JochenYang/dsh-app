/**
 * Provider metadata for the kernel's own provider pickers.
 *
 * Why this is a dictionary module rather than a literal next to each provider:
 * `web`'s `WebSearchProvider` / `WebFetchProvider` take a `title` and a
 * `description` (`LocalizedText`, English required), which the kernel's Web search
 * page renders. That is user-visible copy, and this repository keeps such copy in
 * a dictionary — `scripts/check-plugin-graph.mjs` refuses Han characters anywhere
 * under `plugins/*​/src` except a `locale(s).ts` file.
 *
 * @module @dsh-app/plugin-websearch/locales
 */

/** The suite's provider name in both pickers. */
export const PROVIDER_TITLE = 'DSH APP'

/** What the search provider is: the suite's engine chain, not one engine. */
export const SEARCH_PROVIDER_DESCRIPTION = {
  en: 'The suite engine chain: anysearch, bing, parallel, exa and a SearXNG instance list, tried in order with automatic fallback.',
  zh: '套件自带的引擎链：anysearch、bing、parallel、exa 与自填的 SearXNG 实例，按顺序尝试并自动回退。',
} as const

/** What the fetch provider adds over the host's own fetcher. */
export const FETCH_PROVIDER_DESCRIPTION = {
  en: 'Resolves through the injected proxy when one applies, skips fake-IP answers from a TUN client, and falls back to DNS-over-HTTPS when a canary probes it as poisoned.',
  zh: '走注入的代理（有的话），识别 TUN 客户端给出的假 IP 并跳过，DNS 被污染时回退到 DoH。',
} as const
