/**
 * Session-level PPT-mode persistence.
 *
 * One JSON file (`<storeDir>/mode.json`) maps sessionId → { template,
 * updatedAt }, where an entry's presence means the mode is on and `template`
 * is the chosen template or `null` for 常规主题 (the neutral default when the
 * user has not picked one). Entries written by the previous generation carry
 * a `theme` field instead; those are migrated once at load — known legacy
 * theme ids map onto the closest bundled template, anything else resets to
 * the default template (reported through the load result). The in-memory map
 * is the live state: the system-prompt section provider reads it without I/O,
 * writes go to disk asynchronously through the serialized atomic writer, and
 * boot prunes stale entries so the file cannot grow unboundedly.
 *
 * @module @dsh-app/plugin-ppt/mode-store
 */

import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { DEFAULT_TEMPLATE_ID } from './templates.ts'

/** Entries older than this are pruned at boot. */
export const MODE_ENTRY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** One persisted entry: the template the session's PPT mode runs with. */
export interface StoredModeEntry {
  template: string | null
  updatedAt: number
}

/** On-disk shape of mode.json (legacy entries keep their `theme` field). */
export type ModeFile = Record<string, { theme?: unknown, template?: unknown, updatedAt?: unknown }>

/** Minimal logger face the store reports write failures through. */
export interface ModeStoreLog {
  warn(message: string): void
  info(message: string): void
}

/**
 * Legacy theme id → bundled template id. The old catalog's built-in and
 * brand presets map by closest visual role; unknown ids reset to the
 * default template.
 */
const LEGACY_THEME_MAP: Readonly<Record<string, string>> = {
  graphite: 'dsh-blue-professional',
  paper: 'dsh-blue-professional',
  ocean: 'dsh-signal',
  ember: 'dsh-broadside',
  forest: 'dsh-editorial-forest',
  mono: 'dsh-monochrome',
}

/** The template id a legacy theme value maps onto (unknown → default). */
export function migrateLegacyTheme(value: string): string {
  return LEGACY_THEME_MAP[value] ?? DEFAULT_TEMPLATE_ID
}

/**
 * SessionId → template state with serialized async persistence. `load` must
 * run once at mount before the routes/section read the map.
 */
export class PptModeStore {
  private readonly entries = new Map<string, StoredModeEntry>()
  /** Serialization tail: every persist appends after the previous one settles. */
  private writeTail: Promise<void> = Promise.resolve()

  constructor(
    /** Absolute path of mode.json. */
    readonly file: string,
    private readonly log: ModeStoreLog | undefined = undefined,
  ) {}

  /** Number of legacy `theme` entries rewritten at load (migration report). */
  migratedCount = 0

  /** Synchronously read the persisted map; missing or corrupt content starts empty. */
  load(): void {
    this.entries.clear()
    this.migratedCount = 0
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.log?.warn(`mode.json is corrupt, starting empty: ${this.file}`)
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof sessionId !== 'string' || sessionId === '') continue
      if (typeof value !== 'object' || value === null) continue
      const entry = value as Record<string, unknown>
      const updatedAt = entry.updatedAt
      if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) continue
      const template = entry.template
      const legacyTheme = entry.theme
      // `template: null` is the on-without-template state (常规主题), distinct
      // from an absent entry, which is off.
      if (template === null || (typeof template === 'string' && template !== '')) {
        this.entries.set(sessionId, { template: template === null ? null : template, updatedAt })
        continue
      }
      // Legacy entry: carry the theme over as the closest template selection.
      if (typeof legacyTheme === 'string' && legacyTheme !== '') {
        this.entries.set(sessionId, { template: migrateLegacyTheme(legacyTheme), updatedAt })
        this.migratedCount += 1
      }
    }
    if (this.migratedCount > 0) this.persist()
  }

  /** Whether the session's PPT mode is on (with or without a template). */
  isEnabled(sessionId: string): boolean {
    return this.entries.has(sessionId)
  }

  /** The session's active template, or null while off or on 常规主题. */
  templateOf(sessionId: string): string | null {
    return this.entries.get(sessionId)?.template ?? null
  }

  /** When the session's entry was last written, or null while off. */
  updatedAtOf(sessionId: string): number | null {
    return this.entries.get(sessionId)?.updatedAt ?? null
  }

  /**
   * Turn PPT mode on with `template` (`null` = 常规主题). The map updates
   * synchronously so the next prompt assembly sees the change immediately;
   * the disk copy follows asynchronously.
   */
  set(sessionId: string, template: string | null): void {
    this.entries.set(sessionId, { template, updatedAt: Date.now() })
    this.persist()
  }

  /** Turn PPT mode off, dropping the session's entry. */
  clear(sessionId: string): void {
    this.entries.delete(sessionId)
    this.persist()
  }

  /** Drop entries older than `maxAgeMs`; returns the pruned count. */
  prune(maxAgeMs: number = MODE_ENTRY_MAX_AGE_MS, now: number = Date.now()): number {
    let pruned = 0
    for (const [sessionId, entry] of this.entries) {
      if (now - entry.updatedAt > maxAgeMs) {
        this.entries.delete(sessionId)
        pruned += 1
      }
    }
    if (pruned > 0) this.persist()
    return pruned
  }

  /** Resolves after every queued persistence attempt has settled (test seam). */
  flush(): Promise<void> {
    return this.writeTail
  }

  /**
   * Queue one atomic write of the full map. Writes serialize on a promise
   * tail, so rapid toggles never interleave and the last state wins.
   */
  private persist(): void {
    const snapshot: Record<string, StoredModeEntry> = {}
    for (const [sessionId, entry] of this.entries) {
      snapshot[sessionId] = entry
    }
    this.writeTail = this.writeTail
      .then(() => writeFileAtomic(this.file, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o644, dirMode: 0o700 }))
      .catch((cause: unknown) => {
        this.log?.warn(`mode.json write failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      })
  }
}
