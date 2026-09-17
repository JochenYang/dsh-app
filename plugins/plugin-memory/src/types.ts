/**
 * Shared shapes of the memory plugin (host ↔ client wire types + card model).
 *
 * @module @dsh-app/plugin-memory/types
 */

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

/** Card categories the save tool accepts. Small by design: five buckets
 * cover what actually deserves cross-session persistence, and a closed set
 * keeps the store greppable and the tool schema honest. */
export const MEMORY_CATEGORIES = ['preference', 'convention', 'decision', 'lesson', 'fact'] as const

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]

/** One topic card as the settings page lists it. */
export interface MemoryCardRow {
  /** Topic key (kebab-case; the card's identity and filename stem). */
  topic: string
  category: MemoryCategory
  /** ≤40-char index hook future saves route by. */
  summary: string
  /** `YYYY-MM-DD` of the last content change. */
  updated: string
  /** Full body (entries route only; the status list omits it). */
  body?: string
  pinned: boolean
}

/** One project's memory summary in the settings page. */
export interface MemoryProjectSummary {
  /** Directory slug under projects/ (basename + 8-hex of the cwd). */
  slug: string
  /** Full workspace path (from project.json; '' when unreadable). */
  cwd: string
  /** Topic-card count. */
  cards: number
  sizeBytes: number
}

/** One background-distill run's trace entry (settings-page transparency). */
export interface MemoryDistillActivity {
  /** Unix epoch ms when the distill ran. */
  at: number
  /** Short session id (first 8 hex) the run distilled. */
  session: string
  /** Cards the run persisted (0 = it ran but nothing new qualified). */
  saved: number
  /** LLM channel that ran the pass (absent for traces before backend tracking). */
  backend?: 'direct' | 'subagent'
  /** Model tokens spent on the pass (direct channel only). */
  tokens?: number
}

/** One background-LLM audit row (cost observability). */
export interface MemoryLlmAuditRun {
  at: number
  source: 'distill' | 'curate'
  session: string
  status: 'ok' | 'error' | 'aborted'
  inputTokens: number
  outputTokens: number
  durationMs: number
  error?: string
}

/** Response of GET api/entries — one store's cards with pin state. */
export interface MemoryEntriesResponse {
  cards: MemoryCardRow[]
}

/** Response of GET api/llm-audit — recent background-LLM cost rows. */
export interface MemoryLlmAuditResponse {
  runs: MemoryLlmAuditRun[]
  /** Summed tokens across the returned rows. */
  totalTokens: number
}

/** Response of GET api/status — the settings section's whole world. */
export interface MemoryStatus {
  /** Whether memory injection + tools are active (master toggle). */
  enabled: boolean
  /** Whether the background distiller pass is active (sub-toggle). */
  distill: boolean
  /** GLOBAL card count. */
  cards: number
  /** GLOBAL topics/ size in bytes. */
  sizeBytes: number
  /** GLOBAL topics directory path, shown so the user can edit cards by hand. */
  storePath: string
  /** GLOBAL cards in index order with their pin state (settings list). */
  globalList: MemoryCardRow[]
  /** Per-project summaries, largest first. */
  projects: MemoryProjectSummary[]
  /** Recent background-distill traces, newest first (bounded list). */
  activity: MemoryDistillActivity[]
}

/** Route namespace on the shared Connection `/api` channel. The registry admits
 * only path segments matching `[A-Za-z0-9_$.-]`, so the npm scope's `@` cannot
 * appear in the URL: `@dsh-app/plugin-memory` travels as
 * `dsh-app/plugin-memory`. Lives here (not in routes.ts) so the browser half
 * references the same constant without importing host-only modules. */
export const ROUTE_PREFIX = '/api/plugins/dsh-app/plugin-memory'
