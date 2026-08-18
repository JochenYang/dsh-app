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

  // ------------------------------------------------------------------ init

  async init(): Promise<CurrentKernel> {
    await fs.mkdir(this.root, { recursive: true })
    if (this.opts.source === 'dev') {
      return this.initDev()
    }
    this.current = await loadCurrentKernel(this.root)
    if (this.current) {
      const dir = this.kernelDir(this.current.active)
      if (await exists(dir)) {
        this.log(`active kernel ${this.current.active} present`)
        return this.current
      }
      this.log(`active kernel ${this.current.active} missing — reinstall`)
      this.current = null
    }
    // First run (or broken install): fetch the latest kernel.
    const installed = await this.installLatest('installing')
    this.status({ phase: 'ready', message: 'Kernel ready', progress: null })
    return installed
  }

  /** True when a usable kernel is already on disk (or dev mode). */
  async isInstalled(): Promise<boolean> {
    if (this.opts.source === 'dev') return true
    const current = await loadCurrentKernel(this.root)
    if (!current) return false
    return exists(this.kernelDir(current.active))
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
   */
  async checkForUpdate(): Promise<UpdateCheckResult> {
    if (this.opts.source === 'dev' || !this.current) {
      return { available: false, current: this.current?.manifest.dshVersion ?? null, latest: null, channel: this.opts.channel, reason: this.opts.source === 'dev' ? 'dev mode pinned to checkout' : 'no kernel installed' }
    }
    this.status({ phase: 'checking', message: 'Checking for kernel updates…', progress: null })
    const info = await fetchRegistryInfo(this.opts.channel)
    if (!info) {
      return { available: false, current: this.current.manifest.dshVersion, latest: null, channel: this.opts.channel, reason: 'registry unreachable' }
    }
    const currentVersion = this.current.manifest.dshVersion
    const newer = semver.valid(info.version) && semver.valid(currentVersion) ? semver.gt(info.version, currentVersion) : info.version !== currentVersion
    this.log(`registry reports dsh ${info.version}; current ${currentVersion}`)
    return {
      available: !!newer,
      current: currentVersion,
      latest: info.version,
      channel: this.opts.channel,
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
    this.status({ phase: 'checking', message: reason === 'installing' ? 'Preparing first install…' : 'Checking for updates…', progress: null })
    const info = await fetchRegistryInfo(this.opts.channel)
    if (!info) throw new Error('cannot reach npm registry to resolve dsh version')
    return this.installVersion(info.version)
  }

  async installVersion(version: string): Promise<CurrentKernel> {
    if (this.opts.source === 'dev') return this.initDev()
    const resolver = this.makeResolver()
    const artifact = await resolver.fetchArtifact(version)
    if (!artifact) throw new Error(`no runtime artifact for dsh ${version} on ${this.opts.platform}-${this.opts.arch}`)

    await fs.mkdir(path.join(this.root, STAGING_DIR), { recursive: true })
    const tarball = path.join(this.root, STAGING_DIR, TARBALL_FILE)
    const extractDir = path.join(this.root, STAGING_DIR, 'extract')

    // 1. Download with progress.
    this.status({ phase: 'downloading', message: `Downloading dsh ${version}…`, progress: 0 })
    await this.download(artifact.url, tarball)

    // 2. Verify integrity (sha512 from the release asset).
    this.status({ phase: 'extracting', message: 'Verifying download…', progress: null })
    const actual = await sha512File(tarball)
    if (!verifyIntegrity(artifact.sha512, actual)) {
      throw new Error(`integrity mismatch for dsh ${version} (expected ${artifact.sha512.slice(0, 16)}…, got ${actual.slice(0, 16)}…)`)
    }

    // 3. Extract and sanity-check the inner manifest.
    await fs.rm(extractDir, { recursive: true, force: true })
    await fs.mkdir(extractDir, { recursive: true })
    this.status({ phase: 'extracting', message: 'Extracting runtime…', progress: null })
    await tar.x({ file: tarball, cwd: extractDir })
    const inner = path.join(extractDir, 'runtime')
    const innerManifest = await readRuntimeManifest(inner)
    if (!innerManifest) throw new Error('runtime artifact missing manifest.json')
    if (innerManifest.platform !== this.opts.platform || innerManifest.arch !== this.opts.arch) {
      throw new Error(`artifact platform mismatch: ${innerManifest.platform}-${innerManifest.arch} vs ${this.opts.platform}-${this.opts.arch}`)
    }

    // 4. Move into a versioned, immutable directory.
    const versionDir = this.versionDirName(innerManifest)
    const target = this.kernelDir(versionDir)
    await fs.rm(target, { recursive: true, force: true })
    await fs.rename(inner, target)

    // 5. Activate atomically, keeping the previous version for rollback.
    this.status({ phase: 'installing', message: 'Activating runtime…', progress: null })
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

    // 6. Clean staging.
    await fs.rm(path.join(this.root, STAGING_DIR), { recursive: true, force: true })
    return next
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
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length') ?? 0)
    const body = Readable.fromWeb(res.body as never)
    const out = await fs.open(dest, 'w')
    let received = 0
    try {
      for await (const chunk of body) {
        if (this.cancelRequested) throw new Error('download cancelled')
        received += chunk.length
        await out.write(chunk)
        if (total > 0) this.status({ phase: 'downloading', message: `Downloading dsh…`, progress: Math.min(1, received / total) })
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
    this.status({ phase: 'rollback', message: `Rolled back to ${previousDir}`, progress: null })
    this.log(`rolled back to ${previousDir}`)
    return rollbackTo
  }

  /** Remove versioned dirs that are neither active nor previous, and staging. */
  async cleanup(): Promise<void> {
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
