// Static plugin-graph rules (scripts/check-plugin-graph.mjs). Both directions
// matter here: a rule that never fires is dead weight, and a rule that fires on
// a sound graph would turn every release red. The synthetic manifests below pin
// exactly which shapes are violations.
// Run: npm test (root suites need a prior build)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkPluginGraph, checkSuiteRoster } from '../scripts/check-plugin-graph.mjs'

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
