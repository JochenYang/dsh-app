/** Shared types used across the main process, kernel manager, and renderers. */

export type KernelChannel = 'stable' | 'beta' | 'alpha'
export type KernelSource = 'dev' | 'artifact'

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

/**
 * Splash progress steps, 1-based, in the order static/startup.html lists them:
 * 1 prepare (check/verify/download), 2 extract, 3 activate, 4 start the server,
 * 5 open the interface. A step is a property of the MESSAGE, not of the phase —
 * 'extracting' covers both the tarball and the layer path, and only one of them
 * reports progress — so the producer states it (see `step`).
 */
export type KernelStatusStep = 1 | 2 | 3 | 4 | 5

export interface KernelStatusPayload {
  phase: KernelPhase
  /**
   * User-visible status line, localized by whoever produced it: every producer
   * (the shell in src/main, the kernel runtime manager in src/kernel) writes its
   * line through `shared/locale.ts`, in the language of the running process.
   */
  message: string
  /** 0..1 download/extract progress, or null when indeterminate. */
  progress: number | null
  /** Set when phase === 'error'. */
  error?: string
  /**
   * True while the user has paused a download. The phase deliberately stays
   * 'downloading' (the transfer is suspended, not failed, and no renderer
   * branches on a paused phase); `paused` is additive, so a renderer that
   * ignores it keeps showing the frozen progress. Absent on every other status.
   */
  paused?: boolean
  /**
   * Which splash step this line belongs to (see {@link KernelStatusStep}), when
   * the producer knows. The splash prefers it over matching the wording, which
   * only ever worked in zh-CN; absent means "unknown", and the splash then keeps
   * the step it is on.
   */
  step?: KernelStatusStep
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
  /**
   * Build timestamp. Present in the release-metadata manifest and dev
   * manifests, deliberately ABSENT inside the archive: a timestamp in the
   * tarball would change its sha512 on every rebuild and defeat reproducible
   * builds (drift detection requires sha-equal ⇔ content-equal).
   */
  publishedAt?: string
  source: KernelSource
}

/**
 * One layer file an install was assembled from: the cache key (file name) plus
 * the digest it was verified against, kept for provenance.
 */
export interface KernelLayerRef {
  name: string
  sha512: string
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
   * sha512 of the tarball this install was activated from, recorded for
   * provenance. It is NOT the boot drift key — that is `bundledStamp`, which
   * compares the bundle's semantic identity. Tarball bytes are not
   * reproducible across builds (mtimes, order), so a hash comparison would
   * re-extract an identical runtime on every boot.
   */
  sha512?: string
  /**
   * Identity of the bundled runtime this install adopted, as
   * `<dshVersion>+<suiteVersion>` from the installer's own
   * `resources/kernel/manifest.json`. The boot drift check re-activates the
   * bundled tarball only when this differs from what the running shell ships,
   * which separates "a new shell brought a new runtime" from "an online update
   * already got there" — version arithmetic cannot tell those apart, and
   * treating the second as drift downgrades the user's kernel.
   */
  bundledStamp?: string
  /**
   * Layer files this install was assembled from, recorded for provenance when
   * the kernel came from a split-layer install (`installFromLocalLayers`, or the
   * online layer path). ABSENT on tgz installs and on every record written
   * before layers existed — readers must treat a missing field as "no layer
   * provenance", never as a broken record (rollback and load stay unchanged).
   */
  layers?: KernelLayerRef[]
}

export interface UpdateCheckResult {
  available: boolean
  current: string | null
  latest: string | null
  channel: KernelChannel
  /**
   * Newer versions on OTHER lines than the primary one (e.g. an alpha build
   * while running rc, or vice versa). Each entry passed the artifact
   * availability probe, so every option is directly installable — the caller
   * lets the user pick a line instead of only offering the primary update.
   * Empty/absent when no other line has anything newer.
   */
  alternatives?: Array<{ version: string; channel: KernelChannel }>
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
