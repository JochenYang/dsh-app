// The profile patch belongs to the KERNEL, and the shell must not touch it.
//
// 0.1.7 keeps user SETTINGS in `<profile>/cordis.patch.yml`: the kernel's
// configuration editor parses that file as a YAML document, mutates the sequence,
// and serialises the whole document back (`node_modules/@deepseek-ai/
// dsh-config-editor/lib/index.js`, `edit()` — `parseDocument` → `document.add` /
// `setIn` → `String(document)`). Every setting the user changes reaches the file
// that way.
//
// This shell used to regenerate that same file on every start from named sections,
// keeping "everything after the tail marker" verbatim. The marker was a COMMENT,
// and a serializer places a newly added sequence item after the last ITEM — so
// where the kernel's row landed in the text depended on what the sequence's last
// row was, not on where the marker sat. Measured: on a fresh profile it landed
// inside the section the shell re-derived from the shipped overlay, and the
// setting was gone on the next start; every setting stored against a row the
// overlay itself carries (`web`, `deepseek-account`) went the same way.
//
// The fix is that the shell stops writing the file: the suite's rows travel in a
// bundle layer the profile names, and the kernel is the only writer left. So these
// tests assert the property that makes the fix hold, at the level a caller can
// observe:
//
//   - the kernel's write is never undone, wherever in the file it lands;
//   - the shell's start-up work does not modify the file at all.
//
// They deliberately do NOT assert HOW a row is delivered. The previous revision of
// this file pinned "the row must land in the tail region", which was the old
// mechanism's internal detail; a fix that removes the regeneration entirely would
// have failed that assertion while being more correct. See
// docs/profile-patch-regeneration-regression.md §4 (R1/R2) for the migration's own
// contract, which lives in test/suite-layer.test.mjs.
//
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { removeTree } from '../scripts/lib/remove-tree.mjs'

const require = createRequire(import.meta.url)
const { installSuiteLayer } = require('../dist/main/suite-layer.js')

const OVERLAY = readFileSync(path.join(import.meta.dirname, '..', 'dist', 'main', 'dsh-app.patch.yml'), 'utf8')

/**
 * The kernel's OWN `yaml`, resolved through its consumer's package rather than from
 * this repository's root. Its `parseDocument` behaviour is what decides where an
 * added row lands, so a different copy would test a different thing. Undefined when
 * the kernel packages are not installed, in which case the tests skip.
 */
function kernelYaml() {
  for (const anchor of ['@deepseek-ai/dsh-config-editor/package.json', '@deepseek-ai/dsh-settings/package.json']) {
    try {
      return createRequire(require.resolve(anchor))('yaml')
    } catch {
      // Try the next anchor.
    }
  }
  return undefined
}

const yaml = kernelYaml()

/**
 * One settings write the way the KERNEL performs it.
 *
 * Transcribed from `dsh-config-editor`'s `edit()`: parse the document, walk to the
 * row with this id (or add one at the end of the sequence), then serialise the
 * whole document — comments, markers and all. The string this returns is what lands
 * on disk.
 */
function kernelWriteSetting(text, id, name, config) {
  const document = yaml.parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => value }] })
  if (document.errors[0] !== undefined) throw document.errors[0]
  if (!document.contents || document.contents.constructor.name !== 'YAMLSeq') {
    throw new Error('Profile patch must be a YAML sequence')
  }
  document.contents.flow = false
  const items = document.contents.items
  const index = items.findLastIndex((item, at) => item && document.getIn([at, 'id']) === id && !item.has('insert'))
  if (index < 0) document.add(document.createNode({ id, name, config }))
  else document.setIn([index, 'config'], document.createNode(config))
  return String(document)
}

/** The `config` a document assigns to one entry, read through the kernel's parser. */
function storedConfigOf(text, id) {
  for (const item of yaml.parse(text) ?? []) {
    if (item !== null && typeof item === 'object' && item.id === id && item.config !== undefined) return item.config
  }
  return undefined
}

/**
 * One profile under a throwaway `$DSH_HOME`, with the given profile patch.
 *
 * `installSuiteLayer` is the shell's whole start-up relationship with that file
 * now, so it is what these tests drive.
 */
function profileWith(patchText, { overlay = OVERLAY } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-kernel-rows-'))
  const profileDir = path.join(home, 'profiles', 'dsh-app')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-dsh-app',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }, undefined, 2)}\n`, 'utf8')
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), patchText, 'utf8')
  return {
    profileDir,
    patchFile: path.join(profileDir, 'cordis.patch.yml'),
    read: () => readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8'),
    /** Run one start-up pass. */
    async start() {
      const previous = process.env.DSH_HOME
      process.env.DSH_HOME = home
      try {
        return await installSuiteLayer({ profileDir, overlay, report: () => {} })
      } finally {
        if (previous === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previous
      }
    },
    // Through the link-safe walker, not a sync recursive delete: this is a
    // PROFILE tree, and a profile is exactly the shape that can hold a junction
    // (the project's own doctrine — a sync recursive delete follows one and can
    // empty the tree it points at).
    cleanup: () => removeTree(home),
  }
}

test('a setting the kernel stores on a FRESH profile survives the next start', { skip: yaml === undefined ? 'the kernel packages are not installed' : false }, async () => {
  // The user's very first setting change — 设置 → 通用 → 外观 → 深色. The profile was
  // seeded from the kernel's own template and the shell has run its start-up pass.
  const fixture = profileWith('# Your patch layer for this dsh profile.\n[]\n')
  try {
    await fixture.start()
    const afterFirstStart = fixture.read()

    // The kernel stores the setting. Where in the text it lands is the kernel's
    // business; that it lands at all, and stays, is the user's.
    const afterKernel = kernelWriteSetting(afterFirstStart, 'ui-theme', '@deepseek-ai/dsh-ui-theme', { preference: 'dark' })
    writeFileSync(fixture.patchFile, afterKernel, 'utf8')

    await fixture.start()
    assert.equal(
      storedConfigOf(fixture.read(), 'ui-theme')?.preference,
      'dark',
      'the setting was dropped by the next start',
    )
  } finally {
    await fixture.cleanup()
  }
})

test('a setting stored on a row the SHIPPED OVERLAY itself carries survives', { skip: yaml === undefined ? 'the kernel packages are not installed' : false }, async () => {
  // The kernel edits these rows IN PLACE, and they are the rows the shipped overlay
  // carries (`web` — the provider pair; `deepseek-account` — the identity header).
  // The assertion reads the stored VALUE through the kernel's own parser: the
  // overlay's comments mention these very values, so a substring check could pass
  // on a comment while the row itself was gone.
  const fixture = profileWith(`${OVERLAY.trimEnd()}\n`)
  try {
    await fixture.start()
    let text = fixture.read()
    for (const [id, name, config, key, value] of [
      ['web', '@deepseek-ai/dsh-web', { searchProvider: 'probe-provider', fetchProvider: 'http' }, 'searchProvider', 'probe-provider'],
      ['deepseek-account', '@deepseek-ai/dsh-deepseek-account', { desktopPlatform: 'probe-platform' }, 'desktopPlatform', 'probe-platform'],
    ]) {
      text = kernelWriteSetting(text, id, name, config)
      writeFileSync(fixture.patchFile, text, 'utf8')
    }
    await fixture.start()
    const after = fixture.read()
    assert.equal(storedConfigOf(after, 'web')?.searchProvider, 'probe-provider', 'the provider choice was lost')
    assert.equal(storedConfigOf(after, 'deepseek-account')?.desktopPlatform, 'probe-platform', 'the identity row was lost')
  } finally {
    await fixture.cleanup()
  }
})

test('two successive setting changes both survive', { skip: yaml === undefined ? 'the kernel packages are not installed' : false }, async () => {
  // An off-by-one here would lose the newest setting while appearing to keep the
  // older one, so both are asserted.
  const fixture = profileWith('# Your patch layer for this dsh profile.\n[]\n')
  try {
    await fixture.start()
    let text = fixture.read()
    text = kernelWriteSetting(text, 'ui-theme', '@deepseek-ai/dsh-ui-theme', { preference: 'dark' })
    text = kernelWriteSetting(text, 'ui-settings-general', '@deepseek-ai/dsh-ui-settings-general', { welcomeNoticeVersion: '2026-08-13.1' })
    writeFileSync(fixture.patchFile, text, 'utf8')

    await fixture.start()
    const after = fixture.read()
    assert.equal(storedConfigOf(after, 'ui-theme')?.preference, 'dark', 'the first setting was dropped')
    assert.equal(storedConfigOf(after, 'ui-settings-general')?.welcomeNoticeVersion, '2026-08-13.1', 'the second setting was dropped')
  } finally {
    await fixture.cleanup()
  }
})

test('the shell\'s start-up pass does not modify the profile patch once it has settled', { skip: yaml === undefined ? 'the kernel packages are not installed' : false }, async () => {
  // The property that makes every test above hold: after the one-time migration, a
  // start writes nothing at all. Measured by content and mtime, because a rewrite
  // that happens to produce identical bytes is still a rewrite that can race the
  // kernel's own writer.
  const fixture = profileWith(`${OVERLAY.trimEnd()}\n\n- id: ui-theme\n  config:\n    preference: dark\n`)
  try {
    await fixture.start()
    const settled = fixture.read()
    const settledMtime = statSync(fixture.patchFile).mtimeMs

    const second = await fixture.start()
    assert.equal(second.status, 'already', 'a settled profile has nothing left to install')
    assert.equal(fixture.read(), settled, 'the bytes changed')
    assert.equal(statSync(fixture.patchFile).mtimeMs, settledMtime, 'the file was rewritten')
  } finally {
    await fixture.cleanup()
  }
})

test('a start-up pass never drops a row it does not own', { skip: yaml === undefined ? 'the kernel packages are not installed' : false }, async () => {
  // The migration removes the shell's own `insert:` blocks and nothing else. A
  // hand-written third-party insert, a user's own override row and a kernel-written
  // setting row all have to come through.
  //
  // The third-party block names its OWN scope, which is what keeps it out of the
  // migration's reach: a block whose ids all resolve to `@dsh-app/…` is the suite's
  // however old it is (see `isSuiteInsertBlock`), so a fixture that used a suite
  // package name here would be asserting the opposite of the intended rule.
  const usersOwn = [
    '- insert:',
    '    - id: my-own-plugin',
    "      name: 'dsh-some-third-party'",
    '- id: usage-heatmap',
    '  disabled: true',
    '- id: ui-theme',
    '  config:',
    '    preference: dark',
  ].join('\n')
  const fixture = profileWith(`${OVERLAY.trimEnd()}\n\n${usersOwn}\n`)
  try {
    await fixture.start()
    const after = fixture.read()
    assert.ok(after.includes('my-own-plugin'), 'the user\'s own insert block was removed')
    assert.ok(after.includes('usage-heatmap'), 'the user\'s own row was removed')
    assert.equal(storedConfigOf(after, 'ui-theme')?.preference, 'dark', 'the kernel\'s setting row was removed')
    // And the overlay's own inserts really did go, or the migration did nothing.
    assert.ok(!after.includes('plugin-swarm'), 'the overlay\'s insert block is still there')
  } finally {
    await fixture.cleanup()
  }
})
