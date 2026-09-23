// Cross-platform dev launcher (npm run dev).
//
// Sets DSH_APP_DEV=1 and starts Electron. Which KERNEL that run boots, in order:
//
//   1. `DSH_APP_DEV_KERNEL=<dir>`  → that runtime tree (`node/` + `app/`), booted
//      in place, leaving the installed kernel untouched.
//   2. `DSH_APP_DEV_RUNTIME=<dir>` → a deepseek-harness SOURCE checkout, when the
//      work really is against live sources. It must be built: the shell runs its
//      apps/desktop-host and apps/cli out of that tree.
//   3. a runtime tree BUILT IN THIS REPO that declares the followed line —
//      `scratch/<name>/runtime` whose `manifest.json` names a `dshVersion` the
//      followed spec accepts. The suite is adapted per kernel line, so a tree of
//      another line is not a dev run of this repository — and the manifest is what
//      makes the choice informed rather than accidental. Measured: with the
//      installed 0.1.6 kernel and this repository's 0.1.7-adapted suite, a dev run
//      died with `duplicate loader entry id: mcp-context7` before any window.
//   4. nothing → the installed runtime, exactly like a packaged start, with a
//      warning naming the line this repository follows.
//
// A checkout that was pulled but never built is deliberately NOT a candidate: the
// old launcher probed `../deepseek-harness` and silently booted whatever build was
// in it (measured on this tree: three builds behind HEAD, still carrying 0.1.6
// symbols). A runtime tree announces its own version, so this cannot happen here.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertFollowedVersion, followedSpec } from './kernel-line.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, '..')

process.env.DSH_APP_DEV = '1'

/**
 * The newest repo-local runtime tree that declares the followed kernel line.
 *
 * A candidate is a directory under `scratch/` that has `manifest.json`, `node/`
 * and `app/` — the shape `DSH_APP_DEV_KERNEL` expects — and a `dshVersion` the
 * followed spec accepts. Anything else (another line, a stub, a half-extracted
 * tree) is skipped rather than guessed at.
 *
 * @returns the tree's absolute path plus the version it declares, or undefined.
 */
function localRuntimeOfFollowedLine() {
  const spec = followedSpec()
  let entries
  try {
    entries = readdirSync(path.join(appRoot, 'scratch'), { withFileTypes: true })
  } catch {
    return undefined
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const tree = path.join(appRoot, 'scratch', entry.name, 'runtime')
    const manifestPath = path.join(tree, 'manifest.json')
    if (!existsSync(manifestPath) || !existsSync(path.join(tree, 'app')) || !existsSync(path.join(tree, 'node'))) continue
    let version
    try {
      version = JSON.parse(readFileSync(manifestPath, 'utf8')).dshVersion
    } catch {
      continue
    }
    if (typeof version !== 'string' || version === '') continue
    try {
      // The project's own definition of "follows the line", not a second one.
      assertFollowedVersion(version, spec)
    } catch {
      continue
    }
    found.push({ tree, version, mtime: statSync(manifestPath).mtimeMs })
  }
  // Newest first: a rebuilt tree of the same line should win over an older one.
  found.sort((a, b) => b.mtime - a.mtime)
  return found[0]
}

const named = [
  ['DSH_APP_DEV_RUNTIME', process.env.DSH_APP_DEV_RUNTIME],
  ['DSH_APP_DEV_KERNEL', process.env.DSH_APP_DEV_KERNEL],
].filter(([, value]) => (value ?? '').trim() !== '')

if (named.length > 0) {
  console.log(`[dev] DSH_APP_DEV=1, kernel: ${named.map(([name, value]) => `${name}=${value}`).join(', ')}`)
} else {
  const local = localRuntimeOfFollowedLine()
  if (local === undefined) {
    console.error(`[dev] WARNING: no runtime tree built here declares the followed line ${followedSpec()}.`)
    console.error('[dev] Falling back to the INSTALLED kernel, which may be another line — the suite is adapted')
    console.error('[dev] per line, and a mismatch fails in the plugin tree with a confusing error. Build a runtime,')
    console.error('[dev] or name one: DSH_APP_DEV_KERNEL=<dir with node/ and app/> npm run dev')
  } else {
    process.env.DSH_APP_DEV_KERNEL = local.tree
    console.log(`[dev] DSH_APP_DEV=1, kernel: ${path.relative(appRoot, local.tree).replace(/\\/gu, '/')} `
      + `(built here, declares dsh ${local.version}, follows ${followedSpec()})`)
  }
}

// npm start = tsc+copy-static build, then `electron .`. The child inherits
// stdio so boot/server logs stay visible; shell:true resolves the npm shim
// on Windows (npm.cmd) and the bare binary on POSIX alike. windowsHide keeps
// the shim's console from flashing a terminal onto the desktop.
const result = spawnSync('npm', ['start'], {
  cwd: appRoot,
  stdio: 'inherit',
  env: process.env,
  shell: true,
  windowsHide: true,
})
process.exit(result.status ?? 1)
