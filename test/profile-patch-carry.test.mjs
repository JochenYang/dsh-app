// The suite-profile migration carries the user's own patch layer into the newly
// created profile. That layer is only TEXT, and a row may name a FILE rather
// than a package (a local plugin under `./local-plugins/`). Measured on a real
// profile: carrying the text without the file left the new profile booting a
// composition whose single unresolvable entry failed the WHOLE tree
// (`ERR_MODULE_NOT_FOUND` → `plugin tree failed to load`), on the new kernel and
// on the one it rolled back to, so the app reached no window until the user
// restored the file by hand. These tests pin what travels, and what is refused.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { migrateSuiteProfile, SUITE_PROFILE_MARKER } = require('../dist/main/suite-profile.js')

const ROW = "- include:\n    - id: local-provider\n      name: ./local-plugins/local-provider.mjs\n"
const PLUGIN = 'export default { id: "local-provider" }\n'

/** A fake `$DSH_HOME` whose old `web` profile carries the row and the file. */
function fakeHome({ withPlugin = true, patch = ROW } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-app-seed-'))
  const legacy = path.join(home, 'profiles', 'web')
  mkdirSync(path.join(legacy, 'local-plugins'), { recursive: true })
  writeFileSync(path.join(legacy, 'cordis.patch.yml'), patch)
  if (withPlugin) writeFileSync(path.join(legacy, 'local-plugins', 'local-provider.mjs'), PLUGIN)
  writeFileSync(path.join(legacy, 'package.json'), '{"dependencies":{"@scope/one":"1.0.0"}}\n')
  return { home, legacy, target: path.join(home, 'profiles', 'dsh-app') }
}

/** Run one migration against `home`, leaving no DSH_HOME behind. */
async function migrate(home) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await migrateSuiteProfile()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

test('the migration carries a file the patch names, beside the patch', async () => {
  const { home, target } = fakeHome()
  const outcome = await migrate(home)
  assert.equal(outcome.status, 'seeded')
  assert.equal(outcome.carriedPatch, true)
  assert.deepEqual(outcome.carriedFiles, ['./local-plugins/local-provider.mjs'])
  assert.deepEqual(outcome.unresolvedFiles, [])
  // Byte-identical, and exactly where the row resolves it from.
  assert.equal(readFileSync(path.join(target, 'local-plugins', 'local-provider.mjs'), 'utf8'), PLUGIN)
  assert.equal(readFileSync(path.join(target, 'cordis.patch.yml'), 'utf8'), ROW)
  // The marker records what travelled, for the next reader of the profile.
  const marker = JSON.parse(readFileSync(path.join(target, SUITE_PROFILE_MARKER), 'utf8'))
  assert.deepEqual(marker.carriedFiles, ['./local-plugins/local-provider.mjs'])
  assert.equal(marker.legacyPackages, 1)
})

test('a file the HOME layer names is carried too: it resolves against the profile as well', async () => {
  const { home, target } = fakeHome()
  writeFileSync(path.join(home, 'cordis.patch.yml'), ROW)
  const outcome = await migrate(home)
  assert.deepEqual(outcome.carriedFiles, ['./local-plugins/local-provider.mjs'])
  assert.ok(existsSync(path.join(target, 'local-plugins', 'local-provider.mjs')))
})

test('a specifier pointing outside the old profile is refused, not followed', async () => {
  const { home, legacy } = fakeHome()
  writeFileSync(path.join(legacy, 'cordis.patch.yml'), "- include:\n    - id: outside\n      name: ../outside.mjs\n")
  writeFileSync(path.join(home, 'outside.mjs'), 'export default {}\n')
  const outcome = await migrate(home)
  assert.deepEqual(outcome.carriedFiles, [])
  assert.deepEqual(outcome.refusedFiles, ['../outside.mjs'])
  // Nothing was written at the path the specifier would have resolved to.
  assert.ok(!existsSync(path.join(home, 'profiles', 'outside.mjs')))
})

test('a symlink the patch names is not followed into the profile', async () => {
  const { home, legacy, target } = fakeHome({ withPlugin: false })
  const outside = path.join(home, 'outside-target.mjs')
  writeFileSync(outside, 'export default { leaked: true }\n')
  const link = path.join(legacy, 'local-plugins', 'local-provider.mjs')
  mkdirSync(path.dirname(link), { recursive: true })
  try {
    symlinkSync(outside, link, 'file')
  } catch {
    return // no symlink privilege in this environment: the fence is unverifiable here
  }
  const outcome = await migrate(home)
  assert.deepEqual(outcome.carriedFiles, [])
  assert.deepEqual(outcome.refusedFiles, ['./local-plugins/local-provider.mjs'])
  assert.ok(!existsSync(path.join(target, 'local-plugins', 'local-provider.mjs')))
})

test('a directory link in the middle of the path is refused: those bytes are not in the old profile', async () => {
  const { home, legacy, target } = fakeHome({ withPlugin: false })
  // The specifier resolves lexically INSIDE the old profile, so only the real
  // path shows that the bytes live elsewhere — and a link pointing at the
  // runtime tree would otherwise drag kernel files into the profile.
  const outside = path.join(home, 'real-plugins')
  mkdirSync(outside, { recursive: true })
  writeFileSync(path.join(outside, 'local-provider.mjs'), PLUGIN)
  try {
    // `junction` is the one link kind Windows creates without a privilege; on
    // POSIX the type is ignored and a plain symlink is made.
    symlinkSync(outside, path.join(legacy, 'local-plugins'), 'junction')
  } catch {
    return // no link privilege in this environment: the fence is unverifiable here
  }
  const outcome = await migrate(home)
  assert.deepEqual(outcome.carriedFiles, [])
  assert.deepEqual(outcome.refusedFiles, ['./local-plugins/local-provider.mjs'])
  assert.ok(!existsSync(path.join(target, 'local-plugins', 'local-provider.mjs')))
})

test('a CRLF patch carries its files too: the row reader is not fooled by the line ending', async () => {
  // Windows hand-editing produces CRLF, and a row reader anchored to the end of
  // a line would read such a row as one WITHOUT a specifier — silently neither
  // carried nor filtered, which is the failure this change exists to remove.
  const { home, target } = fakeHome({ patch: ROW.replace(/\n/gu, '\r\n') })
  const outcome = await migrate(home)
  assert.deepEqual(outcome.carriedFiles, ['./local-plugins/local-provider.mjs'])
  assert.ok(existsSync(path.join(target, 'local-plugins', 'local-provider.mjs')))
})

test('a specifier naming the shell\'s own state is refused, so the profile keeps its manifest', async () => {
  const { home, target } = fakeHome()
  writeFileSync(path.join(home, 'profiles', 'web', 'cordis.patch.yml'),
    "- include:\n    - id: manifest\n      name: ./package.json\n")
  writeFileSync(path.join(home, 'profiles', 'web', 'package.json'), '{"stale":true}\n')
  const outcome = await migrate(home)
  assert.deepEqual(outcome.carriedFiles, [])
  assert.deepEqual(outcome.refusedFiles, ['./package.json'])
  // The manifest the profile is booted from is still the one this migration wrote.
  assert.equal(JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8')).name, 'dsh-profile-dsh-app')
})

test('a walk that hits the file allowance is not a carry, and leaves nothing behind', async () => {
  const rows = []
  for (let index = 0; index < 501; index += 1) {
    const name = `./local-plugins/plugin-${String(index).padStart(3, '0')}.mjs`
    rows.push(`- include:\n    - id: p${String(index)}\n      name: ${name}\n`)
  }
  const { home, legacy, target } = fakeHome({ withPlugin: false, patch: rows.join('') })
  mkdirSync(path.join(legacy, 'local-plugins'), { recursive: true })
  const names = rows.map((row) => /name: (\S+)/u.exec(row)?.[1] ?? '')
  for (const name of names) writeFileSync(path.join(legacy, name.slice(2)), 'export default {}\n')

  const outcome = await migrate(home)
  // A cap, not a crash: the first 500 travel, the one that would have crossed the
  // allowance is reported and left out.
  assert.equal(outcome.carriedFiles.length, 500)
  assert.deepEqual(outcome.refusedFiles, [names[500]])
  assert.ok(existsSync(path.join(target, names[0].slice(2))))
  assert.ok(!existsSync(path.join(target, names[500].slice(2))))
})

test('a specifier naming a directory is not carried: the loader cannot import one', async () => {
  const { home, legacy, target } = fakeHome({ withPlugin: false })
  mkdirSync(path.join(legacy, 'local-plugins', 'my-plugin'), { recursive: true })
  writeFileSync(path.join(legacy, 'local-plugins', 'my-plugin', 'index.mjs'), 'export default {}\n')
  writeFileSync(path.join(legacy, 'cordis.patch.yml'), "- include:\n    - id: dir\n      name: ./local-plugins/my-plugin\n")
  const outcome = await migrate(home)
  // Copying it would be work the loader can never use, and the row is reported
  // instead — the composition guard then keeps it out of the boot.
  assert.deepEqual(outcome.carriedFiles, [])
  assert.deepEqual(outcome.unresolvedFiles, ['./local-plugins/my-plugin'])
  assert.ok(!existsSync(path.join(target, 'local-plugins', 'my-plugin')))
})

test('a second migration is a no-op: the marker short-circuits it', async () => {
  const { home } = fakeHome()
  await migrate(home)
  const again = await migrate(home)
  assert.equal(again.status, 'already')
  assert.deepEqual(again.carriedFiles, [])
})
