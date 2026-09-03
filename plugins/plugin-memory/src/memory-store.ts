/**
 * Two-level persistence for cross-session memory:
 *
 *   <root>/memory.md                     — GLOBAL entries (user preferences,
 *                                          habits; injected into every session)
 *   <root>/projects/<slug>/memory.md     — PROJECT entries (decisions,
 *                                          conventions, lessons; injected only
 *                                          into sessions of that workspace)
 *   <root>/projects/<slug>/project.json  — {cwd} stamp written on first save
 *                                          (recovers the full path for the UI)
 *   <root>/config.json                   — master enable toggle + background
 *                                          distill toggle (atomic write)
 *   <root>/distill-state.json            — per-session distill progress (the
 *                                          last event seq already consumed by
 *                                          the background distiller), so each
 *                                          distill run sees only the delta
 *
 * Project identity: slug = sanitized basename + '-' + 8 hex of the full cwd
 * (same basename in two parents never collides). Sessions with no cwd see
 * only the global file — hard isolation, not prompt-level discipline.
 *
 * Reads are existsSync-guarded and constructors do NO I/O (a project store
 * is instantiated per prompt assembly), so the dirs appear only on first
 * write. All writes are crash-safe (tmp + rename).
 *
 * @module @dsh-app/plugin-memory/memory-store
 */

import { createHash } from 'node:crypto'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import type { MemoryCategory } from './types.ts'

/** One saved entry gets at most this many characters; longer input is
 * rejected so the model re-thinks a leaner line instead of bloating the
 * file every session re-reads. */
export const MAX_ENTRY_CHARS = 500

/** Slug shape the clear route accepts — also the traversal fence. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** Local-date line prefix for an entry. */
export function todayStamp(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** Normalize text for matching: lowercase, keep letters/digits/CJK, drop the
 *  rest. Shared by the distiller's dedupe and memory_forget's match so both
 *  agree on what counts as "the same text". */
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '')
}

/** Entry-line prefix shape: `- [category] YYYY-MM-DD `. */
const ENTRY_PREFIX = /^- \[[a-z]+\] \d{4}-\d{2}-\d{2} /u

/** Capturing variant: category and date of a standard entry line. */
const FULL_ENTRY_PREFIX = /^- \[([a-z]+)\] (\d{4}-\d{2}-\d{2}) /u

/** One parsed line of a memory file. */
export interface MemoryEntry {
  /** The raw line without its trailing newline. */
  raw: string
  /** Category of a standard entry line; undefined otherwise. */
  category: string | undefined
  /** `YYYY-MM-DD` stamp of a standard entry line; undefined otherwise. */
  date: string | undefined
  /** Prefix-stripped content (the whole raw line when non-standard). */
  content: string
}

/** Split a memory file into its lines (empty lines dropped). Shared by the
 *  injection selector, the curator, and the settings list. */
export function parseEntries(text: string): MemoryEntry[] {
  const out: MemoryEntry[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    const match = FULL_ENTRY_PREFIX.exec(line)
    if (match !== null) out.push({
      raw: line,
      category: match[1],
      date: match[2],
      content: line.slice(match[0].length),
    })
    else out.push({ raw: line, category: undefined, date: undefined, content: line })
  }
  return out
}

/** The content part of an entry line (prefix stripped; the whole line when
 * it does not carry the standard prefix). */
function entryContent(line: string): string {
  return ENTRY_PREFIX.test(line) ? line.replace(ENTRY_PREFIX, '') : line
}

/** Crash-safe replace: write a sibling temp file, then rename over. */
function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

/**
 * File-backed memory store over one directory. All methods throw on I/O
 * failure; callers (tool execute / route handlers) translate that into
 * user-facing errors.
 */
export class MemoryStore {
  readonly dir: string
  private readonly memoryPath: string
  private readonly configPath: string
  /** Project cwd stamped into project.json on the first write. */
  private readonly sourceCwd: string | undefined

  constructor(dir: string, sourceCwd?: string) {
    this.dir = dir
    this.sourceCwd = sourceCwd
    this.memoryPath = join(dir, 'memory.md')
    this.configPath = join(dir, 'config.json')
  }

  /** Full memory file text ('' when absent). */
  read(): string {
    return existsSync(this.memoryPath) ? readFileSync(this.memoryPath, 'utf8') : ''
  }

  /** Append one entry line; returns the line written. */
  append(category: MemoryCategory, content: string): string {
    const line = `- [${category}] ${todayStamp()} ${content.replace(/\s+/gu, ' ').trim()}`
    mkdirSync(this.dir, { recursive: true })
    appendFileSync(this.memoryPath, `${line}\n`, 'utf8')
    if (this.sourceCwd !== undefined) {
      const metaPath = join(this.dir, 'project.json')
      if (!existsSync(metaPath)) {
        writeFileSync(metaPath, `${JSON.stringify({ cwd: this.sourceCwd }, null, 2)}\n`, 'utf8')
      }
    }
    return line
  }

  /** Drop every entry and every pin (the file is recreated empty on the next
 *  append). A clear is a full reset, not a soft wipe that leaves pins behind
 *  to resurrect matching future entries. */
  clear(): void {
    if (existsSync(this.memoryPath)) atomicWrite(this.memoryPath, '')
    this.writeConfig({ pinned: [] })
  }

  /**
   * Remove entries whose normalized CONTENT contains the normalized match
   * (substring, case-insensitive, CJK preserved; the category/date prefix is
   * excluded so matching a date or category name never sweeps entries).
   * Returns the removed lines so the caller can report exactly what went.
   */
  forget(match: string): { removed: string[], remaining: number } {
    const text = this.read()
    const lines = text === '' ? [] : text.split('\n')
    const needle = normalizeForMatch(match)
    if (needle === '') {
      return { removed: [], remaining: lines.filter(l => l.startsWith('- [')).length }
    }
    const kept: string[] = []
    const removed: string[] = []
    for (const line of lines) {
      if (line.startsWith('- [') && normalizeForMatch(entryContent(line)).includes(needle)) {
        removed.push(line)
      } else {
        kept.push(line)
      }
    }
    if (removed.length > 0) {
      // Drop trailing empty lines the removed entries may leave behind; keep
      // exactly one newline when anything remains.
      const body = kept.join('\n').replace(/\n+$/u, '')
      atomicWrite(this.memoryPath, body === '' ? '' : `${body}\n`)
    }
    return { removed, remaining: kept.filter(l => l.startsWith('- [')).length }
  }

  /**
   * Whether an entry with EQUIVALENT content (exact match after
   * normalization — same rule {@link forget} matches by) already exists.
   * Guards memory_save against appending near-identical duplicates; the
   * equality (not substring) test keeps distinct entries that merely share a
   * keyword.
   */
  hasContent(content: string): boolean {
    const needle = normalizeForMatch(content)
    if (needle === '') return false
    for (const line of this.read().split('\n')) {
      if (line.startsWith('- [') && normalizeForMatch(entryContent(line)) === needle) return true
    }
    return false
  }

  /** Entry count (lines starting with the entry bullet) + file size. */
  stats(): { entries: number, sizeBytes: number } {
    const text = this.read()
    const entries = text.split('\n').filter(line => line.startsWith('- [')).length
    const sizeBytes = existsSync(this.memoryPath) ? statSync(this.memoryPath).size : 0
    return { entries, sizeBytes }
  }

  /** Master toggle; a missing or malformed config means ENABLED — the plugin
   * must not silently vanish from a half-written config. */
  isEnabled(): boolean {
    return this.readConfigField('enabled', true)
  }

  /** Persist the master toggle atomically (preserving the distill field). */
  setEnabled(value: boolean): void {
    this.writeConfig({ enabled: value })
  }

  /** Background-distill sub-toggle (the async safety net); defaults ON —
   * the whole point is that it needs no user attention. */
  isDistillEnabled(): boolean {
    return this.readConfigField('distill', true)
  }

  /** Persist the distill toggle atomically (preserving the master field). */
  setDistillEnabled(value: boolean): void {
    this.writeConfig({ distill: value })
  }

  /** One boolean field out of config.json with a default. */
  private readConfigField(field: string, fallback: boolean): boolean {
    const value = this.readConfigJson()[field]
    return typeof value === 'boolean' ? value : fallback
  }

  /** Merge-write one field into config.json (keeps the sibling fields). */
  private writeConfig(patch: Record<string, unknown>): void {
    mkdirSync(this.dir, { recursive: true })
    atomicWrite(this.configPath, `${JSON.stringify({ ...this.readConfigJson(), ...patch }, null, 2)}\n`)
  }

  /** Raw config.json as a plain object (absent/unreadable → empty). */
  private readConfigJson(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.configPath, 'utf8'))
      return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }

  /**
   * Normalized contents pinned to always inject. Pin persists in config.json
   * (not in the memory file), keyed by {@link normalizeForMatch} so it
   * survives line rewrites; a pin of an entry that no longer exists is a
   * harmless no-op at injection time.
   */
  pinnedSet(): Set<string> {
    const pins = this.readConfigJson().pinned
    return new Set(Array.isArray(pins) ? pins.filter((p): p is string => typeof p === 'string') : [])
  }

  /** Pin an entry by content; false when already pinned or matchless. */
  addPin(content: string): boolean {
    const needle = normalizeForMatch(content)
    if (needle === '') return false
    const pins = [...this.pinnedSet()]
    if (pins.includes(needle)) return false
    this.writeConfig({ pinned: [...pins, needle] })
    return true
  }

  /** Unpin an entry by content; false when it was not pinned. */
  removePin(content: string): boolean {
    const needle = normalizeForMatch(content)
    const pins = [...this.pinnedSet()]
    if (!pins.includes(needle)) return false
    this.writeConfig({ pinned: pins.filter(p => p !== needle) })
    return true
  }

  /** Replace the whole file content crash-safely (used by the curator). */
  replace(text: string): void {
    if (text === '') {
      if (existsSync(this.memoryPath)) atomicWrite(this.memoryPath, '')
      return
    }
    atomicWrite(this.memoryPath, text.endsWith('\n') ? text : `${text}\n`)
  }

  /**
   * Remove entries whose CONTENT normalizes to the exact same string — the
   * settings-page row delete. Precise (unlike {@link forget}'s substring
   * sweep): deleting the row "用 pnpm" never touches "用 pnpm 跑 typecheck".
   */
  removeContent(content: string): { removed: string[], remaining: number } {
    const needle = normalizeForMatch(content)
    if (needle === '') return { removed: [], remaining: 0 }
    const kept: string[] = []
    const removed: string[] = []
    for (const line of this.read().split('\n')) {
      if (line.startsWith('- [') && normalizeForMatch(entryContent(line)) === needle) {
        removed.push(line)
      } else {
        kept.push(line)
      }
    }
    if (removed.length > 0) {
      const body = kept.join('\n').replace(/\n+$/u, '')
      atomicWrite(this.memoryPath, body === '' ? '' : `${body}\n`)
    }
    return { removed, remaining: kept.filter(l => l.startsWith('- [')).length }
  }

  /** Absolute memory-file path (for the settings UI). */
  get filePath(): string {
    return this.memoryPath
  }
}

/** Deterministic project directory slug: sanitized basename + 8-hex of the
 * full cwd. Two projects sharing a basename never collide. */
export function projectSlug(cwd: string): string {
  const base = basename(cwd).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'project'
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 8)
  return `${base}-${hash}`
}

/** Whether a slug is well-formed (used to fence the clear route). */
export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug)
}

/** One project's summary for the settings page. */
export interface ProjectSummary {
  slug: string
  /** Full workspace path (from project.json; '' when unreadable). */
  cwd: string
  entries: number
  sizeBytes: number
}

/** Summarize every project directory, busiest first. */
export function listProjects(rootDir: string): ProjectSummary[] {
  const projectsDir = join(rootDir, 'projects')
  if (!existsSync(projectsDir)) return []
  const out: ProjectSummary[] = []
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(projectsDir, entry.name)
    let cwd = ''
    try {
      const meta: unknown = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))
      if (typeof meta === 'object' && meta !== null) {
        const value = (meta as { cwd?: unknown }).cwd
        if (typeof value === 'string') cwd = value
      }
    } catch {
      // missing/stale metadata → keep empty, the slug still identifies it
    }
    const { entries, sizeBytes } = new MemoryStore(dir).stats()
    out.push({ slug: entry.name, cwd, entries, sizeBytes })
  }
  out.sort((a, b) => b.sizeBytes - a.sizeBytes || b.entries - a.entries)
  return out
}

/** Remove one project directory entirely (scoped clear). */
export function removeProject(rootDir: string, slug: string): void {
  rmSync(join(rootDir, 'projects', slug), { recursive: true, force: true })
}

/** How many sessions the distill-progress map keeps before the oldest
 * entries are pruned (the map is a cache, not a ledger — a dropped session
 * simply re-distills its full log on next activation). */
const MAX_TRACKED_SESSIONS = 300

/** How many distill-run traces distill-state.json retains (FIFO). */
const MAX_ACTIVITY = 20

/** One session's background-distill progress. */
export interface DistillProgress {
  /** Last session-event seq already consumed by a distill run. */
  seq: number
  /** Unix epoch ms of the last distill run for this session. */
  at: number
}

/** Short display id: the uuid segment's first 8 chars (`session-` prefix
 * dropped), e.g. `session-49ce2455-...` → `49ce2455`. */
export function shortSessionId(sessionId: string): string {
  return sessionId.replace(/^session-/u, '').slice(0, 8)
}

/** One background-distill run's trace entry (settings-page transparency). */
export interface DistillActivity {
  /** Unix epoch ms when the distill ran. */
  at: number
  /** Short session id (first 8 hex of the uuid segment; {@link shortSessionId}). */
  session: string
  /** Entries the run persisted (0 = it ran but nothing new qualified). */
  saved: number
}

/** Persisted shape of distill-state.json. */
interface DistillState {
  version: 1
  sessions: Record<string, DistillProgress>
  activity: DistillActivity[]
}

/**
 * The two-level root: one global store plus per-workspace project stores.
 * The global store's config.json holds the master + distill toggles.
 */
export class MemoryRoot {
  readonly dir: string
  readonly global: MemoryStore
  private readonly distillStatePath: string

  constructor(dir: string) {
    this.dir = dir
    this.global = new MemoryStore(dir)
    this.distillStatePath = join(dir, 'distill-state.json')
  }

  /** Project store for a workspace cwd (cheap: no I/O until a write). */
  projectFor(cwd: string): MemoryStore {
    return new MemoryStore(join(this.dir, 'projects', projectSlug(cwd)), cwd)
  }

  /** Project store by slug (the settings routes resolve projects by slug,
   *  not cwd; undefined for an unknown or malformed slug). */
  projectBySlug(slug: string): MemoryStore | undefined {
    if (!isValidSlug(slug)) return undefined
    const dir = join(this.dir, 'projects', slug)
    if (!existsSync(dir)) return undefined
    try {
      const meta: unknown = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))
      const cwd = (meta as { cwd?: unknown }).cwd
      if (typeof cwd === 'string' && cwd !== '') return this.projectFor(cwd)
    } catch {
      // missing/stale metadata → operate on the directory as-is
    }
    return new MemoryStore(dir)
  }

  /** Last-consumed event seq for one session (0 when never distilled). */
  distillSeqOf(sessionId: string): number {
    return this.readDistillState().sessions[sessionId]?.seq ?? 0
  }

  /** Advance one session's distill progress and persist (with pruning). */
  advanceDistill(sessionId: string, seq: number): void {
    const state = this.readDistillState()
    state.sessions[sessionId] = { seq, at: Date.now() }
    // Prune to the newest MAX_TRACKED_SESSIONS by last-run time.
    const ids = Object.keys(state.sessions)
    if (ids.length > MAX_TRACKED_SESSIONS) {
      ids.sort((a, b) => state.sessions[a]!.at - state.sessions[b]!.at)
      for (const id of ids.slice(0, ids.length - MAX_TRACKED_SESSIONS)) {
        delete state.sessions[id]
      }
    }
    mkdirSync(this.dir, { recursive: true })
    atomicWrite(this.distillStatePath, `${JSON.stringify(state, null, 2)}\n`)
  }

  /** Recent distill-run traces, newest first (bounded FIFO). */
  distillActivity(): DistillActivity[] {
    return [...this.readDistillState().activity].sort((a, b) => b.at - a.at)
  }

  /** Append one distill trace and persist (bounded, survives restarts). */
  recordDistill(sessionId: string, saved: number): void {
    const state = this.readDistillState()
    state.activity.push({ at: Date.now(), session: shortSessionId(sessionId), saved })
    if (state.activity.length > MAX_ACTIVITY) {
      state.activity = state.activity.slice(-MAX_ACTIVITY)
    }
    mkdirSync(this.dir, { recursive: true })
    atomicWrite(this.distillStatePath, `${JSON.stringify(state, null, 2)}\n`)
  }

  /** Read (and repair) distill-state.json; missing/malformed → empty. */
  private readDistillState(): DistillState {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.distillStatePath, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null) {
        const sessions = (parsed as { sessions?: unknown }).sessions
        const activity = (parsed as { activity?: unknown }).activity
        return {
          version: 1,
          sessions: typeof sessions === 'object' && sessions !== null
            ? sessions as Record<string, DistillProgress>
            : {},
          activity: Array.isArray(activity) ? activity as DistillActivity[] : [],
        }
      }
    } catch {
      // absent or unreadable → fresh state
    }
    return { version: 1, sessions: {}, activity: [] }
  }
}
