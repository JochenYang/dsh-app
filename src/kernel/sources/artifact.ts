import type { KernelManifest } from '../../shared/types'

/**
 * Resolves runtime artifacts (kernel tarballs) from GitHub Releases, with a
 * mirror fallback chain for regions where GitHub asset downloads are blocked
 * or unreliable (e.g. mainland China without a proxy).
 *
 * Naming convention (produced by scripts/build-runtime.mjs in CI):
 *   dsh-runtime-<platform>-<arch>-<version>.tgz
 *   dsh-runtime-<platform>-<arch>-<version>.tgz.sha512
 *   manifest-<platform>-<arch>.json  — the artifact's KernelManifest
 *
 * The tgz contains a single top-level directory `runtime/` with:
 *   manifest.json   — KernelManifest for the artifact
 *   node/           — Node.js binary for the platform/arch
 *   app/            — npm-installed dsh profile (package.json + node_modules)
 *
 * Two-phase resolution keeps mirrors from forging integrity:
 *   1. Metadata (.sha512 + manifest-<platform>-<arch>.json) is trusted from
 *      the OFFICIAL release first, fail-closed: an official HTTP answer is
 *      authoritative (a 404 means the artifacts are genuinely not published),
 *      and mirrors supplement metadata only when the official host is
 *      unreachable at the network level. The sha512 obtained here is the
 *      single trusted digest.
 *   2. The large tarball is downloaded from an ordered candidate list —
 *      official URL first, then each mirror prefix wrapping that URL — and
 *      EVERY candidate is checked against the phase-1 digest, so a hostile
 *      mirror cannot substitute content even when it serves the bytes.
 *
 * Override the mirror chain with DSH_APP_GITHUB_MIRRORS (comma-separated
 * URL prefixes; empty value disables mirrors entirely).
 */
export interface ArtifactInfo {
  /** Ordered download candidates (official first, then mirrors). */
  candidates: string[]
  /** Trusted sha512 (hex) for the tarball, from the phase-1 metadata source. */
  sha512: string
  manifest: KernelManifest
  /** Which base served the metadata (for diagnostics). */
  source: string
}

const RELEASE_TAG_PREFIX = 'runtime-'

/** Default mirror prefixes, tried after the official URL. */
const DEFAULT_GITHUB_MIRRORS = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
]

export function githubMirrorPrefixes(): string[] {
  const raw = process.env.DSH_APP_GITHUB_MIRRORS
  if (raw !== undefined) {
    // Explicit env wins (including '' => no mirrors at all).
    return raw.split(',').map((s) => s.trim()).filter(Boolean)
  }
  return DEFAULT_GITHUB_MIRRORS
}

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

  /** Official base first, then each mirror prefix wrapping the official URL. */
  private bases(version: string): string[] {
    const official = this.baseUrl(version)
    return [official, ...githubMirrorPrefixes().map((m) => `${m}${official}`)]
  }

  /**
   * Resolve the tarball candidates + trusted digest for a kernel version.
   * Fail-closed metadata rule: the official release is authoritative. Mirror
   * metadata is consulted only when the official host is unreachable at the
   * network level (fetch threw or answered 5xx); an official HTTP answer is
   * final and never falls through to mirrors, so a stale or forged mirror
   * sidecar can neither hide nor substitute the release metadata.
   */
  async fetchArtifact(version: string): Promise<ArtifactInfo | null> {
    const name = this.assetName(version)
    const bases = this.bases(version)
    const [officialBase, ...mirrorBases] = bases
    const official = await this.fetchMetadataOutcome(officialBase, name)
    let meta = official.meta
    let source = officialBase
    if (!official.reached) {
      for (const base of mirrorBases) {
        const outcome = await this.fetchMetadataOutcome(base, name)
        if (outcome.meta) {
          meta = outcome.meta
          source = base
          break
        }
        if (outcome.reached) break
      }
    }
    if (!meta) {
      console.warn(`[artifact] no metadata for dsh ${version} on ${this.platform}-${this.arch}`)
      return null
    }
    return {
      candidates: bases.map((b) => `${b}/${name}`),
      sha512: meta.sha512,
      manifest: meta.manifest,
      source,
    }
  }

  /**
   * Tri-state availability probe for a kernel version's metadata sidecar:
   *   'available'   — the .sha512 is reachable (official host or a mirror)
   *   'missing'     — the official host answered HTTP but not 200 (reachable
   *                   GitHub, artifacts not published yet)
   *   'unreachable' — every base failed at the network level (GitHub and all
   *                   mirrors blocked — e.g. mainland China without proxy)
   * Used to gate update availability: a newer dsh version can be published on
   * npm before its runtime artifacts are built (dead-end offer), but a user
   * with no route to GitHub at all should see "network unreachable", not
   * "artifacts pending". Non-authoritative by design — the real download still
   * verifies against the phase-1 sha512 fetched from the official host first.
   */
  async probeArtifact(version: string): Promise<'available' | 'missing' | 'unreachable'> {
    const name = this.assetName(version)
    let sawResponse = false
    const bases = this.bases(version)
    for (let index = 0; index < bases.length; index += 1) {
      const base = bases[index]
      const isOfficial = index === 0
      try {
        const res = await fetch(`${base}/${name}.sha512`, { signal: AbortSignal.timeout(10_000) })
        // A non-5xx answer means we reached that host; 5xx is a mirror-side
        // failure, NOT evidence the artifact is missing.
        if (res.status >= 500) continue
        // Only the official host counts toward 'missing': a mirror answering
        // 404 says nothing about whether the release exists.
        if (isOfficial) sawResponse = true
        if (res.ok) return 'available'
      } catch (err) {
        console.warn(`[artifact] probe failed for ${base}: ${(err as Error).message}`)
      }
    }
    return sawResponse ? 'missing' : 'unreachable'
  }

  /**
   * Fetch one base's metadata sidecars, distinguishing "host answered HTTP"
   * from "host unreachable" (fetch threw, or a 5xx mirror-side failure).
   * A 5xx counts as unreachable — same policy as probeArtifact — so a sick
   * mirror never produces a final "missing" verdict for the whole chain.
   */
  private async fetchMetadataOutcome(
    base: string,
    name: string,
  ): Promise<{ reached: boolean; meta: { sha512: string; manifest: KernelManifest } | null }> {
    try {
      const [shaRes, manifestRes] = await Promise.all([
        fetch(`${base}/${name}.sha512`, { signal: AbortSignal.timeout(15_000) }),
        // Platform-suffixed name: every runtime cell uploads its own copy, so
        // the shared-name asset never suffers a last-writer platform mismatch
        // (nor a --clobber race between the parallel cells).
        fetch(`${base}/manifest-${this.platform}-${this.arch}.json`, { signal: AbortSignal.timeout(15_000) }),
      ])
      if (shaRes.status >= 500 || manifestRes.status >= 500) {
        console.warn(`[artifact] metadata unavailable (HTTP ${shaRes.status}/${manifestRes.status}) for ${base}/${name}`)
        return { reached: false, meta: null }
      }
      if (!shaRes.ok || !manifestRes.ok) return { reached: true, meta: null }
      const sha512 = (await shaRes.text()).trim()
      const manifest = (await manifestRes.json()) as KernelManifest
      return { reached: true, meta: { sha512, manifest } }
    } catch (err) {
      console.warn(`[artifact] metadata fetch failed for ${base}/${name}: ${(err as Error).message}`)
      return { reached: false, meta: null }
    }
  }
}
