/**
 * The home layer's shadowing rows: which ones the app can never write past, and
 * how one of them is moved into a profile without losing a byte.
 *
 * The kernel's own refusal is the thing being modelled (see the module's header):
 * a setting that also lives in `$DSH_HOME/cordis.patch.yml` cannot be changed from
 * the app at all, because the editor composes every layer, finds the home layer's
 * value, and throws before it writes.
 *
 * @module dsh-app/tests/home-layer-rows
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { readHomeLayerConflicts, dropRowById, appendRowLines } = require('../dist/main/home-layer-rows.js')

const HOME = [
  '# DSH_HOME/cordis.patch.yml — rows written by the user for every profile',
  '- id: agent-default-model',
  '  name: \'@deepseek-ai/dsh-agent-default-model\'',
  '  config:',
  '    provider: stepfun',
  '    model: step-5-preview',
  '',
  '# a row without a config cannot shadow anything: it overrides no value',
  '- id: web-search-deepseek',
  '',
  '- id: ui-theme',
  '  config:',
  '    preference: dark',
].join('\n')

test('a home row with a config shadows a setting the profile carries', () => {
  const conflicts = readHomeLayerConflicts({
    homeLayerText: HOME,
    profileEntryIds: new Set(['agent-default-model', 'ui-theme', 'other']),
  })
  assert.deepEqual(conflicts.map((conflict) => conflict.id), ['agent-default-model', 'ui-theme'])
  assert.equal(conflicts[0].name, '@deepseek-ai/dsh-agent-default-model')
  assert.equal(conflicts[0].line, 2, 'the row starts at line 2 (1-based)')
  assert.deepEqual(conflicts[0].lines, [
    '- id: agent-default-model',
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    '  config:',
    '    provider: stepfun',
    '    model: step-5-preview',
  ], 'the row carries its own lines, verbatim, with no trailing comment')
})

test('a row without a config is not a conflict, and an id the profile lacks is not either', () => {
  const conflicts = readHomeLayerConflicts({
    homeLayerText: HOME,
    profileEntryIds: new Set(['web-search-deepseek', 'not-in-the-home-layer']),
  })
  assert.deepEqual(conflicts, [], 'no config, no shadowing')
})

test('dropping one row leaves every other byte alone', () => {
  const before = HOME
  const { text, removed } = dropRowById(before, 'agent-default-model')
  assert.ok(removed !== undefined)
  assert.equal(text, before.split('\n').filter((_line, index) => index < 1 || index > 5).join('\n'))
  assert.ok(text.includes('# a row without a config cannot shadow anything'), 'a comment between rows survives')
  assert.ok(text.includes('- id: ui-theme'), 'the later row survives')
  assert.ok(!text.includes('stepfun'), 'nothing of the dropped row is left')
})

test('dropping an id that is not there changes nothing', () => {
  const { text, removed } = dropRowById(HOME, 'not-a-row')
  assert.equal(removed, undefined)
  assert.equal(text, HOME)
})

test('a row is appended verbatim, and an empty document becomes a list', () => {
  const lines = ['- id: ui-theme', '  config:', '    preference: dark']
  assert.equal(appendRowLines('[]\n', lines), `[]\n${lines.join('\n')}\n`)
  assert.equal(appendRowLines('', lines), `[]\n${lines.join('\n')}\n`)
  assert.equal(appendRowLines('- id: web\n', lines), `- id: web\n${lines.join('\n')}\n`)
  // `!!js` expressions are the reason the lines travel raw: re-serializing a parsed
  // config would drop the tag and change what the kernel evaluates.
  const withExpression = ['- id: deepseek-account', '  config:', "    desktopPlatform: !!js \"['win32'].includes(process.platform) ? 'win32' : null\""]
  assert.ok(appendRowLines('[]\n', withExpression).includes('!!js'), 'the tag survives')
})

test('the copy of the home layer in the repository is not what this reads (no stray file)', () => {
  // A guard against the module ever being pointed at a fixture by accident.
  const source = readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'home-layer-rows.ts'), 'utf8')
  assert.ok(source.includes('readPatchText'), 'the reader takes the path from its caller')
  assert.ok(!source.includes('os.homedir()'), 'the module resolves no home of its own')
})

test('a move appends every row to the profile and drops it from the home layer', () => {
  const { planHomeLayerMoves } = require('../dist/main/home-layer-rows.js')
  const plan = planHomeLayerMoves({
    homeLayerText: HOME,
    profilePatchText: '- id: web\n  config:\n    searchProvider: dsh-app\n',
    ids: ['agent-default-model', 'ui-theme', 'not-there'],
  })
  assert.deepEqual(plan.moved, ['agent-default-model', 'ui-theme'], 'only the rows the home layer carries')
  assert.ok(!plan.home.includes('stepfun'), 'the home layer loses exactly those rows')
  assert.ok(!plan.home.includes('preference: dark'), 'including the second one')
  assert.ok(plan.home.includes('- id: web-search-deepseek'), 'and keeps the config-less row')
  assert.ok(plan.profile.startsWith('- id: web\n'), 'the profile patch keeps what it had')
  assert.ok(plan.profile.endsWith([
    '- id: agent-default-model',
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    '  config:',
    '    provider: stepfun',
    '    model: step-5-preview',
    '- id: ui-theme',
    '  config:',
    '    preference: dark',
    '',
  ].join('\n')), 'both values survive, verbatim, in this profile')
})

test('a row is appended even when the profile already declares the id', () => {
  // The two rows can disagree — the home layer is the one that has been in effect —
  // and dropping it without appending would silently change the value the user sees
  // to whatever the older profile row says. A duplicate id is harmless for a
  // non-insert row: the loader takes the last, and the editor rewrites the last.
  const { planHomeLayerMoves } = require('../dist/main/home-layer-rows.js')
  const profile = '- id: agent-default-model\n  config:\n    provider: openai\n'
  const plan = planHomeLayerMoves({ homeLayerText: HOME, profilePatchText: profile, ids: ['agent-default-model'] })
  assert.deepEqual(plan.moved, ['agent-default-model'])
  assert.ok(plan.profile.startsWith(profile), 'the older row is left exactly as it was')
  assert.ok(plan.profile.includes('model: step-5-preview'), 'the effective value follows the user into the profile')
})

test('a move of rows the home layer does not carry plans nothing', () => {
  const { planHomeLayerMoves } = require('../dist/main/home-layer-rows.js')
  const plan = planHomeLayerMoves({ homeLayerText: HOME, profilePatchText: '[]\n', ids: ['not-there'] })
  assert.deepEqual(plan.moved, [])
  assert.equal(plan.home, HOME)
  assert.equal(plan.profile, '[]\n')
})

test('entry ids are collected from every layer, nested rows included', () => {
  const { collectEntryIds } = require('../dist/main/home-layer-rows.js')
  const ids = collectEntryIds([
    '- id: agent-default-model\n  name: x\n',
    '- insert:\n    - id: brand\n      name: \'@dsh-app/plugin-brand\'\n    - id: ui-schedule\n      name: y\n',
    "  - id: 'quoted-row'\n",
  ])
  assert.deepEqual([...ids].sort(), ['agent-default-model', 'brand', 'quoted-row', 'ui-schedule'])
})
