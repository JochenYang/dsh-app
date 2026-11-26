/**
 * The market bridge: ONE model-facing tool that searches the market's two
 * catalogs, so a user who asks for "a skill that does X" or "a plugin that
 * does Y" gets real, installable hits instead of the model's recollection.
 *
 * Two sources, deliberately different in kind:
 *
 *   - **skills** come from the live SkillHub catalog (`searchSkills`, see
 *     skills.ts). That search is SERVER-SIDE and therefore needs the network;
 *     there is no local index to fall back on, and a transport failure is
 *     reported as a per-source `failures` entry rather than as an empty list —
 *     "nothing matches" and "I could not look" must not read the same.
 *   - **plugins** come from the SAME catalog the panel renders, through the
 *     same `resolveCatalog` chain (fresh cache → live fetch → stale cache →
 *     bundled snapshot), so the tool can still answer offline from the
 *     snapshot. Matching reuses {@link searchEntries}, the weighted ranker the
 *     panel's own search box uses, so the tool and the UI never disagree about
 *     what matches.
 *
 * Read-only by design. Installing is a supply-chain action that belongs to the
 * user's own click in the panel; the tool reports an entry's install shape and
 * whether it is already installed, and never installs anything itself.
 *
 * Every failure is a coded value or an English diagnostic in the result body —
 * never a thrown error — so a broken source degrades to one `failures` row
 * instead of a dead tool call.
 *
 * @module @dsh-app/plugin-market/bridge
 */

import { join } from 'node:path'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { INSTALL_CONSENT_RULE, INSTALL_RESTART_RULE } from './install-consent.ts'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the systemPrompt Context merge (ctx.systemPrompt) into
// scope (ctx.tools rides the dsh-tools import above).
import type {} from '@deepseek-ai/dsh-system-prompt'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { searchEntries } from './catalog-filter.ts'
import type { CatalogEntry } from './catalog.ts'
import {
  cachePayload,
  catalogBuildOf,
  isCacheFresh,
  isTruncatedCache,
  readInstalled,
  refreshCatalogBehind,
  type CatalogPayload,
  type CatalogRefreshRequest,
  type CatalogResolution,
} from './routes.ts'
import type { CatalogHold } from './install-intent.ts'
import { listInstalledSkills, searchSkills, type SkillCard } from './skills.ts'
import { loadCatalogCache, loadSources, saveCatalogCache, type CatalogCache } from './store.ts'

/** The prompt section's order (upstream convention: 100–199; 117 is free). */
const PROMPT_SECTION_ORDER = 117

/** How many hits per source when the caller does not say. */
const DEFAULT_LIMIT = 8

/** Hard ceiling per source: a hit list is a shortlist, not a catalog dump. */
const MAX_LIMIT = 25

/** Description slice in the output — enough to judge a hit, bounded for tokens. */
const MAX_DESCRIPTION_CHARS = 300

/**
 * How long a `market_search` call waits for the in-flight catalog refresh
 * before answering from the snapshot it already holds.
 *
 * The tool runs inside a conversation turn, so a directory download must not
 * become a multi-second stall. Measured 2026-11-26 on this machine with an
 * 84.5-hour-old cache (the state a user who never opens the market panel is
 * permanently in): two consecutive searches paid 3,258 ms and 1,866 ms of live
 * fetch, and neither wrote anything back — so the next call paid again. 5 s is
 * above a healthy refresh (0.6-2.5 s per source on a domestic link) and above
 * what a tool call may make a user wait; past it the tool answers from the old
 * snapshot with a note, and the refresh finishes behind it and persists.
 */
export const BRIDGE_REFRESH_WAIT_MS = 5_000

/** Report a clipped directory: a miss in a truncated catalog proves nothing. */
const TRUNCATED_NOTE = 'The plugin directory is larger than the host\'s per-source entry cap, so only part of it was searched. If nothing matched, do not tell the user the plugin does not exist; retry with the exact package name, or have them search the market panel.'

/** Report an answer served from an old snapshot whose refresh is still running. */
function staleSnapshotNote(hours: number): string {
  return `The plugin catalog snapshot is about ${ageSpan(hours)} old and is being refreshed in the background. If nothing matched, do not claim the plugin does not exist; retry in a minute.`
}

/**
 * Report an answer served from an old snapshot because its refresh FAILED.
 * Deliberately not the sentence above: nothing is running any more, and a model
 * that repeats "refreshing" would promise an update that never comes.
 */
function failedRefreshNote(hours: number): string {
  return `The plugin catalog refresh just failed, so this answer comes from a snapshot about ${ageSpan(hours)} old. If nothing matched, do not claim the plugin does not exist; retry in a minute.`
}

/** "1 hour" / "7 hours" — the span as both snapshot notes phrase it. */
function ageSpan(hours: number): string {
  return hours === 1 ? '1 hour' : `${String(hours)} hours`
}

/** Collaborators the tool needs; mirrors the routes' own deps. */
export interface MarketToolDeps {
  /** Absolute path of sources.json. */
  readonly sourcesPath: string
  /** Absolute path of catalog-cache.json (the cache-first snapshot). */
  readonly catalogCachePath: string
  /** Profile whose manifest backs the installed flag. */
  readonly profile: string
  /** Diagnostic logger (English; never model-facing). */
  readonly log: (message: string) => void
  /**
   * The catalog hold an install intent resolves from. The plugin branch feeds
   * it the build it just served — which may be LIVE, the disk cache, or the old
   * snapshot it fell back to — so a name this tool returns stays installable a
   * moment later. Absent = nothing is remembered (the issuance path falls back
   * to the persisted cache and the snapshot).
   */
  readonly catalogHold?: CatalogHold
  /**
   * How long a search waits for the in-flight catalog refresh before answering
   * from the snapshot it already holds. A test seam: production never sets it,
   * because waiting 5 s inside every case is not something a suite can afford.
   */
  readonly refreshWaitMs?: number
  /**
   * The catalog fetch behind a refresh, injected so the suite drives one with no
   * network. Defaults to `fetchCatalog` (inside `refreshCatalogBehind`).
   */
  readonly fetchSource?: CatalogRefreshRequest['fetchSource']
}

/** One search hit, in the shape the model reads. */
export type MarketHit = {
  readonly kind: 'skill' | 'plugin'
  /** Stable identifier: a skill slug, or a plugin's npm package name. */
  readonly id: string
  readonly name: string
  readonly description: string
  /** Source-declared category label, when it has one. */
  readonly category?: string
  readonly version?: string
  readonly owner?: string
  readonly homepage?: string
  readonly stars?: number
  readonly downloads?: number
  /** True when this machine already has it (a skill directory, a profile dependency). */
  readonly installed: boolean
  /**
   * Plugins only: false for a row this tool cannot install — a source-only
   * row (no install target at all) and a git-only row alike, because the
   * model-facing install tool is npm-only (`installPluginByName` resolves a
   * registry version). The flag exists so the model never promises a
   * one-click install that will fail; a git row the PANEL can install is
   * still not something this tool can, and the panel is where the user
   * installs it.
   */
  readonly installable?: boolean
}

/**
 * The tool result body. Declared as a TYPE ALIAS, not an interface, on
 * purpose: `JsonValue` is an index-signature type, and TypeScript grants an
 * implicit index signature to an object-literal alias but never to an
 * interface — so only the alias form assigns without an `as unknown as`
 * escape (and the suite's ratchet pins that count).
 */
type MarketSearchResult = {
  readonly ok: boolean
  readonly query: string
  readonly scope: 'skills' | 'plugins' | 'all'
  readonly skills: MarketHit[]
  readonly plugins: MarketHit[]
  /** Per-source problems — a source that could not be read, not an empty match. */
  readonly failures: Array<{ readonly source: 'skills' | 'plugins', readonly reason: string }>
  /** Reminders the model must pass on verbatim (install is the user's click). */
  readonly notes: string[]
}

/** Truncate a remote description to the output budget. */
function brief(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= MAX_DESCRIPTION_CHARS ? trimmed : `${trimmed.slice(0, MAX_DESCRIPTION_CHARS)}…`
}

/** Clamp the caller's limit into a sane range (exported for the suite). */
export function limitOf(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(raw)))
}

/** A failed source's diagnostic, for the `failures` list. */
function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Project one SkillHub card onto a hit. Pure and exported so the suite can pin
 * the field mapping (a rename upstream must fail a test, not the tool call).
 * @param card - a validated card from {@link searchSkills}.
 * @param installed - the slugs already present on this machine.
 */
export function skillHitOf(card: SkillCard, installed: ReadonlySet<string>): MarketHit {
  return {
    kind: 'skill',
    id: card.slug,
    name: card.name,
    description: brief(card.description),
    ...(card.category !== '' ? { category: card.category } : {}),
    ...(card.version !== '' ? { version: card.version } : {}),
    ...(card.owner !== undefined ? { owner: card.owner } : {}),
    ...(card.homepage !== undefined ? { homepage: card.homepage } : {}),
    stars: card.stars,
    downloads: card.downloads,
    installed: installed.has(card.slug),
  }
}

/**
 * Project one catalog entry onto a hit, through the SAME weighted ranker the
 * panel's search box uses. Pure and exported for the suite; `installed`
 * decides the flag, and `installable: false` is carried through for every row
 * this tool cannot install — a source-only row and a git-only row alike — so
 * the model never promises an install that must fail.
 */
export function pluginHitOf(entry: CatalogEntry, installed: ReadonlySet<string>): MarketHit {
  return {
    kind: 'plugin',
    id: entry.package,
    name: entry.name,
    description: brief(entry.description),
    ...(entry.category !== undefined ? { category: entry.category } : {}),
    ...(entry.version !== undefined ? { version: entry.version } : {}),
    ...(entry.owner !== undefined ? { owner: entry.owner } : {}),
    ...(entry.homepage !== undefined ? { homepage: entry.homepage } : {}),
    ...(entry.stars !== undefined ? { stars: entry.stars } : {}),
    ...(entry.downloads !== undefined ? { downloads: entry.downloads } : {}),
    installed: installed.has(entry.package),
    // A git row is installable from the PANEL only: this bridge's install tool
    // is npm-only, so reporting it as installable here would be a promise the
    // tool refuses a moment later.
    installable: entry.installable !== false && entry.gitTarget === undefined,
  }
}

/** One branch's answer: its hits plus anything the snapshot's quality obliges the model to read. */
export interface MarketBranchResult {
  readonly hits: readonly MarketHit[]
  /** Extra notes for this branch's answer (a clipped directory, an old snapshot). */
  readonly notes?: readonly string[]
  /**
   * Per-source read failures this branch's answer already survived — a catalog
   * source that could not be fetched, so the list it searched may be missing
   * rows. They ride the result's `failures` channel (not `notes`), because the
   * contract there is exactly this: "the source could not be read" and "nothing
   * matched" must not read the same to a model.
   */
  readonly failures?: readonly string[]
}

/** The skills branch: live SkillHub search, cross-checked against what is installed. */
async function searchSkillsBranch(query: string, limit: number): Promise<MarketBranchResult> {
  const page = await searchSkills(query, '', 1)
  const installed = new Set((await listInstalledSkills(join(resolveDshHome(), 'skills'))).map(skill => skill.slug))
  return { hits: page.items.slice(0, limit).map(card => skillHitOf(card, installed)) }
}

/** The shared refresh request for one branch call, carrying the test seams. */
function refreshRequestOf(
  deps: MarketToolDeps,
  sources: readonly string[],
  readCache: () => CatalogCache | null,
): CatalogRefreshRequest {
  return {
    sources,
    readCache,
    persist: (cache) => {
      try {
        saveCatalogCache(deps.catalogCachePath, cache)
      } catch (error) {
        deps.log(`plugin-market catalog cache: write failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    ...(deps.catalogHold !== undefined ? { hold: deps.catalogHold } : {}),
    log: deps.log,
    ...(deps.fetchSource !== undefined ? { fetchSource: deps.fetchSource } : {}),
  }
}

/**
 * What waiting for the shared refresh produced: the resolution, the wait
 * expiring while it still runs, or the refresh itself failing. The last two are
 * different facts and the model is told them differently — "being refreshed"
 * would be a lie once the pass has already failed.
 */
type RefreshOutcome =
  | { readonly kind: 'resolution', readonly resolution: CatalogResolution }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'failed' }

/**
 * The refresh's outcome if it lands within `ms`, else `timeout`. The refresh is
 * NOT cancelled: it keeps running and persists behind the answer.
 */
function waitForRefresh(refresh: Promise<CatalogResolution | null>, ms: number): Promise<RefreshOutcome> {
  return new Promise((settle) => {
    let settled = false
    const finish = (outcome: RefreshOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      settle(outcome)
    }
    const timer = setTimeout(() => { finish({ kind: 'timeout' }) }, ms)
    refresh.then(
      (value) => { finish(value === null ? { kind: 'failed' } : { kind: 'resolution', resolution: value }) },
      () => { finish({ kind: 'failed' }) },
    )
  })
}

/**
 * The plugins branch: the panel's own catalog chain, answered within a bounded
 * wait, and persisted so the next call does not pay again.
 *
 * Three cases, and the difference is what the model answers "does this plugin
 * exist?" from:
 *
 * - **fresh cache** → answer immediately, no network;
 * - **cache but expired** → start (or join) the ONE shared refresh and wait at
 *   most {@link BRIDGE_REFRESH_WAIT_MS}. If it lands, answer from it — the
 *   result is already persisted, so the next call is a cache hit. If it does
 *   not, answer from the held snapshot and say which of the two happened: a
 *   wait that expired says a refresh is running, a refresh that FAILED says so
 *   and rides the result's `failures` channel. Blocking on every source here
 *   was the measured defect: a user who never opens the panel left the cache
 *   stale for ever, and every search re-downloaded the directory (3,258 ms and
 *   1,866 ms on two consecutive calls, cache 84.5 h old);
 * - **no cache at all** → wait for the refresh: there is nothing else to answer
 *   from, and this is the one case where a cold start has to pay.
 *
 * The install-intent hold always receives the build the served rows came from —
 * the fresh cache, the old snapshot, or the refreshed build — because a name
 * this tool returns is about to be resolved back against that build.
 */
export async function searchPluginsBranch(deps: MarketToolDeps, query: string, limit: number): Promise<MarketBranchResult> {
  const sources = loadSources(deps.sourcesPath, deps.log)
  const held = loadCatalogCache(deps.catalogCachePath, deps.log)
  const notes: string[] = []
  const failures: string[] = []
  let payload: CatalogPayload
  let cacheBehind: CatalogCache | null
  let truncated: boolean
  if (held === null) {
    const resolution = await refreshCatalogBehind(refreshRequestOf(deps, sources, () => null))
    if (resolution === null) throw new Error('the plugin catalog refresh failed; see the host log')
    payload = resolution.payload
    cacheBehind = resolution.cacheToWrite
    truncated = resolution.truncated
  } else if (isCacheFresh(held, sources, Date.now())) {
    payload = cachePayload(held, sources, true)
    cacheBehind = held
    truncated = isTruncatedCache(held, sources)
  } else {
    const outcome = await waitForRefresh(
      refreshCatalogBehind(refreshRequestOf(deps, sources, () => held)),
      deps.refreshWaitMs ?? BRIDGE_REFRESH_WAIT_MS,
    )
    if (outcome.kind === 'resolution') {
      payload = outcome.resolution.payload
      cacheBehind = outcome.resolution.cacheToWrite ?? held
      truncated = outcome.resolution.truncated
    } else {
      // Either the wait expired (the refresh still runs, and lands on disk) or
      // the refresh itself failed. Both answer from what we hold; they do NOT
      // say the same thing: a failed pass is a failure row plus a note that
      // promises nothing.
      payload = cachePayload(held, sources, false)
      cacheBehind = held
      truncated = isTruncatedCache(held, sources)
      const ageHours = Math.max(1, Math.round((Date.now() - held.fetchedAt) / 3_600_000))
      if (outcome.kind === 'timeout') {
        notes.push(staleSnapshotNote(ageHours))
      } else {
        notes.push(failedRefreshNote(ageHours))
        failures.push(`the plugin catalog refresh failed just now (see the host log), so this answer comes from a snapshot about ${ageSpan(ageHours)} old and may be incomplete`)
      }
    }
  }
  // Hand the build to the install-intent hold: a live fetch yields rows the
  // persisted cache does not carry yet, and the model is about to name one of
  // them back to us. The snapshot the rows came from is the one attribution
  // must read — `cacheToWrite ?? held`, exactly as GET /catalog does: a
  // refreshed build whose rows are live would otherwise name a source from the
  // snapshot it just replaced (or none at all on a cold cache).
  deps.catalogHold?.remember(catalogBuildOf(payload.plugins, payload.cachedAt, sources, cacheBehind))
  if (truncated) notes.push(TRUNCATED_NOTE)
  // A source that could not be read leaves rows out of the list this branch
  // searched — live, lent from the cache, or rescued as stale. The result's
  // `failures` channel is where that belongs: it is what keeps "I could not see
  // it" from reading as "it does not exist".
  for (const entry of payload.failed) {
    const detail = entry.reason.text ?? entry.reason.code
    failures.push(`catalog source ${entry.url} could not be read just now (${detail}), so this plugin list may be incomplete`)
  }
  const installed = new Set(
    readInstalled(join(resolveDshHome(), 'profiles', deps.profile), deps.profile).packages.map(pkg => pkg.name),
  )
  const hits = searchEntries(payload.plugins, query).slice(0, limit).map(entry => pluginHitOf(entry, installed))
  return { hits, notes, ...(failures.length > 0 ? { failures } : {}) }
}

/** The unconditional entry rule: how a phrased request reaches the tool. */
export function marketBridgeSectionText(): string {
  return [
    '## Skill / plugin requests',
    'When the user asks whether a skill or a plugin exists for something, or asks for one to be found, call `market_search` with their own words as the query and answer from its results — do not answer from recollection. It reports what the market has, whether it is already installed, and for plugins whether it is installable.',
    // The consent and restart rules come from the SHARED constant that both install
    // tools also carry, so the two surfaces cannot drift apart. What stays here is
    // the part only a section can say: search first, then let the user choose.
    'Search first, then say what you found and let the user choose. ',
    INSTALL_CONSENT_RULE + ' ',
    INSTALL_RESTART_RULE,
  ].join('\n')
}

/** The orchestrator's collaborators; the two branches are injectable so the
 * suite can exercise every decision without touching the network. */
export interface MarketSearchOptions {
  readonly query: unknown
  readonly scope: unknown
  readonly limit: unknown
  /** The skills branch; the real one performs a live SkillHub search. */
  readonly searchSkills: (query: string, limit: number) => Promise<MarketBranchResult>
  /** The plugins branch; the real one reads the panel's own catalog chain. */
  readonly searchPlugins: (query: string, limit: number) => Promise<MarketBranchResult>
}

/**
 * One `market_search` call, from raw arguments to the result body. Exported
 * and dependency-injected so every decision below — the empty-query refusal,
 * the scope switch, the per-source failure isolation, the empty-match notes —
 * is testable offline; the two branches are the only network-touching part.
 *
 * A failing branch contributes a `failures` row and never throws: "the source
 * could not be read" and "nothing matched" must not read the same to a model.
 * A branch also reports what its answer is WORTH (`notes`): a clipped directory
 * or an old snapshot turns "nothing matched" into "nothing I could see", and
 * that distinction has to reach the model verbatim.
 * @param options - the raw arguments plus the two branch functions.
 * @returns the tool result body.
 */
export async function runMarketSearch(options: MarketSearchOptions): Promise<MarketSearchResult> {
  const query = typeof options.query === 'string' ? options.query.trim() : ''
  if (query === '') {
    return {
      ok: false,
      query,
      scope: 'all',
      skills: [],
      plugins: [],
      failures: [{ source: 'skills', reason: 'the query is required and was empty' }],
      notes: ['Retry market_search with the user\'s own words as `query`.'],
    }
  }
  const scope = options.scope === 'skills' || options.scope === 'plugins' ? options.scope : 'all'
  const limit = limitOf(options.limit)
  const failures: Array<{ source: 'skills' | 'plugins', reason: string }> = []
  let skills: MarketHit[] = []
  let plugins: MarketHit[] = []
  const notes = ['This tool only reports what exists. To install a hit the user has chosen, call market_install_skill or market_install_plugin.']
  // Sequential on purpose: the two branches hit different hosts, and a
  // failure in one must not cancel or delay the other.
  if (scope !== 'plugins') {
    try {
      const answer = await options.searchSkills(query, limit)
      skills = [...answer.hits]
      notes.push(...(answer.notes ?? []))
      for (const reason of answer.failures ?? []) failures.push({ source: 'skills', reason })
    } catch (cause: unknown) {
      failures.push({ source: 'skills', reason: reasonOf(cause) })
    }
  }
  if (scope !== 'skills') {
    try {
      const answer = await options.searchPlugins(query, limit)
      plugins = [...answer.hits]
      notes.push(...(answer.notes ?? []))
      for (const reason of answer.failures ?? []) failures.push({ source: 'plugins', reason })
    } catch (cause: unknown) {
      failures.push({ source: 'plugins', reason: reasonOf(cause) })
    }
  }
  if (scope === 'skills' && skills.length === 0 && failures.length === 0) {
    notes.push('No skill matched this query. Try a broader phrase, or search the plugin catalog with scope "plugins".')
  }
  if (scope === 'plugins' && plugins.length === 0 && failures.length === 0) {
    notes.push('No plugin matched this query. Try a broader phrase, or search the skill catalog with scope "skills".')
  }
  return { ok: true, query, scope, skills, plugins, failures, notes }
}

/**
 * Register the bridge tool (and its prompt entry rule) on the host context.
 * @param ctx - the host plugin context (must expose `tools` + `systemPrompt`).
 * @param deps - collaborators (store paths + the profile name).
 * @returns disposer removing both registrations.
 */
export function registerMarketBridge(ctx: Context, deps: MarketToolDeps): () => void {
  const disposeSection = ctx.systemPrompt.section({
    name: 'tool:market-bridge',
    order: PROMPT_SECTION_ORDER,
    text: marketBridgeSectionText(),
  })
  const disposeTool = ctx.tools.register(defineTool({
    name: 'market_search',
    description: 'Search the plugin market for a skill or a plugin matching a description. Use this whenever the user asks whether a skill or plugin exists for something, or asks you to find one — it queries the live skill catalog and the market\'s plugin catalog, and reports for each hit whether it is already installed (and, for plugins, whether it is installable). It only searches: to install, use market_install_skill or market_install_plugin after the user has chosen.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'What the user wants done, in their own words — e.g. "make a slide deck", "convert pdf to word", "read RSS feeds". Pass the user\'s language through as-is (Chinese queries work); a short natural phrase beats a list of keywords.',
      },
      scope: {
        type: 'string',
        enum: ['all', 'skills', 'plugins'],
        description: 'Where to look. "skills" = the skill catalog (needs the network), "plugins" = the plugin catalog (answers offline from a cached/bundled copy), "all" (default) = both.',
      },
      limit: {
        type: 'integer',
        description: `Maximum hits per source (1-${String(MAX_LIMIT)}, default ${String(DEFAULT_LIMIT)}).`,
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: Record<string, unknown>, _exec: ToolRunContext): Promise<JsonValue> {
      return await runMarketSearch({
        query: args.query,
        scope: args.scope,
        limit: args.limit,
        searchSkills: searchSkillsBranch,
        searchPlugins: (query, limit) => searchPluginsBranch(deps, query, limit),
      })
    },
  }))
  return () => {
    disposeTool()
    disposeSection()
  }
}
