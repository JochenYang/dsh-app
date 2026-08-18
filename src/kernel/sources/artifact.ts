import type { KernelManifest } from '../../shared/types'

/**
 * Resolves runtime artifacts (kernel tarballs) from GitHub Releases.
 *
 * Naming convention (produced by scripts/build-runtime.mjs in CI):
 *   dsh-runtime-<platform>-<arch>-<version>.tgz
 *   dsh-runtime-<platform>-<arch>-<version>.tgz.sha512
 *
 * The tgz contains a single top-level directory `runtime/` with:
 *   manifest.json   — KernelManifest for the artifact
 *   node/           — Node.js binary for the platform/arch
 *   app/            — npm-installed dsh profile (package.json + node_modules)
 */
export interface ArtifactInfo {
  url: string
  sha512: string
  manifest: KernelManifest
}

const RELEASE_TAG_PREFIX = 'runtime-'

export class GitHubArtifactResolver {
  constructor(
    private readonly owner: string,
    private readonly repo: string,
    private readonly platform: string,
    private readonly arch: string,
  ) {}

  /** Asset base dir for a kernel version, e.g. .../releases/download/runtime-0.1.0-rc.7/ */
  private baseUrl(version: string): string {
    return `https://github.com/${this.owner}/${this.repo}/releases/download/${RELEASE_TAG_PREFIX}${version}`
  }

  private assetName(version: string): string {
    return `dsh-runtime-${this.platform}-${this.arch}-${version}.tgz`
  }

  async fetchArtifact(version: string): Promise<ArtifactInfo | null> {
    const base = this.baseUrl(version)
    const name = this.assetName(version)
    try {
      const [shaRes, manifestRes] = await Promise.all([
        fetch(`${base}/${name}.sha512`, { signal: AbortSignal.timeout(10_000) }),
        fetch(`${base}/manifest.json`, { signal: AbortSignal.timeout(10_000) }),
      ])
      if (!shaRes.ok || !manifestRes.ok) return null
      const sha512 = (await shaRes.text()).trim()
      const manifest = (await manifestRes.json()) as KernelManifest
      return { url: `${base}/${name}`, sha512, manifest }
    } catch {
      return null
    }
  }
}
