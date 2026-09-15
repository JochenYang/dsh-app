/**
 * The PPT capsule: one entry in the shared office bar under the composer card
 * (see client/office-bar), shown the same way in the new-session hero and in an
 * open session.
 *
 * The capsule is a toggle, not a launcher: clicking its body turns PPT mode on
 * with no template (常规主题, the neutral default) or off, and the mode is what
 * the workflow reacts to. Template choice lives behind the ▾ dropdown, which an
 * active capsule offers — it opens the same cover-preview panel as before (a
 * body-portal overlay: mask + Esc/mask close, the suite's dialog idiom) with
 * category tabs and a grid of cards showing the template's real cover preview
 * (pages/01.jpg served as a data URL by GET /templates), its name and its
 * one-line description. "使用此模板" applies and closes; "关闭 PPT 模式" stays
 * as the explicit way out, equivalent to a body toggle. A template is only ever
 * applied because the user picked it — never seeded by the turn-on itself.
 *
 * Which session the capsule acts on is read from the live session selection
 * (client.ts hands in the ui-session binding observable), not from a mount-time
 * prop: one capsule serves the hero and every session it hands over to. With no
 * session selected the toggle parks its decision in the shared pending slot and
 * the capsule reports that state honestly — the first session-bound pass applies
 * it through the same PUT, so a choice made before the session existed survives.
 *
 * The suite is mutually exclusive: the capsule polls the shared active claim
 * and closes itself when another format has superseded it (see
 * client/office-supersede), removing the chip it placed in the draft.
 *
 * Performance contract for selection: tab switches, card picks and the catalog
 * fetch live in the panel's LOCAL state — a pick is one class toggle, no
 * capsule re-render, no network. Only 使用此模板 / 关闭 PPT 模式 issue one
 * PUT /mode (applied optimistically, reverted on failure) and close the panel.
 * The capsule renders the active template as text and is memoized on its
 * props, so neither keystroke re-renders nor unrelated bar passes rebuild it.
 *
 * All copy comes from this plugin's own locale namespace (client/locales);
 * interactive elements are real buttons for keyboard use.
 *
 * @module @dsh-app/plugin-ppt/client/ppt-entry
 */

import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { HostObservable, StandardSourceBinding, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { OFFICE_ACTIVE_FORMAT } from '../office-format.ts'
import { pptModeApi } from './api.ts'
import type { ModeUpdate, ModeValue, TemplateView } from './api.ts'
import { PPT_LABEL, UNLOADED_MODE, capsuleState, resolveCapsuleMode } from './capsule-state.ts'
import { NS as PPT_NS } from './locales.ts'
import type { PptKey } from './locales.ts'
import { useOfficeSupersede } from './office-supersede.ts'
import { pendingTemplate } from './pending-template.ts'
import type { PendingPick } from './pending-template.ts'
import { applySkillReference, removeSkillReference, skillReferenceHint } from './skill-prefill.ts'
import type { SkillHintNotice } from './skill-prefill.ts'

/** The ui-session binding that follows the current session selection. */
export type SessionSource = HostObservable<StandardSourceBinding>

/**
 * The capsule's copy seat. A slot occupant receives this from the renderer's
 * standard kit; an injected host is outside that machinery, so the client
 * entry builds the same pair by hand: the namespace binding (which reads the
 * active locale at call time) plus the locale revision observable that turns a
 * language switch into a re-render of the mounted tree.
 */
export interface CapsuleSeat {
  /** Namespace-bound translate of this plugin's own dictionary. */
  readonly t: TranslateNS<typeof PPT_NS>
  /** Locale registry snapshot source (`revision` moves on every locale change). */
  readonly locale: HostObservable<{ revision: number }>
}

/** The seat's translate function, as the panel and card components take it. */
type Translate = TranslateNS<typeof PPT_NS>

/** Key of the notice shown while a decision waits for the session it will be applied to. */
const PENDING_KEY = 'capsule.pending' satisfies PptKey

/** Small inline presentation glyph for the capsule's leading cluster. */
function DeckIcon(): ReactNode {
  return (
    <svg className="dshPptCapsuleIcon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="1.5" y="2.5" width="13" height="8.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5 13.5h6M8 11v2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M5.2 8.4V5.2h1.6a1.1 1.1 0 0 1 0 2.2H5.2m1.6 0 1.2 1M9.6 5.2v3.2" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

/** Dropdown affordance of an active capsule. */
function CaretGlyph(): ReactNode {
  return (
    <svg className="dshPptCapsuleCaretIcon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.5 6.5 8 10l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
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

/**
 * The capsule's translate function for the active locale. The binding itself
 * reads the locale at call time, so subscribing to the registry revision is
 * what turns a language switch into rendered text — the same
 * (namespace, revision) rule the slot renderer applies to its `t` seat.
 */
function useTranslate(seat: CapsuleSeat): Translate {
  useSyncExternalStore(
    listener => seat.locale.subscribe(listener),
    () => seat.locale.getSnapshot().revision,
  )
  return seat.t
}

/** The selected session id, or `undefined` while no session exists. */
function sessionIdOf(binding: StandardSourceBinding): string | undefined {
  const id: unknown = binding.props.sessionId
  return typeof id === 'string' ? id : undefined
}

/** Picker tabs; categories with no templates are dropped at render time. */
const TABS: readonly { id: string, labelKey: PptKey }[] = [
  { id: 'all', labelKey: 'tab.all' },
  { id: 'business', labelKey: 'tab.business' },
  { id: 'consulting', labelKey: 'tab.consulting' },
  { id: 'work', labelKey: 'tab.work' },
  { id: 'academic', labelKey: 'tab.academic' },
  { id: 'editorial', labelKey: 'tab.editorial' },
  { id: 'promotion', labelKey: 'tab.promotion' },
]

/** One template card: real cover preview + name + one-line description. */
function TemplateCard(props: {
  template: TemplateView
  picked: boolean
  active: boolean
  t: Translate
  onPick: () => void
}): ReactNode {
  const { template, picked, active, t } = props
  const classes = picked ? 'dshPptCard dshPptCardPicked' : 'dshPptCard'
  return (
    <button
      type="button"
      className={classes}
      aria-pressed={picked}
      onClick={props.onPick}
    >
      <span className="dshPptCardFrame">
        {template.cover !== undefined
          ? <img className="dshPptCardCover" src={template.cover} alt="" loading="lazy" decoding="async" />
          : <span className="dshPptCardCover dshPptCardCoverMissing" aria-hidden="true">{t('card.noCover')}</span>}
        {(picked || active) && (
          <span className="dshPptCardBadge">{picked && !active ? t('card.picked') : t('card.active')}</span>
        )}
      </span>
      <span className="dshPptCardName">{template.name}</span>
      <span className="dshPptCardBlurb">{template.description}</span>
    </button>
  )
}

/**
 * The template-selection overlay. Tab and pick state are local on purpose:
 * they must never round-trip to the host or re-render the capsule — only
 * onApply (使用此模板) and onDisable (关闭 PPT 模式) leave the panel, once,
 * with their decision. The catalog (with cover previews) is fetched once per
 * panel open, not per keystroke.
 */
function TemplatePanel(props: {
  activeId: string | null
  initialPick: string | null
  pending: boolean
  t: Translate
  onApply: (templateId: string) => void
  onDisable: () => void
  onClose: () => void
}): ReactNode {
  const { activeId, pending, t, onApply, onDisable, onClose } = props
  const [tab, setTab] = useState('all')
  const [picked, setPicked] = useState<string | null>(props.initialPick)
  const [templates, setTemplates] = useState<readonly TemplateView[] | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    pptModeApi.templates().then(
      (value) => { if (!cancelled) setTemplates(value.templates) },
      (cause: unknown) => { if (!cancelled) setLoadError(cause instanceof Error ? cause.message : String(cause)) },
    )
    return () => { cancelled = true }
  }, [])

  const visible = templates === undefined
    ? []
    : tab === 'all' ? templates : templates.filter(template => template.category === tab)
  const countOf = (id: string): number =>
    templates === undefined ? 0 : id === 'all' ? templates.length : templates.filter(template => template.category === id).length

  return createPortal(
    <div className="dshPptOverlay" role="presentation" onClick={onClose}>
      <div
        className="dshPptPanel"
        role="dialog"
        aria-modal="true"
        aria-label={t('panel.title')}
        onClick={(event) => { event.stopPropagation() }}
      >
        <div className="dshPptPanelHeader">
          <span className="dshPptPanelTitle">{t('panel.title')}</span>
          <span className="dshPptPanelHint">{t('panel.hint')}</span>
          <button
            type="button"
            className="dshPptPanelButton dshPptPanelClose"
            onClick={onClose}
            aria-label={t('panel.closeAria')}
          >
            {t('panel.close')}
          </button>
        </div>
        <div className="dshPptTabs" role="tablist" aria-label={t('panel.tabsAria')}>
          {TABS.filter(definition => countOf(definition.id) > 0).map(definition => (
            <button
              key={definition.id}
              type="button"
              role="tab"
              aria-selected={tab === definition.id}
              className={tab === definition.id ? 'dshPptTab dshPptTabActive' : 'dshPptTab'}
              onClick={() => { setTab(definition.id) }}
            >
              {t(definition.labelKey)}
              <span className="dshPptTabCount">{countOf(definition.id)}</span>
            </button>
          ))}
        </div>
        <div className="dshPptGrid">
          {templates === undefined && loadError === undefined && (
            <span className="dshPptPanelStatus" role="status">{t('panel.loading')}</span>
          )}
          {loadError !== undefined && (
            <span className="dshPptPanelStatus dshPptPanelStatusError" role="alert">{t('panel.loadFailed', { message: loadError })}</span>
          )}
          {visible.map(template => (
            <TemplateCard
              key={template.id}
              template={template}
              picked={template.id === picked}
              active={template.id === activeId}
              t={t}
              onPick={() => { setPicked(template.id) }}
            />
          ))}
        </div>
        <div className="dshPptPanelFooter">
          {activeId !== null && (
            <button
              type="button"
              className="dshPptPanelButton dshPptPanelDisable"
              disabled={pending}
              onClick={onDisable}
            >
              {t('panel.disable')}
            </button>
          )}
          <button type="button" className="dshPptPanelButton" onClick={onClose}>{t('panel.cancel')}</button>
          <button
            type="button"
            className="dshPptPanelButton dshPptPanelButtonPrimary"
            disabled={pending || templates === undefined || picked === null}
            onClick={() => { if (picked !== null) onApply(picked) }}
          >
            {t('panel.apply')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * The capsule body: mode state, the dropdown panel, the optimistic
 * apply/disable path and the pending hand-off to the first real session.
 * Memoized so parent renders never rebuild it.
 *
 * The session id is read reactively; when it is absent the capsule stands for
 * the new-session hero and the toggle parks its decision instead of pretending
 * a mode was stored. The parked decision is what the capsule reports until the
 * session-bound pass consumes it and applies it through the same PUT as a live
 * pick. Turning the mode on never seeds a template: the neutral 常规主题 is the
 * default, and only an explicit pick applies one.
 */
export const PptOfficeEntry = memo(function PptOfficeEntry(props: {
  sessionSource: SessionSource
  seat: CapsuleSeat
}): ReactNode {
  const binding = useSessionBinding(props.sessionSource)
  const t = useTranslate(props.seat)
  const sessionId = sessionIdOf(binding)

  // undefined = not loaded yet; the capsule still renders (inactive state).
  const [boundMode, setBoundMode] = useState<ModeValue | undefined>(undefined)
  const [panelOpen, setPanelOpen] = useState(false)
  // Last template the user picked, for the panel's highlight; null = none yet.
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<PptKey | undefined>(undefined)
  // id → display name, from the light (cover-less) catalog fetch.
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map())
  // The only trace of a turn-on that could not seed the skill reference (the
  // draft already held text); it clears itself so it never becomes clutter.
  const [skillHint, setSkillHint] = useState<{ notice: SkillHintNotice, seq: number } | undefined>(undefined)
  const hintSeq = useRef(0)

  // With no session the parked decision *is* the mode, and both the hero and
  // the session that follows re-render when the slot changes.
  const parkedPick = useSyncExternalStore(pendingTemplate.subscribe, pendingTemplate.get)
  const mode: ModeValue | undefined = sessionId === undefined
    ? parkedPick === undefined
      ? { enabled: false, template: null, updatedAt: null }
      : { enabled: true, template: parkedPick.template, updatedAt: null }
    : boundMode

  // Refs keep the callbacks (and so the memoized panel's props)
  // identity-stable across re-renders.
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
    setSkillHint({ notice: skillReferenceHint(PPT_LABEL), seq: hintSeq.current })
  }, [])

  useEffect(() => {
    if (skillHint === undefined) return
    const timer = setTimeout(() => { setSkillHint(undefined) }, 4000)
    return () => { clearTimeout(timer) }
  }, [skillHint])

  // Name-only catalog for the capsule label; the panel fetches covers itself.
  useEffect(() => {
    let cancelled = false
    pptModeApi.templates({ covers: false }).then(
      (value) => {
        if (cancelled) return
        setNames(new Map(value.templates.map(template => [template.id, template.name])))
      },
      () => { /* the capsule falls back to the raw id — never a blocker */ },
    )
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (sessionId === undefined) return
    // The parked pick (chosen before this session existed) is consumed before
    // the read and applied after it settles, so a stale answer cannot
    // overwrite it.
    const parked = parkedPick === undefined ? undefined : pendingTemplate.consume()
    const fresh = loadedFor.current !== sessionId
    if (parked === undefined && !fresh) return
    loadedFor.current = sessionId
    let cancelled = false
    if (fresh) {
      setBoundMode(undefined)
      setError(undefined)
      setPanelOpen(false)
    }
    const applyParked = (pick: PendingPick, previous: ModeValue): void => {
      setBoundMode({ enabled: true, template: pick.template, updatedAt: null })
      if (pick.template !== null) setSelected(pick.template)
      // Same rule as the live path: only an off -> on edge seeds the skill
      // reference, so applying a parked template to a session that already had
      // the mode on is a template change, not a turn-on.
      announceSkill(!previous.enabled)
      pptModeApi.setMode(sessionId, { enabled: true, template: pick.template }).then(
        (result) => { if (!cancelled) setBoundMode(result) },
        (cause: unknown) => {
          // The pick was already made; a failed hand-off only reports itself.
          console.warn(`[dsh-app plugin-ppt] parked template was not applied: ${cause instanceof Error ? cause.message : String(cause)}`)
        },
      )
    }
    pptModeApi.mode(sessionId).then(
      (value) => {
        if (cancelled) return
        setBoundMode(value)
        if (value.template !== null) setSelected(value.template)
        if (parked !== undefined) applyParked(parked, value)
      },
      () => { if (!cancelled) setBoundMode(undefined) },
    )
    return () => { cancelled = true }
  }, [sessionId, parkedPick])

  /**
   * Apply one mode update: parked on the hero (the session-bound pass applies
   * it), or persisted optimistically with a revert on failure in a session.
   */
  const applyMode = useCallback((update: ModeUpdate): void => {
    if (sessionId === undefined) {
      // No session to write a mode to yet: the decision is parked for the
      // session-bound pass instead of pretended. A turn-off just clears the
      // slot — the session default is already off.
      if (update.enabled) {
        pendingTemplate.set({ template: update.template })
        if (update.template !== null) setSelected(update.template)
        setNotice(PENDING_KEY)
      } else {
        pendingTemplate.clear()
        setNotice(undefined)
      }
      setPanelOpen(false)
      return
    }
    const current = modeRef.current
    if (busyRef.current) return
    const wasEnabled = current?.enabled === true
    setBusy(true)
    setError(undefined)
    setBoundMode({ ...update, updatedAt: null })
    // A template pick on an already-active capsule is not a turn-on, so only
    // the off → on edge seeds the skill reference.
    announceSkill(update.enabled && !wasEnabled)
    pptModeApi.setMode(sessionId, update).then(
      (result) => {
        setBoundMode(result)
        setPanelOpen(false)
      },
      (cause: unknown) => {
        // Optimistic flip failed: restore the pre-click state and surface why.
        setBoundMode(current ?? UNLOADED_MODE)
        setError(cause instanceof Error ? cause.message : String(cause))
      },
    ).finally(() => {
      setBusy(false)
    })
  }, [sessionId, announceSkill])

  const openPanel = useCallback(() => { setPanelOpen(true) }, [])
  const closePanel = useCallback(() => { setPanelOpen(false) }, [])
  const applyPicked = useCallback((templateId: string) => {
    setSelected(templateId)
    applyMode({ enabled: true, template: templateId })
  }, [applyMode])
  const disableMode = useCallback(() => { applyMode({ enabled: false, template: null }) }, [applyMode])

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
    setBoundMode({ enabled: false, template: null, updatedAt: null })
    removeSkillReference(bindingRef.current)
    pptModeApi.setMode(sid, { enabled: false, template: null }).then(
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
    readActive: () => pptModeApi.officeActive(),
    onSuperseded: supersede,
  })

  const state = capsuleState({
    sessionBound: sessionId !== undefined,
    enabled: resolved.enabled,
    template: resolved.template,
    name: resolved.template === null ? undefined : names.get(resolved.template) ?? resolved.template,
  })
  // The toggle reads the latest state through a ref so its identity stays
  // stable while the state it decides on does not.
  const stateRef = useRef(state)
  stateRef.current = state
  const toggle = useCallback((): void => {
    const current = stateRef.current
    applyMode({ enabled: current.toggle.enabled, template: null })
  }, [applyMode])

  // The hero hint stands only while the decision is still parked: once the
  // session-bound pass consumes it, this capsule is back to no decision.
  const parkedNotice = notice !== undefined && parkedPick !== undefined ? notice : undefined
  const hint = state.enabled
    ? t('capsule.hintActive', { label: state.label })
    : sessionId === undefined || !loaded ? t('capsule.hintParked') : t('capsule.hintIdle')

  return (
    <>
      <span className={state.enabled ? 'dshPptCapsule dshPptCapsuleActive' : 'dshPptCapsule'}>
        <button
          type="button"
          className="dshPptCapsuleBody"
          title={hint}
          aria-pressed={state.enabled}
          disabled={busy}
          onClick={toggle}
        >
          <DeckIcon />
          <span className="dshPptCapsuleLabel">{state.label}</span>
        </button>
        {state.caret && (
          <button
            type="button"
            className="dshPptCapsuleCaret"
            title={t('capsule.templateAria')}
            aria-label={t('capsule.templateAria')}
            aria-haspopup="dialog"
            aria-expanded={panelOpen}
            disabled={busy}
            onClick={openPanel}
          >
            <CaretGlyph />
          </button>
        )}
      </span>
      {error !== undefined && <span className="dshPptCapsuleError" role="alert">{error}</span>}
      {parkedNotice !== undefined && <span className="dshPptCapsuleNotice" role="status">{t(parkedNotice)}</span>}
      {skillHint !== undefined && <span className="dshPptCapsuleNotice" role="status">{t(skillHint.notice.key, skillHint.notice.params)}</span>}
      {panelOpen && (
        <TemplatePanel
          activeId={resolved.enabled ? resolved.template : null}
          initialPick={selected}
          pending={busy}
          t={t}
          onApply={applyPicked}
          onDisable={disableMode}
          onClose={closePanel}
        />
      )}
    </>
  )
})
