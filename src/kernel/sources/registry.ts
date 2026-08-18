import type { KernelChannel } from '../../shared/types'

const REGISTRY = 'https://registry.npmjs.org'
const DSH_PACKAGE = '@deepseek-ai/dsh'

export interface RegistryInfo {
  version: string
  channel: KernelChannel
  /** npm integrity string (sha512) for the package tarball. */
  integrity: string
}

/**
 * Query the npm registry for the @deepseek-ai/dsh dist-tags.
 *
 * The desktop app follows dsh's own release cadence: `rc` (current dev-preview
 * cadence) or `latest` (stable). The chosen version is used both for update
 * detection and for naming the runtime artifact to download.
 */
export async function fetchRegistryInfo(channel: KernelChannel): Promise<RegistryInfo | null> {
  try {
    const res = await fetch(`${REGISTRY}/${DSH_PACKAGE}`, {
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
    return { version, channel, integrity }
  } catch {
    return null
  }
}
