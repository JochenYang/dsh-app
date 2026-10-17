/**
 * DSH APP rewind — host half.
 *
 * Adds the capability stock dsh lacks: **recall a message you already sent**.
 * A sent message cannot be edited or withdrawn; this plugin cuts the current
 * model-visible surface back to before a chosen user message and hands the
 * original text back to the composer so it can be corrected and re-sent.
 *
 * ## How the cut works
 *
 * The session log is append-only and stays the source of truth. What the model
 * reads is the *surface*: an ordered view folded from the log, where a
 * message-producing event either appends to the tail or replaces a range
 * (`surfaceOp: { op: 'replace', startSeq, endSeq }`). A recall is one such
 * replacement, so:
 *
 *   - the recalled message and everything after it leave the model's view;
 *   - nothing is deleted — the log keeps every event, and a reader that ignores
 *     surface ops still sees the full human transcript;
 *   - the client keeps rendering the append-origin log (deliberate in the
 *     kernel: a landed replacement must not erase what the user already saw),
 *     which is why this plugin also tells the client which turns to hide.
 *
 * The placeholder is an empty-content `user/message` carrying this plugin's own
 * source kind, never a `system/message`: the persistence validator requires a
 * system message to match the currently OPEN turn and step, and a recall happens
 * while the agent is idle, so a system-role placeholder writes fine and then
 * makes the session unloadable. An empty user message contributes no model-facing
 * turn while `deriveEventMessage` still keeps it on the surface. See
 * `placeholderData` in `./cut.ts`.
 *
 * ## Putting the tree back — two sources, merged
 *
 * A recall also puts back the files the range changed, and no single seam sees
 * all of them:
 *
 *   1. **The write waterfalls** (`fs/write-intent` / `fs/edit-intent`) give an
 *      EXACT before-image for `write`, `edit` and `str_replace_editor` — the only
 *      source that can see a write outside the workspace, and the only one that
 *      covers a directory the workspace snapshot skips.
 *   2. **The workspace snapshot** (`./trees.ts`) is a bounded copy of the
 *      workspace taken before the first tool call of a turn that could write. It
 *      is what covers everything the waterfalls cannot see: a shell command, a
 *      script the model ran, an office renderer, a subagent's edits.
 *
 * For a path the snapshot covers, the snapshot's bytes are the range's starting
 * state and win; everywhere else the recorder's before-image is used. See
 * `mergeTargets`.
 *
 * ## Coverage is reported, never assumed
 *
 * The snapshot is taken lazily, so a range can predate it: a kernel child that
 * restarted, a turn from before this feature existed, or a profile with the
 * snapshot turned off. When the range ran a tool whose writes this plugin cannot
 * see AND no snapshot exists for its first turn, the recall says so instead of
 * reporting a clean success over a tree it only partly put back. That silence is
 * the bug this reporting exists to end: measured on a real session, a recall
 * answered `{restored: 6, removed: 8, unrestorable: []}` while 27 shell calls in
 * the same range had just rewritten a sprite sheet and a `dist/` tree.
 *
 * ## The recallable range stops at the newest compaction
 *
 * A compaction replaces the history it summarised with one `compact-checkpoint`
 * message, so the prompts it replaced are not surface nodes and were never
 * recallable. `compactionBoundary` in `./cut.ts` makes that limit sayable: an
 * ordinal past the end reports it as the reason, the bare listing names it, and
 * the picker and the confirmation dialog show it. The anchors themselves are
 * unchanged — this makes an existing limit visible, it does not move it.
 *
 * ## Other plugins reconcile through a published service
 *
 * The file revert is only one thing a recall has to put back. Anything else that
 * mirrored a turn registers a participant on `dsh-app-rewind-participants`
 * (`./participants.ts`), and this plugin runs them after the surface write. The
 * file revert is itself the first participant, so the seam is exercised by the
 * one consumer whose behaviour users already depend on.
 *
 * ## Guards
 *
 * A cut always starts on a user message, which is by construction the head of
 * its turn, so every shadowed range is whole. A cut taken mid-turn would leave
 * that turn's later `tool/result` events without their call in the derived
 * history, and a provider rejects such a transcript — so a running turn is
 * refused outright rather than raced.
 *
 * ## Where the state lives
 *
 * Everything the client needs is derived from the log by the
 * `rewindAnchors` projection (see `./projection.ts`), including the original
 * text of the most recent cut. Projection state is checkpointed and, failing
 * that, rebuilt by replaying the log, so no separate vault file is needed: the
 * log itself is the durable record, and a recall never removes anything from it.
 * The before-images live under `$DSH_HOME/storages/dsh-app-plugin-rewind/` — the
 * quarantine (displaced bytes, never deleted) and the snapshot store.
 *
 * ## Stability discipline
 *
 * `commands` and `sessionProjections` are framework seams, so the plugin stays
 * inactive on a profile that lacks either instead of throwing at load. Nothing
 * here mutates a prototype, writes outside the plugin's own storage, or fails
 * the boot. Neither does it ever fail a tool call: the snapshot gate swallows its
 * own errors and always forwards.
 *
 * @module @dsh-app/plugin-rewind
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: pulls the ctx merges (commands / sessionProjections) into scope.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-projection'
import { availability, compactionBoundary, placeholderData, planCut, type EventLike, type SessionLike } from './cut.ts'
import { createRecorder, turnAt, type CaptureFailure, type RecordedChange, type Recorder } from './recorder.ts'
import {
  captureBefore,
  quarantineRoot,
  restoreOne,
  textOf,
  type Unrestorable,
} from './snapshots.ts'
import {
  captureWorkspace,
  DEFAULT_TREE_LIMITS,
  diffWorkspace,
  dropSnapshots,
  latestSnapshotBefore,
  pathKey,
  pruneSnapshots,
  readSnapshot,
  type TreeLimits,
  type TreeSnapshot,
} from './trees.ts'
import {
  hostText,
  MAX_ANCHORS,
  REWIND_COMMAND,
  type FileChangePreview,
  type RevertCoverage,
  type RewindCode,
} from './wire.ts'
import { rewindProjection } from './projection.ts'
import { createParticipantRegistry } from './participants.ts'
import type { RewindParticipantRegistry } from './participants.ts'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Type-only: pulls the connection Context merge (ctx.connection) into scope.
import type {} from '@deepseek-ai/dsh-client-connection'
import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import { registerQuarantineRoutes } from './routes.ts'

/** What the file revert did, as the client reports it. */
export interface FileRevert {
  /** Files whose bytes were quarantined and then restored to the before-image. */
  readonly restored: number
  /** Files the recalled range created, moved into the quarantine. */
  readonly removed: number
  /** Changes that could not be undone, each with its reason. */
  readonly unrestorable: readonly Unrestorable[]
  /** How much of the range's file changes this recall could see. */
  readonly coverage: RevertCoverage
  /** Why coverage is not `full`, as a client dictionary code. */
  readonly coverageReason?: string
  /** Tools that ran in the range and can write files. */
  readonly tools?: readonly string[]
}

/**
 * The report a recall sends when its file revert could not run at all.
 *
 * `coverage: 'none'` is the honest verdict: the plugin does not know what the
 * range left behind, so it must not claim any of it was put back. The reason is
 * developer-facing; the participant's own message is in the plugin log.
 */
function failedRevert(reason: string): FileRevert {
  return {
    restored: 0,
    removed: 0,
    unrestorable: [{ path: '(all)', reason }],
    coverage: 'none',
    coverageReason: 'revertFailed',
  }
}

/** Narrow one participant report to the file revert's shape. */
function isFileRevert(value: unknown): value is FileRevert {
  if (typeof value !== 'object' || value === null) return false
  const report = value as {
    restored?: unknown
    removed?: unknown
    unrestorable?: unknown
    coverage?: unknown
  }
  return typeof report.restored === 'number'
    && typeof report.removed === 'number'
    && Array.isArray(report.unrestorable)
    && (report.coverage === 'full' || report.coverage === 'partial' || report.coverage === 'none')
}

/**
 * Read the file revert's report out of the participants' results.
 *
 * `reconcileAll` contains a throwing participant and omits it from the map, so a
 * missing entry IS the failure case: the recall already landed and the tree is
 * reported as not put back rather than pretending otherwise.
 */
function fileRevertOf(reports: ReadonlyMap<string, unknown>): FileRevert {
  const report = reports.get(FILE_REVERT_PARTICIPANT)
  return isFileRevert(report)
    ? report
    : failedRevert('the file revert participant failed; see the plugin log')
}

/**
 * The recall seam's public types.
 *
 * Re-exported for documentation value, not for `import type`: the suite's build
 * is esbuild-only and emits no `.d.ts` (every plugin's `types` field points at a
 * file that does not exist), so a consumer cannot actually resolve
 * `@dsh-app/plugin-rewind` as a type source. A consumer therefore declares the
 * service name and the interface it expects in its own module — the same shape
 * `./participants.ts` declares for the Context merge — and `inject`s the name.
 */
export type {
  RewindParticipant,
  RewindParticipantRegistry,
  RewindRecallContext,
} from './participants.ts'

// The two pre-write waterfalls, plus the tool-dispatch gate. Declared here, not
// imported: they are dispatched by `dsh-tool-fs` and `dsh-tools`, which a plugin
// must not depend on, and cordis's `Events` map is merge-extensible exactly for
// that (cordis README, "interface Events").
//
// `target` is a resolved filesystem target (its `targetKey` is the absolute
// path), `exec` is the tool executor, and `next` continues the chain — a listener
// that returns without calling it silently ends the waterfall for everyone after.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'fs/write-intent'(target: unknown, exec: unknown, next: () => unknown): unknown
    'fs/edit-intent'(target: unknown, exec: unknown, next: () => unknown): unknown
    /**
     * The gate every tool dispatch passes through, before the tool runs.
     *
     * `exec` carries the tool name and the agent (hence the session and its
     * cwd). The return value is a decision (`{ kind: 'allow' }` unless another
     * listener answers), so a listener MUST forward: swallowing the chain here
     * would deny every tool call.
     */
    'tools/pre-execute'(exec: unknown, next: () => unknown): unknown
  }
}

export const name = 'plugin-rewind'

/**
 * Required seams: without EITHER, the plugin stays inactive rather than throwing.
 *
 * `connection` is deliberately NOT here. It carries the quarantine manager's
 * routes, which is a housekeeping page, not the recall — so it is taken through
 * `ctx.inject(['connection'], …)` in `apply` (cordis's scoped-service form) and a
 * profile without it loses the management page while the recall keeps working.
 * Listing it here would deactivate the whole plugin instead.
 */
export const inject = ['commands', 'sessionProjections']

export interface Config {
  /**
   * Maximum recall points offered.
   *
   * The client's picker and this host's ordinal resolution MUST use the same
   * number, or every ordinal past the smaller one resolves to a different
   * message. The default here is therefore {@link MAX_ANCHORS} — the same
   * constant the client's projection caps at — not an independent literal. A
   * smaller value here silently truncates the picker's list.
   */
  maxAnchors: number
  /**
   * Whether to snapshot the workspace before a turn's first writing tool.
   *
   * This is what makes a shell command's changes revertible. Turning it off
   * leaves the write-tool changes covered (and says so when a shell ran), at the
   * cost of leaving everything a shell wrote in place.
   */
  snapshotWorkspace: boolean
  /** File-count bound for one workspace snapshot; over it the recall reports partial. */
  maxSnapshotFiles: number
  /** Total-byte bound for one workspace snapshot; over it the recall reports partial. */
  maxSnapshotBytes: number
}

export const Config: z<Config> = z.object({
  maxAnchors: z.natural().default(MAX_ANCHORS),
  snapshotWorkspace: z.boolean().default(true),
  maxSnapshotFiles: z.natural().default(DEFAULT_TREE_LIMITS.maxFiles),
  maxSnapshotBytes: z.natural().default(DEFAULT_TREE_LIMITS.maxTotalBytes),
})

/** The parsed argument: bare lists, `plan <n>` previews, a number recalls. */
type Ordinal =
  | { readonly kind: 'list' }
  | { readonly kind: 'n', readonly n: number }
  /** Preview a recall of `n` without performing it. */
  | { readonly kind: 'plan', readonly n: number }
  | { readonly kind: 'bad' }

/**
 * Id of the participant that puts the working tree back.
 *
 * It is a participant rather than an inline step so the seam is exercised by the
 * one consumer whose behaviour users depend on; the id is also the key the
 * command reads its `FileRevert` report under.
 */
const FILE_REVERT_PARTICIPANT = 'file-revert'

/**
 * Tools whose writes the recorder sees exactly, so a range that ran only these
 * needs no workspace snapshot to be fully covered.
 */
const RECORDER_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/**
 * Tools that cannot touch the workspace at all, so they never trigger a snapshot.
 *
 * This list is deliberately short and only holds readers: a tool wrongly listed
 * here would silently lose its changes from a recall, while a tool wrongly left
 * out only costs one walk. An unknown tool therefore errs toward taking a
 * snapshot, which is the safe direction.
 */
const READ_ONLY_TOOLS = new Set([
  'read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch',
  'ask_user_question', 'todo_write', 'job_list', 'job_output',
  'skill', 'present', 'memory_recall', 'session_search', 'session_event_search',
])

/**
 * Parse the argument.
 *
 * Bare lists; `<n>` recalls; `plan <n>` previews. The preview is a separate verb
 * rather than a flag because the client needs to ASK what would happen before the
 * user decides — and asking must never be capable of changing anything, which is
 * easiest to keep true when it is a different command.
 */
function parseOrdinal(raw: string): Ordinal {
  const text = raw.trim()
  if (text === '') return { kind: 'list' }
  const plan = /^plan\s+(\d+)$/.exec(text)
  if (plan !== null) {
    const n = Number(plan[1])
    return Number.isSafeInteger(n) && n >= 1 ? { kind: 'plan', n } : { kind: 'bad' }
  }
  if (!/^\d+$/.test(text)) return { kind: 'bad' }
  const n = Number(text)
  return Number.isSafeInteger(n) && n >= 1 ? { kind: 'n', n } : { kind: 'bad' }
}

/**
 * Encode one coded answer as the command's text.
 *
 * The kernel renders a command result's text verbatim, and this repo's rule is
 * that a host half sends a stable code rather than user-visible prose; the
 * client half owns the sentence. The payload is therefore a `HostText` as JSON,
 * and the client's `conversation.chat.commandview` entry for `/rewind` renders
 * it.
 *
 * `prompt` rides the same payload for the SUCCESS answer only. It is the
 * recalled message's original text, and it travels here — in a one-shot result —
 * rather than in the projection on purpose: the composer prefill must happen
 * exactly once per recall, and a projection is durable state that a page reload
 * would replay. See `prefillRecalled` in the client half.
 *
 * The file revert's outcome rides here too, for the same class of reason: the
 * registry's `normalizeResult` keeps ONLY `kind`, `text` and `sourceEventSeq`
 * (`dsh-commands/lib/types/index.js`), so a sibling field on the result would be
 * dropped without a word.
 */
function coded(
  code: RewindCode,
  params?: Readonly<Record<string, string | number>>,
  text?: string,
  extra?: Readonly<Record<string, unknown>>,
): string {
  return JSON.stringify({
    ...hostText(code, params, text),
    ...(extra ?? {}),
  })
}

/**
 * The session facts one tool dispatch exposes, or undefined when it carries none.
 *
 * `cwd` is optional: a session header does not have to carry one, and the two
 * readers here need different things from it — the recorder needs only the id and
 * the turn, the workspace snapshot needs a root.
 */
interface SessionInfo {
  readonly id: string
  /** The session's working directory, when its header carries one. */
  readonly cwd: string | undefined
  readonly turn: number
}

/** The session facts a workspace snapshot needs: the same, with a root. */
interface SnapshotTarget {
  readonly id: string
  readonly cwd: string
  readonly turn: number
}

/** One file a recall will put back, with the bytes it will write. */
interface RevertTarget {
  readonly path: string
  readonly before: Buffer | null
}

/** The cut a preview and a recall both work from. */
type CutPlan = { readonly turns: readonly number[], readonly startSeq: number, readonly endSeq: number }

export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger(name)
  const maxAnchors = Number.isSafeInteger(config.maxAnchors) && config.maxAnchors >= 1 ? config.maxAnchors : MAX_ANCHORS
  const { recorder, record } = createRecorder()
  const limits: TreeLimits = {
    ...DEFAULT_TREE_LIMITS,
    maxFiles: positive(config.maxSnapshotFiles, DEFAULT_TREE_LIMITS.maxFiles),
    maxTotalBytes: positive(config.maxSnapshotBytes, DEFAULT_TREE_LIMITS.maxTotalBytes),
  }
  const snapshotWorkspace = config.snapshotWorkspace !== false

  // --- The participant seam. Published as a service so another suite plugin can
  // restore its own state after a recall without this plugin knowing what that
  // state is; with no consumer the recall behaves exactly as before. The fiber
  // owns it, so it is unregistered with the plugin.
  //
  // The file revert is registered FIRST, as the seam's own proof: it is the one
  // consumer users already depend on, and it reads the recorder and the range's
  // snapshot, which is why `reconcileAll` must run before the cleanup below. ---
  const participants: RewindParticipantRegistry = createParticipantRegistry(log)
  ctx.effect(
    () => ctx.provide('dsh-app-rewind-participants', participants),
    'plugin-rewind: participant registry',
  )
  participants.register({
    id: FILE_REVERT_PARTICIPANT,
    reconcileAfterRewind: (context) =>
      revertFiles(context.session, context.sessionId, context.plan, recorder, limits, log),
  })

  // --- The quarantine manager rides the Connection exact-Fetch registry, the
  // same carrier every suite route uses. `connection` is declared in `inject`
  // and read structurally: a profile without it loses the management page, never
  // the recall itself. ---
  ctx.inject(['connection'], (scope) => {
    const fetch = (scope.get('connection') as { fetch?: HostConnectionFetch } | undefined)?.fetch
    if (fetch === undefined) return
    scope.effect(() => registerQuarantineRoutes(fetch), 'plugin-rewind: quarantine routes')
  })

  // The projection is the client's whole read face: recall points and the
  // turns a recall already hid. Registering it is what lets the client render
  // without folding session events itself. The recalled message's TEXT is
  // deliberately not here — it rides the command result instead, because a
  // projection is durable and a reload would replay the composer prefill.
  ctx.effect(
    () => ctx.sessionProjections.register(rewindProjection),
    'plugin-rewind: rewindAnchors projection',
  )

  // --- The two pre-write waterfalls. Both are registered with `prepend`, and
  // both MUST forward: the kernel's own `fs-observation-policy` listener returns
  // the write's CAS guard and never calls `next()`, so a later listener never
  // runs — silently. See `./recorder.ts` for the measurement.
  //
  // The capture is AWAITED before the write is released: a before-image read
  // after the write landed is not a before-image, and the read is bounded (≤4 MB)
  // so the cost is one small read per write call. ---
  const onIntent = (name: 'fs/write-intent' | 'fs/edit-intent'): void => {
    ctx.effect(() => ctx.on(name, async (target, exec, next) => {
      const path = String((target as { targetKey?: unknown } | null)?.targetKey ?? '')
      const info = sessionInfoOfExec(exec)
      if (path !== '' && info !== undefined) {
        try {
          await record(info.id, path, info.turn, seqOfExec(exec))
        } catch (error) {
          // A capture failure must never block the user's write.
          log.warn(`rewind: could not snapshot ${path}: ${messageOf(error)}`)
        }
      }
      return next()
    }, { prepend: true }), `plugin-rewind: ${name} recorder`)
  }
  onIntent('fs/write-intent')
  onIntent('fs/edit-intent')

  // --- The workspace snapshot. Taken lazily, at the FIRST tool call of a turn
  // that could write, and only once per turn: a turn of pure chat or reads costs
  // nothing, and the snapshot is by construction the state before anything in
  // that turn changed. `write` and `edit` DO trigger it — the write waterfalls
  // cover their target exactly, but a turn that writes and then runs a shell
  // command would otherwise be snapshotted AFTER the write, and the diff would
  // then treat that write as part of the range's starting state. ---
  const captured = new Set<string>()
  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    const info = sessionInfoOfExec(exec)
    const tool = String((exec as { name?: unknown } | null)?.name ?? '')
    if (
      snapshotWorkspace
      && info !== undefined
      && info.cwd !== undefined
      && !READ_ONLY_TOOLS.has(tool)
    ) {
      // AWAITED, not fire-and-forget: the snapshot must describe the workspace
      // BEFORE this tool runs. Started and not waited for, it would race the very
      // write it exists to capture.
      try {
        await ensureSnapshot({ id: info.id, cwd: info.cwd, turn: info.turn }, signalOfExec(exec))
      } catch (error) {
        // A tool call is never failed over bookkeeping: the snapshot is a safety
        // net, and a missing net must not stop the work.
        log.warn(`rewind: workspace snapshot failed: ${messageOf(error)}`)
      }
    }
    return next()
  }, { prepend: true }), 'plugin-rewind: workspace snapshot gate')

  /**
   * Take this turn's workspace snapshot if it does not exist yet.
   *
   * The in-memory guard is claimed BEFORE the await so two concurrent tool calls
   * of one step cannot both walk the tree, and it is never released: a snapshot
   * that failed is not retried mid-turn, because the state it would capture is no
   * longer the turn's starting state.
   */
  async function ensureSnapshot(info: SnapshotTarget, signal?: AbortSignal): Promise<void> {
    const key = `${info.id}\u0000${String(info.turn)}`
    if (captured.has(key)) return
    captured.add(key)
    const dshHome = resolveDshHome()
    const previous = await latestSnapshotBefore(dshHome, info.id, info.turn)
    await captureWorkspace(dshHome, info.id, info.turn, info.cwd, limits, previous, signal)
    await pruneSnapshots(dshHome, info.id, limits)
  }

  const handle = async (invocation: CommandInvocation): Promise<CommandResult> => {
    const session = invocation.agent.session
    const parsed = parseOrdinal(invocation.rawInput)

    if (parsed.kind === 'bad') {
      return { kind: 'error', text: coded('rewind.host.badArg') }
    }

    if (parsed.kind === 'list') {
      // ONE availability computation for the count and the boundary, so the
      // listing can never disagree with what the picker offers.
      const { maxTurns, stoppedAtCompaction } = availability(session, maxAnchors)
      if (maxTurns === 0) {
        // A compacted session can have no recall point at all: `/compact` keeps a
        // priced tail, and with no retained budget that tail is the last node, so
        // the checkpoint consumed every prompt. Saying "nothing recallable yet"
        // there names the wrong cause.
        return {
          kind: 'error',
          text: stoppedAtCompaction
            ? coded('rewind.host.compactedAll')
            : coded('rewind.host.empty'),
        }
      }
      return {
        kind: 'success',
        text: stoppedAtCompaction
          ? coded('rewind.host.listBoundary', { count: maxTurns })
          : coded('rewind.host.list', { count: maxTurns }),
      }
    }

    // A running turn must not be cut: its later tool results would be left
    // without their call, and the provider rejects that transcript.
    if (invocation.agent.status === 'running') {
      return { kind: 'error', text: coded('rewind.host.busy') }
    }

    const plan = planCut(session, parsed.n, maxAnchors)
    if ('reason' in plan) {
      // A preview reports the same reasons as a recall; the dialog shows them
      // rather than letting the user confirm something that cannot happen.
      const failureCode: RewindCode = plan.reason === 'empty'
        ? 'rewind.host.empty'
        : plan.reason === 'compactionBoundary'
          ? plan.available === 0
            ? 'rewind.host.compactedAll'
            : 'rewind.host.compactionBoundary'
          : plan.reason === 'outOfRange'
            ? 'rewind.host.outOfRange'
            : 'rewind.host.notUserMessage'
      const failureParams = (plan.reason === 'outOfRange' || plan.reason === 'compactionBoundary')
        && plan.available > 0
        ? { available: plan.available, requested: parsed.n }
        : undefined
      if (parsed.kind === 'plan') {
        return {
          kind: 'success',
          text: coded('rewind.host.plan', undefined, undefined, {
            ok: false,
            reason: failureCode,
            ...(failureParams === undefined ? {} : { params: failureParams }),
          }),
        }
      }
      return { kind: 'error', text: coded(failureCode, failureParams) }
    }

    const sessionId = String(session.header.id)

    // A preview stops here: it has answered what the recall would do, and it must
    // not have changed anything on the way. It carries the boundary flag so the
    // confirmation dialog can say that older messages are gone.
    if (parsed.kind === 'plan') {
      const preview = await previewRevert(session, sessionId, plan, recorder, limits)
      return {
        kind: 'success',
        text: coded('rewind.host.plan', undefined, undefined, {
          ok: true,
          n: parsed.n,
          prompt: plan.prompt,
          // The flag alone: `availability` would walk the surface a third time
          // (through `listAnchors`) to read a boolean, and this path already
          // paid for two walks (`planCut`).
          stoppedAtCompaction: compactionBoundary(session) !== null,
          ...preview,
        }),
      }
    }

    let sourceEventSeq: SessionSeq
    try {
      // A `user/message` placeholder, not `system/message`: the persistence
      // validator requires a system message to match the OPEN turn and step,
      // and a recall happens while the agent is idle. See placeholderData().
      const replacement = session.append('user/message', placeholderData(), {
        surfaceOp: { op: 'replace', startSeq: SessionSeq(plan.startSeq), endSeq: SessionSeq(plan.endSeq) },
        sourceEventSeqs: plan.shadowedSeqs.map((seq) => SessionSeq(seq)),
      })
      sourceEventSeq = replacement.seq
    } catch (error) {
      // The kernel's own message is the honest diagnostic; it travels as the
      // developer-facing fallback, never as user copy.
      const detail = messageOf(error)
      log.warn(`rewind: replacement rejected: ${detail}`)
      return { kind: 'error', text: coded('rewind.host.rejected', undefined, detail) }
    }

    // The surface write is the recall's authoritative act, so the participants run
    // AFTER it: each one reconciles against a cut that has already landed, and one
    // participant's failure is a warning instead of a rollback. The file revert is
    // the first of them (registered in `apply`), which is why this runs before the
    // recorder and snapshot cleanup — it reads both.
    const reconciled = await participants.reconcileAll({ session, sessionId, plan })
    const revert = fileRevertOf(reconciled)

    // The recalled turns are off the surface, so their before-images are dead
    // weight — in memory and on disk.
    recorder.forget(sessionId, plan.turns)
    try {
      await dropSnapshots(resolveDshHome(), sessionId, plan.turns)
    } catch (error) {
      log.warn(`rewind: snapshot cleanup failed: ${messageOf(error)}`)
    }

    return {
      kind: 'success',
      // The recalled text travels WITH the result, so the composer gets it
      // exactly once — a durable projection would replay it on every reload.
      // The file revert's tally rides the same payload; see `coded`.
      text: coded('rewind.host.done', { n: parsed.n }, undefined, {
        prompt: plan.prompt,
        files: revert,
      }),
      sourceEventSeq,
    }
  }

  ctx.effect(() => ctx.commands.register({
    name: REWIND_COMMAND,
    description: 'Recall a sent message: cut the conversation back to before it and put its text back in the composer',
    // Declaring `input` is required: without it the composer treats the whole
    // line as a bare command name and `/rewind 2` never reaches the handler.
    // The hint is English because a host half carries no user-visible prose;
    // the composer shows it as the field's placeholder.
    input: { hint: 'Ordinal (1 = newest), or leave empty to list recallable messages' },
    handler: (invocation) => handle(invocation),
  }), 'plugin-rewind: /rewind command')
}

/** A positive safe integer from config, or the fallback. */
function positive(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/** One error's message, for a log line. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The session handle inside a tool executor, or undefined. */
function sessionOfExec(exec: unknown): {
  seq?: unknown
  header?: { id?: unknown, cwd?: unknown }
  ownEvents?: () => readonly { type?: unknown, seq?: unknown, data?: unknown }[]
} | undefined {
  const agent = (exec as { agent?: { session?: unknown } } | null)?.agent
  const session = agent?.session
  return typeof session === 'object' && session !== null ? session as never : undefined
}

/**
 * The session facts a tool dispatch carries: id, workspace root, and the open
 * turn.
 *
 * There is no public "current turn" accessor on a Session, so it comes from the
 * log — see `turnAt`. `exec.agent.session` is the same handle the `write` tool
 * itself reads its cwd from (`dsh-tool-fs/lib/index.js`), so this needs no extra
 * service.
 */
function sessionInfoOfExec(exec: unknown): SessionInfo | undefined {
  const session = sessionOfExec(exec)
  if (session === undefined || session.ownEvents === undefined) return undefined
  const id = session.header?.id
  if (typeof id !== 'string' || id === '') return undefined
  // `cwd` is optional HERE on purpose. The recorder needs only the session id and
  // the turn, and a session whose header carries no cwd must still have its writes
  // recorded; only the workspace SNAPSHOT needs a root. Requiring it here made a
  // write-only range restore nothing at all — caught by re-running the probes.
  const raw = session.header?.cwd
  const cwd = typeof raw === 'string' && raw !== '' ? raw : undefined
  const seq = typeof session.seq === 'number' ? session.seq : Number.MAX_SAFE_INTEGER
  try {
    const turn = turnAt(session.ownEvents(), seq)
    return turn === null ? undefined : { id, cwd, turn }
  } catch {
    return undefined
  }
}

/** The sequence a write happens at, so two writes to one path stay ordered. */
function seqOfExec(exec: unknown): number {
  const seq = sessionOfExec(exec)?.seq
  return typeof seq === 'number' && Number.isSafeInteger(seq) ? seq : 0
}

/**
 * The tool call's abort signal, when it carries one.
 *
 * The kernel requires an async gate on `tools/pre-execute` to observe it: a
 * cancelled call is not abandoned by the kernel, so a walk that ignores the
 * signal keeps working for a tool nobody is waiting for any more.
 */
function signalOfExec(exec: unknown): AbortSignal | undefined {
  const signal = (exec as { signal?: unknown } | null)?.signal
  return typeof signal === 'object' && signal !== null && 'aborted' in signal
    ? signal as AbortSignal
    : undefined
}

/**
 * The set of file changes a recall of one turn range would act on, grouped by
 * PATH.
 *
 * Keeps only the FIRST before-image of each path: that is the state the file was
 * in when the range began, which is exactly the restore target. Restoring the
 * LAST one would leave the file as the range's own final write left it, which
 * undoes nothing.
 *
 * @param sessionId - the session whose turns are being recalled.
 * @param turns - the turns the recall removes.
 * @param recorder - the file-change recorder.
 * @returns one entry per path, plus the changes that could not be captured.
 */
function planPaths(
  sessionId: string,
  turns: readonly number[],
  recorder: Recorder,
): { readonly targets: readonly RecordedChange[], readonly failures: readonly CaptureFailure[] } {
  const firstByPath = new Map<string, RecordedChange>()
  for (const change of recorder.changesForTurns(sessionId, turns)) {
    if (!firstByPath.has(change.path)) firstByPath.set(change.path, change)
  }
  return { targets: [...firstByPath.values()], failures: recorder.failuresForTurns(sessionId, turns) }
}

/**
 * Merge the two before-image sources into the list to restore.
 *
 * The snapshot is authoritative for any path it COVERED — it holds the state at
 * the moment the range's first turn began to change things, which is the target
 * state by definition, and it is the only source that saw a shell command. The
 * recorder is authoritative everywhere else: a write outside the workspace, a
 * path under a directory the snapshot skips, or a file too large to snapshot.
 *
 * A covered path the diff found UNCHANGED is not restored at all, even when the
 * recorder holds a before-image for it: the bytes are already the target bytes,
 * and restoring them would only add a pointless quarantine copy.
 *
 * @param sessionId - the session being recalled.
 * @param turns - the turns the recall removes.
 * @param recorder - the write-waterfall recorder.
 * @param diff - the diff of the current workspace against the range's snapshot,
 *   when one exists.
 * @returns the targets, plus everything the merge knows it could not cover.
 */
function mergeTargets(
  sessionId: string,
  turns: readonly number[],
  recorder: Recorder,
  diff: Awaited<ReturnType<typeof diffWorkspace>> | undefined,
): { readonly targets: readonly RevertTarget[], readonly missed: readonly Unrestorable[] } {
  const { targets: recorded, failures } = planPaths(sessionId, turns, recorder)
  const missed: Unrestorable[] = []
  const byPath = new Map<string, RevertTarget>()

  if (diff !== undefined) {
    for (const target of diff.restore) byPath.set(pathKey(target.path), target)
    for (const path of diff.missing) {
      missed.push({ path, reason: 'its before-image is no longer in the snapshot store' })
    }
    for (const path of diff.uncapturedChanged) {
      missed.push({ path, reason: 'its earlier content was never kept (too large, unreadable, or a link)' })
    }
    // An incomplete walk is reported through `coverage: partial` rather than as a
    // path: the plugin does not know WHICH files it never reached, and inventing a
    // row for that reads as a file named "(files created in this range)".
  }

  for (const change of recorded) {
    // The snapshot decided this path, so its bytes win — including the decision
    // that the path did not change at all.
    if (diff !== undefined && diff.coveredOf(change.path)) continue
    // Keyed by `pathKey`, not by the raw string: the two sources spell one file
    // differently (see `pathKey`), and a raw key would put the same file in the
    // list twice — two quarantine copies for one restore.
    const key = pathKey(change.path)
    if (byPath.has(key)) continue
    byPath.set(key, { path: change.path, before: change.before })
  }

  // A capture failure is only reported for a path the restore did not handle:
  // otherwise a file the snapshot put back would be listed as both restored and
  // unrestorable, which reads as a contradiction.
  for (const failure of failures) {
    if (byPath.has(pathKey(failure.path))) continue
    if (diff !== undefined && diff.coveredOf(failure.path)) continue
    missed.push({ path: failure.path, reason: failure.reason })
  }
  return { targets: [...byPath.values()], missed }
}

/**
 * The tool names that ran inside one recalled range and can write files.
 *
 * Read from the session log, which is the durable record: an in-memory note
 * would be empty exactly when it matters (a restarted kernel child), and the
 * whole point of this list is to tell the user when a recall cannot see what a
 * range did.
 */
function writingToolsInRange(session: SessionLike, startSeq: number, endSeq: number): string[] {
  const names = new Set<string>()
  for (let seq = startSeq; seq <= endSeq; seq += 1) {
    const event: EventLike | undefined = session.eventAt(seq)
    if (event === undefined || event.type !== 'tool/call') continue
    const name = (event.data as { name?: unknown } | null)?.name
    if (typeof name !== 'string' || name === '') continue
    if (READ_ONLY_TOOLS.has(name)) continue
    names.add(name)
  }
  return [...names]
}

/**
 * How much of a range's file changes a recall can see, and why not.
 *
 * `full` means every path the range could have changed is accounted for: either
 * the workspace snapshot covered the whole tree, or the only tools that ran are
 * ones the recorder sees exactly. `none` means a tool that writes through its own
 * handle ran and there is no snapshot for the range's first turn — the case that
 * used to be reported as an unqualified success.
 *
 * @param session - the session being recalled.
 * @param plan - the computed cut.
 * @param snapshot - the range's first turn's snapshot, when there is one.
 * @returns the coverage verdict, plus the tools that make it partial.
 */
function coverageOf(
  session: SessionLike,
  plan: CutPlan,
  snapshot: TreeSnapshot | undefined,
): { readonly coverage: RevertCoverage, readonly reason?: string, readonly tools?: readonly string[] } {
  const tools = writingToolsInRange(session, plan.startSeq, plan.endSeq)
  const blind = tools.filter((tool) => !RECORDER_TOOLS.has(tool))
  if (blind.length === 0) return { coverage: 'full', ...(tools.length === 0 ? {} : { tools }) }
  if (snapshot === undefined) return { coverage: 'none', reason: 'noSnapshot', tools: blind }
  if (snapshot.complete) return { coverage: 'full', tools }
  return { coverage: 'partial', reason: snapshot.reason ?? 'incomplete', tools: blind }
}

/**
 * Read the range's snapshot and diff the current workspace against it.
 *
 * One helper so the preview and the recall cannot disagree about which turn's
 * state the range starts from.
 *
 * @param sessionId - the session being recalled.
 * @param plan - the computed cut.
 * @param limits - the workspace-snapshot bounds.
 * @returns the snapshot (when there is one) and its diff.
 */
async function snapshotDiff(
  sessionId: string,
  plan: CutPlan,
  limits: TreeLimits,
): Promise<{ readonly snapshot: TreeSnapshot | undefined, readonly diff: Awaited<ReturnType<typeof diffWorkspace>> | undefined }> {
  const dshHome = resolveDshHome()
  const first = plan.turns[0]
  const snapshot = first === undefined ? undefined : await readSnapshot(dshHome, sessionId, first)
  const diff = snapshot === undefined ? undefined : await diffWorkspace(snapshot, dshHome, limits)
  return { snapshot, diff }
}

/**
 * Describe what a recall would do to the tree, WITHOUT doing it.
 *
 * This is what the confirmation dialog renders. It reads the current bytes of each
 * affected file so the preview can show a real before/after rather than a bare
 * path list — the difference between asking a user to approve a described change
 * and asking them to approve a mystery.
 *
 * The read is best-effort per file: a file that cannot be read now is still
 * listed for restore, with no diff, because refusing to preview it would hide a
 * change the recall is about to make. Binary content has no diff to show — the
 * kernel's own diff view is text — so those rows carry paths only.
 *
 * @param session - the session being recalled.
 * @param sessionId - the session being recalled, by id.
 * @param plan - the computed cut.
 * @param recorder - the file-change recorder.
 * @param limits - the workspace-snapshot bounds.
 * @returns the plan, as the client's dialog consumes it.
 */
async function previewRevert(
  session: SessionLike,
  sessionId: string,
  plan: CutPlan,
  recorder: Recorder,
  limits: TreeLimits,
): Promise<{
  restore: FileChangePreview[]
  remove: FileChangePreview[]
  unrestorable: readonly Unrestorable[]
  coverage: RevertCoverage
  coverageReason?: string
  tools?: readonly string[]
}> {
  const { snapshot, diff } = await snapshotDiff(sessionId, plan, limits)
  const { targets, missed } = mergeTargets(sessionId, plan.turns, recorder, diff)
  const restore: FileChangePreview[] = []
  const remove: FileChangePreview[] = []
  for (const target of targets) {
    const current = await captureBefore(target.path)
    const now = current.kind === 'captured' ? current.before : undefined
    const nowText = textOf(now)
    const nextText = textOf(target.before)
    if (target.before === null) {
      // The range created it; the recall moves it into the quarantine.
      remove.push({
        path: target.path,
        action: 'remove',
        ...(nowText === undefined ? {} : { current: nowText }),
      })
      continue
    }
    restore.push({
      path: target.path,
      action: 'restore',
      ...(nowText === undefined ? {} : { current: nowText }),
      ...(nextText === undefined ? {} : { next: nextText }),
    })
  }
  const cover = coverageOf(session, plan, snapshot)
  return {
    restore,
    remove,
    unrestorable: missed,
    coverage: cover.coverage,
    ...(cover.reason === undefined ? {} : { coverageReason: cover.reason }),
    ...(cover.tools === undefined ? {} : { tools: cover.tools }),
  }
}

/**
 * Put the working tree back the way it was before a recalled turn range.
 *
 * Every restored file's current bytes go into the quarantine first, and a file
 * this range CREATED is moved there rather than deleted — the recall stays
 * reversible and nothing is destroyed. See `./snapshots.ts`.
 *
 * A change that could not be captured — an oversized file, a range with no
 * snapshot — is reported, never silently skipped, because the one outcome a user
 * must not get is a confident "reverted" over a tree that was only partly put
 * back.
 *
 * @param session - the session being recalled.
 * @param sessionId - the session being recalled, by id.
 * @param plan - the computed cut.
 * @param recorder - the file-change recorder.
 * @param limits - the workspace-snapshot bounds.
 * @param log - the plugin's logger.
 * @returns what happened, for the command result.
 */
async function revertFiles(
  session: SessionLike,
  sessionId: string,
  plan: CutPlan,
  recorder: Recorder,
  limits: TreeLimits,
  log: { warn(message: string): void },
): Promise<FileRevert> {
  const dshHome = resolveDshHome()
  const { snapshot, diff } = await snapshotDiff(sessionId, plan, limits)
  const { targets, missed } = mergeTargets(sessionId, plan.turns, recorder, diff)
  const dir = quarantineRoot(dshHome, sessionId)
  const now = Date.now()
  const unrestorable: Unrestorable[] = [...missed]
  let restored = 0
  let removed = 0
  for (const target of targets) {
    const outcome = await restoreOne({ path: target.path, before: target.before }, dir, now, limits.maxFileBytes)
    if (outcome.kind === 'restored') restored += 1
    else if (outcome.kind === 'removed') removed += 1
    else {
      unrestorable.push({ path: target.path, reason: outcome.reason ?? 'unknown' })
      log.warn(`rewind: could not restore ${target.path}: ${outcome.reason ?? 'unknown'}`)
    }
  }
  const cover = coverageOf(session, plan, snapshot)
  return {
    restored,
    removed,
    unrestorable,
    coverage: cover.coverage,
    ...(cover.reason === undefined ? {} : { coverageReason: cover.reason }),
    ...(cover.tools === undefined ? {} : { tools: cover.tools }),
  }
}
