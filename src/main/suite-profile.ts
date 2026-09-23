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
 * where the old profile has one, AND the files that layer names by relative
 * path (a `local-plugins/` folder). The layer is only text, and text pointing at
 * a file that stayed behind boots a tree that cannot load at all: measured on a
 * real profile, the app looped boot → rollback → boot for a day, on every
 * kernel line, until the user restored the file by hand. Doing the seeding
 * before the first host start instead of behind it means the very first launch
 * already runs the suite.
 *
 * A host line that reads the profile as an INSTALLED tree needs one more thing
 * on top of the seed: the kernel tree under the profile's own node_modules
 * ({@link mirrorRuntimeIntoProfile}, gated by the host package's version — see
 * `hostProfileAnchor`), because that line resolves `@deepseek-ai/dsh` and every
 * bundle out of the profile rather than out of the runtime it was handed. A
 * manifest alone is enough for 0.1.6 and later; {@link dropRuntimeMirror} takes
 * the mirror away again when the app moves onto such a line. Both steps own
 * their entries at PACKAGE granularity: a scope directory is shared with the
 * market, which installs its own packages inside `@deepseek-ai` (see
 * {@link removeOwnedEntry}), and a package the profile's own lockfile records is
 * the market's outright — neither step overwrites nor deletes it (see
 * {@link lockfileOwnedNames}). A removal additionally has to be WITNESSED: the
 * runtime tree the marker was taken from is the only record of what the mirror
 * wrote, so a name that tree does not carry is left in place rather than guessed
 * away (see {@link mirrorWitnessGap}).
 *
 * Third-party packages declared on the old profile are deliberately NOT carried
 * over: the in-app market reinstalls them into the new profile, and it is the
 * component that already knows how to satisfy pnpm's supply-chain policies,
 * prompt for build scripts and handle a spec no longer resolves. That decision
 * is about the PACKAGE TREE; a file the user's own patch names travels, and it
 * is copied one path at a time rather than by moving the profile across, so
 * neither the package-manager state nor `node_modules` is ever dragged along.
 * Two "carry the tree" variants were measured and rejected first:
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
import { PLUGIN_SCOPE, PROFILE_PATCH_FILENAME, relativePatchSpecifiers, resolveDshHome } from './brand-suite'

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
  /**
   * Relative specifiers the patch names whose files were carried into the new
   * profile along with it (`./local-plugins/…`). Empty in the normal case: a
   * row naming a file is the exception, a row naming a package the rule.
   */
  carriedFiles: readonly string[]
  /**
   * Relative specifiers the patch names whose files resolved nowhere — neither
   * the old profile nor anywhere else. Such a row cannot load in the new
   * profile, so the composition guard keeps it out of the boot; this list is
   * what the log line names.
   */
  unresolvedFiles: readonly string[]
  /**
   * Relative specifiers the shell DECLINED to carry: one resolving outside the
   * old profile, one reached through a link that leaves it, one naming the
   * shell's own state, or one whose copy would have crossed an allowance. The
   * row cannot load either, but the fix is a different one — the file is there.
   */
  refusedFiles: readonly string[]
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

/** Cap on the files one migration carries out of the old profile. */
const MAX_CARRIED_FILES = 500

/** Cap on the bytes one migration carries out of the old profile. */
const MAX_CARRIED_BYTES = 50 * 1024 * 1024

/**
 * Whether `rel` (relative to the new profile) is a path the carry must not write.
 *
 * The patch is the user's own, so this is not a fence against a stranger — it is
 * the shell protecting the state it just wrote. `./package.json` would replace
 * the manifest the profile is booted from, and the marker written afterwards
 * would declare that profile ready, so it would never be rebuilt; the lockfile
 * would make the kernel mirror treat the OLD profile's packages as the market's
 * own and leave them alone; anything under `node_modules/` would shadow the
 * packages the mirror and the market own.
 *
 * The comparison is normalized because the same file has more than one spelling
 * and only one of them is the one a user writes: Windows (and macOS) fold case,
 * Windows drops trailing dots and spaces, and `name:` is the one field where an
 * NTFS stream suffix (`./package.json:$DATA`) could name the file of that name.
 * A spelling this misses would let the carry — and its cleanup — land on the
 * shell's own file, which is the whole point of the check.
 *
 * The names are listed here rather than in a module constant because two of them
 * belong to the installed-tree section further down the file.
 */
function refusedTarget(rel: string): boolean {
  const refused: readonly string[] = [
    'package.json',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    PROFILE_PATCH_FILENAME,
    SUITE_PROFILE_MARKER,
    PROFILE_KERNEL_MARKER,
  ]
  const segments = rel.split(/[\\/]+/u).filter((segment) => segment !== '')
  if (segments.length === 0) return true
  const first = normalizeSegment(segments[0] ?? '')
  if (first === 'node_modules') return true
  return segments.length === 1 && refused.includes(first)
}

/**
 * One path segment, as the file system of this platform sees it.
 *
 * Only for comparison against the shell's own names — nothing is written under
 * the normalized form: `:stream` is dropped (the file of that name is what the
 * copy would hit), trailing dots and spaces are dropped (Windows ignores them),
 * and the remainder is folded to lower case (Windows and macOS compare that way,
 * POSIX does not — folding there can only ever refuse MORE, which is the safe
 * direction for this check).
 */
function normalizeSegment(segment: string): string {
  return (segment.split(':')[0] ?? '').replace(/[. ]+$/u, '').toLowerCase()
}

/** What one migration may still copy, and whether it stopped early. */
interface CarryBudget {
  /** Files still allowed. */
  left: number
  /** Bytes copied so far. */
  bytes: number
  /** Set when a copy stopped because an allowance ran out. */
  hit: boolean
}

/** File text, or '' when it is absent or unreadable. */
async function readTextIfExists(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return ''
  }
}

/** Whether `candidate` is a path inside `root` (never `root` itself). */
function insideRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Copy one referenced FILE from the old profile into the new one.
 *
 * Files only: a row names a path the loader imports, and a directory is not
 * importable — the kernel hands a relative specifier to Node's own ESM resolver
 * (`dsh-app-boot` falls through to `native` when no route matches), which throws
 * on a directory and on an unknown extension alike. A directory source is
 * reported rather than copied, so the effort never lands somewhere the loader
 * cannot use.
 *
 * Symlinks are never followed: the file a link points at may live in the runtime
 * tree, and a profile must not end up carrying that (`dropRuntimeMirror` applies
 * the same rule in the other direction).
 *
 * @param source - absolute source path, inside the old profile.
 * @param target - absolute destination, inside the new profile.
 * @param budget - remaining allowances; decremented per copied file, and flagged
 *   when an allowance is what stopped the copy.
 * @returns how many files were copied (0 or 1).
 */
async function copyReferenced(source: string, target: string, budget: CarryBudget): Promise<number> {
  if (budget.left <= 0 || budget.bytes >= MAX_CARRIED_BYTES) {
    budget.hit = true
    return 0
  }
  const stats = await fs.lstat(source).catch(() => undefined)
  if (stats === undefined || stats.isSymbolicLink() || !stats.isFile()) return 0
  if (budget.bytes + stats.size > MAX_CARRIED_BYTES) {
    budget.hit = true
    return 0
  }
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.copyFile(source, target)
  budget.left -= 1
  budget.bytes += stats.size
  return 1
}

/**
 * Carry the files a patch text points at from the old profile into the new one.
 *
 * The patch travels as TEXT, and a row may name a file rather than a package (a
 * local plugin under `./local-plugins/`). Carrying the text without the file
 * boots a composition whose single unresolvable entry fails the ENTIRE tree, on
 * every kernel line: measured on a real profile, that looped boot → rollback →
 * boot until the user restored the file by hand, with the app never reaching a
 * window.
 *
 * The specifiers come from the patch just copied AND from the home layer: a
 * relative specifier in either resolves against the profile being booted, so a
 * file the home layer names has to exist in THIS profile too.
 *
 * Every step degrades to "not carried" rather than to a failed migration: a
 * locked file, a link that leaves the old profile, a specifier naming the
 * shell's own state, a copy that would cross an allowance. The caller reports
 * the lists, and the composition guard keeps those rows out of the boot — the
 * app starts with the row disabled instead of not starting at all.
 *
 * The two failure lists are kept apart on purpose, because the fix for each is
 * the user's to make and they are not the same fix: `unresolved` means the file
 * could not be found or read (restore it, or drop the row), `refused` means the
 * shell declined to copy what is there (move the file inside the profile, drop
 * the link, or name something other than the shell's own state).
 *
 * @param legacy - the old profile directory; the only source anything is read
 *   from (a specifier resolving outside it is refused, not followed).
 * @param target - the new profile directory.
 * @param home - `$DSH_HOME`, where the home layer lives.
 * @returns the specifiers that were carried, those whose file was not there, and
 *   those the shell declined to copy.
 */
async function carryPatchFiles(
  legacy: string,
  target: string,
  home: string,
): Promise<{ carried: string[], unresolved: string[], refused: string[] }> {
  const specifiers = [
    ...relativePatchSpecifiers(await readTextIfExists(path.join(target, PROFILE_PATCH_FILENAME))),
    ...relativePatchSpecifiers(await readTextIfExists(path.join(home, PROFILE_PATCH_FILENAME))),
  ]
  const carried: string[] = []
  const unresolved: string[] = []
  const refused: string[] = []
  const budget: CarryBudget = { left: MAX_CARRIED_FILES, bytes: 0, hit: false }
  const legacyReal = await fs.realpath(legacy).catch(() => undefined)
  const targetReal = await fs.realpath(target).catch(() => undefined)
  for (const specifier of [...new Set(specifiers)]) {
    const from = path.resolve(legacy, specifier)
    const to = path.resolve(target, specifier)
    if (!insideRoot(legacy, from) || !insideRoot(target, to) || refusedTarget(path.relative(target, to))) {
      refused.push(specifier)
      continue
    }
    // A link in the MIDDLE of the path (`local-plugins` as a junction) passes
    // every lexical check while the bytes come from somewhere else entirely, so
    // the real path is what decides: a link pointing at the runtime tree cannot
    // drag kernel files into the profile. The same check refuses the degenerate
    // case where the two profiles are one directory through a link, which would
    // otherwise copy a file onto itself and then clean "the copy" away.
    const fromReal = await fs.realpath(from).catch(() => undefined)
    if (fromReal === undefined) {
      unresolved.push(specifier)
      continue
    }
    if (legacyReal === undefined || targetReal === undefined
      || !insideRoot(legacyReal, fromReal) || insideRoot(targetReal, fromReal)) {
      refused.push(specifier)
      continue
    }
    budget.hit = false
    try {
      if (await copyReferenced(from, to, budget) === 0 || budget.hit) {
        if (budget.hit) {
          await fs.rm(to, { recursive: true, force: true }).catch(() => undefined)
          refused.push(specifier)
          continue
        }
        unresolved.push(specifier)
        continue
      }
    } catch {
      // Half a copy is worse than none: remove it and let the guard report the row.
      await fs.rm(to, { recursive: true, force: true }).catch(() => undefined)
      unresolved.push(specifier)
      continue
    }
    carried.push(specifier)
  }
  return { carried, unresolved, refused }
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
    return { status: 'already', legacyPackages: 0, carriedPatch: false, carriedFiles: [], unresolvedFiles: [], refusedFiles: [] }
  }

  const target = path.join(home, 'profiles', SUITE_PROFILE)
  const legacy = path.join(home, 'profiles', LEGACY_PROFILE)
  try {
    // A leftover directory without a usable manifest is an interrupted attempt.
    await fs.rm(target, { recursive: true, force: true })
    await fs.mkdir(target, { recursive: true })

    // The user's own rows — hand-written disables and MCP inserts. Copied
    // verbatim: a row naming a package this profile lacks is filtered out of
    // the composition at write time, and a row naming a FILE gets that file
    // carried over below.
    let carriedPatch = false
    try {
      await fs.copyFile(path.join(legacy, PROFILE_PATCH_FILENAME), path.join(target, PROFILE_PATCH_FILENAME))
      carriedPatch = true
    } catch {
      /* the old profile has no patch layer: nothing to carry */
    }
    const { carried, unresolved, refused } = await carryPatchFiles(legacy, target, home)

    // The shell's own files are written AFTER the carry, so its state wins even
    // if a patch spelled one of them in a form `refusedTarget` did not
    // recognize: a manifest the carry replaced would leave the profile booting
    // the old bundle list while the marker already called it ready.
    await fs.writeFile(
      path.join(target, 'package.json'),
      `${JSON.stringify({
        name: `dsh-profile-${SUITE_PROFILE}`,
        private: true,
        dependencies: {},
        // No `patchReload`: the field was removed upstream — a profile's
        // configuration reloads through the base bundle's `hmr` row now
        // (`packages/bundle/base`, `cordis.patch.yml`), which this kernel line
        // always composes. Writing it here would be a field nothing reads, and a
        // later reader would have to find out the hard way that it decides
        // nothing about reload behaviour.
        dsh: { profile: { bundles: [...SUITE_PROFILE_BUNDLES] } },
      }, undefined, 2)}\n`,
      'utf8',
    )
    await fs.writeFile(path.join(target, 'pnpm-workspace.yaml'), PNPM_WORKSPACE, 'utf8')

    const legacyPackages = await declaredPackages(legacy)
    await fs.writeFile(
      markerPath(home),
      `${JSON.stringify({
        migratedAt: new Date().toISOString(),
        from: LEGACY_PROFILE,
        carriedPatch,
        carriedFiles: carried,
        unresolvedFiles: unresolved,
        refusedFiles: refused,
        legacyPackages,
      }, undefined, 2)}\n`,
      'utf8',
    )
    return { status: 'seeded', legacyPackages, carriedPatch, carriedFiles: carried, unresolvedFiles: unresolved, refusedFiles: refused }
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => undefined)
    return {
      status: 'failed',
      legacyPackages: 0,
      carriedPatch: false,
      carriedFiles: [],
      unresolvedFiles: [],
      refusedFiles: [],
      detail: (error as Error).message,
    }
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

/** The profile's own package-manager state; see {@link lockfileOwnedNames}. */
const PROFILE_LOCKFILE = 'pnpm-lock.yaml'

/** One name a removal step declined to touch, and why (see {@link mirrorWitnessGap}). */
export interface KeptEntry {
  /** The marker name, at the granularity the marker recorded. */
  readonly name: string
  /** English diagnostic, for the caller's log line. */
  readonly reason: string
}

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
  /**
   * Names the step would have removed but left in place, each because the tree
   * the marker recorded could not witness it ({@link mirrorWitnessGap}). The
   * caller logs one line per entry; empty in the normal case.
   */
  kept: readonly KeptEntry[]
  /** Failure detail, for the log. */
  detail?: string
}

/** One profile's mirror record: what this shell put there, and from where. */
interface KernelMarker {
  /** Real path of the runtime tree the mirror was taken from. */
  readonly runtime: string
  /**
   * The paths the mirror owns inside the profile's node_modules, at PACKAGE
   * granularity: `@scope/name` for a scoped package, a bare `name` otherwise.
   * A marker written before ownership stopped at packages records a bare
   * `@scope` directory instead — see {@link ownedRemovals}.
   */
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
 * Why this exists at all: the SYNC recursive delete (`fs.rmSync(dir, {
 * recursive: true })`) follows a directory junction on the way down — measured
 * on this machine, Electron 44.4.1 / Node 24.21, removing a directory that held
 * junctions into a runtime tree emptied that runtime's own package directories.
 * The async `fs.rm` does not follow one (asserted in
 * `test/recursive-delete-guard.test.mjs`), and this walker exists so that
 * neither form is ever handed a path whose descendants can be links: a profile
 * is a directory users and package managers delete, and the correctness of a
 * delete must not rest on which spelling of the call someone reached for.
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

/** Join one owned path (`@scope/name` or `name`) onto a node_modules directory. */
function ownedTarget(nodeModulesDir: string, name: string): string {
  return path.join(nodeModulesDir, ...name.split('/'))
}

/** Ensure every level above an owned path exists as a REAL directory. */
async function ensureOwnedParent(nodeModulesDir: string, name: string): Promise<void> {
  const parts = name.split('/')
  parts.pop()
  let current = nodeModulesDir
  for (const part of parts) {
    current = path.join(current, part)
    await ensureDirectory(current)
  }
}

/** Remove a directory that is real and empty; leave anything else alone. */
async function pruneEmptyDirectory(target: string): Promise<void> {
  const stats = await statOrUndefined(target)
  if (stats === undefined || !stats.isDirectory() || stats.isSymbolicLink()) return
  try {
    await fs.rmdir(target)
  } catch {
    // Not empty — the market installs into scopes too — or busy: leave it.
  }
}

/**
 * Remove one owned path, plus a scope directory the removal emptied.
 *
 * The scope is shared ground: the kernel ships packages in `@deepseek-ai` and
 * the in-app market installs its own packages under whatever scope their
 * publisher chose (`@deepseek-ai/dsh-toolkit` is one that really ships that
 * way). A scope therefore only goes away once its last package does.
 */
async function removeOwnedEntry(nodeModulesDir: string, name: string): Promise<void> {
  await removeWithoutLinks(ownedTarget(nodeModulesDir, name))
  const slash = name.indexOf('/')
  if (slash === -1) return
  await pruneEmptyDirectory(path.join(nodeModulesDir, name.slice(0, slash)))
}

/**
 * The paths a marker name may be removed as.
 *
 * A name that already stops at a package is itself. A BARE `@scope` name only
 * exists in markers written before ownership did, and removing that path
 * wholesale takes the market's packages with the kernel's — a profile whose
 * manifest still declares them cannot boot (`cannot resolve profile bundle ...`).
 * Such a name is narrowed to the packages the MIRRORED tree carries inside that
 * scope, which is exactly what the mirror wrote there: narrowing against the
 * tree running now leaves behind every package the old line had and this one does
 * not, and a leftover kernel package shadows this line's own.
 *
 * @param name - the recorded name.
 * @param sources - candidate runtime `node_modules` directories, most specific
 *   first; undefined entries are skipped. With none left a scope entry is left
 *   alone: a stale kernel copy is recoverable, a deleted user package is not.
 * @returns the paths to remove; empty when the name is not this shell's to take.
 */
async function ownedRemovals(name: string, sources: readonly (string | undefined)[]): Promise<string[]> {
  if (name.includes('/') || !name.startsWith('@')) return [name]
  for (const source of sources) {
    if (source === undefined) continue
    try {
      const entries = await fs.readdir(path.join(source, name), { withFileTypes: true })
      return entries.map((entry) => `${name}/${entry.name}`)
    } catch {
      // Not there — the kernel it mirrored was cleaned up. Try the next source.
    }
  }
  return []
}

/**
 * Why a marker name may NOT be touched, or undefined when the mirror can be
 * PROVEN to have written it.
 *
 * The marker is a claim, not evidence: it records what a mirror of some past
 * start intended to own, and the tree it names is the only remaining witness of
 * what it actually wrote. Two ways that claim goes stale:
 *
 *   - the runtime it mirrored was cleaned up, so a marker that was told about a
 *     mirror on a line the user has since dropped cannot prove anything at all
 *     about the copy now in the profile;
 *   - the tree is there and simply does not carry the name, which means the
 *     marker is describing something else's installation — a package manager
 *     may have replaced the mirror's copy after the marker was written, which
 *     the lockfile fence catches only while the lockfile is readable.
 *
 * A name that fails this check is left where it is. That is the deliberate
 * direction of the error: a leftover kernel package shadows this line's copy
 * only in the case the marker already proves a mirror happened, while a deleted
 * user package cannot be recovered by anything the shell runs.
 *
 * @param name - one path from a marker, at the granularity the marker recorded.
 * @param mirroredFrom - the recorded runtime's `node_modules`, or undefined
 *   when there is no marker at all.
 * @returns the English reason to leave the name alone, or undefined to remove
 *   it.
 */
async function mirrorWitnessGap(name: string, mirroredFrom: string | undefined): Promise<string | undefined> {
  if (mirroredFrom === undefined) return 'the marker records no runtime to check it against'
  if (await statOrUndefined(ownedTarget(mirroredFrom, name)) !== undefined) return undefined
  const tree = await statOrUndefined(mirroredFrom)
  return tree === undefined
    ? `the runtime it was mirrored from is gone (${path.dirname(mirroredFrom)})`
    : 'the runtime it was mirrored from does not carry it'
}

/**
 * The entries of a runtime's `node_modules` a mirror takes ownership of.
 *
 * Ownership stops one level inside a scope directory, at the package: see
 * {@link removeOwnedEntry} for why the scope itself is never owned.
 *
 * @param nodeModulesDir - the runtime's `node_modules`.
 * @returns relative paths, `@scope/name` for a scoped package.
 */
async function ownedPaths(nodeModulesDir: string): Promise<string[]> {
  const owned: string[] = []
  for (const entry of await fs.readdir(nodeModulesDir, { withFileTypes: true })) {
    // `.bin` is npm's own shim directory for the runtime's private layout; it is
    // not resolution-relevant and its scripts name absolute runtime paths.
    if (entry.name === '.bin') continue
    if (entry.name.startsWith('@') && entry.isDirectory() && !entry.isSymbolicLink()) {
      for (const inner of await fs.readdir(path.join(nodeModulesDir, entry.name), { withFileTypes: true })) {
        owned.push(`${entry.name}/${inner.name}`)
      }
      continue
    }
    owned.push(entry.name)
  }
  return owned.sort()
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
 * The package name a lockfile key names.
 *
 * `@scope/name@1.2.3` and `name@1.2.3` both name the directory the package
 * occupies, which is what ownership is recorded in, so everything from the
 * version separator on is dropped — including a peer-dependency suffix
 * (`name@1.2.3(peer@4.5.6)`) and an alias (`name@npm:other@1.2.3`), which would
 * otherwise end up inside the name.
 *
 * @param key - one lockfile key, unquoted.
 * @returns the name, or undefined when the key is not `name@version`.
 */
function packageNameFromKey(key: string): string | undefined {
  const separator = key.startsWith('@') ? key.indexOf('@', 1) : key.indexOf('@')
  if (separator <= 0 || separator === key.length - 1) return undefined
  const name = key.slice(0, separator)
  if (name.includes(' ') || name.endsWith('/')) return undefined
  return name
}

/**
 * The package names a profile's own lockfile accounts for.
 *
 * The mirror's ownership has to stop at them. pnpm's `nodeLinker: hoisted` puts
 * the profile's own dependencies at the top of the profile's `node_modules` —
 * the very level a mirror writes to — so one name can be both the market's
 * installation and a package the runtime carries. It is the market's: the
 * lockfile is that install's record, the mirror is a fallback for a host line
 * that needs kernel packages there, and a fallback does not overwrite or delete
 * the state it found. Measured: dropping a mirror removed
 * `<profile>/node_modules/iconv-lite`, which a market-installed `dsh-better-edit`
 * resolves (`Cannot find package 'iconv-lite' imported from
 * .../dsh-better-edit/lib/encoding.js` on the next production boot; dev boots
 * hid it because the checkout's own tree satisfied the parent walk).
 *
 * Read textually on purpose: the shape is stable — two-space indented
 * `name@version:` keys inside `packages:`/`snapshots:`, quoted when the name is
 * scoped, with `{}` as an inline value where the entry carries nothing else
 * (pnpm writes a leaf package that way, so a parse that insisted on a bare
 * colon would miss exactly the packages most likely to be shared) — and no YAML
 * parser belongs on a boot path. Anything unrecognized accounts for NOTHING,
 * which is the behaviour before this fence existed, so a lockfile this cannot
 * read costs a kernel package its overwrite but never a user package its
 * existence.
 *
 * @param text - the lockfile's contents.
 * @returns the names it records; empty when the text is not a usable lockfile.
 */
export function lockfileOwnedNames(text: string): Set<string> {
  const names = new Set<string>()
  let section = ''
  for (const line of text.split(/\r?\n/u)) {
    if (/^\S/u.test(line)) {
      // A top-level key. Only `packages:`/`snapshots:` hold package keys:
      // `importers:` holds workspace paths, and the dependency maps under it
      // carry versions as VALUES, so none of those lines is a package key.
      section = /^([A-Za-z]+):\s*$/u.exec(line)?.[1] ?? ''
      continue
    }
    if (section !== 'packages' && section !== 'snapshots') continue
    // The key ends at the first colon that leaves only an empty or
    // whitespace-indented tail, which keeps a `:` inside a spec (`foo@npm:bar@1.2.3`,
    // a tarball URL) where it belongs. Deeper indentation is a nested map.
    const raw = /^ {2}(\S.*?):(?:\s.*)?$/u.exec(line)?.[1]
    if (raw === undefined) continue
    // pnpm quotes a key it would otherwise have to read as an alias — every
    // scoped name, and any name that is its own YAML syntax.
    const key = (raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))
      ? raw.slice(1, -1)
      : raw
    const name = packageNameFromKey(key)
    if (name !== undefined) names.add(name)
  }
  return names
}

/**
 * The names a profile's lockfile accounts for; empty when it has none.
 *
 * Absent is the normal state of a profile the market has not installed into, and
 * an unreadable one is not this shell's to fail on — both account for nothing,
 * i.e. the fence-free behaviour (see {@link lockfileOwnedNames}).
 */
async function accountedNames(profileDir: string): Promise<Set<string>> {
  try {
    return lockfileOwnedNames(await fs.readFile(path.join(profileDir, PROFILE_LOCKFILE), 'utf8'))
  } catch {
    return new Set<string>()
  }
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
 * the runtime's copy wins — unless the profile's own lockfile records it, which
 * means the market installed it there and its copy is the one that stays (see
 * {@link lockfileOwnedNames}).
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
    const owned = await ownedPaths(source)
    if (owned.length === 0) {
      return { status: 'failed', entries: 0, files: 0, kept: [], detail: `${source} carries no packages` }
    }
    // A name the profile's own lockfile accounts for is the market's
    // installation: its copy is the one that stays, and it is not pruned below
    // either. See lockfileOwnedNames for the case that measured this.
    const accounted = await accountedNames(profileDir)
    const mirrorable = owned.filter((name) => !accounted.has(name))
    const runtime = await fs.realpath(runtimeDir)
    const marker = await readKernelMarker(markerPath)
    if (marker !== undefined && marker.runtime === runtime) {
      const absent = await Promise.all(
        mirrorable.map(async (name) => (await statOrUndefined(ownedTarget(target, name))) === undefined),
      )
      if (!absent.some(Boolean)) return { status: 'already', entries: mirrorable.length, files: marker.files, kept: [] }
    }
    await fs.mkdir(target, { recursive: true })
    let files = 0
    for (const name of mirrorable) {
      await ensureOwnedParent(target, name)
      files += await mirrorTree(ownedTarget(source, name), ownedTarget(target, name))
    }
    // Entries an earlier mirror owned and this runtime no longer carries: the
    // kernel dropped them, and a stale copy would keep resolving. A name that
    // is only in the marker goes through the same narrowing as a drop, so what
    // the market installed inside a scope is never the price of a stale entry —
    // and through the same witness check, so a marker this tree cannot back up
    // is not acted on either ({@link mirrorWitnessGap}).
    const current = new Set(mirrorable)
    const mirroredFrom = marker === undefined ? undefined : path.join(marker.runtime, 'node_modules')
    const kept: KeptEntry[] = []
    for (const name of marker?.names ?? []) {
      if (current.has(name) || accounted.has(name)) continue
      const reason = await mirrorWitnessGap(name, mirroredFrom)
      if (reason !== undefined) {
        kept.push({ name, reason })
        continue
      }
      for (const removal of await ownedRemovals(name, [mirroredFrom, source])) {
        if (current.has(removal) || accounted.has(removal)) continue
        await removeOwnedEntry(target, removal)
      }
    }
    await fs.writeFile(markerPath, `${JSON.stringify({
      runtime,
      names: mirrorable,
      files,
      at: new Date().toISOString(),
    }, undefined, 2)}\n`, 'utf8')
    return { status: 'mirrored', entries: mirrorable.length, files, kept }
  } catch (error) {
    return { status: 'failed', entries: 0, files: 0, kept: [], detail: (error as Error).message }
  }
}

/**
 * Drop a mirror this shell made, for a host line that no longer needs one.
 *
 * A host that anchors on the runtime tree resolves every kernel package there,
 * so a mirror left in the profile is not read for kernel code — but the suite
 * plugins live in that same tree, and a stale copy would be the one the loader
 * finds. Removing exactly the paths the marker proves this shell created keeps
 * a kernel-line change from booting the previous line's plugin code, and stops
 * at the package so the market's own installs survive it — including a name the
 * marker claims but the profile's own lockfile records, which by then is the
 * market's copy of a package the runtime also carries ({@link lockfileOwnedNames}).
 *
 * What the marker claims is checked against the tree it was taken from
 * ({@link mirrorWitnessGap}) before anything leaves: a name that tree does not
 * carry was never written by the mirror this marker describes, and a name whose
 * tree is gone has nothing left to prove it at all. Each such name is reported
 * in {@link KernelTreeOutcome.kept} instead.
 *
 * @param profileDir - the profile to clean.
 * @param runtimeDir - the runtime tree running now; consulted with the recorded
 *   one so a scope-directory name from an older marker can be narrowed (see
 *   {@link ownedRemovals}).
 * @returns `removed` when a mirror was there and is gone, `already` otherwise.
 */
export async function dropRuntimeMirror(profileDir: string, runtimeDir?: string): Promise<KernelTreeOutcome> {
  const markerPath = path.join(profileDir, PROFILE_KERNEL_MARKER)
  const target = path.join(profileDir, 'node_modules')
  try {
    const marker = await readKernelMarker(markerPath)
    if (marker === undefined) return { status: 'already', entries: 0, files: 0, kept: [] }
    // Same fence as the mirror: a name the profile's own lockfile accounts for
    // is the market's install, and a marker that claims it was written before
    // that install replaced it (see lockfileOwnedNames).
    const accounted = await accountedNames(profileDir)
    const mirroredFrom = path.join(marker.runtime, 'node_modules')
    const fallback = runtimeDir === undefined ? undefined : path.join(runtimeDir, 'node_modules')
    let entries = 0
    const kept: KeptEntry[] = []
    for (const name of marker.names) {
      if (accounted.has(name)) continue
      // The suite's own scope is never the drop's to take back. It is the
      // directory the shell links on EVERY start (`linkSuitePlugins`), and on a
      // runtime-anchored line those links are what the enforcing resolver reads
      // out of the profile. A marker written while a profile-anchored line ran
      // records them (the runtime tree ships `@dsh-app/*`), so without this the
      // drop deletes the links the same start has just created: 17 entries stop
      // activating and the brand UI goes quietly vanilla.
      if (name === PLUGIN_SCOPE || name.startsWith(`${PLUGIN_SCOPE}/`)) continue
      const reason = await mirrorWitnessGap(name, mirroredFrom)
      if (reason !== undefined) {
        kept.push({ name, reason })
        continue
      }
      for (const removal of await ownedRemovals(name, [mirroredFrom, fallback])) {
        if (accounted.has(removal)) continue
        await removeOwnedEntry(target, removal)
        entries += 1
      }
    }
    await fs.rm(markerPath, { force: true })
    return { status: 'removed', entries, files: marker.files, kept }
  } catch (error) {
    return { status: 'failed', entries: 0, files: 0, kept: [], detail: (error as Error).message }
  }
}
