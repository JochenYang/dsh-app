/**
 * Provider identity and price facts for the settings page.
 *
 * The host reports which providers its registry holds; this module decides
 * what to CALL each one and which ones bill. It lives outside the React
 * section so the test suite can assert it: this package's tests cannot bundle a
 * `.tsx`, and the mapping is exactly where a kernel-line move goes wrong (the
 * page kept naming two providers after the kernel started mounting three).
 *
 * An id this table does not know is deliberately still shown, under its raw
 * id: an unnamed provider the model can resolve to is worth seeing, and
 * silently dropping it is the failure mode this module exists to prevent.
 *
 * @module @dsh-app/plugin-websearch/client/providers
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS, type WebSearchKey } from './locales.ts'

/** The page's translate seat. */
type T = TranslateNS<typeof NS>

/**
 * Known provider ids as dictionary keys. `deepseek-official` is the older
 * auxiliary-model-turn route; `deepseek-search-api` is 0.2.1's direct Search
 * API provider. Both are mounted by the same kernel line, both need the same
 * `DEEPSEEK_API_KEY`, and both cost money — but not the same way, which is why
 * the label, the hint and the price line are all per id.
 */
export const PROVIDER_KEYS: Readonly<Record<string, WebSearchKey>> = {
  'dsh-app': 'ws.provider.brand',
  'deepseek-official': 'ws.provider.official',
  'deepseek-search-api': 'ws.provider.officialApi',
}

/**
 * One hint per provider: what choosing it actually does.
 *
 * Two DeepSeek cards sharing one sentence is what made the pair read as a
 * duplicate — the difference (a full model call versus a direct search
 * endpoint) is the whole reason to pick one over the other.
 */
export const PROVIDER_HINT_KEYS: Readonly<Record<string, WebSearchKey>> = {
  'dsh-app': 'ws.provider.brandHint',
  'deepseek-official': 'ws.provider.officialHint',
  'deepseek-search-api': 'ws.provider.officialApiHint',
}

/**
 * How each payable provider is charged, as its own sentence.
 *
 * The date-based price is the Search API's alone. The model-retrieval route has
 * no per-call price at all — it spends tokens — so sharing the Search API's
 * sentence (what this page used to do) told users that route was free until
 * November and would then cost 5 CNY per 1000 calls. Both halves were wrong.
 */
export const PROVIDER_PRICE_KEYS: Readonly<Record<string, WebSearchKey>> = {
  'deepseek-official': 'ws.provider.officialModelBilling',
  'deepseek-search-api': 'ws.provider.officialBilling',
}

/**
 * The label for one provider card.
 * @param id - the provider id the host reported.
 * @param t - the page's translate seat.
 * @returns the dictionary label, or the raw id when this build has no name.
 */
export function providerLabel(id: string, t: T): string {
  const key = PROVIDER_KEYS[id]
  return key === undefined ? id : t(key)
}
