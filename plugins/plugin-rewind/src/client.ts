/**
 * DSH APP rewind — client half.
 *
 * Contributes one visible entry point and four pieces of housekeeping:
 *
 *   1. a hover icon under each user message — the fast path, and the only one a
 *      user sees without typing;
 *   2. a stylesheet that hides the turns a recall removed;
 *   3. the composer prefill — the recalled text back in the input box;
 *   4. the `/rewind` command's picker and transcript row, for the deliberate
 *      path and for keyboard users;
 *   5. the quarantine manager, a tab of the suite's maintenance settings section
 *      that lists and discards the files a recall displaced.
 *
 * Everything the entry points SHOW comes from the host's `rewindAnchors`
 * projection, read through the standard `useProjection` seat — this half never
 * folds session events. The prefill is the one piece of data that does not:
 * it rides the command result, because a projection is durable state a reload
 * replays, and a replayed prefill re-fills the composer forever.
 *
 * ## The per-message icon wraps the built-in renderer
 *
 * The kernel has no action slot on a user-message bubble (`assistant-actions`
 * is reached from the assistant turn tail, and nothing equivalent exists on the
 * user side), so the icon rides the built-in `user` renderer through a wrapper
 * registered at `priority: -1`. That is safe only for a renderer that does NOT
 * call `renderSlot` itself — a wrapper cannot supply the child-slot renderers
 * the owner would have passed, and a throwing registration is retired by the
 * slot system. `UserMessageNodeView` calls `renderSlot` zero times on
 * 0.2.0-rc.2; `turn-tail` calls it three times and must never be wrapped. The
 * wrapper also forwards every prop it receives, including the chat-bound `t`
 * seat, so the built-in's own copy keeps resolving.
 *
 * ## Hiding what was recalled
 *
 * The transcript deliberately renders the append-origin log, so a landed
 * replacement does NOT remove the old bubbles (compaction behaves the same way).
 * This half therefore hides the affected turns itself, using the `data-chat-turn`
 * attribute the chat flow wrapper puts on every node. Turns are the right unit:
 * a recall always cuts at a turn head, so the whole turn goes away together and
 * no half-turn is left behind.
 *
 * The hidden-turn set becomes a PROCESS-WIDE `<style>` element that is only ever
 * written, never emptied — see `client/hide-turns.ts` for why a component-owned
 * element cannot work here. An earlier version of this comment claimed the
 * element was owned by the icon wrapper and removed with it, which is the
 * opposite of what the code does; following it would reintroduce the bug where a
 * single bubble unmounting un-hides the whole transcript.
 *
 * ## Stability discipline
 *
 * The service names this half touches (`remote`, `sessions`, the projection key)
 * are read structurally through `ctx.get` and checked at every step. When one is
 * absent the icon reports that recall is unavailable instead of throwing — a
 * throwing component blanks its slot entry.
 *
 * @module @dsh-app/plugin-rewind/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the slots service face (ctx.slots) into this unit.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the locale runtime's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.commandUi merge and the popup/command-row prop types.
import type { CommandUiContract } from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: the branded session id the Remote command face and the projection
// lookup both take. Widening these helpers to it removes the casts at the
// popup call sites.
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { makeMessageActionView } from './client/message-action.tsx'
import { RewindCommandRow } from './client/command-row.tsx'
import { anchorsToOptions, type RewindView } from './client/popup.ts'
import type { RecallOutcome } from './client/outcome.ts'
import { hostCode } from './client/messages.ts'
import type { Translate } from './client/messages.ts'
import type { RevertPlan } from './wire.ts'
import { QuarantineSection } from './client/quarantine-section.tsx'
import { showRecallNote, mountRecallNoteHost } from './client/recall-note-host.tsx'
import { adoptStyles } from './client/styles.ts'
import { en as rewindEn, NS as REWIND_NS, zh as rewindZh, type RewindKey } from './client/locales.ts'
import { REWIND_COMMAND, REWIND_PROJECTION_KEY } from './wire.ts'

// --- 维护 tab slot (`settings.dsh-app-maintenance.tab`). The section owner —
// plugin-client-ui — DECLARES it in the same register() call that contributes
// the section (its `children` table); every tab contributor registers into it.
// The suite ships no shared package, so this block is repeated in client
// entries — plugin-client-ui/src/client.ts, plugin-presets/src/client.ts and
// plugin-rewind/src/client.ts — and the copies must stay identical line for
// line. A checkout may give each file a different line ending (this tree mixes
// CRLF and LF), so plugin-client-ui/tests/settings-merge.test.ts compares them
// modulo line endings and fails if one drifts.
// BEGIN maintenance-tab-slot
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.dsh-app-maintenance.tab': {
      kind: 'list'
      scope: 'root'
      owner: MaintenanceTabOwnerProps
    }
  }
}
/** Owner share of one maintenance tab (the section supplies nothing). */
interface MaintenanceTabOwnerProps {
  /** Marker field: tab owner props are intentionally empty. */
  children?: never
}
// END maintenance-tab-slot

// The locale namespace table lives in ui-slots: this merge is what makes
// `ctx.locale.register`/`bind` key-checked — a key missing from (or extra in)
// either dictionary of the pair fails this package's typecheck, and the same
// union constrains the picker's `t` seat.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Recall button and picker copy, plus the coded host answers. */
    [REWIND_NS]: RewindKey
  }
}

/**
 * The client halves this plugin depends on.
 *
 * `remote` and `sessions` are load-bearing: cordis answers a service property
 * access ONLY when the service is declared here, and reading an undeclared one
 * throws `cannot get property "remote.commands" without inject`. The command
 * call path goes through `ctx.remote.commands`, so omitting it makes every
 * recall fail at click time while registration still looks healthy. The
 * sub-service is declared in its dotted form as well, which is how the kernel's
 * own `ui-commands` names it.
 */
export const inject = ['slots', 'locale', 'sessions', 'uiSession', 'remote', 'remote.commands']

/**
 * Locale namespace of the built-in chat UI.
 *
 * The wrapper registers under this namespace because it renders the built-in
 * bubble, whose copy resolves through it — the same registration the chat
 * package itself uses.
 */
const CHAT_NS = 'chat'

/**
 * The Remote command face this plugin calls.
 *
 * `ctx.remote.commands.execute(sessionId, line, attachments)` is the sanctioned
 * way for a client half to run a command: it is what the kernel's own
 * `ui-commands` uses, and it routes to the same host executor as a typed line.
 */
interface RemoteCommands {
  execute(
    sessionId: string,
    line: string,
    attachments: readonly never[],
  ): Promise<{
    ok: boolean
    value?: { result?: { kind: string, text?: string, sourceEventSeq?: number } }
  }>
}

/** The `sessions` service slice this plugin reads. */
interface SessionsSlice {
  readonly binding?: (sessionId: string) => RawBinding | undefined
}

/** The raw Controller binding: the owner token, with the session and its feed. */
interface RawBinding {
  /** The session's projection store, for reading `rewindAnchors`. */
  readonly session?: {
    readonly projections?: {
      faceOf?: (key: string) => { getSnapshot?: () => unknown } | undefined
    }
  }
  /**
   * Append-only event feed of this session's log.
   *
   * A recall typed by hand (`/rewind 2`) runs entirely on the host: the client
   * never calls the command, so nothing prefills the composer. Watching the feed
   * for the command's own result is what makes BOTH entry points behave the
   * same, instead of the icon working and the typed line not.
   */
  readonly eventSource?: {
    subscribe(listener: () => void): () => void
    getSnapshot(): { change?: { kind?: string, entries?: readonly { event?: { type?: string, seq?: number, data?: unknown } }[] } }
  }
}

/**
 * The `uiSession` service slice this plugin reads.
 *
 * This — NOT `sessions.binding(id)` — is where the composer's write face lives.
 * The two are different objects and the difference is invisible:
 *
 *   - `sessions.binding(id)` returns the raw Controller binding, which carries
 *     `session` and `eventSource` and NO props;
 *   - the composer face exists only on the MATERIALIZED binding that
 *     `uiSession.materialize()` builds by folding every `uiSession.provide`
 *     descriptor. The kernel's own `ui-conversation` contributes one with
 *     `props: ["inputActions"]` (`dsh-client-ui-conversation/lib/client.js`).
 *
 * Reading `props.inputActions` off the raw binding therefore finds nothing, the
 * prefill silently does not happen, and the host's success sentence — "its text
 * is back in the composer" — is a lie. That is exactly the bug this comment
 * exists to stop being reintroduced.
 */
interface UiSessionSlice {
  /**
   * The materialized binding for one session reference.
   *
   * `reference.binding` must be the same owner token `sessions.binding(id)`
   * returns — this method throws when it is not, which is the check that makes
   * this call safe rather than a guess.
   */
  readonly bindingSource?: (reference: {
    readonly sessionId: string
    readonly binding: unknown
  }) => { getSnapshot?: () => MaterializedBinding | undefined } | undefined
}

/** One materialized session binding, as `uiSession.materialize` builds it. */
interface MaterializedBinding {
  readonly props?: {
    /** The composer write face: `setDraft` replaces the whole draft. */
    readonly inputActions?: { readonly setDraft?: (text: string) => void }
  }
  readonly hooks?: {
    /**
     * Published composer state, carrying `draft` and `phase`.
     *
     * `subscribe` is what a deferred write waits on: a hand-typed `/rewind n`
     * submits THROUGH the composer, so its result arrives while the phase machine
     * is still `submitting`, and the text can only be written once it settles.
     */
    readonly input?: {
      getSnapshot?: () => unknown
      subscribe?: (listener: () => void) => () => void
    }
  }
}

/**
 * The dictionary code a SUCCESSFUL recall answers with.
 *
 * The event observer matches on it, so it prefills only for a real recall — the
 * preview carries the recalled text too, and matching any successful command made
 * the composer fill the moment the dialog opened.
 */
const RECALL_DONE_CODE = 'rewind.host.done'

/** Slot id of this plugin's tab in the 维护设置 section. */
const QUARANTINE_TAB_ID = 'dsh-app-rewind-quarantine'

/**
 * Client apply: decorate user bubbles with a per-message recall icon, and give
 * `/rewind` a picker and a readable transcript row.
 *
 * There is deliberately NO control in the composer dock. One was tried and
 * removed: the dock sits under the input box where nothing else lives, so a
 * permanent button there read as an accidental stray element — and it duplicated
 * an affordance the per-message icon already covers. The deliberate path stays
 * the `/rewind` command (bare = picker, `/rewind <n>` = direct).
 *
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  // Recalls this page already prefilled from a command RESULT, keyed by the
  // placeholder event the host appended. The event observer reads this so the
  // same recall is not prefilled twice (see `observeTypedRecalls`).
  const handled = new Set<number>()

  // Dictionaries first: every seat below resolves through this namespace, and
  // the effect disposes the pair with this plugin's fiber.
  ctx.effect(
    () => ctx.locale.register(REWIND_NS, { zh: rewindZh, en: rewindEn }),
    'dsh-app plugin-rewind: dictionaries',
  )

  adoptStyles()

  // The outcome toast: mounted once, from here. A component mounted inside the
  // per-message wrapper would render one toast per user message on screen.
  ctx.effect(() => mountRecallNoteHost(), 'plugin-rewind: recall note host')

  // --- The quarantine manager: a tab in the suite's 维护设置 section, beside
  // 预设包 and 诊断. It is an upkeep page for this plugin, not a rail row of its
  // own — one more row for a housekeeping surface would crowd settings, and the
  // section exists for exactly this. ---
  ctx.slots.inject('settings.dsh-app-maintenance.tab', () => ctx.slots.register({
    name: 'settings.dsh-app-maintenance.tab',
    id: QUARANTINE_TAB_ID,
    // 4 = after 用量统计 (1), 预设包 (2) and 诊断 (3). The existing three are the
    // suite's upkeep set; this extends it rather than reordering it.
    order: 4,
    // `locale:` puts the namespace-bound `t` seat on the component's props.
    locale: REWIND_NS,
    label: () => t('rewind.quarantine.title'),
  }, QuarantineSection))

  // --- The command row. Without it the kernel's generic card prints the coded
  // payload verbatim, which is how `/rewind` ended up showing raw JSON. ---
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
    name: 'conversation.chat.commandview',
    key: REWIND_COMMAND,
    locale: REWIND_NS,
  }, RewindCommandRow))

  // --- The bare-invocation popup. A `popupSelect` decoration replaces what
  // `/rewind` + Enter does on this client: the host command keeps its catalog
  // row and its argument claim, and a pick submits a completed
  // `/rewind <n>` line back through the same executor a typed line uses.
  // Without this, Enter ran the host's list branch and dumped its payload. ---
  ctx.inject(['commandUi'], (scope) => {
    const commandUi = scope.get('commandUi') as CommandUiContract | undefined
    if (commandUi === undefined) return
    scope.effect(() => commandUi.decorate({
      name: REWIND_COMMAND,
      available: (session) => readProjection(ctx, session.sessionId) !== undefined,
      ui: {
        kind: 'popupSelect',
        options: async (session) => anchorsToOptions(readProjection(ctx, session.sessionId)),
        onSelect: async (option, session) => {
          const n = Number(option.id)
          if (!Number.isSafeInteger(n) || n < 1) return
          await recallByOrdinal(ctx, t, n, session.sessionId, handled)
        },
      },
    }), 'dsh-app plugin-rewind: /rewind popup')
  })

  // --- Per-message icon. The kernel has no user-bubble action slot, so the
  // icon rides the built-in `user` renderer through a wrapper registered at a
  // LOWER priority (a lower number wins, so -1 shadows the built-in's 0).
  // Wrapping is only safe for a renderer that does not call `renderSlot`:
  // `UserMessageNodeView` calls it zero times. The wrapper forwards every prop
  // it receives — including the chat-bound `t` seat — so the built-in's own
  // copy keeps resolving.
  //
  // Registration MUST go through `ctx.slots.inject`, not a bare `ctx.effect`:
  // the registry throws `slot "…" is not declared` for an undeclared key, and
  // this plugin can activate before the chat package declares the slot.
  // `inject` waits for the declaration and re-runs if it ever disappears. ---
  const t = ctx.locale.bind(REWIND_NS)
  const deps = {
    slots: ctx.slots,
    t,
    recall: (ordinal: number, sessionId: string) =>
      recallByOrdinal(ctx, t, ordinal, sessionId as SessionId, handled),
    plan: (ordinal: number, sessionId: string) =>
      planRecall(ctx, t, ordinal, sessionId as SessionId),
  }
  // `locale: 'chat'` matches how the built-in registers this slot: it supplies
  // the chat-bound `t` seat the keyed props require, and the wrapper forwards
  // it straight through to the built-in bubble. Each key registers its own
  // literal kind so the slot keeps that kind's prop type.
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'user',
    priority: -1,
    locale: CHAT_NS,
  }, makeMessageActionView('user', deps)))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'steering',
    priority: -1,
    locale: CHAT_NS,
  }, makeMessageActionView('steering', deps)))

  // --- The typed-command path. A recall typed by hand (`/rewind 2`) runs
  // entirely on the host: this client never calls the command, so without this
  // observer the icon prefills the composer and the typed line does not — while
  // the host's own success sentence promises the composer either way. Watching
  // the log for the command's result makes both entry points behave alike.
  //
  // Only APPENDED events are considered. The initial snapshot already contains
  // every earlier recall, and reacting to it would re-fill the composer with
  // text the user already dealt with — the exact bug the command-result
  // delivery was introduced to fix. ---
  observeTypedRecalls(ctx, handled)
}

/**
 * Watch every session for a `/rewind` result that this client did not issue.
 *
 * The icon path prefills from the value the command call returns; a recall typed
 * by hand (`/rewind 2`) never calls the command at all, so it has no return
 * value to read. Watching the log is what makes both entry points behave alike.
 *
 * A session created after this runs must be watched too, so the list is followed
 * rather than sampled once — a boot-time sample leaves every session the user
 * opens later without a prefill, which looks exactly like the original bug.
 *
 * ## Why the dedupe key is the recall's own event sequence
 *
 * The icon path calls the command and prefills from its return value; the SAME
 * recall then lands in this feed as a `command/done`, and a second write would
 * report `the composer already holds text` on a recall that worked perfectly.
 * An earlier version of this comment claimed that could not happen because the
 * write refuses a non-empty composer — it can, and it did, on a real machine.
 *
 * `sourceEventSeq` names the placeholder event the host appended, so it is the
 * same id on the command result and on this event. Recording the ids this page
 * already handled makes the two paths converge on one write per recall, which is
 * the one-shot discipline the whole delivery design exists to keep.
 *
 * @param ctx - the client root context.
 * @param handled - recall events this page already prefilled from a result.
 */
function observeTypedRecalls(ctx: ClientContext, handled: ReadonlySet<number>): void {
  const sessions = ctx.get('sessions') as SessionsSlice | undefined
  if (sessions?.binding === undefined) return
  const seen = new Set<string>()
  const watched = new Set<string>()
  const watch = (sessionId: string): void => {
    if (watched.has(sessionId)) return
    const source = sessions.binding?.(sessionId)?.eventSource
    // A session whose binding is not materialized yet is retried on the next
    // list change, not dropped.
    if (source === undefined) return
    watched.add(sessionId)
    const stop = source.subscribe(() => {
      const change = source.getSnapshot().change
      if (change?.kind !== 'append') return
      for (const entry of change.entries ?? []) {
        const event = entry.event
        if (event?.type !== 'command/done') continue
        const key = `${sessionId}:${String(event.seq)}`
        if (seen.has(key)) continue
        seen.add(key)
        const data = event.data as { kind?: unknown, text?: unknown, sourceEventSeq?: unknown } | undefined
        if (data?.kind !== 'success') continue
        if (typeof data.text !== 'string') continue
        // ONLY the recall's own success answer. Matching any successful command
        // made the PREVIEW prefill the composer: the plan carries the recalled
        // text too (so the dialog can show it), so a generic match wrote the
        // message back to the input box before the user had confirmed anything.
        if (!data.text.includes(`"${RECALL_DONE_CODE}"`)) continue
        // A recall this page already prefilled from the command result.
        if (typeof data.sourceEventSeq === 'number' && handled.has(data.sourceEventSeq)) continue
        prefillRecalled(ctx, sessionId as SessionId, data.text)
      }
    })
    // Disposal rides the plugin's own fiber, like every other effect here.
    ctx.effect(() => stop, `plugin-rewind: typed-recall observer for ${sessionId}`)
  }
  const known = (): string[] => {
    const list = (ctx.get('sessions') as SessionsSlice & {
      list?: { getSnapshot?: () => { byId?: Record<string, unknown>, ids?: readonly string[] } }
    } | undefined)?.list?.getSnapshot?.()
    return [...(list?.ids ?? Object.keys(list?.byId ?? {}))]
  }
  for (const id of known()) watch(id)
  const list = (ctx.get('sessions') as { list?: { subscribe?: (l: () => void) => () => void } } | undefined)?.list
  if (list?.subscribe === undefined) return
  const stopAll = list.subscribe(() => {
    for (const id of known()) watch(id)
  })
  ctx.effect(() => stopAll, 'plugin-rewind: typed-recall observer list')
}

/**
 * Ask the host what a recall would do, for the confirmation dialog.
 *
 * A separate command from the recall itself (`/rewind plan <n>`), so a preview
 * is incapable of changing anything. The refusal reasons arrive as codes and are
 * rendered here, where the `t` seat lives — the dialog must show a sentence, and
 * `rewind.host.busy` is not one.
 *
 * @param ctx - the client root context.
 * @param t - this plugin's locale-bound `t`.
 * @param n - the ordinal to preview.
 * @param sessionId - the session to act on.
 * @returns the plan, or a finished sentence explaining why there is none.
 */
async function planRecall(
  ctx: ClientContext,
  t: Translate,
  n: number,
  sessionId: SessionId,
): Promise<{ readonly plan?: RevertPlan, readonly note?: string }> {
  const remote = (ctx.get('remote') as { commands?: RemoteCommands } | undefined)?.commands
  if (remote === undefined) return { note: t('rewind.error.unavailable') }
  if (typeof sessionId !== 'string' || sessionId === '') return { note: t('rewind.error.noSession') }
  try {
    const result = await remote.execute(sessionId, `/rewind plan ${n}`, [])
    const outcome = result.value?.result
    if (!result.ok || outcome === undefined || outcome.kind !== 'success') {
      const coded = hostCode(outcome?.text)
      return { note: coded === undefined ? t('rewind.error.unavailable') : t(coded.code, coded.params) }
    }
    const payload = parsedPlan(outcome.text)
    if (payload?.ok !== true) {
      const coded = hostCode(outcome.text)
      return { note: coded === undefined ? t('rewind.error.unavailable') : t(coded.code, coded.params) }
    }
    return { plan: payload }
  } catch {
    return { note: t('rewind.error.unavailable') }
  }
}

/**
 * Read the plan payload out of a success result.
 *
 * @param raw - the command result's text, carrying the coded payload.
 * @returns the plan, or undefined when the payload is not one.
 */
function parsedPlan(raw: string | undefined): (RevertPlan & { readonly ok?: unknown }) | undefined {
  if (raw === undefined || raw === '') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return parsed as RevertPlan & { readonly ok?: unknown }
  } catch {
    return undefined
  }
}

/**
 * Run `/rewind <n>` and report the outcome.
 *
 * Services are read through `ctx.get(name)`, cordis's own untyped lookup: the
 * client service names are not part of a documented Context map in this build,
 * and a structural read keeps a missing service a `undefined` rather than a
 * throw. Every step is guarded for that reason.
 *
 * @param ctx - the client root context.
 * @param n - the ordinal to recall.
 * @param sessionId - the session to act on. Both entry points know it: the
 *   per-message icon from the bubble it sits under, the picker from its own
 *   session-scoped slot props. Nothing here guesses it from the client's list
 *   snapshot, which has no "current session" field to read.
 * @param handled - records the recall this call prefilled, so the event observer
 *   skips it instead of writing a second time.
 */
async function recallByOrdinal(
  ctx: ClientContext,
  t: Translate,
  n: number,
  sessionId: SessionId,
  handled: Set<number>,
): Promise<RecallOutcome> {
  const remote = (ctx.get('remote') as { commands?: RemoteCommands } | undefined)?.commands
  if (remote === undefined) return { ok: false, code: 'rewind.error.unavailable' }
  const target = sessionId
  if (typeof target !== 'string' || target === '') return { ok: false, code: 'rewind.error.noSession' }
  try {
    const result = await remote.execute(target, `/rewind ${n}`, [])
    const outcome = result.value?.result
    if (!result.ok || outcome === undefined) {
      // The transport refused without a command outcome. `result.error` is the
      // kernel's own envelope when it carries one; the coded fallback keeps the
      // report actionable either way.
      return { ok: false, code: 'rewind.error.unavailable' }
    }
    if (outcome.kind !== 'success') {
      // A refusal is a coded host answer: hand the code up so the component
      // renders it in its own dictionary, rather than reporting a generic
      // failure that reads the same for every reason.
      const coded = hostCode(outcome.text)
      return coded === undefined
        ? { ok: false, code: 'rewind.error.unavailable' }
        : { ok: false, code: coded.code, ...(coded.params === undefined ? {} : { params: coded.params }) }
    }
    // Claim this recall BEFORE writing, so the observer — which may see the same
    // event first — does not write it too.
    if (typeof outcome.sourceEventSeq === 'number') handled.add(outcome.sourceEventSeq)
    // The recalled text arrives with THIS result and is put back now, once.
    // It deliberately does not come from the projection: that is durable state
    // a reload replays, which made the text reappear in the composer forever.
    // A prefill that did NOT happen reports why: the recall itself succeeded,
    // and a success that silently produced no draft is the hardest kind of
    // failure to report after the fact.
    const blocked = prefillRecalled(ctx, target, outcome.text)
    const revert = revertSummary(outcome.text, t)
    if (blocked !== undefined) return { ok: true, note: `composer prefill skipped: ${blocked}` }
    if (revert !== undefined) return { ok: true, note: revert }
    return { ok: true }
  } catch {
    return { ok: false, code: 'rewind.error.unavailable' }
  }
}

/**
 * Read the file revert's tally out of a success result.
 *
 * Reports ONLY the unrestorable ones. A recall that did what it said needs no
 * announcement — the message is gone from the transcript and the text is back in
 * the composer, which the user can see. A tally of restored/removed files is
 * noise on a success; measured on a real machine as a small red note over the
 * composer after a perfectly good recall, which reads as a problem.
 *
 * The failure case is the opposite: a file this plugin could not see (a shell
 * command's write) leaves the tree half-reverted, and staying quiet about that
 * would make "reverted" a lie. So that one IS announced, with paths.
 *
 * @param raw - the command result's text, carrying the coded payload.
 * @param t - this plugin's locale-bound `t`.
 * @returns the sentence to show, or undefined when there is nothing to report.
 */
function revertSummary(
  raw: string | undefined,
  t: Translate,
): string | undefined {
  if (raw === undefined || raw === '') return undefined
  let files: unknown
  try {
    files = (JSON.parse(raw) as { files?: unknown }).files
  } catch {
    return undefined
  }
  if (typeof files !== 'object' || files === null) return undefined
  const { unrestorable } = files as { unrestorable?: unknown }
  if (!Array.isArray(unrestorable) || unrestorable.length === 0) return undefined
  // Named, not counted: "1 file could not be restored" without saying WHICH one
  // is not actionable. The sentence comes from the DICTIONARY — an English
  // literal here showed up in a Chinese UI, which is the same rule the host half
  // follows when it sends a code instead of prose.
  const names = unrestorable
    .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as { path?: unknown }).path : undefined))
    .filter((p): p is string => typeof p === 'string')
  return t('rewind.files.unrestorable', {
    count: unrestorable.length,
    paths: names.join(', '),
  })
}

/**
 * Put a recalled message's original text back in the composer, once.
 *
 * The prompt travels in the command result (`rewind.host.done`), so this runs
 * only when a recall actually succeeds in THIS page session. It deliberately
 * does NOT come from the projection: that is durable state a reload replays,
 * which made the text reappear in the composer on every reload.
 *
 * The composer face is read off the MATERIALIZED session binding, reached
 * through `uiSession.bindingSource` — see {@link UiSessionSlice} for why the raw
 * `sessions.binding(id)` does not carry it. Only an idle, empty composer is
 * written, because `setDraft` replaces everything the user typed.
 *
 * ## Why every step reports a reason
 *
 * This used to `return` silently at each guard, and a silent return is
 * indistinguishable from a working write: the recall succeeded, the message left
 * the transcript, and nothing appeared in the composer — with nothing anywhere
 * saying which step refused. The caller now surfaces this reason, so one
 * real-machine run pinpoints the step instead of guessing.
 *
 * ## Why a draft that already holds the text is SUCCESS, not a refusal
 *
 * TWO writers race on one recall, and both are legitimate:
 *
 *   - the icon path writes from the command RESULT when the RPC returns;
 *   - the event observer writes when it sees the `command/done` event.
 *
 * The event can arrive first, so the result path then finds a non-empty composer
 * — holding the very text it was about to write — and reported "the composer
 * already holds text" on a recall that worked perfectly. Marking the recall as
 * handled cannot fix that: the mark happens when the RPC returns, which is after
 * the observer has already run.
 *
 * The write is therefore IDEMPOTENT: finding exactly this text already in place
 * is the outcome it wanted, so it reports success and writes nothing. Any OTHER
 * text still refuses, because `setDraft` would replace what the user typed.
 *
 * @param ctx - the client root context.
 * @param sessionId - the session the recall happened in.
 * @param raw - the command result's text, carrying the coded payload.
 * @returns `undefined` when the text is in the composer, otherwise why not.
 */
function prefillRecalled(
  ctx: ClientContext,
  sessionId: SessionId,
  raw: string | undefined,
): string | undefined {
  const prompt = recalledPrompt(raw)
  if (prompt === undefined || prompt === '') return 'no prompt in the command result'
  const sessions = ctx.get('sessions') as SessionsSlice | undefined
  const owner = sessions?.binding?.(sessionId)
  if (owner === undefined) return 'this session resolved no raw binding'
  const materialized = materializedBinding(ctx, sessionId, owner)
  if (materialized === undefined) return 'the uiSession binding is unavailable'
  const setDraft: unknown = materialized.props?.inputActions?.setDraft
  if (typeof setDraft !== 'function') return 'the materialized binding publishes no inputActions.setDraft'
  const published = materialized.hooks?.input?.getSnapshot?.()
  const state = typeof published === 'object' && published !== null
    ? published as { draft?: unknown, phase?: unknown }
    : undefined
  const draft = typeof state?.draft === 'string' ? state.draft : undefined
  // Already done — the other writer won the race. Not a failure.
  if (draft !== undefined && draft === prompt) return undefined
  if (draft !== undefined && draft.trim() !== '') return 'the composer already holds text'
  if (typeof state?.phase === 'string' && state.phase !== 'plain') {
    // A hand-typed `/rewind n` submits through the composer, so the phase machine
    // is `submitting` when its `command/done` arrives. Refusing here is why that
    // path never prefilled: the text would be dropped by the submit's own
    // `commit-draft` anyway. So wait for the machine to settle, then write.
    return deferUntilIdle(materialized, setDraft as (text: string) => void, prompt)
  }
  ;(setDraft as (text: string) => void)(prompt)
  return undefined
}

/** How long a deferred write waits for the composer to settle. */
const SETTLE_TIMEOUT_MS = 15_000

/**
 * Write once the composer's phase machine returns to `plain`.
 *
 * Subscribing rather than polling: the settle is signalled by the store itself,
 * and a poll would both lag and burn a timer per recall. The subscription and its
 * timeout are torn down on the first settle, so nothing outlives the attempt.
 *
 * @param binding - the materialized binding whose `hooks.input` publishes state.
 * @param setDraft - the composer write face.
 * @param prompt - the text to put back.
 * @returns `undefined` — the outcome is reported later, if it fails at all.
 */
function deferUntilIdle(
  binding: MaterializedBinding,
  setDraft: (text: string) => void,
  prompt: string,
): undefined {
  const input = binding.hooks?.input
  if (typeof input?.subscribe !== 'function' || typeof input.getSnapshot !== 'function') {
    showRecallNote('composer prefill skipped: the composer state is not subscribable')
    return undefined
  }
  const settle = (): void => {
    const state = input.getSnapshot?.() as { draft?: unknown, phase?: unknown } | undefined
    if (typeof state?.phase === 'string' && state.phase !== 'plain') return
    stop()
    const draft = typeof state?.draft === 'string' ? state.draft : undefined
    if (draft === prompt) return
    if (draft !== undefined && draft.trim() !== '') {
      showRecallNote('composer prefill skipped: the composer already holds text')
      return
    }
    setDraft(prompt)
  }
  let stopped = false
  const unsubscribe = input.subscribe(settle)
  const timer = setTimeout(() => {
    stop()
    showRecallNote('composer prefill skipped: the composer never settled')
  }, SETTLE_TIMEOUT_MS)
  function stop(): void {
    if (stopped) return
    stopped = true
    unsubscribe()
    clearTimeout(timer)
  }
  return undefined
}

/**
 * Resolve ONE session's materialized binding.
 *
 * `uiSession.bindingSource(reference)` throws when `reference.binding` is not
 * the owner token the Controller currently holds for that id, so the raw
 * binding is read first and passed straight through — the two facts come from
 * one source and cannot disagree.
 *
 * When the reference does not line up (an id the Controller has since dropped),
 * the call throws and the write is reported as skipped rather than applied to
 * the wrong session.
 */
function materializedBinding(
  ctx: ClientContext,
  sessionId: SessionId,
  owner: unknown,
): MaterializedBinding | undefined {
  const uiSession = ctx.get('uiSession') as UiSessionSlice | undefined
  try {
    const source = uiSession?.bindingSource?.({ sessionId, binding: owner })
    return source?.getSnapshot?.()
  } catch {
    return undefined
  }
}

/** Read the `prompt` field out of a coded command result, or undefined. */
function recalledPrompt(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined
  try {
    const parsed = JSON.parse(raw) as { prompt?: unknown }
    return typeof parsed?.prompt === 'string' ? parsed.prompt : undefined
  } catch {
    return undefined
  }
}

/** Read this plugin's projection value for one session. */
function readProjection(ctx: ClientContext, sessionId: SessionId): RewindView | undefined {
  const sessions = ctx.get('sessions') as SessionsSlice | undefined
  return sessions?.binding?.(sessionId)?.session?.projections
    ?.faceOf?.(REWIND_PROJECTION_KEY)?.getSnapshot?.() as RewindView | undefined
}
