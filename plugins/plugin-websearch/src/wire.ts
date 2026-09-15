/**
 * Pure wiring shared by both plugin halves: the engine roster, the persisted
 * config shape, validation, and the host↔client view mapping. Zero node
 * builtins — the browser bundle imports this module directly.
 *
 * The provider id is deliberately NOT the upstream `deepseek-official` id:
 * the two providers coexist in the registry, and the settings page switches
 * which one `ctx.web.searchProvider` points at.
 *
 * @module @dsh-app/plugin-websearch/wire
 */

/** The provider id this plugin registers. Stable: it is persisted in overlay config. */
export const BRAND_PROVIDER_ID = 'dsh-app'

/** The upstream DeepSeek provider id (the "原生" switch). */
export const UPSTREAM_PROVIDER_ID = 'deepseek-official'

/** The upstream anonymous fetch provider id. */
export const UPSTREAM_FETCH_ID = 'http'

/**
 * Engine ids, in the default priority order.
 *
 * Ordering is decided by a 5-query head-to-head against the live endpoints,
 * covering the cases this tool is actually used for (Chinese long-tail
 * research, short factual lookups, English technical queries):
 *
 * - `anysearch` leads: it stayed on target across EVERY tested query,
 *   including the long-tail Chinese ones where Bing collapsed to generic
 *   results. It is a keyless JSON API (no HTML scraping to break) and returns
 *   snippets, which `web_search` renders. Cost: ~2-3s per query versus Bing's
 *   ~0.5s, paid once per uncached query.
 * - `bing` second: still the right answer for short queries and English
 *   technical queries (it returned github.com for a vLLM query where
 *   AnySearch returned forum threads), and it is the faster of the two. When
 *   it degrades it degrades into unrelated content — see the note below — so
 *   it is a strong second, not a first.
 * - `parallel` then `exa`: hosted endpoints that meter usage, kept as
 *   backstops so the free engines absorb the volume. Parallel ranks above Exa
 *   because a full 4-engine comparison put it ahead on both axes: it was
 *   faster (1958ms average vs 3070ms) and better on the queries that matter —
 *   for `怎么在 Windows 上配置 vLLM 双卡推理` it returned docs.vllm.ai three
 *   times over, where Exa returned jishuzhan.net / cloud.baidu.com / framerc.cn
 *   and Bing returned Baidu Baike plus a Chinese-grammar site. Exa also
 *   produced a spam-looking hit (npo00410y.npoall.com) on the news query.
 * - `searxng` LAST: it requires a SELF-HOSTED instance (public ones disabled
 *   the JSON API and serve an anti-bot page instead), so it cannot run at all
 *   until the user configures one. Ordering it ahead of working engines would
 *   spend a guaranteed failure on every search.
 *
 * All four engines answered 5/5 with 5 results and snippets each, so the
 * ordering reflects QUALITY and LATENCY, not reliability. Average latency
 * across the same five queries: Bing 958ms, Parallel 1958ms, AnySearch
 * 2543ms, Exa 3070ms.
 *
 * Why Bing is not first, in one example: for `成都今天天气 实时` it returned
 * baike.baidu.com and Zhihu travel guides, while AnySearch, Exa and Parallel
 * all returned weather.com.cn / nmc.cn. The same query shortened to `成都天气`
 * made Bing behave. So Bing is not broken — it degrades on long queries, and
 * long queries are what an agent actually issues.
 *
 * DuckDuckGo's two surfaces were removed: proxied-only from the mainland AND
 * rate-limited with an anti-bot page for hours at a time, so they added a
 * guaranteed failure to every chain they were in.
 */
export const ENGINE_IDS = ['anysearch', 'bing', 'parallel', 'exa', 'searxng'] as const

/** One engine id. */
export type EngineId = (typeof ENGINE_IDS)[number]

/** Whether an engine needs a user-supplied key. */
export type EngineTier = 'free' | 'key'

/** Static description of one engine (never persisted — the roster is code). */
export interface EngineSpec {
  readonly id: EngineId
  /** Display name — a proper noun (Bing, Exa), so it needs no translation. */
  readonly label: string
  readonly tier: EngineTier
}

/**
 * A user-visible message the host cannot localize — and deliberately does not
 * try to.
 *
 * The host is a long-lived child process: its language would be decided at
 * boot, so switching the UI language would require restarting the kernel. It
 * therefore never sends prose. It sends a stable code plus the values the
 * sentence interpolates, and the client — which owns the locale namespace —
 * renders it. `text` is an ENGLISH diagnostic used only for a code this client
 * does not know (an older UI beside a newer kernel); it is never a localized
 * sentence, because matching on one across a boundary is how the kernel-side
 * failure classifier once misread "tampered" as "network error".
 */
export interface HostText {
  readonly code: string
  readonly params?: Readonly<Record<string, string | number>>
  /** English developer-facing fallback; shown only for an unknown code. */
  readonly text?: string
}

/** The engine roster. Order here is documentation only; priority is per-user. */
export const ENGINE_SPECS: readonly EngineSpec[] = [
  { id: 'bing', label: 'Bing', tier: 'free' },
  { id: 'anysearch', label: 'AnySearch', tier: 'free' },
  { id: 'searxng', label: 'SearXNG', tier: 'free' },
  { id: 'parallel', label: 'Parallel', tier: 'free' },
  { id: 'exa', label: 'Exa', tier: 'free' },
]


/** Look up one engine's static spec. */
export function engineSpec(id: string): EngineSpec | undefined {
  return ENGINE_SPECS.find(spec => spec.id === id)
}

/**
 * Validation failure of a settings-page write (routes map it to 400).
 *
 * Carries a code plus its params rather than a sentence: the client renders
 * the copy, and `super()` keeps an English developer-facing message for logs
 * and for the wire's diagnostic field.
 */
export class WebSearchValidationError extends Error {
  /**
   * @param code - stable message code (see the `ws.host.*` keys).
   * @param params - values the client's copy interpolates.
   */
  constructor(readonly code: string, readonly params?: Readonly<Record<string, string | number>>) {
    super(`websearch config rejected: ${code}`)
    this.name = 'WebSearchValidationError'
  }

  /** The coded message, in the shape every host route speaks. */
  hostText(): HostText {
    return this.params === undefined ? { code: this.code } : { code: this.code, params: this.params }
  }
}

/** Fallback strategy when the preferred engine fails. */
export type ChainMode = 'fallback' | 'rotate'

/** Per-engine user state. */
export interface EngineEntry {
  readonly id: EngineId
  readonly enabled: boolean
  /** Ascending: lower runs first. */
  readonly priority: number
  /**
   * Key for `key`-tier engines. `$ENV:NAME` references are resolved at call
   * time; literal values are stored but never returned to the client (routes
   * mask them).
   */
  readonly apiKey?: string
}

/** The persisted config file shape. */
export interface WebSearchFile {
  readonly version: 1
  /** Master switch: false makes the provider report itself unavailable. */
  readonly enabled: boolean
  /**
   * Which provider `ctx.web.searchProvider` points at. `dsh-app` = this
   * plugin's chain; `deepseek-official` = the upstream DeepSeek search.
   */
  readonly provider: string
  readonly mode: ChainMode
  /** Cooperative per-search budget in ms; the chain stops trying engines past it. */
  readonly timeoutMs: number
  /** Result cache TTL in minutes; 0 disables caching. */
  readonly cacheTtlMinutes: number
  /** Upper bound on sources returned per search. */
  readonly maxResults: number
  /** Engine order + enablement + keys. */
  readonly engines: readonly EngineEntry[]
  /**
   * SearXNG instance base URLs, tried in order. Empty by default on purpose:
   * most public instances disable the JSON API, so a shipped list would show
   * as a permanently failing engine. A self-hosted instance is the intended
   * configuration.
   */
  readonly searxngInstances: readonly string[]
}

/** Default config: free engines first, then the two hosted MCP endpoints. */
export function defaultFile(): WebSearchFile {
  return {
    version: 1,
    enabled: true,
    provider: BRAND_PROVIDER_ID,
    mode: 'fallback',
    timeoutMs: 25_000,
    cacheTtlMinutes: 5,
    maxResults: 10,
    engines: ENGINE_IDS.map((id, index) => ({ id, enabled: true, priority: index })),
    searxngInstances: [],
  }
}

type Raw = Record<string, unknown>

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Clamp an unknown number into a range, falling back on non-finite input. */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.floor(value), min), max)
}

/**
 * Validate one raw engine entry. Unknown ids are rejected (the roster is
 * code, not user data) so a hand-edited typo surfaces instead of silently
 * disabling a search path.
 */
export function validateEngine(raw: unknown, seen: ReadonlySet<string>): EngineEntry {
  if (!isRecord(raw)) throw new WebSearchValidationError('engine.notObject')
  const id = asString(raw.id)
  if (id === undefined || !(ENGINE_IDS as readonly string[]).includes(id)) {
    throw new WebSearchValidationError('engine.unknownId', { id: String(raw.id) })
  }
  if (seen.has(id)) throw new WebSearchValidationError('engine.duplicate', { id })
  const entry: {
    id: EngineId
    enabled: boolean
    priority: number
    apiKey?: string
  } = {
    id: id as EngineId,
    enabled: raw.enabled !== false,
    priority: clampNumber(raw.priority, 0, 999, 0),
  }
  const apiKey = asString(raw.apiKey)
  if (apiKey !== undefined && apiKey.trim() !== '') entry.apiKey = apiKey.trim()
  return entry
}

/**
 * Validate a whole config object into a {@link WebSearchFile}, filling gaps
 * from the defaults. Throws {@link WebSearchValidationError} with a code —
 * used both for route writes (400) and load-time degradation.
 */
export function validateFile(raw: unknown): WebSearchFile {
  const base = defaultFile()
  if (!isRecord(raw)) throw new WebSearchValidationError('config.notObject')

  const seen = new Set<string>()
  const engines: EngineEntry[] = []
  if (raw.engines !== undefined) {
    if (!Array.isArray(raw.engines)) throw new WebSearchValidationError('engines.notArray')
    for (const item of raw.engines) {
      const entry = validateEngine(item, seen)
      seen.add(entry.id)
      engines.push(entry)
    }
  }
  // Engines absent from the file (a config written by an older build, or a
  // hand-trimmed file) join at the end, enabled — a missing row must never
  // silently remove a search path.
  for (const id of ENGINE_IDS) {
    if (seen.has(id)) continue
    engines.push({ id, enabled: true, priority: engines.length })
  }
  engines.sort((a, b) => a.priority - b.priority)

  const provider = asString(raw.provider)
  const mode = asString(raw.mode)
  const searxngInstances: string[] = []
  if (raw.searxngInstances !== undefined) {
    if (!Array.isArray(raw.searxngInstances)) throw new WebSearchValidationError('searxng.notArray')
    for (const item of raw.searxngInstances) {
      if (typeof item !== 'string') throw new WebSearchValidationError('searxng.notArray')
      const trimmed = item.trim()
      if (trimmed === '') continue
      if (!/^https?:\/\//.test(trimmed)) {
        throw new WebSearchValidationError('searxng.notHttp', { url: trimmed })
      }
      searxngInstances.push(trimmed)
    }
  }
  return {
    version: 1,
    enabled: raw.enabled !== false,
    provider: provider === UPSTREAM_PROVIDER_ID ? UPSTREAM_PROVIDER_ID : BRAND_PROVIDER_ID,
    mode: mode === 'rotate' ? 'rotate' : 'fallback',
    timeoutMs: clampNumber(raw.timeoutMs, 3_000, 120_000, base.timeoutMs),
    cacheTtlMinutes: clampNumber(raw.cacheTtlMinutes, 0, 60, base.cacheTtlMinutes),
    maxResults: clampNumber(raw.maxResults, 1, 50, base.maxResults),
    engines,
    searxngInstances,
  }
}

/** One engine's live status, computed by the host. */
export interface EngineStatus {
  /**
   * ready = usable now; blocked = enabled but missing what it needs (an API
   * key, or a SearXNG instance) with `message` saying which; disabled = off;
   * error = last probe failed; unknown = not yet determined.
   */
  readonly state: 'ready' | 'blocked' | 'disabled' | 'error' | 'unknown'
  /** Why it cannot run, in the coded shape; see {@link HostText}. */
  readonly message?: HostText
  /** Latency of the last probe, when one ran. */
  readonly latencyMs?: number
  /** Source count of the last probe. */
  readonly resultCount?: number
}

/**
 * Availability of one provider choice, computed by the host.
 *
 * The 原生/品牌 switch needs more than a binary on/off. A provider can be
 * selected, selectable, or unusable — and the upstream one is genuinely
 * unusable on a kernel whose `web-search-deepseek` row is disabled, or which
 * has no DeepSeek key. Without this the user would see 官方 as a plain option,
 * pick it, and get a bare failure with no explanation.
 */
export interface ProviderStatus {
  /** The provider id (`dsh-app` or `deepseek-official`). */
  readonly id: string
  /** Whether the id is currently selected in `ctx.web`. */
  readonly selected: boolean
  /**
   * `ready` = confirmed usable; `unavailable` = confirmed unusable;
   * `unknown` = the host could not determine (never rendered as a green badge,
   * because claiming a provider works without evidence is the exact failure
   * this field exists to prevent).
   */
  readonly state: 'ready' | 'unavailable' | 'unknown'
  /** Coded explanation, present whenever the state is not `ready`. */
  readonly reason?: HostText
}

/** The client-facing config view: the file plus per-engine status. */
export interface WebSearchView {
  readonly file: WebSearchFile
  readonly engines: readonly (EngineSpec & { readonly entry: EngineEntry, readonly status: EngineStatus })[]
  /** The provider id `ctx.web` currently resolves to (may differ from the file). */
  readonly activeProvider: string
  /**
   * Both provider choices with their real availability. The UI renders these
   * instead of assuming either side works.
   */
  readonly providers: readonly ProviderStatus[]
  readonly filePath: string
  /** False when the kernel has no `ctx.web` seam to register into. */
  readonly seamAvailable: boolean
}

/** Mask sentinel for secret values on reads; on writes it means "keep stored". */
export const VALUE_MASK = '••••••'

/**
 * Mask literal keys before they cross to the client. `$ENV:NAME` references
 * stay verbatim (they are not secrets, and the UI shows which variable is
 * referenced).
 */
export function maskEngines(engines: readonly EngineEntry[]): EngineEntry[] {
  return engines.map((entry) => {
    if (entry.apiKey === undefined) return { ...entry }
    return { ...entry, apiKey: /^\$ENV:/.test(entry.apiKey) ? entry.apiKey : VALUE_MASK }
  })
}

/** Re-attach stored keys where the client sent the mask sentinel back. */
export function unmaskEngines(raw: unknown, existing: readonly EngineEntry[]): unknown {
  if (!Array.isArray(raw)) return raw
  const stored = new Map(existing.map(entry => [entry.id, entry.apiKey]))
  return raw.map((item) => {
    if (!isRecord(item)) return item
    if (item.apiKey !== VALUE_MASK) return item
    const kept = typeof item.id === 'string' ? stored.get(item.id as EngineId) : undefined
    if (kept === undefined) {
      throw new WebSearchValidationError('engine.keyMasked', { id: String(item.id) })
    }
    return { ...item, apiKey: kept }
  })
}

/**
 * The engines the chain will actually try, in priority order. Disabled
 * engines and `key`-tier engines without a key are dropped here rather than
 * at call time, so the chain's attempt list is inspectable in the UI.
 */
/**
 * The engines the chain will actually try, in priority order.
 *
 * Filtering happens here rather than at call time so the attempt list is
 * inspectable in the UI: an engine that cannot succeed is dropped instead of
 * being attempted and failing on every search. Three reasons to drop one:
 * disabled by the user, a `key`-tier engine with no key, and SearXNG with no
 * instance configured (it has no working default — public instances disabled
 * the JSON API — so attempting it only spends a round-trip and adds noise to
 * the fallback note).
 */
export function activeEngines(file: WebSearchFile): EngineEntry[] {
  return [...file.engines]
    .filter(entry => entry.enabled)
    .filter((entry) => {
      const spec = engineSpec(entry.id)
      if (spec === undefined) return false
      if (spec.tier === 'key') return entry.apiKey !== undefined && entry.apiKey !== ''
      if (entry.id === 'searxng') return file.searxngInstances.length > 0
      return true
    })
    .sort((a, b) => a.priority - b.priority)
}

/** Why one engine cannot run right now, or undefined when it can. */
export function engineBlockReason(
  entry: EngineEntry,
  resolvedKey: string | undefined,
  searxngInstanceCount = 0,
): HostText | undefined {
  if (!entry.enabled) return { code: 'engine.disabled', params: { id: entry.id } }
  const spec = engineSpec(entry.id)
  if (spec === undefined) return { code: 'engine.unknown', params: { id: entry.id } }
  if (spec.tier === 'key' && (resolvedKey === undefined || resolvedKey === '')) {
    return { code: 'engine.missingKey', params: { label: spec.label } }
  }
  if (entry.id === 'searxng' && searxngInstanceCount === 0) {
    return { code: 'engine.missingInstance', params: { label: spec.label } }
  }
  return undefined
}
