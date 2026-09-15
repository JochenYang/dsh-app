/**
 * Shared shapes for the usage plugin: the persisted usage row, the
 * aggregated summaries the API routes return, and the per-model/per-day
 * aggregate cell. Both halves import from here so the wire contract lives
 * in exactly one place.
 *
 * @module @dsh-app/plugin-usage/types
 */

/** One persisted usage row: one assistant/message usage report. */
export interface UsageRow {
  /** Session-scoped event sequence number (dedupe + watermark key part). */
  seq: number
  /** Event time (ms since epoch). */
  time: number
  /** Owning session id. */
  sessionId: string
  /** Turn index within the session. */
  turn: number
  /** Step index within the turn. */
  step: number
  /** Provider route that served the request. */
  provider: string
  /** Provider-owned model id. */
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

/** Price table entry (CNY ¥ per 1M tokens). */
export interface UsagePrice {
  provider: string
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Peak-hour multiplier over the base (idle) rates; 1 = flat pricing. */
  peakFactor?: number
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

/** One aggregate bucket (total, one day, or one model). */
export interface UsageAgg {
  date: string
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  billedInputTokens: number
  cacheHitRate: number
  cost: number
}

/** Per-model aggregate with share of billed input. */
export interface UsageModelAgg extends UsageAgg {
  provider: string
  model: string
  share: number
  modelTokens: number
}

/** Response of GET api/summary?days=N. */
export interface UsageSummary {
  since: number
  until: number
  totals: UsageAgg
  models: UsageModelAgg[]
  daily: UsageAgg[]
}

/** One heatmap cell. */
export interface UsageHeatCell {
  date: string
  requests: number
  totalTokens: number
  cacheHitRate: number
}

/** Response of GET api/heatmap?weeks=N. */
export interface UsageHeatmap {
  weeks: number
  since: number
  until: number
  cells: UsageHeatCell[]
}

/** Response of GET api/status — the collector's liveness signal. */
export interface UsageStatus {
  /** false when the user config file disabled the collector. */
  active: boolean
  /** Present when active is false; identifies why. */
  reason?: 'disabled-by-user-config'
}

/** One currency bucket of the DeepSeek official account balance. */
export interface UsageBalanceEntry {
  /** 'CNY' | 'USD'. */
  currency: string
  /** Total available balance (granted + topped up), as a decimal string. */
  total: string
  /** Unexpired granted (free credit) balance. */
  granted: string
  /** Topped-up (paid) balance. */
  toppedUp: string
}

/** Response of GET api/balance — a proxied DeepSeek GET /user/balance. */
export interface UsageBalance {
  /** Whether the account can still serve API calls. */
  isAvailable: boolean
  balances: UsageBalanceEntry[]
}

/**
 * Wire shape of GET api/balance: the payload plus the time the upstream call
 * actually happened. A cache-served response carries the ORIGINAL fetch time
 * so the card never shows a "just queried" timestamp for stale data.
 */
export interface UsageBalanceSnapshot {
  balance: UsageBalance
  /** Epoch ms of the real upstream fetch (not the cache-serving moment). */
  fetchedAt: number
}
