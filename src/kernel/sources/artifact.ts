import type { KernelManifest } from '../../shared/types'
import { t } from '../../shared/locale'
import { MODELSCOPE_ENDPOINT, MODELSCOPE_REPO } from '../../shared/constants'
import { layerIndexAssetName, parseLayerIndex } from '../layers'
import type { LayerIndex } from '../layers'

/**
 * Resolves runtime artifacts (kernel tarballs) from GitHub Releases, with a
 * mirror fallback chain for regions where GitHub asset downloads are blocked
 * or unreliable (e.g. mainland China without a proxy).
 *
 * Naming convention (produced by scripts/build-runtime.mjs in CI):
 *   dsh-runtime-<platform>-<arch>-<version>.tgz
 *   dsh-runtime-<platform>-<arch>-<version>.tgz.sha512
 *   manifest-<platform>-<arch>.json  — the artifact's KernelManifest
 *   layers-<platform>-<arch>.json    — the split-runtime layer index (optional;
 *                                      see fetchLayerIndex, plus the layer files
 *                                      it names, all transported like the tgz)
 *
 * The tgz contains a single top-level directory `runtime/` with:
 *   manifest.json   — KernelManifest for the artifact
 *   node/           — Node.js binary for the platform/arch
 *   app/            — npm-installed dsh profile (package.json + node_modules)
 *
 * Two-phase resolution keeps mirrors from forging integrity:
 *   1. Metadata (.sha512 + manifest-<platform>-<arch>.json, and the layer index)
 *      is trusted from the OFFICIAL release first, fail-closed: an official HTTP
 *      answer is authoritative (a 404 means the artifacts are genuinely not
 *      published), and mirrors supplement metadata only when the official host is
 *      unreachable at the network level. The sha512 obtained here is the single
 *      trusted digest — and for the split-layer path the index itself is that
 *      digest source, which is why an index that fails validation is an error
 *      rather than a silent "no layers".
 *   2. The large tarball is downloaded from an ordered candidate list —
 *      official URL first, then each mirror prefix wrapping that URL, then the
 *      ModelScope mirror copy — and EVERY candidate is checked against the
 *      phase-1 digest, so a hostile mirror cannot substitute content even when
 *      it serves the bytes. ModelScope is a transport-only entry: it never
 *      supplies metadata (see `bases` vs the candidate list in fetchArtifact).
 *      Layer files use exactly the same candidate list, verified against the
 *      digest their index carries.
 *
 * Override the mirror chain with DSH_APP_GITHUB_MIRRORS (comma-separated
 * URL prefixes; empty value disables mirrors entirely).
 */
export interface ArtifactInfo {
  /** Ordered download candidates (official first, then mirrors, ModelScope last). */
  candidates: string[]
  /** Trusted sha512 (hex) for the tarball, from the phase-1 metadata source. */
  sha512: string
  manifest: KernelManifest
  /** Which base served the metadata (for diagnostics). */
  source: string
}

export interface LayerIndexInfo {
  /**
   * Validated index: the runtime manifest fields plus the per-layer file names
   * and their sha512. It is the trust anchor for the split-layer path.
   */
  index: LayerIndex
  /** Which base served the index (for diagnostics). */
  source: string
}

const RELEASE_TAG_PREFIX = 'runtime-'

/** Default mirror prefixes, tried after the official URL. */
const DEFAULT_GITHUB_MIRRORS = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
]

/**
 * ModelScope FilePath URL for one runtime asset, mirroring CI's layout
 * (`releases/runtime/runtime-<version>/<asset>`). Segment-wise encoding keeps
 * the slashes literal while a crafted version string can neither smuggle
 * `&`/`#` into the query nor turn a literal `+` into a space.
 */
export function modelscopeRuntimeAssetUrl(version: string, assetName: string): string {
  const relativePath = `releases/runtime/${RELEASE_TAG_PREFIX}${version}/${assetName}`
  const encodedPath = relativePath.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  return `${MODELSCOPE_ENDPOINT}/api/v1/models/${MODELSCOPE_REPO}/repo?Revision=master&FilePath=${encodedPath}`
}

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
   * Ordered download candidates for ONE asset of a kernel version: official
   * release first, then each mirror prefix wrapping that URL, then the
   * ModelScope copy. Shared by the tarball and the split-layer paths so both
   * inherit the same transport chain; whatever a candidate serves is still
   * checked against a digest that came from the phase-1 metadata source.
   */
  assetCandidates(version: string, assetName: string): string[] {
    return [
      ...this.bases(version).map((base) => `${base}/${assetName}`),
      modelscopeRuntimeAssetUrl(version, assetName),
    ]
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
      // ModelScope is transport-only: the digest above came from the phase-1
      // metadata chain, so the mirror copy is verified against it like every
      // other candidate.
      candidates: this.assetCandidates(version, name),
      sha512: meta.sha512,
      manifest: meta.manifest,
      source,
    }
  }

  /**
   * Resolve the split-runtime layer index for a kernel version. Returns null
   * when the release publishes no index (an older runtime, or the layer assets
   * are not uploaded yet) — "no layers", which the caller answers by using the
   * single tarball.
   *
   * The metadata discipline of fetchArtifact is unchanged, for a sharper
   * reason: the index carries the sha512 of every layer, so it IS the trust
   * anchor of the layer path. The official host is authoritative and
   * fail-closed (an official HTTP answer, 404 included, is final; mirrors are
   * consulted only when the official host is unreachable at the network level),
   * and ModelScope is never asked for it at all.
   *
   * An index that arrives but does not validate is THROWN, never downgraded to
   * null: silently reporting "no layers" would let a broken or hostile index
   * decide nothing while hiding the fault, and the decision to fall back to the
   * tarball belongs to the caller, made on evidence.
   */
  async fetchLayerIndex(version: string): Promise<LayerIndexInfo | null> {
    const name = layerIndexAssetName(this.platform, this.arch)
    const [officialBase, ...mirrorBases] = this.bases(version)
    const official = await this.fetchIndexOutcome(officialBase, name)
    let info: LayerIndexInfo | null = official.index ? { index: official.index, source: officialBase } : null
    // Mirrors only when the official host answered nothing at all; an official
    // 404 means this release genuinely has no layer set.
    if (!official.reached) {
      for (const base of mirrorBases) {
        const outcome = await this.fetchIndexOutcome(base, name)
        if (outcome.index) {
          info = { index: outcome.index, source: base }
          break
        }
        if (outcome.reached) break
      }
    }
    if (!info) {
      console.warn(`[artifact] no layer index for dsh ${version} on ${this.platform}-${this.arch}`)
    }
    return info
  }

  /**
   * Fetch and validate one base's layer index. `reached` distinguishes "host
   * answered HTTP" from "host unreachable" (fetch threw, or a 5xx) with the
   * same policy as the metadata sidecars, so a sick mirror never ends the chain.
   * A body that does not validate throws (see fetchLayerIndex).
   */
  private async fetchIndexOutcome(
    base: string,
    name: string,
  ): Promise<{ reached: boolean; index: LayerIndex | null }> {
    const url = `${base}/${name}`
    let res: Response
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    } catch (err) {
      console.warn(`[artifact] layer index fetch failed for ${url}: ${(err as Error).message}`)
      return { reached: false, index: null }
    }
    if (res.status >= 500) {
      console.warn(`[artifact] layer index unavailable (HTTP ${res.status}) for ${url}`)
      return { reached: false, index: null }
    }
    if (!res.ok) return { reached: true, index: null }
    let body: unknown
    try {
      body = await res.json()
    } catch (err) {
      throw new Error(t('kernel.layerIndex.invalidJson', { label: url, detail: (err as Error).message }))
    }
    return { reached: true, index: parseLayerIndex(body, url) }
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
