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
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the systemPrompt Context merge (ctx.systemPrompt) into
// scope (ctx.tools rides the dsh-tools import above).
import type {} from '@deepseek-ai/dsh-system-prompt'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { searchEntries } from './catalog-filter.ts'
import { fetchCatalog, type CatalogEntry } from './catalog.ts'
import { readInstalled, resolveCatalog } from './routes.ts'
import { listInstalledSkills, searchSkills, type SkillCard } from './skills.ts'
import { loadSnapshot } from './snapshot.ts'
import { loadCatalogCache, loadSources } from './store.ts'

/** The prompt section's order (upstream convention: 100–199; 117 is free). */
const PROMPT_SECTION_ORDER = 117

/** How many hits per source when the caller does not say. */
const DEFAULT_LIMIT = 8

/** Hard ceiling per source: a hit list is a shortlist, not a catalog dump. */
const MAX_LIMIT = 25

/** Description slice in the output — enough to judge a hit, bounded for tokens. */
const MAX_DESCRIPTION_CHARS = 300

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
}

/** One search hit, in the shape the model reads. */
type MarketHit = {
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
   * Plugins only: false for a source-only catalog row (no npm package to
   * install), so the model never promises a one-click install that will fail.
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
 * decides the flag, and `installable: false` (a source-only row) is carried
 * through so the model never promises an install that must fail.
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
    installable: entry.installable !== false,
  }
}

/** The skills branch: live SkillHub search, cross-checked against what is installed. */
async function searchSkillsBranch(query: string, limit: number): Promise<MarketHit[]> {
  const page = await searchSkills(query, '', 1)
  const installed = new Set((await listInstalledSkills(join(resolveDshHome(), 'skills'))).map(skill => skill.slug))
  return page.items.slice(0, limit).map(card => skillHitOf(card, installed))
}

/** The plugins branch: the panel's own catalog resolution, then the shared ranker. */
async function searchPluginsBranch(deps: MarketToolDeps, query: string, limit: number): Promise<MarketHit[]> {
  // `refresh: false` on purpose: the tool answers from the cache or the bundled
  // snapshot when it can, so an offline user still gets a shortlist.
  const resolution = await resolveCatalog({
    sources: loadSources(deps.sourcesPath, deps.log),
    refresh: false,
    fetchSource: fetchCatalog,
    readCache: () => loadCatalogCache(deps.catalogCachePath, deps.log),
    loadSnapshot,
    now: Date.now,
  })
  const installed = new Set(
    readInstalled(join(resolveDshHome(), 'profiles', deps.profile), deps.profile).packages.map(pkg => pkg.name),
  )
  return searchEntries(resolution.payload.plugins, query).slice(0, limit).map(entry => pluginHitOf(entry, installed))
}

/** The unconditional entry rule: how a phrased request reaches the tool. */
export function marketBridgeSectionText(): string {
  return [
    '## Skill / plugin requests',
    'When the user asks whether a skill or a plugin exists for something, or asks for one to be found, call `market_search` with their own words as the query and answer from its results — do not answer from recollection. It reports what the market has, whether it is already installed, and for plugins whether it is installable.',
    'Installing is the user\'s decision, not yours: search first, then say what you found and let them choose. Once the user has named a skill or a plugin from those results — or told you to install one — call `market_install_skill` with its slug or `market_install_plugin` with its npm package name, and name the exact thing you are installing. Never install on your own initiative, and never install something the user has not seen.',
    'A successful plugin install takes effect after a restart; a skill is picked up on the next scan. Say so in one short sentence, and never print install commands.',
  ].join('\n')
}

/** The orchestrator's collaborators; the two branches are injectable so the
 * suite can exercise every decision without touching the network. */
export interface MarketSearchOptions {
  readonly query: unknown
  readonly scope: unknown
  readonly limit: unknown
  /** The skills branch; the real one performs a live SkillHub search. */
  readonly searchSkills: (query: string, limit: number) => Promise<MarketHit[]>
  /** The plugins branch; the real one reads the panel's own catalog chain. */
  readonly searchPlugins: (query: string, limit: number) => Promise<MarketHit[]>
}

/**
 * One `market_search` call, from raw arguments to the result body. Exported
 * and dependency-injected so every decision below — the empty-query refusal,
 * the scope switch, the per-source failure isolation, the empty-match notes —
 * is testable offline; the two branches are the only network-touching part.
 *
 * A failing branch contributes a `failures` row and never throws: "the source
 * could not be read" and "nothing matched" must not read the same to a model.
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
  // Sequential on purpose: the two branches hit different hosts, and a
  // failure in one must not cancel or delay the other.
  if (scope !== 'plugins') {
    try {
      skills = await options.searchSkills(query, limit)
    } catch (cause: unknown) {
      failures.push({ source: 'skills', reason: reasonOf(cause) })
    }
  }
  if (scope !== 'skills') {
    try {
      plugins = await options.searchPlugins(query, limit)
    } catch (cause: unknown) {
      failures.push({ source: 'plugins', reason: reasonOf(cause) })
    }
  }
  const notes = ['This tool only reports what exists. To install a hit the user has chosen, call market_install_skill or market_install_plugin.']
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
