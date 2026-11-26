/**
 * Event folding: project session events into usage rows.
 *
 * Only two event kinds carry the projection's inputs: `request/header`
 * reveals the serving provider/model for the turn, and `assistant/message`
 * carries the adapter's token accounting. Folding is watermark-driven — a
 * session's events below its stored watermark are skipped, so live capture
 * (one event at a time) and backfill (whole log replay) share one idempotent
 * path and the same event is counted at most once.
 *
 * The watermark may only advance past seqs that were actually folded HERE.
 * Backfill replays a contiguous suffix, so it advances to the last seq it
 * folded. A LIVE event can arrive far above the watermark: the session moved
 * on while this plugin was not capturing it (the app was closed, another
 * process or profile appended, or the start-up backfill has not reached this
 * session yet). Advancing across that gap would make every later backfill skip
 * the events inside it and under-count for good — measured on a real install,
 * one session lost nine usage rows while its watermarks on either side of the
 * gap read the same. So the live path advances only a contiguous event
 * (`seq <= watermark + 1`); a jump is still folded — rows are keyed
 * `sessionId:seq`, so the backfill re-folding it adds nothing — and the gap
 * stays the backfill's to fill.
 *
 * @module @dsh-app/plugin-usage/fold
 */

import type { UsageRow } from './types.ts'
import type { UsageStore } from './store.ts'

/**
 * Minimal structural view of one session event. Kept local (instead of
 * importing the harness event union) so the plugin compiles against any
 * kernel version whose events match these field shapes.
 */
export interface FoldEvent {
  seq: number
  time: number
  type: string
  data: unknown
}

interface RequestHeaderShape {
  header?: { config?: { provider?: unknown; model?: unknown } }
}

interface AssistantMessageShape {
  turn?: unknown
  step?: unknown
  message?: { source?: { kind?: unknown; provider?: unknown; model?: unknown } }
  usage?: Partial<Record<
    'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens',
    number
  >>
}

const asNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined

/**
 * Last-seen request header per session. Live capture folds one event at a
 * time (see foldLiveEvent), so a turn's `request/header` and its
 * `assistant/message` events arrive in separate calls — without this cache
 * the message-side header fallback would always resolve to ''. Backfill
 * replays refresh the same entries with identical values, so sharing the map
 * across both paths is safe.
 */
const headerBySession = new Map<string, { provider: string, model: string }>()

/** Cap on cached session headers; past it the oldest session drops (its next
 * header event simply re-seeds it). */
const MAX_CACHED_SESSIONS = 1_000

function rememberHeader(sessionId: string, provider: string, model: string): void {
  headerBySession.delete(sessionId)
  headerBySession.set(sessionId, { provider, model })
  if (headerBySession.size > MAX_CACHED_SESSIONS) {
    const oldest = headerBySession.keys().next()
    if (!oldest.done) headerBySession.delete(oldest.value)
  }
}

/**
 * Fold `events` (one session's suffix, `seq` above the stored watermark)
 * into the store. Provider/model resolution prefers the message's own model
 * source, falls back to the turn's request header, and finally to the
 * session's last-seen header (the live path folds one event per call, so the
 * header usually arrived in an earlier call).
 *
 * The batch is contiguous by contract — it is a log slice — so the watermark
 * advances to its last seq. A single event that jumped a gap must not take
 * this path; {@link foldLiveEvent} owns that rule.
 *
 * @param fromSeq - lowest seq to fold, when the caller knows something the
 *   store does not. The backfill passes a FORK's `inheritedEventCount` here:
 *   those leading events were copied from the parent and already folded under
 *   the parent's id, so folding them again under the child would double-count
 *   the same model calls. The store's own watermark still applies on top.
 * @returns the number of rows actually added (deduped).
 */
export function foldEvents(
  store: UsageStore,
  sessionId: string,
  events: readonly FoldEvent[],
  fromSeq?: number,
): number {
  const added = foldInto(store, sessionId, events, fromSeq)
  if (events.length > 0) store.advanceWatermark(sessionId, events[events.length - 1]!.seq)
  return added
}

/** Project the events above the fold floor into rows. Advances no watermark. */
function foldInto(
  store: UsageStore,
  sessionId: string,
  events: readonly FoldEvent[],
  fromSeq?: number,
): number {
  if (events.length === 0) return 0
  const floor = Math.max(store.watermark(sessionId), fromSeq ?? 0)
  const rows: UsageRow[] = []
  const cached = headerBySession.get(sessionId)
  let provider = cached?.provider ?? ''
  let model = cached?.model ?? ''
  for (const event of events) {
    if (event.seq <= floor) continue
    if (event.type === 'request/header') {
      const data = asObject(event.data) as RequestHeaderShape | undefined
      const config = asObject(data?.header?.config)
      provider = asString(config?.provider)
      model = asString(config?.model)
      rememberHeader(sessionId, provider, model)
    } else if (event.type === 'assistant/message') {
      const data = asObject(event.data) as AssistantMessageShape | undefined
      const usage = data?.usage
      if (usage === undefined) continue
      const source = asObject(data?.message?.source)
      const hasModelSource = asString(source?.kind) === 'model'
      rows.push({
        seq: event.seq,
        time: asNumber(event.time),
        sessionId,
        turn: asNumber(data?.turn),
        step: asNumber(data?.step),
        provider: hasModelSource && asString(source?.provider) !== '' ? asString(source?.provider) : provider,
        model: hasModelSource && asString(source?.model) !== '' ? asString(source?.model) : model,
        inputTokens: asNumber(usage.inputTokens),
        outputTokens: asNumber(usage.outputTokens),
        cacheReadTokens: asNumber(usage.cacheReadTokens),
        cacheWriteTokens: asNumber(usage.cacheWriteTokens),
        reasoningTokens: asNumber(usage.reasoningTokens),
      })
    }
  }
  return store.addRows(rows)
}

/**
 * Fold one live event as it streams through the session bus. Header events
 * seed the per-session cache; message events resolve provider/model through it.
 *
 * The watermark moves only when the event CONTINUES it (`seq <= watermark + 1`).
 * A live event can arrive above a gap this store never folded (see the module
 * header), and advancing there would hide that gap from every later backfill;
 * the row is still added under `sessionId:seq`, so the backfill's re-fold of
 * the same event is a dedupe, never a second count.
 */
export function foldLiveEvent(store: UsageStore, sessionId: string, event: FoldEvent): number {
  const watermark = store.watermark(sessionId)
  const added = foldInto(store, sessionId, [event], watermark)
  if (event.seq <= watermark + 1) store.advanceWatermark(sessionId, event.seq)
  return added
}
