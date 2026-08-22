/**
 * Advanced Models page store: the read join (configurable-provider directory
 * + shared settings mirror + host model catalog) and the write helper.
 *
 * Mirrors the official Models page's store discipline: the host stays the
 * single fact source, every mutation writes through `settings.mutate` as
 * path ops against the STORED user layer, and the page re-renders from the
 * next describe (pushed or refetched). This page only ever writes under
 * `llm-pi-ai` → `providers.<route>`.
 */

import type {
  ConfigurableProviderView, IApiClient, ModelProviderGroup,
  SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsDescribeFace, SettingsSchemaService } from '@deepseek-ai/dsh-client-ui-settings/client'

/** Plain schema callbacks, hidden behind bound functions (no cordis leakage). */
export type SchemaOps = Pick<
  SettingsSchemaService,
  'rehydrate' | 'getPath' | 'hasPath' | 'setPath' | 'deletePath' | 'nodeAtPath'
>

/** One pi-ai route this page can edit, with its user-layer profile state. */
export interface RouteRow {
  /** The directory entry (route id, display name, settings address, live state). */
  entry: ConfigurableProviderView
  /** The user-layer profile object, or undefined when only composition configures it. */
  userProfile: Record<string, unknown> | undefined
  /**
   * Which model-addressing mode the user layer is in. `models` = the route
   * owns a full list (hand-written routes always land here once they declare
   * one); `overrides` = per-id tweaks over the installed catalog; `empty` =
   * the user layer addresses no models at all.
   */
  mode: 'models' | 'overrides' | 'empty'
}

/** Page snapshot. */
export interface AdvancedModelsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; write failures stay in the editor. */
  error: string | null
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** pi-ai routes in directory order. */
  routes: readonly RouteRow[]
  /** Namespace views by ns (schema/layers/revision for the write path). */
  namespaces: ReadonlyMap<string, SettingsNamespaceView>
  /** Host model catalog by provider route id (candidate ids for overrides). */
  groups: ReadonlyMap<string, ModelProviderGroup>
}

/** Human text for a rejected wire call (transport rejects with anything). */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Outcome of one settings write attempt. */
export type WriteOutcome =
  | { kind: 'ok'; namespace: SettingsNamespaceView }
  | { kind: 'conflict' }
  | { kind: 'failure'; message: string }

/**
 * One `settings.mutate` against the stored `llm-pi-ai` user layer. Ops are
 * path-addressed and name only what this page edits, so a concurrent edit to
 * another route or field survives. A conflict is reported as its own outcome:
 * the page reloads and lets the user retry on fresh state.
 */
export async function writeOps(
  api: Pick<IApiClient, 'settings'>,
  ops: readonly SettingsPathOpView[],
  expectedRevision: number | undefined,
): Promise<WriteOutcome> {
  try {
    const response = await api.settings.mutate({
      ns: 'llm-pi-ai',
      ops: [...ops],
      ...expectedRevision === undefined ? {} : { expectedRevision },
    })
    if (response.result.ok) return { kind: 'ok', namespace: response.result.value }
    return response.result.error.code === 'settings-conflict'
      ? { kind: 'conflict' }
      : { kind: 'failure', message: response.result.error.message }
  } catch (error) {
    return { kind: 'failure', message: messageOf(error) }
  }
}

/**
 * The wire protocols a route may name at the profile level, read out of the
 * namespace's own schema (the choices offered cannot drift from what the
 * adapter accepts). Same read the official page makes.
 */
export function protocolChoices(
  namespace: SettingsNamespaceView | undefined,
  schema: SchemaOps,
): string[] {
  if (namespace === undefined) return []
  // Any route key walks a dict schema to the same profile node; \0 cannot
  // collide with a configured route.
  const node = schema.nodeAtPath(schema.rehydrate(namespace.schema), ['providers', '\u0000probe', 'api'])
  const list = node as { type?: string; list?: readonly { value?: unknown }[] } | undefined
  if (list?.type !== 'union' || list.list === undefined) return []
  return list.list.map(entry => entry.value).filter((value): value is string => typeof value === 'string')
}

/** The Advanced Models page controller (one per settings surface). */
export class AdvancedModelsStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<AdvancedModelsState> = createSnapshotStore<AdvancedModelsState>({
    status: 'idle', error: null, writable: false, routes: [], namespaces: new Map(), groups: new Map(),
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0

  /**
   * @param api - the wire face (llm/settings domains).
   * @param schema - settings-owned schema operations.
   * @param describeFace - the shared mirror's describe face.
   */
  constructor(
    private readonly api: Pick<IApiClient, 'llm' | 'settings'>,
    private readonly schema: SchemaOps,
    private readonly describeFace: SettingsDescribeFace,
  ) {}

  /**
   * Refresh the page snapshot: provider directory, settings mirror, and host
   * model catalog in parallel. Only pi-ai routes are kept — the advanced
   * fields (reasoningEfforts / input / compat) are pi-ai profile fields.
   * @returns nothing; the snapshot carries the outcome.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    let providers: ConfigurableProviderView[]
    let groups: readonly ModelProviderGroup[]
    let writable: boolean
    let views: readonly SettingsNamespaceView[]
    try {
      const [providersResponse, modelsResponse] = await Promise.all([
        this.api.llm.providers({}),
        this.api.llm.models({}),
        this.describeFace.ensure(),
      ])
      if (!providersResponse.result.ok) throw new Error(providersResponse.result.error.message)
      if (!modelsResponse.result.ok) throw new Error(modelsResponse.result.error.message)
      const mirrored = this.describeFace.getSnapshot()
      if (mirrored.view === undefined) {
        throw new Error(mirrored.error ?? 'settings are unavailable in this browser')
      }
      providers = providersResponse.result.value.providers
      groups = modelsResponse.result.value.groups
      writable = mirrored.view.writable
      views = mirrored.view.namespaces
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((s) => {
        s.status = 'error'
        s.error = messageOf(error)
      })
      return
    }
    const namespaces = new Map(views.map(view => [view.ns, view]))
    const byGroup = new Map(groups.map(group => [group.id, group]))
    const routes: RouteRow[] = providers
      .filter(entry => entry.settingsNs === 'llm-pi-ai')
      .map((entry) => {
        const namespace = namespaces.get(entry.settingsNs)
        const profile = namespace === undefined
          ? undefined
          : this.schema.getPath(namespace.user, entry.settingsPath)
        const userProfile = typeof profile === 'object' && profile !== null && !Array.isArray(profile)
          ? profile as Record<string, unknown>
          : undefined
        const hasModels = userProfile !== undefined && Array.isArray(userProfile.models)
        const hasOverrides = userProfile !== undefined && typeof userProfile.modelOverrides === 'object'
          && userProfile.modelOverrides !== null && !Array.isArray(userProfile.modelOverrides)
          && Object.keys(userProfile.modelOverrides as Record<string, unknown>).length > 0
        return {
          entry,
          userProfile,
          // A route carrying both is a config the adapter would reject; the
          // page shows what the user layer owns rather than deciding for them.
          mode: hasModels ? 'models' : hasOverrides ? 'overrides' : 'empty',
        }
      })
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.status = 'ready'
      s.error = null
      s.writable = writable
      s.routes = routes
      s.namespaces = namespaces
      s.groups = byGroup
    })
  }
}
