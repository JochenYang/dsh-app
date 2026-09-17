/**
 * The suite's own dsh profile: the one the app boots, created on the spot when
 * it is not there yet.
 *
 * Upstream's desktop owns a reserved profile (its CLI refuses `--profile
 * desktop`), with its own bundle list and its own package-manager state, and
 * shares only the data layer. The suite does the same: the app boots
 * `dsh-app`, so the plugin world a user's own `dsh` / `dsh web` runs manage in
 * `web` stays theirs — including for our plugin market, which follows
 * `DSH_APP_PROFILE`, set to the profile actually booted.
 *
 * The host composes the profile from its own directory (`loadProfileDirectory`
 * reads its package.json, its bundle list and its patch file) and refuses to
 * boot without one, and the suite rows now live in that profile's patch file —
 * so the old "boot the shared `web` profile until the suite profile is ready"
 * two-phase boot is gone. The seeding work is the same either way: write the
 * manifest (the shipped template's bundle list) plus the user's own patch layer
 * where the old profile has one. Doing it before the first host start instead
 * of behind it means the very first launch already runs the suite.
 *
 * A host line that reads the profile as an INSTALLED tree needs one more thing
 * on top of the seed: the kernel tree under the profile's own node_modules
 * ({@link mirrorRuntimeIntoProfile}, gated by the host package's version — see
 * `hostProfileAnchor`), because that line resolves `@deepseek-ai/dsh` and every
 * bundle out of the profile rather than out of the runtime it was handed. A
 * manifest alone is enough for 0.1.6 and later; {@link dropRuntimeMirror} takes
 * the mirror away again when the app moves onto such a line.
 *
 * Third-party packages declared on the old profile are deliberately NOT carried
 * over: the in-app market reinstalls them into the new profile, and it is the
 * component that already knows how to satisfy pnpm's supply-chain policies,
 * prompt for build scripts and handle a spec that no longer resolves. Two "carry
 * the tree" variants were measured and rejected first:
 *
 *   - COPYING `profiles/web` across: pnpm's `.pnpm` virtual store holds
 *     SYMLINKS (peer dependencies) and Windows refuses to create them without
 *     Developer Mode or elevation — `EPERM: operation not permitted, symlink
 *     ...\.pnpm\...\cosmokit`, partway through.
 *   - REINSTALLING the old dependencies from the copied lockfile: `pnpm
 *     install` runs pnpm 11's supply-chain policy check over that lockfile and
 *     rejects entries inside the release-age cooldown
 *     (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, e.g. a plugin published hours
 *     ago) — the exclusion list the market writes does not apply to that
 *     check, so a migration would depend on whether the user's newest plugins
 *     happen to be old enough.
 *
 * Sessions, settings, credentials, workspaces and plugin storages live under
 * `$DSH_HOME` and are profile-independent: nothing about them moves.
 *
 * A seeding attempt is idempotent and self-healing: an interrupted attempt
 * leaves no marker, its directory is removed before the retry, and a profile
 * whose manifest is missing is rebuilt rather than booted half-formed.
 */
import { existsSync, promises as fs, type Stats } from 'node:fs'
import path from 'node:path'
import { LEGACY_PROFILE, SUITE_PROFILE, SUITE_PROFILE_BUNDLES } from '../shared/constants'
import { resolveDshHome } from './brand-suite'

/** Marker inside the suite profile: present = the profile is ready to boot. */
export const SUITE_PROFILE_MARKER = '.dsh-app-ready.json'

/** pnpm settings an upstream-initialized profile carries (app-boot initProfile). */
const PNPM_WORKSPACE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'

/** Where the marker lives for the given home. */
function markerPath(home = resolveDshHome()): string {
  return path.join(home, 'profiles', SUITE_PROFILE, SUITE_PROFILE_MARKER)
}

/** Whether the suite profile is ready to be booted. */
export function isSuiteProfileReady(home = resolveDshHome()): boolean {
  return existsSync(markerPath(home))
}

/** Whether the suite profile carries the manifest a host composition needs. */
export function hasSuiteProfileManifest(home = resolveDshHome()): boolean {
  return existsSync(path.join(home, 'profiles', SUITE_PROFILE, 'package.json'))
}

/** Outcome of one attempt. */
export interface MigrationOutcome {
  /** `already` — marker present; `seeded` — profile created now; `failed` — see detail. */
  status: 'already' | 'seeded' | 'failed'
  /** Package names the old profile declares (they stay there; the market reinstalls). */
  legacyPackages: number
  /** Whether the user's own patch layer was carried over. */
  carriedPatch: boolean
  /** Failure detail, for the log. */
  detail?: string
}

/** Whether the profile can be booted, and what had to happen for that. */
export interface SuiteProfileStatus {
  /** Absolute profile directory to boot. */
  dir: string
  /** False when neither the manifest nor the seeding attempt produced one. */
  ready: boolean
  /** The seeding attempt, or null when the profile was already there. */
  outcome: MigrationOutcome | null
}

/** Package names a profile's manifest declares. */
async function declaredPackages(profileDir: string): Promise<number> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(profileDir, 'package.json'), 'utf8'))
    const dependencies = (parsed as { dependencies?: Record<string, unknown> }).dependencies
    return dependencies === undefined ? 0 : Object.keys(dependencies).length
  } catch {
    return 0
  }
}

/**
 * Materialize the suite profile. Idempotent: a profile that already carries its
 * manifest short-circuits a second call, and a failed attempt removes its own
 * half-built directory so the retry starts clean.
 *
 * @returns what happened, for the caller's log line.
 */
export async function migrateSuiteProfile(): Promise<MigrationOutcome> {
  const home = resolveDshHome()
  if (isSuiteProfileReady(home) && hasSuiteProfileManifest(home)) {
    return { status: 'already', legacyPackages: 0, carriedPatch: false }
  }

  const target = path.join(home, 'profiles', SUITE_PROFILE)
  const legacy = path.join(home, 'profiles', LEGACY_PROFILE)
  try {
    // A leftover directory without a usable manifest is an interrupted attempt.
    await fs.rm(target, { recursive: true, force: true })
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(
      path.join(target, 'package.json'),
      `${JSON.stringify({
        name: `dsh-profile-${SUITE_PROFILE}`,
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: [...SUITE_PROFILE_BUNDLES], patchReload: 'live' } },
      }, undefined, 2)}\n`,
      'utf8',
    )
    await fs.writeFile(path.join(target, 'pnpm-workspace.yaml'), PNPM_WORKSPACE, 'utf8')

    // The user's own rows — hand-written disables and MCP inserts. Copied
    // verbatim: an id that does not exist in this profile is simply inert.
    let carriedPatch = false
    try {
      await fs.copyFile(path.join(legacy, 'cordis.patch.yml'), path.join(target, 'cordis.patch.yml'))
      carriedPatch = true
    } catch {
      /* the old profile has no patch layer: nothing to carry */
    }

    const legacyPackages = await declaredPackages(legacy)
    await fs.writeFile(
      markerPath(home),
      `${JSON.stringify({
        migratedAt: new Date().toISOString(),
        from: LEGACY_PROFILE,
        carriedPatch,
        legacyPackages,
      }, undefined, 2)}\n`,
      'utf8',
    )
    return { status: 'seeded', legacyPackages, carriedPatch }
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => undefined)
    return { status: 'failed', legacyPackages: 0, carriedPatch: false, detail: (error as Error).message }
  }
}

/**
 * Ensure the profile the app is about to boot exists, seeding it when it does
 * not. Called once per host start, before the suite patch layer is written (the
 * patch file lives inside this directory).
 *
 * @returns the directory to boot plus whether it is usable, and what had to
 *   happen for that (for the log line).
 */
export async function ensureSuiteProfile(): Promise<SuiteProfileStatus> {
  const home = resolveDshHome()
  const dir = path.join(home, 'profiles', SUITE_PROFILE)
  if (hasSuiteProfileManifest(home)) return { dir, ready: true, outcome: null }
  const outcome = await migrateSuiteProfile()
  return { dir, ready: outcome.status !== 'failed', outcome }
}

// ------------------------------------------------- profile as installed tree

/** Marker inside the profile recording the runtime tree its node_modules mirrors. */
export const PROFILE_KERNEL_MARKER = '.dsh-app-kernel.json'

/** What one mirror step did, for the caller's log line. */
export interface KernelTreeOutcome {
  /**
   * `mirrored` — files were written now; `already` — the profile already mirrors
   * this runtime; `removed` — a mirror of an earlier runtime was dropped;
   * `failed` — nothing was guaranteed, see detail. The step never throws: the
   * host start reports the consequence with its own message.
   */
  status: 'mirrored' | 'already' | 'removed' | 'failed'
  /** Top-level `node_modules` entries the mirror covers. */
  entries: number
  /** Files hardlinked (or copied, where the volumes differ) in this run. */
  files: number
  /** Failure detail, for the log. */
  detail?: string
}

/** One profile's mirror record: what this shell put there, and from where. */
interface KernelMarker {
  /** Real path of the runtime tree the mirror was taken from. */
  readonly runtime: string
  /** Top-level entries the mirror owns inside the profile's node_modules. */
  readonly names: readonly string[]
  /** Files the mirror wrote, for diagnostics. */
  readonly files: number
  /** When it was written. */
  readonly at: string
}

/** Read the mirror marker; undefined when it is absent or unusable. */
async function readKernelMarker(markerPath: string): Promise<KernelMarker | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(markerPath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    const value = parsed as Record<string, unknown>
    if (typeof value.runtime !== 'string' || !Array.isArray(value.names)) return undefined
    const names = value.names.filter((name): name is string => typeof name === 'string')
    return {
      runtime: value.runtime,
      names,
      files: typeof value.files === 'number' ? value.files : 0,
      at: typeof value.at === 'string' ? value.at : '',
    }
  } catch {
    return undefined
  }
}

/** `lstat`, or undefined when the path is absent (every other failure is real). */
async function statOrUndefined(target: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Remove a path WITHOUT ever following a link.
 *
 * Why this exists at all: `fs.rm(path, { recursive: true })` follows a directory
 * junction on the way down — measured on this machine, Electron 44.4.1 / Node
 * 24.21, removing a directory that held junctions into a runtime tree emptied
 * that runtime's own package directories. A profile is a directory users and
 * package managers delete, so this module must never hand such a call a path
 * whose descendants can be links.
 */
async function removeWithoutLinks(target: string): Promise<void> {
  const stats = await statOrUndefined(target)
  if (stats === undefined) return
  if (stats.isSymbolicLink()) {
    await fs.unlink(target)
    return
  }
  if (!stats.isDirectory()) {
    await fs.rm(target, { force: true })
    return
  }
  for (const entry of await fs.readdir(target)) await removeWithoutLinks(path.join(target, entry))
  await fs.rmdir(target)
}

/** Make `target` a real directory, replacing a link or a file in its place. */
async function ensureDirectory(target: string): Promise<void> {
  const stats = await statOrUndefined(target)
  if (stats !== undefined) {
    if (stats.isDirectory() && !stats.isSymbolicLink()) return
    await removeWithoutLinks(target)
  }
  await fs.mkdir(target, { recursive: true })
}

/**
 * One mirrored tree: hardlink `source`'s files into `target`, creating the
 * directories the shape needs and replacing whatever else occupies a name the
 * runtime tree claims.
 *
 * A hardlink is the point. The file gains a second name inside the profile, so a
 * recursive delete inside the profile can only unlink OUR name — the runtime's
 * own file stays where it was (measured both ways: through a junction the target
 * loses its files, through a hardlink it loses nothing).
 *
 * @returns how many files this subtree contributed.
 */
async function mirrorTree(source: string, target: string): Promise<number> {
  let files = 0
  await ensureDirectory(target)
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) {
      files += await mirrorTree(from, to)
      continue
    }
    const existing = await statOrUndefined(to)
    if (existing !== undefined) await removeWithoutLinks(to)
    try {
      await fs.link(from, to)
    } catch {
      // Two volumes, or a filesystem without hardlinks: a copy is the only
      // truthful fallback, and the safety argument above still holds.
      await fs.copyFile(from, to)
    }
    files += 1
  }
  return files
}

/**
 * Give a profile the kernel tree a pre-0.1.6 host anchors on.
 *
 * Those hosts read the profile as an INSTALLED tree rather than as a manifest:
 * `desktopPatches` resolves `<profile>/node_modules/@deepseek-ai/dsh`, uses that
 * package's directory as the anchor every bundle resolves from, and then imports
 * the composed entries — whose own dependencies resolve by walking up from their
 * file, i.e. out of this profile. A manifest-only profile dies with `installed
 * package "@deepseek-ai/dsh" has no manifest`; a profile carrying only the
 * `@deepseek-ai` scope dies with `Cannot find package 'ws'`, because the runtime
 * installs the vendor packages (and the other scopes) at its own node_modules
 * top level. So the mirror covers every top-level entry of the runtime's
 * `node_modules`, not just the scope the anchor names.
 *
 * Idempotent: the profile's marker records the runtime it mirrors and the entries
 * it owns, and a start whose marker matches and whose entries are all still there
 * writes nothing.
 *
 * Ownership fence: a top-level entry the runtime tree does not carry and this
 * shell never mirrored — a plugin the market installed, pnpm's own state — is
 * never touched. A name the runtime DOES carry belongs to the kernel, and there
 * the runtime's copy wins.
 *
 * @param runtimeDir - the runtime tree whose `node_modules` is the source.
 * @param profileDir - the profile to make self-contained.
 * @returns what happened, for the caller's log line. Never throws.
 */
export async function mirrorRuntimeIntoProfile(runtimeDir: string, profileDir: string): Promise<KernelTreeOutcome> {
  const source = path.join(runtimeDir, 'node_modules')
  const target = path.join(profileDir, 'node_modules')
  const markerPath = path.join(profileDir, PROFILE_KERNEL_MARKER)
  try {
    // `.bin` is npm's own shim directory for the runtime's private layout; it is
    // not resolution-relevant and its scripts name absolute runtime paths.
    const names = (await fs.readdir(source)).filter((name) => name !== '.bin').sort()
    if (names.length === 0) {
      return { status: 'failed', entries: 0, files: 0, detail: `${source} carries no packages` }
    }
    const runtime = await fs.realpath(runtimeDir)
    const marker = await readKernelMarker(markerPath)
    if (marker !== undefined && marker.runtime === runtime) {
      const absent = await Promise.all(names.map(async (name) => (await statOrUndefined(path.join(target, name))) === undefined))
      if (!absent.some(Boolean)) return { status: 'already', entries: names.length, files: marker.files }
    }
    await fs.mkdir(target, { recursive: true })
    let files = 0
    for (const name of names) files += await mirrorTree(path.join(source, name), path.join(target, name))
    // Entries an earlier mirror owned and this runtime no longer carries: the
    // kernel dropped them, and a stale copy would keep resolving.
    const current = new Set(names)
    for (const name of marker?.names ?? []) {
      if (!current.has(name)) await removeWithoutLinks(path.join(target, name))
    }
    await fs.writeFile(markerPath, `${JSON.stringify({
      runtime,
      names,
      files,
      at: new Date().toISOString(),
    }, undefined, 2)}\n`, 'utf8')
    return { status: 'mirrored', entries: names.length, files }
  } catch (error) {
    return { status: 'failed', entries: 0, files: 0, detail: (error as Error).message }
  }
}

/**
 * Drop a mirror this shell made, for a host line that no longer needs one.
 *
 * A host that anchors on the runtime tree resolves every kernel package there,
 * so a mirror left in the profile is not read for kernel code — but the suite
 * plugins live in that same tree, and a stale copy would be the one the loader
 * finds. Removing exactly the entries the marker proves this shell created keeps
 * a kernel-line change from booting the previous line's plugin code.
 *
 * @param profileDir - the profile to clean.
 * @returns `removed` when a mirror was there and is gone, `already` otherwise.
 */
export async function dropRuntimeMirror(profileDir: string): Promise<KernelTreeOutcome> {
  const markerPath = path.join(profileDir, PROFILE_KERNEL_MARKER)
  try {
    const marker = await readKernelMarker(markerPath)
    if (marker === undefined) return { status: 'already', entries: 0, files: 0 }
    for (const name of marker.names) await removeWithoutLinks(path.join(profileDir, 'node_modules', name))
    await fs.rm(markerPath, { force: true })
    return { status: 'removed', entries: marker.names.length, files: marker.files }
  } catch (error) {
    return { status: 'failed', entries: 0, files: 0, detail: (error as Error).message }
  }
}
