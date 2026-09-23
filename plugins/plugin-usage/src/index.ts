/**
 * DSH APP usage statistics — host half.
 *
 * Captures per-request token accounting from the `session/event` firehose,
 * backfills history from persisted session logs, aggregates on demand, and
 * serves four GET endpoints under `/api/plugins/dsh-app/plugin-usage`
 * (status/summary/heatmap/balance) for the settings-page client half.
 *
 * Coexistence with third-party usage plugins: both read the same immutable
 * session logs and write only to their own namespaced store
 * (`storages/dsh-app-plugin-usage`) and routes, so running alongside one is
 * safe by construction — no shared mutable state, no double counting (each
 * plugin reads its own store). A product feature must not vanish because
 * the user installed a same-kind plugin, so this half never yields.
 *
 * The exit valve and the price extension point are declarative config fields
 * on this plugin's entry (`enabled`, `pricing`; see src/user-config.ts):
 * `enabled: false` mounts only the status route answering active:false;
 * `pricing` rows override or extend the built-in price table for personal
 * gateway providers. Both are `Volatile` fields the kernel's config editor
 * writes into the profile's `cordis.patch.yml`, so the plugin owns no
 * configuration file any more: the JSON store it used to read
 * (`<storeDir>/config.json`) is imported once and moved aside.
 *
 * Stability discipline: zero global side effects — no context prototype
 * mutation, no process-wide state. A kernel without the consumed services
 * never mounts anything.
 *
 * @module @dsh-app/plugin-usage
 */

import { join } from 'node:path'
import type { Context, Volatile, VolatileSnapshot } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Type-only: pulls the connection Context merge (ctx.connection) into scope.
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: pulls the session Events merge ('session/event') into scope.
import type {} from '@deepseek-ai/dsh-session'
// Type-only: pulls the sessionPersistence Context merge into scope.
import type {} from '@deepseek-ai/dsh-session-persistence'
import { runBackfill } from './backfill.ts'
import { mergePricing } from './aggregate.ts'
import { foldLiveEvent } from './fold.ts'
import { BalanceError, registerUsageRoutes, type BalanceFetcher } from './routes.ts'
import { UsageStore } from './store.ts'
import { projectUsageConfig, readRetiredUsageConfig, retireUsageConfigFile, type UsageConfigValues } from './user-config.ts'
import type { UsageBalance, UsagePrice } from './types.ts'

export const name = 'plugin-usage'

/**
 * The usage half rides the Connection exact-Fetch registry
 * (`ctx.connection.fetch`). The web server is deliberately NOT injected: the
 * desktop host disables its `webserver` row, so a plugin that waits for it
 * never activates at all.
 */
export const inject = ['connection', 'sessionPersistence']

/**
 * Credential ref of the official DeepSeek provider route (`deepseek-official`
 * in llm-deepseek). Resolved through the credentials service so the key never
 * leaves the host process: the client only ever sees the balance payload.
 */
const DEEPSEEK_API_KEY_REF = 'DEEPSEEK_API_KEY'

/** Structural slice of the credentials service (same discipline as WebServerLike). */
interface CredentialsLike {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

/** DeepSeek official balance endpoint (see api-docs.deepseek.com). */
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'
const BALANCE_TIMEOUT_MS = 10_000

/**
 * Build the balance fetcher: resolve the user's DeepSeek API key, proxy the
 * official GET /user/balance, and map the payload to the wire shape. Every
 * failure mode becomes a typed BalanceError whose code the settings page
 * renders in the active UI language (the diagnostic beside it stays English).
 */
function makeBalanceFetcher(ctx: Context): BalanceFetcher {
  return async (): Promise<UsageBalance> => {
    const credentials = ctx.get('credentials') as CredentialsLike | undefined
    const apiKey = credentials !== undefined
      ? (await credentials.resolve(DEEPSEEK_API_KEY_REF))?.value
      : undefined
    if (apiKey === undefined || apiKey.length === 0) {
      throw new BalanceError('missing-credential', 'no DEEPSEEK_API_KEY credential is configured')
    }
    let response: Response
    try {
      response = await fetch(DEEPSEEK_BALANCE_URL, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
      })
    } catch (error) {
      const timedOut = (error as Error).name === 'TimeoutError'
      throw new BalanceError(
        timedOut ? 'upstream-timeout' : 'upstream-network',
        timedOut ? 'the balance request timed out' : `the balance request failed: ${(error as Error).message}`,
      )
    }
    if (response.status === 401) {
      throw new BalanceError('invalid-credential', 'the DeepSeek API key was rejected (HTTP 401)')
    }
    if (!response.ok) {
      throw new BalanceError('upstream-http', `the balance endpoint answered HTTP ${response.status}`, { status: response.status })
    }
    const data = await response.json() as {
      is_available?: unknown
      balance_infos?: Array<{ currency?: unknown; total_balance?: unknown; granted_balance?: unknown; topped_up_balance?: unknown }>
    }
    return {
      isAvailable: data.is_available === true,
      balances: (data.balance_infos ?? []).map((entry) => ({
        currency: typeof entry.currency === 'string' ? entry.currency : '',
        total: typeof entry.total_balance === 'string' ? entry.total_balance : '',
        granted: typeof entry.granted_balance === 'string' ? entry.granted_balance : '',
        toppedUp: typeof entry.topped_up_balance === 'string' ? entry.topped_up_balance : '',
      })),
    }
  }
}

/**
 * Config: storage location and the collector knobs.
 *
 * `enabled`, `backfillOnStart`, `rescanMinutes` and `pricing` are `Volatile`
 * references (see user-config.ts): the kernel's config editor stores them in
 * the profile's `cordis.patch.yml` and commits a new value into this running
 * plugin's references. All of them are read at activation — the mount
 * decision, the rescan timer and the price table are built there — so a value
 * saved while the plugin runs applies from the next start. `storePath` stays
 * an ordinary field: it says where the data lives, which is deployment
 * structure rather than user tuning.
 */
export interface Config {
  /** Absolute store directory; empty → $DSH_HOME/storages/dsh-app-plugin-usage. */
  storePath: string
  /**
   * Whether the collector mounts at all (default true). false mounts only the
   * status route answering active:false — the coexistence exit valve for a
   * user who prefers their own third-party usage plugin.
   */
  enabled: Volatile<boolean>
  /** Fold persisted session logs once at startup (default true). */
  backfillOnStart: Volatile<boolean>
  /** Minutes between incremental rescans; 0 disables (default 5). */
  rescanMinutes: Volatile<number>
  /**
   * The price table (CNY per 1M tokens), merged over the built-in defaults
   * (default []). This is the whole user-editable price surface: a row here
   * overrides the built-in table per provider/model key, and rows for models
   * the table does not carry price personal gateway providers. There is no
   * second table any more — the retired JSON store's rows used to merge on top
   * of the loader entry's, and this field is now the only editable table.
   */
  pricing: Volatile<UsagePrice[]>
}

// The schema is the runtime source of truth for the interface above, and stays
// unannotated on purpose: schemastery's volatile mode makes an object schema's
// own `default()` signature incompatible with `z<Config>`, which is why the
// kernel's volatile configs (`ui-theme`, `agent-default-model`) also declare
// the interface beside an inferred schema. Keep the two in step by hand.
export const Config = z.object({
  storePath: z.string().default(''),
  enabled: z.boolean().default(true).volatile(),
  backfillOnStart: z.boolean().default(true).volatile(),
  rescanMinutes: z.number().default(5).volatile(),
  pricing: z.array(z.object({
    provider: z.string().required(),
    model: z.string().required(),
    input: z.number().required(),
    output: z.number().required(),
    cacheRead: z.number().required(),
    cacheWrite: z.number().required(),
    peakFactor: z.number().min(1).default(1),
  })).default([]).volatile(),
})

/**
 * The effective config with the kernel's volatile references snapshotted: what
 * the runtime reads at activation, with no reference to hold on to.
 */
export type ResolvedConfig = {
  readonly [K in keyof Config]: Config[K] extends Volatile<infer V> ? VolatileSnapshot<V> : Config[K]
}

/**
 * The subset of the kernel's `configEditor` service this plugin uses.
 *
 * Declared structurally, like the other optional-service faces in this file
 * (`CredentialsLike`): the host half then compiles without a runtime dependency
 * on the package that provides the service, and a host whose profile carries no
 * editor simply has none.
 */
interface UsageConfigEditor {
  /**
   * Persist the config a change callback derives.
   * @param entry - the loader entry to write for.
   * @param change - derives the next raw config from the entry's current
   *   config and the layer-only config the entry would inherit.
   */
  edit(
    entry: unknown,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
}

/**
 * The loader entry that owns this plugin's row — the handle the kernel's config
 * editor addresses (`ctx.fiber.entry` in `packages/boot/config-editor`). The
 * loader merges that property onto the fiber through
 * `@deepseek-ai/cordis-plugin-loader`, which this package does not depend on at
 * runtime; it is read structurally so the host half never has to resolve a
 * package whose own cordis import can land on a second copy.
 */
function owningEntry(ctx: Context): unknown {
  return (ctx.fiber as { entry?: unknown }).entry
}

/** The editable values, as the write path sees them. */
function editableValues(config: ResolvedConfig): UsageConfigValues {
  return {
    enabled: config.enabled,
    backfillOnStart: config.backfillOnStart,
    rescanMinutes: config.rescanMinutes,
    pricing: config.pricing,
  }
}

/**
 * Host apply: mount capture + backfill + routes, unless the config disabled the
 * plugin (the coexistence exit valve).
 * @param ctx - the host plugin context.
 * @param baseConfig - validated plugin config; the editable knobs are `Volatile`
 *   references, snapshotted once here (see {@link ResolvedConfig}).
 */
export function apply(ctx: Context, baseConfig: Config): void {
  const log = ctx.logger(name)

  /**
   * The kernel's persistent config editor, when this host has one. It appends
   * the rows it stores for a setting to the profile's `cordis.patch.yml`, the
   * document the desktop shell preserves verbatim (`src/main/brand-suite.ts`,
   * the opaque tail). A host without a profile carries no editor, and then the
   * retired JSON store cannot be imported at all.
   */
  const configEditor = (): UsageConfigEditor | undefined => ctx.get('configEditor') as UsageConfigEditor | undefined

  /**
   * The effective config, read live. Every knob is a volatile reference — a
   * stable handle the kernel updates in place — read here once because the
   * collector's mount, timer and price table are all built at activation.
   */
  const resolveConfig = (): ResolvedConfig => ({
    storePath: baseConfig.storePath,
    enabled: baseConfig.enabled.get(),
    backfillOnStart: baseConfig.backfillOnStart.get(),
    rescanMinutes: baseConfig.rescanMinutes.get(),
    pricing: baseConfig.pricing.get(),
  })

  const config = resolveConfig()
  const dir = config.storePath !== '' ? config.storePath : join(resolveDshHome(), 'storages', 'dsh-app-plugin-usage')

  /**
   * Import the retired JSON store once, then move it aside.
   *
   * That file (`<storeDir>/config.json`) is what this plugin read before its
   * knobs became declarative config, so a value saved there would be ignored
   * from now on. What it carried is written into the profile row, and the file
   * is renamed — never deleted, it is the user's own writing. Deferred past
   * activation (the editor refuses an entry whose fiber is still loading) and
   * never fatal: a stale file must not fail a boot. The deferral is also why
   * the imported `enabled` governs the NEXT start and not this one — this
   * start's mount decision was already taken from the config.
   */
  const importRetiredConfig = async (): Promise<void> => {
    const storeFile = join(dir, 'config.json')
    const retired = readRetiredUsageConfig(storeFile, (message) => log.warn(message))
    if (retired === undefined) return
    const editor = configEditor()
    const entry = owningEntry(ctx)
    if (editor === undefined || entry === undefined) {
      log.warn(`usage plugin: cannot import ${storeFile} — this host has no configuration editor to persist it through, so the file is left in place`)
      return
    }
    try {
      if (Object.keys(retired).length > 0) {
        await editor.edit(entry, (current, inherited) => projectUsageConfig(current, inherited, retired, editableValues(resolveConfig())))
      }
    } catch (error) {
      log.warn(`usage plugin: could not import ${storeFile}: ${error instanceof Error ? error.message : String(error)}; the file is left in place`)
      return
    }
    const movedTo = retireUsageConfigFile(storeFile)
    log.info(movedTo === undefined
      ? `usage plugin: imported ${storeFile} into the plugin config, but could not move the file aside`
      : `usage plugin: imported ${storeFile} into the plugin config; the old file is kept as ${movedTo}`)
  }

  ctx.effect(() => {
    const timer = setTimeout(() => { void importRetiredConfig() }, 0)
    return () => { clearTimeout(timer) }
  }, 'plugin-usage: retired config import')

  if (!config.enabled) {
    log.info('usage plugin: disabled by config (enabled=false)')
    ctx.effect(() => registerUsageRoutes(ctx.connection.fetch, null, { active: false }), 'plugin-usage: status routes (disabled)')
    return
  }
  const store = new UsageStore({ dir, log: (message) => log.warn(message) })
  store.load()
  log.info(`usage store: ${store.size} row(s) loaded from ${dir}`)

  ctx.on('session/event', (session, event) => {
    try {
      foldLiveEvent(store, String(session.id), event)
    } catch (error) {
      log.warn(`usage capture failed: ${(error as Error).message}`)
    }
  })

  if (config.backfillOnStart) {
    void runBackfill(store, ctx.sessionPersistence, (message) => log.info(message))
      .catch((error: unknown) => { log.warn(`usage backfill failed: ${(error as Error).message}`) })
  }
  if (config.rescanMinutes > 0) {
    const timer = setInterval(() => {
      void runBackfill(store, ctx.sessionPersistence, (message) => log.info(message))
        .catch((error: unknown) => { log.warn(`usage rescan failed: ${(error as Error).message}`) })
    }, config.rescanMinutes * 60_000)
    ctx.effect(() => () => { clearInterval(timer) }, 'plugin-usage: rescan timer')
  }
  ctx.effect(() => () => { store.dispose() }, 'plugin-usage: store')

  const pricing = mergePricing(config.pricing)
  ctx.effect(() => registerUsageRoutes(ctx.connection.fetch, store, { pricing, active: true, fetchBalance: makeBalanceFetcher(ctx) }), 'plugin-usage: api routes')
}
