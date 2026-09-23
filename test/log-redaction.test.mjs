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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
const { composeSuitePatch, filterUnresolvableRows, legacyTail, marketManagedBlock, parseSuitePatch, relativePatchSpecifiers, specifierResolves, unloadableRows, writePatchAtomically } = require('../dist/main/brand-suite.js')

test('redact keeps the key name and drops the value in every shape we see', () => {
  // JSON pairs (the shape dsh prints in its own diagnostics).
  assert.equal(redact('{"apiKey": "sk-1234567890"}'), '{"apiKey": "[redacted]"}')
  assert.equal(redact("{'authorization': 'Bearer abc.def'}"), "{'authorization': '[redacted]'}")
  // A Set-Cookie header: every attribute after the name is session material.
  assert.match(redact('set-cookie: sid=abc123; Path=/; HttpOnly'), /^set-cookie: \[redacted\]$/u)
  assert.equal(redact('{"set-cookie": "session=xyz; Path=/"}'), '{"set-cookie": "[redacted]"}')
  // node's inspect() prints single-quoted pairs, and a child's dump reaches
  // the logs verbatim — this shape leaked before the rule covered it.
  assert.equal(redact("{'set-cookie': 'sid=abc; Path=/'}"), "{'set-cookie': '[redacted]'}")
  // The bare rule must not eat the line break and the next line.
  assert.equal(redact('set-cookie: sid=1\nnext line kept'), 'set-cookie: [redacted]\nnext line kept')
  // A bearer token carries no key name at all.
  assert.equal(redact('Authorization failed for bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'), 'Authorization failed for bearer [redacted]')
  // A JWT, the bearer token's encoded form, with no key name in sight.
  assert.equal(redact('got token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_X'), 'got token [redacted]')
  // A provider key prefix with no key name.
  assert.equal(redact('request failed for sk-abcdef0123456789abcd'), 'request failed for [redacted]')
  // Query strings: the bare rule below would otherwise swallow the whole URL.
  assert.equal(redact('GET /?token=abc123&next=/x'), 'GET /?token=[redacted]&next=/x')
  // Bare key=value and key: value.
  assert.equal(redact('api_key=secret-value rest'), 'api_key=[redacted] rest')
  assert.equal(redact('password: hunter2'), 'password: [redacted]')
  // Case-insensitive, and the credential name itself survives for debugging.
  assert.match(redact('TOKEN=abc'), /^TOKEN=\[redacted\]$/u)
  // The word "bearer" outside an actual token stays readable.
  assert.equal(redact('using bearer auth for the upstream'), 'using bearer auth for the upstream')
  // An ordinary hyphenated word starting in "sk" is not a key.
  assert.equal(redact('task-tracking shows no problems'), 'task-tracking shows no problems')
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

test('the plugin market block survives a regeneration', () => {
  // The market appends its managed block past the home marker, where a rewrite
  // did not read: every start silently re-enabled the plugins a user had just
  // switched off, and the reason they switched them off came back with them.
  const market = [
    '# ── plugin-market managed disables ──',
    '- id: broken-plugin',
    '  disabled: true',
    '# ── end managed ──',
  ].join('\n')
  const first = composeSuitePatch({ suite: SHIPPED, preserved: '', home: HOME, managed: market })
  assert.ok(first.includes(market))
  // A second start reads the block back out of the file (it sits after the home
  // marker) and keeps it there — once, with its rows intact.
  const withoutBlock = first.replace(market, '')
  const again = composeSuitePatch({
    suite: SHIPPED,
    preserved: parseSuitePatch(withoutBlock).preserved,
    home: HOME,
    managed: marketManagedBlock(first),
  })
  assert.equal(again, first)
  assert.equal(again.match(/- id: broken-plugin/gu)?.length, 1)
  // A file that never had one stays without one.
  assert.equal(marketManagedBlock(composeSuitePatch({ suite: SHIPPED, preserved: '', home: HOME })), '')
  // A hand-truncated block (no footer) is left to the market to repair.
  assert.equal(marketManagedBlock('# ── plugin-market managed disables ──\n- id: x\n'), '')
})

test('rows the kernel appends past the home section survive a regeneration', () => {
  // 0.1.7 keeps user SETTINGS in this file: the kernel's configuration editor
  // parses the profile patch as a YAML document and appends a row for the entry
  // whose config changed (`packages/boot/config-editor`). The regenerator
  // re-derives the file from its named sections, so without a marker for
  // "everything past the shell's own text" that row was dropped on the next
  // start and the user's setting went with it. Measured on a copy of the real
  // profile patch with the very document API the kernel uses: the row lands
  // after the home section whenever the home section is not a trailing comment
  // block — always in dev (the home rows are copied in) and in production as
  // soon as the plugin market has written its own block.
  const settingsRow = [
    '- id: agent-default-model',
    '  config:',
    '    provider: littlejochen',
    '    model: deepseek-v4.1-flash',
  ].join('\n')

  const first = composeSuitePatch({ suite: SHIPPED, preserved: '', home: HOME })
  assert.ok(first.includes('@@dsh-app-rows:tail'), 'the shell marks where its own text ends')

  // The kernel appends its row after everything the shell wrote.
  const kernelWrote = `${first}${settingsRow}\n`

  // The next start carries it, once, byte for byte.
  const read = parseSuitePatch(kernelWrote)
  const again = composeSuitePatch({ suite: SHIPPED, preserved: read.preserved, home: HOME, tail: read.tail })
  assert.equal(again, kernelWrote)
  assert.equal(again.match(/- id: agent-default-model/gu)?.length, 1)

  // And it stays put across further starts — the regeneration is idempotent.
  const third = parseSuitePatch(again)
  assert.equal(composeSuitePatch({ suite: SHIPPED, preserved: third.preserved, home: HOME, tail: third.tail }), again)
})

test('a patch written before the tail marker adopts its trailing rows once', () => {
  // Files the previous shell wrote end with the home section and say nothing
  // about what follows it. The recovery anchors on that exact text — the home
  // section this start would write — and takes what comes after it.
  const settingsRow = ['- id: llm-deepseek', '  config: { models: [] }'].join('\n')
  const legacy = composeSuitePatch({ suite: SHIPPED, preserved: '', home: HOME })
    .replace('# @@dsh-app-rows:tail\n', '')
  assert.ok(!legacy.includes('@@dsh-app-rows:tail'))

  assert.equal(parseSuitePatch(legacy).tail, '')
  assert.equal(legacyTail(legacy, HOME), '')
  assert.equal(legacyTail(`${legacy}${settingsRow}\n`, HOME), settingsRow)

  // A file whose home section is NOT the one this start would write is not
  // guessed at: the caller keeps a copy aside instead (undefined here).
  assert.equal(legacyTail(legacy, '- id: something-else\n  config: {}\n'), undefined)
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

// --------------------------------- rows an EARLIER build commented out
//
// A judgement that was wrong once leaves text behind: the pre-0.1.7 reader took
// config VALUES for package names, so a provider row carrying a model list was
// commented out and, before this, stayed that way through every later start —
// measured on the machine this was written for, the user's model list came back
// empty after two shell upgrades because the file still held the dead row.

/** A row commented out exactly the way {@link filterUnresolvableRows} writes one. */
function commentedOut(why, row) {
  return [
    `# [dsh-app] NOT LOADED: "${why}" does not resolve from this profile.`,
    ...row.replace(/\n$/u, '').split('\n').map((line) => (line.startsWith('#') ? line : `# ${line}`)),
    '',
  ].join('\n')
}

/** The row the wrong judgement killed: a custom provider, its models a config value. */
const PI_AI_ROW = "- insert:\n    - id: llm-pi-ai\n      name: '@deepseek-ai/dsh-llm-pi-ai'\n      config:\n        models: 'deepseek-v4-flash,deepseek-v4-pro'\n"

test('a row an older build commented out comes back once it resolves', () => {
  const { profileDir, install } = fixtureProfile()
  install('@deepseek-ai/dsh-llm-pi-ai')
  const filtered = filterUnresolvableRows(commentedOut('deepseek-v4-flash,', PI_AI_ROW), profileDir)
  assert.deepEqual(filtered.restored, ['@deepseek-ai/dsh-llm-pi-ai'])
  assert.deepEqual(filtered.skipped, [])
  assert.equal(filtered.text, PI_AI_ROW)
  if (loadYaml() !== undefined) assert.doesNotThrow(() => loadYaml().load(filtered.text))
})

test('a row an older build commented out stays dead while it cannot load', () => {
  const { profileDir } = fixtureProfile()
  const dead = commentedOut('@deepseek-ai/dsh-not-installed', "- insert:\n    - id: ghost\n      name: '@deepseek-ai/dsh-not-installed'\n")
  const filtered = filterUnresolvableRows(dead, profileDir)
  assert.deepEqual(filtered.restored, [])
  // Byte-identical: the block keeps its marker, so the file still explains itself.
  assert.equal(filtered.text, dead)
})

test('a dead row holding a comment at column zero is left alone', () => {
  const { profileDir, install } = fixtureProfile()
  install('@deepseek-ai/dsh-mcp-client')
  // Marking a row prefixes `# ` to its lines and leaves an existing `#` line as it
  // is, so the marker cannot tell this comment from commented code. Un-commenting
  // it would put bare prose where the loader expects YAML — worse than the silent
  // omission the restore undoes, so the block keeps its comment.
  const row = "- insert:\n    - id: mcp-context7\n# keep this one first\n      name: '@deepseek-ai/dsh-mcp-client'\n"
  const dead = commentedOut('@deepseek-ai/dsh-mcp-client', row)
  const filtered = filterUnresolvableRows(dead, profileDir)
  assert.deepEqual(filtered.restored, [])
  assert.equal(filtered.text, dead)
})

test('two dead rows in a row are judged one at a time', () => {
  const { profileDir, install } = fixtureProfile()
  install('@deepseek-ai/dsh-mcp-client')
  const text = commentedOut('@deepseek-ai/dsh-mcp-client', "- insert:\n    - id: mcp-context7\n      name: '@deepseek-ai/dsh-mcp-client'\n")
    + commentedOut('@deepseek-ai/dsh-not-installed', "- insert:\n    - id: ghost\n      name: '@deepseek-ai/dsh-not-installed'\n")
  const filtered = filterUnresolvableRows(text, profileDir)
  assert.deepEqual(filtered.restored, ['@deepseek-ai/dsh-mcp-client'])
  assert.ok(filtered.text.includes("name: '@deepseek-ai/dsh-mcp-client'"), 'the loadable row is live again')
  assert.ok(filtered.text.includes('NOT LOADED: "@deepseek-ai/dsh-not-installed"'), 'the unloadable one keeps its marker')
  if (loadYaml() !== undefined) assert.doesNotThrow(() => loadYaml().load(filtered.text))
})

test('a fixed judgement undoes an older one through the whole composition', () => {
  const { profileDir, install } = fixtureProfile()
  install('@deepseek-ai/dsh-llm-pi-ai')
  // What the old build left on disk: the composed file, its provider row dead.
  const asWritten = composeSuitePatch({ suite: '', preserved: commentedOut('deepseek-v4-flash,', PI_AI_ROW), home: '' })
  const filtered = filterUnresolvableRows(asWritten, profileDir)
  assert.deepEqual(filtered.restored, ['@deepseek-ai/dsh-llm-pi-ai'])
  assert.ok(!filtered.text.includes('NOT LOADED'))
  assert.ok(parseSuitePatch(filtered.text).preserved.includes("name: '@deepseek-ai/dsh-llm-pi-ai'"))
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

test('unloadableRows names the home-layer rows a profile cannot load, with their lines', () => {
  const { profileDir } = fixtureProfile()
  installTo(path.join(profileDir, 'node_modules'), '@deepseek-ai/dsh-present')
  const text = [
    '# a comment',
    '- insert:',
    '    - id: ok-one',
    "      name: '@deepseek-ai/dsh-present'",
    '',
    '- insert:',
    '    - id: bad-one',
    "      name: '@deepseek-ai/dsh-gone'",
    '- id: later',
    "  name: './local-plugins/missing.mjs'",
  ].join('\n')
  // The line numbers are what make the finding actionable: they go straight to
  // the failure card, next to the file the user has to open.
  assert.deepEqual(unloadableRows(text, profileDir), [
    { specifier: '@deepseek-ai/dsh-gone', line: 8 },
    { specifier: './local-plugins/missing.mjs', line: 10 },
  ])
})

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

test('writePatchAtomically installs the composition whole, with no staging file left behind', async () => {
  const { profileDir } = fixtureProfile()
  const target = path.join(profileDir, 'cordis.patch.yml')
  writeFileSync(target, 'previous composition\n')
  await writePatchAtomically(target, 'new composition\n')
  assert.equal(readFileSync(target, 'utf8'), 'new composition\n')
  // The staging file is what an interrupted write would leave in a directory the
  // host reads at every start.
  assert.deepEqual(readdirSync(profileDir).filter((name) => name.endsWith('.tmp')), [])
})

test('writePatchAtomically keeps what is at the target when the install cannot land', async () => {
  const { profileDir } = fixtureProfile()
  const target = path.join(profileDir, 'cordis.patch.yml')
  // A non-empty directory cannot be replaced by a rename on any platform. This
  // is the observable half of "the target is never removed first": an install
  // that fails has to leave the composition that was already there intact.
  mkdirSync(target)
  writeFileSync(path.join(target, 'composition.txt'), 'still here\n')
  await assert.rejects(writePatchAtomically(target, 'new composition\n'), (error) => {
    return /^(EPERM|EACCES|EBUSY|EISDIR|ENOTEMPTY|EEXIST)$/u.test(error.code)
  })
  assert.equal(readFileSync(path.join(target, 'composition.txt'), 'utf8'), 'still here\n')
  assert.deepEqual(readdirSync(profileDir).filter((name) => name.endsWith('.tmp')), [])
})

test('a nested composition is not judged against the profile, so one bad name cannot sink the row', () => {
  // Measured on a real home layer: one migrated `@deepseek-ai/dsh-agent-preset`
  // row carries a 35-name composition, and a single nested name that did not
  // resolve from the profile got the user's ENTIRE preset commented out. A
  // nested row's names are resolved by whoever mounts that composition (the
  // preset registry), and a mount failure is a warning the user can act on —
  // while a dropped row takes the preset away with no way back.
  const { profileDir } = fixtureProfile()
  const row = [
    '- insert:',
    '    - id: preset-rsi-dev',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: rsi-dev',
    '        plugins:',
    '          - id: nested',
    "            name: '@deepseek-ai/dsh-nested-not-installed'",
    '',
  ].join('\n')
  const filtered = filterUnresolvableRows(row, profileDir)
  // ONLY the row's own entry is reported; the nested name is not this profile's
  // to judge. Before the fix this list carried both, and the row was dropped.
  assert.deepEqual(filtered.skipped, ['@deepseek-ai/dsh-agent-preset'])

  // With the installation closure in play the own name resolves too, and the row
  // survives verbatim — the shape the real home layer has.
  const closure = mkdtempSync(path.join(os.tmpdir(), 'dsh-app-preset-closure-'))
  installInto(path.join(closure, '@deepseek-ai', 'dsh-agent-preset'), '@deepseek-ai/dsh-agent-preset')
  const kept = filterUnresolvableRows(row, profileDir, [closure])
  assert.deepEqual(kept.skipped, [])
  assert.equal(kept.text, row, 'the row is kept verbatim')

  // The gate still works on the row's OWN entry: same shape, own name missing.
  const own = row.replace("'@deepseek-ai/dsh-agent-preset'", "'@deepseek-ai/dsh-not-installed'")
  assert.deepEqual(filterUnresolvableRows(own, profileDir, [closure]).skipped, ['@deepseek-ai/dsh-not-installed'])
})

test('the installation closure is a resolution position, and a subpath resolves through its package root', () => {
  // The host resolves through a TABLE built from the running installation's
  // dependency closure (`createRuntimeResolution` → `collectInstallationScopePackages`),
  // not from the fallback DIRECTORY — which is a mirror and can lag. Measured:
  // the mirror still held the 0.1.6-era set while lacking three packages 0.1.7
  // ships, so the shell reported resolvable rows as unresolvable.
  const { profileDir } = fixtureProfile()
  const closure = mkdtempSync(path.join(os.tmpdir(), 'dsh-app-closure-'))
  installInto(path.join(closure, '@deepseek-ai', 'dsh-agent-preset'), '@deepseek-ai/dsh-agent-preset')
  installInto(path.join(closure, '@deepseek-ai', 'dsh-plugin-manager'), '@deepseek-ai/dsh-plugin-manager')

  assert.equal(specifierResolves('@deepseek-ai/dsh-agent-preset', profileDir), false, 'not in either mirror')
  assert.equal(specifierResolves('@deepseek-ai/dsh-agent-preset', profileDir, [closure]), true, 'the closure is the authority')
  // A SUBPATH has no `…/tools/package.json`; the package root is what must be
  // present. Building the path from the whole specifier reported every subpath
  // row unresolvable — and two of the three real ones are subpaths.
  assert.equal(specifierResolves('@deepseek-ai/dsh-plugin-manager/tools', profileDir, [closure]), true)
  assert.equal(specifierResolves('@deepseek-ai/dsh-plugin-manager/tools', profileDir), false)
  // A package nothing carries stays refused, subpath or not.
  assert.equal(specifierResolves('@deepseek-ai/dsh-nope/tools', profileDir, [closure]), false)
  assert.equal(specifierResolves('http-free-pkg', profileDir, [closure]), false)
})

/** Write one package's manifest at an explicit directory. */
function installInto(dir, packageName) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: packageName, version: '0.0.1' })}\n`)
}
