/**
 * One provider's page: its model list and its advanced configuration, saved as a
 * single unit.
 *
 * Division of labour with the official Models page is deliberate and unchanged:
 * that page owns provider CRUD, credentials, the endpoint, the model-list
 * membership of a catalog route, and a declared route's `api`. This page owns
 * what is left — a declared route's model rows (with the full per-model field
 * set), `modelOverrides` on a catalog route, and the route's advanced parameters.
 * It writes under the route's own settings path through path-addressed
 * `settings.mutate` ops, with `expectedRevision` fencing concurrent edits.
 *
 * Two addressing modes, because the adapter makes them mutually exclusive:
 *  - `models` — the route owns a full model list (hand-declared routes, or a
 *    catalog route whose list the user already took over). Edits are whole-list:
 *    the array is one `set` op, exactly how the official editor writes.
 *  - `overrides` — per-id tweaks over the installed catalog. Adding an id the
 *    catalog does not carry would be rejected at resolve time, so this page never
 *    invents one: a model outside the catalog belongs to the provider the
 *    official page creates.
 *
 * One Save writes both halves. Every op names one of this route's paths, so the
 * conflict path is the same for either half: reload for a fresh revision and
 * re-apply once, keeping the draft if a second conflict says two surfaces are
 * editing at the same time.
 *
 * The layout follows the source design: one card, its header, a body of labelled
 * fields, and the advanced block as a full-bleed band above the footer.
 *
 * @module @dsh-app/plugin-client-ui/client/models-advanced/provider-detail
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { Button, Input, Menu, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { defaultReasoningEfforts, formatCapacity, getPath, modelRowFailure } from './fields.ts'
import type { ModelDraft } from './fields.ts'
import { enrichDraftsFromModelsDev, fetchModelsDev } from './models-dev.ts'
import { ModelDialog } from './model-dialog.tsx'
import { ModelsDevImportDialog } from './import-dialog.tsx'
import { ProviderModelDiscoveryDialog } from './provider-discovery.tsx'
import type { ProviderDiscoveryTarget } from './provider-discovery.tsx'
import { ProviderMark, iconForProvider } from './provider-mark.tsx'
import { ProviderListPage, summarizeRoute } from './provider-list.tsx'
import type { ProviderSummary } from './provider-list.tsx'
import { message, messageText, wireText } from './messages.ts'
import type { PageMessage, Translate } from './messages.ts'
import { configuredRouteCount, RouteAdvancedFields, useRouteAdvancedDraft } from './route-advanced.tsx'
import { normalizeManaged, routeOps } from './route-fields.ts'
import { probeModel } from './probe.ts'
import { messageOf, writeOps } from './store.ts'
import { credentialRefs } from './store.ts'
import type { AdvancedModelsRemote, AdvancedModelsStore, AdvancedModelsState, RouteRow } from './store.ts'
import { IconArrowLeft, IconChevron, IconInfo, IconMore, IconPencil, IconPlug, IconPlus, IconSpinner, IconTrash } from './icons.tsx'

/** The override value this page would write: the row minus its display id. */
function overrideFields(row: ModelDraft): Record<string, unknown> {
  const { id: _drop, ...fields } = row
  return fields
}

/** Merge imported rows by model id while keeping manual blank rows intact. */
function mergeModelRows(existing: readonly ModelDraft[], additions: readonly ModelDraft[]): ModelDraft[] {
  const next = [...existing]
  const positions = new Map<string, number>()
  next.forEach((model, index) => {
    const id = typeof model.id === 'string' ? model.id.trim() : ''
    if (id !== '') positions.set(id, index)
  })
  for (const model of additions) {
    const id = typeof model.id === 'string' ? model.id.trim() : ''
    const position = id === '' ? undefined : positions.get(id)
    if (position === undefined) {
      if (id !== '' && typeof model.id === 'string' && model.id !== id) {
        next.push({ ...model, id })
      } else {
        next.push(model)
      }
      if (id !== '') positions.set(id, next.length - 1)
    } else {
      next[position] = model
    }
  }
  return next
}

/** Which dialog is open, if any. */
type DialogState =
  | { readonly kind: 'add' }
  | { readonly kind: 'model'; readonly index: number }
  | { readonly kind: 'override'; readonly id: string }
  | null

/** Props of {@link ProviderListSection}. */
export interface ProviderListSectionProps {
  readonly t: Translate
  readonly state: AdvancedModelsState
  /** Resolved profile at one settings path, for display. */
  readonly profileAt: (settingsPath: readonly string[]) => Record<string, unknown>
  readonly onOpen: (route: string) => void
  readonly onAdd: () => void
  readonly onRefresh: () => void
  /** Pinned route ids, in pin order. */
  readonly pins: readonly string[]
  readonly onTogglePin: (route: string) => void
}

/**
 * Render the list level from a page snapshot.
 * @param props - see {@link ProviderListSectionProps}.
 * @returns the list page.
 */
export function ProviderListSection(props: ProviderListSectionProps): ReactNode {
  const { t, state, profileAt, onOpen, onAdd, onRefresh, pins, onTogglePin } = props
  const rows: ProviderSummary[] = state.routes.map(
    row => summarizeRoute(row, profileAt(row.entry.settingsPath)),
  )
  return (
    <ProviderListPage
      t={t}
      rows={rows}
      loading={state.status === 'idle' || (state.status === 'loading' && state.routes.length === 0)}
      readOnly={!state.writable}
      error={state.status === 'error' ? state.error ?? '' : undefined}
      refreshing={state.status === 'loading' && state.routes.length > 0}
      onOpen={onOpen}
      onAdd={onAdd}
      onRefresh={onRefresh}
      pins={pins}
      onTogglePin={onTogglePin}
    />
  )
}

/** Props of {@link ProviderDetail}. */
export interface ProviderDetailProps {
  readonly t: Translate
  /** The route being edited. */
  readonly row: RouteRow
  /** The row's display summary (header only). */
  readonly summary: ProviderSummary
  /** The page's Remote face. */
  readonly api: AdvancedModelsRemote
  /** The page's store, for the reload after a conflict. */
  readonly controller: AdvancedModelsStore
  /** Whether the settings source accepts writes. */
  readonly writable: boolean
  /** Whether models belong to the user layer (or only overrides do). */
  readonly inModelsMode: boolean
  /** The user-layer `models` array as loaded (undefined when unowned). */
  readonly baseModels: readonly ModelDraft[] | undefined
  /** The user-layer `modelOverrides` object as loaded. */
  readonly baseOverrides: Readonly<Record<string, ModelDraft>>
  /** Resolved wire protocol of the route, for the compat filter. */
  readonly routeApi: string | undefined
  /** Resolved profile of the route (the discovery target reads it). */
  readonly resolvedProfile: Record<string, unknown>
  /** The route namespace's view (revision for the write fence). */
  readonly namespace: SettingsNamespaceView | undefined
  /** A message to show as soon as the page mounts (a key write that failed
   *  after the provider itself was created). */
  readonly startupNotice?: PageMessage
  /** Back to the list; the caller decides whether a dirty draft may leave. */
  readonly onBack: () => void
  /** The draft became dirty or clean (drives the leave confirmation). */
  readonly onDirtyChange: (dirty: boolean) => void
  /** The provider was removed; the page is gone. */
  readonly onDeleted: () => void
}

/**
 * Render one provider's page.
 * @param props - see {@link ProviderDetailProps}.
 * @returns the detail page.
 */
export function ProviderDetail(props: ProviderDetailProps): ReactNode {
  const {
    t, row, summary, api, controller, writable, inModelsMode,
    baseModels, baseOverrides, routeApi, resolvedProfile, namespace,
    startupNotice, onBack, onDirtyChange, onDeleted,
  } = props

  const routeDraft = useRouteAdvancedDraft(row, api, row.entry.nativeAuthEnv)
  const [modelsDraft, setModelsDraft] = useState<readonly ModelDraft[] | undefined>(undefined)
  const [overridesDraft, setOverridesDraft] = useState<Record<string, ModelDraft> | undefined>(undefined)
  const [dialog, setDialog] = useState<DialogState>(null)
  const [overrideDraftId, setOverrideDraftId] = useState('')
  // The LIVE model catalog, fetched once for the override suggestions. Which
  // models a route serves right now is what the chat's own picker lists, so it is
  // the only honest source for "the model I want to correct".
  const [catalogIds, setCatalogIds] = useState<readonly string[]>([])
  useEffect(() => {
    let live = true
    void api.session.modelCatalog().then(
      (response) => {
        if (!live || !response.ok) return
        const group = response.value.groups.find(candidate => candidate.id === row.entry.provider)
        const ids = (group === undefined ? response.value.groups : [group])
          .flatMap(item => item.models.map(model => model.id))
        setCatalogIds(ids)
      },
      () => { /* the picker stays free-text */ },
    )
    return () => { live = false }
  }, [api, row.entry.provider])

  const [busy, setBusy] = useState(false)
  const [enrichBusy, setEnrichBusy] = useState(false)
  /** Bumped on every model-draft edit, so an async enrich can tell whether the
   *  list it started from is still the list on screen. */
  const draftEpoch = useRef(0)
  const [failure, setFailure] = useState<PageMessage | undefined>(startupNotice)
  const [notice, setNotice] = useState<PageMessage | undefined>(undefined)
  const [modelsDevOpen, setModelsDevOpen] = useState(false)
  const [discoveryOpen, setDiscoveryOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [providerMenuOpen, setProviderMenuOpen] = useState(false)
  const [askDelete, setAskDelete] = useState(false)
  /** A new key typed into this page, or undefined when untouched. */
  const [keyDraft, setKeyDraft] = useState<string | undefined>(undefined)
  /** The user asked to clear the stored key on the next save. */
  const [keyCleared, setKeyCleared] = useState(false)
  /** A key write that landed this session, so the badge stops reading the
   *  pre-save credential status. */
  const [keyStatus, setKeyStatus] = useState<boolean | undefined>(undefined)
  const [advancedOpen, setAdvancedOpen] = useState(() => configuredRouteCount(routeDraft.working) > 0)
  /** The model id whose probe is in flight. */
  const [testing, setTesting] = useState<string | undefined>(undefined)
  /** The last probe's result; it clears itself after a few seconds. */
  const [testResult, setTestResult] = useState<
    { model: string; ok: boolean; latency?: number; failure?: PageMessage } | undefined
  >(undefined)
  useEffect(() => {
    if (testResult === undefined) return undefined
    const timer = setTimeout(() => { setTestResult(undefined) }, 6000)
    return () => { clearTimeout(timer) }
  }, [testResult])

  const models = modelsDraft ?? baseModels ?? []
  const overrides = overridesDraft ?? baseOverrides
  const disabled = !writable || busy
  /** Every reference this route authenticates with: its own variable first,
   *  then the adapter's native-auth lookup list. */
  const routeCredentialRefs = credentialRefs(row.entry, resolvedProfile)
  const credentialRef = routeCredentialRefs[0]
  const keyDirty = (keyDraft !== undefined && keyDraft !== '') || keyCleared
  const keyConfigured = keyCleared
    ? false
    : keyDraft !== undefined && keyDraft !== ''
      ? true
      : keyStatus ?? routeDraft.credential?.configured === true
  const modelIds = useMemo(
    () => new Set(models.map(model => typeof model.id === 'string' ? model.id : '')),
    [models],
  )
  const overrideIds = Object.keys(overrides)

  const rowsFailure = useMemo(() => {
    if (inModelsMode) {
      // Row validation first: the adapter's own validator would reject bad
      // rows with its English diagnostic, one model per attempt — the exact
      // trap this page exists to prevent.
      const seen = new Set<string>()
      for (const model of models) {
        const modelApi = typeof model.api === 'string' && model.api !== ''
          ? model.api
          : routeApi
        const text = modelRowFailure(model, seen, modelApi)
        if (text !== undefined) return text
        seen.add(typeof model.id === 'string' ? model.id : '')
      }
      return undefined
    }
    for (const [id, value] of Object.entries(overrides)) {
      // Override rows address a catalog id by key; a row that sets nothing
      // would write a meaningless empty object into settings.yaml.
      if (Object.keys(overrideFields(value)).length === 0) return message('adv.failure.overrideEmpty', { id })
      const text = modelRowFailure({ ...value, id }, new Set(), routeApi, 'override')
      if (text !== undefined) return text
    }
    return undefined
  }, [inModelsMode, models, overrides, routeApi])

  const modelsChanged = modelsDraft !== undefined
    && JSON.stringify(models) !== JSON.stringify(baseModels ?? [])
  const overridesChanged = overridesDraft !== undefined
    && JSON.stringify(overrides) !== JSON.stringify(baseOverrides)
  const dirty = routeDraft.touched.size > 0 || modelsChanged || overridesChanged || keyDirty
  const canSave = dirty
    && (keyDirty
      || (inModelsMode ? modelsChanged || routeDraft.touched.size > 0 : overridesChanged || routeDraft.touched.size > 0))

  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])

  // A notice describes the save that produced it; the next edit makes it stale.
  useEffect(() => {
    if (dirty) setNotice(undefined)
  }, [dirty])

  /** Any model-draft edit invalidates an in-flight models.dev enrich. */
  const writeModels = (next: readonly ModelDraft[] | undefined): void => {
    draftEpoch.current += 1
    setModelsDraft(next)
  }

  const resetDrafts = (): void => {
    writeModels(undefined)
    setOverridesDraft(undefined)
    routeDraft.reset()
    setKeyDraft(undefined)
    setKeyCleared(false)
    setKeyStatus(undefined)
    setFailure(undefined)
    setNotice(undefined)
  }

  /** Send one model to the host probe and keep its result on the row. */
  const runTest = async (model: string): Promise<void> => {
    if (disabled || model === '' || testing !== undefined) return
    setTesting(model)
    setTestResult(undefined)
    const outcome = await probeModel(row.entry.provider, model)
    setTesting(undefined)
    setTestResult({ model, ...outcome })
  }

  /** Remove the user's profile of this provider; the stored key is kept. */
  const removeProvider = async (): Promise<void> => {
    if (namespace === undefined || row.userProfile === undefined) {
      setAskDelete(false)
      return
    }
    setBusy(true)
    const baseline = JSON.stringify(row.userProfile)
    const ops: SettingsPathOpView[] = [{ op: 'unset', path: [...row.entry.settingsPath] }]
    let outcome = await writeOps(api, ops, namespace.revision)
    if (outcome.kind === 'conflict') {
      await controller.load()
      const snapshot = controller.store.getSnapshot()
      const revision = snapshot.namespaces.get(row.entry.settingsNs)?.revision
      const freshRow = snapshot.routes.find(candidate => candidate.entry.provider === row.entry.provider)
      if (revision === undefined
        || (freshRow !== undefined && JSON.stringify(freshRow.userProfile) !== baseline)) {
        // Someone edited this provider meanwhile; a blind unset would discard
        // their work, so the user has to look at it first.
        setBusy(false)
        setFailure(message('adv.failure.conflictRetained'))
        return
      }
      outcome = await writeOps(api, ops, revision)
    }
    setAskDelete(false)
    setBusy(false)
    if (outcome.kind !== 'ok') {
      setFailure(outcome.kind === 'conflict' ? message('adv.failure.conflictRetained') : outcome.message)
      return
    }
    // The credential is deliberately kept: the adapter may still declare this
    // route (a shipped one), another provider may name the same variable, and a
    // stale snapshot cannot tell those apart. Clearing it is the provider
    // page's explicit action, not a side effect of deleting the profile.
    await controller.load()
    onDeleted()
  }

  /** Save the route's edits as path ops against the stored user layer. */
  const save = async (): Promise<void> => {
    if (namespace === undefined || rowsFailure !== undefined) return
    const normalized = normalizeManaged(routeDraft.working)
    if (!normalized.ok) {
      setFailure(normalized.failure)
      return
    }
    setBusy(true)
    setFailure(undefined)
    setNotice(undefined)
    const path = [...row.entry.settingsPath]
    const ops: SettingsPathOpView[] = routeOps(path, normalized.draft, routeDraft.touched)
    if (inModelsMode) {
      // Only a changed list is written: a save that touched an advanced field
      // alone must not restate the whole models array from a view that never
      // edited it.
      if (modelsChanged) {
        if (models.length === 0) {
          // An emptied list restores inheritance on a catalog route; a
          // hand-declared route has nothing to inherit and would serve nothing.
          if (row.entry.declared === true) {
            setFailure(message('adv.failure.declaredNeedsModel'))
            setBusy(false)
            return
          }
          ops.push({ op: 'unset', path: [...path, 'models'] })
        } else {
          ops.push({ op: 'set', path: [...path, 'models'], value: models as JsonValue })
        }
      }
    } else {
      for (const id of Object.keys(baseOverrides)) {
        if (!(id in overrides)) ops.push({ op: 'unset', path: [...path, 'modelOverrides', id] })
      }
      for (const [id, value] of Object.entries(overrides)) {
        const fields = overrideFields(value)
        // Compare like-for-like (the stored value never carries `id`); an
        // emptied override unsets rather than writing `{}`.
        const comparable = Object.keys(fields).length === 0 ? undefined : fields
        if (JSON.stringify(baseOverrides[id]) !== JSON.stringify(comparable)) {
          if (comparable === undefined) ops.push({ op: 'unset', path: [...path, 'modelOverrides', id] })
          else ops.push({ op: 'set', path: [...path, 'modelOverrides', id], value: fields as JsonValue })
        }
      }
    }
    if (ops.length === 0 && !keyDirty) {
      setNotice(message('adv.notice.noChanges'))
      setBusy(false)
      return
    }
    // Values the write is about to replace, keyed by the op's path inside this
    // route. A conflict retry re-applies the ops against a fresh revision, so
    // this snapshot is what tells "unrelated write" from "someone edited the
    // same models list" — the latter must keep the draft and ask.
    const relative = (op: SettingsPathOpView): readonly string[] => op.path.slice(path.length)
    const baseline = ops.map(op => JSON.stringify(getPath(row.userProfile, relative(op))))
    let outcome: Awaited<ReturnType<typeof writeOps>> | undefined
    if (ops.length > 0) {
      outcome = await writeOps(api, ops, namespace.revision)
      if (outcome.kind === 'conflict') {
        // Another surface wrote first. Re-apply only when none of the paths this
        // write names changed; otherwise the retry would silently overwrite the
        // concurrent edit (a whole-list `models` set is the dangerous case).
        await controller.load()
        const snapshot = controller.store.getSnapshot()
        const revision = snapshot.namespaces.get(row.entry.settingsNs)?.revision
        const freshRow = snapshot.routes.find(candidate => candidate.entry.provider === row.entry.provider)
        if (revision === undefined) {
          setBusy(false)
          setFailure(message('adv.failure.conflictRetained'))
          return
        }
        const changed = ops.some((op, index) =>
          JSON.stringify(getPath(freshRow?.userProfile, relative(op))) !== baseline[index])
        if (changed) {
          setBusy(false)
          setFailure(message('adv.failure.conflictRetained'))
          return
        }
        outcome = await writeOps(api, ops, revision)
        if (outcome.kind === 'conflict') {
          setBusy(false)
          setFailure(message('adv.failure.conflictRetained'))
          return
        }
      }
      if (outcome.kind === 'failure') {
        setBusy(false)
        setFailure(outcome.message)
        return
      }
    }
    // The profile landed. The key lives in a different service, so its write is
    // reported on its own: a failure here does not mean the settings are lost,
    // and the typed key stays in the field so the next save retries it. The
    // target ref is the one THIS save wrote, not the pre-save profile's.
    // `busy` stays true through this await: the key field and the Save button
    // are disabled while it runs, so a completion cannot clear a newer draft.
    const keyTarget = typeof normalized.draft.apiKeyEnv === 'string' && normalized.draft.apiKeyEnv.trim() !== ''
      ? normalized.draft.apiKeyEnv.trim()
      : credentialRef
    let keyFailure: PageMessage | undefined
    if (keyTarget !== undefined && keyDirty) {
      try {
        const written = keyCleared
          ? await api.credentials.unset(keyTarget)
          : await api.credentials.set(keyTarget, keyDraft ?? '')
        if (!written.ok) keyFailure = message('adv.key.saveFailed', { message: written.error.message })
        else setKeyStatus(!keyCleared)
      } catch (error) {
        keyFailure = message('adv.key.saveFailed', { message: messageOf(error) })
      }
    }
    writeModels(undefined)
    setOverridesDraft(undefined)
    routeDraft.reset()
    if (keyFailure === undefined) {
      setKeyDraft(undefined)
      setKeyCleared(false)
      setNotice(message('adv.notice.saved'))
    } else {
      setFailure(keyFailure)
    }
    // The page's snapshot is what the list re-renders from, so the reload is
    // the only refresh needed.
    await controller.load()
    setBusy(false)
  }

  /**
   * Gap-fill missing fields (especially reasoningEfforts) from models.dev by
   * model id. Hand-declared routes have no catalog inherit, so this is how a
   * batch of discovered/copied ids gets xhigh/max and the rest without a
   * per-row manual enable. Pass `explicitRows` when the caller just set a
   * draft this render has not seen yet (discovery adopt).
   */
  const enrich = async (explicitRows?: readonly ModelDraft[]): Promise<void> => {
    const source = explicitRows ?? models
    const ids = source.filter(model => typeof model.id === 'string' && model.id.trim() !== '')
    if (ids.length === 0) {
      setNotice(message('adv.notice.noIdsToEnrich'))
      return
    }
    setEnrichBusy(true)
    setFailure(undefined)
    setNotice(undefined)
    const epoch = draftEpoch.current
    try {
      const providers = await fetchModelsDev()
      if (draftEpoch.current !== epoch) {
        // The list was edited, cleared or saved while models.dev was answering;
        // applying that answer now would resurrect rows the user just removed.
        setNotice(message('adv.notice.enrichDiscarded'))
        return
      }
      const result = enrichDraftsFromModelsDev(providers, source, row.entry.provider)
      draftEpoch.current += 1
      setModelsDraft(result.drafts)
      const separator = t('adv.list.separator')
      if (result.filled.length === 0) {
        // Only the first eight misses are listed, and the trailing ellipsis
        // belongs to the value (it marks the cut), not to the sentence.
        const listed = result.missing.slice(0, 8).join(separator)
        setNotice(result.missing.length > 0
          ? message('adv.notice.notInModelsDev', {
            ids: result.missing.length > 8 ? `${listed}…` : listed,
          })
          : message('adv.notice.nothingToEnrich'))
      } else {
        const listed = result.missing.slice(0, 5).join(separator)
        setNotice(result.missing.length > 0
          ? message('adv.notice.enrichedWithMissing', { count: result.filled.length, ids: `${listed}…` })
          : message('adv.notice.enriched', { count: result.filled.length }))
      }
    } catch (error) {
      setFailure(wireText(messageOf(error)))
    } finally {
      setEnrichBusy(false)
    }
  }

  const discoveryTarget: ProviderDiscoveryTarget = {
    settingsNs: row.entry.settingsNs,
    provider: row.entry.provider,
    ...(typeof resolvedProfile.baseURL === 'string' ? { baseURL: resolvedProfile.baseURL } : {}),
    ...(typeof resolvedProfile.api === 'string' ? { api: resolvedProfile.api } : {}),
  }

  const adoptDiscovered = (rows: readonly ModelDraft[]): void => {
    const merged = mergeModelRows(models, rows)
    writeModels(merged)
    // Discovery only returns id/name/capacities — enrich reasoning etc.
    void enrich(merged)
  }

  const removeOverride = (id: string): void => {
    const next = { ...overrides }
    delete next[id]
    setOverridesDraft(next)
  }

  const openOverride = (id: string): void => {
    const next = id.trim()
    if (next === '') return
    setOverrideDraftId('')
    // The row joins the draft only when the dialog applies: an override that
    // sets nothing is not writable, and a cancel must not leave one behind.
    setDialog({ kind: 'override', id: next })
  }

  const dialogProps = (() => {
    if (dialog === null) return undefined
    if (dialog.kind === 'add') {
      return {
        title: t('adv.models.addTitle'),
        row: row.entry.declared === true
          ? { id: '', ...(defaultReasoningEfforts() as ModelDraft) }
          : { id: '' },
        lockedId: false,
        handDeclared: row.entry.declared === true,
      }
    }
    if (dialog.kind === 'model') {
      return {
        title: t('adv.models.editTitle'),
        row: models[dialog.index] ?? { id: '' },
        lockedId: false,
        handDeclared: row.entry.declared === true,
      }
    }
    return {
      title: t('adv.overrides.editTitle'),
      row: { ...(overrides[dialog.id] ?? {}), id: dialog.id },
      lockedId: true,
      handDeclared: false,
    }
  })()

  const applyDialog = (edited: ModelDraft): void => {
    if (dialog === null) return
    if (dialog.kind === 'add') {
      writeModels([...models, edited])
    } else if (dialog.kind === 'model') {
      writeModels(models.map((model, at) => at === dialog.index ? edited : model))
    } else {
      setOverridesDraft({ ...overrides, [dialog.id]: overrideFields(edited) })
    }
    setDialog(null)
  }

  const overrideCandidateIds = catalogIds.filter(id => !(id in overrides))
  const count = inModelsMode ? models.length : overrideIds.length
  const advancedCount = configuredRouteCount(routeDraft.working)

  return (
    <div className="dshAma-view">
      <button type="button" className="dshAma-backBtn" onClick={onBack}>
        <IconArrowLeft />
        <span>{t('adv.detail.back')}</span>
      </button>

      <section className="dshAma-card" aria-label={summary.displayName}>
        <header className="dshAma-cardHead">
          <ProviderMark iconKey={iconForProvider(summary)} label={summary.displayName} size={30} />
          <div className="dshAma-titleBlock">
            <span className="dshAma-title">
              <span className="dshAma-titleText">{summary.displayName}</span>
            </span>
            <div className="dshAma-providerMeta">
              <span className="dshAma-mono">{summary.route}</span>
              <span className="dshAma-metaDot" aria-hidden="true" />
              <span>
                {inModelsMode
                  ? t('adv.detail.modelCount', { count })
                  : t('adv.detail.overrideCount', { count })}
              </span>
              {summary.api === undefined ? null : (
                <>
                  <span className="dshAma-metaDot" aria-hidden="true" />
                  <span>{summary.api}</span>
                </>
              )}
              <span className="dshAma-tag">
                {summary.declared ? t('adv.info.declared') : t('adv.info.catalog')}
              </span>
              {summary.active ? null : <span className="dshAma-tag">{t('adv.info.inactive')}</span>}
            </div>
          </div>
          <Menu
            open={providerMenuOpen}
            onClose={() => { setProviderMenuOpen(false) }}
            align="end"
            items={[{ id: 'delete', label: t('adv.detail.delete'), danger: true, disabled: disabled || row.userProfile === undefined }]}
            onSelect={(id) => {
              setProviderMenuOpen(false)
              if (id === 'delete') setAskDelete(true)
            }}
            anchor={(
              <Tooltip label={t('adv.detail.actions')} align="end" side="bottom">
                <Button
                  type="button" variant="ghost" size="sm"
                  className="dshAma-iconAction"
                  icon={<IconMore />}
                  aria-label={t('adv.detail.actions')}
                  aria-haspopup="menu"
                  aria-expanded={providerMenuOpen}
                  disabled={disabled}
                  onClick={() => { setProviderMenuOpen(open => !open) }}
                />
              </Tooltip>
            )}
          />
        </header>

        <div className="dshAma-cardBody">
          {summary.baseURL === undefined ? null : (
            <div className="dshAma-field">
              <span className="dshAma-fieldLabel">Base URL</span>
              <Tooltip label={summary.baseURL} onlyWhenClipped>
                <span className="dshAma-readonly dshAma-mono">{summary.baseURL}</span>
              </Tooltip>
            </div>
          )}

          <div className="dshAma-field">
            <div className="dshAma-fieldHead">
              <span className="dshAma-fieldLabel dshAma-fieldLabelInline">
                {t('adv.key.label')}
                <span className={keyConfigured ? 'dshAma-keyState is-on' : 'dshAma-keyState'}>
                  <span className="dshAma-keyDot" aria-hidden="true" />
                  {keyConfigured ? t('adv.key.configured') : t('adv.key.missing')}
                </span>
              </span>
              {credentialRef === undefined || !keyConfigured
                ? null
                : (
                  <button
                    type="button" className="dshAma-linkBtn"
                    disabled={disabled}
                    onClick={() => { setKeyDraft(''); setKeyCleared(true) }}
                  >{t('adv.key.clear')}</button>
                )}
            </div>
            <Input
              className="dshAma-inputWrap"
              type="password"
              value={keyDraft ?? ''}
              placeholder={t('adv.key.placeholder')}
              aria-label={t('adv.key.label')}
              disabled={disabled || credentialRef === undefined}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => { setKeyDraft(event.target.value); setKeyCleared(false) }}
            />
            <span className="dshAma-fieldHint">
              {credentialRef === undefined ? t('adv.key.noRef') : t('adv.key.setHint')}
            </span>
          </div>

          <div className="dshAma-field">
            <div className="dshAma-fieldHead">
              <span className="dshAma-fieldLabel dshAma-fieldLabelInline">
                {inModelsMode ? t('adv.models.title') : t('adv.overrides.title')}
                <span className="dshAma-count">{count}</span>
              </span>
              <div className="dshAma-fieldHeadActions">
                {inModelsMode ? (
                  <>
                    <Button
                      type="button" variant="ghost" size="sm"
                      disabled={disabled}
                      onClick={() => { setDiscoveryOpen(true) }}
                    >{t('adv.list.discover')}</Button>
                    <Menu
                      open={moreOpen}
                      onClose={() => { setMoreOpen(false) }}
                      align="end"
                      items={[
                        { id: 'import', label: t('adv.list.modelsDevRef'), disabled },
                        { id: 'enrich', label: enrichBusy ? t('adv.list.enriching') : t('adv.list.enrich'), disabled: disabled || enrichBusy },
                      ]}
                      onSelect={(id) => {
                        setMoreOpen(false)
                        if (id === 'import') setModelsDevOpen(true)
                        else void enrich()
                      }}
                      anchor={(
                        <Button
                          type="button" variant="ghost" size="sm"
                          className="dshAma-iconAction"
                          icon={<IconMore />}
                          aria-label={t('adv.list.more')}
                          aria-haspopup="menu"
                          aria-expanded={moreOpen}
                          disabled={disabled}
                          onClick={() => { setMoreOpen(open => !open) }}
                        />
                      )}
                    />
                    <Button
                      type="button" variant="outline" size="sm" icon={<IconPlus />}
                      disabled={disabled}
                      onClick={() => { setDialog({ kind: 'add' }) }}
                    >{t('adv.list.addManual')}</Button>
                  </>
                ) : null}
              </div>
            </div>

            {inModelsMode && row.entry.declared === true && models.length > 0
              ? <p className="dshAma-hint">{t('adv.models.hint.full')}</p>
              : null}
            {!inModelsMode ? <p className="dshAma-hint">{t('adv.models.hint.overrides')}</p> : null}

            {inModelsMode
              ? (
                models.length === 0
                  ? (
                    <div className="dshAma-modelEmpty">
                      <IconInfo />
                      <span>{t('adv.models.hint.declaredEmpty')}</span>
                      <button
                        type="button" className="dshAma-linkBtn"
                        disabled={disabled}
                        onClick={() => { setDialog({ kind: 'add' }) }}
                      >{t('adv.list.addManual')}</button>
                    </div>
                  )
                  : (
                    <>
                      {row.entry.declared === true && models.some(model => model.reasoningEfforts === undefined)
                        ? (
                          <p className="dshAma-hint">
                            {t('adv.list.reasoningWarning', {
                              count: models.filter(model => model.reasoningEfforts === undefined).length,
                            })}<b>{t('adv.list.noReasoningTiers')}</b>{t('adv.list.reasoningWarningTail')}
                          </p>
                        )
                        : null}
                      <div className="dshAma-modelBox">
                        {models.map((model, index) => {
                          const id = typeof model.id === 'string' ? model.id : ''
                          const name = typeof model.name === 'string' ? model.name : ''
                          const context = typeof model.contextWindow === 'number' ? model.contextWindow : undefined
                          const input = Array.isArray(model.input)
                            ? model.input.filter((value): value is string => typeof value === 'string')
                            : []
                          return (
                            <div className="dshAma-modelRow" key={index}>
                              <Tooltip label={id === '' ? t('adv.list.unnamed') : id} onlyWhenClipped side="top">
                                <button
                                  type="button" className="dshAma-modelName"
                                  disabled={disabled}
                                  onClick={() => { setDialog({ kind: 'model', index }) }}
                                >{id === '' ? t('adv.list.unnamed') : id}</button>
                              </Tooltip>
                              <div className="dshAma-modelBadges">
                                {context === undefined
                                  ? null
                                  : (
                                    <Tooltip label={t('adv.models.badgeContext', { value: formatCapacity(context) })} side="top">
                                      <span className="dshAma-badge dshAma-badgeMono">{formatCapacity(context)}</span>
                                    </Tooltip>
                                  )}
                                {input.includes('image')
                                  ? (
                                    <Tooltip label={t('adv.models.badgeVision')} side="top">
                                      <span className="dshAma-badge">{t('adv.models.badgeVision')}</span>
                                    </Tooltip>
                                  )
                                  : null}
                                {testResult === undefined || testResult.model !== id || id === ''
                                  ? null
                                  : (
                                    <Tooltip
                                      side="top"
                                      label={testResult.ok
                                        ? t('adv.models.test')
                                        : (testResult.failure === undefined ? t('adv.models.testFailed') : messageText(testResult.failure, t))}
                                    >
                                      <span className={`dshAma-result${testResult.ok ? ' is-ok' : ' is-err'}`}>
                                        {testResult.ok ? `${testResult.latency ?? 0}ms` : t('adv.models.testFailed')}
                                      </span>
                                    </Tooltip>
                                  )}
                              </div>
                              <div className="dshAma-modelActions">
                                <Tooltip label={t('adv.models.test')} side="top">
                                  <Button
                                    type="button" variant="ghost" size="sm"
                                    icon={testing === id ? <IconSpinner /> : <IconPlug />}
                                    className="dshAma-iconAction"
                                    aria-label={t('adv.models.test')}
                                    aria-busy={testing === id}
                                    disabled={disabled || testing !== undefined || id === ''}
                                    onClick={() => { void runTest(id) }}
                                  />
                                </Tooltip>
                                <Tooltip label={t('adv.models.editAria', { id: id === '' ? t('adv.list.unnamed') : id })} side="top">
                                  <Button
                                    type="button" variant="ghost" size="sm" icon={<IconPencil />}
                                    className="dshAma-iconAction"
                                    aria-label={t('adv.models.editAria', { id: id === '' ? t('adv.list.unnamed') : id })}
                                    disabled={disabled}
                                    onClick={() => { setDialog({ kind: 'model', index }) }}
                                  />
                                </Tooltip>
                                <Tooltip label={t('adv.list.removeModel', { index: index + 1 })} side="top">
                                  <Button
                                    type="button" variant="ghost" size="sm" icon={<IconTrash />}
                                    className="dshAma-iconAction dshAma-iconDanger"
                                    aria-label={t('adv.list.removeModel', { index: index + 1 })}
                                    disabled={disabled}
                                    onClick={() => { writeModels(models.filter((_model, at) => at !== index)) }}
                                  />
                                </Tooltip>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </>
                  )
              )
              : (
                <>
                  <div className="dshAma-overrideAdd">
                    <Input
                      className="dshAma-inputWrap"
                      type="text"
                      list="dshAma-overrideCandidates"
                      value={overrideDraftId}
                      disabled={disabled}
                      placeholder={t('adv.overrides.addPlaceholder')}
                      aria-label={t('adv.overrides.addPlaceholder')}
                      onChange={(event) => { setOverrideDraftId(event.target.value) }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return
                        event.preventDefault()
                        openOverride(overrideDraftId)
                      }}
                    />
                    <datalist id="dshAma-overrideCandidates">
                      {overrideCandidateIds.map(id => <option key={id} value={id} />)}
                    </datalist>
                    <Button
                      type="button" variant="outline" size="sm" icon={<IconPlus />}
                      disabled={disabled || overrideDraftId.trim() === ''}
                      onClick={() => { openOverride(overrideDraftId) }}
                    >{t('adv.overrides.add')}</Button>
                  </div>
                  {overrideIds.length === 0
                    ? <p className="dshAma-hint">{t('adv.models.hint.overridesEmpty')}</p>
                    : (
                      <div className="dshAma-modelBox">
                        {overrideIds.map((id) => {
                          const fields = overrideFields(overrides[id])
                          return (
                            <div className="dshAma-modelRow" key={id}>
                              <Tooltip label={id} onlyWhenClipped side="top">
                                <button
                                  type="button" className="dshAma-modelName"
                                  disabled={disabled}
                                  onClick={() => { setDialog({ kind: 'override', id }) }}
                                >{id}</button>
                              </Tooltip>
                              <div className="dshAma-modelBadges">
                                <span className="dshAma-badge">
                                  {t('adv.overrides.fields', { count: Object.keys(fields).length })}
                                </span>
                              </div>
                              <div className="dshAma-modelActions">
                                <Button
                                  type="button" variant="ghost" size="sm" icon={<IconPencil />}
                                  className="dshAma-iconAction"
                                  aria-label={t('adv.overrides.edit', { id })}
                                  disabled={disabled}
                                  onClick={() => { setDialog({ kind: 'override', id }) }}
                                />
                                <Button
                                  type="button" variant="ghost" size="sm" icon={<IconTrash />}
                                  className="dshAma-iconAction dshAma-iconDanger"
                                  aria-label={t('adv.overrides.remove', { id })}
                                  disabled={disabled}
                                  onClick={() => { removeOverride(id) }}
                                />
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                </>
              )}
          </div>

          {failure === undefined ? null : <p className="dshAma-alert is-err" role="alert">{messageText(failure, t)}</p>}
          {failure === undefined && rowsFailure !== undefined
            ? <p className="dshAma-alert is-err" role="alert">{messageText(rowsFailure, t)}</p>
            : null}
          {notice === undefined ? null : <p className="dshAma-notice" role="status">{messageText(notice, t)}</p>}

          <section className="dshAma-advBlock">
            <button
              type="button"
              className="dshAma-advHead"
              aria-expanded={advancedOpen}
              onClick={() => { setAdvancedOpen((was) => !was) }}
            >
              <span className="dshAma-advChevron"><IconChevron open={advancedOpen} /></span>
              <span className="dshAma-advTitle">{t('adv.adv.title')}</span>
              {advancedCount === 0 ? null : <span className="dshAma-badge">{advancedCount}</span>}
            </button>
            {advancedOpen
              ? (
                <div className="dshAma-advBody">
                  <RouteAdvancedFields draft={routeDraft} disabled={disabled} t={t} />
                </div>
              )
              : null}
          </section>
        </div>

        <footer className="dshAma-cardFoot">
          <span className={`dshAma-dirty${dirty ? ' is-on' : ''}`}>{dirty ? t('adv.adv.unsaved') : ''}</span>
          <Button
            type="button" variant="ghost" size="sm"
            disabled={disabled || !dirty}
            onClick={resetDrafts}
          >{t('adv.reset')}</Button>
          <Button
            type="button" variant="primary" size="sm"
            disabled={disabled || rowsFailure !== undefined || !canSave}
            onClick={() => { void save() }}
          >{busy ? t('adv.save.busy') : t('adv.save.action')}</Button>
        </footer>
      </section>

      {dialog === null || dialogProps === undefined
        ? null
        : (
          <ModelDialog
            key={`${dialog.kind}:${dialog.kind === 'model' ? String(dialog.index) : dialog.kind === 'override' ? dialog.id : 'new'}`}
            t={t}
            title={dialogProps.title}
            row={dialogProps.row}
            lockedId={dialogProps.lockedId}
            handDeclared={dialogProps.handDeclared}
            api={routeApi}
            disabled={disabled}
            takenIds={dialog.kind === 'add' ? modelIds : new Set()}
            onClose={() => { setDialog(null) }}
            onApply={applyDialog}
          />
        )}

      <Modal
        open={askDelete}
        onClose={() => { setAskDelete(false) }}
        title={t('adv.detail.delete')}
        closeLabel={t('adv.common.close')}
        className="dshAma-scope"
        footer={(
          <>
            <Button type="button" variant="ghost" size="sm" onClick={() => { setAskDelete(false) }}>
              {t('adv.common.cancel')}
            </Button>
            <Button type="button" variant="primary" size="sm" disabled={busy} onClick={() => { void removeProvider() }}>
              {t('adv.detail.deleteConfirm')}
            </Button>
          </>
        )}
      >
        <p className="dshAma-hint">{t('adv.detail.deleteBody')}</p>
      </Modal>

      <ModelsDevImportDialog
        t={t}
        open={modelsDevOpen}
        onClose={() => { setModelsDevOpen(false) }}
        onAdopt={(rows) => { writeModels(mergeModelRows(models, rows)) }}
        existingIds={modelIds}
      />
      <ProviderModelDiscoveryDialog
        t={t}
        open={discoveryOpen}
        onClose={() => { setDiscoveryOpen(false) }}
        api={api}
        target={discoveryTarget}
        existingIds={modelIds}
        onAdopt={(rows) => { adoptDiscovered(rows) }}
      />
    </div>
  )
}
