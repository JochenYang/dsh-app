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
 * Fold `events` (one session's suffix, `seq` above the stored watermark)
 * into the store. Provider/model resolution prefers the message's own model
 * source and falls back to the turn's request header.
 * @returns the number of rows actually added (deduped).
 */
export function foldEvents(store: UsageStore, sessionId: string, events: readonly FoldEvent[]): number {
  if (events.length === 0) return 0
  const fromSeq = store.watermark(sessionId)
  const rows: UsageRow[] = []
  let provider = ''
  let model = ''
  for (const event of events) {
    if (event.seq <= fromSeq) continue
    if (event.type === 'request/header') {
      const data = asObject(event.data) as RequestHeaderShape | undefined
      const config = asObject(data?.header?.config)
      provider = asString(config?.provider)
      model = asString(config?.model)
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
  store.advanceWatermark(sessionId, events[events.length - 1]!.seq)
  return store.addRows(rows)
}

/** Fold one live event as it streams through the session bus. */
export function foldLiveEvent(store: UsageStore, sessionId: string, event: FoldEvent): number {
  return foldEvents(store, sessionId, [event])
}
