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
  /** npm integrity string (sha512) for the package tarball. */
  integrity: string
  /** Registry URL that answered (for diagnostics). */
  source: string
}

/**
 * Query npm registries (in order) for the @deepseek-ai/dsh dist-tags.
 *
 * The desktop app follows dsh's own release cadence: `rc` (current dev-preview
 * cadence) or `latest` (stable). The chosen version is used both for update
 * detection and for naming the runtime artifact to download.
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
    const res = await fetch(`${base}/${DSH_PACKAGE}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const doc = (await res.json()) as {
      'dist-tags'?: Record<string, string>
      versions?: Record<string, { dist?: { integrity?: string } }>
    }
    const tags = doc['dist-tags'] ?? {}
    const version = tags[channel] ?? tags.latest ?? tags.rc
    if (!version) return null
    const integrity = doc.versions?.[version]?.dist?.integrity ?? ''
    return { version, channel, integrity, source: base }
  } catch {
    return null
  }
}
