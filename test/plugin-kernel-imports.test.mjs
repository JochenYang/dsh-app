// Every `@deepseek-ai/*` name the suite imports at runtime must exist in the
// followed kernel line.
//
// Why this is a test and not a habit: the plugin graph gate checks peers and
// versions, the type gate checks shapes, and neither sees a name that the line
// simply STOPPED EXPORTING — `import { IconRefreshOutline14 } from '…/primitives'`
// type-checks as `any`-ish through a slice and only fails at render time, as
// React "Element type is invalid … but got: undefined". Measured on this machine:
// the user's third-party `dshmarket@1.48.0` imports 17 icons that the 0.1.6 line
// exports (3-4 occurrences each in its `dsh-client-ui-primitives`) and the 0.1.7
// line does not (0 occurrences), so its whole settings page collapses into an
// error card. Our own seventeen plugins import 68 such names and all 68 survive,
// which is exactly the kind of statement that should be re-checked by a machine
// after every kernel-line bump rather than remembered.
//
// It resolves against the repository's own `node_modules` (the followed line, and
// what CI installs), so it needs no kernel tree and no network. A package that is
// not installed is reported and skipped — the question is unanswerable there, and
// failing would block unrelated work.
//
// @module dsh-app/tests/plugin-kernel-imports
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { exportsOf } from '../scripts/lib/kernel-exports.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Every `.ts`/`.tsx` file under a directory. */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/u.test(name)) out.push(full)
  }
  return out
}

/**
 * Named runtime imports from `@deepseek-ai/*` in one source file.
 *
 * A whole `import type { … }` is skipped, and so is a `type X` entry inside a
 * mixed import: neither exists at runtime, so asking whether the line exports it
 * would fail on a name that was never supposed to be there.
 */
function kernelImports(source) {
  const found = []
  // Both quote styles on purpose. A single-quote-only pattern silently skipped
  // every double-quoted bundle: measured on the user's installed third-party
  // plugins, it reported "checked: 0" for `dsh-remote` and `dsh-vision-bridge`,
  // whose `lib/index.js` does import from `@deepseek-ai/*`.
  for (const match of source.matchAll(/import\s+(type\s+)?\{([^}]+)\}\s+from\s+['"](@deepseek-ai\/[^'"]+)['"]/gu)) {
    if (match[1] !== undefined) continue
    for (const raw of match[2].split(',')) {
      const entry = raw.trim()
      if (entry === '' || entry.startsWith('type ')) continue
      // `{ A as B }` binds B but requires A to exist.
      const name = entry.split(/\s+as\s+/u)[0].trim()
      if (name !== '') found.push({ name, pkg: match[3] })
    }
  }
  return found
}

test('every `@deepseek-ai/*` name the plugins import at runtime exists in the installed line', () => {
  const pluginsDir = join(ROOT, 'plugins')
  const plugins = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('plugin-'))
    .map((entry) => entry.name)
  assert.ok(plugins.length >= 16, `expected the whole suite, saw ${String(plugins.length)}`)

  // Package resolution, per importing plugin: a plugin's own `node_modules`
  // FIRST, then the root tree.
  //
  // Why not the root tree alone: plugins install locally (`plugins/AGENTS.md`
  // §2), so a package only the client halves use — `dsh-client-ui-primitives`
  // (13 plugins) and `dsh-web` (plugin-websearch) — lives in the plugin's own
  // `node_modules` and NOT at the root. A root-only lookup answers `null` for
  // them, and `null` means "not installed, not judged": 17 named runtime imports
  // went unjudged that way, silently, which is the one outcome this test exists
  // to prevent. Both were intact when this was fixed; the point is that nothing
  // would have said so.
  const cache = new Map()
  const uninstalled = new Set()
  const missing = []
  let checked = 0

  /** The directory a package resolves to for one plugin, or null. */
  const packageDirFor = (plugin, spec) => {
    const key = `${plugin}\u0000${spec}`
    if (cache.has(key)) return cache.get(key)
    const candidates = [join(pluginsDir, plugin, 'node_modules', spec), join(ROOT, 'node_modules', spec)]
    const found = candidates.find((candidate) => existsSync(candidate)) ?? null
    cache.set(key, found)
    return found
  }

  for (const plugin of plugins) {
    for (const file of walk(join(pluginsDir, plugin, 'src'))) {
      for (const found of kernelImports(readFileSync(file, 'utf8'))) {
        checked += 1
        const pkgDir = packageDirFor(plugin, found.pkg)
        if (pkgDir === null) { uninstalled.add(found.pkg); continue }
        const exports = exportsOf(pkgDir)
        if (exports === null) { uninstalled.add(found.pkg); continue }
        if (!exports.has(found.name)) missing.push(`${plugin}: ${found.name} from ${found.pkg}`)
      }
    }
  }

  assert.ok(checked > 0, 'the scan found no kernel imports at all, which cannot be right')
  if (uninstalled.size > 0) {
    console.log(`plugin-kernel-imports: not installed here, so not judged: ${[...uninstalled].join(', ')}`)
  }
  assert.deepEqual([...new Set(missing)], [],
    `these names are imported by the suite but the installed kernel line does not export them — a client half would render "Element type is invalid … got: undefined" instead of failing a type check: ${[...new Set(missing)].join(', ')}`)
})
