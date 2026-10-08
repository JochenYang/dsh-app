/**
 * The per-message recall icon, and the wrapper that puts it on a user bubble.
 *
 * ## Why a wrapper and not a slot
 *
 * The kernel has no slot on a user-message bubble: the only message-actions
 * slot (`conversation.chat.assistant-actions`) is reached from the assistant
 * turn tail, and nothing equivalent exists for the user side. So the icon rides
 * the built-in `user` renderer, which this module wraps.
 *
 * Wrapping is only safe for a renderer that does NOT call `renderSlot` itself:
 * a wrapper cannot supply the child-slot renderers the owner would have passed,
 * and the slot system retires a registration that throws. `UserMessageNodeView`
 * calls `renderSlot` zero times (measured on 0.2.0-rc.2) — unlike `turn-tail`,
 * which calls it three times and must never be wrapped.
 *
 * The wrapper resolves the built-in component through `slots.entries(...)` at
 * mount and re-resolves while it is absent, because registration order is not
 * guaranteed: this plugin may load before the chat package registers `user`.
 * It renders `null` until the built-in is found rather than drawing a
 * second-rate bubble.
 *
 * ## The locale seat
 *
 * `ChatNodeViewProps` carries a `t` seat bound to the CHAT namespace, and the
 * renderer receives it as a normal prop. The wrapper therefore forwards the
 * props it was given unchanged — including `t` — and only adds the icon. It
 * must NOT substitute its own namespace's `t`: this plugin's `t` throws on a
 * key it does not own, so the built-in's `chat.…` lookups would fail.
 *
 * @module @dsh-app/plugin-rewind/client/message-action
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatNodeKind, ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RecallOutcome } from './outcome.ts'
import type { Translate } from './messages.ts'
import { ConfirmDialog } from './confirm-dialog.tsx'
import type { RevertPlan } from '../wire.ts'
import { useHiddenTurns } from './hide-turns.ts'
import { showRecallNote } from './recall-note-host.tsx'

/** One slot entry, as the registry exposes it. */
interface SlotEntry {
  readonly options?: { readonly key?: string, readonly priority?: number }
  readonly component?: unknown
}

/** The `slots` service slice this module reads. */
export interface SlotsLike {
  entries(key: string): readonly SlotEntry[]
}

/**
 * The recall icon: an arrow curving back to the left, drawn to match the host's
 * 15px action glyphs.
 *
 * The GLYPH is drawn here rather than imported: the kernel's guidance is that a
 * plugin must not load a Harness Client package as a module for artwork (those
 * change without notice, and a throwing component blanks its slot entry).
 * `Tooltip` is the documented exception the whole suite already uses — it is the
 * only way to get the host's themed bubble instead of the browser's native one.
 * `currentColor` and `aria-hidden` keep the glyph behaving like its neighbours.
 */
export function RecallIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3.2 6.4h5.6a3.4 3.4 0 0 1 0 6.8H5.4" />
      <path d="M5.8 3.6 3 6.4l2.8 2.8" />
    </svg>
  )
}

/** What the wrapper needs from its own context. */
export interface MessageActionDeps {
  /** Slot registry reader, for resolving the built-in renderer. */
  readonly slots: SlotsLike
  /**
   * This plugin's locale-bound `t`, for the icon's label and tooltip, and for
   * the sentence a failed recall reports.
   *
   * The per-message icon carries its OWN copy, not the picker's: the `/rewind`
   * picker asks "choose a message", while this icon acts on the message it sits
   * under ("recall THIS one"). One sentence for both read as a mistake beside a
   * specific message.
   *
   * It is the FULL dictionary seat, not just the two icon keys, because this
   * component is where a failed recall is turned into copy — the overlay it
   * reports through has no dictionary of its own.
   */
  readonly t: Translate
  /**
   * Perform a recall by ORDINAL for one session.
   *
   * The wrapper resolves the node's sequence to an ordinal through the
   * projection and passes both, so the entry never has to guess which session a
   * bubble belongs to.
   *
   * Returns the outcome so a refusal is VISIBLE: a click that silently does
   * nothing is indistinguishable from a broken button, which is how the first
   * round of this feature read on a real machine.
   */
  readonly recall: (ordinal: number, sessionId: string) => Promise<RecallOutcome>
  /**
   * Ask what a recall would do, without doing it.
   *
   * The confirmation dialog renders this. It must be a separate call: a preview
   * that could change things is not a preview.
   */
  readonly plan: (ordinal: number, sessionId: string) => Promise<RecallPlanOutcome>
}

/** The outcome of asking what a recall would do. */
interface RecallPlanOutcome {
  /** The plan, when the recall is possible. */
  readonly plan?: RevertPlan
  /** A finished sentence to show when it is not. */
  readonly note?: string
}

/**
 * Find the built-in renderer for one key.
 *
 * The built-in chat package registers at the default priority (0); this
 * plugin's wrapper registers lower (-1) so it wins, and the search here skips
 * itself by looking for the priority-0 entry first.
 */
function findBuiltin(slots: SlotsLike, key: string): unknown {
  const entries = slots.entries('conversation.chat.node')
  const match = entries.find((entry) => entry.options?.key === key && (entry.options?.priority ?? 0) === 0)
    ?? entries.find((entry) => entry.options?.key === key)
  return match?.component
}

/**
 * Build the wrapper component for one built-in key.
 *
 * Generic over the chat node kind so the registration keeps its per-kind prop
 * type: registering `'user' | 'steering'` as one union would make the props
 * type the union of every kind, which the slot registry rejects.
 *
 * @param key - the keyed chat node renderer to wrap.
 * @param deps - slot reader, `t` seat, and the recall callback.
 * @returns a component that renders the built-in bubble with a recall icon.
 */
export function makeMessageActionView<Kind extends ChatNodeKind>(
  key: Kind,
  deps: MessageActionDeps,
): (props: ChatNodeViewProps<Kind>) => ReactNode {
  /** The built-in component for this key, resolved once it is registered. */
  function useBuiltin(): unknown {
    const [builtin, setBuiltin] = useState<unknown>(() => findBuiltin(deps.slots, key))
    useEffect(() => {
      if (builtin !== undefined && builtin !== null) return undefined
      let cancelled = false
      const timer = setInterval(() => {
        const found = findBuiltin(deps.slots, key)
        if (found === undefined || found === null || cancelled) return
        setBuiltin(found)
        clearInterval(timer)
      }, 250)
      return () => {
        cancelled = true
        clearInterval(timer)
      }
    }, [builtin])
    return builtin
  }

  return function MessageActionView(props: ChatNodeViewProps<Kind>): ReactNode {
    const builtin = useBuiltin()
    // The slot is session-scoped, so the standard kit hands this component the
    // session id and the projection hook directly. Reading them from the props
    // is the reliable path: a root-context service lookup can be absent or
    // point at a different session than the one this bubble belongs to.
    const sessionId = (props as { sessionId?: unknown }).sessionId
    const useProjection = (props as { useProjection?: (key: string) => unknown }).useProjection
    // The pending confirmation for THIS bubble: the ordinal to recall, the
    // session, and the host's plan. Local state, so one bubble's dialog cannot
    // appear over another's.
    const [pending, setPending] = useState<
      { readonly n: number, readonly sessionId: string, readonly plan: RevertPlan } | undefined
    >(undefined)
    const [busy, setBusy] = useState(false)
    const view = typeof useProjection === 'function'
      ? useProjection('rewindAnchors') as {
        anchors?: readonly { n: number, seq: number }[]
        hiddenTurns?: readonly number[]
      } | undefined
      : undefined
    // Recalled turns leave the transcript through this stylesheet. It lives here
    // because this wrapper is mounted for every user bubble, which is the only
    // surface guaranteed to exist in a session that has anything to hide.
    useHiddenTurns(view?.hiddenTurns)

    if (builtin === undefined || builtin === null) return null
    const Builtin = builtin as (input: ChatNodeViewProps<Kind>) => ReactNode

    // Only a real user prompt is recallable. `steering` shares the built-in
    // renderer but is a mid-turn interjection, so it renders without the icon.
    const seq = typeof props.node?.anchorSeq === 'number' ? props.node.anchorSeq : undefined
    // The icon knows the node's SEQUENCE; the command takes an ORDINAL. Resolve
    // it from the same projection the picker reads, so a node that is not
    // recallable (already cut, or injected context) simply shows no icon.
    const anchor = seq === undefined ? undefined : view?.anchors?.find((item) => item.seq === seq)
    return (
      <>
        <Builtin {...props} />
        {key === 'user' && seq !== undefined && anchor !== undefined && typeof sessionId === 'string' && (
          <div className="dshRewind-iconRow">
            <Tooltip label={deps.t('rewind.message.action.hint')} side="top" align="end">
              <button
                type="button"
                className="dshRewind-iconAction"
                aria-label={deps.t('rewind.message.action.aria')}
                onClick={(event) => {
                  event.stopPropagation()
                  // Preview FIRST. A recall rewrites files, so the click opens a
                  // confirmation instead of performing it: by the time a sentence
                  // reported the outcome, the tree would already have changed.
                  setBusy(true)
                  void deps.plan(anchor.n, sessionId).then((planned) => {
                    setBusy(false)
                    if (planned.plan === undefined) {
                      showRecallNote(planned.note ?? deps.t('rewind.error.unavailable'))
                      return
                    }
                    setPending({ n: anchor.n, sessionId, plan: planned.plan })
                  })
                }}
              >
                <RecallIcon />
              </button>
            </Tooltip>
          </div>
        )}
        <ConfirmDialog
          open={pending !== undefined}
          plan={pending?.plan}
          busy={busy}
          t={deps.t}
          onClose={() => setPending(undefined)}
          onConfirm={() => {
            const target = pending
            if (target === undefined) return
            setBusy(true)
            void deps.recall(target.n, target.sessionId).then((outcome) => {
              setBusy(false)
              setPending(undefined)
              // Reported through the overlay, never inside this row: the row sits
              // in the turn the recall just hid, so a note here is display:none in
              // exactly the case it exists for. The SENTENCE is rendered here,
              // where `t` lives — the overlay has no dictionary of its own.
              if (outcome.note !== undefined) showRecallNote(outcome.note)
              else if (!outcome.ok) {
                showRecallNote(
                  outcome.code === undefined
                    ? deps.t('rewind.error.unavailable')
                    : deps.t(outcome.code, outcome.params),
                )
              }
            })
          }}
        />
      </>
    )
  }
}
