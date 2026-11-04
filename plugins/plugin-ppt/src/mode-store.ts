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
import { presetById } from './palette.ts'
import { DEFAULT_TEMPLATE_ID } from './templates.ts'

/** Entries older than this are pruned at boot. */
export const MODE_ENTRY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** One persisted entry: the template the session's PPT mode runs with. */
export interface StoredModeEntry {
  template: string | null
  /**
   * Whether the mode is ON for this session.
   *
   * Presence of an entry no longer means "on": a session can carry a colour the user
   * stated before turning the mode on (and keep it after turning it off), and the
   * colour belongs to the session rather than to the switch. Entries written before
   * this field existed have no `enabled` and load as ON, which is what they meant.
   */
  enabled: boolean
  /**
   * The organisation's brand colour, `#RRGGBB`, when one was supplied.
   *
   * Persisted beside the template because it is a property of the DECK, not of a
   * single assembly: the prompt provider derives the palette from it on every
   * assembly, and a value that only lived in memory would vanish on restart and
   * silently hand the next page the template's own colours.
   */
  brand: string | null
  /**
   * A curated colourway id (`palette.ts`'s `PALETTE_PRESETS`), when the user chose to
   * keep the layout but change its colours.
   *
   * Independent of `brand`: both can be set, and the brand wins (stated by the prompt
   * rather than left implicit). Stored as an id, not as six colours, so a correction
   * to a colourway reaches every session instead of only the new ones.
   */
  palette: string | null
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
      // A brand colour that is not a six-digit hex is dropped rather than repaired:
      // the value reaches a colour derivation, and guessing at a malformed one is how
      // a deck ends up with a palette nobody asked for.
      const brand = typeof entry.brand === 'string' && /^#[0-9a-fA-F]{6}$/u.test(entry.brand) ? entry.brand.toLowerCase() : null
      // A colourway id that no longer exists is dropped the same way: the palette it
      // named is gone, and keeping a dangling id would make `resolvePalette` fall back
      // silently instead of telling the settings page the choice is gone.
      const palette = typeof entry.palette === 'string' && presetById(entry.palette) !== undefined ? entry.palette : null
      // No `enabled` means an entry written before the field existed, which always
      // meant ON. An explicit `false` is a session whose switch is off but whose
      // colours are still remembered.
      const enabled = entry.enabled !== false
      // `template: null` is the on-without-template state (常规主题), distinct
      // from an absent entry, which is off.
      if (template === null || (typeof template === 'string' && template !== '')) {
        this.entries.set(sessionId, { template: template === null ? null : template, enabled, brand, palette, updatedAt })
        continue
      }
      // Legacy entry: carry the theme over as the closest template selection.
      if (typeof legacyTheme === 'string' && legacyTheme !== '') {
        this.entries.set(sessionId, { template: migrateLegacyTheme(legacyTheme), enabled, brand, palette, updatedAt })
        this.migratedCount += 1
      }
    }
    if (this.migratedCount > 0) this.persist()
  }

  /** Whether the session's PPT mode is on (with or without a template). */
  isEnabled(sessionId: string): boolean {
    return this.entries.get(sessionId)?.enabled === true
  }

  /** The session's active template, or null while off or on 常规主题. */
  templateOf(sessionId: string): string | null {
    return this.entries.get(sessionId)?.template ?? null
  }

  /** When the session's entry was last written, or null while off. */
  updatedAtOf(sessionId: string): number | null {
    return this.entries.get(sessionId)?.updatedAt ?? null
  }

  /** The session's brand colour (`#RRGGBB`), or null when the template's own stands. */
  brandOf(sessionId: string): string | null {
    return this.entries.get(sessionId)?.brand ?? null
  }

  /** The session's colourway id, or null when the template's own colours stand. */
  paletteOf(sessionId: string): string | null {
    return this.entries.get(sessionId)?.palette ?? null
  }

  /**
   * Turn PPT mode on with `template` (`null` = 常规主题). The map updates
   * synchronously so the next prompt assembly sees the change immediately;
   * the disk copy follows asynchronously.
   *
   * `brand` / `palette` are written only when the caller states them (`undefined`
   * keeps the existing value): the client's template switcher sends `template` alone,
   * and clearing a colour as a side effect of picking another layout would lose the
   * one thing the user typed in. `null` clears explicitly.
   */
  set(sessionId: string, template: string | null, brand?: string | null, palette?: string | null, enabled = true): void {
    const previous = this.entries.get(sessionId)
    this.entries.set(sessionId, {
      template,
      enabled,
      brand: brand === undefined ? previous?.brand ?? null : brand,
      palette: palette === undefined ? previous?.palette ?? null : palette,
      updatedAt: Date.now(),
    })
    this.log?.info(`ppt mode: ${sessionId} ${enabled ? 'on' : 'off'} (template=${template ?? '常规主题'}, brand=${brand ?? previous?.brand ?? 'none'}, palette=${palette ?? previous?.palette ?? 'none'})`)
    this.persist()
  }

  /**
   * Record the colours for a session WITHOUT touching the switch.
   *
   * The mode and the colours are two decisions, and a user states the second one
   * first all the time ("our brand colour is #c0392b, now make me a deck"). Refusing
   * to record it until the switch is on turned that into a three-step conversation
   * with the model in the middle.
   *
   * @param sessionId - the session whose deck this is.
   * @param brand - the brand colour, or null.
   * @param palette - the colourway id, or null.
   */
  setColours(sessionId: string, brand: string | null, palette: string | null): void {
    const previous = this.entries.get(sessionId)
    this.entries.set(sessionId, {
      template: previous?.template ?? null,
      enabled: previous?.enabled ?? false,
      brand,
      palette,
      updatedAt: Date.now(),
    })
    this.log?.info(`ppt colours: ${sessionId} brand=${brand ?? 'none'} palette=${palette ?? 'none'} (mode ${this.isEnabled(sessionId) ? 'on' : 'off'})`)
    this.persist()
  }

  /**
   * Turn PPT mode off but KEEP the session's colours.
   *
   * `clear` is still here for a session being forgotten; the switch is not that. A
   * user who turns the capsule off and back on expects their colourway to still be
   * there — the colour is a property of the deck they are building, not of the switch
   * they toggled.
   */
  disable(sessionId: string): void {
    const previous = this.entries.get(sessionId)
    if (previous === undefined) return
    this.entries.set(sessionId, { ...previous, enabled: false, updatedAt: Date.now() })
    this.log?.info(`ppt mode: ${sessionId} off (colours kept)`)
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
