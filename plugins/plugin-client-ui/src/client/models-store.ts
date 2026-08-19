/**
 * Brand Models page store: a self-contained join over the same wire APIs the
 * upstream Models page uses (llm.providers + settings.describe +
 * credentials.describe). Kept independent of
 * @deepseek-ai/dsh-client-ui-settings-models because the client bundle purity
 * gate forbids cross-plugin value imports — the join logic is small, and
 * owning it lets the brand page evolve freely.
 */

import type {
  ConfigurableProviderView, CredentialView, IApiClient, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { getPath, hasPath, nodeAtPath, rehydrateSchema } from '@deepseek-ai/dsh-client-schema-form'

/** One provider card the brand page renders. */
export interface BrandProviderRow {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: string[]
  active: boolean
  declared: boolean
  configured: boolean
  removable: boolean
  apiKeyEnv: string | undefined
  credential: CredentialView | undefined
}

/** Page snapshot. */
export interface BrandModelsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  writable: boolean
  rows: readonly BrandProviderRow[]
  namespaces: ReadonlyMap<string, SettingsNamespaceView>
}

/** Human text for a rejected wire call. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Conventional credential reference derived from a provider route id. */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * Any route key walks a dict schema to the same profile node, so the lookup
 * names one that cannot collide with a configured route.
 */
const PROBE_ROUTE = String.fromCharCode(0) + 'probe'

export function protocolChoices(namespace: SettingsNamespaceView | undefined): string[] {
  if (namespace === undefined) return []
  const node = nodeAtPath(rehydrateSchema(namespace.schema), ['providers', PROBE_ROUTE, 'api'])
  const list = (node as { type?: string; list?: readonly { value?: unknown }[] } | undefined)
  if (list?.type !== 'union' || list.list === undefined) return []
  return list.list.map(entry => entry.value).filter((v): v is string => typeof v === 'string')
}

/** The credential reference a resolved profile names (its apiKeyEnv field). */
function apiKeyEnvOf(namespace: SettingsNamespaceView | undefined, path: readonly string[]): string | undefined {
  if (namespace === undefined) return undefined
  const profile = getPath(namespace.value, path)
  if (typeof profile !== 'object' || profile === null) return undefined
  const ref = (profile as { apiKeyEnv?: unknown }).apiKeyEnv
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/** Whether a joined row can serve model requests as it stands. */
export function providerUsable(row: BrandProviderRow): boolean {
  if (!row.active) return false
  if (row.apiKeyEnv === undefined) return true
  return row.credential?.configured === true
}

/** The brand Models page controller (one per settings surface). */
export class BrandModelsStore {
  readonly store: SnapshotStore<BrandModelsState> = createSnapshotStore<BrandModelsState>({
    status: 'idle', error: null, writable: false, rows: [], namespaces: new Map(),
  })

  private generation = 0

  constructor(private readonly api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>) {}

  /** Refresh the whole page snapshot; latest load wins. */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    let providers: ConfigurableProviderView[]
    let writable: boolean
    let views: SettingsNamespaceView[]
    try {
      const [providersResponse, settingsResponse] = await Promise.all([
        this.api.llm.providers({}),
        this.api.settings.describe({}),
      ])
      if (!providersResponse.result.ok) throw new Error(providersResponse.result.error.message)
      if (!settingsResponse.result.ok) throw new Error(settingsResponse.result.error.message)
      providers = providersResponse.result.value.providers
      writable = settingsResponse.result.value.writable
      views = settingsResponse.result.value.namespaces
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((s) => {
        s.status = 'error'
        s.error = error instanceof Error ? error.message : String(error)
      })
      return
    }
    const namespaces = new Map(views.map(view => [view.ns, view]))
    const rows: BrandProviderRow[] = providers.map((entry) => {
      const namespace = namespaces.get(entry.settingsNs)
      const configured = namespace !== undefined
        && (entry.settingsPath.length === 0 || getPath(namespace.value, entry.settingsPath) !== undefined)
      const removable = namespace !== undefined
        && entry.settingsPath.length > 0
        && hasPath(namespace.user, entry.settingsPath)
        && !hasPath(namespace.base, entry.settingsPath)
      return {
        provider: entry.provider,
        displayName: entry.displayName,
        settingsNs: entry.settingsNs,
        settingsPath: [...entry.settingsPath],
        active: entry.active,
        declared: entry.declared === true,
        configured,
        removable,
        apiKeyEnv: apiKeyEnvOf(namespace, entry.settingsPath),
        credential: undefined,
      }
    })
    const refs = [...new Set(rows.flatMap(row => row.apiKeyEnv === undefined ? [] : [row.apiKeyEnv]))]
    let credentials: Record<string, CredentialView> = {}
    if (refs.length > 0) {
      try {
        const response = await this.api.credentials.describe({ refs })
        if (response.result.ok) credentials = response.result.value.credentials
      } catch {
        // Credential state is an enrichment; the cards stay usable without it.
      }
    }
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.status = 'ready'
      s.error = null
      s.writable = writable
      s.rows = rows.map(row => row.apiKeyEnv !== undefined && credentials[row.apiKeyEnv] !== undefined
        ? { ...row, credential: credentials[row.apiKeyEnv] }
        : row)
      s.namespaces = namespaces
    })
  }
}
