// The checks a suite plugin passes before its `lib/` can enter an artifact, and
// the decisions every call site must make identically.
//
// Why the type gate exists: `plugins/build-lib.mjs` bundles with esbuild, which
// does NOT type check, and `scripts/build-runtime.mjs` packs exactly what
// esbuild wrote. A client half that called a function its own module stopped
// exporting therefore type-checked nowhere between an editor and a user:
// esbuild emitted the call, the bundle shipped, and the renderer threw
// `Uncaught ReferenceError: pctAt is not defined` on the first drag —
// read out of the artifact, not out of any log. `plugin-effort`'s slider and
// `geometry.ts` were the pair.
//
// That gate has a PRECONDITION, and the release is the place it was missing: the
// typecheck needs the plugin's own imports to resolve, while both packaging paths
// install a plugin's tree with `--legacy-peer-deps`, which installs NO peer — so a
// gate that ran regardless failed a whole release on
// `error TS2307: Cannot find module '@deepseek-ai/dsh-client-ui-primitives'`
// (a peer fourteen plugins import and only a peer of them). `pluginMissingPeers`
// is that precondition, and a plugin that fails it SKIPS the type gate loudly
// rather than failing it; the artifact checks below do not depend on peers at all
// and keep running.
//
// Why the two artifact checks exist, and why they are two: `lib/` is gitignored,
// so the tree a developer runs and the tree a pack reads are two build products
// from two different moments — and a build that writes nothing ships a package
// whose declared entries are simply absent (npm's `files` field omits a missing
// directory SILENTLY, and this repository has already shipped a suite that was
// missing plugins with every gate green). They answer different questions on
// different sides of the build:
//
//   before the build   — only staleness is decidable: no `lib/` means "never
//                        built", which is not a stale artifact;
//   after the build /  — absence is a failure: whatever the plugin's own manifest
//   before the pack      declares must be there, because the build was just
//                        supposed to write it.
//
// Both call sites run the checks AFTER the plugin's build, so the presence half
// is meaningful there; only a developer's tree can observe the pre-build state.
//
// Every verdict is a decision over a plugin directory, and every call site — the
// local build (`scripts/build-runtime.mjs`), the release pre-pass and the CI gate
// (`.github/workflows/{release,ci}.yml`, through `scripts/plugin-gates.mjs`) —
// must reach the same one, so the verdicts live here and the call sites run them.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Directories under a plugin that can never be an input to its `lib/`.
 *
 * `node_modules` and `.git` are not the plugin's own bytes; `lib`/`dist` are
 * outputs (comparing an output with itself is what makes a walker agree with
 * anything); `.test-dist` is the test harness's own bundle, built from `tests/`.
 */
const NON_INPUT_DIRS = new Set(['node_modules', 'lib', 'dist', '.test-dist', '.git'])

/** Files under a plugin that can never be an input to its `lib/`. */
const NON_INPUT_FILE = /^(?:package-lock\.json|.+\.(?:log|tsbuildinfo))$/u

/** The plugin declares a `typecheck` script — run it. */
export const TYPECHECK_SCRIPT = 'typecheck-script'
/**
 * No `typecheck` script, but the build script invokes `tsc`, which exits
 * non-zero on any type error — the build in the same loop is the type gate.
 * `plugin-brand` is the one plugin of this shape.
 */
export const TYPECHECK_BUILD = 'tsc-build'
/** Neither: nothing on the packaging path can see a type error, so refuse. */
export const TYPECHECK_NONE = 'no-type-gate'

/** `tsc` as a word in a script line, not a substring of a path or a flag value. */
const TSC_IN_SCRIPT = /(?:^|[^\w-])tsc(?:[^\w-]|$)/u

/**
 * Newest mtime in a tree, over the files that are neither an input to `lib/`
 * nor a shipped entry inside it.
 *
 * Symlinks are skipped rather than followed: a link is not a source, and
 * following one could walk into a runtime tree or a package store outside the
 * plugin. Entries are visited in name order so two files sharing an mtime
 * always resolve to the same report.
 *
 * @param dir - absolute directory to walk.
 * @param base - directory `path` values are reported relative to.
 * @returns `{ path, mtimeMs }` with a posix-relative path, or null for a tree
 *   holding no such file at all.
 */
function newestMtime(dir, base) {
  let newest = null
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (NON_INPUT_DIRS.has(entry.name)) continue
      const found = newestMtime(full, base)
      if (found !== null && (newest === null || found.mtimeMs > newest.mtimeMs)) newest = found
      continue
    }
    if (!entry.isFile() || NON_INPUT_FILE.test(entry.name)) continue
    const { mtimeMs } = statSync(full)
    if (newest === null || mtimeMs > newest.mtimeMs) {
      newest = { path: path.relative(base, full).split(path.sep).join('/'), mtimeMs }
    }
  }
  return newest
}

/**
 * Whether a plugin's built `lib/` is older than the newest file that feeds it.
 *
 * The input set is every file under the plugin directory except the directories
 * and files above — `src/**` first of all, plus the plugin's own build recipe
 * (`build.mjs`), its `tsconfig.json` and its `package.json`. That is
 * deliberately wider than "what esbuild read": a file with no effect on the
 * bundle can only ever mark the plugin stale in the one case this gate is for —
 * a build that did not rewrite `lib/` — and refusing there is the right answer
 * (rebuilding is cheap, shipping a `lib/` from another moment is not).
 *
 * A missing `lib/` is NOT stale — "never built" is a different state from "built
 * and outdated" — so this is the BEFORE-THE-BUILD half of the timeline in the
 * module header. The build that follows writes it, and `pluginOutputGap` is what
 * refuses its absence once that build has run. A pack with no `lib/` fails on its
 * own, on the plugin's `files` field.
 *
 * The comparison is strictly newer, so a filesystem whose mtimes tie (a coarse
 * timestamp resolution, a source edited and rebuilt inside one tick) reads as
 * fresh rather than refusing a build that just succeeded.
 *
 * @param pluginDir - absolute path of a plugin directory.
 * @returns `{ stale, newestInput, libMtime }`; each of `newestInput`/`libMtime`
 *   is `{ path, mtimeMs }` (posix-relative to the plugin) or null.
 */
export function pluginLibStaleness(pluginDir) {
  const libDir = path.join(pluginDir, 'lib')
  const libMtime = !existsSync(libDir)
    ? null
    : statSync(libDir).isDirectory()
      ? newestMtime(libDir, pluginDir)
      : { path: 'lib', mtimeMs: statSync(libDir).mtimeMs }
  const newestInput = newestMtime(pluginDir, pluginDir)
  const stale = libMtime !== null && newestInput !== null && newestInput.mtimeMs > libMtime.mtimeMs
  return { stale, newestInput, libMtime }
}

/**
 * Refuse a `lib/` older than the plugin's own inputs.
 *
 * @param pluginDir - absolute path of a plugin directory.
 * @throws {Error} naming the plugin and the offending file.
 */
export function assertPluginLibFresh(pluginDir) {
  const { stale, newestInput, libMtime } = pluginLibStaleness(pluginDir)
  if (!stale) return
  throw new Error(
    `[plugin-gate] ${path.basename(pluginDir)}: lib/ is older than its own input — refusing to pack it. `
    + `Newest input ${newestInput.path} (${new Date(newestInput.mtimeMs).toISOString()}), `
    + `newest lib/ entry ${libMtime.path} (${new Date(libMtime.mtimeMs).toISOString()}). `
    + `The build did not refresh lib/ — build the plugin (plugins/${path.basename(pluginDir)}: npm run build) before packing it.`,
  )
}

/** The output root a plugin's manifest always names: everything else is a source resource. */
const LIB_ENTRY = /^lib(?:\/|$)/u

/**
 * Relative posix paths of every regular file under `dir`.
 *
 * A deliberately different walk from `newestMtime`: that one filters what can
 * feed `lib/` (a lockfile is not a source), while this one records what `lib/`
 * actually holds, so nothing is filtered here but symlinks — a link is not a
 * build output, and following one could read another tree entirely.
 *
 * @param dir - absolute directory to walk.
 * @param base - directory `path` values are reported relative to.
 * @returns every regular file below `dir`, posix-relative to `base`.
 */
function collectFiles(dir, base) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...collectFiles(full, base))
      continue
    }
    if (entry.isFile()) found.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return found
}

/**
 * Whether one file path matches one npm `files` pattern.
 *
 * `*` stays inside a segment, `**` crosses segments (and may match none of
 * them), everything else is literal. Only the shapes a plugin's `files` field
 * actually uses need to work; the point of reading the entry as written is that
 * a pattern nobody anticipated still means "at least one file matches".
 *
 * @param pattern - the entry, posix, relative to the plugin directory.
 * @param file - a posix path from collectFiles.
 * @returns true when the pattern matches that exact path.
 */
function globMatches(pattern, file) {
  const source = pattern
    .split('/')
    .map((segment) => (segment === '**' ? '.*' : segment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\\\*/gu, '[^/]*')))
    .join('/')
    .replace(/\.\*\//gu, '(?:.*/)?')
  return new RegExp(`^${source}$`, 'u').test(file)
}

/**
 * The build outputs a plugin's own manifest promises, in declaration order.
 *
 * Two declarations are read, both of them the plugin's own:
 *
 *   - `files`, the publish contract npm itself reads. Only the entries naming
 *     `lib` are outputs — `locale/*.json`, `cordis.patch.yml`, `assets`,
 *     `templates` and `icon.svg` in this suite are SOURCE resources that npm
 *     copies from the checkout; whether they exist is a different question, and
 *     `build-runtime.mjs` already warns about a declared resource an `npm pack`
 *     did not carry. A `!` negation can only ever remove an entry, so ignoring
 *     negations under-requires and never refuses a plugin wrongly.
 *   - `main` and the `exports` targets that live under `lib/` — the paths npm and
 *     the dsh loader resolve at LOAD time. Their `types` targets are deliberately
 *     NOT outputs: the seventeen esbuild plugins emit no `.d.ts`, so requiring
 *     them would refuse the whole suite over a pre-existing omission.
 *
 * The entry `lib` is a directory (it must exist and hold a file); `lib/x.js` is
 * a file; a pattern is satisfied by at least one match.
 *
 * @param pluginDir - absolute path of a plugin directory.
 * @returns `[{ path, kind, declaredBy }]`, deduplicated by path — `kind` is
 *   `dir` / `file` / `glob`, `declaredBy` names the field that asked for it.
 */
export function pluginDeclaredOutputs(pluginDir) {
  const manifestPath = path.join(pluginDir, 'package.json')
  if (!existsSync(manifestPath)) return []
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const declared = []
  const declare = (entry, kind, declaredBy) => {
    const normalized = entry.replace(/^\.\//u, '')
    if (!LIB_ENTRY.test(normalized) || declared.some((output) => output.path === normalized)) return
    declared.push({ path: normalized, kind, declaredBy })
  }
  for (const entry of manifest.files ?? []) {
    if (typeof entry !== 'string' || entry.startsWith('!')) continue
    const normalized = entry.replace(/^\.\//u, '')
    declare(normalized, normalized.includes('*') ? 'glob' : normalized === 'lib' ? 'dir' : 'file', 'files')
  }
  const targets = []
  if (typeof manifest.main === 'string') targets.push(['main', manifest.main])
  for (const [key, value] of Object.entries(manifest.exports ?? {})) {
    if (typeof value === 'string') targets.push([`exports["${key}"]`, value])
    else if (value !== null && typeof value === 'object') {
      for (const [condition, target] of Object.entries(value)) {
        if (condition === 'types' || typeof target !== 'string') continue
        targets.push([`exports["${key}"].${condition}`, target])
      }
    }
  }
  for (const [declaredBy, target] of targets) {
    if (target.includes('*')) continue
    declare(target, 'file', declaredBy)
  }
  return declared
}

/**
 * Which declared build outputs a plugin's `lib/` does not hold.
 *
 * The AFTER-THE-BUILD half of the timeline in the module header: `lib/` missing
 * or empty, or a declared entry absent, means the build did not write what the
 * plugin's manifest says it ships (npm omits a missing directory from the
 * tarball silently, so nothing downstream would say so). `missing` is empty for
 * a plugin that declares no `lib` output at all — a host-only shape with its
 * entry elsewhere is then judged by nothing here, not refused by accident.
 *
 * @param pluginDir - absolute path of a plugin directory.
 * @returns `{ declared, missing, libExists, libFiles }` — the declarations, the
 *   absent ones, and what `lib/` actually holds (files counted recursively,
 *   symlinks skipped).
 */
export function pluginOutputGap(pluginDir) {
  const declared = pluginDeclaredOutputs(pluginDir)
  const libDir = path.join(pluginDir, 'lib')
  const libExists = existsSync(libDir)
  const files = libExists && statSync(libDir).isDirectory() ? collectFiles(libDir, pluginDir) : []
  const missing = declared.filter((output) => {
    if (output.kind === 'dir') return files.length === 0
    if (output.kind === 'glob') return !files.some((file) => globMatches(output.path, file))
    const full = path.join(pluginDir, output.path)
    return !existsSync(full) || !statSync(full).isFile()
  })
  return { declared, missing, libExists, libFiles: files.length }
}

/**
 * Refuse a plugin whose build did not produce what its manifest declares.
 *
 * @param pluginDir - absolute path of a plugin directory.
 * @returns the gap report, for a caller that wants to log what was found.
 * @throws {Error} naming the plugin, the absent artifact and the field that
 *   declared it.
 */
export function assertPluginOutputs(pluginDir) {
  const gap = pluginOutputGap(pluginDir)
  if (gap.missing.length === 0) return gap
  const expected = gap.missing.map((output) => `${output.path} (declared by ${output.declaredBy})`).join(', ')
  throw new Error(
    `[plugin-gate] ${path.basename(pluginDir)}: the build produced no declared output — refusing to pack it. `
    + `Missing: ${expected}. lib/ holds ${gap.libFiles} file(s). `
    + `The plugin's build wrote nothing for these (npm omits a missing directory silently) — `
    + `build it (plugins/${path.basename(pluginDir)}: npm run build) before packing it.`,
  )
}

/**
 * Which of a plugin's declared peers nothing on its resolution path provides.
 *
 * The `typecheck` script is the ONLY check that needs them: esbuild bundles with
 * every `@deepseek-ai/*` import marked external, so a missing peer costs nothing
 * until tsc tries to read its types. Both packaging paths install a plugin's tree
 * with `npm install --legacy-peer-deps`, which installs NO peer at all — on a CI
 * tree fifteen of the eighteen plugins import a peer that is therefore absent
 * (`@deepseek-ai/dsh-client-ui-primitives` in fourteen of them, `react` in most),
 * and a gate that ran anyway failed the whole release with
 * `error TS2307: Cannot find module '@deepseek-ai/dsh-client-ui-primitives'`.
 * The set is the plugin's own declaration, never a list kept here: a peer added to
 * a plugin is covered the day it is written.
 *
 * Resolution follows node's own chain — the plugin directory, then each ancestor,
 * so a package the ROOT tree provides (`@deepseek-ai/dsh`) counts, and one only a
 * sibling plugin has does not. A package is present only if it carries a
 * `package.json`: an empty directory left by an interrupted install is not a
 * resolution. `peerDependenciesMeta[…].optional` peers are skipped — an optional
 * peer is exactly one that may legitimately be absent.
 *
 * Deliberately a TYPE question: a peer also counts as resolvable through
 * `@types/<its DefinitelyTyped name>`, because that is what tsc reads for an
 * import whose package is absent. Measured on this repository's own tree, fifteen
 * of the eighteen plugins resolve `react` from `@types/react` alone, so a
 * package-only reading would have skipped the gate on fifteen plugins locally —
 * the place where the gate is actually run — and left it with no teeth at all.
 * The remaining conservatism: a plugin whose types would resolve through some
 * OTHER mechanism is still skipped, and skipping is the safe direction — a skipped
 * gate leaves a release runnable, a gate that fails on an import nobody installed
 * stops it (`TS2307`, release run 38377277084).
 *
 * @param pluginDir - absolute path of a plugin directory.
 * @returns the missing peer names, sorted; empty when the gate may run.
 */
export function pluginMissingPeers(pluginDir) {
  const manifestPath = path.join(pluginDir, 'package.json')
  if (!existsSync(manifestPath)) return []
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const optional = manifest.peerDependenciesMeta ?? {}
  return Object.keys(manifest.peerDependencies ?? {})
    .filter((name) => optional[name]?.optional !== true)
    .filter((name) => !resolvesFrom(pluginDir, name))
    .sort()
}

/**
 * The DefinitelyTyped package a name's types would come from.
 *
 * `@types/react` for `react`; `@types/scope__pkg` for `@scope/pkg`, which is the
 * name DefinitelyTyped actually publishes.
 */
function typesPackageFor(name) {
  if (!name.startsWith('@')) return `@types/${name}`
  const [scope, rest] = name.split('/')
  return `@types/${scope.slice(1)}__${rest}`
}

/** Whether `name`, or the `@types` package tsc would read for it, resolves from `dir`. */
function resolvesFrom(dir, name) {
  const lookups = [name, typesPackageFor(name)]
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    for (const lookup of lookups) {
      if (existsSync(path.join(current, 'node_modules', lookup, 'package.json'))) return true
    }
    const parent = path.dirname(current)
    if (parent === current) return false
  }
}

/**
 * The one line that must accompany a run in which plugins skipped the type gate.
 *
 * Its whole point is that a green build log cannot be read as "every plugin's
 * types were checked": the skip is a decision, and this is the count that says how
 * much of the run it covered. Both call sites print it whether or not anything was
 * skipped — `0 of 18` is the sentence that means the gate really ran everywhere.
 *
 * @param total - plugins the run covered.
 * @param skipped - how many of them skipped the type gate.
 * @returns the log line, prefixed like every other verdict.
 */
export function typecheckSkipSummary(total, skipped) {
  if (skipped === 0) {
    return `[plugin-gate] type gate: 0 of ${total} plugins skipped it (their declared peers resolve here — every plugin was checked)`
  }
  return `[plugin-gate] type gate: ${skipped} of ${total} plugins skipped it (their declared peers are not installed here — `
    + 'this run vouches for their outputs, not for their types)'
}

/**
 * Which type gate a plugin has, read from its own `package.json`.
 *
 * @param pluginDir - absolute path of a plugin directory.
 * @returns `{ kind, script }` — one of TYPECHECK_SCRIPT / TYPECHECK_BUILD /
 *   TYPECHECK_NONE, with the script line the decision came from (or null).
 */
export function pluginTypecheckPlan(pluginDir) {
  const manifestPath = path.join(pluginDir, 'package.json')
  if (!existsSync(manifestPath)) return { kind: TYPECHECK_NONE, script: null }
  const scripts = JSON.parse(readFileSync(manifestPath, 'utf8')).scripts ?? {}
  if (typeof scripts.typecheck === 'string' && scripts.typecheck.trim() !== '') {
    return { kind: TYPECHECK_SCRIPT, script: scripts.typecheck }
  }
  if (typeof scripts.build === 'string' && TSC_IN_SCRIPT.test(scripts.build)) {
    return { kind: TYPECHECK_BUILD, script: scripts.build }
  }
  return { kind: TYPECHECK_NONE, script: null }
}

/**
 * Run a plugin's type gate through a caller-supplied npm.
 *
 * The runner is injected because the two call sites already own their child
 * process handling (build-runtime resolves an absolute npm and logs redacted
 * command lines; the CLI has no build log to join), and because a test can then
 * assert the policy without spawning anything.
 *
 * A plugin with neither a `typecheck` script nor a `tsc` build is REFUSED, not
 * skipped: silently passing is the exact shape of the failure this gate exists
 * to remove, and a plugin that reaches this point has no other check on the
 * packaging path.
 *
 * A plugin of which that is not true still SKIPS when its declared peers are
 * missing, because tsc would fail on an import the install never provided
 * (`pluginMissingPeers`) — and the skip is LOUD, never silent: a caller that
 * swallowed it would turn "nothing could check these types here" into "they
 * passed". Both call sites also print `typecheckSkipSummary` once per run, so the
 * count is in the log either way.
 *
 * @param pluginDir - absolute path of a plugin directory.
 * @param options.runNpm - `(args, cwd) => void`; must throw on a non-zero exit.
 * @param options.log - one-line sink for the decisions (default `console.log`).
 * @returns `{ kind, script, skipped, missing }` — `skipped` true means the gate
 *   did NOT run and `missing` holds the peers that stopped it.
 * @throws {Error} when the plugin has no type gate at all, is not installed, or
 *   its typecheck fails.
 */
export function runPluginTypecheck(pluginDir, { runNpm, log = console.log }) {
  const dirName = path.basename(pluginDir)
  const plan = pluginTypecheckPlan(pluginDir)
  if (plan.kind === TYPECHECK_BUILD) {
    log(`[plugin-gate] ${dirName}: no typecheck script; its build is tsc (${plan.script}), which type-checks as it compiles`)
    return { ...plan, skipped: false, missing: [] }
  }
  if (plan.kind === TYPECHECK_NONE) {
    throw new Error(
      `[plugin-gate] ${dirName} has neither a "typecheck" script nor a tsc build — nothing on the packaging path could see a type error. `
      + `Add "typecheck": "tsc --noEmit" to plugins/${dirName}/package.json.`,
    )
  }
  if (!existsSync(path.join(pluginDir, 'node_modules'))) {
    throw new Error(
      `[plugin-gate] ${dirName} has no node_modules, so tsc cannot resolve its imports — `
      + `run (cd plugins/${dirName} && npm install --legacy-peer-deps) first.`,
    )
  }
  const missing = pluginMissingPeers(pluginDir)
  if (missing.length > 0) {
    log(
      `[plugin-gate] ${dirName}: type gate SKIPPED — its declared peers are not installed here `
      + `(missing: ${missing.join(', ')}); npm --legacy-peer-deps omits them. `
      + 'The output and freshness checks still ran.',
    )
    return { ...plan, skipped: true, missing }
  }
  runNpm(['run', 'typecheck'], pluginDir)
  return { ...plan, skipped: false, missing: [] }
}
