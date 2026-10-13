// Configuration checkpoints: what a healthy start captures, and what a restore
// does to the files it replaces.
//
// The property under test is not "a copy was made" but "the way back is safe":
// a restore must leave a byte-exact backup of everything it overwrites, must
// touch nothing outside the four slots, must refuse a checkpoint it cannot
// verify, and must never delete a file the user has. Each of those is asserted
// with a counter-example (a decoy file, a damaged copy, a target that is not a
// plain file) so a green run means the guard ran, not that nothing happened.
//
// All four directories are scratch roots from this file, so no real profile and
// no real `$DSH_HOME` is involved — the module resolves nothing itself.
//
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { scratchDir } from './scratch.mjs'

const require = createRequire(import.meta.url)
const {
  CHECKPOINT_DIR_NAME,
  CHECKPOINT_FAMILY_MAX_BYTES,
  CHECKPOINT_KEEP_GENERATIONS,
  CHECKPOINT_MANIFEST_FILE,
  CHECKPOINT_MAX_FILE_BYTES,
  CHECKPOINT_MAX_TOTAL_BYTES,
  captureConfigCheckpoint,
  checkpointRoot,
  digestOf,
  findRestorableCheckpoint,
  freeBackupPath,
  generationName,
  hasRestorableConfigCheckpoint,
  restoreConfigCheckpoint,
  shouldCaptureCheckpoint,
  slotTargets,
} = require('../dist/main/config-checkpoint.js')

/** One measured instant, so a generation name is predictable. */
const AT = new Date('2026-10-13T09:31:02.483Z')
const LATER = new Date('2026-10-13T10:00:00.000Z')
const clock = (at) => () => at

/** A scope holding the four files, in the shape the shell hands over. */
function fixture(tag) {
  const userDataDir = scratchDir(`dsh-app-cp-userdata-${tag}-`)
  const dshHome = scratchDir(`dsh-app-cp-home-${tag}-`)
  const profileDir = path.join(dshHome, 'profiles', 'dsh-app')
  mkdirSync(profileDir, { recursive: true })
  const scope = { userDataDir, profileDir, dshHome }
  const targets = slotTargets(scope)
  writeFileSync(targets['profile-package'], '{"name":"dsh-profile-dsh-app"}\n')
  writeFileSync(targets['profile-patch'], '- id: home\n  rows:\n    - a\n')
  writeFileSync(targets['profile-lockfile'], "lockfileVersion: '9.0'\n")
  writeFileSync(targets['home-patch'], '- id: web\n  rows:\n    - b\n')
  return { ...scope, targets }
}

/** Every generation directory present, oldest first. */
function generations(scope) {
  const root = checkpointRoot(scope.userDataDir)
  return existsSync(root) ? readdirSync(root).sort() : []
}

/** Read a generation's manifest. */
function manifestOf(scope, generation) {
  return JSON.parse(readFileSync(path.join(checkpointRoot(scope.userDataDir), generation, CHECKPOINT_MANIFEST_FILE), 'utf8'))
}

/** Each target's bytes, keyed by slot. */
function contents(scope) {
  return Object.fromEntries(Object.entries(scope.targets).map(([slot, target]) => [slot, readFileSync(target)]))
}

/** Backups a restore would create now — computed BEFORE it runs. */
async function expectedBackups(scope, at) {
  const paths = {}
  for (const [slot, target] of Object.entries(scope.targets)) paths[slot] = await freeBackupPath(target, at)
  return paths
}

// ------------------------------------------------------------------ capture

test('a healthy start captures all four files, byte for byte', async () => {
  const scope = fixture('capture')
  const lines = []
  const outcome = await captureConfigCheckpoint({ ...scope, now: clock(AT), log: (line) => lines.push(line) })
  assert.equal(outcome.status, 'written')
  assert.equal(outcome.generation, 'checkpoint-20261013T093102Z-01')
  assert.equal(outcome.slots, 4)
  assert.equal(outcome.bytes, Object.values(contents(scope)).reduce((total, bytes) => total + bytes.length, 0))
  assert.match(lines.join('\n'), /\[config-checkpoint\] captured checkpoint-20261013T093102Z-01/)

  const manifest = manifestOf(scope, outcome.generation)
  assert.equal(manifest.version, 1)
  assert.equal(manifest.createdAt, AT.toISOString())
  assert.deepEqual(Object.keys(manifest.files).sort(), ['home-patch', 'profile-lockfile', 'profile-package', 'profile-patch'])
  const dir = path.join(checkpointRoot(scope.userDataDir), outcome.generation)
  for (const slot of ['profile-package', 'profile-patch', 'profile-lockfile', 'home-patch']) {
    const record = manifest.files[slot]
    assert.equal(record.present, true, `${slot} is recorded`)
    const stored = path.join(dir, slot === 'home-patch' ? 'home' : 'profile', path.basename(scope.targets[slot]))
    assert.deepEqual(readFileSync(stored), readFileSync(scope.targets[slot]), `${slot} is stored byte for byte`)
    assert.equal(record.bytes, readFileSync(stored).length)
    assert.equal(record.sha256, digestOf(readFileSync(stored)))
  }

  const lookup = await findRestorableCheckpoint(scope)
  assert.equal(lookup.status, 'ok')
  assert.deepEqual(lookup.checkpoint.present, ['profile-package', 'profile-patch', 'profile-lockfile', 'home-patch'])
  assert.equal(await hasRestorableConfigCheckpoint(scope), true)
})

test('the checkpoint lives under userData, never in the home or the profile', async () => {
  const scope = fixture('location')
  await captureConfigCheckpoint({ ...scope, now: clock(AT) })
  assert.equal(existsSync(path.join(scope.userDataDir, CHECKPOINT_DIR_NAME)), true)
  assert.deepEqual(readdirSync(scope.profileDir).sort(), ['cordis.patch.yml', 'package.json', 'pnpm-lock.yaml'])
  assert.deepEqual(readdirSync(scope.dshHome).sort(), ['cordis.patch.yml', 'profiles'])
})

test('the rule for "healthy" refuses every start that is not both up and shown', () => {
  const healthy = { hostReady: true, uiShown: true, safeMode: false, alreadyCaptured: false }
  assert.equal(shouldCaptureCheckpoint(healthy), true)
  // The host came up but the UI never loaded, and the reverse: neither is a
  // configuration worth calling known-good.
  assert.equal(shouldCaptureCheckpoint({ ...healthy, uiShown: false }), false)
  assert.equal(shouldCaptureCheckpoint({ ...healthy, hostReady: false }), false)
  // Safe mode is a diagnostic run by definition: capturing it would let a
  // suspect configuration become the thing a later restore puts back.
  assert.equal(shouldCaptureCheckpoint({ ...healthy, safeMode: true }), false)
  // One capture per process: a tray restart or a proxy-watchdog restart is not a
  // new configuration.
  assert.equal(shouldCaptureCheckpoint({ ...healthy, alreadyCaptured: true }), false)
})

test('a configuration with no file left to keep writes nothing', async () => {
  const scope = fixture('empty')
  for (const target of Object.values(scope.targets)) await rm(target, { force: true })
  const lines = []
  const outcome = await captureConfigCheckpoint({ ...scope, now: clock(AT), log: (line) => lines.push(line) })
  assert.equal(outcome.status, 'empty')
  assert.deepEqual(generations(scope), [])
  assert.match(lines.join('\n'), /none of the four configuration files exists yet/)
  assert.equal(await hasRestorableConfigCheckpoint(scope), false)
})

// ------------------------------------------------------------------ rotation

test('generations rotate, and the family stays inside its derived ceiling', async () => {
  assert.equal(CHECKPOINT_FAMILY_MAX_BYTES, CHECKPOINT_MAX_TOTAL_BYTES * CHECKPOINT_KEEP_GENERATIONS)
  const scope = fixture('rotate')
  const names = []
  for (let run = 0; run < CHECKPOINT_KEEP_GENERATIONS + 2; run += 1) {
    const at = new Date(AT.getTime() + run * 60_000)
    writeFileSync(scope.targets['profile-patch'], `- id: home\n  rows:\n    - run-${String(run)}\n`)
    const outcome = await captureConfigCheckpoint({ ...scope, now: clock(at) })
    assert.equal(outcome.status, 'written')
    names.push(outcome.generation)
  }
  // The name order is the age order, and the generations the cap pushed out are
  // gone.
  assert.deepEqual(generations(scope), names.slice(-CHECKPOINT_KEEP_GENERATIONS))
  assert.equal(generations(scope).includes(names[0]), false)
  // What a restore offers is the newest one, i.e. the configuration that was live
  // at the last healthy start.
  const lookup = await findRestorableCheckpoint(scope)
  assert.equal(lookup.status, 'ok')
  assert.equal(lookup.checkpoint.generation, names.at(-1))
  const newest = CHECKPOINT_KEEP_GENERATIONS + 1
  assert.equal(readFileSync(path.join(lookup.checkpoint.dir, 'profile', 'cordis.patch.yml'), 'utf8').includes(`run-${String(newest)}`), true)
})

test('two captures inside one second are told apart rather than overwriting', async () => {
  const scope = fixture('same-second')
  const first = await captureConfigCheckpoint({ ...scope, now: clock(AT) })
  const second = await captureConfigCheckpoint({ ...scope, now: clock(AT) })
  assert.deepEqual(
    [first.generation, second.generation],
    ['checkpoint-20261013T093102Z-01', 'checkpoint-20261013T093102Z-02'],
  )
  assert.equal(generationName(AT, 2), 'checkpoint-20261013T093102Z-02')
  assert.equal(generations(scope).length, 2)
})

test('a file over a cap refuses the whole capture instead of storing part of it', async () => {
  const scope = fixture('oversized')
  writeFileSync(scope.targets['profile-lockfile'], 'x'.repeat(CHECKPOINT_MAX_FILE_BYTES + 1))
  const lines = []
  const outcome = await captureConfigCheckpoint({ ...scope, now: clock(AT), log: (line) => lines.push(line) })
  assert.equal(outcome.status, 'oversized')
  assert.equal(outcome.detail, 'file-over-cap (profile-lockfile)')
  assert.deepEqual(generations(scope), [])
  assert.match(lines.join('\n'), /per-file cap/)
})

test('a target that is not a plain file is never recorded', async () => {
  const scope = fixture('other')
  // A directory where a config file belongs: it cannot be read as one, and
  // recording it as absent would hide a file a restore must not touch.
  await rm(scope.targets['profile-package'], { force: true })
  mkdirSync(scope.targets['profile-package'])
  const outcome = await captureConfigCheckpoint({ ...scope, now: clock(AT) })
  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.detail, 'not-a-regular-file (profile-package)')
  assert.deepEqual(generations(scope), [])
})

// ------------------------------------------------------------------ restore

test('a restore backs up every file it replaces, then puts the checkpoint back', async () => {
  const scope = fixture('restore')
  const captured = await captureConfigCheckpoint({ ...scope, now: clock(AT) })
  assert.equal(captured.status, 'written')
  const good = contents(scope)
  const backups = await expectedBackups(scope, LATER)
  // What the user changed after that healthy start — the state a restore is
  // expected to overwrite, and therefore to preserve.
  const edited = {}
  for (const [slot, target] of Object.entries(scope.targets)) {
    edited[slot] = Buffer.from(`# edited ${slot}\n`)
    writeFileSync(target, edited[slot])
  }

  const outcome = await restoreConfigCheckpoint({ ...scope, now: clock(LATER) })
  assert.equal(outcome.status, 'restored')
  assert.equal(outcome.generation, captured.generation)
  assert.equal(outcome.createdAt, AT.toISOString())
  // The restart is not a detail the caller may forget: the files are read when
  // the host starts, so the outcome states it as a literal.
  assert.equal(outcome.restartRequired, true)
  assert.deepEqual(outcome.actions.map((action) => [action.slot, action.action]), [
    ['profile-package', 'replaced'],
    ['profile-patch', 'replaced'],
    ['profile-lockfile', 'replaced'],
    ['home-patch', 'replaced'],
  ])
  assert.equal(outcome.backups.length, 4)

  for (const slot of ['profile-package', 'profile-patch', 'profile-lockfile', 'home-patch']) {
    assert.deepEqual(readFileSync(scope.targets[slot]), good[slot], `${slot} is back to the checkpoint's content`)
    assert.equal(existsSync(backups[slot]), true, `${slot} kept a backup`)
    assert.deepEqual(readFileSync(backups[slot]), edited[slot], `${slot}'s backup is what was overwritten`)
    // In the repo's own backup spelling, beside the file it belongs to.
    assert.match(path.basename(backups[slot]), /\.bak-before-restore-\d{8}-\d{6}$/u)
    assert.equal(outcome.backups.includes(backups[slot]), true)
  }
})

test('a restore touches nothing but the four slots', async () => {
  const scope = fixture('scope')
  await captureConfigCheckpoint({ ...scope, now: clock(AT) })
  // Decoys in every directory a restore could plausibly wander into.
  const decoys = [
    path.join(scope.profileDir, 'settings.yaml'),
    path.join(scope.profileDir, 'pnpm-workspace.yaml'),
    path.join(scope.profileDir, 'node_modules', 'some-package', 'index.js'),
    path.join(scope.dshHome, 'settings.yaml'),
    path.join(scope.dshHome, 'sessions', 'one.jsonl'),
    path.join(scope.userDataDir, 'unrelated.txt'),
  ]
  for (const decoy of decoys) {
    mkdirSync(path.dirname(decoy), { recursive: true })
    writeFileSync(decoy, `decoy ${path.basename(decoy)}\n`)
  }
  for (const target of Object.values(scope.targets)) writeFileSync(target, '# edited\n')

  const outcome = await restoreConfigCheckpoint({ ...scope, now: clock(LATER) })
  assert.equal(outcome.status, 'restored')
  for (const decoy of decoys) {
    assert.equal(readFileSync(decoy, 'utf8'), `decoy ${path.basename(decoy)}\n`, `${decoy} is untouched`)
  }
  // Nothing else appeared beside them either: no stray staging files, and no
  // directory the restore invented.
  assert.deepEqual(readdirSync(path.join(scope.profileDir, 'node_modules')), ['some-package'])
  assert.deepEqual(readdirSync(scope.userDataDir).sort(), [CHECKPOINT_DIR_NAME, 'unrelated.txt'])
})

test('a slot the checkpoint did not hold is left exactly as it is', async () => {
  // The home layer is absent on most machines, so a checkpoint that records it as
  // absent must not delete a file the user created afterwards.
  const scope = fixture('absent')
  await rm(scope.targets['home-patch'], { force: true })
  const captured = await captureConfigCheckpoint({ ...scope, now: clock(AT) })
  assert.equal(captured.status, 'written')
  assert.equal(manifestOf(scope, captured.generation).files['home-patch'].present, false)
  const added = '# the user added one after the checkpoint\n'
  writeFileSync(scope.targets['home-patch'], added)

  const outcome = await restoreConfigCheckpoint({ ...scope, now: clock(LATER) })
  assert.equal(outcome.status, 'restored')
  assert.deepEqual(outcome.actions.at(-1), { slot: 'home-patch', action: 'kept' })
  assert.equal(readFileSync(scope.targets['home-patch'], 'utf8'), added)
  // And the three the checkpoint did hold were written.
  assert.equal(readFileSync(scope.targets['profile-package'], 'utf8'), '{"name":"dsh-profile-dsh-app"}\n')
})

test('a target that is gone is created again, with no backup to take', async () => {
  const scope = fixture('recreate')
  const captured = await captureConfigCheckpoint({ ...scope, now: clock(AT) })
  assert.equal(captured.status, 'written')
  const good = contents(scope)
  await rm(scope.targets['profile-lockfile'], { force: true })

  const outcome = await restoreConfigCheckpoint({ ...scope, now: clock(LATER) })
  assert.equal(outcome.status, 'restored')
  assert.deepEqual(readFileSync(scope.targets['profile-lockfile']), good['profile-lockfile'])
  assert.deepEqual(
    outcome.actions.find((action) => action.slot === 'profile-lockfile'),
    { slot: 'profile-lockfile', action: 'created', backup: undefined },
  )
  // Three replaced, one created: a backup exists only where something was there.
  assert.equal(outcome.backups.length, 3)
})

// ----------------------------------------------------------------- refusals

test('no checkpoint means no restore, and no button to offer', async () => {
  const scope = fixture('none')
  assert.equal(await hasRestorableConfigCheckpoint(scope), false)
  assert.equal((await findRestorableCheckpoint(scope)).status, 'none')
  const lines = []
  const outcome = await restoreConfigCheckpoint({ ...scope, now: clock(AT), log: (line) => lines.push(line) })
  assert.equal(outcome.status, 'none')
  assert.equal(outcome.restartRequired, false)
  assert.match(lines.join('\n'), /no checkpoint to restore/)
})

test('an incomplete or damaged checkpoint is refused, and nothing is written', async () => {
  const cases = [
    ['manifest-missing', (dir) => rm(path.join(dir, CHECKPOINT_MANIFEST_FILE), { force: true })],
    ['manifest-unreadable', (dir) => writeFileSync(path.join(dir, CHECKPOINT_MANIFEST_FILE), '{ not json')],
    ['manifest-slots-mismatch', (dir) => {
      const file = path.join(dir, CHECKPOINT_MANIFEST_FILE)
      const manifest = JSON.parse(readFileSync(file, 'utf8'))
      delete manifest.files['home-patch']
      writeFileSync(file, JSON.stringify(manifest))
    }],
    ['copy-missing (profile-lockfile)', (dir) => rm(path.join(dir, 'profile', 'pnpm-lock.yaml'), { force: true })],
    ['copy-size-mismatch (profile-package)', (dir) => writeFileSync(path.join(dir, 'profile', 'package.json'), '{"name":"truncated"}')],
    ['copy-digest-mismatch (profile-package)', (dir) => {
      // Same LENGTH, different bytes: only the digest can see this.
      const file = path.join(dir, 'profile', 'package.json')
      const original = readFileSync(file, 'utf8')
      writeFileSync(file, `${original.slice(0, -2)}X\n`)
    }],
  ]
  for (const [reason, damage] of cases) {
    const scope = fixture(`damage-${reason}`)
    const captured = await captureConfigCheckpoint({ ...scope, now: clock(AT) })
    assert.equal(captured.status, 'written')
    const edited = '# edited after the checkpoint\n'
    for (const target of Object.values(scope.targets)) writeFileSync(target, edited)
    await damage(path.join(checkpointRoot(scope.userDataDir), captured.generation))

    const lines = []
    const lookup = await findRestorableCheckpoint(scope)
    assert.equal(lookup.status, 'invalid', `${reason} must not verify`)
    assert.equal(lookup.reason, reason)
    assert.equal(await hasRestorableConfigCheckpoint(scope), false, `${reason} must not offer the button`)
    const outcome = await restoreConfigCheckpoint({ ...scope, now: clock(LATER), log: (line) => lines.push(line) })
    assert.equal(outcome.status, 'invalid', `${reason} must refuse the restore`)
    assert.equal(outcome.restartRequired, false)
    // The refusal happened before the first write: what the user edited is still
    // there verbatim, and no backup was taken.
    for (const slot of ['profile-package', 'profile-patch', 'profile-lockfile', 'home-patch']) {
      assert.equal(readFileSync(scope.targets[slot], 'utf8'), edited, `${reason}: ${slot} untouched`)
    }
    assert.deepEqual(readdirSync(scope.profileDir).filter((name) => name.includes('bak-before-restore')), [])
  }
})

test('an invalid newest checkpoint is refused rather than reaching further back', async () => {
  const scope = fixture('strict')
  const first = await captureConfigCheckpoint({ ...scope, now: clock(AT) })
  writeFileSync(scope.targets['profile-patch'], '# a second, different configuration\n')
  const second = await captureConfigCheckpoint({ ...scope, now: clock(new Date(AT.getTime() + 60_000)) })
  assert.equal(second.status, 'written')
  // Damage only the newest one; the older one is still perfectly good.
  await rm(path.join(checkpointRoot(scope.userDataDir), second.generation, CHECKPOINT_MANIFEST_FILE), { force: true })
  const lookup = await findRestorableCheckpoint(scope)
  assert.equal(lookup.status, 'invalid')
  assert.equal(lookup.generation, second.generation)
  assert.equal(generations(scope).includes(first.generation), true)
  const outcome = await restoreConfigCheckpoint({ ...scope, now: clock(LATER) })
  assert.equal(outcome.status, 'invalid')
  assert.equal(outcome.restartRequired, false)
})

test('a target that is not a plain file stops the whole restore before any write', async () => {
  const scope = fixture('link')
  const captured = await captureConfigCheckpoint({ ...scope, now: clock(AT) })
  assert.equal(captured.status, 'written')
  for (const target of Object.values(scope.targets)) writeFileSync(target, '# edited\n')
  // A directory where a config file belongs. Writing "through" it is impossible,
  // and a half-restored configuration is worse than a refusal.
  await rm(scope.targets['home-patch'], { force: true })
  mkdirSync(scope.targets['home-patch'])

  const outcome = await restoreConfigCheckpoint({ ...scope, now: clock(LATER) })
  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.detail, 'target-not-a-regular-file (home-patch)')
  assert.equal(outcome.restartRequired, false)
  // Pre-flight first: the three slots that WOULD have been written are untouched,
  // and no backup was left behind for them.
  for (const slot of ['profile-package', 'profile-patch', 'profile-lockfile']) {
    assert.equal(readFileSync(scope.targets[slot], 'utf8'), '# edited\n', `${slot} untouched`)
  }
  assert.deepEqual(readdirSync(scope.profileDir).filter((name) => name.includes('bak-before-restore')), [])
  // The checkpoint is still there to try again with.
  assert.equal(existsSync(path.join(checkpointRoot(scope.userDataDir), captured.generation)), true)
})
