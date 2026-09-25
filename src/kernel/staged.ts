import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * The kernel tree the Windows installer pre-extracts at install time.
 *
 * The bundled tarball (`resources/kernel/kernel.tgz`, shipped by
 * electron-builder's extraResources) is unpacked by the installer's
 * `customInstall` hook (`scripts/installer/extract-kernel.nsh`) into
 * `resources/kernel-staged/`, so the app's first launch can activate the tree
 * directly instead of unpacking ~13k files behind the splash. The app still
 * verifies the tarball's sha512 against its sidecar before it touches the
 * staged tree, and a missing or unusable stage falls back to extracting the
 * tarball itself — this is a fast path, never a trust shortcut.
 */

/** Directory name the installer extracts into, under `resources/`. */
export const STAGED_KERNEL_DIRNAME = 'kernel-staged'

/** The single top-level directory every runtime tarball carries. */
const STAGED_INNER = 'runtime'

/**
 * Candidate staged-kernel directories, in the order they are read.
 *
 * Packaged-app only by construction: the stage is an installer artifact, and
 * a dev or unpackaged run has no installer. The resources path is validated
 * rather than trusted (it is absent under some test runners).
 */
export function stagedKernelDirs(): string[] {
  const dirs: string[] = []
  const resources = process.resourcesPath
  if (typeof resources === 'string' && resources !== '') {
    dirs.push(path.join(resources, STAGED_KERNEL_DIRNAME))
  }
  return dirs
}

/**
 * The extracted runtime tree inside one staged directory, or null when the
 * directory holds no usable tree. A `manifest.json` directly under `runtime/`
 * is the marker: the installer's tar lays the tarball's own layout down, and
 * a half-written stage (killed installer) must answer "no stage" rather than
 * half a runtime.
 */
export function stagedRuntimeTree(dir: string): string | null {
  const inner = path.join(dir, STAGED_INNER)
  return existsSync(path.join(inner, 'manifest.json')) ? inner : null
}

/** One staged kernel the app can adopt. */
export interface StagedKernel {
  /** The staged directory (for diagnostics). */
  readonly dir: string
  /** The extracted runtime tree inside it. */
  readonly runtime: string
}

/**
 * The staged kernel this build can adopt, or null when there is none.
 *
 * @param dirs - candidate directories; defaults to {@link stagedKernelDirs}.
 */
export function findStagedKernel(dirs: string[] = stagedKernelDirs()): StagedKernel | null {
  for (const dir of dirs) {
    const runtime = stagedRuntimeTree(dir)
    if (runtime !== null) return { dir, runtime }
  }
  return null
}
