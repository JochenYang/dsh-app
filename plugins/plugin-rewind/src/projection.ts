/**
 * The `rewindAnchors` session projection: the client's entire read face.
 *
 * The kernel's own guidance is that a value derived from a session belongs in a
 * `ctx.sessionProjections` unit — computed once on the host and shipped to the
 * client already folded, because the client must not fold session events
 * itself. This unit therefore maintains a small model of the model-visible
 * surface and publishes two things:
 *
 *   - `anchors` — the recallable user messages, newest first;
 *   - `hiddenTurns` — turns already cut away, so the client can hide them;
 *
 * ## The surface model
 *
 * The unit mirrors exactly the two fold rules the kernel applies to its node
 * list (`planSurfaceEvent` / `applySurfacePlan`):
 *
 *   - a surface-eligible event carrying `surfaceOp: 'append'` is pushed;
 *   - one carrying a `replace` range splices that range out and takes its place.
 *
 * Message-projection events never join the node list, so they are ignored here.
 * Keeping the rules identical is what makes an anchor's `seq` agree with the
 * range the executor writes.
 *
 * State stays plain JSON — no Maps, Sets, or class instances — because the
 * projection cache persists it and a cold read replays only the tail.
 *
 * @module @dsh-app/plugin-rewind/projection
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { previewText, REWIND_PROJECTION_KEY, REWIND_SOURCE_KIND, MAX_ANCHORS, type RewindAnchor } from './wire.ts'

/** One node currently on the model-visible surface. */
interface SurfaceNode {
  /** Event sequence. */
  readonly seq: number
  /** Event time (epoch ms), for the picker's timestamp column. */
  readonly time: number
  /** Turn the event belongs to, or null when it carries none. */
  readonly turn: number | null
  /**
   * Whether this node is a user PROMPT (`user/message` with `source.kind:
   * 'user'`), which is the only shape a recall point can have.
   *
   * Tracked as its own flag rather than inferred from `text !== ''`: a prompt
   * sent with no text at all (an attachment-only message, a first-class send the
   * composer supports) is still a prompt and still a recall point, and the host
   * enumerates it. Inferring prompt-ness from text made the two halves disagree
   * on exactly that shape, which shifted every ordinal past it.
   */
  readonly prompt: boolean
  /** Full text of a real user prompt; empty for every other node. */
  readonly text: string
}

/** The client-visible wire value. */
export interface RewindWire {
  readonly anchors: readonly RewindAnchor[]
  readonly hiddenTurns: readonly number[]
}

/**
 * Declare this plugin's projection key in the framework's merge-extensible
 * tables, so `ctx.sessionProjections.register` type-checks and a host reader
 * can name the key. Both tables are declared because the key is client-visible.
 */
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Surface model plus hidden turns; see {@link RewindState}. */
    rewindAnchors: RewindState
  }
  interface SessionProjectionMap {
    /** Recall points and hidden turns. */
    rewindAnchors: RewindWire
  }
}

/** A non-negative integer. */
const nonNegInt = z.number().int().nonnegative()

const surfaceNodeSchema = z.object({
  seq: nonNegInt,
  time: nonNegInt,
  turn: nonNegInt.nullable(),
  prompt: z.boolean(),
  text: z.string(),
})

export const rewindStateSchema = z.object({
  nodes: z.array(surfaceNodeSchema),
  hiddenTurns: z.array(nonNegInt),
  openTurn: nonNegInt.nullable(),
})

export const rewindWireSchema = z.object({
  anchors: z.array(z.object({
    n: nonNegInt,
    seq: nonNegInt,
    turn: nonNegInt.nullable(),
    time: nonNegInt,
    preview: z.string(),
  })),
  hiddenTurns: z.array(nonNegInt),
})

/** Read a non-negative integer field, or null. */
function readNonNegInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** Read the plain text of a message payload, joined across text blocks. */
function readText(payload: unknown): string {
  const record = payload as { content?: unknown, message?: { content?: unknown } } | null
  if (typeof record !== 'object' || record === null) return ''
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

/** Whether an event's source marks a real user prompt rather than injected context. */
function isUserSource(payload: unknown): boolean {
  const record = payload as { source?: unknown } | null
  if (typeof record !== 'object' || record === null) return false
  const source = record.source
  if (typeof source !== 'object' || source === null) return false
  return (source as { kind?: unknown }).kind === 'user'
}

/** The narrowed surface marker an event carries. */
type SurfaceOp = 'append' | { readonly startSeq: number, readonly endSeq: number } | undefined

/** Narrow one event's `surfaceOp`, ignoring anything this fold does not model. */
function readSurfaceOp(event: { readonly surfaceOp?: unknown }): SurfaceOp {
  const raw = event.surfaceOp
  if (raw === undefined) return undefined
  if (raw === 'append') return 'append'
  if (typeof raw !== 'object' || raw === null) return undefined
  const op = raw as { op?: unknown, startSeq?: unknown, endSeq?: unknown }
  if (op.op !== 'replace') return undefined
  const startSeq = readNonNegInt(op.startSeq)
  const endSeq = readNonNegInt(op.endSeq)
  return startSeq === null || endSeq === null ? undefined : { startSeq, endSeq }
}

/** Event types that can join the model-visible surface. */
const SURFACE_EVENT_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/**
 * Fold state is a small model of the model-visible surface plus the turn
 * counter.
 *
 * The turn a node belongs to is NOT carried by message events: `turn/start`
 * opens a turn and every following surface node belongs to it until the next
 * `turn/start`. Reading `data.turn` off a `user/message` finds nothing (it is
 * only set on `system/message` and `step/start`), so the fold tracks the open
 * turn itself — the same thing the client's assembler does.
 */
export interface RewindState {
  /** Surface nodes in order. */
  nodes: SurfaceNode[]
  /** Turns hidden by every cut so far, ascending and deduplicated. */
  hiddenTurns: number[]
  /** Turn opened by the latest `turn/start`, or null before the first one. */
  openTurn: number | null
}

/** Initial state: an empty surface and no cuts. */
export function initRewindState(): RewindState {
  return { nodes: [], hiddenTurns: [], openTurn: null }
}

/**
 * Fold one event.
 *
 * Returns the SAME reference for an event this unit ignores, so unchanged state
 * costs nothing downstream — the registry compares with `Object.is`.
 */
export function applyRewindEvent(state: RewindState, event: unknown): RewindState {
  const candidate = event as {
    readonly type?: unknown
    readonly seq?: unknown
    readonly time?: unknown
    readonly data?: unknown
    readonly surfaceOp?: unknown
  } | null
  if (typeof candidate !== 'object' || candidate === null) return state

  const type = candidate.type
  if (typeof type !== 'string') return state

  // A turn boundary moves the open turn. Message events carry no turn of their
  // own (reading `data.turn` off a `user/message` finds nothing), so this is
  // where a node's turn comes from — the same thing the client's assembler does.
  if (type === 'turn/start') {
    const turn = readNonNegInt((candidate.data as { turn?: unknown } | null)?.turn)
    return turn === null || turn === state.openTurn ? state : { ...state, openTurn: turn }
  }

  if (!SURFACE_EVENT_TYPES.has(type)) return state

  const op = readSurfaceOp(candidate)
  if (op === undefined) return state

  const seq = readNonNegInt(candidate.seq)
  if (seq === null) return state
  const time = readNonNegInt(candidate.time) ?? 0
  const prompt = type === 'user/message' && isUserSource(candidate.data)
  const text = prompt ? readText(candidate.data) : ''
  const node: SurfaceNode = { seq, time, turn: state.openTurn, prompt, text }

  if (op === 'append') {
    return { ...state, nodes: [...state.nodes, node] }
  }

  const startIdx = state.nodes.findIndex((item) => item.seq === op.startSeq)
  const endIdx = state.nodes.findIndex((item) => item.seq === op.endSeq)
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) return state

  // ONLY this plugin's own replacements hide turns.
  //
  // Every surface replacement used to count, and the log says that is wrong: on
  // this machine's own sessions the replacements are `system/message` (241),
  // `tool/result` (127), `compact-checkpoint` (8) against 2 recalls. Counting
  // them all made ordinary compaction hide historical turns from the transcript,
  // which is a display change the user never asked for.
  //
  // The placeholder carries this plugin's source kind, so it is the one shape
  // that identifies a recall by construction.
  if (!isOwnReplacement(candidate)) {
    return {
      ...state,
      nodes: [...state.nodes.slice(0, startIdx), node, ...state.nodes.slice(endIdx + 1)],
    }
  }

  const shadowed = state.nodes.slice(startIdx, endIdx + 1)
  const hiddenTurns = [...state.hiddenTurns]
  for (const item of shadowed) {
    if (item.turn !== null && !hiddenTurns.includes(item.turn)) hiddenTurns.push(item.turn)
  }
  hiddenTurns.sort((a, b) => a - b)

  return {
    ...state,
    nodes: [...state.nodes.slice(0, startIdx), node, ...state.nodes.slice(endIdx + 1)],
    hiddenTurns,
  }
}

/** Whether one replacement event was written by this plugin. */
function isOwnReplacement(event: { readonly data?: unknown }): boolean {
  const data = event.data as { source?: { kind?: unknown } } | null
  return data?.source?.kind === REWIND_SOURCE_KIND
}

/**
 * Project state to the wire value: recall points newest first, plus what has
 * already been hidden.
 *
 * The enumeration MUST match the host's `listAnchors` exactly, because the
 * client shows ordinal `n` and the host resolves `/rewind n` by recomputing the
 * same list. The two drifted once — this filtered on `text !== ''` while the
 * host filtered on prompt-ness — and a prompt with no text (an attachment-only
 * send) then shifted every ordinal past it by one, so the picker's row for one
 * message recalled a different one. `tests/anchors.test.ts` now checks the two
 * functions against one surface.
 */
export function rewindView(state: RewindState): RewindWire {
  const anchors: RewindAnchor[] = []
  // "First prompt of its turn is the recall point", applied in LOG order — a
  // steering message shares the prompt shape but is a mid-turn interjection, and
  // a recall starting there would cut mid-turn. The surviving nodes are then read
  // backwards so `n = 1` is the newest, matching `listAnchors`.
  const openers = new Set<number>()
  const claimed = new Set<number>()
  for (const node of state.nodes) {
    if (!node.prompt) continue
    if (node.turn === null) {
      openers.add(node.seq)
      continue
    }
    if (claimed.has(node.turn)) continue
    claimed.add(node.turn)
    openers.add(node.seq)
  }
  for (let i = state.nodes.length - 1; i >= 0 && anchors.length < MAX_ANCHORS; i -= 1) {
    const node = state.nodes[i]
    if (!openers.has(node.seq)) continue
    anchors.push({
      n: anchors.length + 1,
      seq: node.seq,
      turn: node.turn,
      time: node.time,
      preview: previewText(node.text),
    })
  }
  return { anchors, hiddenTurns: state.hiddenTurns }
}

/**
 * The projection definition this plugin registers.
 *
 * `stateVersion` is bumped whenever the fold's fields or semantics change; the
 * cache then discards a stale checkpoint instead of seeding a wrong fold.
 */
export const rewindProjection = {
  key: REWIND_PROJECTION_KEY,
  stateSchema: rewindStateSchema,
  init: () => initRewindState(),
  apply: applyRewindEvent,
  wire: {
    viewSchema: rewindWireSchema,
    view: rewindView,
  },
  stateVersion: 2,
} satisfies ProjectionDefinition<'rewindAnchors'>
