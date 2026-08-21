import { promises as fs } from 'node:fs'
import { Readable } from 'node:stream'
import { once } from 'node:events'
import path from 'node:path'
import semver from 'semver'
import * as tar from 'tar'
import type {
  CurrentKernel,
  KernelChannel,
  KernelManifest,
  KernelSource,
  KernelStatusPayload,
  ServerSpec,
  UpdateCheckResult,
} from '../shared/types'
import { CURRENT_FILE, KERNEL_ROOT_DIR, STAGING_DIR, TARBALL_FILE } from '../shared/constants'
import { exists, loadCurrentKernel, readRuntimeManifest, saveCurrentKernel } from './manifest'
import { sha512File, verifyIntegrity } from './integrity'
import { fetchRegistryInfo } from './sources/registry'
import { GitHubArtifactResolver } from './sources/artifact'
import { readDevManifest } from './sources/dev'

export interface KernelManagerOptions {
  /** userData/kernel — holds versioned runtimes + current.json + staging. */
  runtimeRoot: string
  platform: string
  arch: string
  source: KernelSource
  channel: KernelChannel
  /** Required when source === 'dev': path to a deepseek-harness checkout. */
  devCheckoutDir?: string
  /** Required when source !== 'dev': GitHub owner/repo hosting runtime artifacts. */
  artifactOwner?: string
  artifactRepo?: string
  onStatus?: (status: KernelStatusPayload) => void
  log?: (message: string) => void
}

/**
 * Owns the dsh kernel lifecycle: first-run install, update check/download,
 * atomic activation with rollback, and cleanup. The kernel is a versioned,
 * immutable directory; activation is a single atomic rewrite of current.json,
 * so a failed boot can always step back to the previous version.
 */
export class KernelManager {
  private current: CurrentKernel | null = null
  private cancelRequested = false
  /** True while an install/update is running — blocks concurrent checks. */
  private installing = false

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

  // ----------------------------------------------------------- init / load

  /**
   * Load the currently active kernel into memory: dev mode reads the local
   * checkout manifest; artifact mode reads the on-disk install. Returns null
   * when no usable kernel exists (first run or a broken install) and never
   * performs network or install work, letting the caller choose the path.
   */
  async load(): Promise<CurrentKernel | null> {
    if (this.opts.source === 'dev') return this.initDev()
    this.current = await loadCurrentKernel(this.root)
    if (!this.current) return null
    if (await exists(this.kernelDir(this.current.active))) {
      this.log(`active kernel ${this.current.active} present`)
      return this.current
    }
    this.log(`active kernel ${this.current.active} missing — reinstall`)
    this.current = null
    return null
  }

  private async initDev(): Promise<CurrentKernel> {
    const checkout = this.opts.devCheckoutDir
    if (!checkout) throw new Error('dev source requires devCheckoutDir')
    const manifest = await readDevManifest(checkout)
    this.current = {
      active: 'dev',
      previous: null,
      installedAt: new Date().toISOString(),
      manifest,
    }
    this.log(`dev kernel: dsh ${manifest.dshVersion} at ${checkout}`)
    return this.current
  }

  // ------------------------------------------------------------- discovery

  getCurrent(): CurrentKernel | null {
    return this.current
  }

  /** Absolute path of the active kernel directory ('dev' → the checkout). */
  getCurrentDir(): string {
    if (!this.current) throw new Error('kernel not initialized')
    if (this.opts.source === 'dev') return this.opts.devCheckoutDir!
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
      this.status({ phase: 'checking', message: '正在检查内核更新…', progress: null })
      // A prerelease version (e.g. 0.1.0-rc.7) lives on the `next` dist-tag, so
      // it can only see newer prereleases through the beta channel. Auto-switch
      // when the user is on a prerelease but configured for stable — otherwise
      // the `latest` tag never carries rc builds and the check always says "up
      // to date" even when a newer rc shipped.
      const currentVersion = this.current.manifest.dshVersion
      const isPrerelease = semver.valid(currentVersion) !== null && semver.prerelease(currentVersion) !== null
      const channel = isPrerelease && this.opts.channel === 'stable' ? 'beta' : this.opts.channel
      const info = await fetchRegistryInfo(channel)
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
      if (newer) {
        const probe = await this.makeResolver().probeArtifact(info.version)
        if (probe !== 'available') {
          const reason = probe === 'unreachable' ? 'github unreachable' : 'artifact pending'
          this.log(`dsh ${info.version} published but runtime artifact not yet available (${probe})`)
          return { available: false, current: currentVersion, latest: info.version, channel, reason }
        }
      }
      return {
        available: !!newer,
        current: currentVersion,
        latest: info.version,
        channel,
      }
    } finally {
      // Terminal status: the in-window card never lingers after a check, on
      // any return path (up to date / dev mode / artifact pending / throw).
      // `ready`/`就绪` renders no card — it only clears the one above.
      this.status({ phase: 'ready', message: '就绪', progress: null })
    }
  }

  // -------------------------------------------------------------- install

  /**
   * Install (or update to) a kernel version. Downloads the runtime artifact,
   * verifies its integrity, extracts to a versioned directory, and atomically
   * activates it. Returns the new CurrentKernel.
   */
  async installLatest(reason: string): Promise<CurrentKernel> {
    if (this.opts.source === 'dev') return this.initDev()
    this.cancelRequested = false
    this.status({ phase: 'checking', message: reason === 'installing' ? '正在准备首次安装…' : '正在检查更新…', progress: null })
    const info = await fetchRegistryInfo(this.opts.channel)
    if (!info) throw new Error('无法连接 npm 注册表以解析 dsh 版本')
    return this.installVersion(info.version)
  }

  async installVersion(version: string): Promise<CurrentKernel> {
    if (this.opts.source === 'dev') return this.initDev()
    if (this.installing) throw new Error('内核安装正在进行中，请稍候')
    this.installing = true
    try {
      return await this.installVersionInner(version)
    } finally {
      this.installing = false
    }
  }

  private async installVersionInner(version: string): Promise<CurrentKernel> {
    const resolver = this.makeResolver()
    const artifact = await resolver.fetchArtifact(version)
    if (!artifact) throw new Error(`未找到 dsh ${version} 在 ${this.opts.platform}-${this.opts.arch} 上的运行时产物`)

    await fs.mkdir(path.join(this.root, STAGING_DIR), { recursive: true })
    const tarball = path.join(this.root, STAGING_DIR, TARBALL_FILE)
    const extractDir = path.join(this.root, STAGING_DIR, 'extract')

    // 1. Download from the first candidate that both transfers and verifies.
    //    The trusted sha512 comes from the release metadata (official host
    //    preferred), so a mirror can never substitute content.
    this.status({ phase: 'downloading', message: `正在下载 dsh ${version}…`, progress: 0 })
    let downloadedFrom: string | null = null
    let lastError: Error | null = null
    for (const candidate of artifact.candidates) {
      try {
        await this.download(candidate, tarball)
        const actual = await sha512File(tarball)
        if (!verifyIntegrity(artifact.sha512, actual)) {
          throw new Error(`完整性校验失败（期望 ${artifact.sha512.slice(0, 16)}…，实际 ${actual.slice(0, 16)}…）`)
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
      throw new Error(`dsh ${version} 下载失败（已尝试 ${artifact.candidates.length} 个源）：${lastError?.message ?? '未知错误'}`)
    }

    // 2. (Verified above.) Extract, sanity-check, and activate.
    return this.activateTarball(tarball)
  }

  /**
   * Extract a verified tarball into a versioned runtime dir and atomically
   * activate it. Shared by online install (after download+verify) and local
   * install from a bundled tarball (after sidecar sha512 verify). The caller
   * is responsible for integrity verification before calling this.
   */
  private async activateTarball(tarball: string): Promise<CurrentKernel> {
    const extractDir = path.join(this.root, STAGING_DIR, 'extract')
    await fs.rm(extractDir, { recursive: true, force: true })
    await fs.mkdir(extractDir, { recursive: true })
    this.status({ phase: 'extracting', message: '正在解压运行时…', progress: null })
    await tar.x({ file: tarball, cwd: extractDir })
    const inner = path.join(extractDir, 'runtime')
    const innerManifest = await readRuntimeManifest(inner)
    if (!innerManifest) throw new Error('运行时产物缺少 manifest.json')
    if (innerManifest.platform !== this.opts.platform || innerManifest.arch !== this.opts.arch) {
      throw new Error(`产物平台不匹配：${innerManifest.platform}-${innerManifest.arch} 与 ${this.opts.platform}-${this.opts.arch}`)
    }

    // 3. Move into a versioned, immutable directory.
    const versionDir = this.versionDirName(innerManifest)
    const target = this.kernelDir(versionDir)
    await fs.rm(target, { recursive: true, force: true })
    await fs.rename(inner, target)

    // 4. Activate atomically, keeping the previous version for rollback.
    this.status({ phase: 'installing', message: '正在激活运行时…', progress: null })
    const previous = this.current ? this.current.active : null
    const next: CurrentKernel = {
      active: versionDir,
      previous,
      installedAt: new Date().toISOString(),
      manifest: innerManifest,
    }
    await saveCurrentKernel(this.root, next)
    this.current = next
    this.log(`activated kernel ${versionDir}${previous ? ` (previous ${previous})` : ''}`)

    // 5. Clean staging.
    await fs.rm(path.join(this.root, STAGING_DIR), { recursive: true, force: true })
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
    if (this.installing) throw new Error('内核安装正在进行中，请稍候')
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
    this.status({ phase: 'extracting', message: '正在校验内置运行时…', progress: null })
    const expected = (await fs.readFile(sha512Path, 'utf8')).trim().toLowerCase()
    const actual = await sha512File(tarball)
    if (!verifyIntegrity(expected, actual)) {
      throw new Error(`内置运行时完整性校验失败（期望 ${expected.slice(0, 16)}…，实际 ${actual.slice(0, 16)}…）`)
    }
    this.log(`bundled tarball verified: ${path.basename(tarballPath)}`)
    return this.activateTarball(tarball)
  }

  private versionDirName(manifest: KernelManifest): string {
    return `dsh-${manifest.dshVersion}+suite-${manifest.suiteVersion}`
  }

  private makeResolver(): GitHubArtifactResolver {
    const { artifactOwner, artifactRepo } = this.opts
    if (!artifactOwner || !artifactRepo) throw new Error('artifact source requires artifactOwner/artifactRepo')
    return new GitHubArtifactResolver(artifactOwner, artifactRepo, this.opts.platform, this.opts.arch)
  }

  private async download(url: string, dest: string): Promise<void> {
    const res = await fetch(url, { signal: AbortSignal.timeout(300_000) })
    if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length') ?? 0)
    const body = Readable.fromWeb(res.body as never)
    const out = await fs.open(dest, 'w')
    let received = 0
    let lastEmit = 0
    try {
      for await (const chunk of body) {
        if (this.cancelRequested) throw new Error('下载已取消')
        received += chunk.length
        await out.write(chunk)
        // Throttle status broadcasts (~4/s): each one re-renders the in-window
        // card and the tray tooltip, and a 160 MB download would otherwise
        // fire thousands of IPCs per second on small chunks.
        if (total > 0) {
          const now = Date.now()
          if (received === total || now - lastEmit >= 250) {
            lastEmit = now
            this.status({ phase: 'downloading', message: '正在下载 dsh…', progress: Math.min(1, received / total) })
          }
        }
      }
    } finally {
      await out.close()
    }
  }

  requestCancel(): void {
    this.cancelRequested = true
  }

  // -------------------------------------------------------------- rollback

  /**
   * Point current.json back at the previous kernel version. Called by the
   * shell when the freshly activated kernel fails to boot.
   */
  async rollback(): Promise<CurrentKernel | null> {
    if (!this.current?.previous) return null
    const previousDir = this.current.previous
    const rollbackTo: CurrentKernel = {
      active: previousDir,
      previous: null,
      installedAt: new Date().toISOString(),
      manifest: this.current.manifest, // replaced below by the real manifest
    }
    const manifest = await readRuntimeManifest(this.kernelDir(previousDir))
    if (manifest) rollbackTo.manifest = manifest
    await saveCurrentKernel(this.root, rollbackTo)
    this.current = rollbackTo
    this.status({ phase: 'rollback', message: `已回滚到 ${previousDir}`, progress: null })
    this.log(`rolled back to ${previousDir}`)
    return rollbackTo
  }

  /** Remove versioned dirs that are neither active nor previous, and staging. */
  async cleanup(): Promise<void> {
    // Dev mode: the "kernel" is the local checkout; the versioned dir under
    // root is a production install owned by artifact mode. Never touch it —
    // wiping it during a dev boot deletes a production kernel that a later
    // non-dev start still depends on (current.json keeps pointing at the
    // removed dir and forces a broken reinstall).
    if (this.opts.source === 'dev') return
    const keep = new Set<string>()
    if (this.current) {
      keep.add(this.current.active)
      if (this.current.previous) keep.add(this.current.previous)
    }
    const entries = await fs.readdir(this.root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(this.root, entry.name)
      if (entry.isDirectory() && !keep.has(entry.name) && entry.name !== STAGING_DIR) {
        await fs.rm(full, { recursive: true, force: true }).catch(() => undefined)
        this.log(`cleaned up ${entry.name}`)
      }
    }
    await fs.rm(path.join(this.root, STAGING_DIR), { recursive: true, force: true }).catch(() => undefined)
  }

  // -------------------------------------------------------------- server

  /** How the shell should spawn the dsh server for the active kernel. */
  getServerSpec(): ServerSpec {
    if (this.opts.source === 'dev') {
      return { kind: 'pnpm', cwd: this.opts.devCheckoutDir! }
    }
    const dir = this.getCurrentDir()
    const nodePath = path.join(dir, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
    return {
      kind: 'node',
      nodePath,
      scriptPath: path.join(dir, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      cwd: path.join(dir, 'app'),
    }
  }

  /** Resolve the artifact host for the current source (for UI display). */
  describeSource(): string {
    return this.opts.source === 'dev'
      ? `dev:${this.opts.devCheckoutDir}`
      : `${this.opts.artifactOwner}/${this.opts.artifactRepo} (${this.opts.channel})`
  }
}
