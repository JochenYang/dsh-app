// Static plugin-graph rules (scripts/check-plugin-graph.mjs). Both directions
// matter here: a rule that never fires is dead weight, and a rule that fires on
// a sound graph would turn every release red. The synthetic manifests below pin
// exactly which shapes are violations.
// Run: npm test (root suites need a prior build)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { checkHanCharacters, checkOnDiskRoster, checkPluginGraph, checkSuiteRoster } from '../scripts/check-plugin-graph.mjs'

const FOLLOWED = '^0.1.5-rc.2'

const plugin = (manifest) => ({ dir: 'plugin-x', manifest })
const check = (manifest, followed = FOLLOWED) => checkPluginGraph([plugin(manifest)], followed)

test('a core package declared as a dependency is a violation', () => {
  const violations = check({ dependencies: { '@deepseek-ai/dsh-tools': '^0.1.5-rc.2' } })
  assert.equal(violations.length, 1)
  assert.match(violations[0], /peerDependencies/u)
  assert.equal(check({ dependencies: { '@dsh-app/plugin-brand': '0.7.0' } }).length, 1)
  // An ordinary third-party dependency is fine.
  assert.deepEqual(check({ dependencies: { docx: '^9.0.0' } }), [])
})

test('packaging node_modules is a violation at any depth', () => {
  assert.equal(check({ files: ['node_modules'] }).length, 1)
  assert.equal(check({ files: ['lib/node_modules/x'] }).length, 1)
  assert.deepEqual(check({ files: ['lib', 'templates/**'] }), [])
})

test('a dsh peer range that lags the followed line is a violation', () => {
  // A prerelease suffix within the SAME version is fine: 0.1.5-rc.2 satisfies
  // ^0.1.5-rc.1, and both floors are 0.1.5 — flagging this would be a false alarm
  // on every release.
  assert.deepEqual(check({ peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.5-rc.1' } }), [])
  assert.deepEqual(check({ peerDependencies: { '@deepseek-ai/dsh-tools': FOLLOWED } }), [])
  // A different line is not.
  const lagging = check({ peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.4' } })
  assert.equal(lagging.length, 1)
  assert.match(lagging[0], /does not track the followed line/u)
})

test('non-dsh core peers are left alone', () => {
  // cordis has its own release cadence; the kernel line does not govern it.
  assert.deepEqual(check({ peerDependencies: { '@deepseek-ai/cordis': '^4.0.0' } }), [])
  assert.deepEqual(check({ peerDependencies: { '@deepseek-ai/cordis-plugin-group': '^3.0.0' } }), [])
})

test('an unparseable dsh peer range is reported instead of skipped', () => {
  const violations = check({ peerDependencies: { '@deepseek-ai/dsh-tools': 'not-a-range' } })
  assert.equal(violations.length, 1)
  assert.match(violations[0], /unparseable/u)
})

test('a sound plugin produces no violations', () => {
  assert.deepEqual(check({
    dependencies: { docx: '^9.0.0' },
    files: ['lib', 'package.json'],
    peerDependencies: { '@deepseek-ai/cordis': '^4.0.0', '@deepseek-ai/dsh-tools': '^0.1.5-rc.1' },
  }), [])
})

test('the suite roster is compared on the package name, not the directory', () => {
  const repoRoot = 'C:/nonexistent-repo-for-test'
  const missing = checkSuiteRoster(repoRoot, ['@dsh-app/plugin-brand'])
  assert.equal(missing.length, 1)
  assert.match(missing[0], /plugins\/plugin-brand\/package\.json/u)

  // The real roster is checked against the real tree: every entry resolves.
  const actual = checkSuiteRoster(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'))
  assert.deepEqual(actual, [], 'the shipped roster must match the plugins on disk')
})

/** A throwaway repo skeleton: `plugins/<dir>/package.json` + optional sources. */
function skeleton(t, pluginDirs) {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-graph-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const dir of pluginDirs) {
    mkdirSync(path.join(root, 'plugins', dir, 'src', 'client'), { recursive: true })
    writeFileSync(path.join(root, 'plugins', dir, 'package.json'), `${JSON.stringify({ name: `@dsh-app/${dir}` })}\n`)
  }
  return root
}

test('a plugin directory no roster carries is a violation (the reverse check)', (t) => {
  const root = skeleton(t, ['plugin-brand', 'plugin-ghost'])
  const violations = checkOnDiskRoster(root, ['@dsh-app/plugin-brand'])
  assert.equal(violations.length, 1)
  assert.match(violations[0], /plugin-ghost/u)
  // A roster name without the `plugin-` prefix normalizes to the same directory
  // in BOTH directions — the two checks must not disagree about it.
  assert.deepEqual(checkOnDiskRoster(root, ['@dsh-app/brand', '@dsh-app/ghost']), [])
  assert.deepEqual(checkSuiteRoster(root, ['@dsh-app/brand']), [])
})

test('Han outside a dictionary is a violation; dictionaries and model-facing trees are exempt', (t) => {
  const root = skeleton(t, ['plugin-alpha'])
  const write = (relative, text) => writeFileSync(path.join(root, relative), text)
  const han = '\u8868\u5355'  // two Han characters, as a string literal
  const section = 'plugins/plugin-alpha/src/client/section.tsx'
  // Stray Han in ordinary source.
  write(section, `export const label = '${han}'\n`)
  assert.equal(checkHanCharacters(root).length, 1)
  // The dictionary file itself is where it belongs, and ordinary code is clean.
  write('plugins/plugin-alpha/src/client/locales.ts', `export const zh = { a: '${han}' }\n`)
  write(section, "export const label = 'form'\n")
  assert.deepEqual(checkHanCharacters(root), [])
  // The office plugins' model-facing trees are exempt, but their CLIENT half is
  // not: that is the drift this exemptions rule kept visible.
  const officeRoot = skeleton(t, ['plugin-doc'])
  writeFileSync(path.join(officeRoot, 'plugins', 'plugin-doc', 'src', 'skill.ts'), `export const t = '${han}'\n`)
  writeFileSync(path.join(officeRoot, 'plugins', 'plugin-doc', 'src', 'client', 'section.tsx'), `export const t = '${han}'\n`)
  const officeViolations = checkHanCharacters(officeRoot)
  assert.equal(officeViolations.length, 1)
  assert.match(officeViolations[0], /plugin-doc\/src\/client\/section\.tsx/u)
  // A comment is not code: a bilingual JSDoc example must not fire.
  write(section, `/** ${han} example */\nexport const label = 'x'\n`)
  assert.deepEqual(checkHanCharacters(root), [])
})
