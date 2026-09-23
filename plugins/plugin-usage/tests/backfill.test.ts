/**
 * Unit tests for the historical backfill and the store's crash/retry
 * behaviour: the session-listing SHAPE (a wrapper, not a bare header — reading
 * the wrong field silently turned the whole pass into a no-op), the fork
 * inherited prefix (never folded twice), and a failed flush (rows are kept,
 * not dropped).
 *
 * Run via `npm test` (esbuild bundles TS → .test-dist, node --test runs it).
 *
 * @module @dsh-app/plugin-usage/tests/backfill
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listedSessionId, runBackfill, type BackfillPersistence } from '../src/backfill.ts'
import { foldEvents, type FoldEvent } from '../src/fold.ts'
import { UsageStore } from '../src/store.ts'
import type { UsageRow } from '../src/types.ts'

const tmpDir = (): string => mkdtempSync(join(tmpdir(), 'dshu-backfill-'))

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
  logs: Record<string, { events: FoldEvent[], inherited?: number, version?: number }>,
): BackfillPersistence => ({
  // The kernel's `list()` returns snapshot wrappers: the id lives on
  // `entry.header.id`. Returning bare headers here would make this test pass
  // against the very bug it exists to catch. The header also carries the LOG
  // FORMAT version, which is what the fold treats as its seq-space witness.
  list: () => Promise.resolve(Object.keys(logs).map(id => ({
    header: { id, ...(logs[id]?.version === undefined ? {} : { version: logs[id]!.version }) },
    sizeBytes: 0,
  }))),
  open: (id: string) => {
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
