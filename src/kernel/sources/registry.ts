import semver from 'semver'
import type { KernelChannel } from '../../shared/types'

/**
 * npm registries tried in order. The official registry first; npmmirror as
 * the fallback so mainland-China users can resolve kernel versions without a
 * proxy. Override the whole chain with DSH_APP_NPM_REGISTRIES
 * (comma-separated URLs) or a single entry with NPM_CONFIG_REGISTRY.
 */
export function registryCandidates(): string[] {
  const envChain = process.env.DSH_APP_NPM_REGISTRIES
  if (envChain && envChain.trim() !== '') {
    return envChain.split(',').map((s) => s.trim()).filter(Boolean)
  }
  const single = process.env.NPM_CONFIG_REGISTRY
  if (single && single.trim() !== '') {
    return [single.trim(), 'https://registry.npmmirror.com']
  }
  return ['https://registry.npmjs.org', 'https://registry.npmmirror.com']
}

const DSH_PACKAGE = '@deepseek-ai/dsh'

export interface RegistryInfo {
  version: string
  channel: KernelChannel
  /** Registry URL that answered (for diagnostics). */
  source: string
}

/**
 * Query npm registries (in order) for the @deepseek-ai/dsh dist-tags.
 *
 * The desktop app follows dsh's own release cadence, mapping each app channel
 * to the dist-tag dsh's release script actually publishes (families.ts):
 * `stable` → `latest` (formal releases), `beta` → `next` (rc prereleases),
 * `alpha` → `alpha` (alpha prereleases). The chosen version is used both for
 * update detection and for naming the runtime artifact to download.
 */
export async function fetchRegistryInfo(channel: KernelChannel): Promise<RegistryInfo | null> {
  for (const registry of registryCandidates()) {
    const info = await fetchFromRegistry(registry, channel)
    if (info) return info
  }
  return null
}

async function fetchFromRegistry(registry: string, channel: KernelChannel): Promise<RegistryInfo | null> {
  try {
    const base = registry.endsWith('/') ? registry.slice(0, -1) : registry
    if (!base.startsWith('https://')) return null
    const res = await fetch(`${base}/${DSH_PACKAGE}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const contentLength = Number(res.headers.get('content-length') ?? 0)
    if (contentLength > 8 * 1024 * 1024) return null
    const doc = (await res.json()) as {
      'dist-tags'?: Record<string, string>
      versions?: Record<string, unknown>
    }
    const tags = doc['dist-tags'] ?? {}
    // Map the app channel to the dist-tag dsh's release script actually
    // publishes: `latest` for stable releases, `next` for rc prereleases,
    // `alpha` for alpha prereleases (publish.ts families.ts). A plain channel
    // name is also accepted so a future release cadence that publishes a
    // matching tag works without another edit here.
    const tagForChannel = channel === 'stable' ? 'latest' : channel === 'alpha' ? 'alpha' : 'next'
    const version = tags[tagForChannel] ?? tags[channel] ?? tags.latest ?? tags.next ?? tags.rc ?? tags.alpha
    if (!version) return null
    if (semver.valid(version) === null) return null
    return { version, channel, source: base }
  } catch (err) {
    console.warn(`[registry] fetch failed for ${registry}: ${(err as Error).message}`)
    return null
  }
}
