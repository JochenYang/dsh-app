#!/usr/bin/env node
/**
 * Kernel-line preflight: one command that says what a new upstream line will do
 * to this repository, BEFORE anyone adapts anything.
 *
 * Why this exists. Three line moves were paid for with the same shape of miss:
 * a change no gate could see until it was already adapted.
 *
 *   - 0.2.2-rc.1 renamed `register`'s return value. Every plugin build was green
 *     because 18 of 19 build with esbuild, which does not type check; the type
 *     gate found it hours later.
 *   - 0.2.2-rc.2 renamed the Office provider (`dsh-office-to-pdf` →
 *     `dsh-office-kit`) and cut `skill-office`'s SKILL_NAMES from seven to four.
 *     The shell's copy and the build's copy each refused at runtime, and the
 *     probe's third copy refused every artifact of the line.
 *   - The same release added a sibling `@deepseek-ai/dsh-error` PEER, which
 *     `--legacy-peer-deps` does not install: nine plugin suites failed at bundle
 *     time with "Could not resolve", never at type-check time.
 *
 * Each of those is a question about the TARGET line that the repository can ask
 * itself without adapting anything. This script asks all of them at once and
 * prints what to do.
 *
 * What it checks (each line's report names the check):
 *
 *   line         every consumed kernel package resolves at ONE version
 *   published    (npm targets) the target actually publishes every package we
 *                depend on — a rename shows up here as a missing name
 *   engines      the target's `engines.node` floor vs the Node in CI
 *   exports      every symbol we import is still exported by the target entry
 *   declarations (source/npm targets) a symbol we import changed its declaration
 *   slots        every client slot id we register still exists in the target
 *   overlay      every loader row this repo patches still exists upstream, and
 *                our insert ids do not collide with a row the line added
 *   skill-office the skill names `build-runtime.mjs` and the shell mirror vs the
 *                target package's own list
 *   services     a host service id we reach through ctx.<id> that the target
 *                renamed or removed (the host-side twin of a slot)
 *   payload      (npm targets) which packages changed at all, and how much
 *   deps         a transitive package the target now pins at a version this
 *                tree does not bundle (the zod 4.6.6 case)
 *   peers        a sibling package the target declares as a peer that our
 *                install (`--legacy-peer-deps`) will not put on disk
 *
 * It does NOT reimplement `check:surface` (the addition direction, "which new
 * exports could we adopt"); the report ends with the command to run once the
 * line is switched, because that question is only answerable on the installed
 * line.
 *
 * Usage:
 *   node scripts/kernel-preflight.mjs                    # the installed line
 *   node scripts/kernel-preflight.mjs --dir <dir>        # a checkout / worktree
 *   node scripts/kernel-preflight.mjs --npm <version>    # the published packages
 *   node scripts/kernel-preflight.mjs --baseline-dir <dir>   # re-audit a move:
 *   node scripts/kernel-preflight.mjs --baseline-npm <version># old line vs new
 *   node scripts/kernel-preflight.mjs --line-policy=exact  # a copy above the line is a blocker
 *   node scripts/kernel-preflight.mjs --json
 *
 * `--dir` is the mode that answers "upstream just tagged a release" — point it
 * at the tag or a worktree of it. `--npm` downloads the packages we depend on
 * into `scratch/kernel-preflight/<version>/` (gitignored), verifies each tarball
 * against the registry's `dist.integrity`, and reads the published declarations —
 * the authoritative shape of what users will install. `--baseline-dir` /
 * `--baseline-npm` replace the installed line as the other side of the
 * comparison, which is how a move that already happened gets re-audited in its
 * own direction (baseline = the old line, target = the new one).
 *
 * Exit: 0 no blocker, 1 at least one blocker, 2 usage or input error.
 *
 * @module scripts/kernel-preflight
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installedKernelPackages, pluginDirs } from './lib/kernel-exports.mjs'
import { removeTree } from './lib/remove-tree.mjs'
import { followedSpec } from './kernel-line.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// The only process this script spawns is `tar`, which is in PATH on Windows 10+
// (bsdtar), macOS and Linux. Downloads go through `fetch`, not `npm pack`: a
// .cmd shim needs a shell and a shell re-quotes every path this script builds.
const TAR = process.platform === 'win32' ? 'tar.exe' : 'tar'

// ---------------------------------------------------------------- findings

/** One report line. `severity` decides the exit code and the grouping. */
class Findings {
  constructor() {
    this.items = []
  }

  /** @param {'blocker'|'adapt'|'note'} severity @param {string} check @param {string} subject @param {string} detail @param {string} [action] */
  add(severity, check, subject, detail, action) {
    this.items.push({ severity, check, subject, detail, action })
    return this
  }

  blocker(check, subject, detail, action) { return this.add('blocker', check, subject, detail, action) }
  adapt(check, subject, detail, action) { return this.add('adapt', check, subject, detail, action) }
  note(check, subject, detail, action) { return this.add('note', check, subject, detail, action) }

  count(severity) { return this.items.filter((item) => item.severity === severity).length }
}

// ------------------------------------------------------------ our surfaces

/** Directives that make an import invisible to a text scan if not filtered. */
const IMPORT_RE = /import\s+(?:type\s+)?(?:([\w$]+)\s*,\s*)?\{([^}]*)\}\s*from\s*'(@deepseek-ai\/[^']+)'/gu

/**
 * Packages under the `@deepseek-ai/` scope that are NOT part of the followed
 * kernel line: the cordis fork the line runs on and the runtime helpers it
 * republishes. Their versions (4.x, 1.x) are their own, so folding them into the
 * "one line" check reports a mixed line that does not exist.
 */
const NON_LINE = new Set([
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-group',
  '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/schemastery',
])

/**
 * Every named import this repository makes from a kernel package.
 *
 * `import type` counts: the augmentation form (`import type {} from 'x'`) is what
 * carries a `declare module` merge, and losing it silently drops `ctx.<service>`.
 *
 * @param {string} repoRoot - repository root.
 * @returns {Map<string, Set<string>>} package → imported names.
 */
function ourImports(repoRoot) {
  const wanted = new Map()
  const roots = [path.join(repoRoot, 'src'), ...pluginDirs(repoRoot).map((dir) => path.join(dir, 'src'))]
  for (const start of roots) {
    for (const file of sourceFiles(start)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(IMPORT_RE)) {
        const names = match[2].split(',').map((part) => part.trim()).filter(Boolean)
        const set = wanted.get(match[3]) ?? new Set()
        for (const raw of names) {
          const name = raw.replace(/^type\s+/u, '').split(/\s+as\s+/u)[0].trim()
          if (name !== '') set.add(name)
        }
        wanted.set(match[3], set)
      }
    }
  }
  for (const spec of [...wanted.keys()]) if (NON_LINE.has(splitSpec(spec).pkg)) wanted.delete(spec)
  return wanted
}

/** Files under `dir` with a TypeScript extension, node_modules excluded. */
function sourceFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (/\.(ts|tsx|mts)$/u.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * Split an import specifier into its package and subpath.
 *
 * `@deepseek-ai/dsh-web` → no subpath; `@deepseek-ai/dsh-api-remotes/client` →
 * `client`. Subpaths matter: a name can live in `./types` or `./client` and not
 * be exported from the root entry, so judging a subpath import against the root
 * surface reports a live symbol as missing.
 *
 * @param {string} spec - the import specifier.
 * @returns {{ pkg: string, sub: string }} the package name and the subpath ('' for root).
 */
function splitSpec(spec) {
  const parts = spec.split('/')
  const pkg = parts.slice(0, 2).join('/')
  return { pkg, sub: parts.slice(2).join('/') }
}

/**
 * Every host service this repository reaches through `ctx.<id>`.
 *
 * The host-side twin of a slot registration: a service id the line renamed
 * (`officeToPdf` → `officeKit`) turns every call through it into
 * `undefined.<method>`, and the type gate only catches it if the plugin is one
 * of the two that build with `tsc`. Cordis's own members (`ctx.logger`,
 * `ctx.on`, `ctx.get`) come from a package this scan does not compare, so the
 * check asks a narrower question: a name the BASELINE line declared and the
 * target no longer does.
 *
 * @param {string} repoRoot - repository root.
 * @returns {Map<string, string>} service id → first file that uses it.
 */
function ourServiceUses(repoRoot) {
  const used = new Map()
  const roots = [path.join(repoRoot, 'src'), ...pluginDirs(repoRoot).map((dir) => path.join(dir, 'src'))]
  for (const start of roots) {
    for (const file of sourceFiles(start)) {
      const text = STRIP(readFileSync(file, 'utf8'))
      for (const match of text.matchAll(/\bctx\.([a-z][A-Za-z0-9]*)/gu)) {
        if (!used.has(match[1])) used.set(match[1], path.relative(repoRoot, file).split(path.sep).join('/'))
      }
      for (const match of text.matchAll(/\bctx\.get\(\s*'([\w-]+)'/gu)) {
        if (!used.has(match[1])) used.set(match[1], path.relative(repoRoot, file).split(path.sep).join('/'))
      }
    }
  }
  return used
}

/** Every `ctx.slots.<fn>('id'` registration/declaration id in this repo. */
function ourSlotIds(repoRoot) {
  const ids = new Map()
  const roots = [path.join(repoRoot, 'src'), ...pluginDirs(repoRoot).map((dir) => path.join(dir, 'src'))]
  for (const start of roots) {
    for (const file of sourceFiles(start)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/slots\.(?:inject|register|entries|renderSlot)\(\s*(?:name:\s*)?'([\w.-]+)'/gu)) {
        if (!ids.has(match[1])) ids.set(match[1], path.relative(repoRoot, file).split(path.sep).join('/'))
      }
    }
  }
  return ids
}

/** Rows this repo patches or disables in its generated overlay, by id. */
function ourOverlayRows(repoRoot) {
  const file = path.join(repoRoot, 'plugins', 'dsh-app.patch.yml')
  if (!existsSync(file)) return { patched: [], inserted: [] }
  const lines = readFileSync(file, 'utf8').split(/\r?\n/u)
  const patched = []
  const inserted = []
  let inInsert = false
  for (const line of lines) {
    if (/^- insert:\s*$/u.test(line)) { inInsert = true; continue }
    if (/^-\s+id:\s*/u.test(line) || /^-\s*$/u.test(line)) inInsert = false
    const row = /^\s*-\s+id:\s*(\S+)\s*$/u.exec(line)
    if (row === null) continue
    ;(inInsert ? inserted : patched).push(row[1])
  }
  return { patched, inserted }
}

// ------------------------------------------------------------- target model

/**
 * A target line, abstracted so every check can ask the same questions.
 *
 * Three modes exist because the honest answer depends on what is available:
 *   - `installed`: this repository's own `node_modules` (names only — the
 *     published `.d.ts` are there, so declarations and slots also work);
 *   - `dir`: a checkout or worktree at a tag (source, unfollowed by a build);
 *   - `npm`: the published tarballs (authoritative, but a download).
 */
async function buildTarget(options) {
  if (options.dir !== undefined) return sourceTarget(path.resolve(options.dir), 'dir')
  if (options.npm !== undefined) return npmTarget(options.npm)
  return installedTarget(root)
}

/** @param {string} dir @param {'dir'} mode */
function sourceTarget(dir, mode) {
  const index = new Map()
  for (const a of readdirSync(path.join(dir, 'packages'), { withFileTypes: true })) {
    if (!a.isDirectory()) continue
    for (const b of readdirSync(path.join(dir, 'packages', a.name), { withFileTypes: true })) {
      if (!b.isDirectory()) continue
      const pkgDir = path.join(dir, 'packages', a.name, b.name)
      const manifestPath = path.join(pkgDir, 'package.json')
      if (!existsSync(manifestPath)) continue
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        if (typeof manifest.name === 'string') index.set(manifest.name, { dir: pkgDir, manifest })
      } catch { /* a malformed manifest is reported by the line check */ }
    }
  }
  return targetFacade({ mode, index, bundles: path.join(dir, 'packages', 'bundle') })
}

/** Published packages, unpacked into `scratch/kernel-preflight/<version>/`. */
/**
 * Published packages, fetched into `scratch/kernel-preflight/<version>/`.
 *
 * The tarball is downloaded directly and its `dist.integrity` checked, rather
 * than shelling out to `npm pack`: Windows ships `npm` as a .cmd shim that
 * `execFile` refuses without a shell, and a shell would re-quote every path this
 * script builds. Verifying the hash is also the only way this check can claim
 * "this is what users install" while a mirror is in play.
 *
 * @param {string} version - the published version.
 * @returns {Promise<object>} the target facade.
 */
async function npmTarget(version) {
  const cache = path.join(root, 'scratch', 'kernel-preflight', version)
  const index = new Map()
  const wanted = new Set([
    ...ourImports(root).keys(),
    '@deepseek-ai/dsh',
    '@deepseek-ai/dsh-skill-office',
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
  ])
  const packages = [...new Set([...wanted].map((spec) => splitSpec(spec).pkg))].sort()
  mkdirSync(cache, { recursive: true })
  for (const name of packages) {
    const dir = path.join(cache, name.replace('@deepseek-ai/', ''))
    if (!existsSync(path.join(dir, 'package.json'))) {
      // An upstream tarball can carry a symlink, so this tree goes through the
      // audited walker rather than a sync recursive delete (test/recursive-delete-guard).
      await removeTree(dir)
      mkdirSync(dir, { recursive: true })
      try {
        const tarball = path.join(cache, `${path.basename(dir)}-${version}.tgz`)
        const integrity = await downloadPublished(name, version, tarball)
        if (integrity !== undefined) verifyIntegrity(tarball, integrity, name)
        // Relative paths, because a Windows drive letter reads as a remote
        // host to GNU tar (`D:codes...` → "Cannot connect to D").
        execFileSync(TAR, ['-xzf', path.basename(tarball), '-C', path.basename(dir), '--strip-components=1'], {
          cwd: cache, stdio: ['ignore', 'ignore', 'pipe'],
        })
        unlinkSync(tarball)
      } catch (error) {
        // The reason travels with the finding: "not published" is a lie when the
        // download is what failed (no network, a private registry, a proxy).
        index.set(name, { missing: error instanceof Error ? error.message : String(error) })
        continue
      }
    }
    try {
      index.set(name, { dir, manifest: JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) })
    } catch { /* reported as missing by the published check */ }
  }
  // Every download failing is not a report about the line: it is a bad version
  // number, no network, or a registry that needs a token. Saying "32 packages
  // are gone" would send the reader looking for a rename that never happened.
  if (packages.length > 0 && [...index.values()].every((pkg) => pkg.missing !== undefined)) {
    const reasons = new Set([...index.values()].map((pkg) => pkg.missing))
    throw new Error(`no package of ${version} could be read (${[...reasons].slice(0, 2).join('; ')}); check the version, the network, or DSH_PREFLIGHT_REGISTRY`)
  }

  return targetFacade({ mode: 'npm', index, bundles: null })
}

/**
 * Download one published tarball.
 * @param {string} name - the package name.
 * @param {string} version - the exact version.
 * @param {string} target - where to write the tarball.
 * @returns {Promise<string | undefined>} the `dist.integrity` value, when published.
 */
async function downloadPublished(name, version, target) {
  const registry = process.env.DSH_PREFLIGHT_REGISTRY ?? 'https://registry.npmjs.org'
  const metaUrl = `${registry}/${name.replace('/', '%2F')}/${version}`
  const meta = await fetch(metaUrl)
  if (!meta.ok) throw new Error(`${meta.status} from ${metaUrl}`)
  const manifest = await meta.json()
  const tarballUrl = manifest?.dist?.tarball
  if (typeof tarballUrl !== 'string') throw new Error(`no dist.tarball for ${name}@${version}`)
  const response = await fetch(tarballUrl)
  if (!response.ok) throw new Error(`${response.status} from ${tarballUrl}`)
  writeFileSync(target, Buffer.from(await response.arrayBuffer()))
  return typeof manifest?.dist?.integrity === 'string' ? manifest.dist.integrity : undefined
}

/**
 * Check a downloaded tarball against the hash the registry published.
 * A mismatch is a hard failure: the report would otherwise describe a package
 * nobody installs.
 * @param {string} file - the downloaded tarball.
 * @param {string} integrity - the `sha512-…` value from the packument.
 * @param {string} name - the package name, for the error.
 */
function verifyIntegrity(file, integrity, name) {
  const [algorithm, expected] = integrity.split('-')
  const actual = createHash(algorithm).update(readFileSync(file)).digest('base64')
  if (actual !== expected) {
    throw new Error(`${name}: integrity mismatch (published ${algorithm}, got a different tarball)`)
  }
}

/** This repository's own installed tree: root scope plus every plugin-local one. */
function installedTarget(repoRoot) {
  const index = new Map()
  const copies = new Map()
  const record = (pkg, where) => {
    const name = `@deepseek-ai/${pkg.name}`
    const manifest = readManifest(pkg.dir)
    const seen = copies.get(name) ?? []
    seen.push({ version: manifest.version, where })
    copies.set(name, seen)
    if (!index.has(name)) index.set(name, { dir: pkg.dir, manifest })
  }
  for (const dir of pluginDirs(repoRoot)) {
    const where = path.relative(repoRoot, dir).split(path.sep).join('/')
    for (const pkg of installedKernelPackages(path.join(dir, 'node_modules', '@deepseek-ai'))) record(pkg, where)
  }
  for (const pkg of installedKernelPackages(path.join(repoRoot, 'node_modules', '@deepseek-ai'))) record(pkg, 'node_modules')
  return targetFacade({ mode: 'installed', index, copies, bundles: null })
}

function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    return {}
  }
}

/**
 * The questions every check asks, answered per mode.
 * @param {{mode: string, index: Map<string, object>, bundles: string | null}} state
 */
function targetFacade(state) {
  /**
   * The file a specifier resolves to, in whatever shape this tree has.
   *
   * Every mode parses DECLARATIONS, including the source tree (a `.ts` entry is a
   * declaration source too): a name re-exported through `export * from './types'`
   * reads as missing to an entry-only scan, which is exactly the false positive
   * this cost when the office provider was renamed.
   */
  const entryFile = (pkgName, sub) => {
    const pkg = state.index.get(pkgName)
    if (pkg?.dir === undefined) return undefined
    if (state.mode === 'dir') return sourceEntry(pkg.dir, sub)
    return declarationEntryFor(pkg.dir, sub)
  }

  const surfaceOf = (spec) => {
    const { pkg: name, sub } = splitSpec(spec)
    const pkg = state.index.get(name)
    if (pkg === undefined) return { resolved: false, reason: 'not in the target line' }
    if (pkg.missing !== undefined) return { resolved: false, reason: pkg.missing }
    const file = entryFile(name, sub)
    if (file === undefined) return { resolved: false, reason: `no readable entry for ${sub === '' ? '.' : `./${sub}`}` }
    return { resolved: true, ...collectSurface(file) }
  }

  return {
    mode: state.mode,
    has: (name) => state.index.has(name),
    packageNames: () => [...state.index.keys()].sort(),
    copiesOf: (name) => state.copies?.get(name) ?? [],
    packageOf: (name) => state.index.get(name),
    versionOf: (name) => state.index.get(name)?.manifest?.version,
    surfaceOf,
    slotIds: (only) => interfaceSurface(state.index, 'SlotMap', only),
    serviceIds: (only) => interfaceSurface(state.index, 'Context', only),
    bundleRows: (bundle) => bundleRows(state, bundle),
    skillNames: () => skillNamesOf(state),
    enginesOfDsh: () => {
      const dsh = (state.index.get('@deepseek-ai/dsh') ?? state.index.get('dsh'))?.manifest?.engines?.node
      if (typeof dsh === 'string') return dsh
      // `@deepseek-ai/dsh` is the CLI, which this repository does not depend on
      // (the runtime carries it). Every kernel package of a line declares the
      // same floor, so the first one that states it is the line's answer.
      const floors = [...state.index.values()]
        .map((pkg) => pkg.manifest?.engines?.node)
        .filter((node) => typeof node === 'string')
        .map((node) => ({ node, major: Number.parseInt(/(\d+)/u.exec(node)?.[1] ?? '0', 10) }))
        .sort((a, b) => b.major - a.major)
      return floors[0]?.node
    },
  }
}

/**
 * Where a specifier's entry lives in a source tree.
 *
 * The `exports` map points at `lib/types/…`, which a checkout does not build, so
 * its `types` path is mapped back onto `src/` (`lib/types/client/index.d.ts` →
 * `src/client/index.ts`) and the obvious candidates are tried after it.
 *
 * @param {string} pkgDir - the package directory.
 * @param {string} sub - the subpath (`''` for the root entry).
 */
function sourceEntry(pkgDir, sub) {
  const manifest = readManifest(pkgDir)
  const key = sub === '' ? '.' : `./${sub}`
  const types = typeof manifest.exports?.[key] === 'object' ? manifest.exports[key].types : undefined
  const bases = []
  if (typeof types === 'string') {
    bases.push(path.join(pkgDir, 'src', types.replace(/^\.\/lib\/types\//u, '').replace(/\.d\.ts$/u, '')))
  }
  bases.push(path.join(pkgDir, 'src', sub === '' ? 'index' : sub))
  for (const base of bases) {
    for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * The published declaration entry for a specifier (`exports[<key>].types`).
 * @param {string} pkgDir - the unpacked package directory.
 * @param {string} sub - the subpath (`''` for the root entry).
 */
function declarationEntryFor(pkgDir, sub) {
  const manifest = readManifest(pkgDir)
  const key = sub === '' ? '.' : `./${sub}`
  const types = typeof manifest.exports?.[key] === 'object' ? manifest.exports[key].types : undefined
  const candidate = typeof types === 'string' ? path.join(pkgDir, types) : path.join(pkgDir, 'lib', 'types', 'index.d.ts')
  return existsSync(candidate) ? candidate : undefined
}

// The modifiers come in any order and any number: `export async function
// writeFileAtomic` is the shape that made a live export read as gone.
const DECL = /export\s+(?:(?:declare|abstract|default|async)\s+)*(?:interface|type|class|const|let|var|function|enum)\s+([\w$]+)/gu
const REFROM = /export\s+(?:type\s+)?(?:\*|\{([^}]*)\})\s*from\s*'([^']+)'/gu
const STRIP = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1')

/**
 * Resolve a relative re-export specifier in either tree shape.
 *
 * The published declarations keep the SOURCE specifier (`from './CodeToolbar.tsx'`)
 * while the emitted files are `CodeToolbar.d.ts` / `CodeToolbar.js` — the
 * extension is REPLACED, not appended. Stripping only `.js` (the Node ESM
 * convention) therefore resolves nothing in a published tree, and the whole
 * package reads as exporting an empty surface: a "gone: Button, Modal, Toast…"
 * report against a package that exports all three.
 *
 * @param {string} fromFile - the file doing the re-export.
 * @param {string} spec - the relative specifier as written.
 */
function relativeTarget(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec)
  const stem = base.replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u, '')
  const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.d.ts`, `${stem}.d.mts`, `${stem}.js`]
  for (const dir of [stem, base]) candidates.push(path.join(dir, 'index.ts'), path.join(dir, 'index.d.ts'), path.join(dir, 'index.js'))
  return candidates.find((candidate) => existsSync(candidate) && /\.(ts|tsx|mts|d\.mts)$/u.test(candidate) && statSync(candidate).isFile())
}

/**
 * Exported names and their declaration text, following relative re-exports.
 *
 * Following them matters: a package that only re-exports reads as exporting
 * nothing to a single-file scan, and "cannot judge" must not be reported as
 * "missing". A cross-package re-export is NOT followed (the other package is
 * checked on its own, and its names are not this package's surface).
 *
 * @param {string} entry - the entry file.
 */
function collectSurface(entry) {
  const names = new Map()
  const seen = new Set()
  const visit = (file) => {
    if (file === undefined || seen.has(file)) return
    seen.add(file)
    const text = STRIP(readFileSync(file, 'utf8'))
    for (const match of text.matchAll(DECL)) {
      if (!names.has(match[1])) names.set(match[1], declarationText(text, match.index))
    }
    for (const match of text.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/gu)) {
      for (const part of match[1].split(',')) {
        const name = part.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u).pop()?.trim()
        if (name !== undefined && name !== '' && !names.has(name)) names.set(name, name)
      }
    }
    for (const match of text.matchAll(REFROM)) {
      const target = match[2]
      if (target.startsWith('.')) { visit(relativeTarget(file, target)); continue }
      if (match[1] === undefined) continue // `export * from 'pkg'`: another package's surface
      for (const part of match[1].split(',')) {
        const name = part.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u).pop()?.trim()
        if (name !== undefined && name !== '' && !names.has(name)) names.set(name, name)
      }
    }
  }
  visit(entry)
  return { names: new Set(names.keys()), declarations: names, file: entry }
}

/**
 * A declaration reduced to the shape a caller depends on.
 *
 * The published `.d.ts` and the source `.ts` differ in ways that carry no
 * meaning — semicolon separators, `declare`, a trailing `{}` versus `{ }` — and
 * a diff that reports those is a diff nobody reads. 86 of 86 "changed"
 * declarations on a same-line comparison were pure formatting before this
 * normalisation existed.
 *
 * @param {string} text - the declaration text.
 */
function normalizeDeclaration(text) {
  return text
    .split('declare ').join('')
    .replace(/;/gu, ' ')
    .replace(/\{\s*\}/gu, '{}')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * The member declarations of a brace-bodied declaration.
 *
 * This is what makes an ADDITIVE change cheap to read: an optional prop gained
 * is not a call site to fix. Without it, "Checkbox gained `modalAutofocus`" and
 * "SubagentActivation lost `name`" read the same, and one of them cost this
 * repository a release.
 *
 * @param {string} text - the declaration text.
 * @returns {string[] | undefined} normalised members, or undefined when the
 *   declaration has no brace body to split.
 */
function declarationMembers(text) {
  const open = text.indexOf('{')
  if (open === -1) return undefined
  let depth = 0
  let end = -1
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }
  if (end === -1) return undefined
  const body = text.slice(open + 1, end)
  const members = []
  let current = ''
  let inner = 0
  for (const char of body) {
    if ('{([<'.includes(char)) inner += 1
    else if ('})]>'.includes(char)) inner -= 1
    // A member ends at a semicolon, a newline, or — for a destructured
    // parameter list — a top-level comma. The text was whitespace-collapsed
    // before it got here, so the newline case only fires on raw input.
    if (inner === 0 && (char === ';' || char === '\n' || char === ',')) {
      if (current.trim() !== '') members.push(normalizeDeclaration(current))
      current = ''
      continue
    }
    current += char
  }
  if (current.trim() !== '') members.push(normalizeDeclaration(current))
  return members
}

/**
 * A declaration's text: its keyword to the end of its body, whitespace-squashed.
 *
 * Three shapes need three end rules. A brace body (interface, class, a function
 * with a block) ends at its matching brace. A short form ends at its semicolon.
 * A multi-line union type has BOTH, but its `{` belongs to a member rather than
 * to the declaration, so it ends at the first line that is not an indented
 * continuation — reading it to the semicolon instead swallows the next export,
 * and two adjacent declarations then compare as one changed blob.
 *
 * @param {string} text - the file text.
 * @param {number} start - the declaration's keyword offset.
 */
function declarationText(text, start) {
  const open = text.indexOf('{', start)
  const eq = text.indexOf('=', start)
  const semi = text.indexOf(';', start)
  const lineBreak = text.slice(start).search(/\n(?=[^\s])/u)
  const lineEnd = lineBreak === -1 ? -1 : start + lineBreak
  const isUnion = eq !== -1 && (open === -1 || eq < open)
  // The slice keeps its line breaks: members of an interface are separated by
  // newlines in this codebase's house style, and collapsing them first merges
  // the whole body into one member (which then never compares as additive).
  // normalizeDeclaration is what flattens text for display and comparison.
  if (open !== -1 && !isUnion) {
    let depth = 0
    for (let index = open; index < text.length; index += 1) {
      if ('{[('.includes(text[index])) depth += 1
      else if ('}])'.includes(text[index])) {
        depth -= 1
        if (depth === 0) return text.slice(start, index + 1).trim()
      }
    }
    return ''
  }
  const stops = [semi === -1 ? Infinity : semi + 1, lineEnd === -1 ? Infinity : lineEnd, start + 600]
  return text.slice(start, Math.min(...stops)).trim()
}

/**
 * Members declared by every `interface <name> { … }` in a tree, member → file.
 *
 * One scanner for two surfaces, because they are the same shape and two copies
 * would drift: `interface SlotMap` carries the client seats, and
 * `interface Context` (inside a `declare module` block) carries the host
 * services. Both are quoted-or-bare keys, one per line.
 *
 * @param {string[]} files - the files to scan.
 * @param {string} name - the interface name, e.g. `SlotMap` or `Context`.
 */
function interfaceMembers(files, name) {
  const declared = new Map()
  const head = new RegExp(String.raw`interface\s+${name}\b`, 'u')
  for (const file of files) {
    const text = STRIP(readFileSync(file, 'utf8'))
    for (const match of text.matchAll(new RegExp(head.source, 'gu'))) {
      const start = match.index
      const open = text.indexOf('{', start)
      if (open === -1) continue
      let depth = 0
      let end = open
      for (; end < text.length; end += 1) {
        if (text[end] === '{') depth += 1
        else if (text[end] === '}') {
          depth -= 1
          if (depth === 0) break
        }
      }
      for (const member of text.slice(open + 1, end).matchAll(/^\s*'?([\w.-]+)'?\s*[:?(]/gmu)) {
        if (!declared.has(member[1])) declared.set(member[1], file)
      }
    }
  }
  return declared
}

/**
 * An interface surface of the whole target line.
 *
 * Source trees are read as source and published trees as declarations; a client
 * package that only the plugin-local trees carry is included either way, because
 * the facade's index already merged every tree.
 *
 * `only` is how a comparison stays fair: an npm target holds the ~35 packages we
 * import, while the installed tree holds every package of the line. Without the
 * restriction, a service declared by a package the download set omits (`settings`,
 * `credentials`, `credentials`, cordis's own `logger`/`get`/`inject`) reads as
 * removed by the target, and the report blames the line for its own blind spot.
 *
 * @param {Map<string, object>} index - the target's packages.
 * @param {string} name - the interface name.
 * @param {Iterable<string>} [only] - package names to include, when restricted.
 */
function interfaceSurface(index, name, only) {
  const allowed = only === undefined ? undefined : new Set(only)
  const files = []
  for (const [packageName, pkg] of index.entries()) {
    if (allowed !== undefined && !allowed.has(packageName)) continue
    // The cordis fork is versioned off the line, and its Context base members
    // (logger, get, inject, provide, fiber) are not part of what a line move can
    // rename. Left in, a SOURCE target — which does not carry cordis at all —
    // reports every one of them as a removed service.
    if (NON_LINE.has(packageName)) continue
    if (pkg.dir === undefined) continue
    const sourceDir = path.join(pkg.dir, 'src')
    if (existsSync(sourceDir)) files.push(...sourceFiles(sourceDir))
    const declarationDir = path.join(pkg.dir, 'lib', 'types')
    if (existsSync(declarationDir)) files.push(...collectFiles(declarationDir, '.d.ts'))
  }
  return files.length === 0 ? new Map() : interfaceMembers(files, name)
}

function collectFiles(dir, extension, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectFiles(full, extension, out)
    else if (entry.name.endsWith(extension)) out.push(full)
  }
  return out
}

/** Loader row ids in a bundle layer's patch file, or null when the layer is absent. */
function bundleRows(state, bundle) {
  const candidates = []
  if (state.bundles !== null) candidates.push(path.join(state.bundles, bundle, 'cordis.patch.yml'))
  const pkg = state.index.get(`@deepseek-ai/dsh-${bundle}`)
  if (pkg?.dir !== undefined) candidates.push(path.join(pkg.dir, 'cordis.patch.yml'))
  const file = candidates.find((candidate) => existsSync(candidate))
  if (file === undefined) return null
  const ids = new Set()
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const row = /^\s*-\s+id:\s*['"]?([\w.-]+)['"]?\s*$/u.exec(line)
    if (row !== null) ids.add(row[1])
  }
  return ids
}

/** The target `skill-office` skill names, read from source or from the built module. */
function skillNamesOf(state) {
  const pkg = state.index.get('@deepseek-ai/dsh-skill-office')
  if (pkg?.dir === undefined) return null
  const files = [path.join(pkg.dir, 'src', 'index.ts'), path.join(pkg.dir, 'lib', 'index.js')]
  for (const file of files) {
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    const block = /SKILL_NAMES\s*=\s*\[([\s\S]*?)\]/u.exec(text)
    if (block === null) continue
    // The source list is single-quoted and the published build is double-quoted
    // (a bundler writes JSON-ish output); reading only one style reports an
    // empty upstream list, which then reads as "we have four names it does not".
    const names = [...block[1].matchAll(/['"]([\w.-]+)['"]/gu)].map((match) => match[1])
    if (names.length === 0) continue
    return names
  }
  return null
}

// ----------------------------------------------------------------- checks

/**
 * 1. One line.
 *
 * Two different failures live under "mixed line", and merging them is what made
 * this check unusable in CI:
 *
 *   - a copy BELOW the followed line (a stale nested copy that wins resolution
 *     silently, or a tree someone half-reinstalled) — never acceptable, always a
 *     blocker;
 *   - a copy ABOVE it (upstream published, plugin trees float on `^` while the
 *     root lockfile still pins the old version) — nothing is stale, the line bump
 *     is simply due. Blocking on that turns every unrelated pull request red the
 *     day upstream tags a release, so it is reported as a note with the action
 *     spelled out. `--line-policy=exact` (what a release run wants) makes it a
 *     blocker again.
 *
 * @param {object} target - the target facade.
 * @param {Map<string, Set<string>>} imports - our import map.
 * @param {object} findings - the report.
 * @param {'floor'|'exact'} policy - how to treat a copy above the followed line.
 * @returns {string | undefined} the line version, for the header line.
 */
function checkLine(target, imports, findings, policy = 'floor') {
  const packages = [...new Set([...imports.keys()].map((spec) => splitSpec(spec).pkg))]
  const floor = followedSpec()
  const drift = []
  const versions = new Map()

  for (const name of packages.sort()) {
    const version = target.versionOf(name)
    if (version === undefined) {
      const reason = target.packageOf(name)?.missing
      findings.blocker('published', name, 'not present in the target line',
        reason === undefined ? 'rename it here and in every manifest, or drop the import' : `the target could not be read: ${reason}`)
      continue
    }
    const bucket = versions.get(version) ?? []
    bucket.push(name)
    versions.set(version, bucket)

    for (const copy of target.copiesOf(name)) {
      if (compareVersions(copy.version, floor) >= 0) continue
      findings.blocker('line', `${name} ${copy.version}`, `older than the followed line ${floor} · ${copy.where}`,
        'a stale copy wins the resolution silently: reinstall that plugin (or the root tree) before trusting any build')
    }
    const ahead = target.copiesOf(name).filter((copy) => compareVersions(copy.version, floor) > 0)
    if (ahead.length > 0) drift.push(`${name} (${[...new Set(ahead.map((copy) => copy.version))].join('/')})`)
  }

  if (drift.length > 0) {
    findings.add(policy === 'exact' ? 'blocker' : 'note', 'line',
      `${String(drift.length)} package(s) ahead of the followed line ${floor}`,
      `this tree already carries what upstream published — bump the line (specs + lockfile + the two version resolutions): ${drift.slice(0, 6).join(', ')}`,
      policy === 'exact' ? 'a release must be built from one line; bump before shipping' : undefined)
  }

  if (versions.size > 1) {
    for (const [version, names] of versions) {
      findings.blocker('line', `${String(names.length)} package(s) resolve at ${version}`, names.slice(0, 6).join(', '),
        'two lines inside one tree: a stale copy, or a half-reinstalled plugin; find it before trusting any build')
    }
  } else if (versions.size === 1) {
    findings.note('line', [...versions.keys()][0], `${String(packages.length)} consumed packages resolve at one version`)
  }
  return [...versions.keys()][0]
}

/** 2. Node floor vs CI. */
function checkEngines(target, findings) {
  const floor = target.enginesOfDsh()
  if (typeof floor !== 'string') {
    findings.note('engines', 'dsh', 'the target declares no engines.node')
    return
  }
  const configured = ciNodeVersions()
  const major = Number.parseInt(/(\d+)\./u.exec(floor)?.[1] ?? '', 10)
  if (!Number.isFinite(major) || configured.length === 0) {
    findings.note('engines', `node ${floor}`, `CI node-version lines: ${configured.join(', ') || 'none found'}`)
    return
  }
  const tooLow = configured.filter((version) => Number.parseInt(/(\d+)/u.exec(version)?.[1] ?? '0', 10) < major)
  if (tooLow.length > 0) {
    findings.blocker('engines', `node ${floor}`, `CI runs ${tooLow.join(', ')}`,
      'raise .github/workflows node-version to the floor (and check scripts/build-runtime.mjs packs that Node)')
  } else {
    findings.note('engines', `node ${floor}`, `CI runs ${configured.join(', ')}`)
  }
}

function ciNodeVersions() {
  const dir = path.join(root, '.github', 'workflows')
  if (!existsSync(dir)) return []
  const versions = new Set()
  for (const file of readdirSync(dir).filter((name) => /\.ya?ml$/u.test(name))) {
    const text = readFileSync(path.join(dir, file), 'utf8')
    for (const match of text.matchAll(/node-version:\s*['"]?([^'"\s]+)['"]?/gu)) versions.add(match[1])
  }
  return [...versions].sort()
}

/** 3. Removals: every symbol we import must still be exported. */
function checkExports(target, imports, findings) {
  for (const [name, symbols] of [...imports].sort()) {
    const surface = target.surfaceOf(name)
    if (!surface.resolved) {
      findings.note('exports', name, `cannot judge: ${surface.reason ?? 'not in target'}`)
      continue
    }
    const missing = [...symbols].filter((symbol) => !surface.names.has(symbol))
    if (missing.length === 0) continue
    findings.blocker('exports', name, `gone: ${missing.join(', ')}`,
      'rename the import (and its use) or re-derive it from what the line exposes now; a type gate will not catch a value export')
  }
}

/** 4. Declarations: a symbol that survived can still have changed shape. */
function checkDeclarations(target, imports, findings, baseline) {
  if (target.mode === 'installed') {
    findings.note('declarations', 'skipped', 'the installed line IS the baseline; use --npm <version> for a declaration diff')
    return
  }
  if ((target.mode === 'dir') !== (baseline.mode === 'dir')) {
    // One side is SOURCE and the other is published DECLARATIONS. Comparing them
    // reports the difference between an implementation and its type surface (a
    // function body versus a return annotation), which is not a change. Pair a
    // checkout with a checkout (`--dir` + `--baseline-dir`) or a published line
    // with a published one (`--npm` + `--baseline-npm`).
    findings.note('declarations', 'skipped', 'source and published declarations are not comparable; pair like with like')
    return
  }
  let compared = 0
  const changed = []
  const added = []
  for (const [spec, symbols] of [...imports].sort()) {
    const surface = target.surfaceOf(spec)
    if (!surface.resolved || surface.declarations === undefined) continue
    const before = baseline.surfaceOf(spec)
    for (const symbol of symbols) {
      const text = surface.declarations.get(symbol)
      // A name that only re-exports records its own name as text; there is
      // nothing to diff, and the exports check already owns existence.
      if (text === undefined || text === symbol) continue
      const previous = before.resolved === true ? before.declarations?.get(symbol) : undefined
      if (previous === undefined || previous === symbol) continue
      const was = normalizeDeclaration(previous)
      const now = normalizeDeclaration(text)
      if (was === now || was.length === 0 || now.length === 0) continue
      compared += 1

      // An optional member gained (or a whole member the old declaration did not
      // have) breaks no call site: note it, do not send the reader to the type
      // gate.
      const beforeMembers = declarationMembers(previous)
      const afterMembers = declarationMembers(text)
      if (beforeMembers !== undefined && afterMembers !== undefined && beforeMembers.every((member) => afterMembers.includes(member)) && afterMembers.length > beforeMembers.length) {
        const fresh = afterMembers.filter((member) => !beforeMembers.includes(member))
        // A destructured parameter list makes every added name optional by
        // absence; elsewhere an added member must be optional or defaulted.
        // `readonly name: string` on SubagentActivation is REQUIRED, and that is
        // the shape that forced a call-site change in plugin-swarm.
        const destructured = /\(\s*\{/u.test(text)
        if (destructured || fresh.every((member) => member.includes('?:') || member.includes('= '))) {
          added.push(`${spec} · ${symbol} (+${String(fresh.length)})`)
          findings.note('declarations', `${spec} · ${symbol}`, `additive: ${fresh.join('; ').slice(0, 160)}`)
          continue
        }
      }

      changed.push(`${spec} · ${symbol}`)
      const shown = firstDivergence(was, now)
      findings.adapt('declarations', `${spec} · ${symbol}`, `before: ${shown.before}\n      after:  ${shown.after}`,
        'read the new shape before touching call sites; the type gate names the sites it breaks')
    }
  }
  const summary = []
  if (changed.length > 0) summary.push(`${String(changed.length)} changed: ${changed.slice(0, 5).join(', ')}`)
  if (added.length > 0) summary.push(`${String(added.length)} additive: ${added.slice(0, 5).join(', ')}`)
  findings.note('declarations', `${String(compared)} declaration(s) compared`,
    summary.length === 0 ? 'no declaration any import depends on changed shape' : summary.join(' | '))
}

/**
 * The window around a declaration's first difference.
 *
 * Two declarations of different length would otherwise both be cut at 150
 * characters, and a difference in the last member reads as a difference
 * everywhere. Showing the divergence instead of the head is what makes the line
 * readable at a glance.
 *
 * @param {string} before - the normalised baseline text.
 * @param {string} after - the normalised target text.
 */
function firstDivergence(before, after) {
  let index = 0
  while (index < before.length && index < after.length && before[index] === after[index]) index += 1
  const from = Math.max(0, index - 60)
  const lead = from === 0 ? '' : '…'
  return {
    before: lead + before.slice(from, index + 140).trimStart(),
    after: lead + after.slice(from, index + 140).trimStart(),
  }
}

/** 5. Slots: a retired seat is a silent no-op, an undeclared one throws. */
function checkSlots(target, findings) {
  const declared = target.slotIds()
  if (declared.size === 0) {
    findings.note('slots', 'skipped', 'the target declares no SlotMap that this scan can read')
    return
  }
  const ours = ourSlotIds(root)
  const own = ourOwnDeclarations(root)
  for (const [id, where] of ours) {
    if (declared.has(id)) continue
    if (own.has(id)) continue // declared by a plugin in this repo
    findings.blocker('slots', id, `registered at ${where} but no target SlotMap declares it`,
      'the registration is a silent no-op now; move it to a seat the line still declares or drop it')
  }
  findings.note('slots', `${String(ours.size)} id(s) we register`, `target declares ${String(declared.size)}`)
}

/** Slot ids a plugin in THIS repository declares (they are not the target's). */
function ourOwnDeclarations(repoRoot) {
  const files = []
  for (const dir of pluginDirs(repoRoot)) files.push(...sourceFiles(path.join(dir, 'src')))
  return interfaceMembers(files, 'SlotMap')
}

/** 6. Overlay rows: a patched row that moved makes the patch a silent no-op. */
function checkOverlay(target, findings) {
  const { patched, inserted } = ourOverlayRows(root)
  const upstream = new Set()
  let readable = false
  for (const bundle of ['base', 'web-app']) {
    const rows = target.bundleRows(bundle)
    if (rows === null) continue
    readable = true
    for (const id of rows) upstream.add(id)
  }
  if (!readable) {
    findings.note('overlay', 'skipped', 'the target tree carries no bundle patch layers this scan can read')
    return
  }
  for (const id of patched) {
    if (upstream.has(id)) continue
    findings.blocker('overlay', id, 'patched by plugins/dsh-app.patch.yml but no base/web-app row carries it',
      'a patch row without a target is a silent no-op: find the row the line moved it to, or drop the patch')
  }
  for (const id of inserted) {
    if (!upstream.has(id)) continue
    findings.blocker('overlay', id, 'our insert id collides with a row the target line now ships',
      'rename our row, or patch theirs instead of inserting a duplicate')
  }
  findings.note('overlay', `${String(patched.length)} patched / ${String(inserted.length)} inserted`,
    `target bundles carry ${String(upstream.size)} rows`)
}

/** 7. skill-office: the two lists in this repo must match the package's own. */
function checkSkillOffice(target, findings) {
  const upstream = target.skillNames()
  if (upstream === null) {
    findings.note('skill-office', 'skipped', 'the target does not ship @deepseek-ai/dsh-skill-office, or its list is unreadable')
    return
  }
  const mirrors = ['scripts/build-runtime.mjs', 'src/main/desktop-host.ts']
  let found = 0
  for (const file of mirrors) {
    const full = path.join(root, file)
    if (!existsSync(full)) continue
    const block = /OFFICE_SKILL_NAMES\s*=\s*\[([\s\S]*?)\]/u.exec(readFileSync(full, 'utf8'))
    // A file that no longer mirrors the list is not a defect: the mirror moves
    // with the code that needs it. Only a TOTAL absence is worth a note.
    if (block === null) continue
    found += 1
    const listed = [...block[1].matchAll(/'([^']+)'/gu)].map((match) => match[1])
    const missing = upstream.filter((name) => !listed.includes(name))
    const extra = listed.filter((name) => !upstream.includes(name))
    if (missing.length === 0 && extra.length === 0) continue
    findings.blocker('skill-office', file,
      `upstream: ${upstream.join(', ')} | missing here: ${missing.join(', ') || '-'} | extra here: ${extra.join(', ') || '-'}`,
      'both copies refuse at build or boot; move them together with the line')
  }
  if (found === 0) findings.note('skill-office', 'no mirror found', 'no OFFICE_SKILL_NAMES list in this repository any more')
  else findings.note('skill-office', `${String(upstream.length)} upstream skill(s) × ${String(found)} mirror(s)`, upstream.join(', '))
}

/**
 * 8. Peers: a sibling the target NEWLY declares as a peer.
 *
 * The delta matters more than the absolute set. Our line already declares peers
 * this repository never installs (they are not reached at runtime, so nothing
 * breaks); what costs a release is a peer the target ADDS, because
 * `--legacy-peer-deps` will not put it on disk and every plugin whose suite
 * bundles that package fails with "Could not resolve".
 *
 * Both sides are read from MANIFESTS, never from `node_modules`: the question is
 * "will an install have this", and a checkout without an install would otherwise
 * report every peer of every package as unmet.
 *
 * @param {object} target - the target facade.
 * @param {object} baseline - the baseline facade.
 * @param {object} imports - our import map.
 * @param {object} findings - the report.
 */
function checkPeers(target, baseline, imports, findings) {
  const packages = [...new Set([...imports.keys()].map((spec) => splitSpec(spec).pkg))]
  const declared = declaredDependencies()
  let judged = 0
  for (const name of packages.sort()) {
    const peers = Object.keys(target.packageOf(name)?.manifest?.peerDependencies ?? {})
    if (peers.length === 0) continue
    const before = new Set(Object.keys(baseline.packageOf(name)?.manifest?.peerDependencies ?? {}))
    for (const peer of peers.filter((candidate) => candidate.startsWith('@deepseek-ai/') && !before.has(candidate))) {
      judged += 1
      if (declared.has(peer)) {
        findings.note('peers', `${name} → ${peer}`, 'a new peer, already declared in this repository\'s manifests')
        continue
      }
      findings.blocker('peers', `${name} → ${peer}`, 'newly declared peer that no manifest of this repository installs',
        'add it to the devDependencies of every plugin whose suite bundles this package — --legacy-peer-deps skips peers')
    }
  }
  findings.note('peers', `${String(judged)} new peer(s)`, judged === 0 ? 'the target adds no peer over the baseline' : 'see above')
}

/**
 * Every `@deepseek-ai/*` name any manifest in this repository depends on.
 *
 * Read as text from the manifests rather than resolved from `node_modules`, so
 * the answer is the same before an install and after one.
 *
 * @returns {Set<string>} the declared package names.
 */
function declaredDependencies() {
  const declared = new Set()
  const manifests = [path.join(root, 'package.json'), ...pluginDirs(root).map((dir) => path.join(dir, 'package.json'))]
  for (const file of manifests) {
    if (!existsSync(file)) continue
    const manifest = readManifest(path.dirname(file))
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(manifest[field] ?? {})) declared.add(name)
    }
  }
  return declared
}



/**
 * 11. Transitive pins: a dependency the target line now requires at a version
 *     this tree does not have.
 *
 * The 0.2.2-rc.2 move broke `plugin-rewind` exactly this way: the kernel's
 * `dsh-session-projection` began pinning `zod` 4.6.6 while the plugin bundled
 * 4.4.3, and the projection's `ZodType` lost `validate`/`validateAsync` at
 * runtime. No symbol disappeared, no type changed — the versions simply did not
 * agree, which is why every other check here was silent.
 *
 * The line pins exact versions, so the comparison needs no resolver: an exact
 * pin that differs from the copy on disk is the whole test. Ranges are skipped
 * rather than guessed at.
 *
 * @param {object} target - the target facade.
 * @param {object} imports - our import map.
 * @param {object} findings - the report.
 */
function checkDeps(target, imports, findings) {
  const packages = [...new Set([...imports.keys()].map((spec) => splitSpec(spec).pkg))]
  const seen = new Set()
  let judged = 0
  for (const name of packages.sort()) {
    const dependencies = target.packageOf(name)?.manifest?.dependencies ?? {}
    for (const [dependency, range] of Object.entries(dependencies)) {
      // A line package pinned to the LINE version is not a transitive pin: this
      // tree sitting one line behind is the expected state before a bump, and the
      // line check plus the bump itself own that question. Leaving it in buried a
      // real report under 11 rows of "dsh-brand 0.2.2-rc.3, we have rc.2" on the
      // first release-day run.
      if (dependency.startsWith('@deepseek-ai/')) continue
      if (!/^\d+\.\d+\.\d+/u.test(range)) continue // a range: not decidable here
      if (seen.has(`${dependency}@${range}`)) continue
      const ours = installedVersionOf(dependency)
      if (ours === undefined || ours === range) continue
      seen.add(`${dependency}@${range}`)
      judged += 1
      const older = compareVersions(ours, range) < 0
      findings.add(older ? 'blocker' : 'note', 'deps', `${dependency} ${range} ← ${name}`,
        `the target pins ${range}; this tree has ${ours}`,
        older
          ? 'bundle the version the line requires (a plugin-local bump); the two APIs differ at runtime, not at the type gate'
          : 'newer than the line requires; usually harmless, but a shared module instance can disagree')
    }
  }
  findings.note('deps', `${String(judged)} mismatched pin(s)`, judged === 0 ? 'every exact pin the target makes matches this tree' : 'see above')
}

/** The version of a package anywhere in this repository's own trees. */
function installedVersionOf(name) {
  const candidates = [
    path.join(root, 'node_modules', name, 'package.json'),
    ...pluginDirs(root).map((dir) => path.join(dir, 'node_modules', name, 'package.json')),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  return found === undefined ? undefined : readManifest(path.dirname(found)).version
}

/**
 * Compare two semver-ish versions by their numeric parts.
 * @param {string} left - a version.
 * @param {string} right - a version.
 * @returns {number} negative when left is older.
 */
function compareVersions(left, right) {
  const split = (value) => {
    const [release, ...rest] = String(value).replace(/^[\^~>=]+/u, '').split('+')[0].split('-')
    return { release: release.split('.').map((part) => Number.parseInt(part, 10) || 0), prerelease: rest.join('-') }
  }
  const a = split(left)
  const b = split(right)
  for (let index = 0; index < Math.max(a.release.length, b.release.length); index += 1) {
    const difference = (a.release[index] ?? 0) - (b.release[index] ?? 0)
    if (difference !== 0) return difference
  }
  // A release outranks any prerelease of the same version (semver §11): 0.2.2
  // is newer than 0.2.2-rc.3. This line moves BETWEEN prereleases, so the rc
  // numbers themselves have to be compared, not discarded.
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === '') return 1
  if (b.prerelease === '') return -1
  const leftParts = a.prerelease.split('.')
  const rightParts = b.prerelease.split('.')
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const x = leftParts[index] ?? ''
    const y = rightParts[index] ?? ''
    if (x === y) continue
    const nx = Number.parseInt(x, 10)
    const ny = Number.parseInt(y, 10)
    if (Number.isFinite(nx) && Number.isFinite(ny)) return nx - ny
    return x < y ? -1 : 1
  }
  return 0
}

/**
 * 9. Services: a host service id the target renamed or removed.
 *
 * This is the host-side twin of a client slot. `officeToPdf` → `officeKit` in
 * the 0.2.2 line turned every `ctx.officeToPdf.…` call into a property read on
 * `undefined`, and only the two plugins that build with `tsc` saw it.
 *
 * The question is deliberately narrow: a name the BASELINE line declared and the
 * target does not. Cordis's own members (`ctx.logger`, `ctx.on`, `ctx.get`) are
 * declared by a package this scan does not compare, so asking "does the target
 * declare every name we use" would report them as gone on every run.
 *
 * @param {object} target - the target facade.
 * @param {object} baseline - the installed line's facade.
 * @param {object} findings - the report.
 */
function checkServices(target, baseline, findings) {
  const after = target.serviceIds()
  // Only the packages both sides carry: a source checkout holds the whole line,
  // an npm target holds the packages we import. See interfaceSurface on `only`.
  const before = baseline.serviceIds(target.mode === 'npm' ? target.packageNames() : undefined)
  if (before.size === 0 || after.size === 0) {
    findings.note('services', 'skipped', 'no Context interface this scan can read on one side of the comparison')
    return
  }
  const used = ourServiceUses(root)
  let judged = 0
  for (const [id, where] of used) {
    if (!before.has(id)) continue // not a kernel service (cordis, a local map, a typo)
    judged += 1
    if (after.has(id)) continue
    findings.blocker('services', id, `used at ${where}; the baseline line declared it, the target does not`,
      'every call through it is a property read on undefined; the id was renamed or the service left the line')
  }
  findings.note('services', `${String(judged)} of ${String(used.size)} ctx.<id> use(s) judged`,
    `target declares ${String(after.size)} service(s)`)
}

/**
 * 10. Payload: how much of each package actually changed.
 *
 * The answer the changelog does not give. A line move is 30+ packages and the
 * question that decides where to look is "which of them changed at all" — the
 * previous two moves each spent an hour on this with a scratch script. Only
 * `--npm` can answer it, because it is the only mode where the target bytes and
 * the installed bytes are the same kind of thing.
 *
 * @param {object} target - the target facade.
 * @param {object} findings - the report.
 */
function checkPayload(target, findings) {
  if (target.mode !== 'npm') {
    findings.note('payload', 'skipped', 'a byte-for-byte comparison needs --npm <version>')
    return
  }
  const changed = []
  for (const name of target.packageNames()) {
    const pkg = target.packageOf(name)
    if (pkg?.dir === undefined) continue
    const installed = resolveInstalledDir(name)
    if (installed === undefined) continue
    const diff = payloadDiff(installed, pkg.dir)
    if (diff.changed === 0 && diff.added === 0 && diff.removed === 0) continue
    changed.push({ name, ...diff })
  }
  if (changed.length === 0) {
    findings.note('payload', 'every package is byte-identical', 'no payload changed between the installed line and the target')
    return
  }
  const total = changed.reduce((sum, item) => sum + item.changed + item.added + item.removed, 0)
  findings.note('payload', `${String(changed.length)} package(s), ${String(total)} file(s) differ (−removed ~changed +added)`,
    changed.sort((a, b) => b.changed + b.added + b.removed - (a.changed + a.added + a.removed))
      .slice(0, 12)
      .map((item) => `${item.name.replace('@deepseek-ai/', '')} (-${String(item.removed)} ~${String(item.changed)} +${String(item.added)})`)
      .join(', '))
}

/** Where this repository's own tree carries a package, if anywhere. */
function resolveInstalledDir(name) {
  const short = name.replace('@deepseek-ai/', '')
  const candidates = [
    path.join(root, 'node_modules', '@deepseek-ai', short),
    ...pluginDirs(root).map((dir) => path.join(dir, 'node_modules', '@deepseek-ai', short)),
  ]
  return candidates.find((candidate) => existsSync(path.join(candidate, 'package.json')))
}

/**
 * Count added, removed and changed files between two package trees.
 *
 * `package.json` is excluded: its version and its internal pins are supposed to
 * differ on every line move, so counting it says nothing. Source maps and
 * READMEs are excluded for the same reason — they carry no behaviour.
 *
 * @param {string} before - the installed package directory.
 * @param {string} after - the target package directory.
 * @returns {{ changed: number, added: number, removed: number }} the counts.
 */
function payloadDiff(before, after) {
  const ignored = /(^|[\\/])(package\.json|README[^/]*\.md|\.DS_Store)$|(\.map|\.d\.ts\.map)$|(^|[\\/])locale[\\/][^\\/]+\.json$/u
  const left = fileHashes(before, ignored)
  const right = fileHashes(after, ignored)
  let changed = 0
  let added = 0
  let removed = 0
  for (const [file, hash] of left) {
    if (!right.has(file)) removed += 1
    else if (right.get(file) !== hash) changed += 1
  }
  for (const file of right.keys()) if (!left.has(file)) added += 1
  return { changed, added, removed }
}

/** A relative-path → sha256 map for a package tree. */
function fileHashes(dir, ignored, base = dir, out = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    const relative = path.relative(base, full).split(path.sep).join('/')
    if (ignored.test(relative)) continue
    if (entry.isDirectory()) fileHashes(full, ignored, base, out)
    else out.set(relative, createHash('sha256').update(readFileSync(full)).digest('hex'))
  }
  return out
}

// ------------------------------------------------------------------- main

function parseArgs(argv) {
  const options = { json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--json') { options.json = true; continue }
    if (token.startsWith('--line-policy=')) {
      const value = token.slice('--line-policy='.length)
      if (value !== 'floor' && value !== 'exact') throw new Error(`--line-policy takes floor or exact, not ${value}`)
      options.linePolicy = value
      continue
    }
    if (token === '--dir' || token === '--npm' || token === '--baseline-dir' || token === '--baseline-npm') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`)
      options[token.slice(2)] = value
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${token}`)
  }
  if (options.dir !== undefined && options.npm !== undefined) throw new Error('--dir and --npm are exclusive')
  if (options['baseline-dir'] !== undefined && options['baseline-npm'] !== undefined) {
    throw new Error('--baseline-dir and --baseline-npm are exclusive')
  }
  return options
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`kernel-preflight: ${error.message}`)
    console.error('usage: node scripts/kernel-preflight.mjs [--dir <checkout> | --npm <version>] [--json]')
    process.exit(2)
  }

  const imports = ourImports(root)
  const target = await buildTarget(options)
  // The baseline defaults to THIS repository's installed line: a declaration only
  // matters when it differs from what the code in this tree is written against.
  //
  // `--baseline-dir` / `--baseline-npm` exist to re-audit a move that already
  // happened — the checks then answer "what would this have told us the day
  // before we adapted", with the old line as the baseline and the new one as the
  // target. Both sides should be the same KIND of tree (two checkouts, or two
  // published lines), because a source declaration and a published one differ in
  // ways that carry no meaning.
  const baselineOptions = options['baseline-dir'] !== undefined
    ? { dir: options['baseline-dir'] }
    : options['baseline-npm'] !== undefined
      ? { npm: options['baseline-npm'] }
      : undefined
  const baseline = baselineOptions !== undefined
    ? await buildTarget(baselineOptions)
    : target.mode === 'installed' ? target : await buildTarget({})
  const findings = new Findings()

  const line = checkLine(target, imports, findings, options.linePolicy ?? 'floor')
  checkEngines(target, findings)
  checkExports(target, imports, findings)
  checkDeclarations(target, imports, findings, baseline)
  checkSlots(target, findings)
  checkOverlay(target, findings)
  checkSkillOffice(target, findings)
  checkPeers(target, baseline, imports, findings)
  checkServices(target, baseline, findings)
  checkDeps(target, imports, findings)
  checkPayload(target, findings)

  if (options.json) {
    console.log(JSON.stringify({
      target: { mode: target.mode, line: line ?? null, followed: followedSpec() },
      blockers: findings.count('blocker'),
      adapt: findings.count('adapt'),
      notes: findings.count('note'),
      findings: findings.items,
    }, null, 2))
  } else {
    const mode = target.mode === 'dir' ? `checkout ${options.dir}` : target.mode === 'npm' ? `npm ${options.npm}@published` : 'installed line'
    console.log(`kernel-preflight: ${mode} · ${String(imports.size)} packages we import · line ${line ?? 'unknown'} (we follow ${followedSpec()})`)
    for (const severity of ['blocker', 'adapt', 'note']) {
      const items = findings.items.filter((item) => item.severity === severity)
      if (items.length === 0) continue
      console.log(`\n${severity.toUpperCase()} (${String(items.length)})`)
      for (const item of items) {
        console.log(`  [${item.check}] ${item.subject}: ${item.detail}`)
        if (item.action !== undefined) console.log(`      → ${item.action}`)
      }
    }
    console.log(`\nRESULT: ${String(findings.count('blocker'))} blocker(s), ${String(findings.count('adapt'))} to read, ${String(findings.count('note'))} note(s)`)
    if (target.mode === 'installed') {
      console.log('Next: `npm run check:surface -- --used-only` lists what the line added and we do not use yet.')
    }
  }

  process.exitCode = findings.count('blocker') > 0 ? 1 : 0
}

// Running as a program is what produces a report; importing the module (a test,
// a probe) gets the checks without the side effect of printing and exiting.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`kernel-preflight: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  })
}

export {
  ourImports,
  ourSlotIds,
  ourServiceUses,
  ourOverlayRows,
  collectSurface,
  relativeTarget,
  splitSpec,
  compareVersions,
  buildTarget,
  installedTarget,
  checkLine,
  Findings,
}
