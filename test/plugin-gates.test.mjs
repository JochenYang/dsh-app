// The two plugin packaging gates: the type gate, and the `lib/` freshness gate.
//
// What this suite is here for: `plugins/build-lib.mjs` bundles with esbuild,
// which does not type check, and `scripts/build-runtime.mjs` packs whatever
// esbuild wrote. A client half calling a function its own module stopped
// exporting (`plugin-effort`'s slider and `geometry.ts`) therefore shipped and
// threw `ReferenceError` in the renderer — and `lib/` is gitignored, so the tree
// a pack reads and the tree a developer runs are two build products from two
// moments. The gates live in `scripts/lib/plugin-gates.mjs`; this file pins
// their decisions and the two call sites that must keep running them.
//
// Everything here is built from fixtures with explicit mtimes: a test that slept
// for a filesystem timestamp would be slow and still flaky on a coarse clock.
// `utimesSync` takes seconds, so the timestamps are whole seconds.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertPluginLibFresh,
  assertPluginOutputs,
  pluginDeclaredOutputs,
  pluginLibStaleness,
  pluginOutputGap,
  pluginTypecheckPlan,
  runPluginTypecheck,
  TYPECHECK_BUILD,
  TYPECHECK_NONE,
  TYPECHECK_SCRIPT,
} from '../scripts/lib/plugin-gates.mjs'
import { scratchDir } from './scratch.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Whole-second base for the fixtures; every mtime is an offset from it. */
const BASE = Date.UTC(2026, 0, 1) / 1000

/**
 * A plugin-shaped fixture directory.
 *
 * @param files - `{ 'src/client.ts': [content, 'seconds since BASE'] }`; the
 *   mtime is applied only when given, so a file can be left at "now".
 * @returns the created directory.
 */
function fixture(files) {
  const dir = scratchDir('dsh-plugin-gates-')
  for (const [relative, value] of Object.entries(files)) {
    const [content, offset] = Array.isArray(value) ? value : [value, undefined]
    const full = path.join(dir, ...relative.split('/'))
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content)
    if (offset !== undefined) utimesSync(full, BASE + offset, BASE + offset)
  }
  return dir
}

/** The `exports` block every dual-half suite plugin declares, types targets included. */
const DUAL_EXPORTS = {
  '.': { types: './lib/index.d.ts', default: './lib/index.js' },
  './client': { types: './lib/client.d.ts', default: './lib/client.js' },
  './package.json': './package.json',
}

/**
 * A plugin manifest carrying the fields the presence cases turn on.
 *
 * @param fields - `{ files, main, exports }`, each omitted when not given.
 * @returns the manifest's JSON text.
 */
function manifestJson({ files, main, exports } = {}) {
  return JSON.stringify({
    name: '@dsh-app/plugin-fixture',
    version: '0.0.1',
    type: 'module',
    ...(files === undefined ? {} : { files }),
    ...(main === undefined ? {} : { main }),
    ...(exports === undefined ? {} : { exports }),
  })
}

test('pluginLibStaleness calls a lib/ older than its source stale, and names both', () => {
  const dir = fixture({
    'src/client/slider.tsx': ['export const level = 1\n', 200],
    'src/client/geometry.ts': ['export const pctAt = () => 0\n', 150],
    'lib/client.js': ['var client = {};\n', 100],
  })
  const { stale, newestInput, libMtime } = pluginLibStaleness(dir)
  assert.equal(stale, true)
  // The newest input is what a reader needs: the file the lib/ predates.
  assert.equal(newestInput.path, 'src/client/slider.tsx')
  assert.equal(newestInput.mtimeMs, (BASE + 200) * 1000)
  assert.equal(libMtime.path, 'lib/client.js')
})

test('pluginLibStaleness calls a lib/ newer than every source fresh', () => {
  const dir = fixture({
    'src/client/slider.tsx': ['export const level = 1\n', 100],
    'lib/client.js': ['var client = {};\n', 200],
  })
  assert.equal(pluginLibStaleness(dir).stale, false)
})

test('a tie is NOT stale: a coarse clock or a one-tick rebuild must not refuse a fresh build', () => {
  const dir = fixture({
    'src/index.ts': ['export const a = 1\n', 100],
    'lib/index.js': ['export const a = 1;\n', 100],
  })
  assert.equal(pluginLibStaleness(dir).stale, false)
})

test('the input walk ignores what cannot reach lib/, however new it is', () => {
  const dir = fixture({
    'src/index.ts': ['export const a = 1\n', 100],
    'lib/index.js': ['export const a = 1;\n', 200],
    // Every one of these is newer than lib/, and none of them is an input.
    'node_modules/@dsh-app/dep/index.js': ['x\n', 900],
    '.test-dist/tests/index.test.js': ['x\n', 900],
    'dist/index.js': ['x\n', 900],
    'package-lock.json': ['{}\n', 900],
  })
  const { stale, newestInput } = pluginLibStaleness(dir)
  assert.equal(stale, false)
  assert.equal(newestInput.path, 'src/index.ts')
})

test('a plugin whose sources are newer than lib/ is stale even with a node_modules tree present', () => {
  const dir = fixture({
    'src/client.ts': ['export const a = 1\n', 900],
    'lib/client.js': ['var a = 1;\n', 100],
    'node_modules/dep/index.js': ['x\n', 950],
  })
  const { stale, newestInput } = pluginLibStaleness(dir)
  assert.equal(stale, true)
  assert.equal(newestInput.path, 'src/client.ts')
})

test('an unbuilt plugin (no lib/) is not stale', () => {
  const dir = fixture({ 'src/index.ts': ['export const a = 1\n', 100] })
  const { stale, libMtime } = pluginLibStaleness(dir)
  assert.equal(stale, false)
  assert.equal(libMtime, null)
})

test('assertPluginLibFresh refuses a stale lib/ and names the plugin and the file', () => {
  const dir = fixture({
    'src/client/slider.tsx': ['export const level = 1\n', 200],
    'lib/client.js': ['var client = {};\n', 100],
  })
  assert.throws(
    () => assertPluginLibFresh(dir),
    new RegExp(`${path.basename(dir)}: lib/ is older than its own input.*src/client/slider\\.tsx.*lib/client\\.js`, 'su'),
  )
  const fresh = fixture({
    'src/index.ts': ['export const a = 1\n', 100],
    'lib/index.js': ['export const a = 1;\n', 200],
  })
  assert.doesNotThrow(() => assertPluginLibFresh(fresh))
})

// ------------------------------------------- build outputs (after the build)

test('pluginDeclaredOutputs reads files, main and exports — and never a types target', () => {
  const dir = fixture({
    'package.json': manifestJson({
      files: ['lib', 'cordis.patch.yml', 'locale/*.json', 'icon.svg'],
      main: 'lib/index.js',
      exports: DUAL_EXPORTS,
    }),
  })
  // The `types` targets are absent on purpose: the seventeen esbuild plugins emit
  // no `.d.ts`, so requiring them would refuse the suite it is meant to protect.
  // Non-`lib` entries (a patch file, locale JSON, an icon) are source resources.
  assert.deepEqual(pluginDeclaredOutputs(dir), [
    { path: 'lib', kind: 'dir', declaredBy: 'files' },
    { path: 'lib/index.js', kind: 'file', declaredBy: 'main' },
    { path: 'lib/client.js', kind: 'file', declaredBy: 'exports["./client"].default' },
  ])
  assert.deepEqual(pluginDeclaredOutputs(fixture({ 'package.json': manifestJson({ files: ['cordis.patch.yml', 'locale/*.json'] }) })), [])
})

test('a missing lib/ is an ABSENT output after the build, not a stale one before it', () => {
  const dir = fixture({
    'package.json': manifestJson({ files: ['lib'], main: 'lib/index.js' }),
    'src/index.ts': ['export const a = 1\n', 100],
  })
  // Same tree, both sides of the timeline: nothing has been built, so there is
  // no stale artifact — and there IS a missing one.
  assert.equal(pluginLibStaleness(dir).stale, false)
  const gap = pluginOutputGap(dir)
  assert.equal(gap.libExists, false)
  assert.equal(gap.libFiles, 0)
  assert.deepEqual(gap.missing.map((output) => output.path), ['lib', 'lib/index.js'])
  assert.throws(
    () => assertPluginOutputs(dir),
    new RegExp(`${path.basename(dir)}: the build produced no declared output.*lib/index\\.js \\(declared by main\\).*lib/ holds 0 file`, 'su'),
  )
})

test('an empty lib/ and a lib/ holding only empty directories are both absent outputs', () => {
  const empty = fixture({ 'package.json': manifestJson({ files: ['lib'] }) })
  mkdirSync(path.join(empty, 'lib'))
  assert.deepEqual(pluginOutputGap(empty).missing.map((output) => output.path), ['lib'])
  assert.equal(pluginOutputGap(empty).libFiles, 0)
  assert.throws(() => assertPluginOutputs(empty), /lib\/ holds 0 file\(s\)/su)

  const hollow = fixture({ 'package.json': manifestJson({ files: ['lib'] }) })
  mkdirSync(path.join(hollow, 'lib', 'nested'), { recursive: true })
  assert.equal(pluginOutputGap(hollow).libExists, true)
  assert.deepEqual(pluginOutputGap(hollow).missing.map((output) => output.path), ['lib'])
})

test('an absent declared entry is named with the field that declared it', () => {
  // The half-built plugin: the host half emitted, the client half did not — the
  // shape that ships a suite row with nothing behind it.
  const dir = fixture({
    'package.json': manifestJson({ files: ['lib'], main: 'lib/index.js', exports: DUAL_EXPORTS }),
    'lib/index.js': 'module.exports = {}\n',
  })
  assert.deepEqual(pluginOutputGap(dir).missing.map((output) => output.path), ['lib/client.js'])
  assert.throws(
    () => assertPluginOutputs(dir),
    /lib\/client\.js \(declared by exports\["\.\/client"\]\.default\)/su,
  )
})

test('a build that emits the declared entries passes, globs included', () => {
  const dir = fixture({
    'package.json': manifestJson({ files: ['lib', 'lib/*.js'], main: 'lib/index.js', exports: DUAL_EXPORTS }),
    'lib/index.js': 'a\n',
    'lib/client.js': 'b\n',
  })
  const gap = pluginOutputGap(dir)
  assert.equal(gap.libFiles, 2)
  assert.deepEqual(gap.missing, [])
  assert.doesNotThrow(() => assertPluginOutputs(dir))

  // A glob entry with nothing matching it is missing; a sibling entry that the
  // pattern does not cover does not stand in for it.
  const unmatched = fixture({
    'package.json': manifestJson({ files: ['lib/*.js'] }),
    'lib/index.cjs': 'a\n',
  })
  assert.deepEqual(pluginOutputGap(unmatched).missing.map((output) => output.path), ['lib/*.js'])

  // The two glob shapes the reader documents: `*` stops at a segment boundary,
  // `**` crosses one (including none of them).
  const deep = fixture({ 'package.json': manifestJson({ files: ['lib/**/*.js'] }), 'lib/nested/a.js': 'a\n' })
  assert.deepEqual(pluginOutputGap(deep).missing, [])
  const shallow = fixture({ 'package.json': manifestJson({ files: ['lib/**/*.js'] }), 'lib/a.js': 'a\n' })
  assert.deepEqual(pluginOutputGap(shallow).missing, [])
  const wrongDepth = fixture({ 'package.json': manifestJson({ files: ['lib/*.js'] }), 'lib/nested/a.js': 'a\n' })
  assert.deepEqual(pluginOutputGap(wrongDepth).missing.map((output) => output.path), ['lib/*.js'])
})

test('pluginTypecheckPlan reads the plugin\'s own scripts', () => {
  assert.deepEqual(
    pluginTypecheckPlan(fixture({ 'package.json': JSON.stringify({ scripts: { build: 'node build.mjs', typecheck: 'tsc --noEmit' } }) })),
    { kind: TYPECHECK_SCRIPT, script: 'tsc --noEmit' },
  )
  // plugin-brand's shape: the build IS tsc, so the build in the same loop gates.
  assert.deepEqual(
    pluginTypecheckPlan(fixture({ 'package.json': JSON.stringify({ scripts: { build: 'tsc -p tsconfig.json' } }) })),
    { kind: TYPECHECK_BUILD, script: 'tsc -p tsconfig.json' },
  )
  // An esbuild build with no typecheck script has no gate at all.
  assert.deepEqual(
    pluginTypecheckPlan(fixture({ 'package.json': JSON.stringify({ scripts: { build: 'node build.mjs' } }) })),
    { kind: TYPECHECK_NONE, script: null },
  )
  assert.deepEqual(pluginTypecheckPlan(fixture({ 'src/index.ts': 'x\n' })), { kind: TYPECHECK_NONE, script: null })
})

test('runPluginTypecheck runs the declared script in the plugin directory', () => {
  const dir = fixture({
    'package.json': JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
    'node_modules/.keep': 'x\n',
  })
  const calls = []
  const plan = runPluginTypecheck(dir, { runNpm: (args, cwd) => calls.push([args, cwd]), log: () => {} })
  assert.equal(plan.kind, TYPECHECK_SCRIPT)
  assert.deepEqual(calls, [[['run', 'typecheck'], dir]])
})

test('runPluginTypecheck leaves a tsc build alone and refuses a plugin with no gate', () => {
  const brandShape = fixture({
    'package.json': JSON.stringify({ scripts: { build: 'tsc -p tsconfig.json' } }),
  })
  const calls = []
  const lines = []
  assert.equal(
    runPluginTypecheck(brandShape, { runNpm: (args) => calls.push(args), log: (line) => lines.push(line) }).kind,
    TYPECHECK_BUILD,
  )
  assert.deepEqual(calls, [])
  assert.match(lines.join('\n'), /no typecheck script; its build is tsc/)

  const bare = fixture({ 'package.json': JSON.stringify({ scripts: { build: 'node build.mjs' } }) })
  assert.throws(
    () => runPluginTypecheck(bare, { runNpm: () => {}, log: () => {} }),
    /nothing on the packaging path could see a type error.*Add "typecheck": "tsc --noEmit"/su,
  )
})

test('runPluginTypecheck refuses an uninstalled plugin with the command that fixes it', () => {
  const dir = fixture({ 'package.json': JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }) })
  assert.throws(
    () => runPluginTypecheck(dir, { runNpm: () => {}, log: () => {} }),
    /no node_modules.*npm install --legacy-peer-deps/su,
  )
})

test('the walker reads a real plugin directory and keeps out of lib/ and node_modules', () => {
  const pluginsRoot = path.join(ROOT, 'plugins')
  const names = readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('plugin-'))
    .map((entry) => entry.name)
  assert.ok(names.length >= 18, `the suite has ${names.length} plugin directories, expected at least 18`)
  for (const name of names) {
    const { newestInput, libMtime } = pluginLibStaleness(path.join(pluginsRoot, name))
    // A plugin always has sources; the newest one is never an output or a
    // dependency (both would make the report name a file nobody edited).
    assert.ok(newestInput !== null, `${name}: the input walk found nothing`)
    assert.ok(!newestInput.path.startsWith('lib/'), `${name}: the newest input is a build output: ${newestInput.path}`)
    assert.ok(!newestInput.path.startsWith('node_modules/'), `${name}: the newest input is a dependency: ${newestInput.path}`)
    // A tree with no built lib/ (a fresh checkout, before the CI build step) is a
    // valid state and exercises only the input half; the lib/ half is covered by
    // the fixtures above.
    if (libMtime !== null) {
      assert.ok(libMtime.path.startsWith('lib/'), `${name}: lib entry is outside lib/: ${libMtime.path}`)
      // Every BUILT plugin of the real suite must hold what its own manifest
      // declares — the check that reads the 18 real `files`/`main`/`exports`
      // declarations rather than a fixture of them.
      assert.doesNotThrow(
        () => assertPluginOutputs(path.join(pluginsRoot, name)),
        `${name}: a built plugin is missing a declared output (scripts/lib/plugin-gates.mjs refuses this on the packaging path)`,
      )
    }
  }
})

test('every call site that builds or packs a plugin runs the shared gates', () => {
  // A gate nothing calls is green forever. Each file below is read as TEXT —
  // running a workflow is not this suite's job — and each is a place a plugin
  // can be built, packed, or merged without otherwise being type-checked.
  const build = readFileSync(path.join(ROOT, 'scripts', 'build-runtime.mjs'), 'utf8')
  assert.match(build, /from '\.\/lib\/plugin-gates\.mjs'/)
  // All three judgements, in this file: the local `runtime:build` loop is where
  // a suite missing whole plugins would be packed, so it cannot run a subset.
  assert.match(build, /runPluginTypecheck\(/)
  assert.match(build, /assertPluginOutputs\(/)
  assert.match(build, /assertPluginLibFresh\(/)
  // The presence check is the one that must sit after the build, not before it.
  // `\r?\n` on purpose: a Windows checkout with core.autocrlf has CRLF here, and
  // an assertion that only matches LF would go red for a line ending rather than
  // for the order it is about.
  assert.match(build, /run\(npmBin\(\), \['run', 'build'\], pluginDir\)\r?\n\s*assertPluginOutputs\(pluginDir\)/u)

  const release = readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8')
  assert.match(release, /node \.\.\/scripts\/plugin-gates\.mjs/)

  // The PR gate. This is the one call site whose teeth are the TYPE gate and the
  // presence check: a clean checkout has no lib/ at all, so the freshness half
  // passes by construction and only guards a tree that was already built. The
  // `"$dir"` argument pins the call inside the per-plugin loop (`$dir` exists
  // only there), so the gate cannot be moved out of the loop that builds.
  const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.match(ci, /for dir in plugins\/\*\/; do/u)
  assert.match(ci, /node scripts\/plugin-gates\.mjs "\$dir"/u)
})
