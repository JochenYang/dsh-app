/**
 * models.dev data source for one-click import. The feed is used as FORM
 * PREFILL, never as a runtime catalog: what lands in settings stays a plain
 * `llm-pi-ai` route the official pipeline resolves — no adapter
 * registration, no route-key conflicts, no runtime compat mirroring.
 *
 * Field mapping follows the retrofit report §5.3:
 *   id/name → id/name; limit.context → contextWindow; limit.output → maxTokens;
 *   modalities.input ⊇ image → [text, image]; reasoning + option values →
 *   reasoningEfforts (value IS the wire spelling); tool_call !== true is
 *   skipped (dsh runs with tool calling on); cost and the rest are dropped —
 *   the dsh chain never consumes them.
 */

import type { ModelDraft } from './fields.ts'

/** The public feed (one JSON document, every provider). */
const MODELS_DEV_URL = 'https://models.dev/api.json'

/** One models.dev model entry (defensively typed — the feed is external). */
export interface ModelsDevModel {
  id?: string
  name?: string
  limit?: { context?: number; output?: number }
  modalities?: { input?: string[] }
  reasoning?: boolean
  reasoning_options?: unknown
  tool_call?: boolean
}

/** One models.dev provider entry. */
export interface ModelsDevProvider {
  /** Provider key (e.g. `opencode`). */
  id: string
  /** The AI-SDK npm package marker (protocol hint, display only). */
  npm?: string
  /** Provider-declared base url, shown as a baseURL prefill hint. */
  api?: string
  models: Record<string, ModelsDevModel>
}

/** The feed document, provider-keyed. */
export type ModelsDevApi = Record<string, Omit<ModelsDevProvider, 'id' | 'models'> & { models?: Record<string, ModelsDevModel> }>

/**
 * Fetch and minimally normalize the feed.
 * @returns providers in feed order.
 * @throws on network or CORS failure — the caller shows the manual fallback.
 */
export async function fetchModelsDev(): Promise<ModelsDevProvider[]> {
  const response = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`models.dev HTTP ${String(response.status)}`)
  const data: unknown = await response.json()
  if (typeof data !== 'object' || data === null) throw new Error('models.dev 返回格式异常')
  const providers: ModelsDevProvider[] = []
  for (const [id, entry] of Object.entries(data as ModelsDevApi)) {
    if (typeof entry !== 'object' || entry === null) continue
    providers.push({ id, npm: entry.npm, api: entry.api, models: entry.models ?? {} })
  }
  return providers
}

/**
 * Providers matching a free-text query (id, npm marker, or base url;
 * case-insensitive substring). An empty query matches nothing — the caller
 * asks for a query before searching.
 */
export function searchProviders(providers: readonly ModelsDevProvider[], query: string): ModelsDevProvider[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  return providers.filter(provider => {
    const haystack = [provider.id, provider.npm ?? '', provider.api ?? ''].join(' ').toLowerCase()
    return haystack.includes(needle)
  })
}

/**
 * Parse `reasoning_options` into the level list it carries. The feed's real
 * shape is an array of typed option objects (`{type:'effort',values:[…]}`,
 * `{type:'toggle'}`, `{type:'budget_tokens',…}`); a bare string array and a
 * single `{values}` object are accepted defensively. `none` normalizes to
 * the `off` level (that is its meaning; the wire spelling stays `none`).
 */
function optionLevels(options: unknown): string[] {
  const collect = (values: unknown, out: string[]): void => {
    if (!Array.isArray(values)) return
    for (const value of values) {
      if (typeof value !== 'string') continue
      out.push(value === 'none' ? 'off' : value)
    }
  }
  const out: string[] = []
  if (Array.isArray(options)) {
    for (const entry of options) {
      if (typeof entry === 'string') {
        collect([entry], out)
      } else if (typeof entry === 'object' && entry !== null) {
        collect((entry as { values?: unknown }).values, out)
      }
    }
  } else if (typeof options === 'object' && options !== null) {
    collect((options as { values?: unknown }).values, out)
  }
  const unique = [...new Set(out)]
  // Only spellings pi-ai can address are offered; anything else would fail
  // the write with an unknown-level diagnostic.
  const known = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  return unique.filter(level => known.includes(level))
}

/**
 * Map one feed entry into this page's draft. `undefined` = skip (the entry
 * states it cannot call tools, which dsh requires).
 */
export function mapModel(id: string, entry: ModelsDevModel): ModelDraft | undefined {
  if (entry.tool_call === false) return undefined
  const draft: ModelDraft = { id }
  if (typeof entry.name === 'string' && entry.name.length > 0) draft.name = entry.name
  const context = entry.limit?.context
  if (typeof context === 'number' && Number.isSafeInteger(context) && context > 0) {
    draft.contextWindow = context
  }
  const output = entry.limit?.output
  if (typeof output === 'number' && Number.isSafeInteger(output) && output > 0) {
    draft.maxTokens = output
  }
  const input = entry.modalities?.input
  if (Array.isArray(input) && input.includes('image')) draft.input = ['text', 'image']
  if (entry.reasoning === true) {
    const levels = optionLevels(entry.reasoning_options)
    if (levels.length > 0) {
      // The feed's values are both the offered level and its wire spelling,
      // except that `none` was normalized to the `off` level above — its
      // wire spelling stays the feed's own word.
      draft.reasoningEfforts = Object.fromEntries(
        levels.map(level => [level, level === 'off' ? 'none' : level]),
      )
    }
    // Reasoning with no listed levels writes NOTHING: the adapter requires
    // a dict to offer at least one non-off level, and `off` alone is the
    // illegal shape it rejects. Absent means "not thinking" — legal, and
    // the user can add real levels per model once the gateway documents
    // its spellings.
  }
  return draft
}

/** Map one provider's models, preserving feed order, skipping unusable ones. */
export function mapProviderModels(provider: ModelsDevProvider): { id: string; draft: ModelDraft }[] {
  const mapped: { id: string; draft: ModelDraft }[] = []
  for (const [key, entry] of Object.entries(provider.models)) {
    const draft = mapModel(entry.id ?? key, entry)
    if (draft !== undefined) mapped.push({ id: entry.id ?? key, draft })
  }
  return mapped
}
