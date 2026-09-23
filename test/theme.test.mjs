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
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { parseThemePreference, parseThemePreferenceFromPatch, readThemePreference, readThemePreferenceFromPatch, resolveThemeMode, DEFAULT_THEME_PREFERENCE } =
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

// --- the same setting on the line that moved it ------------------------------
//
// 0.1.7 keeps user settings as rows in the booted profile's patch and renames
// `settings.yaml` to `settings.yaml.imported`, so the reader above finds nothing
// on that line and the window opens on the OS preference whatever the user had
// chosen. These cases pin the second address, including the two ways a narrow
// reader can go wrong: reading a DIFFERENT row's field, and missing the row when
// it is the last thing in the file.

/** A profile patch with the ui-theme row somewhere among other rows. */
const patch = (rows) => ['# generated by the desktop shell', ...rows].join('\n')

test('the profile patch answers with the ui-theme row\'s own preference', () => {
  const text = patch([
    '- id: llm-deepseek',
    '  config:',
    '    apiKey: sk-not-a-real-key',
    '- id: ui-theme',
    "  name: '@deepseek-ai/dsh-ui-theme'",
    '  config:',
    '    preference: dark',
    '- id: agent-presets',
    '  config:',
    '    default: standard',
  ])
  assert.equal(parseThemePreferenceFromPatch(text), 'dark')
})

test('a preference under ANOTHER row is not the theme\'s', () => {
  // The locale plugin keeps its own `preference` (and the sibling parser above
  // exists for exactly this reason). The row is the unit, not the field.
  const text = patch([
    '- id: locale',
    '  config:',
    '    preference: en-US',
    '- id: ui-theme',
    '  config:',
    '    colorScheme: auto',
  ])
  assert.equal(parseThemePreferenceFromPatch(text), null)
})

test('the row is read when it is the LAST thing in the file', () => {
  // The scan stops at the next top-level entry; EOF has to read as a stop too,
  // or the value of the final row would never be seen.
  const text = patch([
    '- id: ui-theme',
    '  config:',
    '    preference: light',
  ])
  assert.equal(parseThemePreferenceFromPatch(text), 'light')
})

test('a patch with no ui-theme row, an unknown value, or no file answers null', () => {
  assert.equal(parseThemePreferenceFromPatch(patch(['- id: locale', '  config:', '    preference: zh-CN'])), null)
  assert.equal(parseThemePreferenceFromPatch(patch(['- id: ui-theme', '  config:', '    preference: sepia'])), null)
  assert.equal(parseThemePreferenceFromPatch(''), null)
  assert.equal(readThemePreferenceFromPatch(path.join(os.tmpdir(), 'dsh-theme-does-not-exist.yml')), null)
})

test('a quoted preference is unquoted like the settings document\'s is', () => {
  const text = patch(['- id: ui-theme', '  config:', "    preference: 'dark'"])
  assert.equal(parseThemePreferenceFromPatch(text), 'dark')
})

test('the window path RESOLVES the persisted preference, not just the OS one', () => {
  // Every parser above passed while the splash still ignored all of them: the
  // module that owns the window called `applyWindowTheme()` and never called
  // `applyThemePreference()`, so the setting was read correctly by every unit
  // test and reached no user — measured on a real boot, the startup page painted
  // `data-theme="light"` while the preference was `dark`.
  //
  // A structural check is the only kind that can see that: an unwired function
  // has no return value to assert on. It is deliberately narrow (the call is in
  // the function that binds the splash to its window) rather than a general
  // "was it called" analysis.
  const source = readFileSync(path.join(ROOT, 'src', 'main', 'startup-window.ts'), 'utf8')
  const attach = /export function attachSplashToWindow\([^)]*\)[^{]*\{([\s\S]*?)\n\}/u.exec(source)
  assert.ok(attach !== null, 'attachSplashToWindow is where the splash is bound to its window')
  assert.match(attach[1], /applyThemePreference\(\)/u, 'the window path must resolve the persisted preference')
  assert.match(attach[1], /applyWindowTheme\(\)/u, 'and paint with what it resolved')
})
