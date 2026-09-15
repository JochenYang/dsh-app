// The splash's appearance hand-off: which theme the shell draws before any UI
// exists.
//
// The preference lives in the user-settings document (`ui-theme.preference`),
// which the shell reads directly — so the parser is the part that can go wrong
// quietly: `preference` also exists under OTHER namespaces (the locale plugin
// keeps one), and a document-wide search would happily return the wrong value.
// These cases pin that scoping plus every degradation path (missing file, no
// block, unknown value) onto the setting's own default, `system`.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { parseThemePreference, readThemePreference, resolveThemeMode, DEFAULT_THEME_PREFERENCE } =
  require('../dist/main/theme.js')

/** One settings document with the shape dsh writes. */
const document = (themeBlock, extra = '') => [
  'llm-deepseek:',
  '  apiKey: sk-not-a-real-key',
  extra,
  themeBlock,
  'agent-presets:',
  '  default: standard',
].filter((line) => line !== '').join('\n')

test('parseThemePreference reads the value inside the ui-theme block', () => {
  assert.equal(parseThemePreference(document('ui-theme:\n  preference: dark')), 'dark')
  assert.equal(parseThemePreference(document('ui-theme:\n  preference: light')), 'light')
  assert.equal(parseThemePreference(document('ui-theme:\n  preference: system')), 'system')
  // Quoted scalars are valid YAML for the same value.
  assert.equal(parseThemePreference(document("ui-theme:\n  preference: 'dark'")), 'dark')
  // Indentation is the block's, not a fixed number of spaces.
  assert.equal(parseThemePreference(document('ui-theme:\n    preference: dark')), 'dark')
})

test('parseThemePreference ignores a preference belonging to another namespace', () => {
  // The locale plugin's own `preference` sits in the same document; reading it
  // as the theme would put an English-speaking user in a Japanese theme or,
  // more likely, a Chinese-first user into the wrong one silently.
  const text = document('ui-theme:\n  preference: light', 'locale:\n  preference: zh')
  assert.equal(parseThemePreference(text), 'light')
  // And the reverse order: the theme block first, the locale block after.
  const reversed = ['ui-theme:', '  preference: dark', 'locale:', '  preference: zh'].join('\n')
  assert.equal(parseThemePreference(reversed), 'dark')
})

test('parseThemePreference stops at the next top-level key', () => {
  // A `preference` that belongs to the FOLLOWING namespace must not be
  // attributed to a `ui-theme:` block that has none.
  const text = ['ui-theme:', '  fontSize: 14', 'locale:', '  preference: zh'].join('\n')
  assert.equal(parseThemePreference(text), null)
})

test('parseThemePreference rejects anything unusable', () => {
  assert.equal(parseThemePreference(''), null)
  assert.equal(parseThemePreference('llm-deepseek:\n  apiKey: sk-x'), null)
  assert.equal(parseThemePreference('ui-theme:\n  preference: sepia'), null)
  assert.equal(parseThemePreference('ui-theme: {preference: dark}'), null, 'flow style is not the shape dsh writes')
  assert.equal(parseThemePreference('# ui-theme:\n  preference: dark'), null, 'a commented block is not a block')
})

test('readThemePreference survives a missing or unreadable document', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-theme-test-'))
  assert.equal(readThemePreference(path.join(dir, 'nope.yaml')), null)
  const file = path.join(dir, 'settings.yaml')
  writeFileSync(file, document('ui-theme:\n  preference: dark'), 'utf8')
  assert.equal(readThemePreference(file), 'dark')
})

test('resolveThemeMode honours a pinned preference and otherwise follows the OS', () => {
  assert.equal(resolveThemeMode('light', true), 'light', 'an explicit light beats a dark OS')
  assert.equal(resolveThemeMode('dark', false), 'dark', 'an explicit dark beats a light OS')
  assert.equal(resolveThemeMode('system', true), 'dark')
  assert.equal(resolveThemeMode('system', false), 'light')
  // The degradation path is the setting's own default, so a document the shell
  // cannot read behaves exactly like a user who never touched the row.
  assert.equal(resolveThemeMode(null, true), resolveThemeMode(DEFAULT_THEME_PREFERENCE, true))
  assert.equal(resolveThemeMode(null, false), 'light')
})
