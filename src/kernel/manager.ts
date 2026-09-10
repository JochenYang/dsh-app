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
  ServerSpec,
  UpdateCheckResult,
} from '../shared/types'
import { KERNEL_ROOT_DIR, STAGING_DIR, TARBALL_FILE } from '../shared/constants'
import { exists, loadCurrentKernel, readRuntimeManifest, saveCurrentKernel } from './manifest'
import { sha512File, verifyIntegrity } from './integrity'
import { fetchRegistryInfo } from './sources/registry'
import type { RegistryInfo } from './sources/registry'
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
    if (!checkout) throw new Error('开发模式需要配置 devCheckoutDir（本地 deepseek-harness 源码目录）')
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

  // ------------------------------------------------------------- discovery

  getCurrent(): CurrentKernel | null {
    return this.current
  }

  /** Absolute path of the active kernel directory ('dev' → the checkout). */
  getCurrentDir(): string {
    if (!this.current) throw new Error('内核尚未初始化')
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
      // `ready`/`就绪` renders no card — it only clears the one above.
      this.status({ phase: 'ready', message: '就绪', progress: null })
    }
  }

  // -------------------------------------------------------------- install

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
    if (artifact.manifest.platform !== this.opts.platform || artifact.manifest.arch !== this.opts.arch) {
      throw new Error(`产物平台不匹配：${artifact.manifest.platform}-${artifact.manifest.arch} 与 ${this.opts.platform}-${this.opts.arch}`)
    }

    await fs.mkdir(path.join(this.root, STAGING_DIR), { recursive: true })
    const tarball = path.join(this.root, STAGING_DIR, TARBALL_FILE)

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
    const next = await this.activateTarball(tarball)
    // Record the verified source hash (mirror side of the download chain);
    // see installFromLocalTarballInner for the comparison semantics.
    next.sha512 = artifact.sha512
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
  private async activateTarball(tarball: string): Promise<CurrentKernel> {
    const extractDir = path.join(this.root, STAGING_DIR, 'extract')
    await fs.rm(extractDir, { recursive: true, force: true })
    await fs.mkdir(extractDir, { recursive: true })
    this.status({ phase: 'extracting', message: '正在解压运行时…', progress: null })
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
      filter: (entryPath) => !path.isAbsolute(entryPath) && !entryPath.split('/').includes('..'),
      onentry: () => {
        extracted += 1
        if (total <= 0) return
        this.throttledStatus(throttle, {
          phase: 'extracting',
          message: `正在解压运行时…（${extracted}/${total}）`,
          progress: Math.min(1, extracted / total),
        }, extracted === total)
      },
    })
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
    //    Same-name re-activation (bundled content drift) must not point
    //    `previous` at itself — nothing to roll back to beyond the new dir.
    this.status({ phase: 'installing', message: '正在激活运行时…', progress: null })
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

    // 5. Clean staging — best effort. `force` only ignores ENOENT, and on
    //    Windows a just-extracted file can still be locked (AV scanner, indexer),
    //    which would throw here. Letting that escape would report a SUCCESSFUL
    //    activation as a failed install and send the caller into a pointless
    //    network reinstall of a kernel that is already active. Same discipline
    //    as cleanup(); the staging dir is reclaimed on the next install anyway.
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
    const next = await this.activateTarball(tarball)
    // Record the verified source hash and the identity of the bundle itself.
    // The stamp is what the boot drift check compares against: it says WHICH
    // bundled runtime this install adopted, so "already adopted" is
    // distinguishable from "a new shell shipped a different one". It is read
    // from the same manifest.json the boot check reads, so the two can never
    // disagree about what was adopted.
    next.sha512 = expected
    const shipped = await readRuntimeManifest(path.dirname(tarballPath))
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
    if (!artifactOwner || !artifactRepo) throw new Error('制品源需要配置 artifactOwner/artifactRepo（GitHub 仓库）')
    return new GitHubArtifactResolver(artifactOwner, artifactRepo, this.opts.platform, this.opts.arch)
  }

  private async download(url: string, dest: string): Promise<void> {
    const res = await fetch(url, { signal: AbortSignal.timeout(300_000) })
    if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length') ?? 0)
    const body = Readable.fromWeb(res.body as never)
    const out = await fs.open(dest, 'w')
    let received = 0
    const throttle = { lastEmit: 0 }
    // F20: cap a single runtime download (typical ~160 MB) at 1 GiB.
    const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024
    if (total > MAX_DOWNLOAD_BYTES) throw new Error(`下载失败：安装包过大（${total} 字节）`)
    try {
      for await (const chunk of body) {
        // TODO: wire download cancellation from the shell (tray/close) when a cancel UI exists.
        received += chunk.length
        await out.write(chunk)
        // Throttled (~4/s): each status re-renders the in-window card and tray tooltip.
        if (total > 0) {
          if (received > MAX_DOWNLOAD_BYTES) throw new Error(`下载失败：安装包过大（已接收 ${received} 字节）`)
          this.throttledStatus(throttle, { phase: 'downloading', message: '正在下载 dsh…', progress: Math.min(1, received / total) }, received === total)
        }
      }
    } finally {
      await out.close()
    }
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
    if (!manifest) throw new Error(`回滚失败：上一个内核 ${previousDir} 缺少 manifest.json`)
    const rollbackTo: CurrentKernel = {
      active: previousDir,
      previous: null,
      installedAt: new Date().toISOString(),
      manifest,
    }
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
    // Never race an install/update: cleanup's `rm -rf staging` would destroy
    // the in-flight download (open 'staging/runtime.tgz' → ENOENT) when a
    // server restart fires during a kernel update — exactly what happens in
    // a crash/restart loop. activateTarball already removes staging at the
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
    const nodePath = path.join(dir, 'node', this.opts.platform === 'win32' ? 'node.exe' : 'node')
    return {
      kind: 'node',
      nodePath,
      scriptPath: path.join(dir, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      cwd: path.join(dir, 'app'),
    }
  }

}
