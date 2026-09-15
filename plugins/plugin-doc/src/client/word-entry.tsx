/**
 * The Word capsule: one entry in the shared office bar under the composer card
 * (see client/office-bar), shown the same way in the new-session hero and in an
 * open session.
 *
 * The capsule is a toggle, not a launcher: clicking its body turns Word mode on
 * or off, and the mode is what the workflow reacts to. Word has no template, so
 * there is no dropdown and no panel — the capsule is the whole surface.
 *
 * Which session the capsule acts on is read from the live session selection
 * (client.ts hands in the ui-session binding observable), not from a mount-time
 * prop: one capsule serves the hero and every session it hands over to. With no
 * session selected the toggle parks its decision in the shared pending slot and
 * the capsule reports that state honestly — the first session-bound pass applies
 * it through the same PUT, so a toggle made before the session existed survives.
 *
 * The mode is applied optimistically and reverted on failure, so the capsule
 * never lags behind the click. The capsule body is a real button for keyboard
 * use.
 *
 * Every word this capsule renders comes from the plugin's own locale namespace
 * through the {@link useTranslate} seat client.ts hands in: the capsule is not a
 * slot occupant, so no renderer-synthesized `t` prop exists for it.
 *
 * @module @dsh-app/plugin-doc/client/word-entry
 */

import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { HostObservable, StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import { OFFICE_ACTIVE_FORMAT } from '../office-format.ts'
import { docModeApi } from './api.ts'
import type { ModeValue } from './api.ts'
import { UNLOADED_MODE, capsuleState, resolveCapsuleMode } from './capsule-state.ts'
import { useTranslate } from './locale-seat.ts'
import type { LocaleSeat } from './locale-seat.ts'
import { useOfficeSupersede } from './office-supersede.ts'
import { pendingMode } from './pending-mode.ts'
import { applySkillReference, removeSkillReference } from './skill-prefill.ts'
import { SKILL_TOKEN } from './skill-reference.ts'

/** The ui-session binding that follows the current session selection. */
export type SessionSource = HostObservable<StandardSourceBinding>

/** Small inline document glyph for the capsule's leading cluster. */
function DocIcon(): ReactNode {
  return (
    <svg className="dshWordCapsuleIcon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M4 1.8h5l3 3v9.4H4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M9 1.9v3h2.9" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M5.8 8.2h4.4M5.8 10.4h4.4" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

/** The live session binding; the absent projection carries no session id. */
function useSessionBinding(source: SessionSource): StandardSourceBinding {
  return useSyncExternalStore(
    listener => source.subscribe(listener),
    () => source.getSnapshot(),
  )
}

/** The selected session id, or `undefined` while no session exists. */
function sessionIdOf(binding: StandardSourceBinding): string | undefined {
  const id: unknown = binding.props.sessionId
  return typeof id === 'string' ? id : undefined
}

/**
 * The capsule body: mode state, the optimistic toggle and the pending hand-off
 * to the first real session. Memoized so parent renders never rebuild it.
 */
export const WordOfficeEntry = memo(function WordOfficeEntry(props: {
  sessionSource: SessionSource
  locale: LocaleSeat
}): ReactNode {
  const t = useTranslate(props.locale)
  const binding = useSessionBinding(props.sessionSource)
  const sessionId = sessionIdOf(binding)

  // undefined = not loaded yet; the capsule still renders (inactive state).
  const [boundMode, setBoundMode] = useState<ModeValue | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  // Both notices are held as state and worded at render time, so a language
  // switch re-words one that is already on screen instead of stranding it.
  const [pendingNotice, setPendingNotice] = useState(false)
  // The only trace of a turn-on that could not seed the skill reference (the
  // draft already held text); it clears itself so it never becomes clutter. The
  // sequence is what restarts the timer for a repeated hint.
  const [skillHint, setSkillHint] = useState<{ seq: number } | undefined>(undefined)
  const hintSeq = useRef(0)

  // With no session the parked decision *is* the mode, and both the hero and
  // the session that follows re-render when the slot changes.
  const parked = useSyncExternalStore(pendingMode.subscribe, pendingMode.get)
  const mode: ModeValue | undefined = sessionId === undefined
    ? { enabled: parked === true, updatedAt: null }
    : boundMode

  // Refs keep the callbacks identity-stable across re-renders.
  const modeRef = useRef(mode)
  modeRef.current = mode
  const busyRef = useRef(busy)
  busyRef.current = busy
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  // The latest binding, read at click time: the composer face it publishes is
  // what a turn-on seeds, and reading it through a ref keeps the callbacks
  // identity-stable.
  const bindingRef = useRef(binding)
  bindingRef.current = binding
  // Session whose mode load (or pending hand-off) already ran; a repeated run
  // for the same id is then only the parked slot changing while it is open.
  const loadedFor = useRef<string | undefined>(undefined)

  // Turn-on reference: one kernel chip is placed at the head of the draft; the
  // hint stands only for the case it could not be placed over user text, and
  // clears itself.
  const announceSkill = useCallback((turningOn: boolean): void => {
    if (applySkillReference(bindingRef.current, turningOn).kind !== 'notice') return
    hintSeq.current += 1
    setSkillHint({ seq: hintSeq.current })
  }, [])

  useEffect(() => {
    if (skillHint === undefined) return
    const timer = setTimeout(() => { setSkillHint(undefined) }, 4000)
    return () => { clearTimeout(timer) }
  }, [skillHint])

  useEffect(() => {
    if (sessionId === undefined) return
    // The parked decision (chosen before this session existed) is consumed
    // before the read and applied after it settles, so a stale answer cannot
    // overwrite it.
    const parkedValue = parked === undefined ? undefined : pendingMode.consume()
    const fresh = loadedFor.current !== sessionId
    if (parkedValue === undefined && !fresh) return
    loadedFor.current = sessionId
    let cancelled = false
    if (fresh) {
      setBoundMode(undefined)
      setError(undefined)
    }
    const applyParked = (enabled: boolean, previous: boolean): void => {
      setBoundMode({ enabled, updatedAt: null })
      // Only an off -> on edge seeds the skill reference (live-path rule).
      announceSkill(enabled && !previous)
      docModeApi.setMode(sessionId, enabled).then(
        (result) => { if (!cancelled) setBoundMode(result) },
        (cause: unknown) => {
          // The pick was already made; a failed hand-off only reports itself.
          console.warn(`[dsh-app plugin-doc] parked Word mode was not applied: ${cause instanceof Error ? cause.message : String(cause)}`)
        },
      )
    }
    docModeApi.mode(sessionId).then(
      (value) => {
        if (cancelled) return
        setBoundMode(value)
        if (parkedValue !== undefined) applyParked(parkedValue, value.enabled)
      },
      () => { if (!cancelled) setBoundMode(undefined) },
    )
    return () => { cancelled = true }
  }, [sessionId, parked])

  const toggle = useCallback((): void => {
    if (busyRef.current) return
    const current = modeRef.current ?? UNLOADED_MODE
    const state = capsuleState({
      sessionBound: sessionId !== undefined,
      enabled: current.enabled,
    })
    const next = state.toggle.enabled
    if (sessionId === undefined) {
      // No session to write a mode to yet: the decision is parked for the
      // session-bound pass instead of pretended.
      pendingMode.set(next)
      setPendingNotice(next)
      return
    }
    const previous = current.enabled
    const previousUpdatedAt = current.updatedAt
    setBusy(true)
    setError(undefined)
    setBoundMode({ enabled: next, updatedAt: null })
    announceSkill(next)
    docModeApi.setMode(sessionId, next).then(
      (result) => { setBoundMode(result) },
      (cause: unknown) => {
        // Optimistic flip failed: restore the pre-click state and surface why.
        setBoundMode({ enabled: previous, updatedAt: previousUpdatedAt })
        setError(cause instanceof Error ? cause.message : String(cause))
      },
    ).finally(() => {
      setBusy(false)
    })
  }, [sessionId])

  /**
   * Another office format claimed the shared slot later than this session's
   * mode: close locally, drop the chip this capsule placed, and persist the
   * off state (best effort — the winner's claim is untouched).
   */
  const supersede = useCallback((): void => {
    const current = modeRef.current
    const sid = sessionIdRef.current
    if (current === undefined || !current.enabled || sid === undefined || busyRef.current) return
    setBusy(true)
    setError(undefined)
    setBoundMode({ enabled: false, updatedAt: null })
    removeSkillReference(bindingRef.current)
    docModeApi.setMode(sid, false).then(
      (result) => { setBoundMode(result) },
      (cause: unknown) => {
        setBoundMode(current)
        setError(cause instanceof Error ? cause.message : String(cause))
      },
    ).finally(() => {
      setBusy(false)
    })
  }, [])

  const { mode: resolved, loaded } = resolveCapsuleMode(mode)

  useOfficeSupersede({
    format: OFFICE_ACTIVE_FORMAT,
    enabled: resolved.enabled,
    sessionBound: sessionId !== undefined,
    ownUpdatedAt: resolved.updatedAt,
    readActive: () => docModeApi.officeActive(),
    onSuperseded: supersede,
  })

  // The hero hint stands only while the toggle is still parked: once the
  // session-bound pass consumes it, this capsule is back to no decision.
  const showNotice = pendingNotice && parked !== undefined
  const hint = resolved.enabled
    ? t('capsule.hintOn')
    : sessionId === undefined || !loaded ? t('capsule.hintOffPending') : t('capsule.hintOff')

  return (
    <>
      <span className={resolved.enabled ? 'dshWordCapsule dshWordCapsuleActive' : 'dshWordCapsule'}>
        <button
          type="button"
          className="dshWordCapsuleBody"
          title={hint}
          aria-pressed={resolved.enabled}
          disabled={busy}
          onClick={toggle}
        >
          <DocIcon />
          <span className="dshWordCapsuleLabel">{t('capsule.label')}</span>
        </button>
      </span>
      {error !== undefined && <span className="dshWordCapsuleError" role="alert">{error}</span>}
      {showNotice && <span className="dshWordCapsuleNotice" role="status">{t('capsule.pendingNotice')}</span>}
      {skillHint !== undefined && (
        <span className="dshWordCapsuleNotice" role="status">
          {t('capsule.skillHint', { label: t('capsule.label'), token: SKILL_TOKEN })}
        </span>
      )}
    </>
  )
})
