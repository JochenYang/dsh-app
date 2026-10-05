#!/usr/bin/env node
/**
 * Kernel surface report: what does the followed line export, and which of it do
 * we not use yet?
 *
 * This is the other half of `test/plugin-kernel-imports.test.mjs`. That test
 * answers the REMOVAL direction — "a name we import stopped existing" — and it
 * is the direction that breaks a release. This script answers the ADDITION
 * direction, which nothing else in the repository asks: a capability the new
 * line added, that our plugins could adopt but do not, is invisible to every
 * gate we have. A kernel-line move therefore reads as "nothing broke" while a
 * whole seam sits unused.
 *
 * What it is NOT:
 *
 *   - it is not a work list. An unused export is usually correctly unused: most
 *     of the surface belongs to the kernel's own composition, or to a deployment
 *     shape we do not ship (headless, ACP, SDK, SSH, provider backends). The
 *     report marks the packages we DO couple to and the ones we do not, and
 *     leaves the judgement to the reader — which is why it is a report and not a
 *     gate.
 *   - it is not a snapshot with a blessed baseline. There is no stored JSON to
 *     diff against, because the interesting question is not "what changed since I
 *     last ran it" (a diff of 861 names says nothing) but "of the surface that
 *     exists NOW, which parts are we not on".
 *
 * Usage:
 *   node scripts/kernel-surface.mjs [--repo <dir>] [--package <name>]
 *        [--used-only] [--unused-only] [--json]
 *
 * Exit: 0 report produced; 2 usage or input error. Never fails on findings —
 * see above.
 *
 * @module scripts/kernel-surface
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportsOf, installedKernelPackages, pluginDirs } from './lib/kernel-exports.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Source extensions that can carry an import from the kernel. */
const SOURCE_RE = /\.tsx?$/u

/** Directories never walked: build outputs and dependency trees. */
const SKIP_DIRS = new Set(['node_modules', 'lib', '.test-dist', 'dist', 'scratch'])

/** A named import from the kernel scope, capturing `type`-only-ness. */
const NAMED_IMPORT_RE = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"](@deepseek-ai\/[^'"]+)['"]/gu

/** A namespace or default import from the kernel scope. */
const OTHER_IMPORT_RE = /import\s+(type\s+)?(?:\*\s+as\s+\w+|\w+)\s+from\s+['"](@deepseek-ai\/[^'"]+)['"]/gu

/**
 * A specifier's package name: `@deepseek-ai/dsh-llm/types` → `dsh-llm`.
 *
 * A subpath is the SAME package: `dsh-llm/types` and `dsh-llm` are two entries
 * of one package, and both count as a coupling to `dsh-llm`. Counting them
 * separately would report a package as untouched while we import its `/client`.
 */
function packageOfSpecifier(specifier) {
  return specifier.slice('@deepseek-ai/'.length).split('/')[0]
}


/**
 * Every `@deepseek-ai/*` coupling this repository's sources establish, split by
 * the KIND of edge.
 *
 * The distinction is the point, not a nicety:
 *
 *   - RUNTIME — `import { x } from 'pkg'`: a real runtime dependency. A name that
 *     disappears here is what `test/plugin-kernel-imports.test.mjs` guards.
 *   - TYPE — `import type { T } from 'pkg'`: erased at build time. The line can
 *     drop the name and nothing fails until a later typecheck.
 *   - AUGMENT — `import type {} from 'pkg'`: 101 occurrences in this repository.
 *     It is the Cordis idiom for pulling a `declare module` augmentation into
 *     scope, so it NAMES nothing and establishes NO runtime edge, yet it is a
 *     hard coupling: if the package stops existing, the augmentation is silently
 *     lost and every `ctx.<service>` access in that file goes untyped. Counting
 *     it as "we use this package at runtime" would overstate the coupling in
 *     exactly the direction that matters when judging whether a line move is safe.
 */
function collectUsage(repoRoot) {
  const runtime = new Map()
  const typeOnly = new Map()
  const augment = new Map()
  const namedByPackage = new Map()

  const scanFile = (file) => {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return
    }

    for (const match of text.matchAll(NAMED_IMPORT_RE)) {
      const pkg = packageOfSpecifier(match[3])
      const names = match[2]
        .split(',')
        .map((raw) => raw.trim().split(/\s+as\s+/u)[0].trim())
        .filter((name) => name !== '' && !name.startsWith('type '))

      // Order matters: `import type {} from 'pkg'` satisfies BOTH tests — it
      // carries the `type` keyword and names nothing — and it is the augment
      // case, not the type-only one. Testing `type` first swallowed all 101 of
      // them into typeOnly and reported 0 augmentation couplings.
      if (names.length === 0) {
        augment.set(pkg, (augment.get(pkg) ?? 0) + 1)
        continue
      }
      if (match[1] !== undefined) {
        typeOnly.set(pkg, (typeOnly.get(pkg) ?? 0) + 1)
        continue
      }
      runtime.set(pkg, (runtime.get(pkg) ?? 0) + 1)
      const adopted = namedByPackage.get(pkg) ?? new Set()
      for (const name of names) adopted.add(name)
      namedByPackage.set(pkg, adopted)
    }

    for (const match of text.matchAll(OTHER_IMPORT_RE)) {
      const pkg = packageOfSpecifier(match[2])
      if (match[1] !== undefined) {
        typeOnly.set(pkg, (typeOnly.get(pkg) ?? 0) + 1)
        continue
      }
      // A namespace or default import names no member, but the package is a
      // runtime edge all the same.
      if (!runtime.has(pkg)) runtime.set(pkg, 1)
    }
  }

  const scanDir = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        scanDir(full)
        continue
      }
      if (SOURCE_RE.test(entry.name)) scanFile(full)
    }
  }

  for (const top of ['plugins', 'src', 'test', 'scripts']) {
    scanDir(path.join(repoRoot, top))
  }
  return { runtime, typeOnly, augment, namedByPackage }
}

function parseArgs(argv) {
  const args = { json: false, usedOnly: false, unusedOnly: false, package: null }
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--repo': args.repo = argv[++i]; break
      case '--package': args.package = argv[++i]; break
      case '--used-only': args.usedOnly = true; break
      case '--unused-only': args.unusedOnly = true; break
      case '--json': args.json = true; break
      default: throw new Error(`unknown argument: ${argv[i]}`)
    }
  }
  if (args.repo === undefined) args.repo = root
  if (args.package === '') throw new Error('--package needs a value')
  return args
}

/**
 * Packages to report: the root scope, plus any package that only a plugin
 * carries.
 *
 * Without the second half the report lists a package as coupled and then says
 * nothing about it — `@deepseek-ai/dsh-client-ui-primitives` and
 * `@deepseek-ai/dsh-web` are imported by 14 plugins and exist only inside those
 * plugins' own `node_modules` (plugins install locally, `plugins/AGENTS.md` §2).
 */
function collectPackages(repoRoot, scopeDir) {
  const packages = installedKernelPackages(scopeDir)
  const known = new Set(packages.map((entry) => entry.name))
  for (const pluginDir of pluginDirs(repoRoot)) {
    for (const entry of installedKernelPackages(path.join(pluginDir, 'node_modules', '@deepseek-ai'))) {
      if (known.has(entry.name)) continue
      known.add(entry.name)
      packages.push(entry)
    }
  }
  packages.sort((a, b) => a.name.localeCompare(b.name))
  return packages
}

/** Rank by the STRONGEST edge; within a rank, alphabetical. */
const rankOf = (row) => (row.edges.runtime ? 0 : row.edges.type ? 1 : row.edges.augment ? 2 : 3)

const MARK = { 0: 'RUN ', 1: 'TYPE', 2: 'AUG ', 3: '    ' }

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error('usage: node scripts/kernel-surface.mjs [--repo <dir>] [--package <name>] [--used-only|--unused-only] [--json]')
    console.error(`[kernel-surface] ${error.message}`)
    process.exitCode = 2
    return
  }

  const repoRoot = path.resolve(args.repo)
  const scopeDir = path.join(repoRoot, 'node_modules', '@deepseek-ai')
  if (!existsSync(scopeDir)) {
    console.error(`[kernel-surface] ${scopeDir} does not exist — install the followed line first`)
    process.exitCode = 2
    return
  }

  const { runtime, typeOnly, augment, namedByPackage } = collectUsage(repoRoot)
  const packages = collectPackages(repoRoot, scopeDir)

  const rows = []
  for (const { name, dir } of packages) {
    if (args.package !== null && name !== args.package) continue
    const edges = { runtime: runtime.has(name), type: typeOnly.has(name), augment: augment.has(name) }
    const exports = exportsOf(dir)
    if (exports === null) {
      rows.push({ name, edges, exports: null, adopted: [], unused: [] })
      continue
    }
    const adopted = namedByPackage.get(name) ?? new Set()
    rows.push({
      name,
      edges,
      exports: [...exports],
      adopted: [...exports].filter((entry) => adopted.has(entry)),
      unused: [...exports].filter((entry) => !adopted.has(entry)),
    })
  }
  rows.sort((a, b) => rankOf(a) - rankOf(b) || a.name.localeCompare(b.name))

  const visible = rows.filter((row) => {
    if (args.usedOnly) return rankOf(row) < 3
    if (args.unusedOnly) return rankOf(row) === 3
    return true
  })

  const counts = {
    runtime: rows.filter((row) => row.edges.runtime).length,
    typeOnly: rows.filter((row) => !row.edges.runtime && row.edges.type).length,
    augmentOnly: rows.filter((row) => !row.edges.runtime && !row.edges.type && row.edges.augment).length,
    exports: rows.reduce((sum, row) => sum + (row.exports?.length ?? 0), 0),
    adopted: rows.reduce((sum, row) => sum + row.adopted.length, 0),
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      scannedPackages: packages.length,
      ...counts,
      packages: visible.map((row) => ({
        name: row.name,
        edges: row.edges,
        exportCount: row.exports?.length ?? null,
        adopted: row.adopted,
        unused: row.unused,
      })),
    }, null, 2)}\n`)
    return
  }

  console.log(`kernel surface — ${packages.length} installed @deepseek-ai packages, ${counts.exports} exported names`)
  console.log(`couplings: ${counts.runtime} runtime, ${counts.typeOnly} type-only, ${counts.augmentOnly} augmentation-only; ${counts.adopted} names imported by name`)
  console.log('')
  console.log('(an unused name is usually correctly unused — the kernel ships shapes we do not deploy;')
  console.log(' this is a list to read at a line move, not a work list)')
  console.log('')

  for (const row of visible) {
    const mark = MARK[rankOf(row)]
    if (row.exports === null) {
      console.log(`${mark} ${row.name} — no readable entry, surface unknown`)
      continue
    }
    console.log(`${mark} ${row.name} — ${row.exports.length} exports, ${row.adopted.length} imported by name`)
    const clip = (list) => `${list.slice(0, 12).join(', ')}${list.length > 12 ? ` … +${list.length - 12}` : ''}`
    if (rankOf(row) < 3 && row.adopted.length > 0) console.log(`      used:   ${clip(row.adopted)}`)
    if (rankOf(row) < 3 && row.unused.length > 0) console.log(`      unused: ${clip(row.unused)}`)
  }
}

main()
