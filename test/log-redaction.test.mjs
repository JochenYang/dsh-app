// Guards on the shell's own text handling:
//   - redact(): a credential fragment must never reach a log file, an event or
//     the diagnostics the shell shows the user.
//   - the suite patch layer: the desktop host takes no `--patch` argument, so
//     the profile's cordis.patch.yml IS the composition the app boots. The
//     merge of shipped rows, rows the profile already carried and the user's
//     home layer has to be idempotent — a regeneration that keeps re-appending
//     or that drops the user's rows would corrupt the plugin tree silently.
//   - carried rows the profile cannot load: a row naming an uninstalled package
//     must not reach the loader (measured: "1 entry did not activate", which the
//     client's own boot audit turns into a page that never loads), and the row
//     must survive the skip so the user can install the package and re-enable it.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)

/**
 * js-yaml, when it happens to be installed. An independent reader for the
 * generated patch file: the structural assertions stand on their own, and this
 * adds the one check they cannot make — that the document really parses.
 */
function loadYaml() {
  try {
    return require('js-yaml')
  } catch {
    return undefined
  }
}
const { redact, MAX_LOG_LINE } = require('../dist/main/redact.js')
const { composeSuitePatch, filterUnresolvableRows, parseSuitePatch, relativePatchSpecifiers, specifierResolves } = require('../dist/main/brand-suite.js')

test('redact keeps the key name and drops the value in every shape we see', () => {
  // JSON pairs (the shape dsh prints in its own diagnostics).
  assert.equal(redact('{"apiKey": "sk-1234567890"}'), '{"apiKey": "[redacted]"}')
  assert.equal(redact("{'authorization': 'Bearer abc.def'}"), "{'authorization': '[redacted]'}")
  // Query strings: the bare rule below would otherwise swallow the whole URL.
  assert.equal(redact('GET /?token=abc123&next=/x'), 'GET /?token=[redacted]&next=/x')
  // Bare key=value and key: value.
  assert.equal(redact('api_key=secret-value rest'), 'api_key=[redacted] rest')
  assert.equal(redact('password: hunter2'), 'password: [redacted]')
  // Case-insensitive, and the credential name itself survives for debugging.
  assert.match(redact('TOKEN=abc'), /^TOKEN=\[redacted\]$/u)
})

test('redact leaves ordinary output alone', () => {
  assert.equal(redact('kernel activated dsh-0.1.5-rc.2+suite-98b0d32e'), 'kernel activated dsh-0.1.5-rc.2+suite-98b0d32e')
  assert.equal(redact(''), '')
  assert.ok(redact('a normal log line about tokens being loaded').includes('tokens being loaded'))
  assert.notEqual(redact('dsh host: /tmp/dsh-host/lib/index.js'), undefined)
})

test('redact caps a single line', () => {
  const capped = redact('x'.repeat(MAX_LOG_LINE * 2))
  assert.equal(capped.length, MAX_LOG_LINE)
})

const SHIPPED = '- insert:\n    - id: brand\n      name: "@dsh-app/plugin-brand"\n'
const HOME = '- id: mcp\n  config: {}\n'

test('the generated patch carries the shipped rows, the home layer and a preserved section', () => {
  const text = composeSuitePatch({ suite: SHIPPED, preserved: '', home: HOME })
  assert.ok(text.includes('@dsh-app/plugin-brand'))
  assert.ok(text.includes('- id: mcp'))
  // Empty sections leave their marker without a body.
  assert.match(text, /# @@dsh-app-rows:preserved\n# @@dsh-app-rows:home\n/u)
})

test('regenerating an unchanged patch is byte-identical (idempotent merge)', () => {
  const first = composeSuitePatch({ suite: SHIPPED, preserved: '', home: HOME })
  const second = composeSuitePatch({ suite: SHIPPED, preserved: parseSuitePatch(first).preserved, home: HOME })
  assert.equal(second, first)

  // And once more with a preserved body, which is where a naive append would
  // duplicate rows on every start.
  const withRows = composeSuitePatch({ suite: SHIPPED, preserved: '- id: keep\n  config: {}\n', home: HOME })
  const again = composeSuitePatch({ suite: SHIPPED, preserved: parseSuitePatch(withRows).preserved, home: HOME })
  assert.equal(again, withRows)
  assert.equal(again.match(/- id: keep/gu).length, 1)
})

test('a pre-A1 profile patch file is preserved verbatim on the first generation', () => {
  const previous = '- id: web\n  config:\n    searchProvider: dsh-app\n'
  const generated = composeSuitePatch({ suite: SHIPPED, preserved: parseSuitePatch(previous).preserved, home: HOME })
  assert.ok(generated.includes(previous.trim()))
  assert.equal(parseSuitePatch(generated).preserved, previous.trim())
})

test('safe mode drops the shipped rows and keeps the user ones', () => {
  const text = composeSuitePatch({ suite: '', preserved: '', home: HOME })
  assert.ok(!text.includes('@dsh-app/plugin-brand'))
  assert.ok(text.includes('- id: mcp'))
})

test('an empty flow section cannot break the generated file', () => {
  // The kernel writes `[]` for a profile that has no patch. Concatenating that
  // with block rows ENDS the YAML document, and the real failure read
  // `end of the stream or a document separator is expected` — on both kernel
  // lines, with the file never rewritten (the generator compares content, so a
  // broken file regenerates to itself). The empty section is dropped, with the
  // reason in its place.
  const text = composeSuitePatch({ suite: SHIPPED, preserved: '[]', home: HOME })
  assert.ok(!text.split('\n').some((line) => line.trim() === '[]'))
  assert.match(text, /# \[dsh-app\] an empty flow collection/u)
  assert.ok(text.includes('@dsh-app/plugin-brand'))
  assert.ok(text.includes('- id: mcp'))
  // Idempotent: the note reads back as the preserved section and stays put.
  const again = composeSuitePatch({ suite: SHIPPED, preserved: parseSuitePatch(text).preserved, home: HOME })
  assert.equal(again, text)
  // And the result is a document a YAML reader accepts, when one is at hand.
  const yaml = loadYaml()
  if (yaml !== undefined) assert.doesNotThrow(() => yaml.load(text))
})

test('the kernel patch template that ends in "[]" heals instead of bricking the file', () => {
  // The shape that actually occurred, taken from a user's profile: the kernel's
  // own template — three comment lines, then `[]`. A reader that only looked at
  // the FIRST character of the section classified this as block text and let the
  // `[]` through, which is the file that failed with
  // `end of the stream or a document separator is expected (274:1)`.
  const template = [
    '# Your patch layer for this dsh profile, applied after every bundle layer:',
    '# a top-level YAML array of loader patch entries (id-targeted config',
    '# overrides, disables, and insert lists; `!!js` expressions allowed).',
    '[]',
  ].join('\n')
  for (const home of ['', HOME]) {
    const text = composeSuitePatch({ suite: SHIPPED, preserved: template, home })
    assert.ok(!text.split('\n').some((line) => line.trim() === '[]'), `bare [] left with home=${JSON.stringify(home)}`)
    assert.match(text, /an empty flow collection/u)
    assert.ok(text.includes('@dsh-app/plugin-brand'))
    // Stable: the notes read back as the preserved section and stay put, so a
    // healed machine does not flip between two files on every start.
    assert.equal(composeSuitePatch({ suite: SHIPPED, preserved: parseSuitePatch(text).preserved, home }), text)
    if (home !== '') assert.ok(text.includes('- id: mcp'), 'the home rows must still travel')
    if (loadYaml() !== undefined) assert.doesNotThrow(() => loadYaml().load(text))
  }
})

test('a non-empty flow section is kept visible but inert', () => {
  const text = composeSuitePatch({ suite: SHIPPED, preserved: '[{id: x}]', home: HOME })
  assert.match(text, /NOT MERGED/u)
  assert.ok(text.includes('# [{id: x}]'))
  assert.ok(!text.split('\n').some((line) => /^[[{]/u.test(line.trim())))
})



/** A throwaway profile under a fake $DSH_HOME layout. */
function fixtureProfile() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-app-patch-'))
  const profileDir = path.join(home, 'profiles', 'dsh-app')
  mkdirSync(profileDir, { recursive: true })
  const install = (packageName, into = path.join(profileDir, 'node_modules')) => {
    const dir = path.join(into, ...packageName.split('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: packageName, version: '0.0.1' })}\n`)
  }
  return { profileDir, install }
}

test('a carried row whose package this profile has is kept verbatim', () => {
  const { profileDir, install } = fixtureProfile()
  install('@deepseek-ai/dsh-mcp-client')
  const row = "- insert:\n    - id: mcp-context7\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: context7\n"
  const filtered = filterUnresolvableRows(row, profileDir)
  assert.equal(filtered.text, row)
  assert.deepEqual(filtered.skipped, [])
})

test('the kernel-provided packages count as resolvable through the shared fallback', () => {
  const { profileDir, install } = fixtureProfile()
  // $DSH_HOME/profiles/node_modules is where the harness links the kernel's own
  // closure — a package the profile never installed still resolves.
  install('@deepseek-ai/dsh-schedule', path.join(profileDir, '..', 'node_modules'))
  const row = "- insert:\n    - id: schedule\n      name: '@deepseek-ai/dsh-schedule'\n"
  assert.deepEqual(filterUnresolvableRows(row, profileDir).skipped, [])
})

test('a carried row naming an uninstalled package is commented out and reported', () => {
  const { profileDir } = fixtureProfile()
  const row = "- insert:\n    - id: ghost\n      name: '@deepseek-ai/dsh-not-installed'\n      config:\n        keep: this\n"
  const filtered = filterUnresolvableRows(row, profileDir)
  assert.deepEqual(filtered.skipped, ['@deepseek-ai/dsh-not-installed'])
  assert.equal(filtered.text, `# [dsh-app] NOT LOADED: "@deepseek-ai/dsh-not-installed" does not resolve from this profile.\n${row.split('\n').filter((line) => line !== '').map((line) => `# ${line}`).join('\n')}\n`)
  // The row is recoverable: the shell's own reader still hands it back intact.
  assert.equal(parseSuitePatch(filtered.text).preserved, filtered.text.trim())
})

test('a config key called name is not read as a package entry', () => {
  const { profileDir } = fixtureProfile()
  // No sibling `id:` at that indent, so this is a plugin's own config value —
  // dropping the row over it would silently remove a user's configuration.
  const row = "- id: usage-heatmap\n  config:\n    name: not-a-package-name\n"
  const filtered = filterUnresolvableRows(row, profileDir)
  assert.equal(filtered.text, row)
  assert.deepEqual(filtered.skipped, [])
  // A row without any entry keeps its place too (a plain enable/disable override).
  assert.equal(filterUnresolvableRows('- id: web-search-deepseek\n  disabled: true\n', profileDir).text, '- id: web-search-deepseek\n  disabled: true\n')
})

test('filtering is idempotent: a commented row is not a row any more', () => {
  const { profileDir } = fixtureProfile()
  const row = "- insert:\n    - id: ghost\n      name: '@deepseek-ai/dsh-not-installed'\n"
  const once = filterUnresolvableRows(row, profileDir)
  const twice = filterUnresolvableRows(composeSuitePatch({ suite: '', preserved: once.text, home: '' }), profileDir)
  assert.deepEqual(twice.skipped, [])
  assert.equal(twice.text.match(/NOT LOADED/gu)?.length, 1)
})

// ------------------------------------------- carried rows that name a FILE

/** The row shape measured on a real profile: a local plugin named relatively. */
const LOCAL_ROW = "- include:\n    - id: local-provider\n      name: ./local-plugins/local-provider.mjs\n"

test('a carried row naming a missing file is commented out, not left to fail the tree', () => {
  const { profileDir } = fixtureProfile()
  // Left in place this is not a warning: the loader's own `import` throws and
  // the WHOLE tree fails, on every kernel line including a rollback target, so
  // the app reaches no window at all. Measured on a real profile.
  const filtered = filterUnresolvableRows(LOCAL_ROW, profileDir)
  assert.deepEqual(filtered.skipped, ['./local-plugins/local-provider.mjs'])
  assert.match(filtered.text, /^# \[dsh-app\] NOT LOADED: "\.\/local-plugins\/local-provider\.mjs"/u)
  // Recoverable the same way an uninstalled package is.
  assert.equal(parseSuitePatch(filtered.text).preserved, filtered.text.trim())
})

test('a carried row naming a file that is there is kept verbatim', () => {
  const { profileDir } = fixtureProfile()
  const file = path.join(profileDir, 'local-plugins', 'local-provider.mjs')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, 'export default {}\n')
  const filtered = filterUnresolvableRows(LOCAL_ROW, profileDir)
  assert.equal(filtered.text, LOCAL_ROW)
  assert.deepEqual(filtered.skipped, [])
})

test('a relative specifier is judged from the profile directory', () => {
  const { profileDir } = fixtureProfile()
  const shared = path.join(profileDir, '..', 'shared', 'helper.mjs')
  mkdirSync(path.dirname(shared), { recursive: true })
  writeFileSync(shared, 'export default {}\n')
  const row = "- include:\n    - id: from-parent\n      name: ../shared/helper.mjs\n"
  assert.deepEqual(filterUnresolvableRows(row, profileDir).skipped, [])
  assert.equal(specifierResolves('../shared/helper.mjs', profileDir), true)
  assert.equal(specifierResolves('../shared/gone.mjs', profileDir), false)
})

test('a cordis builtin is never judged', () => {
  const { profileDir } = fixtureProfile()
  const row = "- include:\n    - id: builtin\n      name: cordis:include\n"
  assert.deepEqual(filterUnresolvableRows(row, profileDir).skipped, [])
  assert.equal(specifierResolves('cordis:include', profileDir), true)
})

test('a row naming a file the loader cannot import is commented out too', () => {
  const { profileDir } = fixtureProfile()
  // Existence is not loadability: the kernel hands a relative specifier straight
  // to Node's ESM resolver, which refuses an unknown extension — so a typed
  // `.txt` would take the tree down exactly like a missing file.
  const notes = path.join(profileDir, 'local-plugins', 'notes.txt')
  mkdirSync(path.dirname(notes), { recursive: true })
  writeFileSync(notes, 'just notes\n')
  const row = "- include:\n    - id: notes\n      name: ./local-plugins/notes.txt\n"
  assert.deepEqual(filterUnresolvableRows(row, profileDir).skipped, ['./local-plugins/notes.txt'])
  // The same directory, same row, with a script extension: kept.
  writeFileSync(path.join(profileDir, 'local-plugins', 'plugin.mjs'), 'export default {}\n')
  assert.equal(specifierResolves('./local-plugins/notes.txt', profileDir), false)
  assert.equal(specifierResolves('./local-plugins/plugin.mjs', profileDir), true)
})

test('a quoted path value with a space in it is read like any other row', () => {
  const { profileDir } = fixtureProfile()
  // How a path with a space is written — and a reader that cannot see this row
  // would neither carry the file nor keep it out of the loader.
  const row = '- include:\n    - id: spaced\n      name: "./my plugins/local provider.mjs"\n'
  assert.deepEqual(relativePatchSpecifiers(row), ['./my plugins/local provider.mjs'])
  assert.deepEqual(filterUnresolvableRows(row, profileDir).skipped, ['./my plugins/local provider.mjs'])
  const file = path.join(profileDir, 'my plugins', 'local provider.mjs')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, 'export default {}\n')
  assert.equal(filterUnresolvableRows(row, profileDir).text, row)
  // Single quotes, and a `#` inside the value, read the same way.
  const hashRow = "- include:\n    - id: hash\n      name: './local-plugins/a#b.mjs'\n"
  assert.deepEqual(relativePatchSpecifiers(hashRow), ['./local-plugins/a#b.mjs'])
  // A trailing comment after a bare value is still a comment.
  const commented = "- include:\n    - id: c\n      name: ./local-plugins/c.mjs # keep this\n"
  assert.deepEqual(relativePatchSpecifiers(commented), ['./local-plugins/c.mjs'])
})

test('a package only an ancestor of the profile carries does not count as resolvable', () => {
  const { profileDir } = fixtureProfile()
  // `createRequire`'s upward walk would accept this one: it lives two levels
  // above the profile, in the fake home. The host's enforcing resolver reads the
  // profile and the shared fallback, and nothing else — keeping such a row means
  // the client's boot audit refuses the whole page over it.
  const stray = path.join(profileDir, '..', '..', 'node_modules', '@deepseek-ai', 'dsh-stray')
  mkdirSync(stray, { recursive: true })
  writeFileSync(path.join(stray, 'package.json'), '{"name":"@deepseek-ai/dsh-stray"}\n')
  const row = "- insert:\n    - id: stray\n      name: '@deepseek-ai/dsh-stray'\n"
  assert.deepEqual(filterUnresolvableRows(row, profileDir).skipped, ['@deepseek-ai/dsh-stray'])
  assert.equal(specifierResolves('@deepseek-ai/dsh-stray', profileDir), false)
  // The shared fallback IS read, one level up where the harness links it.
  installTo(path.join(profileDir, '..', 'node_modules'), '@deepseek-ai/dsh-fallback')
  assert.equal(specifierResolves('@deepseek-ai/dsh-fallback', profileDir), true)
})

/** Install one package's manifest into a node_modules directory. */
function installTo(nodeModules, packageName) {
  const dir = path.join(nodeModules, ...packageName.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: packageName, version: '0.0.1' })}\n`)
}

test('relativePatchSpecifiers reads entry fields only, and dedupes', () => {
  const rows = [
    LOCAL_ROW,
    // A config key called `name` is not an entry: no sibling `id:` at that indent.
    "- id: usage-heatmap\n  config:\n    name: ./not-a-path.mjs\n",
    // The same path again: one entry in the list.
    LOCAL_ROW,
    "- insert:\n    - id: pkg\n      name: '@deepseek-ai/dsh-mcp-client'\n",
  ].join('')
  assert.deepEqual(relativePatchSpecifiers(rows), ['./local-plugins/local-provider.mjs'])
})
