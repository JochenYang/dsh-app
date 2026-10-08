/**
 * Pure wiring shared by both halves of the rewind plugin: the projection key,
 * the wire payload shapes, and the error codes the host answers with.
 *
 * Zero node builtins — the browser bundle imports this module directly, so
 * everything here must be valid in both a Node child and a page.
 *
 * The host half never sends user-visible prose: a failure travels as a stable
 * code plus the values its sentence interpolates ({@link HostText}), and the
 * client dictionary renders it. Matching on prose across that boundary is how
 * a wording change silently becomes a behavior change.
 *
 * @module @dsh-app/plugin-rewind/wire
 */

/**
 * Key of the session projection this plugin registers. It carries the
 * recall-point list and the shadowed ranges, so the client never folds session
 * events itself.
 */
export const REWIND_PROJECTION_KEY = 'rewindAnchors'

/** Slash command that performs a recall (bare = list, `/<n>` = recall that one). */
export const REWIND_COMMAND = 'rewind'

/**
 * Message-source kind the plugin-owned placeholder carries, so the client can
 * tell a recall placeholder apart from a real prompt and `listAnchors` never
 * offers it as a recall point.
 */
export const REWIND_SOURCE_KIND = 'dsh-app-rewind'

/**
 * Maximum recall points offered. ONE value for both halves.
 *
 * The client's list and the host's ordinal MUST agree: the client shows row `n`
 * and the host resolves `/rewind n`, so a second cap on either side shifts every
 * ordinal past it. This used to be a constant here (50) against a config default
 * there (20), which made rows 21-50 of the picker resolve to "only 20 recallable
 * messages" — see the cross-check test in `tests/anchors.test.ts`.
 */
export const MAX_ANCHORS = 50

/** Maximum characters of a message's text carried in one anchor's preview. */
export const PREVIEW_CHARS = 80

/**
 * One recallable user message on the current model-visible surface.
 *
 * `n` is the user-facing ordinal, 1 = newest, so the list reads like a
 * "how far back" menu and stays stable while the menu is open.
 */
export interface RewindAnchor {
  /** User-facing ordinal: 1 is the newest recallable message. */
  readonly n: number
  /** Surface node sequence of this user message. */
  readonly seq: number
  /** Turn this message opened, for whole-turn hiding on the client. */
  readonly turn: number | null
  /** Event time (epoch ms). */
  readonly time: number
  /** Whitespace-collapsed preview of the message text. */
  readonly preview: string
}

/**
 * Codes a `/rewind` invocation is answered with. Each names one sentence in the
 * client dictionary; the host never sends the sentence itself.
 *
 * These strings ARE the dictionary keys (the `rewind.host.` block), so a
 * renamed code and its sentence cannot drift apart silently — the client's
 * unknown-code fallback only fires for a code this build genuinely lacks.
 */
export type RewindCode =
  /** The session is mid-turn; a replacement now would orphan tool results. */
  | 'rewind.host.busy'
  /** The argument is not a positive integer. */
  | 'rewind.host.badArg'
  /** The ordinal is outside the current list. */
  | 'rewind.host.outOfRange'
  /** Nothing recallable yet. */
  | 'rewind.host.empty'
  /** The cut would not start on a user message. */
  | 'rewind.host.notUserMessage'
  /** The kernel refused the replacement; `text` carries its own message. */
  | 'rewind.host.rejected'
  /** The listing succeeded; `count` is how many points were offered. */
  | 'rewind.host.list'
  /** A cut succeeded; `n` is the ordinal that was recalled. */
  | 'rewind.host.done'
  /** The preview succeeded; the plan rides the payload's `files`. */
  | 'rewind.host.plan'

/**
 * One file a recall would change, as the confirmation preview shows it.
 *
 * `action` names what will happen, so the dialog can group and label rows the way
 * the operator thinks about them rather than as one undifferentiated list.
 */
export interface FileChangePreview {
  /** Absolute path of the file. */
  readonly path: string
  /**
   * `restore` — the file exists and will be put back to its earlier content.
   * `remove` — the recalled range CREATED it; it moves into the quarantine.
   */
  readonly action: 'restore' | 'remove'
  /** Bytes the file holds now, for the diff. Absent when it does not exist. */
  readonly current?: string
  /** Bytes it will hold after the recall. Absent for `remove`. */
  readonly next?: string
}

/**
 * The whole file effect of one would-be recall — ONE definition, shared.
 *
 * The host builds it (`previewRevert` in `src/index.ts`) and the client's
 * confirmation dialog renders it. Every field is optional so the client can read
 * it defensively while the host supplies what it has; a second, locally-declared
 * copy of this type lived in `client/confirm-dialog.tsx` with a DIFFERENT field
 * set, which meant a change made against one compiled and silently failed to
 * arrive at the other.
 *
 * A change this plugin never saw — a shell command, an oversized file — is
 * `unrestorable` and named, never omitted: a preview that quietly leaves things
 * out is worse than no preview, because it teaches the user to trust it.
 */
export interface RevertPlan {
  readonly restore?: readonly FileChangePreview[]
  readonly remove?: readonly FileChangePreview[]
  readonly unrestorable?: readonly { readonly path: string, readonly reason: string }[]
  /** Whether a recall at this ordinal is possible at all. */
  readonly ok?: boolean
  /** Why not, as a dictionary code, when `ok` is false. */
  readonly reason?: RewindCode
  readonly params?: Readonly<Record<string, string | number>>
  /** The recalled message's original text, for the composer. */
  readonly prompt?: string
  /** The ordinal the plan was computed for. */
  readonly n?: number
}

/**
 * One host answer that carries no prose: a stable code plus the values its
 * sentence interpolates.
 */
export interface HostText {
  readonly code: string
  readonly params?: Readonly<Record<string, string | number>>
  /** English developer-facing fallback; shown only for an unknown code. */
  readonly text?: string
}

/** Build one coded host answer. */
export function hostText(
  code: RewindCode,
  params?: Readonly<Record<string, string | number>>,
  text?: string,
): HostText {
  return { code, ...(params === undefined ? {} : { params }), ...(text === undefined ? {} : { text }) }
}

/**
 * Collapse whitespace and cap length for one anchor preview. Pure, so the
 * client and the host agree on what a preview looks like.
 */
export function previewText(raw: string, limit: number = PREVIEW_CHARS): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed
}
