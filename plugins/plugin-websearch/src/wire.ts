/**
 * Pure wiring shared by both plugin halves: the engine roster, the persisted
 * config shape, validation, and the host↔client view mapping. Zero node
 * builtins — the browser bundle imports this module directly.
 *
 * The provider id is deliberately NOT the kernel's `deepseek-official` id:
 * several search providers coexist in the registry (`deepseek-official`,
 * `deepseek-search-api`, and this one), and which of them `ctx.web` resolves to
 * is decided by the loader row — the settings page reports that, it does not
 * change it.
 *
 * @module @dsh-app/plugin-websearch/wire
 */

/** The provider id this plugin registers. Stable: it is persisted in overlay config. */
export const BRAND_PROVIDER_ID = 'dsh-app'

/**
 * The fetch provider id this plugin registers. Stable for the same reason:
 * the overlay's `web` row pins `fetchProvider` here, so a rename is a
 * coordinated overlay change, not a code-only one.
 */
export const BRAND_FETCH_PROVIDER_ID = 'dsh-app-fetch'

/**
 * The URL the settings self-check fetches to prove `web_fetch` works on the
 * current network. A neutral, tiny, always-public page: it must not depend on
 * any member engine or key, and it must be the same URL in both locales so a
 * user's screenshot is comparable.
 */
export const FETCH_PROBE_URL = 'https://example.com/'

/**
 * The DeepSeek search providers this kernel line mounts, in display order.
 *
 * Both arrive mounted from `dsh-base`'s own rows and share the
 * `DEEPSEEK_API_KEY` credential; they differ in transport:
 * `deepseek-official` spends an auxiliary model turn per search, while
 * `deepseek-search-api` calls the Search API directly (0.2.1-rc.1+).
 *
 * This is an EXPECTATION, not a fact: a patch layer may disable either row, so
 * the settings page renders one card per id here and lets the live registry
 * decide each card's state.
 */
export const UPSTREAM_PROVIDER_IDS = ['deepseek-official', 'deepseek-search-api'] as const

/** Whether an id names one of the DeepSeek providers this page can select. */
export function isUpstreamProviderId(id: unknown): id is typeof UPSTREAM_PROVIDER_IDS[number] {
  return typeof id === 'string' && (UPSTREAM_PROVIDER_IDS as readonly string[]).includes(id)
}

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

/**
 * Whether an engine can use a user-supplied key.
 *
 * - `none` — the endpoint takes no credential. Bing: its public Search API was
 *   retired on 2025-08-11 and accepts no new signups, so an input box there
 *   would be an entrance with no door. SearXNG: the instance is the
 *   credential, configured as a URL list instead.
 * - `optional` — the endpoint answers anonymously at a metered rate AND
 *   accepts a key that raises the ceiling (AnySearch, Exa, Parallel). A key is
 *   an UPGRADE, never a prerequisite, so `activeEngines` must not drop these
 *   for lacking one.
 *
 * There is deliberately no `required` level. Nothing in the roster needs one,
 * and the level would have had to decide whether a missing key may skip the
 * anonymous path — which `runWithKeys` never does (it always makes that one
 * anonymous attempt), so the level would have been a lie before it had a user.
 */
export type KeySupport = 'none' | 'optional'

/** Static description of one engine (never persisted — the roster is code). */
export interface EngineSpec {
  readonly id: EngineId
  /** Display name — a proper noun (Bing, Exa), so it needs no translation. */
  readonly label: string
  readonly keySupport: KeySupport
  /**
   * Where the user creates a key, for `optional` engines. Shown as a link
   * beside the key field. Verified live on 2026-11-12; a provider that moves
   * its console is one constant to edit.
   */
  readonly keyConsole?: string
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
  { id: 'bing', label: 'Bing', keySupport: 'none' },
  { id: 'anysearch', label: 'AnySearch', keySupport: 'optional', keyConsole: 'https://anysearch.com/console/api-keys' },
  { id: 'searxng', label: 'SearXNG', keySupport: 'none' },
  { id: 'parallel', label: 'Parallel', keySupport: 'optional', keyConsole: 'https://platform.parallel.ai/api-keys' },
  { id: 'exa', label: 'Exa', keySupport: 'optional', keyConsole: 'https://dashboard.exa.ai/api-keys' },
]

/**
 * How many keys one engine may hold.
 *
 * A bound, not a design limit: keys are tried in order and a search that walks
 * a dozen of them costs a dozen round-trips inside one tool call. Ten is far
 * more than the free tiers of three different accounts can use. Enforcement
 * lives on the WRITE path ({@link assertKeysWellFormed}) so a paste that
 * exceeds it is refused with a message; the load path only clamps, because a
 * config that cannot load must never be worse than a key that cannot
 * authenticate.
 */
export const MAX_KEYS_PER_ENGINE = 10


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
   * Keys for engines whose `keySupport` allows one, in the order to try them.
   * Each entry is either a literal or an `$ENV:NAME` reference resolved at call
   * time. Reads mask each literal to an opaque placeholder (`./keymask.ts`) so
   * a value never crosses to the client.
   *
   * More than one key is worth having only because a spent key can be swapped
   * for another MID-SEARCH (see `engines/keyring.ts`). Note what it does NOT
   * buy: every provider here meters per ACCOUNT, so keys from one account
   * share the same quota. The settings copy says so; this comment is why.
   */
  readonly apiKeys?: readonly string[]
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
    apiKeys?: readonly string[]
  } = {
    id: id as EngineId,
    enabled: raw.enabled !== false,
    priority: clampNumber(raw.priority, 0, 999, 0),
  }
  // `apiKey` is the pre-0.3 single-key field. Reading it keeps a config written
  // by an older build working; this build only ever writes `apiKeys`.
  const collected: string[] = []
  const legacy = asString(raw.apiKey)
  if (legacy !== undefined) collected.push(legacy)
  if (raw.apiKeys !== undefined) {
    if (!Array.isArray(raw.apiKeys)) throw new WebSearchValidationError('engine.keysNotArray', { id })
    for (const item of raw.apiKeys) {
      if (typeof item !== 'string') throw new WebSearchValidationError('engine.keysNotArray', { id })
      collected.push(item)
    }
  }
  const keys = splitKeys(collected.join(','))
  // The cap is CLAMPED here, not refused: this runs on the load path too, and a
  // config that throws fails to load at all (see `store.load`), which would
  // hand the user a page full of defaults and lose the keys entirely. The write
  // path refuses an oversized paste with a message instead.
  if (keys.length > 0) entry.apiKeys = keys.slice(0, MAX_KEYS_PER_ENGINE)
  return entry
}

/**
 * Split one key field into the list to store.
 *
 * Keys are separated by commas or newlines, surrounding whitespace is dropped,
 * empty entries disappear, and duplicates collapse in first-seen order. This
 * is a PARSER and nothing else: it does not reject, does not cap. Policy
 * ("these keys are malformed", "too many") belongs to
 * {@link assertKeysWellFormed}, which only the write path calls — a stored
 * value the user can no longer reach must never be able to stop the config
 * from loading.
 *
 * @param text - the raw field value.
 * @returns the keys it contains, in order.
 */
export function splitKeys(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of text.split(/[,\n\r]+/)) {
    const key = part.trim()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/**
 * A key that would fail at the endpoint for a reason the store cannot fix.
 *
 * Printable ASCII is the whole space every provider uses; anything else in a
 * key is a paste accident (a wrapped line, a full-width character, the page's
 * own mask copied out of an older build). Rejecting the whole class on the
 * write path is what keeps a look-alike from being stored as a key that can
 * only ever 401.
 */
const MALFORMED_KEY = /[^\x21-\x7E]/

/**
 * Refuse a key list that is malformed or oversized — on the write path only.
 *
 * Called by the save route with the engines array as the CLIENT sent it, before
 * any merge, because that is the only moment the raw text still exists and the
 * user is still looking at the field that produced it. A key with whitespace
 * inside it is rejected rather than trimmed: a truncated key authenticates as
 * `401` with no way to tell it apart from a revoked one, so the rejection has
 * to happen where a message can be shown.
 *
 * @param engines - the raw `engines` field of a save request, AFTER the mask
 *   has been expanded (an untouched field arrives as one masked entry, so
 *   counting before expansion would undercount by the whole stored list).
 * @throws {WebSearchValidationError} `engine.keyMalformed` or `engine.keyTooMany`.
 */
export function assertKeysWellFormed(engines: unknown): void {
  if (!Array.isArray(engines)) return
  for (const raw of engines) {
    if (!isRecord(raw)) continue
    const id = asString(raw.id) ?? ''
    const pieces: string[] = []
    const legacy = asString(raw.apiKey)
    if (legacy !== undefined) pieces.push(legacy)
    if (Array.isArray(raw.apiKeys)) {
      for (const item of raw.apiKeys) if (typeof item === 'string') pieces.push(item)
    }
    // Counted before dedupe/cap so the message can say how many were sent.
    for (const key of pieces.join(',').split(/[,\n\r]+/)) {
      const trimmed = key.trim()
      if (trimmed === '') continue
      if (MALFORMED_KEY.test(trimmed)) {
        throw new WebSearchValidationError('engine.keyMalformed', { id })
      }
    }
    const unique = new Set(pieces.join(',').split(/[,\n\r]+/).map(key => key.trim()).filter(key => key !== ''))
    if (unique.size > MAX_KEYS_PER_ENGINE) {
      throw new WebSearchValidationError('engine.keyTooMany', { id, max: MAX_KEYS_PER_ENGINE })
    }
  }
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
    // Any other id is a config this build cannot honour: fall back to the brand
    // chain rather than persisting a provider that would never resolve.
    provider: isUpstreamProviderId(provider) ? provider : BRAND_PROVIDER_ID,
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
   * ready = usable now; blocked = enabled but missing what it needs (a SearXNG
   * instance, in the current roster) with `message` saying which; disabled =
   * off; error = last probe failed; unknown = not yet determined.
   */
  readonly state: 'ready' | 'blocked' | 'disabled' | 'error' | 'unknown'
  /** Why it cannot run, in the coded shape; see {@link HostText}. */
  readonly message?: HostText
  /** Latency of the last probe, when one ran. */
  readonly latencyMs?: number
  /** Source count of the last probe. */
  readonly resultCount?: number
  /**
   * How many keys the user has configured (resolved, so an unset `$ENV:VAR`
   * does not count). Reported alongside the placeholders rather than derived
   * from them, because a placeholder list also contains readable `$ENV:`
   * references and could not be counted correctly on the client.
   */
  readonly keyCount?: number
  /**
   * `none` = no key configured and the engine runs anonymously;
   * `configured` = at least one key is usable; `exhausted` = every configured
   * key is cooling off after a quota/auth rejection, so the next search falls
   * back to anonymous until the cooldown expires.
   */
  readonly keyState?: 'none' | 'configured' | 'exhausted'
  /**
   * How many configured entries resolved to nothing — an `$ENV:` reference
   * whose variable is unset, typically. The page cannot tell on its own (it
   * would have to know which entries are references AND be able to read the
   * environment), and a user who wired a variable into their shell deserves to
   * read why their key is not being used instead of an authoritative
   * "匿名" that never mentions it.
   */
  readonly keyUnresolved?: number
}

/**
 * Availability of one provider choice, computed by the host.
 *
 * A provider can be live, selectable, or unusable — and a DeepSeek one is
 * genuinely unusable on a kernel whose loader row is disabled, or which has no
 * DeepSeek key. Without this the reader would see 官方 as a plain option with
 * no explanation for why it is not answering.
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

/** Prefix of the placeholder the client sees in place of a stored key value. */
export const VALUE_MASK = '••••••'

/**
 * Whether a stored entry is a usable `$ENV:NAME` reference.
 *
 * Strict on purpose, and shared by everything that has to agree about it: the
 * resolver only substitutes a well-formed reference, so a hand-edited
 * `$ENV:MY KEY` is a literal string that will authenticate nowhere. Using a
 * loose prefix test here would hide that from the page and count it as fine.
 */
export const ENV_REFERENCE = /^\$ENV:([A-Za-z_][A-Za-z0-9_]*)$/

/**
 * The shape of a stored-key placeholder: the mask prefix plus a short reference
 * derived from the value (see `keymask.ts`) — never the value itself.
 *
 * The reference is what makes a chip deletable. A placeholder that carried only
 * "there is a stored key here" forced positional reconstruction, which can only
 * ever drop the LAST stored key: the page shows indistinguishable chips, so the
 * user's click removes one — just not necessarily a different one when it is
 * mixed with `$ENV:` entries, where the swap became visible.
 */
const STORED_TOKEN = /^•+#[0-9a-f]{8}$/

/**
 * Whether one `apiKeys` entry is a placeholder for a stored literal key.
 *
 * Exported because the page renders one chip per entry and has to tell a
 * placeholder from a readable reference without knowing the pattern.
 *
 * @param value - one `apiKeys` entry as the client received it.
 */
export function isStoredKeyToken(value: string): boolean {
  return STORED_TOKEN.test(value)
}

/**
 * The engines the chain will actually try, in priority order.
 *
 * Filtering happens here rather than at call time so the attempt list is
 * inspectable in the UI: an engine that cannot succeed is dropped instead of
 * being attempted and failing on every search. Two reasons to drop one:
 * disabled by the user, and SearXNG with no instance configured (it has no
 * working default — public instances disabled the JSON API — so attempting it
 * only spends a round-trip and adds noise to the fallback note).
 *
 * A missing KEY is deliberately not a reason: every engine that accepts one
 * also answers anonymously.
 */
export function activeEngines(file: WebSearchFile): EngineEntry[] {
  return [...file.engines]
    .filter(entry => entry.enabled)
    .filter((entry) => {
      const spec = engineSpec(entry.id)
      if (spec === undefined) return false
      if (entry.id === 'searxng') return file.searxngInstances.length > 0
      return true
    })
    .sort((a, b) => a.priority - b.priority)
}

/** Why one engine cannot run right now, or undefined when it can. */
export function engineBlockReason(
  entry: EngineEntry,
  searxngInstanceCount = 0,
): HostText | undefined {
  if (!entry.enabled) return { code: 'engine.disabled', params: { id: entry.id } }
  const spec = engineSpec(entry.id)
  if (spec === undefined) return { code: 'engine.unknown', params: { id: entry.id } }
  if (entry.id === 'searxng' && searxngInstanceCount === 0) {
    return { code: 'engine.missingInstance', params: { label: spec.label } }
  }
  return undefined
}
