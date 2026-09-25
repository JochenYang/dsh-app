import { promises as fs } from 'node:fs'
import { Readable } from 'node:stream'
import path from 'node:path'
import semver from 'semver'
import * as tar from 'tar'
import type {
  CurrentKernel,
  KernelChannel,
  KernelManifest,
  KernelSource,
  KernelStatusPayload,
  UpdateCheckResult,
} from '../shared/types'
import { KERNEL_REQUIRED_ENTRIES, KERNEL_ROOT_DIR, LAYERS_DIR, LAYER_STAGING_DIR, STAGING_DIR, TARBALL_FILE } from '../shared/constants'
import { t } from '../shared/locale'
import { exists, loadCurrentKernel, readRuntimeManifest, saveCurrentKernel } from './manifest'
import { sha512File, verifyIntegrity } from './integrity'
import { classifyDownloadFailure, describeDownloadFailure } from './failures'
import { assertLayerTarget, missingLayers, readLayerIndex } from './layers'
import type { KernelLayer, LayerIndex } from './layers'
import { tarExtractionFilter } from './tar-entry'
import { findStagedKernel } from './staged'
import type { StagedKernel } from './staged'
import { fetchRegistryInfo } from './sources/registry'
import type { RegistryInfo } from './sources/registry'
import { GitHubArtifactResolver } from './sources/artifact'
import { readDevManifest } from './sources/dev'

/**
 * The first entry a kernel tree no longer carries, or undefined when it is
 * complete enough to start.
 *
 * Only the two entries a start cannot do without are checked (see
 * `KERNEL_REQUIRED_ENTRIES`): a full inventory would cost a walk of tens of
 * thousands of files on every boot, and a tree that lost a leaf file fails in
 * its own diagnostics with the path in hand.
 */
/**
 * `CurrentKernel.active` sentinel for a runtime tree booted in place (see
 * {@link KernelManager.initLocal}). It is deliberately not a directory name
 * under `runtimeRoot` — nothing is installed for such a run — so every path that
 * would treat `active` as one checks it first.
 */
const LOCAL_ACTIVE = 'local'

async function missingKernelEntry(dir: string): Promise<string | undefined> {
  for (const entry of KERNEL_REQUIRED_ENTRIES) {
    if (!(await exists(path.join(dir, ...entry)))) return entry.join('/')
  }
  return undefined
}

export interface KernelManagerOptions {
  /** userData/kernel — holds versioned runtimes + current.json + staging. */
  runtimeRoot: string
  platform: string
  arch: string
  source: KernelSource
  channel: KernelChannel
  /** Required when source === 'dev': path to a deepseek-harness checkout. */
  devCheckoutDir?: string
  /**
   * Required when source !== 'dev': GitHub owner/repo hosting runtime artifacts.
   */
  artifactOwner?: string
  artifactRepo?: string
  /**
   * A runtime tree to boot in place, instead of the installed one — the shape a
   * packaged install has (`node/` + `app/`), named directly by a dev run
   * (`DSH_APP_DEV_KERNEL`). No install, no activation record: `current.json`
   * belongs to the installed kernel and this mode must not touch it.
   */
  localRuntimeDir?: string
  onStatus?: (status: KernelStatusPayload) => void
  log?: (message: string) => void
}

/**
 * One transfer in flight plus its pause latch. The record lives in memory on
 * purpose: a partial file is only ever resumed by the process that paused it,
 * so a `staging/runtime.tgz` left behind by an earlier install or a crash can
 * never be appended to — its bytes may belong to another version, and a
 * spliced file could only fail the digest check afterwards.
 */
interface ActiveDownload {
  url: string
  dest: string
  /** Status message of this transfer (reused when the pause is released). */
  message: string
  /** Bytes flushed to `dest` — also the offset a resume asks the server for. */
  received: number
  /** Size the server announced, or 0 when it announced none. */
  total: number
  /** True between pauseDownload() and resumeDownload(). */
  paused: boolean
  /** Aborts the network read of the attempt in flight. */
  abort: AbortController | null
  /** Releases a parked download loop; set only while the loop is parked. */
  wake: (() => void) | null
}

/**
 * Parse `Content-Range` (`bytes <start>-<end>/<total|*>`). Returns null when it
 * is absent or unusable, which the caller reads as "not a partial body from the
 * offset we asked for".
 */
function parseContentRange(value: string | null): { start: number; total: number | null } | null {
  const match = value === null ? null : /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/u.exec(value.trim())
  if (match === null) return null
  const start = Number(match[1])
  const total = match[3] === '*' ? null : Number(match[3])
  if (!Number.isSafeInteger(start) || (total !== null && !Number.isSafeInteger(total))) return null
  return { start, total }
}

/**
 * Owns the dsh kernel lifecycle: first-run install, update check/download,
 * atomic activation with rollback, and cleanup. The kernel is a versioned,
 * immutable directory; activation is a single atomic rewrite of current.json,
 * so a failed boot can always step back to the previous version.
 */
/**
 * Rename with a short retry.
 *
 * Windows reports EPERM/EBUSY/EACCES while ANY handle to the source or the
 * target is still open, and an antivirus scanner or the search indexer holding
 * a freshly written file for a few hundred milliseconds is enough to trigger it.
 * Both callers below rename a tree that was written moments earlier, so a single
 * attempt makes a first install fail on machines whose scanner is merely slow —
 * observed here as an intermittent `EPERM rename` in the layered-install test.
 *
 * Retrying is safe because `rename` is atomic: the target was removed
 * immediately before, so an attempt can only succeed or fail again. Only the
 * transient codes are retried, and the error is rethrown once attempts run out,
 * so a real permission problem still surfaces.
 */
async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (!transient || attempt >= attempts) throw err
      await new Promise((resolve) => setTimeout(resolve, attempt * 50))
    }
  }
}

export class KernelManager {
  private current: CurrentKernel | null = null
  /** True while an install/update is running — blocks concurrent checks. */
  private installing = false
  /** The transfer in flight (or parked by a pause), or null. */
  private downloadState: ActiveDownload | null = null

  constructor(private readonly opts: KernelManagerOptions) {}

  private get root(): string {
    return path.join(this.opts.runtimeRoot, KERNEL_ROOT_DIR)
  }

  private status(payload: KernelStatusPayload): void {
    this.opts.onStatus?.(payload)
  }

  private log(message: string): void {
    this.opts.log?.(`[kernel] ${message}`)
  }

  /** Emit a status at most ~4/s; always emit when done. Shared by download/extract. */
  private throttledStatus(state: { lastEmit: number }, payload: KernelStatusPayload, done: boolean): void {
    const now = Date.now()
    if (done || now - state.lastEmit >= 250) {
      state.lastEmit = now
      this.status(payload)
    }
  }

  // ----------------------------------------------------------- init / load

  /**
   * Load the currently active kernel into memory: dev mode reads the local
   * checkout manifest; artifact mode reads the on-disk install. Returns null
   * when no usable kernel exists (first run or a broken install) and never
   * performs network or install work, letting the caller choose the path.
   */
  async load(): Promise<CurrentKernel | null> {
    if (this.opts.source === 'dev') return this.initDev()
    if (this.opts.localRuntimeDir !== undefined) return this.initLocal(this.opts.localRuntimeDir)
    this.current = await loadCurrentKernel(this.root)
    if (!this.current) return null
    const dir = this.kernelDir(this.current.active)
    // The directory existing is not the question. A tree that lost its host
    // package or its Node binary boots nothing, and reusing it makes every retry
    // — and the rollback that follows — fail the same way; reporting it like a
    // missing tree sends the caller down the reinstall path it already has.
    const broken = await missingKernelEntry(dir)
    if (broken === undefined) {
      this.log(`active kernel ${this.current.active} present`)
      return this.current
    }
    this.log(`active kernel ${this.current.active} is incomplete (${broken} is missing) — reinstall`)
    this.current = null
    return null
  }

  private async initDev(): Promise<CurrentKernel> {
    const checkout = this.opts.devCheckoutDir
    if (!checkout) throw new Error(t('kernel.devCheckoutMissing'))
    const manifest = await readDevManifest(checkout, this.opts.platform, this.opts.arch)
    this.current = {
      active: 'dev',
      previous: null,
      installedAt: new Date().toISOString(),
      manifest,
    }
    this.log(`dev kernel: dsh ${manifest.dshVersion} at ${checkout}`)
    return this.current
  }

  /**
   * A runtime tree booted in place, named directly by a dev run.
   *
   * Deliberately NOT an install: nothing is written to `current.json`, so a dev
   * run pointed at a locally built runtime cannot disturb — or be disturbed by —
   * the kernel the packaged app is running. The tree is validated the same way an
   * installed one is, so a half-built runtime fails here by name instead of
   * several seconds into a start.
   *
   * @param dir - absolute runtime directory (`node/` + `app/`).
   * @returns the kernel record this run boots.
   * @throws when the manifest or a required entry is missing.
   */
  private async initLocal(dir: string): Promise<CurrentKernel> {
    const manifest = await readRuntimeManifest(dir)
    if (manifest === null) throw new Error(t('kernel.localRuntimeUnreadable', { dir }))
    const broken = await missingKernelEntry(dir)
    if (broken !== undefined) throw new Error(t('kernel.localRuntimeIncomplete', { dir, entry: broken }))
    this.current = {
      active: 'local',
      previous: null,
      installedAt: new Date().toISOString(),
      manifest,
    }
    this.log(`local kernel: dsh ${manifest.dshVersion}+suite ${manifest.suiteVersion} at ${dir}`)
    return this.current
  }

  // ------------------------------------------------------------- discovery

  getCurrent(): CurrentKernel | null {
    return this.current
  }

  /** Absolute path of the active kernel directory ('dev' → the checkout). */
  getCurrentDir(): string {
    if (!this.current) throw new Error(t('kernel.notInitialized'))
    if (this.opts.source === 'dev') return this.opts.devCheckoutDir!
    // A locally named tree has no directory under `runtimeRoot`: `active` is the
    // sentinel 'local' and the path is the one the run was pointed at.
    if (this.current.active === LOCAL_ACTIVE) return this.opts.localRuntimeDir!
    return this.kernelDir(this.current.active)
  }

  /** Absolute path of a versioned kernel directory. */
  kernelDir(versionDir: string): string {
    return path.join(this.root, versionDir)
  }

  /**
   * Check the npm registry for a newer dsh version on the configured channel.
   * In dev mode the kernel is pinned to a local checkout and cannot be
   * auto-installed, but the registry is still queried so the caller can tell
   * the user a newer version exists.
   */
  async checkForUpdate(): Promise<UpdateCheckResult> {
    // An install in progress is already broadcasting its own status; letting a
    // concurrent check run and then broadcast `ready` would clear the download
    // card mid-install. Short-circuit before the status machinery.
    if (this.installing) {
      return {
        available: false,
        current: this.current?.manifest.dshVersion ?? null,
        latest: null,
        channel: this.opts.channel,
        reason: 'install in progress',
      }
    }
    try {
      if (!this.current) {
        return { available: false, current: null, latest: null, channel: this.opts.channel, reason: 'no kernel installed' }
      }
      this.status({ phase: 'checking', message: t('kernel.status.checkKernelUpdate'), progress: null, step: 1 })
      // A prerelease kernel lives on its own dist-tag: `rc` builds on `next`,
      // `alpha` builds on `alpha`. Upstream moves a version line across tags
      // as it matures (alpha → rc → stable), so a single-tag query would
      // strand users once upstream moves on (e.g. alpha stalled at
      // 0.1.2-alpha.5 while 0.1.2-rc.1 shipped on next). Query all three tags
      // up front: the primary line follows the configured channel (with the
      // prerelease fallback below), and any OTHER line carrying something
      // newer than the running kernel is offered as an alternative — the user
      // picks a line instead of only getting the primary update. Explicit
      // DSH_APP_CHANNEL=alpha/beta still pins the primary line to a single
      // tag (dev/testing); stable kernels keep `latest` as primary.
      const currentVersion = this.current.manifest.dshVersion
      const prereleaseTag = semver.valid(currentVersion) !== null
        ? (semver.prerelease(currentVersion) ?? [])[0]
        : undefined
      const isPrerelease = prereleaseTag !== undefined
      const [infoAlpha, infoBeta, infoStable] = await Promise.all([
        fetchRegistryInfo('alpha'),
        fetchRegistryInfo('beta'),
        fetchRegistryInfo('stable'),
      ])
      const byChannel = new Map<KernelChannel, RegistryInfo | null>([
        ['alpha', infoAlpha],
        ['beta', infoBeta],
        ['stable', infoStable],
      ])
      let info: RegistryInfo | null
      let channel: KernelChannel
      if (this.opts.channel !== 'stable') {
        channel = this.opts.channel
        info = byChannel.get(channel) ?? null
      } else if (!isPrerelease) {
        channel = 'stable'
        info = infoStable
      } else {
        const candidates = [infoAlpha, infoBeta, infoStable].filter((c): c is RegistryInfo => c !== null)
        info = candidates.length === 0 ? null
          : candidates.sort((a, b) => {
              const va = semver.valid(a.version)
              const vb = semver.valid(b.version)
              if (va && vb) return semver.compare(va, vb)
              return a.version.localeCompare(b.version)
            })[candidates.length - 1]
        channel = info?.channel ?? 'stable'
      }
      if (!info) {
        return { available: false, current: currentVersion, latest: null, channel, reason: this.opts.source === 'dev' ? 'dev mode' : 'registry unreachable' }
      }
      const newer = semver.valid(info.version) && semver.valid(currentVersion) ? semver.gt(info.version, currentVersion) : info.version !== currentVersion
      this.log(`registry reports dsh ${info.version}; current ${currentVersion}`)
      // Dev mode can detect a newer version but cannot auto-install it (the
      // kernel is a local checkout). Surface the finding so the caller can tell
      // the user; `available` stays false to block the install path.
      if (this.opts.source === 'dev') {
        return { available: false, current: currentVersion, latest: info.version, channel, reason: newer ? 'dev mode update available' : 'dev mode' }
      }
      // A newer version can be published on npm before its runtime artifacts are
      // built (kernel cadence is decoupled from the shell's). Gate on artifact
      // availability so the user is never offered an update that cannot
      // download; auto checks stay silent, manual checks show a friendly reason.
      const resolver = this.makeResolver()
      if (newer) {
        const probe = await resolver.probeArtifact(info.version)
        if (probe !== 'available') {
          const reason = probe === 'unreachable' ? 'github unreachable' : 'artifact pending'
          this.log(`dsh ${info.version} published but runtime artifact not yet available (${probe})`)
          return { available: false, current: currentVersion, latest: info.version, channel, reason }
        }
      }
      // Other lines carrying something newer than the running kernel become
      // user-pickable alternatives (each gated on its own artifact probe, so
      // every offered option is directly installable). Same-version entries
      // across tags (e.g. next and latest pointing at one rc) collapse to the
      // primary line above and are skipped here.
      const alternatives: Array<{ version: string; channel: KernelChannel }> = []
      const seen = new Set(info ? [info.version] : [])
      const pending: RegistryInfo[] = []
      for (const other of [infoAlpha, infoBeta, infoStable]) {
        if (!other || seen.has(other.version)) continue
        seen.add(other.version)
        const otherNewer = semver.valid(other.version) && semver.valid(currentVersion)
          ? semver.gt(other.version, currentVersion)
          : other.version !== currentVersion
        if (otherNewer) pending.push(other)
      }
      const probes = await Promise.all(pending.map((other) => resolver.probeArtifact(other.version)))
      pending.forEach((other, index) => {
        if (probes[index] === 'available') {
          alternatives.push({ version: other.version, channel: other.channel })
        } else {
          this.log(`dsh ${other.version} (${other.channel}) skipped as alternative (${probes[index]})`)
        }
      })
      return {
        available: !!newer,
        current: currentVersion,
        latest: info.version,
        channel,
        alternatives,
      }
    } finally {
      // Terminal status: the in-window card never lingers after a check, on
      // any return path (up to date / dev mode / artifact pending / throw).
      // `ready` renders no card — it only clears the one above.
      this.status({ phase: 'ready', message: t('status.ready'), progress: null })
    }
  }

  // -------------------------------------------------------------- install

  /**
   * The version the configured channel resolves to right now, or null when the
   * question cannot be answered (registry unreachable, or dev mode, where the
   * kernel is a local checkout no channel points at).
   *
   * Separate from installLatest, which resolves again as part of installing:
   * this answers WITHOUT downloading anything, so the boot path can compare it
   * with the kernel bundled in the shell before choosing either (see
   * preferredKernel in kernel/bundled.ts).
   */
  async resolveChannelVersion(): Promise<string | null> {
    if (this.opts.source === 'dev') return null
    const info = await fetchRegistryInfo(this.opts.channel)
    return info?.version ?? null
  }

  /**
   * Install (or update to) a kernel version. Downloads the runtime artifact,
   * verifies its integrity, extracts to a versioned directory, and atomically
   * activates it. Returns the new CurrentKernel.
   *
   * Deliberately re-resolves the registry here instead of reusing a prior
   * checkForUpdate result: the check may be hours old and the dist-tag may
   * have moved since, so install pins whatever the channel points at now.
   */
  async installLatest(reason: string): Promise<CurrentKernel> {
    if (this.opts.source === 'dev') return this.initDev()
    this.status({
      phase: 'checking',
      message: t(reason === 'installing' ? 'kernel.status.prepareInstall' : 'kernel.status.checkUpdate'),
      progress: null,
      step: 1,
    })
    const info = await fetchRegistryInfo(this.opts.channel)
    if (!info) throw new Error(t('kernel.registryUnreachable'))
    return this.installVersion(info.version)
  }

  /**
   * Install a kernel version. Prefers the split-layer path (incremental
   * downloads, layer-cache reuse) and falls back to the single runtime tarball
   * whenever any part of it is unavailable; either way the assembled runtime is
   * verified before activation. See installVersionInner.
   */
  async installVersion(version: string): Promise<CurrentKernel> {
    if (this.opts.source === 'dev') return this.initDev()
    if (this.installing) throw new Error(t('kernel.installBusy'))
    this.installing = true
    try {
      return await this.installVersionInner(version)
    } finally {
      this.installing = false
    }
  }

  private async installVersionInner(version: string): Promise<CurrentKernel> {
    const resolver = this.makeResolver()
    // Split layers first: they turn a dsh release into "download the ~10 MiB
    // `dsh` layer plus whatever else actually changed" instead of the whole
    // ~96 MiB tarball. The layer path is an OPTIMIZATION only — no index
    // published, an index that does not validate, a layer no candidate serves,
    // a digest mismatch everywhere: each of those falls through to the single
    // tarball below, because a client must never fail to install a kernel
    // because the faster path was unavailable.
    try {
      const layered = await this.installVersionFromLayers(version, resolver)
      if (layered) return layered
    } catch (err) {
      this.log(`layer install failed for dsh ${version}, falling back to the single tarball: ${(err as Error).message}`)
      await this.discardLayerStaging()
    }
    return this.installVersionFromTarball(version, resolver)
  }

  /**
   * The single-tarball path: resolve the trusted digest and the candidate list
   * from the release metadata, download the first candidate that both transfers
   * and verifies, then extract and activate. It is also the fallback for every
   * layer fault, and the only path a release without layers can install from.
   */
  private async installVersionFromTarball(version: string, resolver: GitHubArtifactResolver): Promise<CurrentKernel> {
    const artifact = await resolver.fetchArtifact(version)
    if (!artifact) {
      throw new Error(t('kernel.artifactMissing', { version, platform: this.opts.platform, arch: this.opts.arch }))
    }
    if (artifact.manifest.platform !== this.opts.platform || artifact.manifest.arch !== this.opts.arch) {
      throw new Error(t('kernel.artifactPlatformMismatch', {
        artifactPlatform: artifact.manifest.platform,
        artifactArch: artifact.manifest.arch,
        platform: this.opts.platform,
        arch: this.opts.arch,
      }))
    }

    await fs.mkdir(path.join(this.root, STAGING_DIR), { recursive: true })
    const tarball = path.join(this.root, STAGING_DIR, TARBALL_FILE)

    // 1. Download from the first candidate that both transfers and verifies.
    //    The trusted sha512 comes from the release metadata (official host
    //    preferred), so a mirror can never substitute content.
    this.status({ phase: 'downloading', message: t('kernel.status.downloading', { version }), progress: 0, step: 1 })
    let downloadedFrom: string | null = null
    let lastError: Error | null = null
    for (const candidate of artifact.candidates) {
      try {
        await this.download(candidate, tarball)
        const actual = await sha512File(tarball)
        if (!verifyIntegrity(artifact.sha512, actual)) {
          throw new Error(t('kernel.integrityFailed', {
            expected: artifact.sha512.slice(0, 16),
            actual: actual.slice(0, 16),
          }))
        }
        downloadedFrom = candidate
        break
      } catch (err) {
        lastError = err as Error
        this.log(`download candidate failed (${candidate}): ${(err as Error).message}`)
        await fs.rm(tarball, { force: true })
      }
    }
    if (!downloadedFrom) {
      // Layered wording: the failure class decides what the user should DO —
      // fix the network, wait for the release to finish uploading, or stop
      // trusting the path the bytes came through.
      throw new Error(describeDownloadFailure(
        classifyDownloadFailure(lastError),
        artifact.candidates.length,
        lastError?.message ?? null,
      ))
    }

    // 2. (Verified above.) Extract, sanity-check, and activate. The requested
    //    version is bound to the artifact's own manifest: a mirror serving an
    //    older tarball under a versioned URL would otherwise activate a
    //    silently downgraded kernel whose digest is self-consistent.
    const next = await this.activateTarball(tarball, version)
    // Record the verified source hash (mirror side of the download chain);
    // see installFromLocalTarballInner for the comparison semantics.
    next.sha512 = artifact.sha512
    await saveCurrentKernel(this.root, next)
    this.current = next
    return next
  }

  /**
   * Online split-layer install. `current.json.layers` gets the same provenance
   * the local path records, so cleanup() reclaims exactly the cached layers the
   * active install depends on.
   *
   * Returns null when the release publishes no layer index — that is "no
   * layers", not a failure, and the caller answers it with the single tarball.
   */
  private async installVersionFromLayers(
    version: string,
    resolver: GitHubArtifactResolver,
  ): Promise<CurrentKernel | null> {
    const resolved = await resolver.fetchLayerIndex(version)
    if (!resolved) {
      this.log(`dsh ${version} publishes no layer index; using the single tarball`)
      return null
    }
    const index = resolved.index
    // The index decides both WHAT is assembled and HOW it is verified, so a
    // foreign or mislabeled one is refused before a single byte is fetched.
    assertLayerTarget(index, this.opts.platform, this.opts.arch)
    if (index.dshVersion !== version) {
      throw new Error(t('kernel.layerIndexVersionMismatch', { indexVersion: index.dshVersion, version }))
    }
    this.log(`layer index for dsh ${version} from ${resolved.source} (${index.layers.length} layers)`)

    const cacheDir = path.join(this.root, LAYERS_DIR)
    this.status({ phase: 'downloading', message: t('kernel.status.layerCacheVerify'), progress: null, step: 1 })
    const cached = await this.scanLayerCache(index, cacheDir)
    const missing = missingLayers(index, cached)
    if (missing.length === 0) {
      this.log(`all ${index.layers.length} layers served from the cache`)
    } else {
      this.log(`layers to download: ${missing.map((layer) => layer.kind).join(', ')} (${missing.length}/${index.layers.length})`)
      await this.downloadLayers(version, resolver, missing, cacheDir)
    }
    return this.assembleLayers(index, cacheDir)
  }

  /**
   * Which layers of `index` the cache can already supply, as name -> expected
   * digest — the shape `missingLayers` consumes. A cache entry counts only
   * after its digest matches the index: the cache sits on the user's disk, so
   * it is a hint about what NOT to download, never a source of truth about
   * content.
   */
  private async scanLayerCache(index: LayerIndex, cacheDir: string): Promise<Map<string, string>> {
    const cached = new Map<string, string>()
    for (const layer of index.layers) {
      const file = path.join(cacheDir, layer.name)
      if (!(await exists(file))) continue
      const digest = await sha512File(file)
      if (verifyIntegrity(layer.sha512, digest)) cached.set(layer.name, layer.sha512)
    }
    return cached
  }

  /**
   * Fetch the layers the cache cannot supply, each from the first candidate
   * that both transfers and verifies against the digest its index carries. A
   * candidate that 404s, truncates, or serves different bytes is discarded and
   * the next one is tried. Only a fully verified layer is renamed into the
   * cache, so an unverified or substituted download can never become a cache
   * entry — much less reach the assembled runtime.
   */
  private async downloadLayers(
    version: string,
    resolver: GitHubArtifactResolver,
    missing: KernelLayer[],
    cacheDir: string,
  ): Promise<void> {
    const stagingDir = path.join(this.root, STAGING_DIR, LAYER_STAGING_DIR)
    await fs.rm(stagingDir, { recursive: true, force: true })
    await fs.mkdir(stagingDir, { recursive: true })
    await fs.mkdir(cacheDir, { recursive: true })
    let done = 0
    for (const layer of missing) {
      const label = t('kernel.status.layerDownloading', { done: done + 1, total: missing.length })
      const part = path.join(stagingDir, `${layer.name}.part`)
      const candidates = resolver.assetCandidates(version, layer.name)
      this.status({ phase: 'downloading', message: label, progress: done / missing.length, step: 1 })
      let lastError: Error | null = null
      let stored = false
      for (const candidate of candidates) {
        try {
          await this.download(candidate, part, label)
          const digest = await sha512File(part)
          if (!verifyIntegrity(layer.sha512, digest)) {
            throw new Error(t('kernel.integrityFailed', {
              expected: layer.sha512.slice(0, 16),
              actual: digest.slice(0, 16),
            }))
          }
          await renameWithRetry(part, path.join(cacheDir, layer.name))
          stored = true
          break
        } catch (err) {
          lastError = err as Error
          this.log(`layer candidate failed (${candidate}): ${(err as Error).message}`)
          await fs.rm(part, { force: true })
        }
      }
      if (!stored) {
        throw new Error(t('kernel.layerDownloadFailed', {
          name: layer.name,
          detail: describeDownloadFailure(classifyDownloadFailure(lastError), candidates.length, lastError?.message ?? null),
        }))
      }
      done += 1
      this.log(`layer ${layer.name} verified (${layer.kind})`)
    }
    await this.discardLayerStaging()
  }

  /** Drop in-flight layer downloads; a leftover .part is only wasted space. */
  private async discardLayerStaging(): Promise<void> {
    await fs.rm(path.join(this.root, STAGING_DIR, LAYER_STAGING_DIR), { recursive: true, force: true }).catch(() => undefined)
  }

  /**
   * Extract every layer of `index` — already verified in `cacheDir` — into
   * staging, producing the same `<dir>/runtime/...` shape the tgz path yields,
   * and activate it. Shared by the local and the online layer paths so their
   * activation semantics cannot drift; the caller persists the record.
   */
  private async assembleLayers(index: LayerIndex, cacheDir: string): Promise<CurrentKernel> {
    const extractDir = path.join(this.root, STAGING_DIR, 'extract')
    await fs.rm(extractDir, { recursive: true, force: true })
    await fs.mkdir(extractDir, { recursive: true })
    let assembled = 0
    for (const layer of index.layers) {
      this.status({
        phase: 'extracting',
        message: t('kernel.status.assembling', { done: assembled + 1, total: index.layers.length }),
        progress: assembled / index.layers.length,
        step: 2,
      })
      await tar.x({
        file: path.join(cacheDir, layer.name),
        cwd: extractDir,
        filter: tarExtractionFilter,
      })
      assembled += 1
    }

    const next = await this.activateExtracted(path.join(extractDir, 'runtime'), index.dshVersion)
    // Provenance: the layer files this install used, so cleanup() can tell the
    // cache entries the active install depends on from reclaimable ones.
    next.layers = index.layers.map((layer) => ({ name: layer.name, sha512: layer.sha512 }))
    // activateExtracted persisted the record without that provenance, so it is
    // rewritten here. Recording it in the SHARED tail (rather than in each
    // caller) is what keeps a layer install from ever claiming to have none —
    // a record without `layers` tells cleanup() to keep every cached file.
    await saveCurrentKernel(this.root, next)
    this.current = next
    return next
  }

  /**
   * Extract a verified tarball into a versioned runtime dir and atomically
   * activate it. Shared by online install (after download+verify) and local
   * install from a bundled tarball (after sidecar sha512 verify). The caller
   * is responsible for integrity verification before calling this.
   */
  private async activateTarball(tarball: string, expectedVersion: string | null): Promise<CurrentKernel> {
    const extractDir = path.join(this.root, STAGING_DIR, 'extract')
    await fs.rm(extractDir, { recursive: true, force: true })
    await fs.mkdir(extractDir, { recursive: true })
    this.status({ phase: 'extracting', message: t('kernel.status.extracting'), progress: null, step: 2 })
    // One listing pass buys a real denominator: extracting ~10k small files
    // takes minutes on Windows, and an indeterminate spinner over that span
    // reads as a hang. Falls back to indeterminate when listing fails.
    let total = 0
    try {
      await tar.t({ file: tarball, onentry: () => { total += 1 } })
    } catch {
      total = 0
    }
    let extracted = 0
    const throttle = { lastEmit: 0 }
    await tar.x({
      file: tarball,
      cwd: extractDir,
      filter: tarExtractionFilter,
      onentry: () => {
        extracted += 1
        if (total <= 0) return
        this.throttledStatus(throttle, {
          phase: 'extracting',
          message: t('kernel.status.extractingProgress', { done: extracted, total }),
          progress: Math.min(1, extracted / total),
          step: 2,
        }, extracted === total)
      },
    })
    return this.activateExtracted(path.join(extractDir, 'runtime'), expectedVersion)
  }

  /**
   * Move an extracted runtime tree (`<inner>/…`, i.e. the `runtime` dir) into a
   * versioned, immutable directory and activate it atomically, keeping the
   * previous version for rollback. This is the ONE activation tail: the online
   * tgz, bundled tgz and split-layer paths all end here, so their activation
   * semantics (target rm, same-name re-activation, previous bookkeeping,
   * staging cleanup) cannot drift apart. `expectedVersion` binds the artifact
   * to the version its caller asked for — see the version check below.
   */
  private async activateExtracted(inner: string, expectedVersion: string | null): Promise<CurrentKernel> {
    const innerManifest = await readRuntimeManifest(inner)
    if (!innerManifest) throw new Error(t('kernel.manifestMissing'))
    if (innerManifest.platform !== this.opts.platform || innerManifest.arch !== this.opts.arch) {
      throw new Error(t('kernel.artifactPlatformMismatch', {
        artifactPlatform: innerManifest.platform,
        artifactArch: innerManifest.arch,
        platform: this.opts.platform,
        arch: this.opts.arch,
      }))
    }
    // The activation tail is shared, so the version binding lives here rather
    // than in each caller: any path that knows which version it asked for
    // refuses an artifact that declares another. A null binder (a bundled
    // tarball whose own manifest.json is unreadable) keeps the tolerant
    // behavior of the boot drift check, which is version-agnostic.
    if (expectedVersion !== null && innerManifest.dshVersion !== expectedVersion) {
      throw new Error(t('kernel.artifactVersionMismatch', {
        artifactVersion: innerManifest.dshVersion,
        version: expectedVersion,
      }))
    }

    // Move into a versioned, immutable directory. The target is removed first:
    // an existing same-named dir must never be merged into.
    const versionDir = this.versionDirName(innerManifest)
    const target = this.kernelDir(versionDir)
    await fs.rm(target, { recursive: true, force: true })
    await renameWithRetry(inner, target)

    // Activate atomically, keeping the previous version for rollback.
    // Same-name re-activation (bundled content drift) must not point
    // `previous` at itself — nothing to roll back to beyond the new dir.
    this.status({ phase: 'installing', message: t('kernel.status.activating'), progress: null, step: 3 })
    const previous = this.current && this.current.active !== versionDir ? this.current.active : null
    const next: CurrentKernel = {
      active: versionDir,
      previous,
      installedAt: new Date().toISOString(),
      manifest: innerManifest,
    }
    await saveCurrentKernel(this.root, next)
    this.current = next
    this.log(`activated kernel ${versionDir}${previous ? ` (previous ${previous})` : ''}`)

    // Clean staging — best effort. `force` only ignores ENOENT, and on
    // Windows a just-extracted file can still be locked (AV scanner, indexer),
    // which would throw here. Letting that escape would report a SUCCESSFUL
    // activation as a failed install and send the caller into a pointless
    // network reinstall of a kernel that is already active. Same discipline
    // as cleanup(); the staging dir is reclaimed on the next install anyway.
    await fs.rm(path.join(this.root, STAGING_DIR), { recursive: true, force: true }).catch(() => undefined)
    return next
  }

  /**
   * Install the kernel from a tarball bundled inside the app's resources
   * (no network download). The sha512 is read from a sidecar file produced
   * by build-runtime.mjs. Used on first launch so the user need not download
   * the kernel separately.
   */
  async installFromLocalTarball(tarballPath: string, sha512Path: string): Promise<CurrentKernel> {
    if (this.opts.source === 'dev') return this.initDev()
    if (this.installing) throw new Error(t('kernel.installBusy'))
    this.installing = true
    try {
      return await this.installFromLocalTarballInner(tarballPath, sha512Path)
    } finally {
      this.installing = false
    }
  }

  private async installFromLocalTarballInner(tarballPath: string, sha512Path: string): Promise<CurrentKernel> {
    await fs.mkdir(path.join(this.root, STAGING_DIR), { recursive: true })
    const tarball = path.join(this.root, STAGING_DIR, TARBALL_FILE)
    // Copy the bundled tarball into staging so activateTarball's cleanup
    // (rm -rf staging) never deletes the original resource.
    await fs.copyFile(tarballPath, tarball)

    // Verify integrity against the bundled sidecar.
    this.status({ phase: 'extracting', message: t('kernel.status.verifyBundled'), progress: null, step: 1 })
    const expected = (await fs.readFile(sha512Path, 'utf8')).trim().toLowerCase()
    const actual = await sha512File(tarball)
    if (!verifyIntegrity(expected, actual)) {
      throw new Error(t('kernel.bundledIntegrityFailed', {
        expected: expected.slice(0, 16),
        actual: actual.slice(0, 16),
      }))
    }
    this.log(`bundled tarball verified: ${path.basename(tarballPath)}`)
    // The bundle's own manifest is read BEFORE activation so its declared
    // version can bind the artifact (a bundled manifest disagreeing with the
    // tarball's inner manifest is a build fault, not something to activate).
    // A manifest that parses but declares no usable version cannot bind
    // anything: normalize it to null rather than passing `undefined`, which
    // would fail the comparison AND throw inside the localized message.
    const shipped = await readRuntimeManifest(path.dirname(tarballPath))
    const shippedVersion = typeof shipped?.dshVersion === 'string' && shipped.dshVersion !== '' ? shipped.dshVersion : null

    // Fast path: the installer pre-extracted this tarball (verified above) at
    // install time. Moving the staged tree is a rename on the usual layout;
    // the tarball extraction below stays as the fallback for every fault.
    const staged = findStagedKernel()
    if (staged !== null) {
      try {
        this.log(`adopting the installer-staged kernel from ${staged.dir}`)
        const stagedNext = await this.activateStagedKernel(staged, shippedVersion)
        return this.finishLocalInstall(stagedNext, expected, shipped)
      } catch (err) {
        this.log(`staged kernel unusable (${(err as Error).message}); extracting the tarball instead`)
      }
    }

    const next = await this.activateTarball(tarball, shippedVersion)
    // Record the verified source hash and the identity of the bundle itself.
    // The stamp is what the boot drift check compares against: it says WHICH
    // bundled runtime this install adopted, so "already adopted" is
    // distinguishable from "a new shell shipped a different one". It is read
    // from the same manifest.json the boot check reads, so the two can never
    // disagree about what was adopted.
    return this.finishLocalInstall(next, expected, shipped)
  }

  /**
   * Move the installer-staged runtime tree into the kernel root's staging
   * area and run the shared activation tail on it. The stage lives in
   * `resources/` and the kernel root in userData — two different trees that
   * are usually on one volume, so the move is a rename when it can be and a
   * copy when it cannot (a user whose APPDATA sits on another drive).
   */
  private async activateStagedKernel(staged: StagedKernel, expectedVersion: string | null): Promise<CurrentKernel> {
    const extractDir = path.join(this.root, STAGING_DIR, 'extract')
    await fs.rm(extractDir, { recursive: true, force: true })
    await fs.mkdir(extractDir, { recursive: true })
    const destination = path.join(extractDir, 'runtime')
    this.status({ phase: 'installing', message: t('kernel.status.activating'), progress: null, step: 2 })
    try {
      await renameWithRetry(staged.runtime, destination)
    } catch {
      await fs.cp(staged.runtime, destination, { recursive: true })
    }
    return this.activateExtracted(destination, expectedVersion)
  }

  /** The shared tail of a local (bundled) install: record, persist, publish. */
  private async finishLocalInstall(
    next: CurrentKernel,
    expectedSha512: string,
    shipped: Awaited<ReturnType<typeof readRuntimeManifest>>,
  ): Promise<CurrentKernel> {
    // Record the verified source hash and the identity of the bundle itself.
    // The stamp is what the boot drift check compares against: it says WHICH
    // bundled runtime this install adopted, so "already adopted" is
    // distinguishable from "a new shell shipped a different one". It is read
    // from the same manifest.json the boot check reads, so the two can never
    // disagree about what was adopted.
    next.sha512 = expectedSha512
    if (shipped !== null) next.bundledStamp = `${shipped.dshVersion}+${shipped.suiteVersion}`
    await saveCurrentKernel(this.root, next)
    this.current = next
    return next
  }

  /**
   * Install from a directory of pre-split layers plus its `layers.json` index
   * (scripts/split-runtime-layers.mjs). Layer names double as cache keys, so an
   * unchanged layer is reused from `<kernelRoot>/layers/` and only the layers
   * that actually changed are copied in — a dsh release replaces the `dsh`
   * layer (~10 MiB) and nothing else.
   *
   * Fail-closed like the tgz path, and stricter in one way: EVERY layer digest
   * (cache copies included) is verified before the first byte is written, so a
   * tampered or truncated layer can neither reach the cache nor leave a
   * half-assembled runtime, a version directory, or an activation record.
   *
   * The assembled tree goes through assembleLayers() — the same tail the online
   * layer path uses — so activation semantics cannot diverge between them.
   */
  async installFromLocalLayers(layerDir: string): Promise<CurrentKernel> {
    if (this.opts.source === 'dev') return this.initDev()
    if (this.installing) throw new Error(t('kernel.installBusy'))
    this.installing = true
    try {
      return await this.installFromLocalLayersInner(layerDir)
    } finally {
      this.installing = false
    }
  }

  private async installFromLocalLayersInner(layerDir: string): Promise<CurrentKernel> {
    const index = await readLayerIndex(layerDir)
    assertLayerTarget(index, this.opts.platform, this.opts.arch)
    const cacheDir = path.join(this.root, LAYERS_DIR)

    // 1. Which cached copies are already the right bytes? (Digest-checked; see
    //    scanLayerCache.)
    this.status({ phase: 'extracting', message: t('kernel.status.verifyLayers'), progress: null, step: 1 })
    const cached = await this.scanLayerCache(index, cacheDir)
    const missing = missingLayers(index, cached)

    // 2. Verify every layer the cache cannot supply BEFORE writing anything.
    for (const layer of missing) {
      const file = path.join(layerDir, layer.name)
      if (!(await exists(file))) {
        throw new Error(t('kernel.layerMissing', { name: layer.name, dir: layerDir }))
      }
      const digest = await sha512File(file)
      if (!verifyIntegrity(layer.sha512, digest)) {
        throw new Error(t('kernel.layerIntegrityFailed', {
          name: layer.name,
          expected: layer.sha512.slice(0, 16),
          actual: digest.slice(0, 16),
        }))
      }
    }

    // 3. Fill the cache. copyFile is not atomic, but a half-copied entry cannot
    //    survive: the next install re-verifies the digest above and replaces it.
    await fs.mkdir(cacheDir, { recursive: true })
    for (const layer of missing) {
      await fs.copyFile(path.join(layerDir, layer.name), path.join(cacheDir, layer.name))
    }
    if (missing.length > 0) {
      this.log(`cached ${missing.length}/${index.layers.length} layers (${missing.map((layer) => layer.kind).join(', ')})`)
    }

    // 4. Assemble into staging from the CACHE — which now holds the verified
    //    copy of every layer — producing the same `<dir>/runtime/...` shape the
    //    tgz path yields.
    const next = await this.assembleLayers(index, cacheDir)
    // Adoption stamp, same rule as the bundled tgz path: only a manifest
    // shipped beside the layers identifies a bundle the shell itself ships, so
    // a downloaded layer set never claims it was adopted from resources.
    const shipped = await readRuntimeManifest(layerDir)
    if (shipped !== null) next.bundledStamp = `${shipped.dshVersion}+${shipped.suiteVersion}`
    await saveCurrentKernel(this.root, next)
    this.current = next
    return next
  }

  private versionDirName(manifest: KernelManifest): string {
    return `dsh-${manifest.dshVersion}+suite-${manifest.suiteVersion}`
  }

  private makeResolver(): GitHubArtifactResolver {
    const { artifactOwner, artifactRepo } = this.opts
    if (!artifactOwner || !artifactRepo) throw new Error(t('kernel.artifactSourceConfig'))
    return new GitHubArtifactResolver(artifactOwner, artifactRepo, this.opts.platform, this.opts.arch)
  }

  // ------------------------------------------------------- download control

  /**
   * True while the download in flight is paused by the user. False when no
   * download is running — a paused install is the only paused state there is.
   */
  isDownloadPaused(): boolean {
    return this.downloadState?.paused === true
  }

  /**
   * Pause the download in flight: stop reading the network, keep every byte
   * already on disk (partial file included) and hold the install where it is
   * until resumeDownload() — a paused install is suspended, not failed, so the
   * caller's `await installVersion(...)` stays pending instead of rejecting
   * into the candidate fallback chain. A no-op (returns false) when no download
   * is running or it is already paused, because a button press can race a
   * status refresh.
   */
  pauseDownload(): boolean {
    const state = this.downloadState
    if (!state || state.paused) return false
    state.paused = true
    state.wake = null
    state.abort?.abort()
    // Phase stays 'downloading' — only `paused` distinguishes a suspended
    // transfer from a running one, and the progress is the frozen value.
    // The step stays 1 for the same reason: a transfer IS step 1.
    this.status({
      phase: 'downloading',
      message: t('kernel.status.paused'),
      progress: state.total > 0 ? Math.min(1, state.received / state.total) : null,
      paused: true,
      step: 1,
    })
    this.log(`download paused at ${String(state.received)} bytes: ${state.url}`)
    return true
  }

  /**
   * Release a pause: the transfer continues with `Range: bytes=<received>-`
   * appended to the same file (or restarts from zero when the server does not
   * honor the range — see download()). A no-op (returns false) when nothing is
   * paused.
   */
  resumeDownload(): boolean {
    const state = this.downloadState
    if (!state || !state.paused) return false
    state.paused = false
    const wake = state.wake
    state.wake = null
    this.status({
      phase: 'downloading',
      message: state.message,
      progress: state.total > 0 ? Math.min(1, state.received / state.total) : null,
      paused: false,
      step: 1,
    })
    this.log(`download resumed at ${String(state.received)} bytes: ${state.url}`)
    // A missing wake means the loop is still unwinding the aborted read; it
    // re-checks `paused` before parking and will find it cleared.
    wake?.()
    return true
  }

  /**
   * Download `url` to `dest`, suspendable by pauseDownload()/resumeDownload().
   *
   * Pausing aborts the network read but not the call: the bytes already flushed
   * stay in `dest`, no further chunk is written or reported, and the loop parks
   * until the pause is released. A resumed attempt asks for
   * `Range: bytes=<received>-` and appends — but only when the server agrees
   * that it is answering that range (206 with a Content-Range starting exactly
   * there). A server that ignores the range answers 200 with the whole body,
   * and appending that to a partial file would splice two bodies into one file
   * that can never match the digest, so the partial file is dropped and the
   * download restarts from zero instead. Every byte still ends up verified by
   * the caller (sha512, or the layer digest) exactly as before.
   */
  private async download(url: string, dest: string, message = t('kernel.status.downloadingDefault')): Promise<void> {
    const state: ActiveDownload = {
      url, dest, message, received: 0, total: 0, paused: false, abort: null, wake: null,
    }
    this.downloadState = state
    try {
      for (;;) {
        const paused = await this.downloadAttempt(state)
        if (!paused) return
        // Park until resumeDownload(). The check lives inside the executor so
        // that a pause already released (the abort above is delivered
        // asynchronously) cannot leave the loop waiting for a wake that will
        // never come.
        await new Promise<void>((resolve) => {
          if (state.paused) state.wake = resolve
          else resolve()
        })
      }
    } finally {
      if (this.downloadState === state) this.downloadState = null
      state.abort = null
      state.wake = null
    }
  }

  /**
   * One HTTP request for `state`, appending from `state.received`. Returns true
   * when a pause ended the request (bytes kept, `received` still the offset a
   * resume continues from), false when the body was read to its end.
   */
  private async downloadAttempt(state: ActiveDownload): Promise<boolean> {
    // A pause requested between attempts — while the loop was being released,
    // before this one started — is honored here: nothing is requested at all,
    // the loop simply parks again.
    if (state.paused) return true
    const offset = state.received
    const abort = new AbortController()
    state.abort = abort
    // The 5-minute cap is per REQUEST, not per download: time spent paused is
    // not charged to the transfer and a resumed request gets a fresh budget.
    // AbortSignal.any keeps the timeout's own reason (TimeoutError) intact.
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(300_000)])
    const headers: Record<string, string> = {}
    if (offset > 0) headers.Range = `bytes=${String(offset)}-`
    let res: Response
    try {
      res = await fetch(state.url, { signal, headers })
    } catch (err) {
      // A pause must not reach the caller as a failure: the candidate chains
      // would read it as a dead source and move to the next mirror.
      if (state.paused) return true
      throw err
    }
    if (!res.ok || !res.body) throw new Error(t('kernel.downloadHttpFailed', { status: res.status }))
    const length = Number(res.headers.get('content-length') ?? 0)
    const range = parseContentRange(res.headers.get('content-range'))
    let appending = false
    let total = length
    if (offset > 0 && res.status === 206 && range !== null && range.start === offset) {
      appending = true
      total = range.total ?? offset + length
    } else if (offset > 0) {
      this.log(`resume refused (HTTP ${res.status}) — restarting ${path.basename(state.dest)} from 0`)
    }
    const body = Readable.fromWeb(res.body as never)
    // 'w' covers both a fresh download and a refused resume: the file is
    // truncated, never appended to, so no earlier bytes can survive into it.
    const out = await fs.open(state.dest, appending ? 'a' : 'w')
    state.total = total
    if (!appending) state.received = 0
    const throttle = { lastEmit: 0 }
    // F20: cap a single runtime download (typical ~160 MB) at 1 GiB.
    const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024
    try {
      if (total > MAX_DOWNLOAD_BYTES) throw new Error(t('kernel.downloadTooLarge', { bytes: total }))
      for await (const chunk of body) {
        state.received += chunk.length
        await out.write(chunk)
        // Throttled (~4/s): each status re-renders the in-window card and tray tooltip.
        if (total > 0) {
          if (state.received > MAX_DOWNLOAD_BYTES) throw new Error(t('kernel.downloadTooLargeReceived', { bytes: state.received }))
          this.throttledStatus(throttle, {
            phase: 'downloading',
            message: state.message,
            progress: Math.min(1, state.received / total),
            step: 1,
          }, state.received === total)
        }
      }
    } catch (err) {
      // The file is closed by the `finally` below before the pause is reported
      // as parked, so nothing can write to it while paused.
      if (state.paused) return true
      throw err
    } finally {
      await out.close()
    }
    // A pause landing after the last byte has nothing left to suspend: the
    // transfer is complete, so the install carries on.
    state.paused = false
    return false
  }

  // -------------------------------------------------------------- rollback

  /**
   * Point current.json back at the previous kernel version. Called by the
   * shell when the freshly activated kernel fails to boot.
   */
  async rollback(): Promise<CurrentKernel | null> {
    if (!this.current?.previous) return null
    const previousDir = this.current.previous
    const manifest = await readRuntimeManifest(this.kernelDir(previousDir))
    if (!manifest) throw new Error(t('kernel.rollbackManifestMissing', { dir: previousDir }))
    const rollbackTo: CurrentKernel = {
      active: previousDir,
      previous: null,
      installedAt: new Date().toISOString(),
      manifest,
    }
    await saveCurrentKernel(this.root, rollbackTo)
    this.current = rollbackTo
    // No step: a rollback is a recovery, and the splash is either gone by then
    // or sitting on the step the failed boot stopped at.
    this.status({ phase: 'rollback', message: t('kernel.rolledBack', { dir: previousDir }), progress: null })
    this.log(`rolled back to ${previousDir}`)
    return rollbackTo
  }

  /**
   * Remove versioned dirs that are neither active nor previous, and staging.
   * The layer cache is deliberately NOT swept as a version directory — it holds
   * the layers an update reuses and follows its own policy in pruneLayers().
   */
  async cleanup(): Promise<void> {
    // Dev mode: the "kernel" is the local checkout; the versioned dir under
    // root is a production install owned by artifact mode. Never touch it —
    // wiping it during a dev boot deletes a production kernel that a later
    // non-dev start still depends on (current.json keeps pointing at the
    // removed dir and forces a broken reinstall).
    if (this.opts.source === 'dev') return
    // A locally named runtime is the same situation, and a sharper one: its
    // `active` is a sentinel that matches no directory, so `keep` below would
    // protect NOTHING and this run would prune the very install a packaged start
    // depends on. A dev run has no business touching the installed kernel.
    if (this.opts.localRuntimeDir !== undefined) return
    // Never race an install/update: cleanup's `rm -rf staging` would destroy
    // the in-flight download (open 'staging/runtime.tgz' → ENOENT) when a
    // server restart fires during a kernel update — exactly what happens in
    // a crash/restart loop. activateExtracted already removes staging at the
    // end, and the post-boot cleanup (startServerAndOpenWindow) runs when no
    // install is active.
    if (this.installing) return
    const keep = new Set<string>()
    if (this.current) {
      keep.add(this.current.active)
      if (this.current.previous) keep.add(this.current.previous)
    }
    const entries = await fs.readdir(this.root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(this.root, entry.name)
      if (entry.isDirectory() && !keep.has(entry.name) && entry.name !== STAGING_DIR && entry.name !== LAYERS_DIR) {
        await fs.rm(full, { recursive: true, force: true }).catch(() => undefined)
        this.log(`cleaned up ${entry.name}`)
      }
    }
    await fs.rm(path.join(this.root, STAGING_DIR), { recursive: true, force: true }).catch(() => undefined)
    await this.pruneLayers()
  }

  /**
   * Reclaim layer cache entries the active install does not reference.
   *
   * What must be kept is exactly the ACTIVE record's layer set: node/vendor/meta
   * are content-addressed, so their names survive a dsh bump and the next update
   * reuses them, while dsh/suite change name on every release they should. A
   * version directory that is no longer active does not need its layers — it is
   * already extracted and immutable, and rollback only repoints current.json —
   * so those files are reclaimable, at the cost of re-copying them if that exact
   * version is ever installed again.
   *
   * Never runs during an install: cleanup() returns early while an install is in
   * flight, and an install is filling this very directory.
   */
  private async pruneLayers(): Promise<void> {
    const keep = new Set((this.current?.layers ?? []).map((layer) => layer.name))
    // A record without layer provenance (written before layers existed, or by a
    // tgz install) names nothing to keep, so nothing is reclaimed: we cannot tell
    // which entries such an install could still reuse, and keeping one bounded
    // layer set is far better than dropping a reusable cache.
    if (keep.size === 0) return
    const cacheDir = path.join(this.root, LAYERS_DIR)
    const entries = await fs.readdir(cacheDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile() || keep.has(entry.name)) continue
      await fs.rm(path.join(cacheDir, entry.name), { force: true }).catch(() => undefined)
      this.log(`reclaimed layer ${entry.name}`)
    }
  }

}
