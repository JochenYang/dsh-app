/** Shared types used across the main process, kernel manager, and renderers. */

export type KernelChannel = 'stable' | 'beta'
export type KernelSource = 'dev' | 'registry' | 'artifact'

export type KernelPhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'extracting'
  | 'installing'
  | 'starting'
  | 'ready'
  | 'rollback'
  | 'error'

export interface KernelStatusPayload {
  phase: KernelPhase
  /** Human-readable (English for now; i18n lives in the renderer layer). */
  message: string
  /** 0..1 download/extract progress, or null when indeterminate. */
  progress: number | null
  /** Set when phase === 'error'. */
  error?: string
}

/**
 * The runtime manifest shipped inside a kernel artifact (runtime tgz).
 * It describes what is inside the archive and how to verify it.
 */
export interface KernelManifest {
  dshVersion: string
  /** Brand plugin suite version bundled in this runtime. */
  suiteVersion: string
  channel: KernelChannel
  /** Artifact platform tag: win32 | darwin | linux */
  platform: string
  /** Artifact arch tag: x64 | arm64 */
  arch: string
  /** sha512 hex of the artifact tarball. */
  integrity: string
  publishedAt: string
  source: KernelSource
}

/** Points at the active (and previous, for rollback) kernel directory. */
export interface CurrentKernel {
  /** Versioned directory name under the kernel root (or 'dev' in dev mode). */
  active: string
  /** Previous versioned directory name kept for rollback, or null. */
  previous: string | null
  installedAt: string
  manifest: KernelManifest
  /**
   * sha512 of the tarball this install was activated from. Missing on
   * installs predating the field; the shell compares it against the bundled
   * sidecar to detect same-version content drift (new suite plugins).
   */
  sha512?: string
}

export interface UpdateCheckResult {
  available: boolean
  current: string | null
  latest: string | null
  channel: KernelChannel
  /**
   * Why the check ended without an installable update. Known values:
   * 'no kernel installed' | 'registry unreachable' | 'dev mode' |
   * 'dev mode update available' | 'artifact pending' (a newer dsh version is
   * published on npm but its runtime artifacts are not built yet) |
   * 'github unreachable' (no route to GitHub or its mirrors) |
   * 'install in progress' (an install/update is already running).
   */
  reason?: string
}

/** How to spawn the dsh server for the active kernel. */
export type ServerSpec =
  | { kind: 'pnpm'; cwd: string }
  | { kind: 'node'; nodePath: string; scriptPath: string; cwd: string }
