/**
 * The export surface of the installed kernel line, resolved from this
 * repository's own `node_modules`.
 *
 * Two checks read this surface, in opposite directions:
 *
 *   - `test/plugin-kernel-imports.test.mjs` asks whether a name we IMPORT still
 *     exists (the removal direction — a kernel-deleted export type-checks and is
 *     `undefined` at render);
 *   - `scripts/kernel-surface.mjs` asks what the line exports that we do NOT
 *     import yet (the addition direction — a surface we could adopt).
 *
 * Both must agree about what "the export surface of package X" means, so the
 * resolution lives here once. Two implementations of this rule would drift, and
 * the drift would show up as one check reporting a name the other cannot see.
 *
 * Scope and honesty: this reads a package's BUILT ENTRY as text and extracts the
 * names it exports. It is not a parser and does not follow re-exports through
 * `export * from`. Measured on the followed line, the entry files carry their
 * export lists inline, so the extraction is complete for the packages this
 * repository consumes — but a package that only re-exports would be read as
 * exporting nothing, and the caller sees an empty set rather than a wrong one.
 *
 * @module scripts/lib/kernel-exports
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/** The scope whose packages belong to the followed kernel line. */
export const KERNEL_SCOPE = '@deepseek-ai/'

/**
 * The built entry file a package's `exports`/`module`/`main` points at, or null.
 *
 * A package with no resolvable entry is not an error: it is a package whose
 * surface cannot be read, and every caller treats `null` as "cannot judge"
 * rather than "exports nothing".
 */
export function entryOf(pkgDir) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
  let entry = manifest.exports?.['.'] ?? manifest.module ?? manifest.main
  // A conditional export map: prefer the ESM build, then the default, then CJS.
  if (typeof entry === 'object' && entry !== null) entry = entry.import ?? entry.default ?? entry.require
  if (typeof entry !== 'string') return null
  const full = path.join(pkgDir, entry)
  return existsSync(full) ? full : null
}

/**
 * Exported names of a built entry: `export { … }` lists plus inline
 * declarations.
 *
 * @returns {Set<string> | null} null when the package has no readable entry.
 */
export function exportsOf(pkgDir) {
  const entry = entryOf(pkgDir)
  if (entry === null) return null
  let code
  try {
    code = readFileSync(entry, 'utf8')
  } catch {
    return null
  }
  const names = new Set()
  for (const match of code.matchAll(/export\s*\{([^}]+)\}/gu)) {
    for (const raw of match[1].split(',')) {
      // `{ A as B }` exports B; the caller compares against what it imports,
      // which is B.
      const exported = raw.trim().split(/\s+as\s+/u).pop().trim()
      if (exported !== '') names.add(exported)
    }
  }
  for (const match of code.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gu)) {
    names.add(match[1])
  }
  return names
}

/**
 * Where a specifier resolves for one importer, or null.
 *
 * Plugin-local FIRST, then the repository root: plugins install inside their own
 * directory (`plugins/AGENTS.md` §2), so a package only the client halves use —
 * `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-web` — exists in a
 * plugin's own `node_modules` and not at the root. A root-only lookup answers
 * null for those, and null means "not judged"; that is how 17 named runtime
 * imports sat unjudged until this helper existed.
 *
 * @param {string} repoRoot - repository root.
 * @param {string | undefined} pluginDir - `plugins/<name>` for a plugin-local
 *   first look, or undefined for a root-only resolution.
 * @param {string} spec - the package specifier, e.g. `@deepseek-ai/dsh-llm`.
 */
export function resolvePackageDir(repoRoot, pluginDir, spec) {
  const candidates = []
  if (pluginDir !== undefined) candidates.push(path.join(repoRoot, 'plugins', pluginDir, 'node_modules', spec))
  candidates.push(path.join(repoRoot, 'node_modules', spec))
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/**
 * Every installed `@deepseek-ai/*` package directory under a tree, sorted.
 *
 * Only the flat scope directory is enumerated: a nested `node_modules` inside a
 * dependency is that dependency's business, not a package of the followed line.
 *
 * @param {string} scopeDir - an absolute path to a `node_modules/@deepseek-ai`.
 * @returns {{ name: string, dir: string }[]}
 */
export function installedKernelPackages(scopeDir) {
  if (!existsSync(scopeDir)) return []
  return readdirSync(scopeDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, dir: path.join(scopeDir, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Every plugin directory under `plugins/`, alphabetically.
 *
 * Shared because three checks need the same list and a second copy drifts: the
 * suite roster's home is `scripts/kernel-line.mjs`, but that list is the
 * BOOTED set, while these checks sweep whatever is on disk — including a plugin
 * whose roster entry has not landed yet, which is exactly the case
 * `scripts/check-plugin-graph.mjs` rejects.
 *
 * A missing `plugins/` is not an error: a check also runs against a fixture tree
 * in its own test.
 *
 * @param {string} repoRoot - repository root.
 * @returns {string[]} absolute plugin directory paths.
 */
export function pluginDirs(repoRoot) {
  const pluginsRoot = path.join(repoRoot, 'plugins')
  if (!existsSync(pluginsRoot)) return []
  return readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(pluginsRoot, entry.name))
    .sort((a, b) => a.localeCompare(b))
}
