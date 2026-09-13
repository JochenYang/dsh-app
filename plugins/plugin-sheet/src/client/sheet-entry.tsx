/**
 * The Excel capsule: one entry in the shared office bar under the composer card
 * (see client/office-bar), shown the same way in the new-session hero and in an
 * open session.
 *
 * The capsule is a toggle, not a launcher: clicking its body turns the
 * spreadsheet mode on or off, and the mode is what the prompt section and the
 * tool workflow react to. There is no dropdown — the Excel format has no
 * per-session variant to pick — so the whole state is the outline: neutral
 * while off, filled brand color while on.
 *
 * Which session the capsule acts on is read from the live session selection
 * (client.ts hands in the ui-session binding observable), not from a mount-time
 * prop: one capsule serves the hero and every session it hands over to. With no
 * session selected the toggle parks its value in the shared pending slot and
 * the capsule reports that state honestly — the first session-bound pass
 * applies it through the same PUT, so a toggle made before the session existed
 * survives.
 *
 * The suite is mutually exclusive: the capsule polls the shared active claim
 * and closes itself when another format has superseded it (see
 * client/office-supersede), removing the chip it placed in the draft.
 *
 * All copy zh-CN; the body is a real button for keyboard use.
 *
 * @module @dsh-app/plugin-sheet/client/sheet-entry
 */

import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { HostObservable, StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import { OFFICE_ACTIVE_FORMAT } from '../office-format.ts'
import { sheetModeApi } from './api.ts'
import type { ModeValue } from './api.ts'
import { SHEET_LABEL, UNLOADED_MODE, capsuleState, resolveCapsuleMode } from './capsule-state.ts'
import { useOfficeSupersede } from './office-supersede.ts'
import { pendingMode } from './pending-mode.ts'
import { applySkillReference, removeSkillReference, skillReferenceHint } from './skill-prefill.ts'

/** The ui-session binding that follows the current session selection. */
export type SessionSource = HostObservable<StandardSourceBinding>

/** Shown while a toggle waits for the session it will be applied to. */
const PENDING_NOTICE = '将在会话开始后生效'

/** Small inline spreadsheet glyph for the capsule's leading cluster. */
function GridIcon(): ReactNode {
  return (
    <svg className="dshSheetCapsuleIcon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M1.5 6h13M1.5 9.5h13M6 2.5v11M10.5 2.5v11" fill="none" stroke="currentColor" strokeWidth="1.1" />
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
 * The capsule body: mode state, the optimistic toggle and the pending
 * hand-off to the first real session. Memoized so parent renders never rebuild
 * it.
 *
 * The session id is read reactively; when it is absent the capsule stands for
 * the new-session hero and the toggle parks its value instead of pretending a
 * mode was stored. The parked value is what the capsule reports until the
 * session-bound pass consumes it and applies it through the same PUT as a live
 * toggle.
 */
export const SheetOfficeEntry = memo(function SheetOfficeEntry(props: { sessionSource: SessionSource }): ReactNode {
  const binding = useSessionBinding(props.sessionSource)
  const sessionId = sessionIdOf(binding)

  // undefined = not loaded yet; the capsule still renders (inactive state).
  const [boundMode, setBoundMode] = useState<ModeValue | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  // The only trace of a turn-on that could not seed the skill reference (the
  // draft already held text); it clears itself so it never becomes clutter.
  const [skillHint, setSkillHint] = useState<{ text: string, seq: number } | undefined>(undefined)
  const hintSeq = useRef(0)

  // With no session the parked value *is* the mode, and both the hero and the
  // session that follows re-render when the slot changes.
  const parked = useSyncExternalStore(pendingMode.subscribe, pendingMode.get)
  const mode: ModeValue | undefined = sessionId === undefined
    ? { enabled: parked === true, updatedAt: null }
    : boundMode

  // Refs keep the callbacks identity-stable across re-renders while they still
  // read the latest state.
  const modeRef = useRef(mode)
  modeRef.current = mode
  const enabledRef = useRef(mode?.enabled === true)
  enabledRef.current = mode?.enabled === true
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
    setSkillHint({ text: skillReferenceHint(SHEET_LABEL), seq: hintSeq.current })
  }, [])

  useEffect(() => {
    if (skillHint === undefined) return
    const timer = setTimeout(() => { setSkillHint(undefined) }, 4000)
    return () => { clearTimeout(timer) }
  }, [skillHint])

  useEffect(() => {
    if (sessionId === undefined) return
    // The parked toggle (chosen before this session existed) is consumed before
    // the read and applied after it settles, so a stale answer cannot overwrite
    // it.
    const parkedValue = parked === undefined ? undefined : pendingMode.consume()
    const fresh = loadedFor.current !== sessionId
    if (parkedValue === undefined && !fresh) return
    loadedFor.current = sessionId
    let cancelled = false
    if (fresh) {
      setBoundMode(undefined)
      setError(undefined)
      setNotice(undefined)
    }
    const applyParked = (enabled: boolean, previous: boolean): void => {
      setBoundMode({ enabled, updatedAt: null })
      // Only an off -> on edge seeds the skill reference (live-path rule).
      announceSkill(enabled && !previous)
      sheetModeApi.setMode(sessionId, enabled).then(
        (result) => { if (!cancelled) setBoundMode(result) },
        (cause: unknown) => {
          // The toggle was already made; a failed hand-off only reports itself.
          console.warn(`[dsh-app plugin-sheet] parked mode was not applied: ${cause instanceof Error ? cause.message : String(cause)}`)
        },
      )
    }
    sheetModeApi.mode(sessionId).then(
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
    const next = !enabledRef.current
    if (sessionId === undefined) {
      // No session to write a mode to yet: the toggle is parked for the
      // session-bound pass instead of pretended, and the capsule reports the
      // parked state until that pass applies it.
      pendingMode.set(next)
      setNotice(next ? PENDING_NOTICE : undefined)
      return
    }
    const previous = modeRef.current ?? UNLOADED_MODE
    setBusy(true)
    setError(undefined)
    setBoundMode({ enabled: next, updatedAt: null })
    announceSkill(next)
    sheetModeApi.setMode(sessionId, next).then(
      (result) => { setBoundMode(result) },
      (cause: unknown) => {
        // Optimistic flip failed: restore the pre-click value and surface why.
        setBoundMode(previous)
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
    sheetModeApi.setMode(sid, false).then(
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
    readActive: () => sheetModeApi.officeActive(),
    onSuperseded: supersede,
  })

  const state = capsuleState({ sessionBound: sessionId !== undefined, enabled: resolved.enabled, loaded })
  // The hero hint stands only while the toggle is still parked: once the
  // session-bound pass consumes it, this capsule is back to no parked value.
  const showNotice = notice !== undefined && parked !== undefined

  return (
    <>
      <span className={state.enabled ? 'dshSheetCapsule dshSheetCapsuleActive' : 'dshSheetCapsule'}>
        <button
          type="button"
          className="dshSheetCapsuleBody"
          title={state.hint}
          aria-label={state.hint}
          aria-pressed={state.enabled}
          disabled={busy}
          onClick={toggle}
        >
          <GridIcon />
          <span className="dshSheetCapsuleLabel">{state.label}</span>
        </button>
      </span>
      {error !== undefined && <span className="dshSheetCapsuleError" role="alert">{error}</span>}
      {showNotice && <span className="dshSheetCapsuleNotice" role="status">{notice}</span>}
      {skillHint !== undefined && <span className="dshSheetCapsuleNotice" role="status">{skillHint.text}</span>}
    </>
  )
})
