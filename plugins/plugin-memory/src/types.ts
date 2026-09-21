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
  /** Full body (the rows /entries serves, which the page expands in place). */
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

/** One background-LLM audit row (cost observability). Rows written before the
 *  extractor was retired may still say `distill` on disk; the reader passes
 *  whatever the file holds through unchanged. */
export interface MemoryLlmAuditRun {
  at: number
  source: 'curate'
  session: string
  status: 'ok' | 'error' | 'aborted'
  inputTokens: number
  outputTokens: number
  durationMs: number
  error?: string
}

/** Response of GET api/entries — one project store's cards with pin state. */
export interface MemoryEntriesResponse {
  cards: MemoryCardRow[]
}

/**
 * Outcome of POST api/curate — the "curate now" button, which runs ONE
 * maintenance pass on the user's request.
 *
 * The status vocabulary is closed on purpose: each value maps to one sentence
 * in the client dictionary, and the two that are not failures (`busy`,
 * `no-route`) exist because the honest answer is "try again" rather than an
 * error the user cannot act on. Counts are what the pass APPLIED, so the
 * toast can say what happened instead of claiming success: a pass that found
 * nothing to do and a pass that merged three cards are different news.
 */
export interface MemoryCurateResult {
  status:
    /** Edits landed. */
    | 'completed'
    /** The pass ran and everything was already tidy. */
    | 'nothing'
    /** Another pass is in flight; nothing was queued. */
    | 'busy'
    /** No live session to borrow a model route from. */
    | 'no-route'
    /** Memory is switched off (the master toggle). */
    | 'disabled'
    /** The slug names no project directory. */
    | 'unknown-project'
    /** The background-maintenance half is not mounted (no agents/llm services). */
    | 'unavailable'
    /** The model call did not land; nothing was applied. */
    | 'failed'
  /** Cards absorbed by a merge. */
  merged: number
  /** Cards deleted outright. */
  deleted: number
  /** Cards rewritten in place. */
  rewritten: number
  /** Proposals the host refused (unseen/stale/pinned/over-limit); each carries
   *  its reason in the ledger. */
  refused: number
}

/**
 * How long a deleted card is kept under `<scope>/archive/`. Deletion is
 * irreversible by design (a forget must actually forget), but THREE automated
 * writers also delete — the curator's merge/delete, the light sweep's
 * duplicate merge, and a model-driven memory_forget — and a single misjudged
 * merge would otherwise lose the content permanently. The archive is the
 * undo: it is written before every automated removal and never participates
 * in injection, search, or the similarity gate (it lives outside `topics/`).
 *
 * Declared HERE (not in `memory-store.ts`) because the client half renders
 * these numbers in the settings copy and the client is a browser bundle: it
 * must never pull in the store's `node:fs` imports. The store imports them
 * from this module, so there is still one source of truth.
 */
export const ARCHIVE_RETENTION_DAYS = 30

/** Hard cap on archived files per scope, oldest dropped first. Retention
 *  alone does not bound a pathological burst (a curator pass can delete
 *  dozens at once), and the archive must never grow without limit. */
export const ARCHIVE_MAX_FILES = 200

/** One archived card as the settings page lists it. */
export interface MemoryArchiveRow {
  /** `YYYY-MM-DD` directory the copy lives in (the day it was deleted). */
  day: string
  /** Archive file stem — the restore handle. Two same-day copies of one
   *  topic differ only by a `~HHMMSS` suffix, so this is NOT the topic key. */
  file: string
  /** Topic key the copy restores to. */
  topic: string
  bytes: number
  /** Which scope the copy belongs to, in the same vocabulary the other routes
   *  use (`scope` + `slug`) so a restore can address it directly. Only a
   *  project exists now: the retired scope's archive moved into
   *  `projects/legacy-global/` and is listed as that project. */
  scope: 'project'
  /** The project slug the copy belongs to (the restore handle). */
  slug: string
}

/** Response of GET api/archive — one store's archived cards. */
export interface MemoryArchiveResponse {
  cards: MemoryArchiveRow[]
  total: number
}

/**
 * One consolidation event as the settings page lists it: which pass touched
 * which topic keys, and whether it was applied or refused. The companion to
 * the archive — this says WHY a card is gone, the archive says how to get it
 * back.
 */
export interface MemoryLedgerRow {
  /** Unix epoch ms. */
  at: number
  /** 'global' or a project slug. */
  scope: string
  pass: 'curate' | 'light-sweep' | 'forget'
  op: 'merge' | 'delete' | 'rewrite' | 'rename'
  keys: string[]
  /** Merge/rewrite destination when it differs from the single cited key. */
  target?: string
  /** Present when the edit was REFUSED instead of applied. */
  rejected?: 'unseen' | 'stale' | 'over-limit'
  /** Short session id (curate only). */
  session?: string
}

/** Response of GET api/ledger — recent consolidation events, newest first. */
export interface MemoryLedgerResponse {
  entries: MemoryLedgerRow[]
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
  /** Whether the background maintenance pass is active (sub-toggle; the field
   *  keeps the name of the pass it used to gate). */
  distill: boolean
  /** Per-project summaries, largest first. The retired global scope has no row
   *  of its own: its cards are `projects/legacy-global/`, listed like any
   *  other project. */
  projects: MemoryProjectSummary[]
}

/** Route namespace on the shared Connection `/api` channel. The registry admits
 * only path segments matching `[A-Za-z0-9_$.-]`, so the npm scope's `@` cannot
 * appear in the URL: `@dsh-app/plugin-memory` travels as
 * `dsh-app/plugin-memory`. Lives here (not in routes.ts) so the browser half
 * references the same constant without importing host-only modules. */
export const ROUTE_PREFIX = '/api/plugins/dsh-app/plugin-memory'
