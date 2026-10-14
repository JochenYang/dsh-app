/**
 * Tests for the file-change recorder and the restore.
 *
 * The recorder is the half that decides which disk changes a recall can undo, so
 * these pin the three properties the feature's honesty rests on:
 *
 *   1. a before-image is taken from the file as it was BEFORE the write, per
 *      session and per turn, and the FIRST one wins for a path (that is the state
 *      the range began in — restoring the last would undo nothing);
 *   2. a change that could not be captured is REPORTED, never dropped, because a
 *      confident "reverted" over a partly-restored tree is the one outcome this
 *      must not produce;
 *   3. one session's turn cannot be confused with another's. Turn numbers are per
 *      session and a kernel process runs every session at once, so an unscoped
 *      key let a recall in one session restore another session's before-image —
 *      measured, before this test existed, as a file put back to the wrong
 *      content.
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
import { captureBefore, restoreOne, textOf } from '../src/snapshots.ts'

/** The session every test here uses unless it is about isolation. */
const S = 'session-one'

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
  record(S, file, 2, 10)
  await settle()
  // The write the hook was standing in front of.
  writeFileSync(file, 'CHANGED')
  const changes = recorder.changesForTurns(S, [2])
  assert.equal(changes.length, 1)
  assert.equal(textOf(changes[0].before), 'ORIGINAL', 'the snapshot must be the pre-write bytes')
  assert.equal(changes[0].turn, 2)
  assert.deepEqual(recorder.changesForTurns(S, [1]), [], 'another turn holds nothing')
  await rm(dir, { recursive: true, force: true })
})

test('one session cannot see, or lose, another session\'s changes', async () => {
  // The bug this pins: turn numbers are per session, and the recorder is created
  // once per kernel process. Keyed by turn alone, a recall in session B matched
  // session A's turn 2 and put the file back to A's before-image — a file
  // restored to content it never had in B.
  const dir = mkdtempSync(join(tmpdir(), 'rewind-rec-'))
  const file = join(dir, 'a.ts')
  writeFileSync(file, 'v0')
  const { recorder, record } = createRecorder()
  record('session-a', file, 2, 10)
  await settle()
  writeFileSync(file, 'a2')
  record('session-b', file, 2, 11)
  await settle()
  assert.equal(recorder.changesForTurns('session-a', [2]).length, 1)
  assert.equal(recorder.changesForTurns('session-b', [2]).length, 1)
  assert.equal(textOf(recorder.changesForTurns('session-b', [2])[0].before), 'a2')
  assert.deepEqual(recorder.changesForTurns('session-c', [2]), [], 'a third session holds nothing')
  // Forgetting is scoped too: session B's recall must not drop A's snapshot.
  recorder.forget('session-b', [2])
  assert.equal(recorder.changesForTurns('session-b', [2]).length, 0)
  assert.equal(recorder.changesForTurns('session-a', [2]).length, 1)
  await rm(dir, { recursive: true, force: true })
})

test('the before-image of the EARLIEST write wins, whatever order the reads finish in', async () => {
  // Two writes to one path in one turn is the normal shape (`edit` then `edit`).
  // The restore target is the state before the FIRST of them, and that used to be
  // decided by the order the captures RESOLVED in — which the thread pool does not
  // guarantee. A capture that finished second then won, and the recall put the file
  // back as the first write had left it: one change in the range was never undone,
  // and the report said `coverage: full`.
  const dir = mkdtempSync(join(tmpdir(), 'rewind-rec-'))
  const file = join(dir, 'a.ts')
  const { recorder, record } = createRecorder(async (path) => {
    // The first write's read is the slow one, so it resolves LAST.
    await new Promise((resolve) => { setTimeout(resolve, path === file ? 30 : 0) })
    return { kind: 'captured', before: Buffer.from(path) }
  })
  await Promise.all([
    record(S, file, 1, 10),
    record(S, file, 1, 20),
  ])
  const changes = recorder.changesForTurns(S, [1])
  assert.equal(changes.length, 2)
  assert.deepEqual(changes.map((change) => change.seq), [10, 20], 'ordered by the write, not by the read')
  await rm(dir, { recursive: true, force: true })
})

test('a file that did not exist is recorded as created, not as an error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rewind-rec-'))
  const { recorder, record } = createRecorder()
  record(S, join(dir, 'new.ts'), 3, 20)
  await settle()
  const changes = recorder.changesForTurns(S, [3])
  assert.equal(changes.length, 1)
  assert.equal(changes[0].before, null, 'absence is how a created file is recorded')
  assert.deepEqual(recorder.failuresForTurns(S, [3]), [])
  await rm(dir, { recursive: true, force: true })
})

test('one write is recorded once, however many times the hook fires', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rewind-rec-'))
  const file = join(dir, 'a.ts')
  writeFileSync(file, 'X')
  const { recorder, record } = createRecorder()
  record(S, file, 1, 5)
  record(S, file, 1, 5)
  await settle()
  assert.equal(recorder.changesForTurns(S, [1]).length, 1)
  await rm(dir, { recursive: true, force: true })
})

test('an unreadable file is reported, not silently skipped', async () => {
  const recorderApi = createRecorder(async () => ({ kind: 'too-large' }))
  recorderApi.record(S, '/some/huge.bin', 4, 30)
  await settle()
  assert.deepEqual(recorderApi.recorder.changesForTurns(S, [4]), [])
  const failures = recorderApi.recorder.failuresForTurns(S, [4])
  assert.equal(failures.length, 1)
  assert.match(failures[0].reason, /too large/)
})

test('forget drops a turn that is no longer on the surface', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rewind-rec-'))
  const file = join(dir, 'a.ts')
  writeFileSync(file, 'X')
  const { recorder, record } = createRecorder()
  record(S, file, 1, 5)
  await settle()
  assert.equal(recorder.size(), 1)
  recorder.forget(S, [1])
  assert.equal(recorder.size(), 0)
  await rm(dir, { recursive: true, force: true })
})

test('restoring puts the before-image back and quarantines the current bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rewind-res-'))
  const file = join(dir, 'a.ts')
  const quarantine = join(dir, 'q')
  writeFileSync(file, 'CHANGED')

  const outcome = await restoreOne({ path: file, before: Buffer.from('ORIGINAL') }, quarantine, 1)
  assert.equal(outcome.kind, 'restored')
  assert.equal(readFileSync(file, 'utf8'), 'ORIGINAL', 'the tree is back to the before-image')
  // The displaced bytes are kept — the recall stays reversible. The slot's name
  // carries a timestamp and a path hash, so it is read rather than reconstructed.
  const slots = readdirSync(quarantine)
  assert.equal(slots.length, 1, 'one quarantine slot')
  assert.equal(readFileSync(join(quarantine, slots[0], 'replaced'), 'utf8'), 'CHANGED')
  await rm(dir, { recursive: true, force: true })
})

test('a restore is byte-exact, so a binary file is not corrupted', async () => {
  // The before-images used to be read and written as utf8. A PNG read as utf8 and
  // written back is not the PNG that was there — and a shell command generating
  // images is one of the writes this feature exists to put back.
  const dir = mkdtempSync(join(tmpdir(), 'rewind-res-'))
  const file = join(dir, 'sprite.png')
  const quarantine = join(dir, 'q')
  const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x01])
  const changed = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x99, 0x99, 0x00, 0x01])
  writeFileSync(file, changed)

  const outcome = await restoreOne({ path: file, before: original }, quarantine, 7)
  assert.equal(outcome.kind, 'restored')
  assert.ok(readFileSync(file).equals(original), 'every byte of the before-image is back')
  const slots = readdirSync(quarantine)
  assert.ok(readFileSync(join(quarantine, slots[0], 'replaced')).equals(changed), 'and the displaced bytes are kept')
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
  assert.match(code, /writeFile\(join\(slot, 'created'\), present\)/)
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
