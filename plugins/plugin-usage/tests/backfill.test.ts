/**
 * Unit tests for the historical backfill and the store's crash/retry
 * behaviour: the session-listing SHAPE (a wrapper, not a bare header — reading
 * the wrong field silently turned the whole pass into a no-op), the fork
 * inherited prefix (never folded twice), the log-size witness (an unchanged log
 * must be skipped without a read, and that witness must not outlive its rows),
 * a live event that jumped a watermark gap (the gap is the backfill's, not
 * the live path's, to fold), the single-flight guard (two passes must never
 * overlap), and a failed flush (rows are kept, not dropped).
 *
 * Run via `npm test` (esbuild bundles TS → .test-dist, node --test runs it).
 *
 * @module @dsh-app/plugin-usage/tests/backfill
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { scratchDir } from './scratch.ts'
import { listedSessionId, listedSizeBytes, runBackfill, singleFlightPass, type BackfillPersistence, type BackfillReport } from '../src/backfill.ts'
import { foldEvents, foldLiveEvent, type FoldEvent } from '../src/fold.ts'
import { UsageStore } from '../src/store.ts'
import type { UsageRow } from '../src/types.ts'

const tmpDir = (): string => scratchDir('dshu-backfill-')

const newStore = (dir: string, log: (message: string) => void = () => {}): UsageStore => {
  const store = new UsageStore({ dir, log })
  store.load()
  return store
}

const header = (seq: number, provider: string, model: string): FoldEvent => ({
  seq,
  time: 1_000_000 + seq,
  type: 'request/header',
  data: { header: { config: { provider, model } } },
})

const message = (seq: number, inputTokens: number, outputTokens: number): FoldEvent => ({
  seq,
  time: 1_000_000 + seq,
  type: 'assistant/message',
  data: {
    turn: 0,
    step: 1,
    usage: { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  },
})

const rowOf = (overrides: Partial<UsageRow> = {}): UsageRow => ({
  seq: 1,
  time: 1,
  sessionId: 's',
  turn: 0,
  step: 1,
  provider: 'p',
  model: 'm',
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  ...overrides,
})

/** A persistence stub over in-memory logs, in the KERNEL's wrapper shape. */
const persistenceOf = (
  logs: Record<string, { events: FoldEvent[], inherited?: number, version?: number, size?: number }>,
  counters?: { opens: string[] },
): BackfillPersistence => ({
  // The kernel's `list()` returns snapshot wrappers: the id lives on
  // `entry.header.id`. Returning bare headers here would make this test pass
  // against the very bug it exists to catch. The header also carries the LOG
  // FORMAT version, which is what the fold treats as its seq-space witness.
  // `sizeBytes` is omitted unless the case asks for one: a snapshot without a
  // size is the shape that must keep paying a full read on every pass.
  list: () => Promise.resolve(Object.keys(logs).map(id => ({
    header: { id, ...(logs[id]?.version === undefined ? {} : { version: logs[id]!.version }) },
    ...(logs[id]?.size === undefined ? {} : { sizeBytes: logs[id]!.size }),
  }))),
  open: (id: string) => {
    counters?.opens.push(id)
    const log = logs[id]
    return Promise.resolve({
      ...(log?.inherited === undefined ? {} : { inheritedEventCount: log.inherited }),
      read: () => Promise.resolve({ events: log?.events ?? [] }),
      close: () => Promise.resolve(),
    })
  },
})

// --- listedSessionId ---------------------------------------------------------

test('listedSessionId: reads the wrapper the kernel returns, and a bare header', () => {
  assert.equal(listedSessionId({ header: { id: 'wrapped' } }), 'wrapped')
  // A future kernel that flattens the wrapper must keep working.
  assert.equal(listedSessionId({ id: 'bare' }), 'bare')
  assert.equal(listedSessionId({}), '', 'neither shape → no id')
  assert.equal(listedSessionId({ header: {} }), '', 'an empty wrapper carries no id')
  assert.equal(listedSessionId({ header: { id: '' } }), '', 'and an empty id is not an id')
})

// --- listedSizeBytes ---------------------------------------------------------

test('listedSizeBytes: a finite non-negative number, otherwise undefined', () => {
  assert.equal(listedSizeBytes({ sizeBytes: 0 }), 0, 'an empty log is still a size')
  assert.equal(listedSizeBytes({ sizeBytes: 128 }), 128)
  assert.equal(listedSizeBytes({ sizeBytes: Number.NaN }), undefined, 'NaN proves nothing about a log')
  assert.equal(listedSizeBytes({ sizeBytes: Number.POSITIVE_INFINITY }), undefined)
  assert.equal(listedSizeBytes({ sizeBytes: -1 }), undefined, 'a negative size cannot be compared')
  assert.equal(listedSizeBytes({ sizeBytes: '128' }), undefined, 'no coercion across shapes')
  assert.equal(listedSizeBytes({}), undefined, 'a backend that provides no size is "not provided"')
})

// --- runBackfill -------------------------------------------------------------

test('runBackfill: a wrapper-shaped listing is actually inspected (the regression)', async () => {
  const store = newStore(tmpDir())
  const report = await runBackfill(store, persistenceOf({
    s1: { events: [header(1, 'deepseek', 'deepseek-v4-flash'), message(2, 10, 5)] },
  }), () => {})
  // Reading `entry.id` instead of `entry.header.id` made every entry skip, so
  // `inspected` stayed 0 and no history was ever imported.
  assert.equal(report.inspected, 1, 'the entry is inspected')
  assert.equal(report.added, 1, 'and its row is folded')
  assert.equal(store.size, 1)
})

test('runBackfill: a fork does not re-fold its inherited prefix', async () => {
  const store = newStore(tmpDir())
  // Parent folded its own two events already.
  foldEvents(store, 'parent', [header(1, 'deepseek', 'deepseek-v4-flash'), message(2, 10, 5)])
  assert.equal(store.size, 1)
  const report = await runBackfill(store, persistenceOf({
    // The child's log physically contains the parent's prefix (same seq) plus
    // one event of its own.
    child: { events: [header(1, 'deepseek', 'deepseek-v4-flash'), message(2, 10, 5), message(7, 3, 1)], inherited: 2 },
  }), () => {})
  assert.equal(report.added, 1, 'only the child own event is added')
  assert.equal(store.size, 2, 'the parent prefix is not counted a second time')
  assert.equal(store.all().filter(row => row.sessionId === 'child').length, 1)
})

test('runBackfill: a session whose log is entirely inherited adds nothing', async () => {
  const store = newStore(tmpDir())
  const report = await runBackfill(store, persistenceOf({
    child: { events: [header(1, 'p', 'm'), message(2, 10, 5)], inherited: 2 },
  }), () => {})
  assert.equal(report.inspected, 1)
  assert.equal(report.added, 0, 'nothing above the inherited cut')
  assert.equal(store.size, 0)
})

test('runBackfill: a fork first live event does not advance past its inherited prefix', async () => {
  const store = newStore(tmpDir())
  // The child's log copies four events from its parent (seq 0..3), so its first
  // own event sits at seq 4. Live capture sees that event with an empty
  // watermark: it must fold without claiming the inherited prefix as folded.
  assert.equal(foldLiveEvent(store, 'child', message(4, 7, 3)), 1)
  assert.equal(store.watermark('child'), 0, 'seq 4 is not contiguous with an empty watermark')

  const report = await runBackfill(store, persistenceOf({
    child: {
      events: [
        message(0, 100, 50),
        message(1, 100, 50),
        message(2, 100, 50),
        message(3, 100, 50),
        message(4, 7, 3),
      ],
      inherited: 4,
      size: 256,
    },
  }), () => {})

  // The inherited prefix belongs to the parent, and the live row already covers
  // seq 4: the pass adds nothing and leaves exactly one child row.
  assert.equal(report.added, 0)
  const childRows = store.all().filter(row => row.sessionId === 'child')
  assert.deepEqual(childRows.map(row => row.seq), [4])
  assert.equal(childRows[0]!.inputTokens, 7)
})

test('runBackfill: a log format change re-folds a session once, at its current seq', async () => {
  // The V3→V4 migration appends synthetic events and renumbers the tail, so an
  // already-folded message can come back at a DIFFERENT seq. Both halves of the
  // fix are asserted here, because each one alone is wrong: without the format
  // witness the watermark skips the moved message (usage quietly too low), and
  // with only the watermark dropped the re-fold adds a SECOND row under the new
  // seq and counts that usage twice (`keyOf` is `sessionId:seq`).
  const store = newStore(tmpDir())
  const before = persistenceOf({ s1: { events: [header(1, 'deepseek', 'm'), message(9, 10, 5)], version: 3 } })
  assert.equal((await runBackfill(store, before, () => {})).added, 1)
  assert.deepEqual(store.all().map(row => [row.seq, row.inputTokens]), [[9, 10]])

  // The same session after its log was migrated: the message now sits at seq 4.
  const migrated = persistenceOf({ s1: { events: [header(1, 'deepseek', 'm'), message(4, 10, 5)], version: 4 } })
  const report = await runBackfill(store, migrated, () => {})

  assert.equal(report.added, 1, 'the migrated log is folded again')
  assert.equal(store.size, 1, 'and the pre-migration row is gone, not kept beside it')
  assert.deepEqual(store.all().map(row => [row.seq, row.inputTokens]), [[4, 10]])
})

test('runBackfill: an unchanged log format does not re-fold anything', async () => {
  // The witness must not fire for the ordinary case: two passes on the same line
  // have to keep costing nothing.
  const store = newStore(tmpDir())
  const persistence = persistenceOf({ s1: { events: [header(1, 'deepseek', 'm'), message(2, 10, 5)], version: 4 } })
  assert.equal((await runBackfill(store, persistence, () => {})).added, 1)
  assert.equal((await runBackfill(store, persistence, () => {})).added, 0)
  assert.equal(store.size, 1)
})

test('runBackfill: a second pass over the same logs adds nothing (watermark)', async () => {
  const store = newStore(tmpDir())
  const persistence = persistenceOf({ s1: { events: [header(1, 'p', 'm'), message(2, 10, 5)] } })
  assert.equal((await runBackfill(store, persistence, () => {})).added, 1)
  assert.equal((await runBackfill(store, persistence, () => {})).added, 0)
  assert.equal(store.size, 1)
})

test('runBackfill: a live event that jumped a watermark gap does not hide the history it crossed', async () => {
  const store = newStore(tmpDir())
  // Folded through seq 10 by an earlier run; the log then kept growing while
  // this plugin was not capturing (app closed, another profile appended).
  foldEvents(store, 's1', [message(10, 10, 5)])
  assert.equal(store.watermark('s1'), 10)

  // The first live event after the restart is seq 20: seqs 11..19 were never
  // folded here. It folds, but must not move the watermark across them — every
  // later pass would then skip the gap for good.
  assert.equal(foldLiveEvent(store, 's1', message(20, 40, 20)), 1)
  assert.equal(store.watermark('s1'), 10, 'a jumped event leaves the watermark below the gap')

  const report = await runBackfill(store, persistenceOf({
    s1: { events: [message(11, 1, 1), message(15, 2, 2), message(20, 40, 20)], size: 300 },
  }), () => {})

  assert.equal(report.added, 2, 'the crossed history folds; seq 20 is deduped, not counted twice')
  assert.deepEqual(store.all().map(row => row.seq).sort((a, b) => a - b), [10, 11, 15, 20])
  assert.equal(store.watermark('s1'), 20, 'the backfill still advances to the last seq it folded')
})

test('runBackfill: one unreadable session is skipped, the rest still fold', async () => {
  const store = newStore(tmpDir())
  const broken: BackfillPersistence = {
    list: () => Promise.resolve([{ header: { id: 'bad' } }, { header: { id: 'good' } }]),
    open: (id: string) => id === 'bad'
      ? Promise.reject(new Error('log unreadable'))
      : Promise.resolve({
          read: () => Promise.resolve({ events: [header(1, 'p', 'm'), message(2, 10, 5)] }),
          close: () => Promise.resolve(),
        }),
  }
  const report = await runBackfill(store, broken, () => {})
  assert.equal(report.inspected, 1, 'the broken session is not inspected')
  assert.equal(report.added, 1, 'the good one still is')
})

test('runBackfill: an unchanged log size skips the read entirely', async () => {
  // The defect this guards: the pass opened and decompressed every log BEFORE
  // consulting a witness, so 256 unchanged sessions cost ~2.5 s of CPU at every
  // kernel start and every rescan interval.
  const store = newStore(tmpDir())
  const opens: string[] = []
  const persistence = persistenceOf({
    s1: { events: [header(1, 'p', 'm'), message(2, 10, 5)], size: 128 },
    s2: { events: [header(1, 'p', 'm'), message(2, 10, 5)], size: 256 },
  }, { opens })
  assert.equal((await runBackfill(store, persistence, () => {})).added, 2)
  opens.length = 0

  const report = await runBackfill(store, persistence, () => {})
  assert.equal(opens.length, 0, 'a size that did not move must never reach open()')
  assert.equal(report.skipped, 2, 'and both sessions are counted as skipped')
  assert.equal(report.inspected, 0)
  assert.equal(report.added, 0)
})

test('runBackfill: a log that grew is read again and its new rows folded', async () => {
  const store = newStore(tmpDir())
  assert.equal((await runBackfill(store, persistenceOf({
    s1: { events: [header(1, 'p', 'm'), message(2, 10, 5)], size: 128 },
  }), () => {})).added, 1)

  // The same session after one more message was appended: the size moved, so
  // the witness must not hide the tail.
  const opens: string[] = []
  const report = await runBackfill(store, persistenceOf({
    s1: { events: [header(1, 'p', 'm'), message(2, 10, 5), message(9, 20, 10)], size: 300 },
  }, { opens }), () => {})
  assert.deepEqual(opens, ['s1'])
  assert.equal(report.skipped, 0)
  assert.equal(report.added, 1, 'only the appended event is folded')
  assert.deepEqual(store.all().map(row => row.seq), [2, 9])
})

test('runBackfill: a snapshot without sizeBytes is read every pass', async () => {
  // The kernel may omit `sizeBytes`; the pass must then fall back to reading —
  // never skip a session on a value it does not have.
  const store = newStore(tmpDir())
  const opens: string[] = []
  const persistence = persistenceOf({
    s1: { events: [header(1, 'p', 'm'), message(2, 10, 5)] },
  }, { opens })
  await runBackfill(store, persistence, () => {})
  const report = await runBackfill(store, persistence, () => {})
  assert.deepEqual(opens, ['s1', 's1'], 'neither pass may skip without a size')
  assert.equal(report.skipped, 0)
  assert.equal(report.inspected, 1)
  assert.equal(report.added, 0, 'the watermark still keeps the second read free of rows')
})

test('runBackfill: the size witness survives a restart, so unchanged logs stay skipped', async () => {
  const dir = tmpDir()
  const first = newStore(dir)
  assert.equal((await runBackfill(first, persistenceOf({
    s1: { events: [header(1, 'p', 'm'), message(2, 10, 5)], size: 128 },
  }), () => {})).added, 1)
  // A real exit: the debounced flush has to land before the next start reads
  // the witness back, or an in-memory-only witness buys nothing at boot.
  first.dispose()

  const restarted = newStore(dir)
  const opens: string[] = []
  const report = await runBackfill(restarted, persistenceOf({
    s1: { events: [header(1, 'p', 'm'), message(2, 10, 5)], size: 128 },
  }, { opens }), () => {})
  assert.equal(opens.length, 0, 'the witness came back from fold-state.json')
  assert.equal(report.skipped, 1)
})

test('runBackfill: a format change re-reads a log whose size did not move', async () => {
  const store = newStore(tmpDir())
  const before = persistenceOf({ s1: { events: [header(1, 'p', 'm'), message(9, 10, 5)], version: 3, size: 128 } })
  assert.equal((await runBackfill(store, before, () => {})).added, 1)

  // The migration rewrote the log in place: same byte size, different seq
  // space. A witness that survived the format change would skip the re-fold and
  // leave the usage under the dead seq for ever.
  const opens: string[] = []
  const reopened = persistenceOf(
    { s1: { events: [header(1, 'p', 'm'), message(4, 10, 5)], version: 4, size: 128 } },
    { opens },
  )
  const report = await runBackfill(store, reopened, () => {})
  assert.deepEqual(opens, ['s1'])
  assert.equal(report.skipped, 0)
  assert.equal(report.added, 1)
  assert.deepEqual(store.all().map(row => [row.seq, row.inputTokens]), [[4, 10]])
})

test('runBackfill: a failed read records no size witness, so the next pass retries', async () => {
  const store = newStore(tmpDir())
  const opens: string[] = []
  let fail = true
  const persistence: BackfillPersistence = {
    list: () => Promise.resolve([{ header: { id: 's1' }, sizeBytes: 128 }]),
    open: (id: string) => {
      opens.push(id)
      if (fail) return Promise.reject(new Error('log unreadable'))
      return Promise.resolve({
        read: () => Promise.resolve({ events: [header(1, 'p', 'm'), message(2, 10, 5)] }),
        close: () => Promise.resolve(),
      })
    },
  }
  const first = await runBackfill(store, persistence, () => {})
  assert.equal(first.inspected, 0)
  fail = false

  const second = await runBackfill(store, persistence, () => {})
  // A witness written on the failed attempt would make the log unreadable
  // forever: the retry would be skipped, with no error to notice.
  assert.deepEqual(opens, ['s1', 's1'])
  assert.equal(second.skipped, 0)
  assert.equal(second.added, 1)
})

// --- singleFlightPass --------------------------------------------------------

test('singleFlightPass: overlapping calls run one pass and skip the other', async () => {
  let release: ((report: BackfillReport) => void) | undefined
  let started = 0
  const pass = singleFlightPass(() => {
    started += 1
    return new Promise<BackfillReport>((resolve) => { release = resolve })
  })
  const first = pass()
  const second = pass()
  assert.equal(started, 1, 'the second call must not start a pass')
  assert.equal(await second, undefined, 'the skipped round answers undefined')
  release!({ inspected: 1, skipped: 0, added: 0 })
  assert.deepEqual(await first, { inspected: 1, skipped: 0, added: 0 })
})

test('singleFlightPass: a finished pass releases the guard', async () => {
  let runs = 0
  const pass = singleFlightPass(() => {
    runs += 1
    return Promise.resolve({ inspected: runs, skipped: 0, added: 0 })
  })
  assert.equal((await pass())?.inspected, 1)
  assert.equal((await pass())?.inspected, 2, 'the next round runs once the first settled')
})

test('singleFlightPass: a rejected pass releases the guard too', async () => {
  let runs = 0
  const pass = singleFlightPass(() => {
    runs += 1
    return runs === 1
      ? Promise.reject(new Error('listing failed'))
      : Promise.resolve({ inspected: 1, skipped: 0, added: 0 })
  })
  // The error still reaches the caller's catch — the guard must not swallow it.
  await assert.rejects(pass(), /listing failed/)
  assert.equal((await pass())?.inspected, 1, 'a throwing pass must not wedge the guard')
})

// --- store flush failures ----------------------------------------------------

/** Obstruct the rows path so an append fails the way a full disk does. */
const blockRowsPath = async (dir: string): Promise<string> => {
  const rowsPath = join(dir, 'usage.jsonl')
  await rm(rowsPath, { recursive: true, force: true })
  mkdirSync(rowsPath)
  return rowsPath
}

test('store: a failed row write keeps the rows for the next flush', async () => {
  const dir = tmpDir()
  const messages: string[] = []
  const store = new UsageStore({ dir, log: (message) => { messages.push(message) } })
  store.load()
  const rowsPath = await blockRowsPath(dir)

  store.addRows([rowOf()])
  store.dispose()
  assert.ok(messages.some(line => line.includes('kept for retry')), 'the failure is reported, not swallowed')
  assert.ok(messages.some(line => line.includes('1 row(s) kept')), 'and the log says how many')
  assert.equal(store.size, 1, 'the row is not lost from the store')

  // Clear the obstruction: the next flush persists what was kept.
  await rm(rowsPath, { recursive: true, force: true })
  store.dispose()
  const written = readFileSync(rowsPath, 'utf8').trim().split('\n').filter(Boolean)
  assert.equal(written.length, 1, 'the kept row reaches disk on the retry')
})

test('store: watermarks are not written while their rows are unwritten', async () => {
  const dir = tmpDir()
  const store = new UsageStore({ dir, log: () => {} })
  store.load()
  const rowsPath = await blockRowsPath(dir)
  // A row that cannot be written, plus the watermark that would claim it was.
  store.addRows([rowOf()])
  store.advanceWatermark('s', 42)
  store.dispose()
  // Writing the watermark while its rows are missing is what made the loss
  // permanent: the backfill trusts the watermark and never re-reads those seqs.
  const files = readdirSync(dir)
  assert.ok(files.includes('usage.jsonl'), 'the obstructing path is still there')
  assert.ok(!files.includes('watermarks.json'), 'no watermark file while the rows are unwritten')

  // Once the rows land, the watermark follows.
  await rm(rowsPath, { recursive: true, force: true })
  store.dispose()
  assert.ok(readdirSync(dir).includes('watermarks.json'), 'the watermark is written after the rows are safe')
  assert.equal(JSON.parse(readFileSync(join(dir, 'watermarks.json'), 'utf8'))['s'], 42)
})

test('store: a size witness is not written while its rows are unwritten', async () => {
  const dir = tmpDir()
  const store = new UsageStore({ dir, log: () => {} })
  store.load()
  const rowsPath = await blockRowsPath(dir)
  // A row that cannot be written, plus a witness claiming it was folded.
  store.addRows([rowOf()])
  store.noteFoldedBytes('s', 128)
  store.dispose()
  // The witness has the same failure mode as the watermark: persisted early, it
  // tells the next backfill "this log is done" while its rows are still only in
  // memory, and the rows never come back.
  assert.ok(!readdirSync(dir).includes('fold-state.json'), 'no witness file while the rows it describes are unwritten')

  await rm(rowsPath, { recursive: true, force: true })
  store.dispose()
  const state = JSON.parse(readFileSync(join(dir, 'fold-state.json'), 'utf8'))
  assert.equal(state.foldedBytes['s'], 128, 'the witness lands once the rows are safe')
})

test('store: a watermark with no rows pending still persists (a session with no usage)', () => {
  const dir = tmpDir()
  const store = new UsageStore({ dir, log: () => {} })
  store.load()
  // Every event advances the watermark, including ones that carry no usage —
  // that is what stops such a session from being re-inspected forever, so this
  // write must NOT be tied to a pending row.
  store.advanceWatermark('quiet', 7)
  store.dispose()
  assert.equal(JSON.parse(readFileSync(join(dir, 'watermarks.json'), 'utf8'))['quiet'], 7)
})
