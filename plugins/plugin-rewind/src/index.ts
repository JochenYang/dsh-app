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
 *
 * ## Stability discipline
 *
 * `commands` and `sessionProjections` are framework seams, so the plugin stays
 * inactive on a profile that lacks either instead of throwing at load. Nothing
 * here mutates a prototype, writes outside the plugin's own storage, or fails
 * the boot.
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
import { listAnchors, placeholderData, planCut } from './cut.ts'
import { createRecorder, turnAt, type CaptureFailure, type RecordedChange, type Recorder } from './recorder.ts'
import { captureBefore, quarantineRoot, restoreOne, type Unrestorable } from './snapshots.ts'
import {
  hostText,
  MAX_ANCHORS,
  REWIND_COMMAND,
  type FileChangePreview,
  type RewindCode,
} from './wire.ts'
import { rewindProjection } from './projection.ts'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Type-only: pulls the connection Context merge (ctx.connection) into scope.
import type {} from '@deepseek-ai/dsh-client-connection'
import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import { registerQuarantineRoutes } from './routes.ts'

/** What the file revert did, as the client reports it. */
interface FileRevert {
  /** Files whose bytes were quarantined and then restored to the before-image. */
  readonly restored: number
  /** Files the recalled range created, moved into the quarantine. */
  readonly removed: number
  /** Changes that could not be undone, each with its reason. */
  readonly unrestorable: readonly Unrestorable[]
}

// The two pre-write waterfalls. Declared here, not imported: they are dispatched
// by `dsh-tool-fs`, which a plugin must not depend on, and cordis's `Events` map
// is merge-extensible exactly for that (cordis README, "interface Events").
//
// `target` is a resolved filesystem target (its `targetKey` is the absolute
// path), `exec` is the tool executor, and `next` continues the chain — a listener
// that returns without calling it silently ends the waterfall for everyone after.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'fs/write-intent'(target: unknown, exec: unknown, next: () => unknown): unknown
    'fs/edit-intent'(target: unknown, exec: unknown, next: () => unknown): unknown
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
}

export const Config: z<Config> = z.object({
  maxAnchors: z.natural().default(MAX_ANCHORS),
})

/** The parsed argument: bare lists, `plan <n>` previews, a number recalls. */
type Ordinal =
  | { readonly kind: 'list' }
  | { readonly kind: 'n', readonly n: number }
  /** Preview a recall of `n` without performing it. */
  | { readonly kind: 'plan', readonly n: number }
  | { readonly kind: 'bad' }

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

export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger(name)
  const maxAnchors = Number.isSafeInteger(config.maxAnchors) && config.maxAnchors >= 1 ? config.maxAnchors : MAX_ANCHORS
  const { recorder, record } = createRecorder()

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
  // The events themselves are declared in the `Events` augmentation at the top of
  // this module: they are dispatched by `dsh-tool-fs`, which a plugin does not
  // depend on, so their signatures are stated here rather than imported. ---
  const onIntent = (name: 'fs/write-intent' | 'fs/edit-intent'): void => {
    ctx.effect(() => ctx.on(name, (target, exec, next) => {
      const path = String((target as { targetKey?: unknown } | null)?.targetKey ?? '')
      if (path !== '') record(path, turnOfExec(exec), seqOfExec(exec))
      return next()
    }, { prepend: true }), `plugin-rewind: ${name} recorder`)
  }
  onIntent('fs/write-intent')
  onIntent('fs/edit-intent')

  const handle = async (invocation: CommandInvocation): Promise<CommandResult> => {
    const session = invocation.agent.session
    const parsed = parseOrdinal(invocation.rawInput)

    if (parsed.kind === 'bad') {
      return { kind: 'error', text: coded('rewind.host.badArg') }
    }

    if (parsed.kind === 'list') {
      const anchors = listAnchors(session, maxAnchors)
      if (anchors.length === 0) {
        return { kind: 'error', text: coded('rewind.host.empty') }
      }
      return { kind: 'success', text: coded('rewind.host.list', { count: anchors.length }) }
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
        : plan.reason === 'outOfRange'
          ? 'rewind.host.outOfRange'
          : 'rewind.host.notUserMessage'
      const failureParams = plan.reason === 'outOfRange'
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

    // A preview stops here: it has answered what the recall would do, and it must
    // not have changed anything on the way.
    if (parsed.kind === 'plan') {
      const preview = await previewRevert(String(session.header.id), plan.turns, recorder)
      return {
        kind: 'success',
        text: coded('rewind.host.plan', undefined, undefined, {
          ok: true,
          n: parsed.n,
          prompt: plan.prompt,
          ...preview,
        }),
      }
    }

    // Revert the files this turn range changed. This is deliberately NOT fatal:
    // a file whose snapshot was never captured (a shell write, an oversized file)
    // cannot be reported by refusing the whole recall, and the transcript really
    // can go back even when the tree cannot. The report rides the result.
    const turns = plan.turns
    let revert: FileRevert | undefined
    try {
      revert = await revertFiles(String(session.header.id), turns, recorder, log)
    } catch (error) {
      // A revert that throws must not lose the recall: the transcript change is
      // the feature, and a failed restore is reported as such.
      const detail = error instanceof Error ? error.message : String(error)
      log.warn(`rewind: file revert failed: ${detail}`)
      revert = { restored: 0, removed: 0, unrestorable: [{ path: '(all)', reason: detail }] }
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
      const detail = error instanceof Error ? error.message : String(error)
      log.warn(`rewind: replacement rejected: ${detail}`)
      return { kind: 'error', text: coded('rewind.host.rejected', undefined, detail) }
    }

    // The recalled turns are off the surface, so their snapshots are dead weight.
    recorder.forget(plan.turns)

    return {
      kind: 'success',
      // The recalled text travels WITH the result, so the composer gets it
      // exactly once — a durable projection would replay it on every reload.
      // The file revert's tally rides the same payload; see `coded`.
      text: coded('rewind.host.done', { n: parsed.n }, undefined, {
        prompt: plan.prompt,
        ...(revert === undefined ? {} : { files: revert }),
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

/**
 * The turn a write belongs to, read off the tool executor's agent.
 *
 * There is no public "current turn" accessor on a Session, so it comes from the
 * log — see `turnAt`. `exec.agent.session` is the same handle the `write` tool
 * itself reads its cwd from (`dsh-tool-fs/lib/index.js`), so this needs no extra
 * service.
 */
function turnOfExec(exec: unknown): number | null {
  const session = sessionOfExec(exec)
  if (session?.ownEvents === undefined) return null
  const seq = typeof session.seq === 'number' ? session.seq : Number.MAX_SAFE_INTEGER
  try {
    return turnAt(session.ownEvents(), seq)
  } catch {
    return null
  }
}

/** The sequence a write happens at, so two writes to one path stay ordered. */
function seqOfExec(exec: unknown): number {
  const seq = sessionOfExec(exec)?.seq
  return typeof seq === 'number' && Number.isSafeInteger(seq) ? seq : 0
}

/** The session handle inside a tool executor, or undefined. */
function sessionOfExec(exec: unknown): { seq?: unknown, ownEvents?: () => readonly { type?: unknown, seq?: unknown, data?: unknown }[] } | undefined {
  const agent = (exec as { agent?: { session?: unknown } } | null)?.agent
  const session = agent?.session
  return typeof session === 'object' && session !== null ? session as never : undefined
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
 * @param turns - the turns the recall removes.
 * @param recorder - the file-change recorder.
 * @returns one entry per path, plus the changes that could not be captured.
 */
function planPaths(
  turns: readonly number[],
  recorder: Recorder,
): { readonly targets: readonly RecordedChange[], readonly failures: readonly CaptureFailure[] } {
  const firstByPath = new Map<string, RecordedChange>()
  for (const change of recorder.changesForTurns(turns)) {
    if (!firstByPath.has(change.path)) firstByPath.set(change.path, change)
  }
  return { targets: [...firstByPath.values()], failures: recorder.failuresForTurns(turns) }
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
 * change the recall is about to make.
 *
 * @param sessionId - the session being recalled.
 * @param turns - the turns the recall removes.
 * @param recorder - the file-change recorder.
 * @returns the plan, as the client's dialog consumes it.
 */
async function previewRevert(
  sessionId: string,
  turns: readonly number[],
  recorder: Recorder,
): Promise<{ restore: FileChangePreview[], remove: FileChangePreview[], unrestorable: Unrestorable[] }> {
  const { targets, failures } = planPaths(turns, recorder)
  const restore: FileChangePreview[] = []
  const remove: FileChangePreview[] = []
  for (const target of targets) {
    const current = await captureBefore(target.path)
    const now = current.kind === 'captured' ? current.before : undefined
    if (target.before === null) {
      // The range created it; the recall moves it into the quarantine.
      remove.push({
        path: target.path,
        action: 'remove',
        ...(now === null || now === undefined ? {} : { current: now }),
      })
      continue
    }
    restore.push({
      path: target.path,
      action: 'restore',
      ...(now === null || now === undefined ? {} : { current: now }),
      next: target.before,
    })
  }
  void sessionId
  return { restore, remove, unrestorable: failures.map((f) => ({ path: f.path, reason: f.reason })) }
}

/**
 * Put the working tree back the way it was before a recalled turn range.
 *
 * Every restored file's current bytes go into the quarantine first, and a file
 * this range CREATED is moved there rather than deleted — the recall stays
 * reversible and nothing is destroyed. See `./snapshots.ts`.
 *
 * A change that could not be captured — a shell write, an oversized file — is
 * reported, never silently skipped, because the one outcome a user must not get
 * is a confident "reverted" over a tree that was only partly put back.
 *
 * @param sessionId - the session being recalled, for the quarantine path.
 * @param turns - the turns the recall removes.
 * @param recorder - the file-change recorder.
 * @param log - the plugin's logger.
 * @returns what happened, for the command result.
 */
async function revertFiles(
  sessionId: string,
  turns: readonly number[],
  recorder: Recorder,
  log: { warn(message: string): void },
): Promise<FileRevert> {
  const { targets, failures } = planPaths(turns, recorder)
  const dir = quarantineRoot(resolveDshHome(), sessionId)
  const now = Date.now()
  const unrestorable: Unrestorable[] = failures.map((f) => ({ path: f.path, reason: f.reason }))
  let restored = 0
  let removed = 0
  for (const snapshot of targets) {
    const outcome = await restoreOne({ path: snapshot.path, before: snapshot.before }, dir, now)
    if (outcome.kind === 'restored') restored += 1
    else if (outcome.kind === 'removed') removed += 1
    else {
      unrestorable.push({ path: snapshot.path, reason: outcome.reason ?? 'unknown' })
      log.warn(`rewind: could not restore ${snapshot.path}: ${outcome.reason ?? 'unknown'}`)
    }
  }
  return { restored, removed, unrestorable }
}

