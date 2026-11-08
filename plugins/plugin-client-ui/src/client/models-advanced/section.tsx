/**
 * The provider manager settings page: the list / template / create / detail
 * shell.
 *
 * This page is the app's surface for the provider configuration the official
 * Models page does not cover — a route's advanced parameters, the advanced
 * fields of its models, and the presets to add a new provider from. Identity,
 * endpoint and key of an EXISTING provider stay editable on the official page;
 * this page adds what it cannot express.
 *
 * The shell owns the snapshot's load, which level is on screen, the provider
 * creation write, and the leave confirmation that stops an unsaved draft from
 * being thrown away by a back press. The provider page itself lives in
 * `provider-detail.tsx`, the list in `provider-list.tsx`, the add flow in
 * `template-picker.tsx` / `create-provider.tsx`.
 *
 * @module @dsh-app/plugin-client-ui/client/models-advanced/section
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from '../namespace.ts'
import { cloneDraft, getPath } from './fields.ts'
import type { ModelDraft } from './fields.ts'
import { CreateProviderForm } from './create-provider.tsx'
import type { CreateProviderValues } from './create-provider.tsx'
import { ProviderDetail, ProviderListSection } from './provider-detail.tsx'
import { summarizeRoute } from './provider-list.tsx'
import { TemplatePicker } from './template-picker.tsx'
import type { ProviderTemplate } from './templates/types.ts'
import { message, messageText, wireText } from './messages.ts'
import type { PageMessage, Translate } from './messages.ts'
import { AdvancedModelsStore, ROUTE_SETTINGS_NS, credentialRefs, messageOf, writeOps } from './store.ts'
import type { AdvancedModelsRemote, AdvancedModelsState, SchemaOps } from './store.ts'
import { readPins, togglePin as togglePinId, writePins } from './pins.ts'
import { ADVANCED_CSS } from './styles.ts'
import { useColorScheme } from './use-color-scheme.ts'

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

/** The resolved face the body component consumes (never partial inside). */
interface ResolvedFace {
  controller: AdvancedModelsStore
  useSnapshot: (selector: (snapshot: AdvancedModelsState) => AdvancedModelsState) => AdvancedModelsState
  api: AdvancedModelsRemote
  schema: SchemaOps
  /** The namespace-bound translate seat every label below reads. */
  t: Translate
}

/** Which level is on screen. */
type View =
  | { readonly kind: 'list' }
  | { readonly kind: 'templates' }
  | { readonly kind: 'create'; readonly preset: ProviderTemplate }
  | { readonly kind: 'detail'; readonly route: string }

/**
 * Render the provider manager settings section.
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
  const { controller, useSnapshot, api, t } = face
  const state = useSnapshot((snapshot: AdvancedModelsState) => snapshot)
  const [view, setView] = useState<View>({ kind: 'list' })
  const [dirty, setDirty] = useState(false)
  const [askLeave, setAskLeave] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  /** Pinned route ids (a browser-local view preference, see pins.ts). */
  const [pins, setPins] = useState<string[]>(() => readPins())
  /** A failure the page should show as soon as the detail mounts (a key write
   *  after a successful create). */
  const [startupNotice, setStartupNotice] = useState<PageMessage | undefined>(undefined)
  const rootRef = useRef<HTMLElement | null>(null)
  const scheme = useColorScheme(rootRef)

  useEffect(() => {
    if (state.status === 'idle') void controller.load()
  }, [state.status, controller])

  // A pinned id that no longer names a configured provider would occupy a slot
  // (and hide, on reload) without a row; prune it once the snapshot is known.
  useEffect(() => {
    if (state.status !== 'ready') return
    setPins((current) => {
      const next = current.filter(id => state.routes.some(
        row => row.entry.provider === id && row.userProfile !== undefined))
      if (next.length === current.length) return current
      writePins(next)
      return next
    })
  }, [state.status, state.routes])

  // The settings shell keeps one scroller across sections, so a page can open at
  // the previous page's scroll position. Every level of this page starts at the
  // top; the walk finds the shell's own scroll container rather than guessing it.
  useEffect(() => {
    if (typeof window === 'undefined') return
    let node: HTMLElement | null = rootRef.current?.parentElement ?? null
    while (node !== null) {
      const style = window.getComputedStyle(node)
      if (/(auto|scroll)/u.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
        node.scrollTo({ top: 0, behavior: 'auto' })
        return
      }
      node = node.parentElement
    }
  }, [view])

  // A provider removed elsewhere must not leave the page on a dead route.
  useEffect(() => {
    if (view.kind !== 'detail' || state.status !== 'ready') return
    if (state.routes.some(candidate => candidate.entry.provider === view.route)) return
    setView({ kind: 'list' })
    setDirty(false)
  }, [view, state.routes, state.status])

  const routeNamespace = state.namespaces.get(ROUTE_SETTINGS_NS)

  /** The resolved (all-layers) profile at one settings path, for display. */
  const profileAt = useCallback((settingsPath: readonly string[]): Record<string, unknown> => {
    if (routeNamespace === undefined) return {}
    const value = getPath(routeNamespace.value, settingsPath)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  }, [routeNamespace])

  const selected = view.kind !== 'detail'
    ? undefined
    : state.routes.find(candidate => candidate.entry.provider === view.route)
  const namespace = selected === undefined
    ? undefined
    : state.namespaces.get(selected.entry.settingsNs) ?? routeNamespace
  const resolvedProfile = selected === undefined ? {} : profileAt(selected.entry.settingsPath)
  const summary = selected === undefined ? undefined : summarizeRoute(selected, resolvedProfile)
  const routeApi = typeof resolvedProfile.api === 'string' && resolvedProfile.api !== ''
    ? resolvedProfile.api
    : undefined
  const baseModels = selected !== undefined && Array.isArray(selected.userProfile?.models)
    ? cloneDraft(selected.userProfile.models as ModelDraft[])
    : undefined
  const baseOverrides = selected !== undefined
    && typeof selected.userProfile?.modelOverrides === 'object'
    && selected.userProfile.modelOverrides !== null
    && !Array.isArray(selected.userProfile.modelOverrides)
    ? cloneDraft(selected.userProfile.modelOverrides as Record<string, ModelDraft>)
    : {}
  const inModelsMode = selected !== undefined
    && (selected.mode === 'models' || (selected.mode === 'empty' && selected.entry.declared === true))

  const onDirtyChange = useCallback((next: boolean): void => { setDirty(next) }, [])

  const openList = useCallback((): void => {
    setView({ kind: 'list' })
    setDirty(false)
    setStartupNotice(undefined)
  }, [])

  const requestBack = useCallback((): void => {
    if (dirty) setAskLeave(true)
    else openList()
  }, [dirty, openList])

  const open = useCallback((route: string): void => {
    setView({ kind: 'detail', route })
    setDirty(false)
    setStartupNotice(undefined)
  }, [])

  const togglePin = useCallback((route: string): void => {
    setPins((current) => {
      const next = togglePinId(current, route)
      writePins(next)
      return next
    })
  }, [])

  /**
   * Write a new provider profile, then its key.
   *
   * The two writes are separate services on purpose: a failed key write must not
   * present the profile as unsaved when it is on disk, so the page opens the new
   * provider and reports the key failure there.
   *
   * @param values - the create form's fields.
   * @returns a failure to show in the form, or undefined when the page moved on.
   */
  const createProvider = async (values: CreateProviderValues): Promise<PageMessage | undefined> => {
    if (routeNamespace === undefined) return message('adv.create.failed', { message: t('adv.load.namespace') })
    setCreateBusy(true)
    const profile = {
      displayName: values.displayName === '' ? values.route : values.displayName,
      api: values.api,
      baseURL: values.baseURL,
      apiKeyEnv: values.apiKeyEnv,
      models: [{ id: values.modelId, name: values.displayName === '' ? values.modelId : values.displayName }],
    }
    const ops: SettingsPathOpView[] = [
      { op: 'set', path: ['providers', values.route], value: profile as JsonValue },
    ]
    let outcome = await writeOps(api, ops, routeNamespace.revision)
    if (outcome.kind === 'conflict') {
      // A concurrent edit elsewhere; reload first and check the route still does
      // not exist, so the retry cannot overwrite a provider another window just
      // created under the same id.
      await controller.load()
      const snapshot = controller.store.getSnapshot()
      if (snapshot.routes.some(candidate => candidate.entry.provider === values.route)) {
        setCreateBusy(false)
        return message('adv.create.routeTaken', { route: values.route })
      }
      const fresh = snapshot.namespaces.get(ROUTE_SETTINGS_NS)?.revision
      if (fresh === undefined) {
        setCreateBusy(false)
        return message('adv.create.failed', { message: t('adv.failure.conflictRetained') })
      }
      outcome = await writeOps(api, ops, fresh)
    }
    if (outcome.kind !== 'ok') {
      setCreateBusy(false)
      return message('adv.create.failed', {
        message: outcome.kind === 'conflict'
          ? t('adv.failure.conflictRetained')
          : messageText(outcome.message, t),
      })
    }
    let keyFailure: PageMessage | undefined
    if (values.apiKey.trim() !== '') {
      try {
        const written = await api.credentials.set(values.apiKeyEnv, values.apiKey)
        if (!written.ok) keyFailure = message('adv.create.keyFailed', { message: written.error.message })
      } catch (error) {
        keyFailure = message('adv.create.keyFailed', { message: messageOf(error) })
      }
    }
    setCreateBusy(false)
    await controller.load()
    setStartupNotice(keyFailure)
    setView({ kind: 'detail', route: values.route })
    setDirty(false)
    return undefined
  }

  let content: ReactNode
  if (view.kind === 'templates') {
    content = (
      <TemplatePicker
        t={t}
        existingRoutes={new Set(state.routes.map(row => row.entry.provider))}
        onPick={(preset) => { setView({ kind: 'create', preset }) }}
        onBack={openList}
      />
    )
  } else if (view.kind === 'create') {
    content = (
      <CreateProviderForm
        t={t}
        preset={view.preset}
        existingRoutes={new Set(state.routes.map(row => row.entry.provider))}
        existingCredentials={new Set(state.routes.flatMap(row =>
          credentialRefs(row.entry, profileAt(row.entry.settingsPath))))}
        busy={createBusy}
        onCancel={() => { setView({ kind: 'templates' }) }}
        onSubmit={createProvider}
      />
    )
  } else if (view.kind === 'list') {
    content = (
      <ProviderListSection
        t={t}
        state={state}
        profileAt={profileAt}
        onOpen={open}
        onAdd={() => { setView({ kind: 'templates' }) }}
        onRefresh={() => { void controller.load() }}
        pins={pins}
        onTogglePin={togglePin}
      />
    )
  } else if (selected === undefined || summary === undefined) {
    // Selected but not in the snapshot yet: the reload right after a write can
    // briefly land here, and a provider that vanished is caught above.
    content = <p className="dshAma-hint">{t('adv.load.loading')}</p>
  } else if (namespace === undefined) {
    content = (
      <>
        <button type="button" className="dshAma-backBtn" onClick={requestBack}>
          <span>{t('adv.detail.back')}</span>
        </button>
        <p className="dshAma-alert is-err" role="alert">{t('adv.load.namespace')}</p>
      </>
    )
  } else {
    content = (
      <ProviderDetail
        key={selected.entry.provider}
        t={t}
        row={selected}
        summary={summary}
        api={api}
        controller={controller}
        writable={state.writable}
        inModelsMode={inModelsMode}
        baseModels={baseModels}
        baseOverrides={baseOverrides}
        routeApi={routeApi}
        resolvedProfile={resolvedProfile}
        namespace={namespace}
        startupNotice={startupNotice}
        onBack={requestBack}
        onDirtyChange={onDirtyChange}
        onDeleted={openList}
      />
    )
  }

  return (
    <section className="dshAma-root" ref={rootRef} data-scheme={scheme} aria-label={t('adv.nav')}>
      <style>{ADVANCED_CSS}</style>
      {content}
      <Modal
        open={askLeave}
        onClose={() => { setAskLeave(false) }}
        title={t('adv.leave.title')}
        closeLabel={t('adv.common.close')}
        className="dshAma-scope"
        footer={(
          <>
            <Button type="button" variant="ghost" size="sm" onClick={() => { setAskLeave(false) }}>
              {t('adv.leave.stay')}
            </Button>
            <Button type="button" variant="primary" size="sm" onClick={openList}>
              {t('adv.leave.discard')}
            </Button>
          </>
        )}
      >
        <p className="dshAma-hint">{t('adv.leave.body')}</p>
      </Modal>
    </section>
  )
}

/** Re-exported so the client entry keeps one import for the section's props. */
export type { PageMessage }
