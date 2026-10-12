/**
 * The Advanced Models settings page: model-level fields the official Models
 * page deliberately leaves to `settings.yaml` — reasoning efforts, input
 * modalities, compat switches — plus whole-list editing for hand-declared
 * routes and a guarded create flow for out-of-catalog models.
 *
 * Division of labour (deliberate, mirroring the retired brand shadow's
 * lesson): the official page owns provider CRUD, credentials, and endpoint
 * discovery. This page only writes under `llm-pi-ai` → `providers.<route>`
 * through path-addressed `settings.mutate` ops against the stored user layer,
 * with `expectedRevision` fencing concurrent edits.
 *
 * Two addressing modes, because the adapter makes them mutually exclusive:
 *  - `models` — the route owns a full model list (hand-declared routes, or a
 *    catalog route whose list the user already took over). Edits are whole-
 *    list: the array is one `set` op, exactly how the official editor writes.
 *  - `overrides` — per-id tweaks over the installed catalog. Adding an id the
 *    catalog does not carry would be rejected at resolve time, so a NEW model
 *    on a catalog route is guarded into its own split route (the
 *    `opencode-go-vision` pattern) instead of being smuggled in.
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from '../namespace.ts'
import { cloneDraft, defaultReasoningEfforts, getPath, modelRowFailure } from './fields.ts'
import { enrichDraftsFromModelsDev, fetchModelsDev } from './models-dev.ts'
import type { ModelDraft } from './fields.ts'
import { IconChevron, IconTrash, ModelEntryEditor } from './entry-editor.tsx'
import { AdvancedModelsStore, messageOf, protocolChoices, writeOps } from './store.ts'
import type { AdvancedModelsRemote, AdvancedModelsState, RouteRow, SchemaOps } from './store.ts'
import { ModelsDevImportDialog } from './import-dialog.tsx'
import { ProviderModelDiscoveryDialog } from './provider-discovery.tsx'
import type { ProviderDiscoveryTarget } from './provider-discovery.tsx'
import { message, messageText, wireText } from './messages.ts'
import type { PageMessage, Translate } from './messages.ts'
import { RouteAdvancedCard } from './route-advanced.tsx'

/** The inject face the registering apply supplies (declared via `hooks`). */
export interface AdvancedModelsInjected {
  controller: AdvancedModelsStore
  hooks: {
    /** Page snapshot bound by the UI renderer as useSnapshot. */
    snapshot: AdvancedModelsStore['store']
  }
  api: AdvancedModelsRemote
  schema: SchemaOps
}

/**
 * Props delivered by the slot outlet: the inject face spread flat with its
 * hooks compartment bound (see `InjectFace`), plus the `t` seat of this page's
 * namespace — the registration declares `locale: NS`, which is what makes
 * every label below read the active UI locale and re-render on a switch.
 * Partial because the renderer may deliver before the face resolves, which
 * the mount guard below handles.
 */
export type AdvancedModelsSectionProps = Partial<InjectFace<AdvancedModelsInjected>> & PropsLocale<typeof NS>

/** Which edit target a models.dev import adopts into. */
type ImportTarget = 'models' | 'new-route'

/** Draft of the create-route card. */
interface NewRouteDraft {
  id: string
  displayName: string
  api: string
  baseURL: string
  apiKeyEnv: string
  rows: ModelDraft[]
}

const EMPTY_NEW_ROUTE: NewRouteDraft = { id: '', displayName: '', api: '', baseURL: '', apiKeyEnv: '', rows: [] }

/** Route ids a new route must not collide with (every layer's keys). */
function existingRouteKeys(state: AdvancedModelsState, schema: SchemaOps): ReadonlySet<string> {
  const namespace = state.namespaces.get('llm-pi-ai')
  const providers = namespace === undefined ? undefined : schema.getPath(namespace.value, ['providers'])
  const keys = typeof providers === 'object' && providers !== null && !Array.isArray(providers)
    ? Object.keys(providers as Record<string, unknown>)
    : []
  return new Set(keys)
}

/** Strip blank optional fields; keep the create card's required shape. */
function cleanRouteValue(draft: NewRouteDraft): Record<string, unknown> {
  const value: Record<string, unknown> = { api: draft.api }
  if (draft.displayName.trim() !== '') value.displayName = draft.displayName.trim()
  if (draft.baseURL.trim() !== '') value.baseURL = draft.baseURL.trim()
  if (draft.apiKeyEnv.trim() !== '') value.apiKeyEnv = draft.apiKeyEnv.trim()
  if (draft.rows.length > 0) value.models = draft.rows
  return value
}

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

/** The resolved face the body component consumes (never partial inside). */
interface ResolvedFace {
  controller: AdvancedModelsStore
  useSnapshot: (selector: (snapshot: AdvancedModelsState) => AdvancedModelsState) => AdvancedModelsState
  api: AdvancedModelsRemote
  schema: SchemaOps
  /** The namespace-bound translate seat every label below reads. */
  t: Translate
}

/**
 * Render the Advanced Models settings section.
 * @param props - the inject face plus the slot's owner props.
 * @returns the section page.
 */
export function AdvancedModelsSection(props: AdvancedModelsSectionProps): ReactNode {
  const { controller, useSnapshot, api, schema, t } = props
  if (controller === undefined || useSnapshot === undefined || api === undefined || schema === undefined) {
    // The face has not resolved yet; the outlet re-renders once it has.
    return null
  }
  return <AdvancedModelsBody controller={controller} useSnapshot={useSnapshot} api={api} schema={schema} t={t} />
}

/** The mounted page: everything below assumes a fully resolved face. */
function AdvancedModelsBody(face: ResolvedFace): ReactNode {
  const { controller, useSnapshot, api, schema, t } = face
  const state = useSnapshot((snapshot: AdvancedModelsState) => snapshot)
  useEffect(() => {
    if (state.status === 'idle') void controller.load()
  }, [state.status, controller])

  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [modelsDraft, setModelsDraft] = useState<readonly ModelDraft[] | undefined>(undefined)
  const [overridesDraft, setOverridesDraft] = useState<Record<string, ModelDraft> | undefined>(undefined)
  // The LIVE model catalog, fetched once for the override picker. Which models a
  // route serves right now is what the chat's own picker lists, so it is the only
  // honest source for "the model I want to correct" — the store no longer receives
  // a per-provider model list (upstream removed it in 0.1.2, which is why this page
  // used to have no way to add an override at all).
  const [catalogIds, setCatalogIds] = useState<readonly string[]>([])
  const [overrideDraftId, setOverrideDraftId] = useState('')
  useEffect(() => {
    let live = true
    void api.session.modelCatalog().then(
      (response) => {
        if (!live || !response.ok) return
        setCatalogIds(response.value.groups.flatMap(group => group.models.map(model => model.id)))
      },
      () => { /* the picker stays free-text */ },
    )
    return () => { live = false }
  }, [api])
  // Expanded-row keys are string-scoped per list ('m3' model row 3, 'o:id'
  // one override, 'n1' one create-card row) so lists never alias state.
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [enrichBusy, setEnrichBusy] = useState(false)
  // Failures and notices stay messages (classify now, word at render) so a
  // language switch re-words a line the page is still showing.
  const [failure, setFailure] = useState<PageMessage | undefined>(undefined)
  const [notice, setNotice] = useState<PageMessage | undefined>(undefined)
  const [newRoute, setNewRoute] = useState<NewRouteDraft | undefined>(undefined)
  const [modelsDevTarget, setModelsDevTarget] = useState<ImportTarget | undefined>(undefined)
  const [discoveryTarget, setDiscoveryTarget] = useState<ImportTarget | undefined>(undefined)
  const row: RouteRow | undefined = useMemo(
    () => state.routes.find(candidate => candidate.entry.provider === selectedId),
    [state.routes, selectedId],
  )
  const namespace = state.namespaces.get('llm-pi-ai')
  const disabled = !state.writable || busy

  // A selection change re-initializes the drafts; an in-flight push refresh
  // does NOT (the official editor's discipline: the revision fence at save
  // time decides, editing state is never ambushed).
  useEffect(() => {
    setModelsDraft(undefined)
    setOverridesDraft(undefined)
    setOpenRows(new Set())
    setFailure(undefined)
    setNotice(undefined)
    setModelsDevTarget(undefined)
    setDiscoveryTarget(undefined)
  }, [selectedId])

  // The first active route is immediately useful on entry; a refresh keeps the
  // current route when it still exists and falls back only when it vanished.
  useEffect(() => {
    if (state.status !== 'ready') return
    const fallback = state.routes.find(candidate => candidate.entry.active) ?? state.routes[0]
    setSelectedId(current => current !== undefined
      && state.routes.some(candidate => candidate.entry.provider === current)
      ? current
      : fallback?.entry.provider)
  }, [state.status, state.routes])

  /** The user-layer `models` array as loaded (undefined when unowned). */
  const baseModels = row !== undefined && Array.isArray(row.userProfile?.models)
    ? cloneDraft(row.userProfile.models as ModelDraft[])
    : undefined
  /** The user-layer `modelOverrides` object as loaded. */
  const baseOverrides = row !== undefined && typeof row.userProfile?.modelOverrides === 'object'
    && row.userProfile.modelOverrides !== null && !Array.isArray(row.userProfile.modelOverrides)
    ? cloneDraft(row.userProfile.modelOverrides as Record<string, ModelDraft>)
    : {}
  const models = modelsDraft ?? baseModels ?? []
  const overrides = overridesDraft ?? baseOverrides
  const inModelsMode = row !== undefined
    && (row.mode === 'models' || (row.mode === 'empty' && row.entry.declared === true))

  const modelIds = new Set(models.map(model => typeof model.id === 'string' ? model.id : ''))
  const overrideIds = Object.keys(overrides)
  /** Resolved wire protocol for the selected route (user-layer or composed profile.api). */
  const routeApi = (() => {
    if (row === undefined || namespace === undefined) return undefined
    const profile = getPath(namespace.value, row.entry.settingsPath)
    if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return undefined
    const value = (profile as Record<string, unknown>).api
    return typeof value === 'string' && value !== '' ? value : undefined
  })()

  const rowsFailure = useMemo(() => {
    if (row === undefined) return undefined
    if (inModelsMode) {
      // Row validation first: the adapter's own validator would reject bad
      // rows with its English diagnostic, one model per attempt — the exact
      // trap this page exists to prevent.
      const seen = new Set<string>()
      for (const model of models) {
        const modelApi = typeof model.api === 'string' && model.api !== ''
          ? model.api as string
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
  }, [row, inModelsMode, models, overrides, routeApi])

  const modelsChanged = modelsDraft !== undefined
    && JSON.stringify(models) !== JSON.stringify(baseModels ?? [])
  const overridesChanged = overridesDraft !== undefined
    && JSON.stringify(overrides) !== JSON.stringify(baseOverrides)
  const canSave = inModelsMode ? modelsChanged : overridesChanged

  /** Save the selected route's edits as path ops against the stored section. */
  const save = async (): Promise<void> => {
    if (row === undefined || namespace === undefined || rowsFailure !== undefined) return
    setBusy(true)
    setFailure(undefined)
    setNotice(undefined)
    const route = row.entry.provider
    const path = [...row.entry.settingsPath]
    let ops: SettingsPathOpView[]
    if (inModelsMode) {
      if (models.length === 0) {
        // An emptied list restores inheritance on a catalog route; a
        // hand-declared route has nothing to inherit and would serve nothing.
        if (row.entry.declared === true) {
          setFailure(message('adv.failure.declaredNeedsModel'))
          setBusy(false)
          return
        }
        ops = [{ op: 'unset', path: [...path, 'models'] }]
      } else {
        ops = [{ op: 'set', path: [...path, 'models'], value: models as JsonValue }]
      }
    } else {
      ops = []
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
    if (ops.length === 0) {
      setNotice(message('adv.notice.noChanges'))
      setBusy(false)
      return
    }
    let outcome = await writeOps(api, ops, namespace.revision)
    if (outcome.kind === 'conflict') {
      // Another surface wrote first. Every op addresses one of this route's own
      // paths, so reloading for a fresh revision and re-applying them is what
      // the user asked for — and it beats dropping an edited screen. One
      // automatic retry; a second conflict keeps the draft and asks.
      await controller.load()
      const fresh = controller.store.getSnapshot().namespaces.get('llm-pi-ai')?.revision
      outcome = await writeOps(api, ops, fresh)
      if (outcome.kind === 'conflict') {
        setBusy(false)
        setFailure(message('adv.failure.conflictRetained'))
        return
      }
    }
    setBusy(false)
    if (outcome.kind === 'failure') {
      setFailure(outcome.message)
      return
    }
    setModelsDraft(undefined)
    setOverridesDraft(undefined)
    setNotice(message('adv.notice.saved'))
    await controller.load()
  }

  /**
   * Upsert from the create card: a NEW id creates the whole profile; an id a
   * declared route already owns MERGES the card's rows into it (per-id, new
   * winning) — the "import another batch later" flow needs no second route.
   * A catalog route's id is refused: appending off-catalog rows there is the
   * write the adapter rejects, and in-catalog ids need no appending.
   */
  const createRoute = async (): Promise<void> => {
    if (newRoute === undefined || namespace === undefined) return
    const id = newRoute.id.trim()
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
      setFailure(message('adv.failure.routeIdInvalid'))
      return
    }
    const existingTarget = state.routes.find(candidate => candidate.entry.provider === id)
    if (existingTarget !== undefined && existingTarget.entry.declared !== true) {
      setFailure(message('adv.failure.catalogRouteCreate', { id }))
      return
    }
    if (existingTarget === undefined && newRoute.api === '') {
      setFailure(message('adv.failure.apiRequired'))
      return
    }
    const seen = new Set<string>()
    for (const model of newRoute.rows) {
      const modelApi = typeof model.api === 'string' && model.api !== ''
        ? model.api as string
        : newRoute.api
      const text = modelRowFailure(model, seen, modelApi)
      if (text !== undefined) { setFailure(text); return }
      seen.add(typeof model.id === 'string' ? model.id : '')
    }
    setBusy(true)
    setFailure(undefined)
    let ops: SettingsPathOpView[]
    let doneNotice: PageMessage
    if (existingTarget === undefined) {
      ops = [{ op: 'set', path: ['providers', id], value: cleanRouteValue(newRoute) as JsonValue }]
      doneNotice = message('adv.notice.routeCreated', { id })
    } else {
      // Merge into the existing declared route: keep its profile fields, upsert rows by id.
      const current = profileAt(['providers', id]).models
      const byId = new Map<string, ModelDraft>()
      for (const model of Array.isArray(current) ? current as ModelDraft[] : []) {
        if (typeof model.id === 'string' && model.id !== '') byId.set(model.id, model)
      }
      for (const model of newRoute.rows) byId.set(typeof model.id === 'string' ? model.id : '', model)
      if (byId.size === 0) {
        setBusy(false)
        setFailure(message('adv.failure.nothingToAppend'))
        return
      }
      ops = [{ op: 'set', path: ['providers', id, 'models'], value: [...byId.values()] as JsonValue }]
      doneNotice = message('adv.notice.appended', { id, count: newRoute.rows.length })
    }
    const outcome = await writeOps(api, ops, namespace.revision)
    setBusy(false)
    if (outcome.kind === 'conflict') {
      setFailure(message('adv.failure.conflictRetry'))
      await controller.load()
      return
    }
    if (outcome.kind === 'failure') {
      setFailure(outcome.message)
      return
    }
    setNewRoute(undefined)
    setNotice(doneNotice)
    setSelectedId(id)
    await controller.load()
  }

  const protocols = protocolChoices(namespace, schema)

  /** The existing route the create card's id addresses, when it does (upsert). */
  const upsertTarget = newRoute === undefined || newRoute.id.trim() === ''
    ? undefined
    : state.routes.find(candidate => candidate.entry.provider === newRoute.id.trim())

  /** The resolved (all-layers) profile at one settings path, for reads. */
  const profileAt = (settingsPath: readonly string[]): Record<string, unknown> => {
    const value = namespace === undefined
      ? undefined
      : getPath(namespace.value, settingsPath)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  }
  /** The resolved (all-layers) profile of one route, for the info bar. */
  const resolvedProfile = (row: RouteRow): Record<string, unknown> =>
    profileAt(row.entry.settingsPath)
  const providerDiscoveryTarget = (candidate: RouteRow): ProviderDiscoveryTarget => {
    const info = resolvedProfile(candidate)
    const baseURL = typeof info.baseURL === 'string' ? info.baseURL : undefined
    const apiName = typeof info.api === 'string' ? info.api : undefined
    return {
      settingsNs: candidate.entry.settingsNs,
      provider: candidate.entry.provider,
      ...(baseURL === undefined ? {} : { baseURL }),
      ...(apiName === undefined ? {} : { api: apiName }),
    }
  }
  const routeInfo = (row: RouteRow): ReactNode => {
    const info = resolvedProfile(row)
    const text = (key: string): string => typeof info[key] === 'string' ? info[key] as string : '—'
    return (
      <dl className="dshAma-routeInfo">
        <div>
          <dt>{t('adv.info.type')}</dt>
          <dd>
            <span className={`dshAma-badge ${row.entry.declared === true ? 'dshAma-badgeCustom' : 'dshAma-badgeCatalog'}`}>
              {row.entry.declared === true ? t('adv.info.declared') : t('adv.info.catalog')}
            </span>
          </dd>
        </div>
        <div><dt>{t('adv.info.displayName')}</dt><dd>{text('displayName')}</dd></div>
        <div><dt>baseURL</dt><dd>{text('baseURL')}</dd></div>
        <div><dt>{t('adv.info.protocol')}</dt><dd>{text('api')}</dd></div>
        <div><dt>{t('adv.info.credentialVar')}</dt><dd>{text('apiKeyEnv')}</dd></div>
        <div><dt>{t('adv.info.status')}</dt><dd>{row.entry.active ? t('adv.info.registered') : t('adv.info.inactive')}</dd></div>
      </dl>
    )
  }

  /**
   * Gap-fill missing fields (especially reasoningEfforts) from models.dev by
   * model id. Hand-declared routes have no catalog inherit, so this is how a
   * batch of discovered/copied ids gets xhigh/max and the rest without a
   * per-row manual enable. Pass `explicitRows` when the caller just set a
   * draft this render has not seen yet (discovery adopt).
   */
  const enrichFromModelsDev = async (
    target: 'models' | 'new-route',
    explicitRows?: readonly ModelDraft[],
  ): Promise<void> => {
    const source = explicitRows
      ?? (target === 'new-route' && newRoute !== undefined ? newRoute.rows : models)
    const ids = source.filter(model => typeof model.id === 'string' && model.id.trim() !== '')
    if (ids.length === 0) {
      setNotice(message('adv.notice.noIdsToEnrich'))
      return
    }
    setEnrichBusy(true)
    setFailure(undefined)
    setNotice(undefined)
    try {
      const providers = await fetchModelsDev()
      const prefer = row?.entry.provider
      const result = enrichDraftsFromModelsDev(providers, source, prefer)
      if (target === 'new-route' && newRoute !== undefined) {
        setNewRoute({ ...newRoute, rows: result.drafts })
      } else {
        setModelsDraft(result.drafts)
      }
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

  const patchModel = (index: number, next: ModelDraft): void => {
    setModelsDraft(models.map((model, at) => at === index ? next : model))
  }

  /** Prefill the create card for an out-of-catalog model on a catalog route. */
  const startSplitRoute = (): void => {
    if (row === undefined) return
    const info = resolvedProfile(row)
    const text = (key: string): string => typeof info[key] === 'string' ? info[key] as string : ''
    // One companion suffix everywhere: -extra (the manual companion-route convention).
    const canonical = `${row.entry.provider}-extra`
    const exists = existingRouteKeys(state, schema).has(canonical)
    let id = canonical
    for (let attempt = 2; existingRouteKeys(state, schema).has(id); attempt += 1) {
      id = `${canonical}-${String(attempt)}`
    }
    setFailure(undefined)
    setNotice(undefined)
    setNewRoute({
      id,
      displayName: t('adv.newRoute.extendedName', { name: row.entry.displayName }),
      // Prefill the source route's protocol when it names one; otherwise the
      // hand-declared default for manual creation.
      api: typeof info.api === 'string' && info.api !== '' ? info.api : 'openai-completions',
      baseURL: text('baseURL'),
      apiKeyEnv: text('apiKeyEnv'),
      rows: [],
    })
    if (exists) {
      setNotice(message('adv.notice.companionExists', { id: canonical }))
    }
  }

  const toggleOpen = (key: string): void => {
    setOpenRows(current => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }
  // Removing any row invalidates positional keys; collapsing everything is
  // correct and cheap (ids re-expand on click).
  const collapseAll = (): void => { setOpenRows(new Set()) }

  return (
    <section className="dshAma-root" aria-label={t('adv.nav')}>
      <style>{ADVANCED_CSS}</style>
      <p className="dshAma-intro">
        {t('adv.intro.lead')}{' '}
        {t('adv.intro.split')}
        <b>{t('adv.info.catalog')}</b>{t('adv.intro.catalog')}
        <b>{t('adv.info.declared')}</b>
        {t('adv.intro.declaredBefore')}{' '}
        <code>-extra</code>{' '}
        {t('adv.intro.declaredAfter')}
      </p>
      {state.status === 'error'
        ? <p className="dshAma-error">{t('adv.load.failed', { message: state.error ?? '' })}</p>
        : state.status === 'loading' && state.routes.length === 0
          ? <p className="dshAma-hint">{t('adv.load.loading')}</p>
          : null}
      {state.status === 'ready' && state.routes.length === 0
        ? <p className="dshAma-hint">{t('adv.load.noRoutes')}</p>
        : null}
      {state.status === 'ready' && !state.writable
        ? <p className="dshAma-hint">{t('adv.readOnly')}</p>
        : null}
      {state.status === 'loading' && state.routes.length > 0
        ? <p className="dshAma-hint" aria-live="polite">{t('adv.syncing')}</p>
        : null}

      <div className="dshAma-routePicker">
        <div className="dshAma-field">
        <span className="dshAma-fieldLabel">{t('adv.picker.label')}</span>
        <select
          className="dshAma-input dshAma-select"
          value={selectedId ?? ''}
          aria-label={t('adv.picker.label')}
          onChange={(event) => {
            setSelectedId(event.target.value === '' ? undefined : event.target.value)
            setNewRoute(undefined)
          }}
        >
          <option value="">{t('adv.picker.placeholder')}</option>
          {state.routes.map(candidate => {
            const kind = candidate.entry.declared === true ? t('adv.picker.kindDeclared') : t('adv.picker.kindCatalog')
            const live = candidate.entry.active ? '' : t('adv.picker.inactiveSuffix')
            const name = candidate.entry.displayName === candidate.entry.provider
              ? candidate.entry.provider
              : t('adv.picker.nameWithId', { name: candidate.entry.displayName, id: candidate.entry.provider })
            return (
              <option key={candidate.entry.provider} value={candidate.entry.provider}>
                {`[${kind}${live}] ${name}`}
              </option>
            )
          })}
        </select>
        </div>
        <Button
          type="button" variant="ghost" size="sm" icon="⟳"
          className="dshAma-iconAction dshAma-refreshButton"
          aria-label={t('adv.picker.refresh')}
          title={t('adv.picker.refresh')}
          disabled={state.status === 'loading'}
          onClick={() => { void controller.load() }}
        />
      </div>

      {row === undefined ? null : (
        <>
          {routeInfo(row)}
          <RouteAdvancedCard
            key={`${row.entry.provider}-advanced`}
            row={row} disabled={disabled} api={api} t={t}
            namespace={namespace} controller={controller}
          />
          {inModelsMode
            ? (
              <div className="dshAma-modeBanner">
                <b>{t('adv.mode.full.title')}</b>
                {row.entry.declared === true
                  ? t('adv.mode.full.declared')
                  : t('adv.mode.full.overridden')}
                {' '}{t('adv.mode.full.catalogHint')}
              </div>
            )
            : row.mode === 'overrides'
              ? (
                <div className="dshAma-modeBanner">
                  <b>{t('adv.mode.override.title')}</b>{t('adv.mode.override.body')}<code>modelOverrides</code>{t('adv.mode.override.afterCode')}
                  <button type="button" className="dshAma-linkButton" onClick={startSplitRoute}>{t('adv.split.action')}</button>{t('adv.mode.override.afterAction')}
                </div>
              )
              : row.entry.declared === true
                ? (
                  <div className="dshAma-modeBanner">
                    <b>{t('adv.info.declared')}</b>{t('adv.mode.declaredEmpty.body')}
                  </div>
                )
                : (
                  <div className="dshAma-modeBanner">
                    <b>{t('adv.info.catalog')}</b>{t('adv.mode.catalog.body')}<b>{t('adv.mode.catalog.outOfCatalog')}</b>{t('adv.mode.catalog.beforeAction')}
                    <button type="button" className="dshAma-linkButton" onClick={startSplitRoute}>{t('adv.split.action')}</button>
                    {t('adv.mode.catalog.afterAction')}
                  </div>
                )}
          {inModelsMode
            ? (
              <>
                <div className="dshAma-listHead">
                  <span className="dshAma-listTitle">{t('adv.list.title', { count: models.length })}</span>
                  <button
                    type="button" className="dshAma-linkButton" disabled={disabled}
                    onClick={() => { setDiscoveryTarget('models') }}
                  >{t('adv.list.discover')}</button>
                  <button
                    type="button" className="dshAma-linkButton" disabled={disabled}
                    onClick={() => { setModelsDevTarget('models') }}
                  >{t('adv.list.modelsDevRef')}</button>
                  <button
                    type="button" className="dshAma-linkButton" disabled={disabled}
                    onClick={() => {
                      const blank: ModelDraft = row.entry.declared === true
                        ? { id: '', ...defaultReasoningEfforts() as ModelDraft }
                        : { id: '' }
                      setModelsDraft([...models, blank])
                    }}
                  >{t('adv.list.addManual')}</button>
                  <button
                    type="button" className="dshAma-linkButton" disabled={disabled || enrichBusy}
                    title={t('adv.list.enrichTitle')}
                    onClick={() => { void enrichFromModelsDev('models') }}
                  >{enrichBusy ? t('adv.list.enriching') : t('adv.list.enrich')}</button>
                </div>
                {models.length === 0 ? <p className="dshAma-hint">{t('adv.list.empty')}</p> : null}
                {row.entry.declared === true && models.some(model => model.reasoningEfforts === undefined)
                  ? (
                    <p className="dshAma-hint">
                      {t('adv.list.reasoningWarning', {
                        count: models.filter(model => model.reasoningEfforts === undefined).length,
                      })}<b>{t('adv.list.noReasoningTiers')}</b>{t('adv.list.reasoningWarningTail')}
                    </p>
                  )
                  : null}
                {models.map((model, index) => (
                  <div key={index} className="dshAma-entry">
                    <div className="dshAma-entryHead">
                      <Button
                        type="button" variant="ghost" size="sm" icon={<IconChevron open={openRows.has('m' + String(index))} />}
                        className="dshAma-iconAction" aria-expanded={openRows.has(`m${String(index)}`)}
                        aria-label={t('adv.list.expandModel', { index: index + 1 })}
                        onClick={() => { toggleOpen(`m${String(index)}`) }}
                      />
                      <span className="dshAma-entryId">
                        {typeof model.id === 'string' && model.id !== '' ? model.id : t('adv.list.unnamed')}
                      </span>
                      <span className="dshAma-entryName">
                        {typeof model.name === 'string' ? model.name : ''}
                      </span>
                      <Button
                        type="button" variant="ghost" size="sm" icon={<IconTrash />}
                        className="dshAma-iconAction dshAma-iconDanger" aria-label={t('adv.list.removeModel', { index: index + 1 })}
                        disabled={disabled}
                        onClick={() => { collapseAll(); setModelsDraft(models.filter((_model, at) => at !== index)) }}
                      />
                    </div>
                    {openRows.has(`m${String(index)}`)
                      ? (
                        <ModelEntryEditor
                          t={t} row={model} index={index} disabled={disabled}
                          api={typeof model.api === 'string' && model.api !== ''
                            ? model.api as string
                            : routeApi}
                          handDeclared={row.entry.declared === true}
                          onChange={(next) => { patchModel(index, next) }}
                        />
                      )
                      : null}
                  </div>
                ))}
              </>
            )
            : (
              <>
                <div className="dshAma-listHead">
                  <span className="dshAma-listTitle">{t('adv.overrides.title', { count: overrideIds.length })}</span>
                  <span className="dshAma-hint">{t('adv.overrides.addHint')}</span>
                </div>
                {/* Adding an override is the whole point of this mode — "correct one
                    model, keep the other thirty-seven" — so the entry lives here
                    rather than behind a catalog list the page never had. The id is
                    free text with suggestions: a model the catalog has not picked up
                    yet (a typo'd deployment, a route added a second ago) must still
                    be correctable. */}
                <div className="dshAma-inline">
                  <Input
                    id="dshAma-overrideId"
                    className="dshAma-inputWrap dshAma-addOverride"
                    type="text"
                    list="dshAma-overrideCandidates"
                    value={overrideDraftId}
                    disabled={disabled}
                    placeholder={t('adv.overrides.addPlaceholder')}
                    onChange={(event) => { setOverrideDraftId(event.target.value) }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      const id = overrideDraftId.trim()
                      if (id === '') return
                      setOverridesDraft({ ...overrides, [id]: {} })
                      setOverrideDraftId('')
                      setOpenRows(new Set([`o:${id}`]))
                    }}
                  />
                  <datalist id="dshAma-overrideCandidates">
                    {catalogIds.filter(id => !(id in overrides)).map(id => (
                      <option key={id} value={id} />
                    ))}
                  </datalist>
                  <Button
                    type="button" variant="primary" size="sm"
                    disabled={disabled || overrideDraftId.trim() === ''}
                    onClick={() => {
                      const id = overrideDraftId.trim()
                      // An override starts INHERITING everything: adding one is a
                      // declaration of intent ("I am about to correct this model"),
                      // and it writes nothing until a field actually changes.
                      setOverridesDraft({ ...overrides, [id]: {} })
                      setOverrideDraftId('')
                      setOpenRows(new Set([`o:${id}`]))
                    }}
                  >{t('adv.overrides.add')}</Button>
                </div>
                {overrideIds.length === 0
                  ? <p className="dshAma-hint">{t('adv.overrides.empty')}</p>
                  : null}
                {overrideIds.map(id => (
                  <div key={id} className="dshAma-entry">
                    <div className="dshAma-entryHead">
                      <Button
                        type="button" variant="ghost" size="sm" icon={<IconChevron open={openRows.has('o:' + id)} />}
                        className="dshAma-iconAction"
                        aria-expanded={openRows.has(`o:${id}`)}
                        aria-label={t('adv.overrides.expand', { id })}
                        onClick={() => { toggleOpen(`o:${id}`) }}
                      />
                      <span className="dshAma-entryId">{id}</span>
                      <Button
                        type="button" variant="ghost" size="sm" icon={<IconTrash />}
                        className="dshAma-iconAction dshAma-iconDanger" aria-label={t('adv.overrides.remove', { id })}
                        disabled={disabled}
                        onClick={() => {
                          const next = { ...overrides }
                          delete next[id]
                          setOverridesDraft(next)
                        }}
                      />
                    </div>
                    {openRows.has(`o:${id}`)
                      ? (
                        <ModelEntryEditor
                          t={t}
                          row={{ ...overrides[id], id }} index={0} disabled={disabled} lockedId
                          api={routeApi}
                          handDeclared={false}
                          onChange={(next) => { setOverridesDraft({ ...overrides, [id]: next }) }}
                        />
                      )
                      : null}
                  </div>
                ))}
              </>
            )}
          <div className="dshAma-footer">
            {failure !== undefined ? <p className="dshAma-error">{messageText(failure, t)}</p> : null}
            {/* The gate names WHY the write is refused while the button stays
                disabled — a silent disabled save is a dead end. */}
            {failure === undefined && rowsFailure !== undefined
              ? <p className="dshAma-error">{messageText(rowsFailure, t)}</p>
              : null}
            {notice !== undefined ? <p className="dshAma-notice">{messageText(notice, t)}</p> : null}
            <Button
              type="button" variant="primary" size="sm"
              disabled={disabled || rowsFailure !== undefined || !canSave}
              onClick={() => { void save() }}
            >{busy ? t('adv.save.busy') : t('adv.save.action')}</Button>
            <Button
              type="button" variant="outline" size="sm"
              disabled={disabled || !canSave}
              onClick={() => {
                setModelsDraft(undefined)
                setOverridesDraft(undefined)
                collapseAll()
              }}
            >{t('adv.reset')}</Button>
          </div>
        </>
      )}

      <details
        className="dshAma-newRoute"
        open={newRoute !== undefined}
        onToggle={(event) => {
          if (!(event.currentTarget as HTMLDetailsElement).open) setNewRoute(undefined)
        }}
      >
        <summary className="dshAma-newRouteSummary">{t('adv.newRoute.summary')}</summary>
        <div className="dshAma-newRouteBody">
          <p className="dshAma-hint">
            {t('adv.newRoute.hint')}<code>opencode-go-vision</code>{t('adv.newRoute.hintTail')}
          </p>
          {newRoute === undefined
            ? (
              <Button
                type="button" variant="outline" size="sm"
                onClick={() => { setNewRoute({ ...EMPTY_NEW_ROUTE }); setFailure(undefined) }}
              >{t('adv.newRoute.start')}</Button>
            )
            : (
              <>
                {/* Upsert targeting: an existing declared route's id switches
                    the card from create to merge-append; a catalog route's id
                    is refused (its models resolve from the official catalog). */}
                {(() => {
                  const trimmed = newRoute.id.trim()
                  if (trimmed === '') return null
                  const target = state.routes.find(candidate => candidate.entry.provider === trimmed)
                  if (target === undefined) return null
                  return target.entry.declared === true
                    ? (
                      <p className="dshAma-hint">
                        {t('adv.newRoute.mergeHintA', { id: trimmed })}<b>{t('adv.newRoute.mergeTerm')}</b>{t('adv.newRoute.mergeHintB')}
                      </p>
                    )
                    : (
                      <p className="dshAma-error">
                        {t('adv.newRoute.catalogRefusal', { id: trimmed })}
                      </p>
                    )
                })()}
                <div className="dshAma-grid">
                  <label className="dshAma-field">
                    <span className="dshAma-fieldLabel">{t('adv.newRoute.id')}</span>
                    <Input className="dshAma-inputWrap" type="text" value={newRoute.id} placeholder={t('adv.newRoute.idPlaceholder')}
                      aria-label={t('adv.newRoute.id')} onChange={(event) => { setNewRoute({ ...newRoute, id: event.target.value }) }} />
                  </label>
                  <label className="dshAma-field">
                    <span className="dshAma-fieldLabel">{t('adv.entry.name')}</span>
                    <Input className="dshAma-inputWrap" type="text" value={newRoute.displayName} placeholder={t('adv.newRoute.displayNamePlaceholder')}
                      aria-label={t('adv.entry.name')} disabled={upsertTarget !== undefined}
                      onChange={(event) => { setNewRoute({ ...newRoute, displayName: event.target.value }) }} />
                  </label>
                  <label className="dshAma-field">
                    <span className="dshAma-fieldLabel">{t('adv.newRoute.api')}</span>
                    <select className="dshAma-input dshAma-select" value={newRoute.api} aria-label={t('adv.newRoute.apiAria')}
                      disabled={upsertTarget !== undefined}
                      onChange={(event) => { setNewRoute({ ...newRoute, api: event.target.value }) }}>
                      <option value="">
                        {upsertTarget !== undefined ? t('adv.newRoute.apiExisting') : t('adv.newRoute.apiRequired')}
                      </option>
                      {protocols.map(choice => <option key={choice} value={choice}>{choice}</option>)}
                    </select>
                  </label>
                  <label className="dshAma-field">
                    <span className="dshAma-fieldLabel">baseURL</span>
                    <Input className="dshAma-inputWrap" type="text" value={newRoute.baseURL} placeholder="https://…/v1"
                      aria-label="baseURL" disabled={upsertTarget !== undefined}
                      onChange={(event) => { setNewRoute({ ...newRoute, baseURL: event.target.value }) }} />
                  </label>
                  <label className="dshAma-field">
                    <span className="dshAma-fieldLabel">{t('adv.newRoute.apiKeyEnv')}</span>
                    <Input className="dshAma-inputWrap" type="text" value={newRoute.apiKeyEnv} placeholder="MY_GATEWAY_API_KEY"
                      aria-label={t('adv.newRoute.apiKeyEnvAria')} disabled={upsertTarget !== undefined}
                      onChange={(event) => { setNewRoute({ ...newRoute, apiKeyEnv: event.target.value }) }} />
                  </label>
                </div>
                <div className="dshAma-listHead">
                  <span className="dshAma-listTitle">
                    {upsertTarget !== undefined
                      ? t('adv.newRoute.rowsAppend', { count: newRoute.rows.length })
                      : t('adv.newRoute.rowsInitial', { count: newRoute.rows.length })}
                  </span>
                  <button type="button" className="dshAma-linkButton" disabled={disabled}
                    onClick={() => { setDiscoveryTarget('new-route') }}>{t('adv.newRoute.discover')}</button>
                  <button type="button" className="dshAma-linkButton" disabled={disabled}
                    onClick={() => { setModelsDevTarget('new-route') }}>{t('adv.list.modelsDevRef')}</button>
                  <button type="button" className="dshAma-linkButton" disabled={disabled || enrichBusy}
                    onClick={() => { void enrichFromModelsDev('new-route') }}>
                    {enrichBusy ? t('adv.list.enriching') : t('adv.list.enrich')}
                  </button>
                  <button type="button" className="dshAma-linkButton" disabled={disabled}
                    onClick={() => {
                      const blank: ModelDraft = { id: '', ...defaultReasoningEfforts() as ModelDraft }
                      setNewRoute({ ...newRoute, rows: [...newRoute.rows, blank] })
                    }}>{t('adv.list.addManual')}</button>
                </div>
                {newRoute.rows.map((model, index) => (
                  <div key={index} className="dshAma-entry">
                    <div className="dshAma-entryHead">
                      <Button type="button" variant="ghost" size="sm" icon={<IconChevron open={openRows.has('n' + String(index))} />}
                        className="dshAma-iconAction" aria-label={t('adv.newRoute.expandRow', { index: index + 1 })}
                        aria-expanded={openRows.has(`n${String(index)}`)}
                        onClick={() => { toggleOpen(`n${String(index)}`) }} />
                      <span className="dshAma-entryId">
                        {typeof model.id === 'string' && model.id !== '' ? model.id : t('adv.list.unnamed')}
                      </span>
                      <Button type="button" variant="ghost" size="sm" icon={<IconTrash />}
                        className="dshAma-iconAction dshAma-iconDanger"
                        aria-label={t('adv.newRoute.removeRow', { index: index + 1 })} disabled={disabled}
                        onClick={() => {
                          collapseAll()
                          setNewRoute({ ...newRoute, rows: newRoute.rows.filter((_m, at) => at !== index) })
                        }} />
                    </div>
                    {openRows.has(`n${String(index)}`)
                      ? (
                        <ModelEntryEditor
                          t={t} row={model} index={index} disabled={disabled}
                          api={typeof model.api === 'string' && model.api !== ''
                            ? model.api as string
                            : newRoute.api}
                          handDeclared
                          onChange={(next) => {
                            setNewRoute({ ...newRoute, rows: newRoute.rows.map((m, at) => at === index ? next : m) })
                          }}
                        />
                      )
                      : null}
                  </div>
                ))}
                <div className="dshAma-footer">
                  {failure !== undefined ? <p className="dshAma-error">{messageText(failure, t)}</p> : null}
                  <Button type="button" variant="primary" size="sm"
                    disabled={disabled || (upsertTarget !== undefined && upsertTarget.entry.declared !== true)}
                    onClick={() => { void createRoute() }}>
                    {busy
                      ? t('adv.newRoute.busy')
                      : upsertTarget === undefined
                        ? t('adv.newRoute.create')
                        : upsertTarget.entry.declared === true ? t('adv.newRoute.append') : t('adv.newRoute.cannotAppend')}
                  </Button>
                </div>
              </>
            )}
        </div>
      </details>

      <ModelsDevImportDialog
        t={t}
        open={modelsDevTarget !== undefined}
        onClose={() => { setModelsDevTarget(undefined) }}
        onAdopt={(rows) => {
          if (modelsDevTarget === 'new-route' && newRoute !== undefined) {
            setNewRoute({ ...newRoute, rows: mergeModelRows(newRoute.rows, rows) })
          } else {
            setModelsDraft(mergeModelRows(models, rows))
          }
        }}
        existingIds={modelsDevTarget === 'new-route' && newRoute !== undefined
          ? new Set(newRoute.rows.map(model => typeof model.id === 'string' ? model.id : ''))
          : modelIds}
      />
      <ProviderModelDiscoveryDialog
        t={t}
        open={discoveryTarget !== undefined}
        onClose={() => { setDiscoveryTarget(undefined) }}
        api={api}
        target={discoveryTarget === 'models' && row !== undefined
          ? providerDiscoveryTarget(row)
          : discoveryTarget === 'new-route' && newRoute !== undefined
            ? { settingsNs: 'llm-pi-ai', baseURL: newRoute.baseURL, api: newRoute.api }
            : undefined}
        existingIds={discoveryTarget === 'new-route' && newRoute !== undefined
          ? new Set(newRoute.rows.map(model => typeof model.id === 'string' ? model.id : ''))
          : modelIds}
        onAdopt={(rows) => {
          if (discoveryTarget === 'new-route' && newRoute !== undefined) {
            const merged = mergeModelRows(newRoute.rows, rows)
            setNewRoute({ ...newRoute, rows: merged })
            // Discovery only returns id/name/capacities — enrich reasoning etc.
            void enrichFromModelsDev('new-route', merged)
          } else {
            const merged = mergeModelRows(models, rows)
            setModelsDraft(merged)
            void enrichFromModelsDev('models', merged)
          }
        }}
      />
    </section>
  )
}

/** Page styles (class prefix dshAma-), injected inline — the brand bundle has no CSS pipeline. */
const ADVANCED_CSS = `
.dshAma-root { display: flex; flex-direction: column; gap: 10px; padding-top: 16px; font-size: 13px; color: var(--dsw-alias-label-primary, #0f172a); }
.dshAma-intro { margin: 0; color: var(--dsw-alias-label-secondary, #64748b); line-height: 1.6; }
.dshAma-intro code, .dshAma-modeBanner code, .dshAma-newRouteBody code { padding: 0 3px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2, #f1f5f9); font-size: 12px; }
.dshAma-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dshAma-fieldLabel { color: var(--dsw-alias-label-secondary, #64748b); font-size: 12px; }
.dshAma-input { box-sizing: border-box; width: 100%; padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(15,23,42,.18)); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; font-size: 13px; }
.dshAma-input:disabled { opacity: .55; }
.dshAma-select { appearance: auto; }
.dshAma-inline { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.dshAma-routePicker { display: flex; gap: 8px; align-items: flex-end; }
.dshAma-routePicker .dshAma-field { flex: 1; }
.dshAma-refreshButton { flex: none; margin-bottom: 1px; }
.dshAma-capacityRow { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.dshAma-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
.dshAma-hint { margin: 2px 0; color: var(--dsw-alias-label-secondary, #64748b); font-size: 12px; line-height: 1.5; }
.dshAma-error { margin: 2px 0; color: #dc2626; font-size: 12px; }
.dshAma-notice { margin: 2px 0; color: #16a34a; font-size: 12px; }
.dshAma-muted { color: var(--dsw-alias-label-secondary, #94a3b8); }
.dshAma-routeInfo { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 6px; margin: 0; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #f8fafc); }
.dshAma-routeInfo div { display: flex; gap: 6px; min-width: 0; }
.dshAma-routeInfo dt { color: var(--dsw-alias-label-secondary, #64748b); flex: none; font-size: 12px; }
.dshAma-routeInfo dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.dshAma-modeBanner { padding: 7px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); background: var(--dsw-alias-bg-layer-2, #f8fafc); line-height: 1.6; color: var(--dsw-alias-label-secondary, #475569); }
.dshAma-listHead { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 4px; }
.dshAma-listTitle { font-weight: 600; }
.dshAma-linkButton { padding: 0; border: none; background: none; color: var(--dsw-alias-brand-primary, #3b82f6); cursor: pointer; font-size: 12px; }
.dshAma-linkButton:disabled { opacity: .5; cursor: default; }
.dshAma-addOverride { width: auto; min-width: 200px; }
.dshAma-entry { border: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #fff); overflow: hidden; }
.dshAma-entry + .dshAma-entry { margin-top: 6px; }
.dshAma-entryHead { display: flex; align-items: center; gap: 8px; padding: 6px 10px; }
.dshAma-entryId { font-weight: 600; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshAma-entryName { color: var(--dsw-alias-label-secondary, #94a3b8); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshAma-badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; }
.dshAma-badgeCatalog { background: rgba(59, 130, 246, .12); color: #2563eb; }
.dshAma-badgeCustom { background: rgba(22, 163, 74, .12); color: #16a34a; }
.dshAma-entryBody { display: flex; flex-direction: column; gap: 10px; padding: 10px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); }
/* The icon actions are the kernel's Button primitive (ghost/sm) carrying the
   page's own compact 24px footprint, which the row grids below are sized against. */
.dshAma-iconAction { width: 24px; padding: 0; }
.dshAma-iconDanger:hover:not(:disabled) { color: #dc2626; }
.dshAma-kvRow { display: grid; grid-template-columns: minmax(120px, 200px) 1fr auto; gap: 6px; align-items: center; }
.dshAma-kvKey { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--dsw-alias-label-secondary, #475569); }
.dshAma-readonlyValue { font-size: 12px; color: var(--dsw-alias-label-secondary, #94a3b8); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshAma-levelGrid { display: flex; flex-wrap: wrap; gap: 10px 14px; padding: 6px 0; }
.dshAma-invalid { color: #dc2626; }
.dshAma-footer { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
.dshAma-newRoute { border: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); border-radius: 8px; margin-top: 8px; }
.dshAma-retryCard { margin-top: 0; }
.dshAma-newRouteSummary { padding: 8px 10px; cursor: pointer; color: var(--dsw-alias-label-secondary, #475569); font-size: 12.5px; }
.dshAma-newRouteBody { display: flex; flex-direction: column; gap: 10px; padding: 10px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); }
/* The two dialogs are the kernel's Modal; these three rules are the seats it
   documents for sizing and for a long scrolling body. */
.dshAma-importModal { width: min(560px, calc(100vw - 48px)); max-height: 100%; }
.dshAma-modalScroll { display: flex; flex-direction: column; gap: 8px; min-height: 0; overflow-y: auto; }
.dshAma-providerList { display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow: auto; }
.dshAma-providerRow { display: flex; flex-direction: column; gap: 2px; align-items: flex-start; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); border-radius: 8px; background: none; cursor: pointer; text-align: left; color: inherit; }
.dshAma-providerRowActive { border-color: var(--dsw-alias-brand-primary, #3b82f6); }
.dshAma-providerId { font-weight: 600; font-size: 12.5px; }
.dshAma-providerMeta { color: var(--dsw-alias-label-secondary, #94a3b8); font-size: 11.5px; }
.dshAma-candidateBlock { display: flex; flex-direction: column; gap: 6px; }
.dshAma-candidateList { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0 0 0 4px; list-style: none; max-height: 200px; overflow: auto; }
.dshAma-candidate { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; font-size: 12.5px; }
.dshAma-capabilityHint { padding: 6px 8px; border-left: 2px solid var(--dsw-alias-brand-primary, #3b82f6); background: var(--dsw-alias-bg-layer-2, #f1f5f9); color: var(--dsw-alias-label-secondary, #64748b); font-size: 12px; line-height: 1.5; }
.dshAma-discoveryModal { width: min(640px, calc(100vw - 48px)); max-height: 100%; }
.dshAma-discoverySource { display: flex; gap: 8px; align-items: center; min-width: 0; }
.dshAma-discoverySourceLabel { color: var(--dsw-alias-label-secondary, #64748b); font-size: 12px; }
.dshAma-discoverySource code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshAma-discoveryToolbar { display: flex; gap: 8px; align-items: center; }
.dshAma-discoveryToolbar .dshAma-inputWrap { flex: 1; min-width: 0; }
.dshAma-discoveryList { display: flex; flex-direction: column; gap: 4px; max-height: 320px; overflow: auto; }
.dshAma-discoveryRow { display: flex; gap: 8px; align-items: flex-start; padding: 7px 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); border-radius: 6px; cursor: pointer; }
.dshAma-discoveryRow:hover { background: var(--dsw-alias-bg-layer-2, #f1f5f9); }
.dshAma-discoveryModel { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 2px; }
.dshAma-discoveryModel strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.dshAma-discoveryModel small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #94a3b8); font-size: 11.5px; }
.dshAma-error p { margin: 0 0 6px; }

/* --- Advanced parameters card (see route-advanced.tsx) --- */
.dshAma-fieldHead { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dshAma-fieldHint { margin: 0; color: var(--dsw-alias-label-secondary, #94a3b8); font-size: 11.5px; line-height: 1.5; }
.dshAma-fieldError { margin: 0; color: #dc2626; font-size: 11.5px; }
.dshAma-badgeOverridden { background: rgba(100, 116, 139, .14); color: var(--dsw-alias-label-secondary, #475569); }
.dshAma-groupSummary { margin-left: 6px; color: var(--dsw-alias-label-secondary, #94a3b8); font-weight: 400; }
.dshAma-input[aria-invalid="true"] { border-color: #dc2626; }
/* The kernel's Input carries no error state of its own: the native input keeps
   aria-invalid, and the wrapper it renders is what shows the refusal. */
.dshAma-inputWrap:has([aria-invalid="true"]) { border-color: #dc2626; }
`
