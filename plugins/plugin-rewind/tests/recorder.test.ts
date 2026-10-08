/**
 * Tests for the file-change recorder and the restore.
 *
 * The recorder is the half that decides which disk changes a recall can undo, so
 * these pin the two properties the feature's honesty rests on:
 *
 *   1. a before-image is taken from the file as it was BEFORE the write, per
 *      turn, and the FIRST one wins for a path (that is the state the range
 *      began in — restoring the last would undo nothing);
 *   2. a change that could not be captured is REPORTED, never dropped, because a
 *      confident "reverted" over a partly-restored tree is the one outcome this
 *      must not produce.
 *
 * The restore itself is exercised against a real temporary directory: the
 * quarantine-first ordering is what keeps the recall reversible, and a mock would
 * not show it.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRecorder, turnAt } from '../src/recorder.ts'
import { captureBefore, restoreOne } from '../src/snapshots.ts'

/**
 * Let the recorder's own async captures settle.
 *
 * `readFile`/`stat` from `node:fs/promises` resolve on the thread pool, which a
 * `setImmediate` loop can outrun: the capture is deliberately NOT awaited (it
 * must not block the write), so a test has to actually wait for the pool. A real
 * timer is the honest way to do that.
 */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => { setTimeout(resolve, 50) })
}

test('a capture records the PRE-write content, keyed to its turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rewind-rec-'))
  const file = join(dir, 'a.ts')
  writeFileSync(file, 'ORIGINAL')
  const { recorder, record } = createRecorder()
  record(file, 2, 10)
  await settle()
  // The write the hook was standing in front of.
  writeFileSync(file, 'CHANGED')
  const changes = recorder.changesForTurns([2])
  assert.equal(changes.length, 1)
  assert.equal(changes[0].before, 'ORIGINAL', 'the snapshot must be the pre-write bytes')
  assert.equal(changes[0].turn, 2)
  assert.deepEqual(recorder.changesForTurns([1]), [], 'another turn holds nothing')
  await rm(dir, { recursive: true, force: true })
})

test('a file that did not exist is recorded as created, not as an error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rewind-rec-'))
  const { recorder, record } = createRecorder()
  record(join(dir, 'new.ts'), 3, 20)
  await settle()
  const changes = recorder.changesForTurns([3])
  assert.equal(changes.length, 1)
  assert.equal(changes[0].before, null, 'absence is how a created file is recorded')
  assert.deepEqual(recorder.failuresForTurns([3]), [])
  await rm(dir, { recursive: true, force: true })
})

test('one write is recorded once, however many times the hook fires', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rewind-rec-'))
  const file = join(dir, 'a.ts')
  writeFileSync(file, 'X')
  const { recorder, record } = createRecorder()
  record(file, 1, 5)
  record(file, 1, 5)
  await settle()
  assert.equal(recorder.changesForTurns([1]).length, 1)
  await rm(dir, { recursive: true, force: true })
})

test('an unreadable file is reported, not silently skipped', async () => {
  const recorderApi = createRecorder(async () => ({ kind: 'too-large' }))
  recorderApi.record('/some/huge.bin', 4, 30)
  await settle()
  assert.deepEqual(recorderApi.recorder.changesForTurns([4]), [])
  const failures = recorderApi.recorder.failuresForTurns([4])
  assert.equal(failures.length, 1)
  assert.match(failures[0].reason, /too large/)
})

test('forget drops a turn that is no longer on the surface', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rewind-rec-'))
  const file = join(dir, 'a.ts')
  writeFileSync(file, 'X')
  const { recorder, record } = createRecorder()
  record(file, 1, 5)
  await settle()
  assert.equal(recorder.size(), 1)
  recorder.forget([1])
  assert.equal(recorder.size(), 0)
  await rm(dir, { recursive: true, force: true })
})

test('restoring puts the before-image back and quarantines the current bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rewind-res-'))
  const file = join(dir, 'a.ts')
  const quarantine = join(dir, 'q')
  writeFileSync(file, 'CHANGED')

  const outcome = await restoreOne({ path: file, before: 'ORIGINAL' }, quarantine, 1)
  assert.equal(outcome.kind, 'restored')
  assert.equal(readFileSync(file, 'utf8'), 'ORIGINAL', 'the tree is back to the before-image')
  // The displaced bytes are kept — the recall stays reversible. The slot's name
  // carries a timestamp and a path hash, so it is read rather than reconstructed.
  const slots = readdirSync(quarantine)
  assert.equal(slots.length, 1, 'one quarantine slot')
  assert.equal(readFileSync(join(quarantine, slots[0], 'replaced'), 'utf8'), 'CHANGED')
  await rm(dir, { recursive: true, force: true })
})

test('restoring a CREATED file moves it away instead of deleting it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rewind-res-'))
  const file = join(dir, 'created.ts')
  const quarantine = join(dir, 'q')
  writeFileSync(file, 'NEW CONTENT')

  const outcome = await restoreOne({ path: file, before: null }, quarantine, 2)
  assert.equal(outcome.kind, 'removed')
  assert.throws(() => readFileSync(file, 'utf8'), 'the file must be gone from its place')
  // ...but preserved, which is the whole point of not unlinking it.
  const slots = readdirSync(quarantine)
  assert.equal(slots.length, 1, 'one quarantine slot')
  assert.equal(readFileSync(join(quarantine, slots[0], 'created'), 'utf8'), 'NEW CONTENT')
  await rm(dir, { recursive: true, force: true })
})

test('removing a created file never renames — a quarantine on another volume must work', async () => {
  // The quarantine lives under `$DSH_HOME`; the workspace does not have to share
  // its volume (this machine: `$DSH_HOME` on `C:`, the project on `D:`). `rename`
  // across volumes fails with `EXDEV`, so a "move it away" written as a rename
  // works only when both happen to share a drive — and fails for a created file,
  // which is the one case with no other path. Measured on a real machine: new
  // files were never quarantined, only modified ones.
  const source = readFileSync(
    fileURLToPath(new URL('../src/snapshots.ts', import.meta.url)),
    'utf8',
  )
  // Only CODE counts: the module's own note explains why a rename is wrong here,
  // and a whole-file scan would flag that prose as the thing it warns against.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
  assert.doesNotMatch(code, /\brename\b/, 'snapshots.ts must not rename anything in code')
  assert.match(code, /writeFile\(join\(slot, 'created'\), present, 'utf8'\)/)
  // The unlink happens only AFTER the copy, so a crash between the two leaves a
  // duplicate rather than a loss.
  const copy = code.indexOf("writeFile(join(slot, 'created')")
  const unlink = code.indexOf('await rm(snapshot.path, { force: true })')
  assert.ok(copy !== -1 && unlink !== -1 && copy < unlink, 'the copy must precede the unlink')
})

test('turnAt follows turn/start and turn/end', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: {} },
    { type: 'turn/end', seq: 2, data: { turn: 1 } },
    { type: 'turn/start', seq: 3, data: { turn: 2 } },
  ]
  assert.equal(turnAt(events, 1), 1)
  assert.equal(turnAt(events, 3), 2)
  assert.equal(turnAt(events, 0), 1)
})

test('captureBefore reports a directory rather than reading it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rewind-cap-'))
  const result = await captureBefore(dir)
  assert.equal(result.kind, 'unreadable')
  await rm(dir, { recursive: true, force: true })
})
