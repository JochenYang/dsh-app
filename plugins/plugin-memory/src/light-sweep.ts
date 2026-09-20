/**
 * The light sweep — the no-LLM maintenance pass that runs after EVERY write
 * (a memory_save; formerly also a distill apply, a pass that is retired),
 * closing the old write-fast/clean-slow gap: the heavy curator sweeps under
 * cooldown and thresholds, while this pass is free enough to run
 * unconditionally.
 *
 *   1. merge exact-content duplicates across cards (possible after hand
 *      edits): the pinned or most-recently-updated card survives, the rest
 *      are removed;
 *   2. log similarity suspects (≥ SIM_DUPLICATE pairs under DIFFERENT topic
 *      keys — the topic model's boundary-overlap failure mode) into
 *      distill-state.json for threshold tuning and the heavy sweep's prompt;
 *   3. rebuild the index, so hand edits between writes are corrected at the
 *      next write rather than accumulating.
 *
 * @module @dsh-app/plugin-memory/light-sweep
 */

import { SIM_RELATED, contentSimilarity, normalizeForMatch, type MemoryRoot, type MemoryStore, type TopicCard } from './memory-store.ts'

/** Pick the survivor of an exact-duplicate group: a pinned card beats an
 *  unpinned one; otherwise the most recently updated wins (ties broken by
 *  name for determinism). */
function survivor(cards: readonly TopicCard[], pinned: ReadonlySet<string>): TopicCard {
  return [...cards].sort((a, b) => {
    const pinA = pinned.has(a.name) ? 1 : 0
    const pinB = pinned.has(b.name) ? 1 : 0
    return pinB - pinA || b.updated.localeCompare(a.updated) || a.name.localeCompare(b.name)
  })[0]!
}

/**
 * Run the light sweep over one store. Never throws — maintenance must not
 * break the write that triggered it.
 */
export async function lightSweep(
  root: MemoryRoot,
  label: string,
  store: MemoryStore,
  log: { info(msg: string): void, warn(msg: string): void },
): Promise<{ merged: number, suspects: number }> {
  try {
    const cards = store.list().filter(card => !card.malformed)
    const pinned = store.pinnedSet()

    // 1. Exact-content duplicates under different keys.
    const byBody = new Map<string, TopicCard[]>()
    for (const card of cards) {
      const needle = normalizeForMatch(card.body)
      if (needle === '') continue
      const group = byBody.get(needle) ?? []
      group.push(card)
      byBody.set(needle, group)
    }
    let merged = 0
    for (const group of byBody.values()) {
      if (group.length < 2) continue
      const keep = survivor(group, pinned)
      const dropped: string[] = []
      for (const card of group) {
        if (card.name !== keep.name && await store.remove(card.name, 'light-sweep-dup')) {
          merged += 1
          dropped.push(card.name)
        }
      }
      if (group.length > 1) {
        log.info(`memory light sweep: ${label} merged ${String(group.length)} exact-duplicate cards into "${keep.name}"`)
        // The survivors' exact-duplicate merge is a silent deletion otherwise:
        // record it so the ledger explains where those keys went.
        if (dropped.length > 0) {
          root.recordLedger({ scope: label, pass: 'light-sweep', op: 'merge', keys: dropped, target: keep.name })
        }
      }
    }

    // 2. Similarity suspects under different keys (tuning + heavy-sweep input).
    //    Logged from SIM_RELATED up: the near-verbatim band (≥SIM_DUPLICATE)
    //    is auto-actionable, but the rewording band below it is exactly where
    //    threshold calibration needs real data (see the constants' comment).
    let suspects = 0
    for (let i = 0; i < cards.length; i += 1) {
      for (let j = i + 1; j < cards.length; j += 1) {
        const a = cards[i]!
        const b = cards[j]!
        const score = contentSimilarity(`${a.summary} ${a.body}`, `${b.summary} ${b.body}`)
        if (score >= SIM_RELATED) {
          root.recordSuspect(label, a.name, b.name, score)
          suspects += 1
        }
      }
    }
    if (suspects > 0) {
      log.info(`memory light sweep: ${label} logged ${String(suspects)} similarity suspect pair(s)`)
    }

    // 3. Index parity after possible hand edits.
    await store.reindex()
    return { merged, suspects }
  } catch (error) {
    log.warn(`memory light sweep for ${label} failed (write unaffected): ${String(error)}`)
    return { merged: 0, suspects: 0 }
  }
}
