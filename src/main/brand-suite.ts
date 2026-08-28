/**
 * Brand suite wiring between the desktop shell and the dsh child process.
 *
 * The suite plugins (@dsh-app/plugin-brand, @dsh-app/plugin-client-ui,
 * @dsh-app/plugin-sidebar, @dsh-app/plugin-swarm, @dsh-app/plugin-usage,
 * @dsh-app/plugin-archives) ship with the product, not with the upstream dsh
 * kernel, so two seams have to be stitched at every server start:
 *
 *   1. Module resolution — the composed loader resolves entry names through
 *      the ordinary Node parent-walk from the profile directory;
 *      $DSH_HOME/profiles/node_modules is the flat fallback directory the
 *      harness maintains so in-box plugins resolve from any profile. The
 *      suite plugins are NOT in the kernel's heal-link closure (they are
 *      product additions), so the shell adds one link per plugin there,
 *      pointing at the real install:
 *        dev  — this repo's plugins/* directories,
 *        prod — the active kernel's app/node_modules (build-runtime.mjs
 *               npm-installs them through file: references).
 *      Links are idempotent; the harness heal step never removes names it
 *      does not manage, so these survive every boot.
 *
 *   2. Composition — the loader overlay (plugins/dsh-app.patch.yml, copied
 *      next to the main bundle by copy-static.mjs) disables the upstream
 *      Models settings page and inserts the two brand rows. The shell writes
 *      a copy into userData and passes it via `dsh web --patch`, so the
 *      brand rows join the tree without touching the user's profile files.
 *      (--patch overlays apply after the profile's own layer: last write
 *      wins per row.)
 *
 * Both seams degrade gracefully: an older kernel without the suite plugins
 * (a rollback target) boots vanilla — no links, no overlay.
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Suite plugin directory names under dsh-app/plugins (and kernel node_modules). */
export const SUITE_PLUGIN_DIRS = ['plugin-brand', 'plugin-client-ui', 'plugin-sidebar', 'plugin-swarm', 'plugin-usage', 'plugin-archives', 'plugin-memory'] as const

/** npm scope shared by the suite plugins. */
const PLUGIN_SCOPE = '@dsh-app'

/** Mirror the harness's resolveDshHome: $DSH_HOME wins, else ~/.dsh. */
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

/**
 * Ensure $DSH_HOME/profiles/node_modules/@dsh-app/<dirName> resolves to each
 * suite plugin's real directory. Junction on Windows (no elevation needed),
 * symlink elsewhere.
 * @param sources - suite plugin sources for the active kernel.
 * @returns true when every plugin linked (false → boot without the overlay).
 */
export async function linkSuitePlugins(sources: readonly SuitePluginSource[]): Promise<boolean> {
  const scopeDir = path.join(resolveDshHome(), 'profiles', 'node_modules', PLUGIN_SCOPE)
  for (const source of sources) {
    try {
      // A missing source means a kernel predating the suite: boot vanilla.
      await fs.access(path.join(source.dir, 'package.json'))
    } catch {
      return false
    }
  }
  await fs.mkdir(scopeDir, { recursive: true })
  for (const source of sources) {
    const target = await fs.realpath(source.dir)
    const linkPath = path.join(scopeDir, source.dirName)
    try {
      const stat = await fs.lstat(linkPath)
      if (stat.isSymbolicLink()) {
        if ((await fs.readlink(linkPath)) === target) continue
        await fs.unlink(linkPath)
      } else {
        // A real directory in the way (stale copy): replace it.
        await fs.rm(linkPath, { recursive: true, force: true })
      }
    } catch {
      /* absent → create below */
    }
    await fs.symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  }
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
 * Wire both seams before a server start.
 * @param sources - suite plugin sources for the kernel about to boot.
 * @returns the `--patch` paths to hand the server ([] → vanilla boot).
 */
export async function prepareBrandSuite(sources: readonly SuitePluginSource[]): Promise<string[]> {
  try {
    if (!(await linkSuitePlugins(sources))) return []
    return [await writeBrandOverlay(app.getPath('userData'))]
  } catch (err) {
    // Never block the boot over brand wiring: log and go vanilla.
    console.error('[brand-suite] wiring failed; booting vanilla:', err)
    return []
  }
}
