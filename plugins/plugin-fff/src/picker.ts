/**
 * PickerManager — lifecycle owner of FFF `FileFinder` instances.
 *
 * FFF indexes a whole workspace into memory (path index + optional content
 * cache + frecency db); a fresh instance pays a full rescan, so instances
 * must be reused, not re-created per call. This manager:
 *
 * - keys instances by the symlink-resolved absolute workspace path (the
 *   `basePath` FFF fences itself to — every search result is relative to it,
 *   which is exactly the security boundary we rely on);
 * - single-flights concurrent acquisition of the same key (one `create` +
 *   initial scan in flight, everyone else awaits the same promise);
 * - guards each in-flight call with a reference count so idle reaping never
 *   destroys a finder that is mid-scan;
 * - reaps idle instances (LRU when at `maxInstances`, then age-based when a
 *   periodic sweep runs) so several workspaces stay hot but memory stays
 *   bounded;
 * - persists frecency + query history per workspace (separate db files per
 *   key hash: FFF records absolute paths, so a shared db would let one
 *   workspace's slots pollute another's ranking).
 *
 * All callers go through {@link acquire}, which resolves the path, gets (or
 * creates) the instance, waits for its initial scan, and returns a guard
 * (call `done()` when finished).
 */

import { createHash } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { FileFinder } from '@ff-labs/fff-node'
import type { FileFinder as Finder } from '@ff-labs/fff-node'

/** A live finder held by one operation. Must call `done()` exactly once. */
export interface HeldFinder {
  /** Resolved workspace path — the fff basePath (results are relative to it). */
  key: string
  finder: Finder
  /** Release the in-flight guard. */
  done(): void
}

/** Minimal logger surface (the dsh context logger satisfies this). */
export interface PickerLog {
  info(message: string): void
  warn(message: string): void
}

export interface PickerOptions {
  /** Directory for per-workspace frecency/history db files. */
  storeDir: string
  /** Persist frecency + query history (creates the store dir on demand). */
  enableFrecency: boolean
  /** Bounds for live instances (LRU-reaps idle ones when exceeded). */
  maxInstances: number
  log: PickerLog
}

/** Result of an attempted acquisition — mirrors FFF's Result pattern. */
export type AcquireResult =
  | { ok: true; held: HeldFinder }
  | { ok: false; error: string }

interface Entry {
  finder: Finder
  key: string
  /** Monotonic last-touch timestamp (ms since epoch). */
  lastUsed: number
  /** Number of operations currently using the finder. */
  active: number
}

export class PickerManager {
  private readonly entries = new Map<string, Entry>()
  /** Single-flight key: promise for a key's entry creation + initial scan. */
  private readonly inflight = new Map<string, Promise<Entry>>()
  private readonly storeDir: string
  private readonly enableFrecency: boolean
  private readonly maxInstances: number
  private readonly log: PickerLog

  constructor(options: PickerOptions) {
    this.storeDir = options.storeDir
    this.enableFrecency = options.enableFrecency
    this.maxInstances = Math.max(1, Math.floor(options.maxInstances))
    this.log = options.log
  }

  /**
   * Resolve the workspace and return a ready finder (initial scan done).
   * Every consumer must call `held.done()` when finished.
   */
  async acquire(cwd: string, scanWaitMs: number): Promise<AcquireResult> {
    let key: string
    try {
      key = await realpath(cwd)
    } catch {
      if (cwd === undefined || cwd === '') return { ok: false, error: '没有可搜索的工作区，请先在工作区中打开会话' }
      return { ok: false, error: '工作区目录不存在或已被删除' }
    }

    const existing = this.entries.get(key)
    if (existing !== undefined) return this.hold(existing)

    try {
      const entry = await this.getOrCreate(key, scanWaitMs)
      return this.hold(entry)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Reap instances idle longer than `idleTtlMs` (called by the periodic sweep). */
  sweepIdle(idleTtlMs: number): void {
    const cutoff = Date.now() - idleTtlMs
    for (const [key, entry] of this.entries) {
      if (entry.active === 0 && entry.lastUsed < cutoff) this.evict(key)
    }
  }

  /**
   * Start the periodic idle sweep; returns a disposer. Safe to ignore for
   * tests that call {@link sweepIdle} directly.
   */
  startReaper(idleTtlMs: number): () => void {
    const timer = setInterval(() => this.sweepIdle(idleTtlMs), 60_000)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  /** Destroy every instance and forget all state (plugin disposal). */
  destroyAll(): void {
    for (const key of [...this.entries.keys()]) this.evict(key)
  }

  private hold(entry: Entry): AcquireResult {
    entry.active += 1
    entry.lastUsed = Date.now()
    return {
      ok: true,
      held: {
        key: entry.key,
        finder: entry.finder,
        done: () => {
          entry.active = Math.max(0, entry.active - 1)
        },
      },
    }
  }

  private async getOrCreate(key: string, scanWaitMs: number): Promise<Entry> {
    const pending = this.inflight.get(key)
    if (pending !== undefined) return pending
    const task = this.createEntry(key, scanWaitMs)
    this.inflight.set(key, task)
    try {
      return await task
    } finally {
      this.inflight.delete(key)
    }
  }

  private async createEntry(key: string, scanWaitMs: number): Promise<Entry> {
    if (this.entries.size >= this.maxInstances) this.reapOneLru()

    let finder: Finder | undefined
    try {
      const dbPaths = await this.dbPaths(key)
      const created = FileFinder.create({
        basePath: key,
        aiMode: true,
        disableMmapCache: false,
        ...dbPaths,
      })
      if (!created.ok) throw new Error(`create failed (${created.error})`)
      finder = created.value
      const waited = await finder.waitForScan(scanWaitMs)
      if (!waited.ok) throw new Error(`scan failed (${String(waited.error)})`)
      if (!waited.value) {
        finder.destroy()
        throw new Error('索引尚未就绪，请稍后重试')
      }
    } catch (error) {
      // A stunned native component surfaces as a create-time failure. Keep the
      // detail transient (log it) but the user-facing message stable.
      this.log.warn(`fff picker create failed for ${key}: ${error instanceof Error ? error.message : String(error)}`)
      finder?.destroy()
      throw new Error('文件搜索引擎初始化失败（原生组件未就绪），请重试或重启应用')
    }

    const entry: Entry = { finder, key, lastUsed: Date.now(), active: 0 }
    this.entries.set(key, entry)
    this.log.info(`fff index ready: ${key}`)
    return entry
  }

  /** Frecency/history db file paths, keyed per workspace so rankings never
   * leak across projects (FFF records absolute paths; a shared db would
   * pollute another project's scores). */
  private async dbPaths(key: string): Promise<{ frecencyDbPath: string; historyDbPath: string } | Record<string, never>> {
    if (!this.enableFrecency) return {}
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 16)
    await mkdir(this.storeDir, { recursive: true })
    return {
      frecencyDbPath: join(this.storeDir, `${hash}.frecency.db`),
      historyDbPath: join(this.storeDir, `${hash}.history.db`),
    }
  }

  /** Drop the least-recently-used idle instance (active===0) to make room. */
  private reapOneLru(): void {
    let oldestKey: string | undefined
    let oldestUsed = Infinity
    for (const [key, entry] of this.entries) {
      if (entry.active > 0) continue
      if (entry.lastUsed < oldestUsed) {
        oldestUsed = entry.lastUsed
        oldestKey = key
      }
    }
    if (oldestKey !== undefined) {
      this.log.info(`fff picker: reaping idle index (${oldestKey})`)
      this.evict(oldestKey)
    } else {
      this.log.warn(`fff picker: at max ${String(this.maxInstances)} instances, all busy — allowing temporary overrun`)
    }
  }

  private evict(key: string): void {
    const entry = this.entries.get(key)
    if (entry === undefined) return
    this.entries.delete(key)
    try {
      entry.finder.destroy()
    } catch (error) {
      this.log.warn(`fff picker: destroy failed for ${key}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}