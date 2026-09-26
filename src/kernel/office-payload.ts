/**
 * The office payload: the LibreOffice engine the kernel converts office
 * documents with, installed on demand instead of shipped with every runtime.
 *
 * Why it is not inside the runtime: the engine is ~115 MiB compressed (330 MiB
 * unpacked) and is needed only when a document is actually converted, while the
 * runtime is downloaded by every user on every kernel update. The runtime keeps
 * a tiny loader shim at the specifier `@deepseek-ai/dsh-office-to-pdf` imports
 * statically, and that shim loads the real kit out of the directory this module
 * installs (`scripts/runtime-stubs/libreoffice-kit`).
 *
 * Where it lands: `<userData>/dsh-app-office/payload/<payloadVersion>/`, with
 * the payload's own manifest and a `node_modules` tree holding the kit, its
 * dependencies and the target's engine. The version is the payload's CONTENT
 * identity (kit version, plus the Python version when a Python set is carried),
 * never the dsh version — that is what makes the engine download once and stay
 * put across kernel updates and rollbacks.
 *
 * What guarantees it: the artifact is resolved through the SAME release
 * metadata chain the kernel uses (official host first and fail-closed, proxies
 * as transport only — `GitHubArtifactResolver`), verified
 * against the sha512 of that phase-1 metadata, extracted into a staging
 * directory under the payload root, validated (its own manifest must describe
 * this target and the required files must be there), and only then swapped into
 * place: the old install is renamed aside first and deleted after the verified
 * tree takes its place, so a failed swap restores the previous version. A
 * failed attempt leaves nothing behind but the last good install.
 *
 * What it deliberately does NOT do: download anything by itself. Nothing here
 * runs at boot; the settings row is the trigger, exactly like the kernel's own
 * update flow.
 *
 * @module dsh-app/kernel/office-payload
 */
import { promises as fs, existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import path from 'node:path'
import * as tar from 'tar'
import type { KernelOfficePayloadManifest } from '../shared/types'
import type { MessageKey } from '../shared/locale'
import { t } from '../shared/locale'
import { tarExtractionFilter } from './tar-entry'
import {
  OFFICE_PAYLOAD_DIR,
  OFFICE_PAYLOAD_MANIFEST_FILE,
  OFFICE_PAYLOAD_MODULES_DIR,
  OFFICE_PRIMARY_RUNTIME_LEAF,
  OFFICE_PRIMARY_RUNTIME_MANIFEST_FILE,
  OFFICE_ROOT_DIR,
} from '../shared/constants'
import { sha512File, verifyIntegrity } from './integrity'
import { classifyDownloadFailure, describeDownloadFailure } from './failures'
import { GitHubArtifactResolver } from './sources/artifact'

/** The kit package; its per-target engine packages are named after it. */
const KIT_PACKAGE = '@deepseek-ai/libreoffice-kit'

/** Directory inside the archive holding the payload tree. Mirrors the build's. */
const ARCHIVE_DIR = 'payload'

/** Single-request cap for the payload download, mirroring the kernel's own. */
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024

/** Per-request timeout; a stalled connection must not pin the task forever. */
const REQUEST_TIMEOUT_MS = 600_000

/** How often progress is reported (frequent enough for a live percentage). */
const PROGRESS_INTERVAL_MS = 250

/**
 * How long {@link OfficePayloadManager.cancel} waits for the aborted transfer
 * to unwind before it answers with whatever state is current.
 */
const CANCEL_SETTLE_MS = 3_000

/**
 * What the ACTIVE kernel needs. Read per call, never cached: a kernel update
 * replaces the manifest under the running shell.
 */
export interface OfficePayloadTarget {
  /** Kernel version whose release carries the payload artifact. */
  dshVersion: string
  /** Payload content version this kernel requires. */
  payloadVersion: string
  platform: string
  arch: string
  /** Engine suffix the payload must carry. */
  engine: string
}

/** Where the install stands. `installing` covers extraction and validation. */
export type OfficePayloadPhase = 'idle' | 'downloading' | 'installing' | 'failed'

/** One user-facing failure: a stable code plus the shell's own sentence. */
export interface OfficePayloadFailure {
  code: MessageKey
  message: string
}

/** The settings row's whole view of the payload. */
export interface OfficePayloadStatus {
  /**
   * False when this kernel declares no office payload at all (dev mode, or a
   * runtime built before the field existed). The row then explains the state
   * instead of offering a download that cannot resolve.
   */
  supported: boolean
  /** Payload version the active kernel requires, or null when unsupported. */
  required: string | null
  /** Installed payload version that satisfies {@link required}, or null. */
  installed: string | null
  /**
   * A payload version that IS on disk and verifies, whether or not it is the
   * one {@link required} names, or null when no usable version is installed.
   *
   * This is the difference between "nothing is installed" and "an upgrade is
   * available": a kernel whose bundled kit moved (a `^0.1.1` range resolving to
   * 0.1.2 at build time) requires a version the user does not have, while the
   * payload they downloaded a week ago is still complete on disk. Reporting
   * that one as {@link installed} would hide the upgrade; reporting only null
   * loses the fact that something IS installed and shows an untouched machine's
   * "download" flow instead of "update".
   */
  installedOnDisk: string | null
  phase: OfficePayloadPhase
  /** 0..1 while downloading, null otherwise. */
  progress: number | null
  error: OfficePayloadFailure | null
}

export interface OfficePayloadOptions {
  /** The shell's data directory (`app.getPath('userData')`). */
  userDataDir: string
  platform: string
  arch: string
  /** GitHub owner/repo hosting the payload artifact. */
  owner: string
  repo: string
  /** What the active kernel needs, read per call. */
  target(): OfficePayloadTarget | null
  /** One diagnostics line (English, log-only). */
  log?(line: string): void
}

/**
 * The transfer in flight, or the failure the last one left. Kept in memory on
 * purpose: a partial download is never resumed, so a staging directory left by
 * an earlier run is reclaimed by the next one rather than appended to.
 */
interface PayloadTask {
  phase: OfficePayloadPhase
  progress: number | null
  error: OfficePayloadFailure | null
  /** Aborts the request in flight. */
  abort: AbortController
  /** True while the task runs, so `download()` is idempotent. */
  running: boolean
}

/** A failure that already carries its own user-facing code and message. */
class OfficePayloadError extends Error {
  constructor(readonly messageKey: MessageKey, message: string) {
    super(message)
    this.name = 'OfficePayloadError'
  }
}

/**
 * Rename with a short retry — the same Windows discipline the kernel manager
 * uses: a freshly written tree can be held by an antivirus scanner or the
 * search indexer for a few hundred milliseconds, and `rename` is atomic, so a
 * retry can only succeed or fail again.
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

/** Whether a directory entry name may be used to build an install path from. */
function isVersionDirectory(name: string): boolean {
  return /^[0-9A-Za-z][0-9A-Za-z._+-]*$/u.test(name)
}

/** One error's message, or its string form. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Owns the office payload's local state: what the active kernel requires, what
 * is installed, and the one download that installs it.
 */
export class OfficePayloadManager {
  private task: PayloadTask | null = null

  constructor(private readonly opts: OfficePayloadOptions) {}

  private log(line: string): void {
    this.opts.log?.(`[office-payload] ${line}`)
  }

  /** Root of everything this shell installs for the office side. */
  private root(): string {
    return path.join(this.opts.userDataDir, OFFICE_ROOT_DIR)
  }

  /** Directory holding the versioned payloads. */
  private payloadRoot(): string {
    return path.join(this.root(), OFFICE_PAYLOAD_DIR)
  }

  /**
   * Absolute directory one payload version installs into.
   *
   * The version is validated here, not only where it is read: it becomes a
   * path component that rename/rm act on, and a value carrying `..` or a
   * separator would step outside the payload root. A caller with a
   * version-shaped value (every real target) sees no difference.
   */
  installDir(version: string): string {
    if (!isVersionDirectory(version)) {
      throw new Error(t('officePayload.manifestMismatch', { detail: `payload version ${JSON.stringify(version)} is not a version-shaped name` }))
    }
    return path.join(this.payloadRoot(), version)
  }

  /**
   * The payload directory the kernel child is told about, whether or not it is
   * installed yet: the runtime's loader shim reads it per conversion, so a
   * payload installed while the kernel runs takes effect without a restart.
   * @returns the directory, or null when this kernel declares no payload.
   */
  expectedDir(): string | null {
    const target = this.opts.target()
    return target === null ? null : this.installDir(target.payloadVersion)
  }

  /**
   * The installed payload directory, or null when the required version is not
   * on disk — or is on disk but unusable, which is reported the same way
   * because "download it again" is the actionable answer to both.
   */
  async installedDir(): Promise<string | null> {
    const target = this.opts.target()
    if (target === null) return null
    const dir = this.installDir(target.payloadVersion)
    return (await this.verify(dir, target)) === null ? null : dir
  }

  /**
   * The directory of a carried Python set inside an installed payload, for the
   * child's primary-runtime argument, or null when the payload carries none.
   */
  async primaryRuntimeDir(): Promise<string | null> {
    const installed = await this.installedDir()
    if (installed === null) return null
    const dir = path.join(installed, OFFICE_PRIMARY_RUNTIME_LEAF)
    return existsSync(path.join(dir, 'runtime.json')) ? dir : null
  }

  /**
   * Verify one directory; returns the installed payload version when it is
   * usable, else null. The ONE validator: the status path, the install commit
   * and the spawn-time hand-off all answer "is this payload usable for this
   * kernel" through it, so they cannot drift apart.
   */
  private async verify(dir: string, target: OfficePayloadTarget): Promise<string | null> {
    const manifest = await readManifest(dir)
    if (manifest === null || manifestProblems(manifest, target).length > 0) return null
    for (const relative of requiredFiles(target.engine, manifest.components.python)) {
      if (!(await exists(path.join(dir, relative)))) return null
    }
    return manifest.payloadVersion
  }

  /**
   * Whether one directory is a COMPLETE payload for this kernel's platform,
   * arch and engine — the question {@link verify} answers while ignoring which
   * content version the directory carries.
   *
   * Used only to report an install that exists while the required version has
   * moved past it. It must never satisfy a download: the kit and engine a
   * kernel needs are named by its OWN target's version, so a stale payload is
   * still a download.
   */
  private async shapeOk(dir: string, target: OfficePayloadTarget): Promise<boolean> {
    const manifest = await readManifest(dir)
    if (manifest === null || payloadShapeProblems(manifest, target).length > 0) return false
    for (const relative of requiredFiles(target.engine, manifest.components.python)) {
      if (!(await exists(path.join(dir, relative)))) return false
    }
    return true
  }

  /**
   * The newest payload version on disk that is complete for this target, or
   * null when none is. "Newest" is by name order of the version directories,
   * which is only ever used to pick WHICH name to show when several are
   * present (the install path prunes the others) — never to decide whether to
   * download, which stays {@link installed}/{@link OfficePayloadStatus.required}.
   */
  private async installedOnDisk(target: OfficePayloadTarget): Promise<string | null> {
    const entries = await fs.readdir(this.payloadRoot(), { withFileTypes: true }).catch(() => [])
    const candidates: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !isVersionDirectory(entry.name)) continue
      if (await this.shapeOk(this.installDir(entry.name), target)) candidates.push(entry.name)
    }
    if (candidates.length === 0) return null
    return candidates.sort().at(-1) ?? null
  }

  /**
   * The current state, from disk plus whatever task is in flight. Never throws
   * and never touches the network, so the row can call it freely.
   */
  async status(): Promise<OfficePayloadStatus> {
    const target = this.opts.target()
    if (target === null) {
      return { supported: false, required: null, installed: null, installedOnDisk: null, phase: 'idle', progress: null, error: null }
    }
    const installed = await this.verify(this.installDir(target.payloadVersion), target)
    // Only scanned when the required version is NOT installed: a satisfied
    // kernel has nothing to distinguish, and the scan is the expensive half
    // (it reads every other version directory's manifest).
    const installedOnDisk = installed !== null ? installed : await this.installedOnDisk(target)
    const task = this.task
    return {
      supported: true,
      required: target.payloadVersion,
      installed,
      installedOnDisk,
      phase: task === null ? 'idle' : task.phase,
      progress: task === null ? null : task.progress,
      error: task === null ? null : task.error,
    }
  }

  /**
   * Start the download unless it is already installed, already running, or this
   * kernel declares no payload. Returns the state to show immediately: the
   * transfer runs in the background and is observed through {@link status},
   * because ~115 MiB is far too long for an action request to hold open.
   */
  async download(): Promise<OfficePayloadStatus> {
    const target = this.opts.target()
    if (target === null) return this.status()
    if (this.task?.running === true) return this.status()
    if ((await this.verify(this.installDir(target.payloadVersion), target)) !== null) {
      this.log(`payload ${target.payloadVersion} is already installed`)
      return this.status()
    }
    const task: PayloadTask = { phase: 'downloading', progress: 0, error: null, abort: new AbortController(), running: true }
    this.task = task
    // Deliberately not awaited: the caller gets the immediate state, and the
    // task reports itself through status().
    void this.run(target, task).catch((err: unknown) => {
      // The task body guards its own failures; anything reaching here is a
      // shell bug and must not be swallowed.
      this.log(`unexpected failure: ${messageOf(err)}`)
      this.fail(task, {
        code: 'officePayload.installFailed',
        message: t('officePayload.installFailed', { detail: messageOf(err) }),
      })
    })
    return this.status()
  }

  /**
   * Abort the transfer in flight. Extraction and the install rename are not
   * interruptible (a half-renamed tree is worse than a slow one), so a cancel
   * that arrives during them takes effect at the next checkpoint — all of which
   * sit before anything is committed.
   *
   * The answer waits briefly for the task to unwind: returning the state of a
   * transfer that is already over would leave the row showing a percentage
   * (and a cancel button) for another poll cycle, which reads as "the click did
   * nothing". A transfer that is still unwinding after that is reported as it
   * is — the poll loop keeps the row honest.
   */
  async cancel(): Promise<OfficePayloadStatus> {
    const task = this.task
    if (task?.running === true) {
      this.log('cancel requested')
      task.abort.abort()
      const deadline = Date.now() + CANCEL_SETTLE_MS
      while (task.running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    return this.status()
  }

  /** One download-extract-verify-install attempt. */
  private async run(target: OfficePayloadTarget, task: PayloadTask): Promise<void> {
    const resolver = new GitHubArtifactResolver(this.opts.owner, this.opts.repo, this.opts.platform, this.opts.arch)
    const staging = path.join(this.payloadRoot(), `.staging-${String(process.pid)}-${String(Date.now())}`)
    try {
      await fs.mkdir(this.payloadRoot(), { recursive: true })
      await fs.rm(staging, { recursive: true, force: true })
      await fs.mkdir(staging, { recursive: true })
      const info = await resolver.fetchOfficePayload(target.dshVersion, target.payloadVersion)
      if (info === null) {
        throw new OfficePayloadError('officePayload.artifactMissing', t('officePayload.artifactMissing', {
          platform: this.opts.platform,
          arch: this.opts.arch,
          dshVersion: target.dshVersion,
        }))
      }
      // The sidecar manifest must already describe this kernel's target; a
      // foreign or re-labelled release is refused before a byte is fetched.
      const sidecarProblems = manifestProblems(info.manifest, target)
      if (sidecarProblems.length > 0) {
        throw new OfficePayloadError('officePayload.manifestMismatch', t('officePayload.manifestMismatch', { detail: sidecarProblems.join('; ') }))
      }

      // A cancel that landed while the metadata was being resolved ends the
      // task here rather than as a failed download of the next candidate.
      this.throwIfAborted(task)
      const part = path.join(staging, 'payload.tgz')
      let lastError: Error | null = null
      let downloaded = false
      for (const candidate of info.candidates) {
        try {
          await this.downloadFile(candidate, part, task)
          const actual = await sha512File(part)
          if (!verifyIntegrity(info.sha512, actual)) {
            throw new Error(t('kernel.integrityFailed', { expected: info.sha512.slice(0, 16), actual: actual.slice(0, 16) }))
          }
          downloaded = true
          this.log(`downloaded from ${candidate}`)
          break
        } catch (err) {
          lastError = err as Error
          this.throwIfAborted(task)
          this.log(`candidate failed (${candidate}): ${messageOf(err)}`)
          await fs.rm(part, { force: true })
        }
      }
      if (!downloaded) {
        throw new OfficePayloadError('officePayload.downloadFailed', t('officePayload.downloadFailed', {
          detail: describeDownloadFailure(classifyDownloadFailure(lastError), info.candidates.length, lastError?.message ?? null),
        }))
      }

      task.phase = 'installing'
      task.progress = null
      const extract = path.join(staging, 'extract')
      await fs.mkdir(extract, { recursive: true })
      await tar.x({
        file: part,
        cwd: extract,
        // The same traversal refusal as the kernel's own extraction: an archive
        // is untrusted input even when its digest matched.
        filter: tarExtractionFilter,
      })
      this.throwIfAborted(task)
      const tree = path.join(extract, ARCHIVE_DIR)
      const inner = await readManifest(tree)
      if (inner === null) {
        throw new OfficePayloadError('officePayload.manifestMismatch', t('officePayload.manifestMismatch', { detail: 'the archive holds no readable payload manifest' }))
      }
      const innerProblems = manifestProblems(inner, target)
      if (innerProblems.length > 0) {
        throw new OfficePayloadError('officePayload.manifestMismatch', t('officePayload.manifestMismatch', { detail: innerProblems.join('; ') }))
      }
      for (const relative of requiredFiles(target.engine, inner.components.python)) {
        if (!(await exists(path.join(tree, relative)))) {
          throw new OfficePayloadError('officePayload.manifestMismatch', t('officePayload.manifestMismatch', { detail: `the archive is missing ${relative}` }))
        }
      }

      // Commit. The required version's directory is swapped atomically: the
      // old install moves aside INSIDE the payload root first (a rename on the
      // same volume), the verified tree takes its place, and only then is the
      // old one deleted. A rename that fails after the old one moved aside
      // restores it, so at no point is the engine both absent and unrecoverable.
      const destination = this.installDir(target.payloadVersion)
      const retired = await exists(destination) ? `${destination}.retired-${Date.now()}` : null
      if (retired !== null) await renameWithRetry(destination, retired)
      try {
        await renameWithRetry(tree, destination)
      } catch (err) {
        if (retired !== null) await renameWithRetry(retired, destination).catch(() => undefined)
        throw err
      }
      if (retired !== null) await fs.rm(retired, { recursive: true, force: true }).catch(() => undefined)
      const pruned = await this.pruneOtherVersions(target.payloadVersion)
      if (pruned.length > 0) this.log(`pruned old payload versions: ${pruned.join(', ')}`)
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
      this.log(`payload ${target.payloadVersion} installed at ${destination}${retired !== null ? ' (replaced)' : ''}`)
      task.phase = 'idle'
      task.progress = null
      task.error = null
      task.running = false
    } catch (err) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
      if (task.abort.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        this.log('cancelled')
        task.phase = 'idle'
        task.progress = null
        task.error = null
        task.running = false
        return
      }
      const failure: OfficePayloadFailure = err instanceof OfficePayloadError
        ? { code: err.messageKey, message: err.message }
        : { code: 'officePayload.downloadFailed', message: t('officePayload.downloadFailed', { detail: messageOf(err) }) }
      this.log(`failed: ${failure.message}`)
      this.fail(task, failure)
    }
  }

  /** Record a failure on the task, leaving it visible until the next attempt. */
  private fail(task: PayloadTask, failure: OfficePayloadFailure): void {
    task.phase = 'failed'
    task.progress = null
    task.error = failure
    task.running = false
  }

  /** Abort the attempt when the user cancelled; safe at any checkpoint. */
  private throwIfAborted(task: PayloadTask): void {
    if (task.abort.signal.aborted) {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }
  }

  /** One streaming download with progress, under the byte cap and a request timeout. */
  private async downloadFile(url: string, dest: string, task: PayloadTask): Promise<void> {
    const signal = AbortSignal.any([task.abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    const res = await fetch(url, { signal })
    if (!res.ok || res.body === null) throw new Error(t('kernel.downloadHttpFailed', { status: res.status }))
    const announced = Number(res.headers.get('content-length') ?? 0)
    if (announced > MAX_DOWNLOAD_BYTES) throw new Error(t('kernel.downloadTooLarge', { bytes: announced }))
    let received = 0
    let lastEmit = 0
    const out = await fs.open(dest, 'w')
    try {
      for await (const chunk of Readable.fromWeb(res.body as never)) {
        received += chunk.length
        if (received > MAX_DOWNLOAD_BYTES) throw new Error(t('kernel.downloadTooLargeReceived', { bytes: received }))
        await out.write(chunk)
        if (announced > 0) {
          const now = Date.now()
          const progress = Math.min(1, received / announced)
          if (now - lastEmit >= PROGRESS_INTERVAL_MS || received === announced) {
            lastEmit = now
            task.phase = 'downloading'
            task.progress = progress
          }
        }
      }
    } finally {
      await out.close()
    }
  }

  /**
   * Drop every other payload version, and any staging directory a crashed run
   * left. The active version is the only one kept: payloads are
   * content-addressed, so a version nobody requires any more is re-downloadable,
   * while holding several kits would cost hundreds of MiB each.
   * @returns the version names removed.
   */
  private async pruneOtherVersions(keep: string): Promise<string[]> {
    const removed: string[] = []
    const entries = await fs.readdir(this.payloadRoot(), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name === keep) continue
      if (!entry.isDirectory() || !isVersionDirectory(entry.name)) {
        // Only the crash-left staging directories land here: a `.retired-`
        // name is version-shaped (`<version>.retired-<ts>`, the swap's
        // aside-copy), so it takes the delete branch below like any other
        // version nobody requires.
        if (entry.name.startsWith('.staging-')) {
          await fs.rm(path.join(this.payloadRoot(), entry.name), { recursive: true, force: true }).catch(() => undefined)
        }
        continue
      }
      await fs.rm(path.join(this.payloadRoot(), entry.name), { recursive: true, force: true }).catch(() => undefined)
      removed.push(entry.name)
    }
    return removed
  }
}

/** Existence test that never throws. */
async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

/** Read `<dir>/manifest.json`, or null when it is absent or unreadable. */
async function readManifest(dir: string): Promise<KernelOfficePayloadManifest | null> {
  try {
    const text = await fs.readFile(path.join(dir, OFFICE_PAYLOAD_MANIFEST_FILE), 'utf8')
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed as KernelOfficePayloadManifest : null
  } catch {
    return null
  }
}

/**
 * Files an installed payload must hold to be usable. KEEP IN SYNC with
 * `officePayloadRequiredFiles` in `scripts/lib/office-payload.mjs` — the build
 * asserts the same set before it publishes the artifact, and
 * `test/office-payload.test.mjs` drives both with one fixture.
 *
 * The engine marker is the engine package's `package.json`, which every engine
 * kind has: a native engine additionally ships `prebuilds.json` (upstream's own
 * packaging assertion), while `wasm` — the kit's fallback for a target without
 * a native engine — does not.
 */
export function requiredFiles(engine: string, pythonVersion: string | null = null): string[] {
  const engineDir = path.join(OFFICE_PAYLOAD_MODULES_DIR, `${KIT_PACKAGE}-${engine}`)
  return [
    OFFICE_PAYLOAD_MANIFEST_FILE,
    path.join(OFFICE_PAYLOAD_MODULES_DIR, KIT_PACKAGE, 'package.json'),
    path.join(engineDir, 'package.json'),
    ...(engine === 'wasm' ? [] : [path.join(engineDir, 'prebuilds.json')]),
    // A manifest that declares a Python set makes that set non-optional: an
    // archive that lost `primary-runtime/` would otherwise install cleanly and
    // only fail when the host's `load_workspace_dependencies` reads it.
    ...(pythonVersion === null || pythonVersion === ''
      ? []
      : [path.join(OFFICE_PRIMARY_RUNTIME_LEAF, OFFICE_PRIMARY_RUNTIME_MANIFEST_FILE)]),
  ]
}

/**
 * Why one payload manifest cannot serve this kernel; an empty list means it can.
 * The reading half of the build's `officePayloadManifestProblems`
 * (`scripts/lib/office-payload.mjs`) — the two are one contract, driven with
 * the same fixtures by `test/office-payload.test.mjs`.
 */
export function manifestProblems(manifest: KernelOfficePayloadManifest, target: OfficePayloadTarget): string[] {
  const problems: string[] = []
  if (manifest.payloadVersion !== target.payloadVersion) {
    problems.push(`the payload is version ${String(manifest.payloadVersion)}, but this kernel requires ${target.payloadVersion}`)
  }
  problems.push(...payloadShapeProblems(manifest, target))
  return problems
}

/**
 * Why one payload manifest cannot serve this target at all, IGNORING which
 * content version it carries.
 *
 * The version equality is deliberately not part of this: it answers "is this a
 * complete payload for this kernel's platform, arch and engine?", which is what
 * an already-installed version must satisfy to be worth REPORTING when
 * {@link OfficePayloadTarget.payloadVersion} has moved past it (a `^0.1.1` kit
 * range resolving to a new kit at build time moves the required version without
 * anything about the user's install changing). {@link manifestProblems} adds
 * the version rule on top, so the two cannot disagree about the shape.
 */
export function payloadShapeProblems(manifest: KernelOfficePayloadManifest, target: OfficePayloadTarget): string[] {
  const problems: string[] = []
  if (manifest.platform !== target.platform || manifest.arch !== target.arch) {
    problems.push(`the payload is built for ${String(manifest.platform)}-${String(manifest.arch)}, not ${target.platform}-${target.arch}`)
  }
  const components = manifest.components
  if (typeof components !== 'object' || components === null) {
    problems.push('the payload declares no components')
    return problems
  }
  if (components.engine === null || components.engine === undefined) problems.push('the payload carries no engine')
  else if (components.engine !== target.engine) problems.push(`the payload carries the ${components.engine} engine, but this kernel needs ${target.engine}`)
  if (typeof components.kit !== 'string' || components.kit === '') problems.push('the payload declares no kit version')
  return problems
}
