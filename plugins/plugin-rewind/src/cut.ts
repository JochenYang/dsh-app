/**
 * The recall computation, kept free of cordis and of any session object so it
 * is unit-testable and so the executor layer stays thin.
 *
 * Three things live here:
 *
 * 1. **Anchor enumeration** — which user messages on the current model-visible
 *    surface are recallable, newest first.
 * 2. **Cut computation** — turning "recall ordinal n" into the exact
 *    replacement range the kernel's surface fold will accept.
 * 3. **Placeholder construction** — the empty-content event that carries the
 *    replacement.
 *
 * ## Why the placeholder is a `user/message`, not a `system/message`
 *
 * The kernel's PERSISTENCE validator (not the in-memory append path) requires a
 * `system/message` to match the currently open turn AND step, and a recall runs
 * while the agent is idle — no turn is open. `append` accepts such a
 * placeholder, the write succeeds, and the session then fails to load with
 * `SessionFormatError: system/message does not match an open turn and step`.
 * `user/message` is not a step event type, so it carries no such requirement;
 * {@link placeholderData} builds it with empty content and this plugin's own
 * source kind, and the request path drops an empty user message so it
 * contributes no model-facing turn while `deriveEventMessage` still keeps it on
 * the surface. Full reasoning and the measured surface: `scratch/probe-rewind-persist.mjs`.
 *
 * The cut also always starts on a user message, which is by construction the
 * first node of its turn. That matters: a cut landing mid-turn leaves the
 * turn's later `tool/result` events with no preceding call in the derived
 * history, and a provider rejects that transcript. Cutting at the turn head
 * keeps every shadowed range whole.
 *
 * @module @dsh-app/plugin-rewind/cut
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { MAX_ANCHORS, previewText, REWIND_SOURCE_KIND, type RewindAnchor } from './wire.ts'

// The session log's V4 admission refuses the retired generic `plugin` source
// kind, so every producer declares its own. This one marks the recall
// placeholder, which is why the client can tell it apart from a real prompt.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    // The literal is required here: a `declare module` interface member cannot be
    // a computed key. `wire.REWIND_SOURCE_KIND` holds the same string and is what
    // the payload and the projection's ownership check both use.
    'dsh-app-rewind': { kind: 'dsh-app-rewind' }
  }
}

/**
 * The slice of a session event this module reads. Structural on purpose: the
 * computation runs against real kernel events and against test fixtures alike.
 */
export interface EventLike {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data: unknown
}

/**
 * The slice of a session this module reads. Structural on purpose: the
 * computation runs against real kernel sessions and against test fixtures
 * alike, and it needs only the surface order plus one event by sequence.
 */
export interface SessionLike {
  /** Current model-visible surface, in order. */
  readonly surface: { readonly nodes: readonly number[] }
  /** One logged event by sequence, or undefined when absent. */
  eventAt(seq: number): EventLike | undefined
}

/** Read the plain text of a message event, joined across text blocks. */
export function messageText(event: EventLike): string {
  const data = event.data
  if (typeof data !== 'object' || data === null) return ''
  // user/message carries its content at the top level; the other surface
  // events nest it under `message`.
  const record = data as { content?: unknown; message?: { content?: unknown } }
  const content = Array.isArray(record.content)
    ? record.content
    : Array.isArray(record.message?.content)
      ? record.message.content
      : []
  return content
    .filter((block): block is { type: string, text: string } => (
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
    ))
    .map((block) => block.text)
    .join('')
}

/** Whether an event is a real user prompt (not injected context or steering). */
export function isUserPrompt(event: EventLike): boolean {
  if (event.type !== 'user/message') return false
  const data = event.data
  if (typeof data !== 'object' || data === null) return false
  const source = (data as { source?: unknown }).source
  if (typeof source !== 'object' || source === null) return false
  return (source as { kind?: unknown }).kind === 'user'
}

/**
 * Track the turn each surface node belongs to.
 *
 * Message events carry no `turn` of their own — only `system/message` and
 * `step/start` do, and neither marks a user prompt's turn. The turn a node
 * belongs to is opened by `turn/start` and held until the next one, which is
 * what the client's own assembler does. Reading `data.turn` off a `user/message`
 * silently yields nothing, so this walks the log in order and carries the open
 * turn forward.
 *
 * @param session - the session to walk.
 * @returns a map from surface node seq to its turn, absent when none was open.
 */
export function surfaceTurns(session: SessionLike): Map<number, number> {
  const turns = new Map<number, number>()
  let open: number | null = null
  const nodes = session.surface.nodes
  // Walk the whole log in sequence order up to the last surface node, so a
  // `turn/start` that is not itself a surface node still moves the counter.
  const last = nodes.length === 0 ? -1 : nodes[nodes.length - 1]
  for (let seq = 0; seq <= last; seq += 1) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    if (event.type === 'turn/start') {
      const turn = (event.data as { turn?: unknown } | null)?.turn
      if (typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0) open = turn
      continue
    }
    if (open !== null && nodes.includes(seq)) turns.set(seq, open)
  }
  return turns
}
/**
 * Enumerate recallable points, newest first, capped at {@link MAX_ANCHORS}.
 *
 * `n` is assigned from the newest backwards so it stays a "how far back" menu
 * while the menu is open.
 *
 * The rule is "the FIRST prompt of its turn", which excludes a steering message
 * (a mid-turn interjection that shares the prompt shape). Walking newest-to-
 * oldest, the message that opens a turn is seen LAST, so the first one recorded
 * for a turn is kept and later ones in the same turn are skipped.
 *
 * This MUST stay byte-for-byte equivalent to `rewindView` in `./projection.ts`:
 * the client shows ordinal `n` and the host resolves `/rewind n` by recomputing
 * this list. `tests/anchors.test.ts` checks both against one surface.
 */
export function listAnchors(session: SessionLike, max: number = MAX_ANCHORS): RewindAnchor[] {
  const anchors: RewindAnchor[] = []
  const nodes = session.surface.nodes
  const turns = surfaceTurns(session)
  // The turn's FIRST prompt opens it, so the rule is applied in LOG order and
  // only the surviving nodes are then reversed into "newest first". Applying it
  // newest-to-oldest kept the STEERING message instead of the opener — the exact
  // opposite of the rule's intent — which the cross-check in
  // `tests/anchors.test.ts` caught.
  const openers = new Set<number>()
  const claimed = new Set<number>()
  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (event === undefined || !isUserPrompt(event)) continue
    const turn = turns.get(seq) ?? null
    if (turn === null) {
      openers.add(seq)
      continue
    }
    if (claimed.has(turn)) continue
    claimed.add(turn)
    openers.add(seq)
  }
  for (let i = nodes.length - 1; i >= 0 && anchors.length < max; i -= 1) {
    const seq = nodes[i]
    if (!openers.has(seq)) continue
    const event = session.eventAt(seq)
    if (event === undefined) continue
    anchors.push({
      n: anchors.length + 1,
      seq,
      turn: turns.get(seq) ?? null,
      time: event.time,
      preview: previewText(messageText(event)),
    })
  }
  return anchors
}

/** A computed replacement range, before it is written to the log. */
export interface PlannedCut {
  /** First shadowed surface node (the recalled user message itself). */
  readonly startSeq: number
  /** Last shadowed surface node (the current surface tail). */
  readonly endSeq: number
  /** Every shadowed surface node, ascending — the kernel demands all of them. */
  readonly shadowedSeqs: readonly number[]
  /** Turns covered by the range, ascending — what the client hides. */
  readonly turns: readonly number[]
  /** Original text of the recalled message. */
  readonly prompt: string
  /** Turn of the recalled message, when it carries one. */
  readonly turn: number | null
}

/** Why a cut could not be planned. Each maps to a client dictionary key. */
export type PlanFailure =
  | { readonly reason: 'empty' }
  | { readonly reason: 'outOfRange', readonly available: number }
  | { readonly reason: 'notUserMessage' }

/**
 * Turn "recall ordinal `n`" into the exact range to replace.
 *
 * The range runs from the recalled user message through the current surface
 * tail, so the recalled message and everything after it leave the model's
 * view. `sourceEventSeqs` must cite **every** shadowed node — the kernel's
 * fold rejects a partial citation (`surface replace: sourceEventSeqs must
 * include every shadowed surface node`).
 */
export function planCut(session: SessionLike, n: number, max: number = MAX_ANCHORS): PlannedCut | PlanFailure {
  const anchors = listAnchors(session, max)
  if (anchors.length === 0) return { reason: 'empty' }
  if (!Number.isSafeInteger(n) || n < 1 || n > anchors.length) {
    return { reason: 'outOfRange', available: anchors.length }
  }
  const anchor = anchors[n - 1]
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(anchor.seq)
  if (startIdx === -1) return { reason: 'notUserMessage' }
  const shadowedSeqs = nodes.slice(startIdx)
  if (shadowedSeqs.length === 0) return { reason: 'notUserMessage' }

  const turns: number[] = []
  const turnMap = surfaceTurns(session)
  for (const seq of shadowedSeqs) {
    const turn = turnMap.get(seq)
    if (turn !== undefined && !turns.includes(turn)) turns.push(turn)
  }
  turns.sort((a, b) => a - b)

  return {
    startSeq: anchor.seq,
    endSeq: shadowedSeqs[shadowedSeqs.length - 1],
    shadowedSeqs,
    turns,
    prompt: messageText(session.eventAt(anchor.seq) ?? { seq: anchor.seq, time: 0, type: '', data: null }),
    turn: anchor.turn,
  }
}

/**
 * Build the placeholder payload for a replacement.
 *
 * ## Why this is a `user/message` and not a `system/message`
 *
 * The kernel's PERSISTENCE validator (not the in-memory append path) requires a
 * `system/message` to match the currently open turn AND step:
 *
 *   requireStep(event, data) {
 *     if (this.turn === null || this.step === null
 *         || data["turn"] !== this.turn || data["step"] !== this.step)
 *       throw new SessionFormatError(`${event.type} does not match an open turn and step`)
 *   }
 *
 * A recall runs while the agent is idle — no turn is open — so a system-role
 * placeholder can NEVER satisfy that rule. `append` accepts it (it validates the
 * surface only), the write succeeds, and the session then fails to load:
 *
 *   SessionFormatError: system/message does not match an open turn and step
 *
 * `user/message` is not a step event type, so it carries no such requirement.
 * Its content is empty, and the request path drops a user message whose content
 * filters to nothing, so it contributes no model-facing turn — while
 * `deriveEventMessage` still keeps it on the surface, which is exactly what a
 * replacement node must do.
 *
 * This is verified against the kernel's released v4 relationship validator and
 * a real session log in `scratch/probe-rewind-persist.mjs`; see also
 * `scratch/scan-session-damage.mjs`, which locates the sessions the earlier
 * system-role placeholder corrupted.
 */
export function placeholderData(): UserMessage {
  return createUserMessage({
    content: [],
    source: { kind: REWIND_SOURCE_KIND },
  })
}
