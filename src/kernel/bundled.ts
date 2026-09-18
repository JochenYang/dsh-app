import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import semver from 'semver'
import type { CurrentKernel, KernelChannel } from '../shared/types'

/**
 * The fields the boot check reads from the installer's
 * `resources/kernel/manifest.json`. All optional on purpose: the file is read
 * with a plain JSON.parse, so a truncated or hand-edited copy must be able to
 * answer "do not adopt" instead of taking the boot down.
 */
export interface BundledManifestFields {
  dshVersion?: string
  suiteVersion?: string
  platform?: string
  arch?: string
  channel?: string
}

/**
 * The kernel a shell build ships inside itself: the tarball
 * `scripts/prepare-bundled-kernel.mjs` copies into `bundled-kernel/` (packaged
 * as `resources/kernel/`, electron-builder.yml extraResources).
 *
 * The files are read from disk rather than from the runtime's own manifest
 * because the bundle is what an install adopts BEFORE a runtime exists — the
 * channel default and the boot install decision both have to answer without a
 * kernel being installed.
 */
export interface BundledKernel {
  /** Directory holding the bundle; installFromLocalTarball reads its manifest.json. */
  dir: string
  /** The bundled runtime tarball, or null when the directory ships none. */
  tarball: string | null
  /** sha512 sidecar of {@link tarball}, or null when it is absent. */
  sha512: string | null
  /** Parsed manifest.json, or null when it is absent or unreadable. */
  manifest: BundledManifestFields | null
}

/**
 * Directories the bundled kernel may live in, in the order they are read.
 *
 * Two locations, because the same files arrive by different routes: the
 * packaged app gets them from electron-builder's extraResources, while a dev or
 * unpackaged run (npm start, npm run dev, a probe) reads the repo copy the
 * packaging step would have shipped — so both runs follow the same kernel line
 * instead of the dev run secretly following `stable`.
 */
export function bundledKernelDirs(): string[] {
  const dirs: string[] = []
  const resources = process.resourcesPath
  if (typeof resources === 'string' && resources !== '') dirs.push(path.join(resources, 'kernel'))
  // dist/kernel/ -> the repository root. Absent in a packaged app (the code
  // lives in the asar), which is why the resources path above is tried first.
  dirs.push(path.join(path.resolve(__dirname, '..', '..'), 'bundled-kernel'))
  return dirs
}

/** Read one candidate manifest; null when it is missing or not a JSON object. */
function readBundledManifestFile(file: string): BundledManifestFields | null {
  if (!existsSync(file)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as BundledManifestFields
  } catch (err) {
    console.warn(`[kernel] cannot read bundled manifest ${file}: ${(err as Error).message}`)
    return null
  }
}

/**
 * The kernel bundled into this shell build, or null when there is none.
 *
 * The first candidate that carries a manifest or a complete tarball pair wins;
 * a directory counts as "no bundle" only when it has neither, so a half-copied
 * bundle still answers with what it does have instead of silently falling
 * through to the online install.
 *
 * @param dirs - candidate directories; defaults to {@link bundledKernelDirs}.
 */
export function findBundledKernel(dirs: string[] = bundledKernelDirs()): BundledKernel | null {
  for (const dir of dirs) {
    const tarball = path.join(dir, 'kernel.tgz')
    const sha512 = `${tarball}.sha512`
    const complete = existsSync(tarball) && existsSync(sha512)
    const manifest = readBundledManifestFile(path.join(dir, 'manifest.json'))
    if (manifest === null && !complete) continue
    return {
      dir,
      tarball: complete ? tarball : null,
      sha512: complete ? sha512 : null,
      manifest,
    }
  }
  return null
}

/** The tarball and its sidecar of a bundle, or null when either is absent. */
export function bundledTarball(bundle: BundledKernel | null): { tarball: string; sha512: string } | null {
  if (bundle === null || bundle.tarball === null || bundle.sha512 === null) return null
  return { tarball: bundle.tarball, sha512: bundle.sha512 }
}

/**
 * The channel a bundled manifest declares, defaulting to `stable`.
 *
 * The value comes from a JSON file, so it is validated instead of trusted: the
 * kernel channel is part of every registry query and every status payload, and
 * an unexpected string would reach them all.
 */
export function bundledKernelChannel(bundle: BundledManifestFields | null): KernelChannel {
  const channel = bundle?.channel
  return channel === 'alpha' || channel === 'beta' ? channel : 'stable'
}

/** Which of the two installable kernels a decision landed on. */
export interface PreferredKernel {
  version: string
  source: 'bundled' | 'resolved'
}

/**
 * True when `version` is strictly newer than `against`.
 *
 * Versions that are not valid semver fall back to plain inequality: a
 * hand-edited or future-format version must never win or lose a comparison it
 * cannot take part in by throwing.
 */
export function isNewerKernel(version: string, against: string): boolean {
  if (semver.valid(version) !== null && semver.valid(against) !== null) return semver.gt(version, against)
  return version !== against
}

/**
 * Decide which kernel a shell should install when it can install either: the
 * version the configured channel resolves right now, or the one bundled inside
 * this build.
 *
 * Neither is newer by construction. The channel is the line the tree follows,
 * but the shell ships whenever it ships and a registry line moves on its own
 * cadence, so a build can be released ahead of its line (an alpha whose
 * artifact is not published yet) or behind it (a stable release cut while the
 * line moved to the next rc).
 *
 * Ties go to the bundle: the same version means the same content, already on
 * disk, so a download could only re-transfer it. Versions that are not valid
 * semver are compared by inequality with the channel winning — the registry is
 * the authority on what a line carries.
 *
 * @param input - the bundled `dshVersion` and the channel-resolved `dshVersion`,
 *   either of which may be null (no bundle / channel unresolvable).
 * @returns the version to install and where it comes from, or null when neither
 *   side produced one.
 */
export function preferredKernel(input: { bundled: string | null; resolved: string | null }): PreferredKernel | null {
  const bundled = input.bundled?.trim() ?? ''
  const resolved = input.resolved?.trim() ?? ''
  if (bundled === '') return resolved === '' ? null : { version: resolved, source: 'resolved' }
  if (resolved === '') return { version: bundled, source: 'bundled' }
  return isNewerKernel(resolved, bundled)
    ? { version: resolved, source: 'resolved' }
    : { version: bundled, source: 'bundled' }
}

export type BundledAdoptionReason =
  | 'platform-mismatch'
  | 'already-adopted'
  | 'online-ahead'
  | 'not-adopted-yet'

export interface BundledAdoptionDecision {
  /** True when the caller should re-activate the bundled tarball. */
  adopt: boolean
  reason: BundledAdoptionReason
}

/**
 * Decide whether the runtime bundled inside this shell build should replace
 * the active installation.
 *
 * The versioned kernel directory is named `dsh-<v>+suite-<v>`, so a NEW shell
 * shipping a same-version kernel whose content changed (the brand suite gained
 * a plugin) would otherwise have its directory reused verbatim and the new
 * content would never land — linkSuitePlugins then bails on the missing member
 * and the whole suite silently boots vanilla.
 *
 * Adoption is keyed on the bundle's semantic identity
 * (`<dshVersion>+<suiteVersion>` from the runtime's own manifest.json), never
 * on the tarball sha512: a packaged runtime tarball is not byte-reproducible
 * across builds (file mtimes and entry order differ), so comparing hashes
 * would re-extract an already-identical runtime on every boot.
 *
 * `active` is a structural subset of CurrentKernel, which keeps the decision
 * testable without touching a disk.
 */
export function decideBundledAdoption(
  bundled: BundledManifestFields,
  active: Pick<CurrentKernel, 'manifest' | 'bundledStamp'>,
): BundledAdoptionDecision {
  // A runtime built for another cell can never be activated here.
  if (bundled.platform !== active.manifest.platform || bundled.arch !== active.manifest.arch) {
    return { adopt: false, reason: 'platform-mismatch' }
  }

  const stamp = bundled.dshVersion !== undefined && bundled.suiteVersion !== undefined
    ? `${bundled.dshVersion}+${bundled.suiteVersion}`
    : undefined

  // "Has this install already adopted this exact bundle?" — the only question
  // that matters here, and one version arithmetic cannot answer: the previous
  // `sameVersion && suiteDrift` test fired just as readily when the bundle's
  // suite was OLDER than the installed one, silently downgrading a kernel the
  // user had already updated online.
  if (stamp !== undefined && active.bundledStamp === stamp) {
    return { adopt: false, reason: 'already-adopted' }
  }

  // An online update ahead of this shell's bundled kernel must survive: the
  // bundle is a snapshot from build time and is routinely older than what the
  // user installed from the registry.
  //
  // semver.gt throws on an unparseable version — the same behaviour the inline
  // check had before this extraction, and why the boot path keeps its
  // try/catch around the whole check.
  if (bundled.dshVersion !== undefined && semver.gt(active.manifest.dshVersion, bundled.dshVersion)) {
    return { adopt: false, reason: 'online-ahead' }
  }

  return { adopt: true, reason: 'not-adopted-yet' }
}
