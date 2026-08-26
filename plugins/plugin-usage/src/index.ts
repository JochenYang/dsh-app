/**
 * DSH APP usage statistics — host half.
 *
 * Captures per-request token accounting from the `session/event` firehose,
 * backfills history from persisted session logs, aggregates on demand, and
 * serves four GET endpoints under `/plugins/@dsh-app/plugin-usage/api`
 * (status/summary/heatmap/balance) for the settings-page client half.
 *
 * Coexistence with third-party usage plugins: both read the same immutable
 * session logs and write only to their own namespaced store
 * (`storages/dsh-app-plugin-usage`) and routes, so running alongside one is
 * safe by construction — no shared mutable state, no double counting (each
 * plugin reads its own store). A product feature must not vanish because
 * the user installed a same-kind plugin, so this half never yields.
 *
 * The user's exit valve and price extension point is `<storeDir>/config.json`
 * (see src/user-config.ts): `enabled: false` mounts only the status route
 * answering active:false; `pricing` rows extend or override the built-in
 * price table for personal gateway providers.
 *
 * Stability discipline: zero global side effects — no context prototype
 * mutation, no process-wide state. A kernel without the consumed services
 * never mounts anything.
 *
 * @module @dsh-app/plugin-usage
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Type-only: pulls the webServer Context merge (ctx.webServer) into scope.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the session Events merge ('session/event') into scope.
import type {} from '@deepseek-ai/dsh-session'
// Type-only: pulls the sessionPersistence Context merge into scope.
import type {} from '@deepseek-ai/dsh-session-persistence'
import { runBackfill } from './backfill.ts'
import { mergePricing } from './aggregate.ts'
import { foldLiveEvent } from './fold.ts'
import { BalanceError, registerUsageRoutes, type BalanceFetcher } from './routes.ts'
import { UsageStore } from './store.ts'
import { loadUserConfig } from './user-config.ts'
import type { UsageBalance, UsagePrice } from './types.ts'

export const name = 'plugin-usage'
export const inject = ['webServer', 'sessionPersistence']

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
 * failure mode becomes a typed BalanceError so the route layer can answer
 * with an actionable zh-CN message.
 */
function makeBalanceFetcher(ctx: Context): BalanceFetcher {
  return async (): Promise<UsageBalance> => {
    const credentials = ctx.get('credentials') as CredentialsLike | undefined
    const apiKey = credentials !== undefined
      ? (await credentials.resolve(DEEPSEEK_API_KEY_REF))?.value
      : undefined
    if (apiKey === undefined || apiKey.length === 0) {
      throw new BalanceError('missing-credential', '未配置 DeepSeek API Key，请先在设置 → 模型页配置')
    }
    let response: Response
    try {
      response = await fetch(DEEPSEEK_BALANCE_URL, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
      })
    } catch (error) {
      const hint = (error as Error).name === 'TimeoutError' ? '请求超时' : '网络错误'
      throw new BalanceError('upstream', `查询 DeepSeek 余额失败（${hint}），请稍后重试`)
    }
    if (response.status === 401) {
      throw new BalanceError('invalid-credential', 'DeepSeek API Key 无效，请检查设置 → 模型页的配置')
    }
    if (!response.ok) {
      throw new BalanceError('upstream', `查询 DeepSeek 余额失败（HTTP ${response.status}），请稍后重试`)
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

/** Config: storage location, backfill behavior, and price overrides. */
export interface Config {
  /** Absolute store directory; empty → $DSH_HOME/storages/dsh-app-plugin-usage. */
  storePath: string
  /** Fold persisted session logs once at startup (default true). */
  backfillOnStart: boolean
  /** Minutes between incremental rescans; 0 disables (default 5). */
  rescanMinutes: number
  /** Price overrides/extensions over the built-in table (CNY per 1M tokens). */
  pricing: UsagePrice[]
}

export const Config: z<Config> = z.object({
  storePath: z.string().default(''),
  backfillOnStart: z.boolean().default(true),
  rescanMinutes: z.number().default(5),
  pricing: z.array(z.object({
    provider: z.string().required(),
    model: z.string().required(),
    input: z.number().required(),
    output: z.number().required(),
    cacheRead: z.number().required(),
    cacheWrite: z.number().required(),
    peakFactor: z.number().min(1).default(1),
  })).default([]),
})

/**
 * Host apply: mount capture + backfill + routes, unless the user config
 * file disabled the plugin (the coexistence exit valve).
 * @param ctx - the host plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger(name)
  const dir = config.storePath !== '' ? config.storePath : join(resolveDshHome(), 'storages', 'dsh-app-plugin-usage')
  const userConfig = loadUserConfig(join(dir, 'config.json'), (message) => log.warn(message))
  if (!userConfig.enabled) {
    log.info(`usage plugin: disabled by user config (${join(dir, 'config.json')})`)
    ctx.effect(() => registerUsageRoutes(ctx.webServer, null, { active: false }), 'plugin-usage: status routes (disabled)')
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

  const pricing = mergePricing([...config.pricing, ...userConfig.pricing])
  ctx.effect(() => registerUsageRoutes(ctx.webServer, store, { pricing, active: true, fetchBalance: makeBalanceFetcher(ctx) }), 'plugin-usage: api routes')
}
