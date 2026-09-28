// The migration that moves the suite's rows out of the profile patch and into a
// bundle layer the profile owns.
//
// Why the migration exists at all: since kernel 0.1.7 the profile patch is where
// the KERNEL persists the user's settings, so the shell stops writing it. The
// suite's rows have to come from somewhere the host reads, and that is a declared
// bundle's own `dsh.bundle.patch` layer. The rows already in an existing profile
// patch must therefore go — but only the ones that would otherwise arrive twice.
//
// The distinction this file pins is the one that decides whether a user loses
// data, and it is not "does the id look like ours":
//
//   - an `insert:` block APPENDS entries (`applyEntryPatches` pushes, it does not
//     look for an existing id), so an overlay insert block left in the profile
//     patch would coexist with the layer's copy — the duplicate shape;
//   - a plain `- id: web` row OVERRIDES an entry, creates nothing, and is exactly
//     where the kernel's configuration editor stores the user's own choice. The
//     shipped overlay carries two such rows (`web`, `deepseek-account`), so
//     removing them by id would silently reset the user's search provider and
//     account identity to the overlay's defaults.
//
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { SUITE_LAYER_PACKAGE, overlayOwnedIds, stripSuiteRows } = require('../dist/main/suite-layer.js')

const OVERLAY = readFileSync(path.join(import.meta.dirname, '..', 'dist', 'main', 'dsh-app.patch.yml'), 'utf8')
const OWNED = overlayOwnedIds(OVERLAY)

test('the overlay\'s id roster is read off the overlay itself', () => {
  // The roster is derived, never listed in the module: a copy could only rot.
  // The two shapes both have to be found — a root-level row (`- id: web`) and an
  // insert block's indented children (the sixteen plugins live in ONE block).
  assert.ok(OWNED.has('web'), 'a root-level row of the overlay')
  assert.ok(OWNED.has('brand'), 'an indented child of the overlay\'s insert block')
  assert.ok(OWNED.has('schedule'), 'a child of the overlay\'s SECOND insert block')
  assert.ok(!OWNED.has('not-a-real-plugin'), 'nothing is attributed that the overlay does not declare')
  for (const plugin of ['brand-client-ui', 'sidebar', 'swarm', 'usage', 'archives', 'memory', 'mcp', 'hooks', 'ppt', 'market', 'presets', 'doc', 'sheet', 'pdf', 'websearch']) {
    assert.ok(OWNED.has(plugin), `the overlay declares ${plugin}`)
  }
})

test('an overlay insert block is removed', () => {
  const text = [
    '# a comment the user wrote',
    '- insert:',
    '    - id: brand',
    "      name: '@dsh-app/plugin-brand'",
    '    - id: swarm',
    "      name: '@dsh-app/plugin-swarm'",
    '',
  ].join('\n')
  const { text: next, removed } = stripSuiteRows(text, OWNED)
  assert.deepEqual(removed.sort(), ['brand', 'swarm'])
  assert.ok(!next.includes('insert:'), 'the block is gone')
  assert.ok(next.includes('a comment the user wrote'), 'the comment around it stays')
  // A document with no rows left is anchored, because the kernel rejects a patch
  // that does not parse as a top-level sequence.
  assert.ok(next.trim() !== '', 'the file is never left empty')
})

test('a non-insert overlay row is KEPT: it is where the user\'s own choice lives', () => {
  // The measured failure this pins: `web` and `deepseek-account` are override rows
  // in the shipped overlay, and the kernel edits them in place. Removing them by id
  // would reset the user's search provider and account identity to the defaults.
  const text = [
    '- id: web',
    '  config:',
    "    searchProvider: my-own-provider",
    '    fetchProvider: http',
    '- id: deepseek-account',
    '  config:',
    "    desktopPlatform: 'win32'",
    '',
  ].join('\n')
  const { text: next, removed } = stripSuiteRows(text, OWNED)
  assert.deepEqual(removed, [], 'nothing is removed')
  assert.equal(next, text, 'the document is returned unchanged, byte for byte')
  assert.ok(next.includes('my-own-provider'), 'the user\'s provider choice is still there')
})

test('kernel-written settings and user rows survive the migration', () => {
  const settings = [
    '- id: ui-theme',
    '  config:',
    '    preference: dark',
    '- id: llm-deepseek',
    '  config:',
    '    models: []',
  ].join('\n')
  const mixed = ['- insert:', '    - id: brand', '', settings, ''].join('\n')
  const { text, removed } = stripSuiteRows(mixed, OWNED)
  assert.deepEqual(removed, ['brand'])
  assert.ok(text.includes('preference: dark'), 'the appearance setting is still there')
  assert.ok(text.includes('llm-deepseek'), 'the user\'s provider row is still there')
})

test('an insert block this cannot fully attribute is KEPT', () => {
  // A hand-written third-party insert, or a block whose ids the overlay does not
  // declare: keeping it costs a duplicate entry, which the loader collapses to the
  // last one. Removing it wrongly costs the user a plugin nothing brings back.
  const thirdParty = ['- insert:', '    - id: some-third-party-plugin', "      name: 'dsh-market-plugin'", ''].join('\n')
  const { text, removed } = stripSuiteRows(thirdParty, OWNED)
  assert.deepEqual(removed, [])
  assert.equal(text, thirdParty)

  // Mixed: one known id and one unknown. The whole block stays.
  const mixed = ['- insert:', '    - id: brand', '    - id: some-third-party-plugin', ''].join('\n')
  assert.deepEqual(stripSuiteRows(mixed, OWNED).removed, [])
})

test('the migration is idempotent: a second pass finds nothing to remove', () => {
  const text = ['- insert:', '    - id: brand', '', '- id: usage-heatmap', '  disabled: true', ''].join('\n')
  const once = stripSuiteRows(text, OWNED)
  assert.deepEqual(once.removed, ['brand'])
  const twice = stripSuiteRows(once.text, OWNED)
  assert.deepEqual(twice.removed, [])
  assert.equal(twice.text, once.text, 'the second pass writes nothing')
})

test('a CRLF document is read, not silently skipped', () => {
  // `.` never matches a carriage return, so a reader anchored to the end of a line
  // reads a CRLF row as having no value — silently, which is the failure mode the
  // sibling readers in brand-suite.ts exist to avoid.
  const text = ['- insert:', '    - id: brand', '', '- id: ui-theme', '  config:', '    preference: dark', ''].join('\r\n')
  const { text: next, removed } = stripSuiteRows(text, OWNED)
  assert.deepEqual(removed, ['brand'], 'the CRLF block is recognised')
  assert.ok(next.includes('preference: dark'), 'the CRLF settings row is kept')
})

test('a block holding prose is left commented: un-commenting it would be invalid YAML', () => {
  // Marking a dead row prefixes `# ` to each of its lines, so a comment the USER
  // had at column zero inside the row looks exactly like commented code afterwards.
  // Stripping the marker from such a block emits bare prose where the loader
  // expects YAML — a boot failure in place of the silent omission the restore is
  // meant to undo. Measured while adding the guard: the block below un-commented
  // into `Unexpected scalar at node end`.
  const text = [
    '# [dsh-app] NOT LOADED: "@dsh-app/plugin-brand" does not resolve from this profile.',
    '# - insert:',
    '#     - id: brand',
    "#       name: '@dsh-app/plugin-brand'",
    '# a note the user wrote inside the row',
    '',
    '- id: ui-theme',
    '  config:',
    '    preference: dark',
  ].join('\n')
  const { text: next, removed } = stripSuiteRows(text, OWNED)
  assert.equal(next, text, 'the block is untouched')
  assert.deepEqual(removed, [], 'the block is not an insert row any more (it is commented)')
  // The file still parses, which is the property the guard protects.
  assert.ok(next.includes('preference: dark'), 'the live rows are unaffected')
})

test('rowsToRestore restores only the shell\'s own commented blocks', () => {
  const marker = '# [dsh-app] NOT LOADED:'
  const restore = require('../dist/main/suite-layer.js').rowsToRestore
  const uncomment = require('../dist/main/suite-layer.js').uncommentRows

  // A block the shell's own older judgement killed: its ids are the overlay's.
  const ours = [
    `${marker} "@dsh-app/plugin-brand" does not resolve from this profile.`,
    '# - insert:',
    '#     - id: brand',
    "#       name: '@dsh-app/plugin-brand'",
  ].join('\n')
  assert.deepEqual(restore(ours, OWNED), ['brand'], 'the shell\'s own block is recognised')
  assert.ok(uncomment(ours, ['brand']).startsWith('- insert:'), 'and it comes back live')

  // A block naming something the overlay does not declare: left exactly as it is.
  const foreign = [`${marker} "@third/party" does not resolve`, '# - id: third-party-plugin', "#   name: '@third/party'"].join('\n')
  assert.deepEqual(restore(foreign, OWNED), [], 'a foreign block is not touched')
  assert.equal(uncomment(foreign, []), foreign, 'and it stays commented')

  // A user's own prose comment under a marker is not rows at all.
  const prose = [`${marker} "x"`, '# remember to check the docs'].join('\n')
  assert.deepEqual(restore(prose, OWNED), [], 'prose is not a row')
})

test('column-0 comments between a block and the next row do not disqualify the block', () => {
  // The shipped overlay itself puts its own comments between an insert block and
  // the next root row (it explains the `web` seam there). A rule that treated any
  // column-0 line as a foreign sibling key would refuse to strip the real overlay's
  // blocks — measured: the migration removed 1 row instead of 17.
  const text = [
    '- insert:',
    '    - id: brand',
    "      name: '@dsh-app/plugin-brand'",
    '',
    '# a comment the shell ships, explaining the next row',
    '# and a second line of it',
    '- id: ui-theme',
    '  config:',
    '    preference: dark',
  ].join('\n')
  const { text: next, removed } = stripSuiteRows(text, OWNED)
  assert.deepEqual(removed, ['brand'], 'the block is still attributed to the overlay')
  assert.ok(next.includes('a comment the shell ships'), 'the comments stay')
  assert.ok(next.includes('preference: dark'), 'the settings row stays')
})

test('a same-indent sibling key keeps the whole block', () => {
  // `- insert:` … `  extra: 1` is ONE patch entry with two fields (YAML), so the
  // `extra` line has no list marker. The shell never writes one of these, but a
  // hand-edited file can — and taking it with the block would silently drop a key
  // the user wrote. Keeping the block costs a duplicate entry, which the loader
  // collapses; dropping the key costs the user their edit.
  const text = ['- insert:', '    - id: brand', '  extra: 1', ''].join('\n')
  const { text: next, removed } = stripSuiteRows(text, OWNED)
  assert.deepEqual(removed, [], 'the block is kept whole')
  assert.equal(next, text, 'the file is untouched')
})

test('a block from an OLDER roster is still attributed to the suite', () => {
  // `plugin-fff` shipped in the suite and was removed from it, and every profile
  // whose patch an earlier shell generated carries a block of SEVENTEEN ids
  // including `fff` (`git show 3b2ce94~1:plugins/dsh-app.patch.yml:153`). Matching
  // against the CURRENT roster alone would never qualify that block again — the
  // roster will never contain `fff` — so it would stay forever: sixteen live ids
  // duplicated against the layer, composing after it and masking it, plus a dead
  // row warning on every start. The `@dsh-app/` scope is the fallback that keeps
  // those profiles migratable.
  const text = [
    '- insert:',
    '    - id: brand',
    "      name: '@dsh-app/plugin-brand'",
    '    - id: fff',
    "      name: '@dsh-app/plugin-fff'",
    '',
  ].join('\n')
  assert.ok(!OWNED.has('fff'), 'the current roster no longer declares it')
  const { removed } = stripSuiteRows(text, OWNED)
  assert.deepEqual(removed.sort(), ['brand', 'fff'], 'the whole old block goes')
})

test('a third-party block is not attributed, even beside suite ids', () => {
  // The scope fallback must not reach a user's own plugin. A block naming its own
  // scope stays; a mixed block stays too (the ids are not all the suite's).
  const thirdParty = ['- insert:', '    - id: my-plugin', "      name: 'dsh-some-third-party'", ''].join('\n')
  assert.deepEqual(stripSuiteRows(thirdParty, OWNED).removed, [], 'a third-party block stays')

  const mixed = ['- insert:', '    - id: brand', "      name: '@dsh-app/plugin-brand'", '    - id: my-plugin', "      name: 'dsh-some-third-party'", ''].join('\n')
  assert.deepEqual(stripSuiteRows(mixed, OWNED).removed, [], 'a mixed block stays whole')

  // A suite-scoped block with no `name:` is not attributed either: the scope has to
  // be READ, not assumed.
  const nameless = ['- insert:', '    - id: x', '    - id: y', ''].join('\n')
  assert.deepEqual(stripSuiteRows(nameless, OWNED).removed, [], 'no name, no attribution')
})

test('a block whose row has a blank line inside it is restored whole or not at all', () => {
  // The old writer left a row's interior blank lines blank while commenting its
  // other lines, so a naive "stop at the first non-`#`" scan splits the row: the
  // `id:` and `config:` come back while the values stay commented, and the
  // resulting `config: null` is applied as a whole-object replacement — silently
  // emptying the user's setting. Measured before the fix.
  const marker = '# [dsh-app] NOT LOADED:'
  const withBlank = [
    `${marker} "@dsh-app/plugin-brand" does not resolve from this profile.`,
    '# - insert:',
    '#     - id: brand',
    "#       name: '@dsh-app/plugin-brand'",
    '',
    '# - id: swarm',
    "#   name: '@dsh-app/plugin-swarm'",
  ].join('\n')
  const restore = require('../dist/main/suite-layer.js').rowsToRestore
  const uncomment = require('../dist/main/suite-layer.js').uncommentRows
  const ids = restore(withBlank, OWNED)
  assert.deepEqual(ids, ['brand', 'swarm'], 'the blank line does not split the block')
  const out = uncomment(withBlank, ids)
  assert.ok(out.includes('- id: swarm'), 'both halves came back')
  assert.ok(!out.includes('NOT LOADED'), 'the marker is gone')
  // The whole point: no half-restored row whose `config` would become null.
  assert.ok(!/^\s*config:\s*$/mu.test(out), 'no empty config key was emitted')
})

test('a block carrying prose is not split at the prose either', () => {
  const marker = '# [dsh-app] NOT LOADED:'
  const prose = [
    `${marker} "@dsh-app/plugin-brand" does not resolve from this profile.`,
    '# - insert:',
    '#     - id: brand',
    '# a note the user wrote',
    '',
    '- id: ui-theme',
    '  config:',
    '    preference: dark',
  ].join('\n')
  const restore = require('../dist/main/suite-layer.js').rowsToRestore
  assert.deepEqual(restore(prose, OWNED), [], 'a block with prose is left alone')
})

test('the layer package name is the synthetic scope entry the manifest names', () => {
  assert.equal(SUITE_LAYER_PACKAGE, '@dsh-app/suite-layer')
  assert.ok(SUITE_LAYER_PACKAGE.startsWith('@dsh-app/'), 'it lives in the suite\'s own scope')
})

test('the layer name does not depend on which module loads first', () => {
  // This started as a circular-import guard: `suite-layer` and `brand-suite` used
  // to import each other, and a module-level constant derived across that cycle
  // evaluated to `undefined` when the other side got there first — measured: the
  // name became `undefined/suite-layer`, which would have put a bundle in the
  // profile manifest that nothing can resolve. The dependency is one-way now
  // (`suite-layer` → `brand-suite`), so the failure mode is gone; the test stays
  // because it pins the invariant the name depends on — the scope it rides in.
  const suiteLayer = require('../dist/main/suite-layer.js')
  const brandSuite = require('../dist/main/brand-suite.js')
  assert.equal(suiteLayer.SUITE_LAYER_PACKAGE, '@dsh-app/suite-layer')
  assert.equal(brandSuite.PLUGIN_SCOPE, '@dsh-app')
  assert.ok(
    suiteLayer.SUITE_LAYER_PACKAGE.startsWith(`${brandSuite.PLUGIN_SCOPE}/`),
    'the layer rides in the scope the suite links its plugins into',
  )
  // And the layer's own directory name has to be the package's last path segment,
  // or the manifest entry and the directory on disk disagree.
  assert.equal(suiteLayer.SUITE_LAYER_PACKAGE.split('/')[1], 'suite-layer')
})
