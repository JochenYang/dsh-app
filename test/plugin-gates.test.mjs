// The plugin packaging gates: the type gate, the import gate, and the `lib/`
// freshness gate.
//
// What this suite is here for: `plugins/build-lib.mjs` bundles with esbuild,
// which does not type check and resolves no EXTERNAL specifier (`@deepseek-ai/*`,
// react, react-dom), and `scripts/build-runtime.mjs` packs whatever esbuild
// wrote. A client half calling a function its own module stopped exporting
// (`plugin-effort`'s slider and `geometry.ts`) therefore shipped and threw
// `ReferenceError` in the renderer — and `lib/` is gitignored, so the tree a pack
// reads and the tree a developer runs are two build products from two moments.
// The gates live in `scripts/lib/plugin-gates.mjs` and
// `scripts/lib/plugin-imports.mjs`; this file pins their decisions and the call
// sites that must keep running them.
//
// Everything here is built from fixtures with explicit mtimes: a test that slept
// for a filesystem timestamp would be slow and still flaky on a coarse clock.
// `utimesSync` takes seconds, so the timestamps are whole seconds.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertPluginImports,
  explainSpecifier,
  importGateSummary,
  importSpecifiers,
  packageNameOf,
  pluginImportGaps,
} from '../scripts/lib/plugin-imports.mjs'
import { SUITE_PLUGINS } from '../scripts/kernel-line.mjs'
import {
  assertPluginLibFresh,
  assertPluginOutputs,
  pluginDeclaredOutputs,
  pluginLibStaleness,
  pluginMissingPeers,
  pluginOutputGap,
  pluginTypecheckPlan,
  runPluginTypecheck,
  typecheckSkipSummary,
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

// ------------------------------------- the type gate's precondition (peers)

/** A plugin fixture that declares `peers` and has the given packages installed. */
function peerFixture({ peers, optional = [], installed = [] }) {
  return fixture({
    'package.json': JSON.stringify({
      scripts: { typecheck: 'tsc --noEmit' },
      peerDependencies: Object.fromEntries(peers.map((name) => [name, '^1.0.0'])),
      ...(optional.length === 0 ? {} : { peerDependenciesMeta: Object.fromEntries(optional.map((name) => [name, { optional: true }])) }),
    }),
    'node_modules/.keep': 'x\n',
    ...Object.fromEntries(installed.map((name) => [`node_modules/${name}/package.json`, `{"name":"${name}"}\n`])),
  })
}

test('pluginMissingPeers reads the plugin\'s own declaration, and a @types package counts', () => {
  // Absent anything: every declared peer is missing, named as declared.
  assert.deepEqual(
    pluginMissingPeers(peerFixture({ peers: ['react', '@deepseek-ai/dsh-client-ui-primitives'] })),
    ['@deepseek-ai/dsh-client-ui-primitives', 'react'],
  )
  // Installed as itself.
  assert.deepEqual(pluginMissingPeers(peerFixture({ peers: ['react'], installed: ['react'] })), [])
  // Installed only as its types — what tsc actually reads, and what this
  // repository's own tree looks like for `react` in fifteen plugins.
  assert.deepEqual(pluginMissingPeers(peerFixture({ peers: ['react'], installed: ['@types/react'] })), [])
  // The DefinitelyTyped name for a scoped package is `@types/scope__pkg`.
  assert.deepEqual(pluginMissingPeers(peerFixture({ peers: ['@scope/pkg'], installed: ['@types/scope__pkg'] })), [])
  // An optional peer may legitimately be absent.
  assert.deepEqual(pluginMissingPeers(peerFixture({ peers: ['react'], optional: ['react'] })), [])
})

test('a peer resolves through an ancestor\'s node_modules, and only as a real package', () => {
  // The shape both call sites rely on: the ROOT tree carries the kernel packages
  // while the plugin's own tree carries none of them.
  const root = fixture({ 'node_modules/@deepseek-ai/dsh/package.json': '{"name":"@deepseek-ai/dsh"}\n' })
  const plugin = path.join(root, 'plugins', 'plugin-x')
  mkdirSync(plugin, { recursive: true })
  writeFileSync(
    path.join(plugin, 'package.json'),
    JSON.stringify({ peerDependencies: { '@deepseek-ai/dsh': '^1.0.0', react: '^18.0.0' } }),
  )
  assert.deepEqual(pluginMissingPeers(plugin), ['react'])
  // An empty directory left by an interrupted install is not a resolution...
  mkdirSync(path.join(plugin, 'node_modules', 'react'), { recursive: true })
  assert.deepEqual(pluginMissingPeers(plugin), ['react'])
  // ...and the package itself, there, is.
  writeFileSync(path.join(plugin, 'node_modules', 'react', 'package.json'), '{"name":"react"}\n')
  assert.deepEqual(pluginMissingPeers(plugin), [])
})

test('a plugin whose peers are missing SKIPS the type gate — loudly, and not as a failure', () => {
  const dir = peerFixture({ peers: ['react', '@deepseek-ai/dsh-client-ui-primitives'] })
  const calls = []
  const lines = []
  const result = runPluginTypecheck(dir, { runNpm: (args) => calls.push(args), log: (line) => lines.push(line) })
  // The capability that must not be lost is dropping nothing when it CAN run.
  assert.deepEqual(calls, [])
  assert.equal(result.skipped, true)
  assert.deepEqual(result.missing, ['@deepseek-ai/dsh-client-ui-primitives', 'react'])
  // Loud: the line names the peers, so a green run cannot be read as coverage.
  assert.match(
    lines.join('\n'),
    /type gate SKIPPED — its declared peers are not installed here \(missing: @deepseek-ai\/dsh-client-ui-primitives, react\); npm --legacy-peer-deps omits them\./su,
  )
})

test('a plugin whose peers resolve RUNS the type gate, and says so', () => {
  const dir = peerFixture({ peers: ['react'], installed: ['@types/react'] })
  const calls = []
  const result = runPluginTypecheck(dir, { runNpm: (args, cwd) => calls.push([args, cwd]), log: () => {} })
  assert.deepEqual(calls, [[['run', 'typecheck'], dir]])
  assert.equal(result.skipped, false)
  assert.deepEqual(result.missing, [])
})

test('typecheckSkipSummary says how much of a run the type gate covered', () => {
  assert.match(typecheckSkipSummary(18, 0), /0 of 18 plugins skipped it.*every plugin was checked/)
  const partial = typecheckSkipSummary(18, 11)
  assert.match(partial, /11 of 18 plugins skipped it/)
  assert.match(partial, /vouches for their outputs, not for their types/)
})

test('every plugin\'s missing-peer report names only peers that plugin declares', () => {
  // True in any environment, unlike a count: the set is read from the manifest,
  // never kept here. A CI tree (peers omitted by --legacy-peer-deps) and this one
  // therefore differ in the answer, never in where the answer comes from.
  const pluginsRoot = path.join(ROOT, 'plugins')
  for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('plugin-')) continue
    const dir = path.join(pluginsRoot, entry.name)
    const declared = Object.keys(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).peerDependencies ?? {})
    for (const name of pluginMissingPeers(dir)) {
      assert.ok(declared.includes(name), `${entry.name}: ${name} is reported missing but is not a declared peer`)
    }
  }
})

test('the walker reads a real plugin directory and keeps out of lib/ and node_modules', () => {
  const pluginsRoot = path.join(ROOT, 'plugins')
  const names = readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('plugin-'))
    .map((entry) => entry.name)
  // The floor is the ROSTER, not a number: the suite's size changes with a
  // deliberate roster edit (this round removed one plugin), and a hardcoded
  // count turns that edit into a red test that says nothing about the walker.
  assert.ok(names.length >= SUITE_PLUGINS.length, `the suite has ${names.length} plugin directories, roster ${SUITE_PLUGINS.length}`)
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

// ------------------------------------------------- the import gate (static)

/**
 * A plugin fixture shaped for the import gate: a manifest carrying the three
 * dependency fields, plus the given sources.
 *
 * @param fields - `{ dependencies, peerDependencies, devDependencies, files }`,
 *   each omitted when not given.
 * @returns the created plugin directory.
 */
function importFixture({ dependencies, peerDependencies, devDependencies, files = {} } = {}) {
  return fixture({
    'package.json': JSON.stringify({
      name: '@dsh-app/plugin-fixture',
      version: '0.0.1',
      ...(dependencies === undefined ? {} : { dependencies }),
      ...(peerDependencies === undefined ? {} : { peerDependencies }),
      ...(devDependencies === undefined ? {} : { devDependencies }),
    }),
    ...files,
  })
}

test('importSpecifiers reads the four shapes that must resolve, with their lines', () => {
  const source = [
    "import { a } from '@fixture/a'", // 1
    "import type { B } from '@fixture/b'", // 2
    "import 'fixture-c'", // 3
    "export { c } from '@fixture/d'", // 4
    "export type { D } from '@fixture/e'", // 5
    "const f = await import('@fixture/f')", // 6
    "const g = await import(`@fixture/${'g'}`)", // 7 — computed, not decidable
    "const h = await import('./local.ts')", // 8 — relative
    "const i = require('@fixture/require')", // 9 — CommonJS, out of scope
    "const j = import.meta.url", // 10
  ].join('\n')
  assert.deepEqual(importSpecifiers(source), [
    { specifier: '@fixture/a', line: 1, typeOnly: false },
    { specifier: '@fixture/b', line: 2, typeOnly: true },
    { specifier: 'fixture-c', line: 3, typeOnly: false },
    { specifier: '@fixture/d', line: 4, typeOnly: false },
    { specifier: '@fixture/e', line: 5, typeOnly: true },
    { specifier: '@fixture/f', line: 6, typeOnly: false },
    { specifier: './local.ts', line: 8, typeOnly: false },
  ])
})

test('a specifier quoted in a comment, a JSDoc block or a string is not an import', () => {
  const source = [
    "// import { gone } from '@fixture/commented'",
    "/* import { gone } from '@fixture/blocked' */",
    '/**',
    " * import { gone } from '@fixture/jsdocked'",
    ' */',
    "const text = \"from '@fixture/quoted'\"",
    "const doc = `import x from '@fixture/templated'`",
    "const re = /from '@fixture/regexed'/u",
  ].join('\n')
  assert.deepEqual(importSpecifiers(source), [])
})

test('packageNameOf reduces a subpath to its package and refuses what names none', () => {
  assert.equal(packageNameOf('react-dom/client'), 'react-dom')
  assert.equal(packageNameOf('@deepseek-ai/dsh-session/types'), '@deepseek-ai/dsh-session')
  assert.equal(packageNameOf('react'), 'react')
  // A builtin is not a package to declare, bare or prefixed.
  assert.equal(packageNameOf('node:fs'), null)
  assert.equal(packageNameOf('fs/promises'), null)
  assert.equal(packageNameOf('path'), null)
  assert.equal(packageNameOf('./local.ts'), null)
  assert.equal(packageNameOf('../sibling.ts'), null)
  assert.equal(packageNameOf('/absolute/path.ts'), null)
  assert.equal(packageNameOf('@scope'), null)
  assert.equal(packageNameOf('@scope/'), null)
})

test('a builtin the runtime provides is not a package to declare, even when the gate runs on an older Node', () => {
  // `node:sqlite` became a builtin in Node 22.5 and needs no flag from 23.4, but
  // it is absent from `builtinModules` on the Node 22 a CI runner installs —
  // while the plugin actually loads inside Electron's own Node 24. Judging by
  // the gate's runtime refused `plugin-codegraph` for an import that never
  // leaves the host (measured on CI run 40104494149: src/store.ts:25). The
  // exemption is a fixed list, so this pins its one entry; a project that starts
  // importing another newer builtin adds it there and fails this test first,
  // which is the reminder to check the runtime really provides it.
  assert.equal(packageNameOf('node:sqlite'), null,
    'node:sqlite is a runtime builtin and must never be read as an undeclared package')
})

test('a package is explained by any of the three fields, by an ancestor manifest, or by being installed', () => {
  // Each of the three fields, one per specifier: the rule is "declared", never
  // "declared as a peer".
  const dir = importFixture({
    dependencies: { '@fixture/dep': '^1.0.0' },
    peerDependencies: { '@fixture/peer': '^1.0.0' },
    devDependencies: { '@fixture/dev': '^1.0.0' },
    files: {
      'src/index.ts': [
        "import '@fixture/dep'\n",
        "import '@fixture/peer'\n",
        "import '@fixture/dev'\n",
      ].join(''),
    },
  })
  assert.deepEqual(pluginImportGaps(dir).gaps, [])
  assert.equal(pluginImportGaps(dir).checked, 3)
  assert.equal(explainSpecifier(dir, '@fixture/dep').via, 'own')

  // An ancestor's manifest counts: the repository root carries the kernel
  // packages, and a plugin importing one is not importing something nobody has.
  const root = fixture({ 'package.json': JSON.stringify({ devDependencies: { '@fixture/root-only': '^1.0.0' } }) })
  const nested = path.join(root, 'plugins', 'plugin-x')
  mkdirSync(path.join(nested, 'src'), { recursive: true })
  writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ name: '@dsh-app/plugin-x', version: '0.0.1' }))
  writeFileSync(path.join(nested, 'src', 'index.ts'), "import '@fixture/root-only'\n")
  assert.deepEqual(pluginImportGaps(nested).gaps, [])
  assert.equal(explainSpecifier(nested, '@fixture/root-only').via, 'ancestor-manifest')

  // Installed, and nothing declares it: still present, and a non-external import
  // is resolved and inlined by the build, so its absence could not reach a user.
  const installed = importFixture({
    files: {
      'src/index.ts': "import '@fixture/installed'\n",
      'node_modules/@fixture/installed/package.json': '{"name":"@fixture/installed"}\n',
    },
  })
  assert.deepEqual(pluginImportGaps(installed).gaps, [])
  assert.equal(explainSpecifier(installed, '@fixture/installed').via, 'installed')
})

test('a package nothing accounts for is an undeclared gap, named with file, line and field', () => {
  const dir = importFixture({ files: { 'src/client/panel.tsx': "import { a } from '@fixture/nobody'\n" } })
  const report = pluginImportGaps(dir)
  assert.deepEqual(report.gaps, [
    {
      file: 'src/client/panel.tsx',
      line: 1,
      specifier: '@fixture/nobody',
      pkg: '@fixture/nobody',
      rule: 'undeclared',
      suggestion: 'declare "@fixture/nobody" in dependencies, peerDependencies or devDependencies',
    },
  ])
  assert.throws(
    () => assertPluginImports(dir),
    new RegExp(`${path.basename(dir)}: 1 import\\(s\\).*src/client/panel\\.tsx:1 imports "@fixture/nobody" — declare "@fixture/nobody" in dependencies, peerDependencies or devDependencies`, 'su'),
  )
})

test('the DefinitelyTyped sibling explains a package, and is reported as the weaker footing it is', () => {
  // The `react-dom` shape: twelve plugins import it, esbuild marks it external,
  // the host answers it, and every one of them declares `@types/react-dom`
  // instead of the package itself.
  const dir = importFixture({
    devDependencies: { '@types/fixture-hosted': '^18.0.0' },
    files: { 'src/client.ts': "import { createPortal } from 'fixture-hosted'\n" },
  })
  const report = pluginImportGaps(dir)
  assert.deepEqual(report.gaps, [])
  assert.deepEqual(report.typesOnly, ['fixture-hosted'])
  assert.equal(explainSpecifier(dir, 'fixture-hosted').via, 'own-types')
  assert.equal(explainSpecifier(dir, 'fixture-hosted').typesOnly, true)
  // The scoped spelling DefinitelyTyped publishes, which is the other half of
  // the same mapping.
  const scoped = importFixture({
    devDependencies: { '@types/fixture__hosted': '^18.0.0' },
    files: { 'src/client.ts': "import '@fixture/hosted'\n" },
  })
  assert.deepEqual(pluginImportGaps(scoped).typesOnly, ['@fixture/hosted'])
})

test('a @deepseek-ai package imported for runtime must be a peer, not a devDependency', () => {
  const value = "import { SessionSeq } from '@deepseek-ai/dsh-session'\n"
  const devOnly = importFixture({ devDependencies: { '@deepseek-ai/dsh-session': '^0.2.0-rc.2' }, files: { 'src/index.ts': value } })
  const report = pluginImportGaps(devOnly)
  assert.equal(report.gaps.length, 1)
  assert.equal(report.gaps[0].rule, 'kernel-peer')
  assert.match(report.gaps[0].suggestion, /declare "@deepseek-ai\/dsh-session" in peerDependencies as well/su)
  assert.throws(() => assertPluginImports(devOnly), /kernel package the kernel provides at load time|in peerDependencies as well/su)

  // The same import with the peer declared passes, and so does an ancestor
  // declaration for the OTHER rule — a package the root tree has is not
  // undeclared, it is simply not this plugin's peer.
  assert.deepEqual(
    pluginImportGaps(importFixture({
      peerDependencies: { '@deepseek-ai/dsh-session': '^0.2.0-rc.2' },
      files: { 'src/index.ts': value },
    })).gaps,
    [],
  )
  const ancestorPeer = fixture({ 'package.json': JSON.stringify({ peerDependencies: { '@deepseek-ai/dsh-session': '^0.2.0-rc.2' } }) })
  const nested = path.join(ancestorPeer, 'plugins', 'plugin-x')
  mkdirSync(path.join(nested, 'src'), { recursive: true })
  writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ name: '@dsh-app/plugin-x', version: '0.0.1' }))
  writeFileSync(path.join(nested, 'src', 'index.ts'), value)
  assert.deepEqual(pluginImportGaps(nested).gaps.map((gap) => gap.rule), ['kernel-peer'])
})

test('a type-only kernel import needs no peer: esbuild deletes it', () => {
  // The Context-merge idiom seventeen plugins use, and a type-only import of a
  // package the plugin otherwise leaves to tsc.
  const dir = importFixture({
    devDependencies: { '@deepseek-ai/dsh-client-connection': '^0.2.0-rc.2' },
    files: {
      'src/index.ts': [
        "import type {} from '@deepseek-ai/dsh-client-connection'\n",
        "import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'\n",
      ].join(''),
    },
  })
  assert.deepEqual(pluginImportGaps(dir).gaps, [])
  assert.equal(pluginImportGaps(dir).checked, 2)
})

test('importGateSummary says how much of a run rested on the @types clause', () => {
  assert.match(
    importGateSummary(18, 476, []),
    /import gate: 476 package import\(s\) across 18 plugins, all declared in a dependency field or installed on the resolution chain/su,
  )
  const weaker = importGateSummary(18, 476, ['react-dom'])
  assert.match(weaker, /1 only through their @types\/ sibling \(react-dom\)/su)
})

test('every import gap the real suite reports is a real one', () => {
  // The 18 real manifests and 18 real `src/` trees, not a fixture of them.
  //
  // The suite is red on exactly one plugin as this lands: plugin-market imports
  // `@deepseek-ai/schemastery` for runtime and declares it nowhere (its manifest
  // is being edited by a parallel change, so it is deliberately left for that
  // one). This case does NOT pin that remainder — an expectation listing today's
  // gaps would go red for the FIX rather than for a defect, and would then be
  // relaxed instead of read. What it pins is that no gap is a FALSE POSITIVE,
  // which is the property that keeps the gate's red meaningful: each one names a
  // package the plugin really imports, at a file:line that really holds that
  // import, and the field the gate says is missing really does not name it.
  const pluginsRoot = path.join(ROOT, 'plugins')
  const names = readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('plugin-'))
    .map((entry) => entry.name)
  // The floor is the ROSTER, not a number: the suite's size changes with a
  // deliberate roster edit (this round removed one plugin), and a hardcoded
  // count turns that edit into a red test that says nothing about the walker.
  assert.ok(names.length >= SUITE_PLUGINS.length, `the suite has ${names.length} plugin directories, roster ${SUITE_PLUGINS.length}`)
  let checked = 0
  const reported = []
  for (const name of names) {
    const pluginDir = path.join(pluginsRoot, name)
    const report = pluginImportGaps(pluginDir)
    checked += report.checked
    assert.deepEqual(
      report.gaps.filter((gap) => gap.rule === 'undeclared'),
      [],
      `${name}: imports a package no dependency field or resolution chain accounts for`,
    )
    const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
    for (const gap of report.gaps) {
      reported.push(`${name}:${gap.pkg}`)
      assert.equal(gap.rule, 'kernel-peer', `${name}: an unexpected rule for ${gap.pkg}`)
      assert.ok(gap.pkg.startsWith('@deepseek-ai/'), `${name}: ${gap.pkg} is not a kernel package`)
      assert.ok(
        !(gap.pkg in (manifest.peerDependencies ?? {})),
        `${name}: ${gap.pkg} is reported as a missing peer, but peerDependencies names it`,
      )
      const file = path.join(pluginDir, gap.file)
      assert.ok(existsSync(file), `${name}: the gap points at ${gap.file}, which does not exist`)
      const specifiers = importSpecifiers(readFileSync(file, 'utf8'))
      assert.ok(
        specifiers.some((found) => found.specifier === gap.specifier && found.line === gap.line),
        `${name}: ${gap.file}:${String(gap.line)} does not import ${gap.specifier}`,
      )
    }
  }
  assert.ok(checked > 300, `the gate read ${checked} package imports from the suite, expected the whole suite's`)
  // Today's remainder, named so a reader of a red run knows what is left and a
  // reader of a green one knows the exception is gone — NOT asserted, for the
  // reason above.
  assert.ok(reported.length <= 1, `the suite reports ${reported.join(', ')} — more than the one known remainder`)
})

test('every call site that builds or packs a plugin runs the shared gates', () => {
  // A gate nothing calls is green forever. Each file below is read as TEXT —
  // running a workflow is not this suite's job — and each is a place a plugin
  // can be built, packed, or merged without otherwise being type-checked.
  const build = readFileSync(path.join(ROOT, 'scripts', 'build-runtime.mjs'), 'utf8')
  assert.match(build, /from '\.\/lib\/plugin-gates\.mjs'/)
  assert.match(build, /from '\.\/lib\/plugin-imports\.mjs'/)
  // All four judgements, in this file: the local `runtime:build` loop is where
  // a suite missing whole plugins would be packed, so it cannot run a subset.
  assert.match(build, /runPluginTypecheck\(/)
  assert.match(build, /assertPluginImports\(/)
  assert.match(build, /assertPluginOutputs\(/)
  assert.match(build, /assertPluginLibFresh\(/)
  // The presence check is the one that must sit after the build, not before it.
  // `\r?\n` on purpose: a Windows checkout with core.autocrlf has CRLF here, and
  // an assertion that only matches LF would go red for a line ending rather than
  // for the order it is about.
  assert.match(build, /run\(npmBin\(\), \['run', 'build'\], pluginDir\)\r?\n\s*assertPluginOutputs\(pluginDir\)/u)

  // The CLI both workflows reach, and the only place the two new summary lines
  // are printed: a run's coverage has to be readable from its log.
  const cli = readFileSync(path.join(ROOT, 'scripts', 'plugin-gates.mjs'), 'utf8')
  assert.match(cli, /assertPluginImports\(/)
  assert.match(cli, /importGateSummary\(/)

  const release = readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8')
  assert.match(release, /node \.\.\/scripts\/plugin-gates\.mjs/)

  // The PR gate. This is the one call site whose teeth are the TYPE gate, the
  // import gate and the presence check: a clean checkout has no lib/ at all, so
  // the freshness half passes by construction and only guards a tree that was
  // already built. The `"$dir"` argument pins the call inside the per-plugin
  // loop (`$dir` exists only there), so the gate cannot be moved out of the loop
  // that builds.
  const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.match(ci, /for dir in plugins\/\*\/; do/u)
  assert.match(ci, /node scripts\/plugin-gates\.mjs "\$dir"/u)
})
