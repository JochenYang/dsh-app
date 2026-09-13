/**
 * Session-level PDF-mode persistence.
 *
 * One JSON file (`<storeDir>/mode.json`) maps sessionId → { enabled,
 * updatedAt }. PDF mode has no template, so the state is a single boolean. The
 * in-memory map is the live state: the system-prompt section provider reads it
 * without I/O, writes go to disk asynchronously through the serialized atomic
 * writer, and boot prunes stale entries so the file cannot grow unboundedly.
 *
 * @module @dsh-app/plugin-pdf/mode-store
 */

import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Entries older than this are pruned at boot. */
export const MODE_ENTRY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** One persisted entry: whether the session's PDF mode is on. */
export interface StoredModeEntry {
  enabled: boolean
  updatedAt: number
}

/** On-disk shape of mode.json. */
export type ModeFile = Record<string, { enabled?: unknown, updatedAt?: unknown }>

/** Minimal logger face the store reports write failures through. */
export interface ModeStoreLog {
  warn(message: string): void
  info(message: string): void
}

/**
 * SessionId → enabled state with serialized async persistence. `load` must run
 * once at mount before the routes/section read the map.
 */
export class PdfModeStore {
  private readonly entries = new Map<string, StoredModeEntry>()
  /** Serialization tail: every persist appends after the previous one settles. */
  private writeTail: Promise<void> = Promise.resolve()

  constructor(
    /** Absolute path of mode.json. */
    readonly file: string,
    private readonly log: ModeStoreLog | undefined = undefined,
  ) {}

  /** Synchronously read the persisted map; missing or corrupt content starts empty. */
  load(): void {
    this.entries.clear()
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
      if (sessionId === '' || typeof value !== 'object' || value === null) continue
      const entry = value as Record<string, unknown>
      if (typeof entry.updatedAt !== 'number' || !Number.isFinite(entry.updatedAt)) continue
      // Only an explicit `true` counts as enabled; anything else reads as off.
      this.entries.set(sessionId, { enabled: entry.enabled === true, updatedAt: entry.updatedAt })
    }
  }

  /** Whether the session has PDF mode on. */
  isEnabled(sessionId: string): boolean {
    return this.entries.get(sessionId)?.enabled === true
  }

  /** When the session's entry was last written, or null while off. */
  updatedAtOf(sessionId: string): number | null {
    return this.entries.get(sessionId)?.updatedAt ?? null
  }

  /**
   * Turn PDF mode on or off. The map updates synchronously so the next prompt
   * assembly sees the change immediately; the disk copy follows asynchronously.
   */
  set(sessionId: string, enabled: boolean): void {
    if (enabled) this.entries.set(sessionId, { enabled: true, updatedAt: Date.now() })
    else this.entries.delete(sessionId)
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
    const snapshot: ModeFile = {}
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
