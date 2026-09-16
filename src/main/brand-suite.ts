/**
 * Brand suite wiring between the desktop shell and the dsh child process.
 *
 * The suite plugins (@dsh-app/plugin-brand, @dsh-app/plugin-client-ui,
 * @dsh-app/plugin-sidebar, @dsh-app/plugin-swarm, @dsh-app/plugin-usage,
 * @dsh-app/plugin-archives, @dsh-app/plugin-memory, @dsh-app/plugin-fff,
 * @dsh-app/plugin-mcp, @dsh-app/plugin-hooks) ship with the product, not
 * with the upstream dsh
 * kernel, so two seams have to be stitched at every server start:
 *
 *   1. Module resolution — the composed loader resolves entry names through
 *      the ordinary Node parent-walk from the profile directory. The suite
 *      plugins are NOT in the kernel's heal-link closure (they are product
 *      additions), so the shell adds one link per plugin inside the suite's
 *      OWN profile:
 *        $DSH_HOME/profiles/<SUITE_PROFILE>/node_modules/@dsh-app/<dir>
 *        dev  — this repo's plugins/* directories,
 *        prod — the active kernel's app/node_modules (build-runtime.mjs
 *               npm-installs them through file: references).
 *      Links are idempotent; the harness heal step never removes names it
 *      does not manage, so these survive every boot.
 *
 *      Why a private profile instead of the shared
 *      `profiles/node_modules` fallback: 0.1.6 introduced generation-based
 *      resolution, and in its runtime mode (packaged / pkg / asar) that
 *      resolver skips the flat fallback directory wholesale — a kernel built
 *      that way would silently drop all seventeen rows. A profile's own
 *      node_modules is a local candidate in every mode, and it keeps the suite
 *      out of the resolution root a user's own `dsh` / `dsh web` runs use
 *      (those keep profile `web`).
 *
 *   2. Composition — the loader overlay (plugins/dsh-app.patch.yml, copied
 *      next to the main bundle by copy-static.mjs) inserts the suite plugin
 *      rows. The shell writes
 *      a copy into userData and passes it via `--patch`, so the
 *      suite rows join the tree without touching the user's profile files.
 *      (--patch overlays apply after the profile's own layer: last write
 *      wins per row. Deliberately NOT the profile's own cordis.patch.yml:
 *      that layer sits BELOW the home one, where a user's
 *      $DSH_HOME/cordis.patch.yml could override the brand rows.)
 *
 * Both seams degrade gracefully: an older kernel without the suite plugins
 * (a rollback target) boots vanilla — no links, no overlay.
 *
 * Ownership fence: the scope dir ($DSH_HOME/profiles/<SUITE_PROFILE>/node_modules/@dsh-app)
 * could still hold a real @dsh-app package a user installed there themselves.
 * The shell therefore only ever replaces links it can prove it created (a
 * journal inside the scope dir records every link this shell owns), and a
 * directory or file it did not create is left untouched with a logged
 * warning while the remaining plugins still link. Links a pre-0.1.6 shell left
 * in the shared `profiles/node_modules` are retired on boot
 * ({@link removeLegacySuiteLinks}) so the user's own runs stop seeing them.
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SUITE_PROFILE, SUITE_PROFILE_BUNDLES } from '../shared/constants'

/** Suite plugin directory names under dsh-app/plugins (and kernel node_modules). */
export const SUITE_PLUGIN_DIRS = ['plugin-brand', 'plugin-client-ui', 'plugin-sidebar', 'plugin-swarm', 'plugin-usage', 'plugin-archives', 'plugin-memory', 'plugin-fff', 'plugin-mcp', 'plugin-hooks', 'plugin-ppt', 'plugin-market', 'plugin-presets', 'plugin-doc', 'plugin-sheet', 'plugin-pdf', 'plugin-websearch'] as const

/** npm scope shared by the suite plugins. */
const PLUGIN_SCOPE = '@dsh-app'

/** Journal file inside the scope dir naming every link this shell owns. */
const OWNERSHIP_JOURNAL = '.dsh-app-links.json'

/**
 * Mirror the harness's resolveDshHome: $DSH_HOME wins, else ~/.dsh.
 */
export function resolveDshHome(): string {
  const raw = (process.env.DSH_HOME ?? '').trim()
  if (raw !== '') {
    return path.resolve(raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw)
  }
  return path.join(os.homedir(), '.dsh')
}

/** One suite plugin's resolvable source directory. */
export interface SuitePluginSource {
  /** Directory name under plugins/ (e.g. 'plugin-brand'). */
  dirName: string
  /** Absolute directory holding the built package (lib/ included). */
  dir: string
}

/** Dev sources: the dsh-app repo's plugins/ (built in place). */
export function devSuiteSources(): SuitePluginSource[] {
  const appRoot = app.getAppPath()
  return SUITE_PLUGIN_DIRS.map((dirName) => ({ dirName, dir: path.join(appRoot, 'plugins', dirName) }))
}

/** Prod sources: the active kernel's npm-flattened app/node_modules. */
export function prodSuiteSources(kernelDir: string): SuitePluginSource[] {
  return SUITE_PLUGIN_DIRS.map((dirName) => ({
    dirName,
    dir: path.join(kernelDir, 'app', 'node_modules', PLUGIN_SCOPE, dirName),
  }))
}

/** Read the ownership journal. Returns the owned set plus whether the journal
 * file existed at all (a corrupt journal counts as existing: nothing is proven
 * owned, but the historical-unowned-symlink exception must NOT apply either). */
async function readOwnedLinks(scopeDir: string): Promise<{ owned: Set<string>; journalExists: boolean }> {
  const journalPath = path.join(scopeDir, OWNERSHIP_JOURNAL)
  try {
    const raw = await fs.readFile(journalPath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return {
      owned: new Set(parsed.filter((entry): entry is string => typeof entry === 'string')),
      journalExists: true,
    }
    // File exists but is not a JSON array: treat as corrupt → nothing owned,
    // and do not extend the historical exception.
    return { owned: new Set(), journalExists: true }
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    return { owned: new Set(), journalExists: !missing }
  }
}

/** Persist the ownership journal (names the shell created or still owns). */
async function writeOwnedLinks(scopeDir: string, owned: ReadonlySet<string>): Promise<void> {
  await fs.writeFile(
    path.join(scopeDir, OWNERSHIP_JOURNAL),
    `${JSON.stringify([...owned], null, 2)}\n`,
    'utf8',
  )
}

/**
 * Ensure $DSH_HOME/profiles/<SUITE_PROFILE>/node_modules/@dsh-app/<dirName>
 * resolves to each suite plugin's real directory. Junction on Windows (no
 * elevation needed), symlink elsewhere.
 *
 * Ownership fence: a link is replaced only when the journal proves this shell
 * created it; a name the journal does not own (a real package dir, a foreign
 * symlink) is left in place and skipped with a warning — never deleted, never
 * overwritten. A non-link entry of ours from a pre-journal shell run is still
 * replaceable when the journal is absent AND the entry is a symlink pointing
 * at a suite source (the historical shape); anything else is foreign.
 *
 * @param sources - suite plugin sources for the active kernel.
 * @returns true when every plugin linked (false → boot without the overlay).
 */
export async function linkSuitePlugins(sources: readonly SuitePluginSource[]): Promise<boolean> {
  const scopeDir = path.join(resolveDshHome(), 'profiles', SUITE_PROFILE, 'node_modules', PLUGIN_SCOPE)
  for (const source of sources) {
    try {
      // A missing source means a kernel predating the suite: boot vanilla.
      await fs.access(path.join(source.dir, 'package.json'))
    } catch {
      return false
    }
  }
  await fs.mkdir(scopeDir, { recursive: true })

  let { owned, journalExists: hadJournal } = await readOwnedLinks(scopeDir)
  // Suite source realpaths, the only targets this shell ever links to.
  const suiteTargets = new Set<string>()
  for (const source of sources) suiteTargets.add(await fs.realpath(source.dir))
  for (const source of sources) {
    const target = await fs.realpath(source.dir)
    const linkPath = path.join(scopeDir, source.dirName)
    const ours = owned.has(source.dirName)
    try {
      const stat = await fs.lstat(linkPath)
      // Correct target already: mark ownership and move on. readlink may
      // return a relative or 8.3-short form (Windows junction); compare via
      // realpath on both sides so forms cannot fight.
      if (stat.isSymbolicLink()) {
        let existing: string | undefined
        try { existing = await fs.realpath(linkPath) } catch { existing = undefined }
        if (existing === target) {
          owned.add(source.dirName)
          continue
        }
      }
      // Not ours to touch: a real dir/file or a foreign symlink.
      // Historical exception: a pre-journal run left a symlink to a suite
      // source; without a journal that is the only shape we still own.
      // realpath may throw on a dangling link — that link is not ours to
      // replace either, so a false (not owned) answer is the safe outcome.
      let linkTarget: string | undefined
      try {
        linkTarget = await fs.realpath(linkPath)
      } catch {
        linkTarget = undefined
      }
      const isOwnedByUs = ours
        || (!hadJournal && stat.isSymbolicLink() && linkTarget !== undefined && suiteTargets.has(linkTarget))
      if (!isOwnedByUs) {
        console.warn(`[brand-suite] @dsh-app/${source.dirName} at ${linkPath} is not a link managed by this shell; leaving it in place and skipping.`)
        continue
      }
      // Ours to replace.
      if (stat.isSymbolicLink()) {
        await fs.unlink(linkPath)
      } else {
        await fs.rm(linkPath, { recursive: true, force: true })
      }
    } catch {
      /* absent → create below */
    }
    await fs.symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    owned.add(source.dirName)
  }
  await writeOwnedLinks(scopeDir, owned)
  return true
}

/**
 * Materialize the loader overlay in userData and return its path. The source
 * of truth is plugins/dsh-app.patch.yml, copied next to this bundle by
 * scripts/copy-static.mjs; rewriting the userData copy every start keeps the
 * two in lockstep without stale-file failure modes.
 * @param userDataDir - electron userData directory.
 * @returns absolute path of the overlay to pass via `--patch`.
 */
export async function writeBrandOverlay(userDataDir: string): Promise<string> {
  const source = path.join(__dirname, 'dsh-app.patch.yml')
  const content = await fs.readFile(source, 'utf8')
  const dest = path.join(userDataDir, 'dsh-app-suite.patch.yml')
  await fs.mkdir(userDataDir, { recursive: true })
  await fs.writeFile(dest, content, 'utf8')
  return dest
}

/**
 * Materialize the suite profile before anything is linked into it.
 *
 * Upstream boots a profile only when `<profile>/package.json` exists — a bare
 * directory is not a profile and the boot dies with `profile "dsh-app" does
 * not exist`. Its own initializer (`--from-default-profile`) cannot be used:
 * it refuses a profile directory that already exists, and by the time the
 * kernel starts ours already holds the plugin links. So the three files
 * upstream's `initProfile` would write are written here instead, in the same
 * shapes, and only when absent — never touching a profile that is already
 * initialized (a user's own pnpm-installed plugins live in the same dir).
 */
export async function ensureSuiteProfile(): Promise<void> {
  const dir = path.join(resolveDshHome(), 'profiles', SUITE_PROFILE)
  await fs.mkdir(dir, { recursive: true })
  const writeIfMissing = async (name: string, content: string): Promise<void> => {
    const file = path.join(dir, name)
    try {
      await fs.access(file)
      return
    } catch {
      /* absent → write */
    }
    await fs.writeFile(file, content, 'utf8')
  }
  await writeIfMissing('package.json', `${JSON.stringify({
    name: `dsh-profile-${SUITE_PROFILE}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...SUITE_PROFILE_BUNDLES], patchReload: 'live' } },
  }, undefined, 2)}\n`)
  // The profile's own patch layer. Empty on purpose: the suite rows arrive via
  // `--patch`, which outranks the home layer this file sits below.
  await writeIfMissing('cordis.patch.yml', '# Your patch layer for this dsh profile, applied after every bundle layer.\n[]\n')
  // pnpm settings for out-of-tree plugins (upstream's own profile template):
  // relevant only if the user installs packages into this profile.
  await writeIfMissing('pnpm-workspace.yaml', 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
}

/**
 * Retire the suite links a pre-0.1.6 shell left in the shared
 * `profiles/node_modules` fallback.
 *
 * That directory belongs to the harness (every profile falls back to it) and
 * 0.1.6's runtime-mode resolver skips it wholesale, so links left there are
 * both visible to processes that never asked for them and useless once the
 * kernel is packaged. Only entries this shell can prove it created are
 * removed — journal-proven names, plus (before the journal existed) symlinks
 * pointing at a suite source; anything else stays put, and the shared parent
 * directory is never touched.
 *
 * Best-effort by contract: the caller treats a failure as "nothing to clean".
 *
 * @param sources - suite plugin sources for the kernel about to boot.
 */
export async function removeLegacySuiteLinks(sources: readonly SuitePluginSource[]): Promise<void> {
  const scope = path.join(resolveDshHome(), 'profiles', 'node_modules', PLUGIN_SCOPE)
  const { owned, journalExists } = await readOwnedLinks(scope)
  const suiteTargets = new Set<string>()
  for (const source of sources) {
    try {
      suiteTargets.add(await fs.realpath(source.dir))
    } catch {
      /* a missing source can only disqualify its own name */
    }
  }
  let entries: string[]
  try {
    entries = await fs.readdir(scope)
  } catch {
    return
  }
  for (const name of entries) {
    if (name === OWNERSHIP_JOURNAL) continue
    const linkPath = path.join(scope, name)
    try {
      const stat = await fs.lstat(linkPath)
      if (owned.has(name)) {
        if (stat.isSymbolicLink()) await fs.unlink(linkPath)
        else await fs.rm(linkPath, { recursive: true, force: true })
        continue
      }
      // Never journaled: the only shape this shell ever created there is a
      // symlink to a suite source, so that — and nothing else — is removable.
      if (!journalExists && stat.isSymbolicLink()) {
        let target: string | undefined
        try {
          target = await fs.realpath(linkPath)
        } catch {
          target = undefined
        }
        if (target !== undefined && suiteTargets.has(target)) await fs.unlink(linkPath)
      }
    } catch {
      /* raced away or unreadable: leave it */
    }
  }
  await fs.rm(path.join(scope, OWNERSHIP_JOURNAL), { force: true }).catch(() => undefined)
  // Drop the scope dir only when nothing is left in it; `profiles/node_modules`
  // itself is the harness's and is never removed.
  await fs.rmdir(scope).catch(() => undefined)
}

/**
 * Wire both seams before a server start.
 * @param sources - suite plugin sources for the kernel about to boot.
 * @returns the `--patch` paths to hand the server ([] → vanilla boot).
 */
export async function prepareBrandSuite(sources: readonly SuitePluginSource[]): Promise<string[]> {
  try {
    // Profile first: the loader refuses to boot without its manifest, and the
    // linking below is what makes the directory non-empty.
    await ensureSuiteProfile()
    // Retiring the old shared fallback links is housekeeping, never a gate: a
    // failure here must not cost the suite its overlay.
    await removeLegacySuiteLinks(sources).catch((err: unknown) => {
      console.warn('[brand-suite] legacy link cleanup skipped:', err)
    })
    if (!(await linkSuitePlugins(sources))) return []
    return [await writeBrandOverlay(app.getPath('userData'))]
  } catch (err) {
    // Never block the boot over brand wiring: log and go vanilla.
    console.error('[brand-suite] wiring failed; booting vanilla:', err)
    return []
  }
}
