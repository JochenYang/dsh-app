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
import type { IApiClient, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { cloneDraft, getPath, modelRowFailure } from './fields.ts'
import type { ModelDraft } from './fields.ts'
import { ModelEntryEditor, IconTrash } from './entry-editor.tsx'
import { AdvancedModelsStore, protocolChoices, writeOps } from './store.ts'
import type { AdvancedModelsState, RouteRow, SchemaOps } from './store.ts'
import { ModelsDevImportDialog } from './import-dialog.tsx'

/** The inject face the registering apply supplies (declared via `hooks`). */
export interface AdvancedModelsInjected {
  controller: AdvancedModelsStore
  hooks: {
    /** Page snapshot bound by the UI renderer as useSnapshot. */
    snapshot: AdvancedModelsStore['store']
  }
  api: Pick<IApiClient, 'settings' | 'llm'>
  schema: SchemaOps
}

/**
 * Props delivered by the slot outlet: the inject face spread flat with its
 * hooks compartment bound (see `InjectFace`); Partial because the renderer
 * may deliver before the face resolves, which the mount guard below handles.
 */
export type AdvancedModelsSectionProps = Partial<InjectFace<AdvancedModelsInjected>>

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

/**
 * Render the Advanced Models settings section.
 * @param props - the inject face plus the slot's owner props.
 * @returns the section page.
 */
/** The resolved face the body component consumes (never partial inside). */
interface ResolvedFace {
  controller: AdvancedModelsStore
  useSnapshot: (selector: (snapshot: AdvancedModelsState) => AdvancedModelsState) => AdvancedModelsState
  api: Pick<IApiClient, 'settings' | 'llm'>
  schema: SchemaOps
}

/**
 * Render the Advanced Models settings section.
 * @param props - the inject face plus the slot's owner props.
 * @returns the section page.
 */
export function AdvancedModelsSection(props: AdvancedModelsSectionProps): ReactNode {
  const { controller, useSnapshot, api, schema } = props
  if (controller === undefined || useSnapshot === undefined || api === undefined || schema === undefined) {
    // The face has not resolved yet; the outlet re-renders once it has.
    return null
  }
  return <AdvancedModelsBody controller={controller} useSnapshot={useSnapshot} api={api} schema={schema} />
}

/** The mounted page: everything below assumes a fully resolved face. */
function AdvancedModelsBody(face: ResolvedFace): ReactNode {
  const { controller, useSnapshot, api, schema } = face
  const state = useSnapshot((snapshot: AdvancedModelsState) => snapshot)
  useEffect(() => {
    if (state.status === 'idle') void controller.load()
  }, [state.status, controller])

  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [modelsDraft, setModelsDraft] = useState<readonly ModelDraft[] | undefined>(undefined)
  const [overridesDraft, setOverridesDraft] = useState<Record<string, ModelDraft> | undefined>(undefined)
  // Expanded-row keys are string-scoped per list ('m3' model row 3, 'o:id'
  // one override, 'n1' one create-card row) so lists never alias state.
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [newRoute, setNewRoute] = useState<NewRouteDraft | undefined>(undefined)
  const [importTarget, setImportTarget] = useState<ImportTarget | undefined>(undefined)
  /** The companion-route migration dialog (off-catalog rows on a catalog route). */
  const [migrate, setMigrate] = useState<
    | undefined
    | { routeId: string; displayName: string; api: string; baseURL: string; exists: boolean }
  >(undefined)

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
  }, [selectedId])

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
  /** The route's full catalog listing (llm.models group), ids only. */
  const catalogIdSet = row === undefined
    ? new Set<string>()
    : new Set((state.groups.get(row.entry.provider)?.models ?? []).map(model => model.id))
  /** Catalog ids offered for a new override (this route's group only). */
  const catalogIds = row === undefined ? [] : [...catalogIdSet].filter(id => !overrideIds.includes(id))
  /**
   * Ids in the drafted list the installed catalog does not carry. On a
   * catalog route these cannot resolve a wire protocol (the route spans
   * several, so no route-level api may be named without rerouting every
   * catalog model too) and the adapter's validator rejects the write — so
   * the page names them up front and routes them to a split route instead.
   */
  const offCatalogIds: string[] = row !== undefined && row.entry.declared !== true && inModelsMode
    ? models
        .map(model => typeof model.id === 'string' ? model.id.trim() : '')
        .filter(id => id !== '' && !catalogIdSet.has(id))
    : []

  const rowsFailure = useMemo(() => {
    if (row === undefined) return undefined
    if (inModelsMode) {
      // The off-catalog gate comes first: the adapter's own validator would
      // reject these with its English diagnostic, one model per attempt —
      // the exact trap this page exists to prevent.
      if (offCatalogIds.length > 0) {
        return `以下模型太新，官方目录尚未收录：${offCatalogIds.join('、')}。它们无法直接加入这个路由（协议无法声明）；请点下方“迁移”按钮——页面会自动创建一条同端点、同密钥的伴生路由（如 opencode-go-extra）来承载它们。`
      }
      const seen = new Set<string>()
      for (const model of models) {
        const text = modelRowFailure(model, seen)
        if (text !== undefined) return text
        seen.add(typeof model.id === 'string' ? model.id : '')
      }
      return undefined
    }
    for (const [id, value] of Object.entries(overrides)) {
      // Override rows address a catalog id by key; a row that sets nothing
      // would write a meaningless empty object into settings.yaml.
      if (Object.keys(overrideFields(value)).length === 0) return `覆盖 ${id}：至少设置一个字段`
      const text = modelRowFailure({ ...value, id }, new Set())
      if (text !== undefined) return text.replace(`${id} 的 `, `覆盖 ${id}：`)
    }
    return undefined
  }, [row, inModelsMode, models, overrides])

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
          setFailure('手写路由至少保留一个模型；如需移除整个路由，请在官方“模型”页操作。')
          setBusy(false)
          return
        }
        ops = [{ op: 'unset', path: [...path, 'models'] }]
      } else {
        ops = [{ op: 'set', path: [...path, 'models'], value: models }]
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
          else ops.push({ op: 'set', path: [...path, 'modelOverrides', id], value: fields })
        }
      }
    }
    if (ops.length === 0) {
      setNotice('没有需要保存的更改。')
      setBusy(false)
      return
    }
    const outcome = await writeOps(api, ops, namespace.revision)
    setBusy(false)
    if (outcome.kind === 'conflict') {
      setFailure('配置已在别处更新（或本页刚保存过其它更改）。已重新加载，请检查后再次保存。')
      setModelsDraft(undefined)
      setOverridesDraft(undefined)
      await controller.load()
      return
    }
    if (outcome.kind === 'failure') {
      setFailure(outcome.message)
      return
    }
    setModelsDraft(undefined)
    setOverridesDraft(undefined)
    setNotice('已保存。')
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
      setFailure('路由 ID 只能包含字母、数字与连字符，且以字母或数字开头。')
      return
    }
    const existingTarget = state.routes.find(candidate => candidate.entry.provider === id)
    if (existingTarget !== undefined && existingTarget.entry.declared !== true) {
      setFailure(`「${id}」是官方目录路由：目录内模型本就直接可用，目录外模型请回到该路由用“迁移”按钮接入。`)
      return
    }
    if (existingTarget === undefined && newRoute.api === '') {
      setFailure('请选择 wire 协议（api）。')
      return
    }
    const seen = new Set<string>()
    for (const model of newRoute.rows) {
      const text = modelRowFailure(model, seen)
      if (text !== undefined) { setFailure(text); return }
      seen.add(typeof model.id === 'string' ? model.id : '')
    }
    setBusy(true)
    setFailure(undefined)
    let ops: SettingsPathOpView[]
    let doneNotice: string
    if (existingTarget === undefined) {
      ops = [{ op: 'set', path: ['providers', id], value: cleanRouteValue(newRoute) }]
      doneNotice = `已创建路由 ${id}，可继续编辑其模型字段。`
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
        setFailure('没有可追加的模型。')
        return
      }
      ops = [{ op: 'set', path: ['providers', id, 'models'], value: [...byId.values()] }]
      doneNotice = `已向路由 ${id} 追加 ${String(newRoute.rows.length)} 个模型（同名覆盖）。`
    }
    const outcome = await writeOps(api, ops, namespace.revision)
    setBusy(false)
    if (outcome.kind === 'conflict') {
      setFailure('配置已在别处更新，请重试。')
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
  const routeInfo = (row: RouteRow): ReactNode => {
    const info = resolvedProfile(row)
    const text = (key: string): string => typeof info[key] === 'string' ? info[key] as string : '—'
    return (
      <dl className="dshAma-routeInfo">
        <div><dt>显示名</dt><dd>{text('displayName')}</dd></div>
        <div><dt>baseURL</dt><dd>{text('baseURL')}</dd></div>
        <div><dt>协议</dt><dd>{text('api')}</dd></div>
        <div><dt>凭据变量</dt><dd>{text('apiKeyEnv')}</dd></div>
        <div><dt>状态</dt><dd>{row.entry.active ? '已注册' : '未生效'}</dd></div>
      </dl>
    )
  }

  const patchModel = (index: number, next: ModelDraft): void => {
    setModelsDraft(models.map((model, at) => at === index ? next : model))
  }

  /** Prefill the create card for an out-of-catalog model on a catalog route. */
  const startSplitRoute = (): void => {
    if (row === undefined) return
    const info = resolvedProfile(row)
    const text = (key: string): string => typeof info[key] === 'string' ? info[key] as string : ''
    let id = `${row.entry.provider}-custom`
    const keys = existingRouteKeys(state, schema)
    for (let attempt = 2; keys.has(id); attempt += 1) id = `${row.entry.provider}-custom-${String(attempt)}`
    setFailure(undefined)
    setNotice(undefined)
    setNewRoute({
      id,
      displayName: `${row.entry.displayName} 自定义`,
      api: '',
      baseURL: text('baseURL'),
      apiKeyEnv: text('apiKeyEnv'),
      rows: [],
    })
  }

  /**
   * Open the companion-route migration dialog for the drafted off-catalog
   * rows. The kernel cannot host them on this route (a multi-protocol
   * catalog route has no resolvable api for ids it does not carry), so the
   * page offers the split for them: a sibling route on the SAME endpoint and
   * credential — one click instead of a manual redo of the import.
   */
  const startMigrate = (): void => {
    if (row === undefined) return
    const info = resolvedProfile(row)
    const text = (key: string): string => typeof info[key] === 'string' ? info[key] as string : ''
    // The canonical companion id: reuse (merge into) it when it exists, use
    // it straight when it does not. No increments — one companion per route.
    const canonical = `${row.entry.provider}-extra`
    const exists = existingRouteKeys(state, schema).has(canonical)
    const existing = exists
      ? profileAt([...row.entry.settingsPath.slice(0, -1), canonical])
      : {}
    const existingApi = typeof existing.api === 'string' ? existing.api : ''
    const existingName = typeof existing.displayName === 'string' ? existing.displayName : ''
    const existingBaseURL = typeof existing.baseURL === 'string' ? existing.baseURL : ''
    setMigrate({
      routeId: canonical,
      displayName: existingName !== '' ? existingName : `${row.entry.displayName} 扩展`,
      // openai-completions is the opencode zen gateway's OpenAI-compatible
      // face (verified by the opencode-go-vision route); models.dev's
      // openai-compatible marker maps to the same.
      api: existingApi !== '' ? existingApi : 'openai-completions',
      // The companion is a route the installed catalog does not know, so the
      // adapter requires an explicit baseURL. Prefill from the companion
      // (merge case) or the source route; the catalog's own internal base
      // address (e.g. opencode-go's) is not visible to any client API.
      baseURL: existingBaseURL !== '' ? existingBaseURL : text('baseURL'),
      exists,
    })
  }

  /**
   * Execute the migration as ONE mutate call: upsert the companion route's
   * models (merged, new rows winning by id) and rewrite this route's list
   * without the migrated rows — or restore catalog inheritance when nothing
   * user-owned remains.
   */
  const doMigrate = async (): Promise<void> => {
    if (row === undefined || namespace === undefined || migrate === undefined) return
    const extraId = migrate.routeId.trim()
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(extraId)) {
      setFailure('伴生路由 ID 只能包含字母、数字与连字符。')
      return
    }
    if (migrate.api === '') {
      setFailure('请选择伴生路由的 wire 协议。')
      return
    }
    if (!migrate.exists && migrate.baseURL.trim() === '') {
      setFailure('伴生路由必须填写 baseURL：官方目录不认识这个新路由，无法继承地址（openai-completions 协议通常以 /v1 结尾，如 https://opencode.ai/zen/go/v1）。')
      return
    }
    const keys = existingRouteKeys(state, schema)
    const extraExists = keys.has(extraId)
    if (!migrate.exists && extraExists) {
      setFailure(`路由 ID 已存在：${extraId}`)
      return
    }
    if (migrate.exists && !extraExists) {
      setFailure('伴生路由已不存在（可能在别处被删除），请关闭后重试。')
      return
    }
    const info = resolvedProfile(row)
    const text = (key: string): string => typeof info[key] === 'string' ? info[key] as string : ''
    const offRows = models.filter(model =>
      typeof model.id === 'string' && model.id.trim() !== '' && !catalogIdSet.has(model.id.trim()))
    const keepRows = models.filter(model =>
      !(typeof model.id === 'string' && model.id.trim() !== '' && !catalogIdSet.has(model.id.trim())))
    if (offRows.length === 0) return
    // The same row gate as save: a migrated row the validator would refuse
    // must fail HERE, inside the dialog, not as a rejected atomic write
    // that loses the whole migration.
    const seen = new Set<string>()
    for (const model of offRows) {
      const text = modelRowFailure(model, seen)
      if (text !== undefined) {
        setFailure(`迁移被阻止：${text}`)
        return
      }
      seen.add(typeof model.id === 'string' ? model.id : '')
    }
    // Merge with the companion's existing rows; migrated rows win by id.
    const existingModels = extraExists
      ? profileAt([...row.entry.settingsPath.slice(0, -1), extraId]).models
      : undefined
    const byId = new Map<string, ModelDraft>()
    for (const model of Array.isArray(existingModels) ? existingModels as ModelDraft[] : []) {
      if (typeof model.id === 'string' && model.id !== '') byId.set(model.id, model)
    }
    for (const model of offRows) byId.set(typeof model.id === 'string' ? model.id : '', model)
    const merged = [...byId.values()]
    const ops: SettingsPathOpView[] = extraExists
      ? [{ op: 'set', path: ['providers', extraId, 'models'], value: merged }]
      : [{
          op: 'set', path: ['providers', extraId], value: {
            api: migrate.api,
            baseURL: migrate.baseURL.trim(),
            ...(migrate.displayName.trim() === '' ? {} : { displayName: migrate.displayName.trim() }),
            ...(text('apiKeyEnv') === '' ? {} : { apiKeyEnv: text('apiKeyEnv') }),
            models: merged,
          },
        }]
    ops.push(keepRows.length === 0
      ? { op: 'unset', path: [...row.entry.settingsPath, 'models'] }
      : { op: 'set', path: [...row.entry.settingsPath, 'models'], value: keepRows })
    setBusy(true)
    setFailure(undefined)
    const outcome = await writeOps(api, ops, namespace.revision)
    setBusy(false)
    if (outcome.kind === 'conflict') {
      setFailure('配置已在别处更新。已重新加载，请重试迁移。')
      setModelsDraft(undefined)
      await controller.load()
      return
    }
    if (outcome.kind === 'failure') {
      setFailure(outcome.message)
      return
    }
    setMigrate(undefined)
    setModelsDraft(undefined)
    setNotice(`已将 ${String(offRows.length)} 个模型迁移到路由 ${extraId}（同端点同凭据）。`)
    await controller.load()
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
    <section className="dshAma-root" aria-label="模型高级设置">
      <style>{ADVANCED_CSS}</style>
      <p className="dshAma-intro">
        在此编辑官方“模型”页未覆盖的高级字段：推理等级、输入模态、网关兼容开关等，写入
        <code>settings.yaml</code> 的 <code>llm-pi-ai</code> 节。路由的增删、密钥与端点发现请使用官方“模型”页。
      </p>
      {state.status === 'error'
        ? <p className="dshAma-error">{`加载失败：${state.error ?? ''}`}</p>
        : state.status === 'loading' && state.routes.length === 0
          ? <p className="dshAma-hint">加载中…</p>
          : null}
      {!state.writable ? <p className="dshAma-hint">当前设置源为只读，页面仅可查看。</p> : null}

      <div className="dshAma-field">
        <span className="dshAma-fieldLabel">选择路由</span>
        <select
          className="dshAma-input dshAma-select"
          value={selectedId ?? ''}
          aria-label="选择路由"
          onChange={(event) => {
            setSelectedId(event.target.value === '' ? undefined : event.target.value)
            setNewRoute(undefined)
          }}
        >
          <option value="">（选择要编辑的 provider 路由）</option>
          {state.routes.map(candidate => (
            <option key={candidate.entry.provider} value={candidate.entry.provider}>
              {candidate.entry.displayName === candidate.entry.provider
                ? candidate.entry.provider
                : `${candidate.entry.displayName}（${candidate.entry.provider}）`}
            </option>
          ))}
        </select>
      </div>

      {row === undefined ? null : (
        <>
          {routeInfo(row)}
          {inModelsMode
            ? (
              <div className="dshAma-modeBanner">
                <b>整表模式</b>：此路由自带模型清单（手写路由或已接管的目录路由）。保存将整表写入
                <code>models</code>；清空列表可恢复目录继承（仅目录路由）。
              </div>
            )
            : row.mode === 'overrides'
              ? (
                <div className="dshAma-modeBanner">
                  <b>覆盖模式</b>：按模型 ID 微调官方目录（<code>modelOverrides</code>），不影响清单本身。
                </div>
              )
              : row.entry.declared === true
                ? (
                  <div className="dshAma-modeBanner">
                    <b>手写路由</b>：尚未声明模型清单。添加模型后将进入整表模式。
                  </div>
                )
                : (
                  <div className="dshAma-modeBanner">
                    <b>目录路由</b>：可按模型 ID 覆盖高级字段；如需接入<b>目录外的新模型</b>，请
                    <button type="button" className="dshAma-linkButton" onClick={startSplitRoute}>创建独立接入路由</button>
                    （避免路由级协议覆盖影响目录内模型）。
                  </div>
                )}
          {inModelsMode
            ? (
              <>
                <div className="dshAma-listHead">
                  <span className="dshAma-listTitle">{`模型清单（${String(models.length)}）`}</span>
                  <button
                    type="button" className="dshAma-linkButton" disabled={disabled}
                    onClick={() => { setImportTarget('models') }}
                  >从 models.dev 导入</button>
                  <button
                    type="button" className="dshAma-linkButton" disabled={disabled}
                    onClick={() => { setModelsDraft([...models, { id: '' }]) }}
                  >手动添加</button>
                </div>
                {models.length === 0 ? <p className="dshAma-hint">清单为空。</p> : null}
                {models.map((model, index) => (
                  <div key={index} className="dshAma-entry">
                    <div className="dshAma-entryHead">
                      <button
                        type="button" className="dshAma-iconButton" aria-expanded={openRows.has(`m${String(index)}`)}
                        aria-label={`展开模型 ${index + 1}`}
                        onClick={() => { toggleOpen(`m${String(index)}`) }}
                      >▶</button>
                      <span className="dshAma-entryId">{typeof model.id === 'string' && model.id !== '' ? model.id : '（未命名）'}</span>
                      {typeof model.id === 'string' && model.id.trim() !== ''
                        && row.entry.declared !== true && !catalogIdSet.has(model.id.trim())
                        ? <span className="dshAma-offCatalogBadge" title="不在官方目录中，多协议目录路由无法为它声明协议">目录外</span>
                        : null}
                      <span className="dshAma-entryName">{typeof model.name === 'string' ? model.name : ''}</span>
                      <button
                        type="button" className="dshAma-iconButton dshAma-iconButtonDanger" aria-label={`移除模型 ${index + 1}`}
                        disabled={disabled}
                        onClick={() => { collapseAll(); setModelsDraft(models.filter((_model, at) => at !== index)) }}
                      ><IconTrash /></button>
                    </div>
                    {openRows.has(`m${String(index)}`)
                      ? (
                        <ModelEntryEditor
                          row={model} index={index} disabled={disabled}
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
                  <span className="dshAma-listTitle">{`目录内覆盖（${String(overrideIds.length)}）`}</span>
                  {catalogIds.length > 0
                    ? (
                      <select
                        className="dshAma-input dshAma-select dshAma-addOverride"
                        aria-label="覆盖目录内模型"
                        disabled={disabled}
                        value=""
                        onChange={(event) => {
                          const id = event.target.value
                          if (id === '') return
                          setOpenRows(current => new Set([...current, `o:${id}`]))
                          setOverridesDraft({ ...overrides, [id]: {} })
                        }}
                      >
                        <option value="">覆盖目录内模型…</option>
                        {catalogIds.map(id => <option key={id} value={id}>{id}</option>)}
                      </select>
                    )
                    : <span className="dshAma-hint">目录模型列表不可用或已全部覆盖。</span>}
                </div>
                {overrideIds.length === 0
                  ? <p className="dshAma-hint">尚未覆盖任何模型。目录外新模型请创建独立接入路由。</p>
                  : null}
                {overrideIds.map(id => (
                  <div key={id} className="dshAma-entry">
                    <div className="dshAma-entryHead">
                      <button
                        type="button" className="dshAma-iconButton"
                        aria-expanded={openRows.has(`o:${id}`)}
                        aria-label={`展开覆盖 ${id}`}
                        onClick={() => { toggleOpen(`o:${id}`) }}
                      >▶</button>
                      <span className="dshAma-entryId">{id}</span>
                      <button
                        type="button" className="dshAma-iconButton dshAma-iconButtonDanger" aria-label={`移除覆盖 ${id}`}
                        disabled={disabled}
                        onClick={() => {
                          const next = { ...overrides }
                          delete next[id]
                          setOverridesDraft(next)
                        }}
                      ><IconTrash /></button>
                    </div>
                    {openRows.has(`o:${id}`)
                      ? (
                        <ModelEntryEditor
                          row={{ ...overrides[id], id }} index={0} disabled={disabled} lockedId
                          onChange={(next) => { setOverridesDraft({ ...overrides, [id]: next }) }}
                        />
                      )
                      : null}
                  </div>
                ))}
              </>
            )}
          <div className="dshAma-footer">
            {failure !== undefined ? <p className="dshAma-error">{failure}</p> : null}
            {/* The gate names WHY the write is refused while the button stays
                disabled — a silent disabled save is a dead end. Off-catalog
                rows get the one-click companion migration right beside it. */}
            {failure === undefined && rowsFailure !== undefined
              ? <p className="dshAma-error">{rowsFailure}</p>
              : null}
            {offCatalogIds.length > 0 && !disabled
              ? (
                <button type="button" className="dshAma-button" onClick={startMigrate}>
                  {`迁移 ${String(offCatalogIds.length)} 个模型到伴生路由`}
                </button>
              )
              : null}
            {notice !== undefined ? <p className="dshAma-notice">{notice}</p> : null}
            <button
              type="button" className="dshAma-button dshAma-buttonPrimary"
              disabled={disabled || rowsFailure !== undefined || !canSave}
              onClick={() => { void save() }}
            >{busy ? '保存中…' : '保存更改'}</button>
            <button
              type="button" className="dshAma-button"
              disabled={disabled || !canSave}
              onClick={() => {
                setModelsDraft(undefined)
                setOverridesDraft(undefined)
                collapseAll()
              }}
            >重置</button>
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
        <summary className="dshAma-newRouteSummary">新增独立接入路由（目录外模型 / 拆分多协议网关）</summary>
        <div className="dshAma-newRouteBody">
          <p className="dshAma-hint">
            适用于网关上的新模型尚未收录进官方目录，或一个网关横跨多种协议需要拆分（如
            <code>opencode-go-vision</code>）。协议（api）在路由级声明，仅对本路由生效。
          </p>
          {newRoute === undefined
            ? (
              <button
                type="button" className="dshAma-button"
                onClick={() => { setNewRoute({ ...EMPTY_NEW_ROUTE }); setFailure(undefined) }}
              >开始创建</button>
            )
            : (
              <>
                {/* Upsert targeting: an existing declared route's id switches
                    the card from create to merge-append; a catalog route's id
                    is refused with the pointer to the migrate flow. */}
                {(() => {
                  const trimmed = newRoute.id.trim()
                  if (trimmed === '') return null
                  const target = state.routes.find(candidate => candidate.entry.provider === trimmed)
                  if (target === undefined) return null
                  return target.entry.declared === true
                    ? (
                      <p className="dshAma-hint">
                        路由「{trimmed}」已存在（自建路由）：将把下方模型<b>合并追加</b>进去（按 ID 去重，同名新条目覆盖旧条目），已有配置保持不变。
                      </p>
                    )
                    : (
                      <p className="dshAma-error">
                        「{trimmed}」是官方目录路由，不能在此追加：目录内模型本就直接可用，目录外模型请选中该路由后用“迁移”按钮接入。
                      </p>
                    )
                })()}
                <div className="dshAma-grid">
                  <label className="dshAma-field">
                    <span className="dshAma-fieldLabel">路由 ID</span>
                    <input className="dshAma-input" type="text" value={newRoute.id} placeholder="如 my-gateway-vision"
                      aria-label="路由 ID" onChange={(event) => { setNewRoute({ ...newRoute, id: event.target.value }) }} />
                  </label>
                  <label className="dshAma-field">
                    <span className="dshAma-fieldLabel">显示名称</span>
                    <input className="dshAma-input" type="text" value={newRoute.displayName} placeholder="（默认同路由 ID）"
                      aria-label="显示名称" disabled={upsertTarget !== undefined}
                      onChange={(event) => { setNewRoute({ ...newRoute, displayName: event.target.value }) }} />
                  </label>
                  <label className="dshAma-field">
                    <span className="dshAma-fieldLabel">wire 协议（api）</span>
                    <select className="dshAma-input dshAma-select" value={newRoute.api} aria-label="wire 协议"
                      disabled={upsertTarget !== undefined}
                      onChange={(event) => { setNewRoute({ ...newRoute, api: event.target.value }) }}>
                      <option value="">{upsertTarget !== undefined ? '（沿用已有路由）' : '（必选）'}</option>
                      {protocols.map(choice => <option key={choice} value={choice}>{choice}</option>)}
                    </select>
                  </label>
                  <label className="dshAma-field">
                    <span className="dshAma-fieldLabel">baseURL</span>
                    <input className="dshAma-input" type="text" value={newRoute.baseURL} placeholder="https://…/v1"
                      aria-label="baseURL" disabled={upsertTarget !== undefined}
                      onChange={(event) => { setNewRoute({ ...newRoute, baseURL: event.target.value }) }} />
                  </label>
                  <label className="dshAma-field">
                    <span className="dshAma-fieldLabel">凭据环境变量（apiKeyEnv）</span>
                    <input className="dshAma-input" type="text" value={newRoute.apiKeyEnv} placeholder="MY_GATEWAY_API_KEY"
                      aria-label="凭据环境变量" disabled={upsertTarget !== undefined}
                      onChange={(event) => { setNewRoute({ ...newRoute, apiKeyEnv: event.target.value }) }} />
                  </label>
                </div>
                <div className="dshAma-listHead">
                  <span className="dshAma-listTitle">{`${upsertTarget !== undefined ? '待追加' : '初始'}模型（${String(newRoute.rows.length)}）`}</span>
                  <button type="button" className="dshAma-linkButton" disabled={disabled}
                    onClick={() => { setImportTarget('new-route') }}>从 models.dev 导入</button>
                  <button type="button" className="dshAma-linkButton" disabled={disabled}
                    onClick={() => { setNewRoute({ ...newRoute, rows: [...newRoute.rows, { id: '' }] }) }}>手动添加</button>
                </div>
                {newRoute.rows.map((model, index) => (
                  <div key={index} className="dshAma-entry">
                    <div className="dshAma-entryHead">
                      <button type="button" className="dshAma-iconButton" aria-label={`展开初始模型 ${index + 1}`}
                        aria-expanded={openRows.has(`n${String(index)}`)}
                        onClick={() => { toggleOpen(`n${String(index)}`) }}>▶</button>
                      <span className="dshAma-entryId">
                        {typeof model.id === 'string' && model.id !== '' ? model.id : '（未命名）'}
                      </span>
                      <button type="button" className="dshAma-iconButton dshAma-iconButtonDanger"
                        aria-label={`移除初始模型 ${index + 1}`} disabled={disabled}
                        onClick={() => {
                          collapseAll()
                          setNewRoute({ ...newRoute, rows: newRoute.rows.filter((_m, at) => at !== index) })
                        }}><IconTrash /></button>
                    </div>
                    {openRows.has(`n${String(index)}`)
                      ? (
                        <ModelEntryEditor
                          row={model} index={index} disabled={disabled}
                          onChange={(next) => {
                            setNewRoute({ ...newRoute, rows: newRoute.rows.map((m, at) => at === index ? next : m) })
                          }}
                        />
                      )
                      : null}
                  </div>
                ))}
                <div className="dshAma-footer">
                  {failure !== undefined ? <p className="dshAma-error">{failure}</p> : null}
                  <button type="button" className="dshAma-button dshAma-buttonPrimary"
                    disabled={disabled || (upsertTarget !== undefined && upsertTarget.entry.declared !== true)}
                    onClick={() => { void createRoute() }}>
                    {busy
                      ? '处理中…'
                      : upsertTarget === undefined
                        ? '创建路由'
                        : upsertTarget.entry.declared === true ? '追加到该路由' : '无法追加（目录路由）'}
                  </button>
                </div>
              </>
            )}
        </div>
      </details>

      {migrate === undefined ? null : (
        <div className="dshAma-modalMask" role="presentation" onClick={() => { setMigrate(undefined) }}>
          <div
            className="dshAma-modal" role="dialog" aria-modal="true" aria-label="迁移到伴生路由"
            onClick={(event) => { event.stopPropagation() }}
          >
            <div className="dshAma-modalHead">
              <span className="dshAma-modalTitle">{`迁移 ${String(offCatalogIds.length)} 个目录外模型`}</span>
              <button type="button" className="dshAma-iconButton" aria-label="关闭" onClick={() => { setMigrate(undefined) }}>✕</button>
            </div>
            <div className="dshAma-modalBody">
              <p className="dshAma-hint">
                这些模型将写入伴生路由（同一端点、同一凭据变量），协议在伴生路由上声明，不影响
                {row === undefined ? '' : `「${row.entry.displayName}」`}目录内模型的协议。当前路由的清单将同步移除它们。
              </p>
              <label className="dshAma-field">
                <span className="dshAma-fieldLabel">伴生路由 ID{migrate.exists ? '（已存在，将合并追加）' : ''}</span>
                <input
                  className="dshAma-input" type="text" value={migrate.routeId} aria-label="伴生路由 ID"
                  disabled={migrate.exists}
                  onChange={(event) => { setMigrate({ ...migrate, routeId: event.target.value }) }}
                />
              </label>
              <label className="dshAma-field">
                <span className="dshAma-fieldLabel">显示名称</span>
                <input
                  className="dshAma-input" type="text" value={migrate.displayName} aria-label="伴生路由显示名称"
                  onChange={(event) => { setMigrate({ ...migrate, displayName: event.target.value }) }}
                />
              </label>
              <label className="dshAma-field">
                <span className="dshAma-fieldLabel">baseURL{migrate.exists ? '（沿用已建路由）' : '（新路由必填）'}</span>
                <input
                  className="dshAma-input" type="text" value={migrate.baseURL}
                  placeholder="https://opencode.ai/zen/go/v1" aria-label="伴生路由 baseURL"
                  disabled={migrate.exists}
                  onChange={(event) => { setMigrate({ ...migrate, baseURL: event.target.value }) }}
                />
              </label>
              <label className="dshAma-field">
                <span className="dshAma-fieldLabel">wire 协议（仅新建时生效）</span>
                <select
                  className="dshAma-input dshAma-select" value={migrate.api} aria-label="伴生路由协议"
                  disabled={migrate.exists}
                  onChange={(event) => { setMigrate({ ...migrate, api: event.target.value }) }}
                >
                  {protocols.map(choice => <option key={choice} value={choice}>{choice}</option>)}
                </select>
              </label>
              {failure !== undefined ? <p className="dshAma-error">{failure}</p> : null}
            </div>
            <div className="dshAma-modalFoot">
              <button type="button" className="dshAma-button" onClick={() => { setMigrate(undefined) }}>取消</button>
              <button
                type="button" className="dshAma-button dshAma-buttonPrimary" disabled={disabled}
                onClick={() => { void doMigrate() }}
              >{busy ? '迁移中…' : '迁移'}</button>
            </div>
          </div>
        </div>
      )}

      <ModelsDevImportDialog
        open={importTarget !== undefined}
        onClose={() => { setImportTarget(undefined) }}
        onAdopt={(rows) => {
          if (importTarget === 'new-route' && newRoute !== undefined) {
            setNewRoute({ ...newRoute, rows: [...newRoute.rows, ...rows] })
          } else {
            setModelsDraft([...models, ...rows])
          }
        }}
        existingIds={importTarget === 'new-route' && newRoute !== undefined
          ? new Set(newRoute.rows.map(model => typeof model.id === 'string' ? model.id : ''))
          : modelIds}
      />
    </section>
  )
}

/** Page styles (class prefix dshAma-), injected inline — the brand bundle has no CSS pipeline. */
const ADVANCED_CSS = `
.dshAma-root { display: flex; flex-direction: column; gap: 10px; font-size: 13px; color: var(--dsw-alias-label-primary, #0f172a); }
.dshAma-intro { margin: 0; color: var(--dsw-alias-label-secondary, #64748b); line-height: 1.6; }
.dshAma-intro code, .dshAma-modeBanner code, .dshAma-newRouteBody code { padding: 0 3px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2, #f1f5f9); font-size: 12px; }
.dshAma-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dshAma-fieldLabel { color: var(--dsw-alias-label-secondary, #64748b); font-size: 12px; }
.dshAma-input { box-sizing: border-box; width: 100%; padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(15,23,42,.18)); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; font-size: 13px; }
.dshAma-input:disabled { opacity: .55; }
.dshAma-select { appearance: auto; }
.dshAma-inline { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
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
.dshAma-offCatalogBadge { flex: none; padding: 1px 6px; border-radius: 999px; background: rgba(220, 38, 38, .12); color: #dc2626; font-size: 11px; }
.dshAma-entryBody { display: flex; flex-direction: column; gap: 10px; padding: 10px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); }
.dshAma-iconButton { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: none; border-radius: 6px; background: none; color: var(--dsw-alias-label-secondary, #64748b); cursor: pointer; font-size: 10px; }
.dshAma-iconButton:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, rgba(148,163,184,.15)); }
.dshAma-iconButtonDanger:hover:not(:disabled) { color: #dc2626; }
.dshAma-iconButton:disabled { opacity: .5; cursor: default; }
.dshAma-kvRow { display: grid; grid-template-columns: minmax(120px, 200px) 1fr 24px; gap: 6px; align-items: center; }
.dshAma-kvKey { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--dsw-alias-label-secondary, #475569); }
.dshAma-readonlyValue { font-size: 12px; color: var(--dsw-alias-label-secondary, #94a3b8); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshAma-check { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.dshAma-footer { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
.dshAma-button { padding: 5px 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(15,23,42,.18)); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; cursor: pointer; font-size: 12.5px; }
.dshAma-button:disabled { opacity: .5; cursor: default; }
.dshAma-buttonPrimary { border-color: transparent; background: var(--dsw-alias-brand-primary, #3b82f6); color: #fff; }
.dshAma-newRoute { border: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); border-radius: 8px; margin-top: 8px; }
.dshAma-newRouteSummary { padding: 8px 10px; cursor: pointer; color: var(--dsw-alias-label-secondary, #475569); font-size: 12.5px; }
.dshAma-newRouteBody { display: flex; flex-direction: column; gap: 10px; padding: 10px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); }
.dshAma-modalMask { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: rgba(15, 23, 42, .45); }
.dshAma-modal { display: flex; flex-direction: column; width: min(560px, calc(100vw - 48px)); max-height: min(560px, calc(100vh - 48px)); border-radius: 10px; background: var(--dsw-alias-bg-overlay, #fff); box-shadow: 0 20px 50px rgba(15, 23, 42, .25); }
.dshAma-modalHead { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); }
.dshAma-modalTitle { font-weight: 600; }
.dshAma-modalBody { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; overflow: auto; }
.dshAma-modalFoot { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); }
.dshAma-providerList { display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow: auto; }
.dshAma-providerRow { display: flex; flex-direction: column; gap: 2px; align-items: flex-start; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)); border-radius: 8px; background: none; cursor: pointer; text-align: left; color: inherit; }
.dshAma-providerRowActive { border-color: var(--dsw-alias-brand-primary, #3b82f6); }
.dshAma-providerId { font-weight: 600; font-size: 12.5px; }
.dshAma-providerMeta { color: var(--dsw-alias-label-secondary, #94a3b8); font-size: 11.5px; }
.dshAma-candidateBlock { display: flex; flex-direction: column; gap: 6px; }
.dshAma-candidateList { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0 0 0 4px; list-style: none; max-height: 200px; overflow: auto; }
.dshAma-candidate { font-size: 12.5px; }
`
