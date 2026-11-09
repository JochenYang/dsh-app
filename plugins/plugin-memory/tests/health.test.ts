/**
 * The measurement layer: the health audit (B1), the injection counters (B2),
 * the rot markers (S1), the status columns (S2/W1), index reconciliation (W2)
 * and the domain-over ledger (D6).
 *
 * Every one of these exists to answer a question the plugin could not answer
 * before without a debugger: how many cards an assembly drops, whether the
 * index still describes the cards, how much of a card will rot. So the tests
 * assert the NUMBERS a real store produces, not that a function was called.
 *
 * @module @dsh-app/plugin-memory/tests/health
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scratchDir, scratchRoot, scratchStore } from './scratch.ts'
import {
  DOMAIN_CAP,
  MAX_DOMAIN_OVER_EVENTS,
  MAX_INDEX_DRIFT_EVENTS,
  MemoryRoot,
  listProjects,
  projectSlug,
  type MemoryCategory,
  type MemoryStore,
} from '../src/memory-store.ts'
import { MAX_PROJECT_CHARS, assembleMemoryText } from '../src/prompt.ts'
import { InjectionMetricsRing, MAX_INJECTION_SAMPLES } from '../src/injection-metrics.ts'
import { auditRoot, formatHealthTable, storeHealth, totalHealth } from '../src/health.ts'
import { hasRot, rotMarkerCount, rotMarkers, rotTotals } from '../src/card-rot.ts'
import { lightSweep } from '../src/light-sweep.ts'

const CATEGORIES: readonly MemoryCategory[] = ['preference', 'convention', 'decision', 'lesson', 'fact']

/** Save one card with a body of exactly `length` ASCII characters. The name
 *  leads the body so two cards are never byte-identical — the light sweep would
 *  merge those, which is correct behaviour and wrong for these fixtures. */
async function saveSized(store: MemoryStore, name: string, length: number, category: MemoryCategory = 'fact'): Promise<void> {
  await store.upsert({ name, category, summary: `${name} summary`, body: `${name} `.padEnd(length, 'x').slice(0, length) })
}

/** A store of `count` cards spread over every category (so no quota alone binds). */
async function seedStore(store: MemoryStore, count: number, bodyLength: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await saveSized(store, `card-${String(i).padStart(2, '0')}`, bodyLength, CATEGORIES[i % CATEGORIES.length]!)
  }
}

const NOOP_LOG = { info: (): void => { /* silent */ }, warn: (): void => { /* silent */ } }

// --- B1: the health audit -----------------------------------------------------

test('B1 auditRoot: one row per project store plus a total, and an empty root is not an error', async () => {
  const root = scrapeRoot()
  await seedStore(root.projectFor('D:\\proj\\one'), 3, 100)
  await seedStore(root.projectFor('D:\\proj\\two'), 5, 100)

  const audit = auditRoot(root.dir)
  assert.equal(audit.rows.length, 2, 'one row per project store')
  assert.equal(audit.total.stores, 2)
  assert.equal(audit.total.cards, 8)
  assert.equal(audit.total.cards, audit.rows.reduce((sum, row) => sum + row.cards, 0))
  // The two numbers the plan's baseline is stated in.
  assert.equal(audit.total.bodiesInjected, audit.rows.reduce((sum, row) => sum + row.bodiesInjected, 0))
  assert.equal(audit.total.droppedCards, audit.total.cards - audit.total.bodiesInjected)
  for (const row of audit.rows) {
    assert.equal(row.cards, row.bodiesInjected + row.droppedCards)
    assert.equal(row.indexGhosts, 0)
    assert.equal(row.indexUnlisted, 0)
  }

  const table = formatHealthTable(audit, true)
  const lines = table.split('\n')
  assert.match(lines[0]!, /^# snapshot .*cards=8 /u, 'the snapshot line pins the card count')
  assert.match(lines[0]!, /fingerprint=[0-9a-f]{12}/u)
  assert.equal(lines.length, 3 + 2, 'header + 2 rows + total')
  assert.match(lines[lines.length - 1]!, /^TOTAL/u)

  const empty = auditRoot(scratchDir('dshm-health-empty-'))
  assert.equal(empty.rows.length, 0)
  assert.equal(empty.total.cards, 0)
  assert.equal(formatHealthTable(empty).split('\n').length, 2, 'header + total, no rows')
})

/** Path to the CLI under test (the bundle lives in `.test-dist/`, sources one level up). */
function healthScript(): string {
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'memory-health.mjs')
  assert.ok(existsSync(script), `missing ${script}`)
  return script
}

/** Run the CLI with arguments and return stdout. */
function runHealth(...args: string[]): string {
  return execFileSync(process.execPath, [healthScript(), ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

test('B1 script: the CLI prints the table and exits 0, and an empty root prints no store rows', async () => {
  const root = scrapeRoot()
  // The project slug is derived from the cwd, so the row is only nameable if a
  // store actually exists — seed one instead of printing an empty table.
  await seedStore(root.projectFor('D:\\proj\\cli'), 2, 40)
  const empty = scratchDir('dshm-health-cli-')
  const emptyOut = runHealth('--root', empty)
  assert.match(emptyOut, /TOTAL/u)
  // Header + total and NOTHING between them: an empty root must not invent a row.
  assert.equal(emptyOut.trim().split('\n').length, 2, 'an empty root prints a header and a total, no store rows')
  // A root with a store exits 0, pins the snapshot, and NAMES the store (a row
  // that is printed but unreadable is worse than none).
  const withStore = runHealth('--root', root.dir, '--snapshot')
  assert.match(withStore, /^# snapshot .*cards=2 /u)
  assert.match(withStore, /^cli-[0-9a-f]{8}/mu, 'the project row is printed by slug')
  assert.match(withStore, /^TOTAL/mu)
})

test('B1 script: a root that does not exist still honours --json and --snapshot', () => {
  // A missing root is a legitimate state (a kernel that never saved anything).
  // Branching early on `existsSync` printed a comment instead, which broke both
  // machine-readable modes for exactly the caller most likely to script this.
  const missing = join(scratchDir('dshm-health-missing-'), 'not-a-root')
  assert.equal(existsSync(missing), false)

  const parsed = JSON.parse(runHealth('--root', missing, '--json')) as {
    rows: unknown[]
    total: { stores: number, cards: number, fingerprint: string }
  }
  assert.deepEqual(parsed.rows, [])
  assert.equal(parsed.total.cards, 0)
  assert.equal(parsed.total.stores, 0)
  assert.match(parsed.total.fingerprint, /^[0-9a-f]{64}$/u, 'the anchor is still a fingerprint of nothing')

  const snapshot = runHealth('--root', missing, '--snapshot')
  assert.match(snapshot, /^# snapshot .*cards=0 stores=0 fingerprint=[0-9a-f]{12} /u)
  assert.match(snapshot, /^TOTAL/mu)
})

/** A root whose project stores the test can seed (synchronously created). */
function scrapeRoot(): MemoryRoot {
  return scratchRoot('dshm-health-root-')
}

// --- B2: the injection counters ------------------------------------------------

test('B2 droppedCards: a 26-card store injects 8 bodies and drops 18', async () => {
  const root = new MemoryRoot(scratchDir('dshm-health-drop-root-'))
  const projectStore = root.projectFor('D:\\proj\\drop')
  await seedStore(projectStore, 26, 300)
  const metrics = assembleMemoryText(root, 'D:\\proj\\drop').metrics
  assert.ok(metrics !== undefined)
  assert.equal(metrics.cardCount, 8, 'the 2800-char budget carries eight 300-char bodies')
  assert.equal(metrics.droppedCards, 18, 'the loss the plan is stated in')
  assert.equal(metrics.truncated, true)
  assert.ok(metrics.bodyChars <= MAX_PROJECT_CHARS)
})

test('B2 indexOverflowLines: a 51-line index overflows the 50-line ceiling by one', async () => {
  const root = new MemoryRoot(scratchDir('dshm-health-overflow-'))
  const store = root.projectFor('D:\\proj\\overflow')
  for (let i = 0; i < 51; i += 1) await saveSized(store, `card-${String(i).padStart(2, '0')}`, 20)
  const metrics = assembleMemoryText(root, 'D:\\proj\\overflow').metrics
  assert.ok(metrics !== undefined)
  assert.equal(metrics.indexLines, 50, 'the injected block carries the ceiling, not the store')
  assert.equal(metrics.indexOverflowLines, 1)
})

test('B2 ring: the mean carries both counters', () => {
  const ring = new InjectionMetricsRing()
  const base = {
    guidelinesChars: 100,
    indexChars: 10,
    bodyChars: 20,
    totalChars: 130,
    cardCount: 2,
    indexLines: 2,
    droppedCards: 4,
    indexOverflowLines: 0,
    truncated: true,
  }
  ring.record(base, 'proj')
  ring.record({ ...base, droppedCards: 8, indexOverflowLines: 2 }, 'proj')
  const summary = ring.summary()
  assert.ok(summary !== undefined)
  assert.equal(summary.mean.droppedCards, 6)
  assert.equal(summary.mean.indexOverflowLines, 1)
  assert.equal(summary.latest.droppedCards, 8)
  assert.equal(summary.truncatedSamples, 2)
})

// --- S1: rot markers -----------------------------------------------------------

test('S1 rotMarkers: the four decay-prone kinds are counted, with the matched text', () => {
  const body = 'Electron 44.2.1 下 preload 在 src/main/window.ts 第 120 行，提交 4f2c9ab1d 之后失效。'
  const found = rotMarkers(body)
  const kinds = new Set(found.map(marker => marker.kind))
  assert.deepEqual([...kinds].sort(), ['line', 'path', 'sha', 'version'])
  assert.ok(found.some(marker => marker.text === '44.2.1'))
  assert.ok(found.some(marker => marker.text.includes('src/main/window.ts')))
  assert.ok(found.some(marker => marker.text === '4f2c9ab1d'))
  assert.equal(rotMarkerCount(body), found.length)
  assert.equal(hasRot(body), true)
  // The English spelling counts, and it is case-insensitive.
  assert.equal(rotMarkerCount('see LINE 42 of the log'), 1)
})

test('S1 rotMarkers: a plain number, a short hex, and a Chinese sentence are not markers', () => {
  for (const body of ['缓存上限 1048576 字节', '色值 ff', '构建产物在 dist 目录下', '先跑类型检查再跑测试']) {
    assert.equal(rotMarkerCount(body), 0, `false positive on: ${body}`)
  }
  assert.equal(hasRot(''), false)
})

test('S1 rotMarkers: the three shapes that LOOK like markers but are not', () => {
  // Each of these was a real false positive measured on the 193-card store, and
  // each is a different kind of near-miss (see the comments in card-rot.ts): a
  // host:port is not a line, an IPv4 address is not a version, and a pair of
  // file names is not a path.
  assert.equal(rotMarkerCount('proxy 监听 localhost:3000，回环 127.0.0.1:8080'), 0, 'host:port is not a line reference')
  assert.equal(rotMarkerCount('镜像 api.github.com:443 与 registry.npmjs.org:8443'), 0, 'a hostname with a port is not a line reference either')
  assert.equal(rotMarkerCount('本地回环是 127.0.0.1'), 0, 'an IPv4 address is not a version')
  assert.equal(rotMarkerCount('特征值 FF00:0002'), 0, 'a BLE UUID is not a line reference')
  assert.equal(rotMarkerCount('同时读 config.toml/config.yaml'), 0, 'two file names are not a filesystem path')
  assert.equal(rotMarkerCount('提交主题写 deadbeef 这种纯字母'), 0, 'pure letters are not a commit id')
  assert.equal(rotMarkerCount('L2 缓存命中率'), 0, 'a cache level is not a line reference')
  assert.equal(rotMarkerCount('文件在 src/main/x.ts:120'), 1, 'the file path counts; the bare line suffix does not')
})

test('S1 rotTotals: reports which kind dominates, not only how many', () => {
  const totals = rotTotals([
    'v1.2.3 与 C:\\work\\a.ts',
    '见 src/b/c.ts 第 12 行',
    '没有具体引用',
  ])
  assert.equal(totals.cards, 2, 'only cards with a marker count as rot cards')
  assert.ok(totals.markers >= 3)
  assert.ok(totals.byKind.version >= 1)
  assert.ok(totals.byKind.path >= 2)
  assert.ok(totals.byKind.line >= 1)
  assert.equal(totals.byKind.sha, 0)
})

// --- S2: status columns --------------------------------------------------------

/** The store the `/status`-versus-audit test seeds. */
const STATUS_CWD = 'D:\\proj\\status-parity'

test('S2 /status and the health audit report the SAME rot/stale numbers', async () => {
  // The two surfaces exist for different readers and are computed by different
  // calls (`listProjects` vs `storeHealth`), so "they agree" is a claim that
  // needs a test: a drift here means one of the two is quietly lying.
  const root = new MemoryRoot(scratchDir('dshm-health-parity-'))
  const store = root.projectFor(STATUS_CWD)
  await store.upsert({ name: 'pinned-version', category: 'fact', summary: '版本钉住', body: '内核钉在 v0.18.7，入口 src/kernel/manager.ts:120。' })
  await store.upsert({ name: 'plain-note', category: 'fact', summary: '普通说明', body: '这条没有任何具体引用。' })
  await store.upsert({ name: 'aged-note', category: 'lesson', summary: '老卡', body: '这条也没有引用，但日期很旧。' })
  const { join: joinPath } = await import('node:path')
  writeFileSync(joinPath(store.storePath, 'aged-note.md'), '---\nname: aged-note\ncategory: lesson\nsummary: 老卡\ncreated: 2020-01-01\nupdated: 2020-01-01\n---\n\n这条也没有引用，但日期很旧。\n')

  const statusRow = listProjects(root.dir).find(row => row.slug === projectSlug(STATUS_CWD))
  assert.ok(statusRow !== undefined)
  const auditRow = storeHealth(store, statusRow.slug)
  assert.equal(statusRow.rotCards, auditRow.rotCards)
  assert.equal(statusRow.staleCards, auditRow.staleCards)
  assert.equal(statusRow.cards, auditRow.cards)
  assert.equal(statusRow.indexLines, auditRow.indexLines)
  assert.equal(statusRow.domains, auditRow.domains)
  assert.equal(auditRow.rotCards, 1, 'one card names a version and a line')
  assert.equal(auditRow.staleCards, 1, 'one card is older than ROT_DAYS')
})


test('S2 metrics: rot and staleness are counted per store, and a fresh card is not stale', async () => {
  const store = scratchStore('dshm-health-rot-')
  await store.upsert({ name: 'pinned-version', category: 'fact', summary: '版本钉住', body: '内核钉在 v0.18.7，入口 src/kernel/manager.ts:120。' })
  await store.upsert({ name: 'plain-note', category: 'fact', summary: '普通说明', body: '这条没有任何具体引用。' })
  const metrics = store.metrics()
  assert.equal(metrics.rotCards, 1)
  assert.ok(metrics.rotMarkers >= 2)
  assert.equal(metrics.staleCards, 0, 'nothing in this store is 90 days old')

  // Age one card by rewriting its `updated` stamp in place.
  const path = join(store.storePath, 'plain-note.md')
  writeFileSync(path, '---\nname: plain-note\ncategory: fact\nsummary: 普通说明\ncreated: 2020-01-01\nupdated: 2020-01-01\n---\n\n这条没有任何具体引用。\n')
  assert.equal(store.metrics().staleCards, 1)
})

test('S2 injection is untouched: the whole injected text still costs exactly what it did', async () => {
  // A GOLDEN fixture, not a self-comparison: the S-batch added rot/stale
  // measurement that must land in `/status` and NOWHERE in the prompt, so the
  // only evidence that counts is fixed character counts over a store that HAS a
  // rot card. Recorded 2026-11-09 (the date is a fixed 10 characters, so the
  // numbers do not drift with the clock); a change here means injection got
  // more expensive — which is the failure this guards.
  const CWD = 'D:\\proj\\injection'
  const root = new MemoryRoot(scratchDir('dshm-health-golden-'))
  const store = root.projectFor(CWD)
  await store.upsert({ name: 'dsh-pinned-version', category: 'preference', summary: '版本钉住', body: '内核钉在 v0.18.7，入口 src/kernel/manager.ts。' })
  await store.upsert({ name: 'plain-note', category: 'fact', summary: '普通说明', body: '这条没有任何具体引用。' })
  const assembly = assembleMemoryText(root, CWD)
  assert.deepEqual(assembly.metrics, {
    guidelinesChars: 3174,
    indexChars: 178,
    bodyChars: 149,
    totalChars: 3607,
    cardCount: 2,
    indexLines: 2,
    droppedCards: 0,
    indexOverflowLines: 0,
    truncated: false,
  })
  // The rot card is IN the prompt as text, and nothing beside it annotates the
  // rot: the pinned counts above are what enforce that (any added character —
  // a refs count, a staleness note — moves one of them).
  assert.match(assembly.text, /内核钉在 v0\.18\.7/u)
  assert.equal(assembly.metrics.totalChars, assembly.text.length, 'the ledger covers the whole injected text')
})

// --- W2: index reconciliation --------------------------------------------------

test('W2 indexDrift: a ghost line and an unlisted card are both reported', async () => {
  const store = scratchStore('dshm-health-drift-')
  await saveSized(store, 'card-a', 20)
  await saveSized(store, 'card-b', 20)
  await store.reindex()
  // The measured shape: one line names a topic that no longer exists, one card
  // has no line at all.
  const text = store.indexText()
    // No newline requirement in the pattern: the LAST line has none after the
    // trimmed read, and a regex that insisted on one silently left it in place.
    .replace(/- \[[a-z]+\] card-b[^\n]*/u, '')
  writeFileSync(join(dirname(store.storePath), 'index.md'), `${text}\n- [fact] vanished-topic — gone (updated 2026-01-01)\n`)

  const drift = store.indexDrift()
  assert.ok(drift !== undefined)
  assert.deepEqual(drift.ghostKeys, ['vanished-topic'])
  assert.deepEqual(drift.unlistedKeys, ['card-b'])
  assert.equal(drift.cards, 2)
})

test('W2 reconcileIndexes: drift is repaired, recorded once, and the second pass is quiet', async () => {
  const root = new MemoryRoot(scratchDir('dshm-health-reconcile-'))
  const store = root.projectFor('D:\\proj\\drift')
  await saveSized(store, 'card-a', 20)
  const index = join(dirname(store.storePath), 'index.md')
  writeFileSync(index, '# Memory index (auto-generated from topics/; edits are overwritten)\n\n- [fact] ghost-topic — gone (updated 2026-01-01)\n')
  assert.ok(store.indexDrift() !== undefined)

  const events = await root.reconcileIndexes()
  assert.equal(events.length, 1)
  assert.equal(events[0]!.scope, projectSlug('D:\\proj\\drift'), 'the event is labelled with the project slug the store belongs to')
  assert.equal(events[0]!.repaired, true)
  assert.deepEqual(events[0]!.ghostKeys, ['ghost-topic'])
  assert.equal(store.indexDrift(), undefined, 'the index now describes the cards')
  assert.equal(root.indexDrifts().length, 1)
  assert.equal(root.indexDrifts()[0]!.scope, events[0]!.scope)

  assert.deepEqual(await root.reconcileIndexes(), [], 'an in-step index is not rewritten')
  assert.equal(root.indexDrifts().length, 1, 'and no event is recorded for it')
})

test('W2 indexDrift: a duplicated line is drift too, and reconciliation removes it', async () => {
  // A set comparison would call this "in step" while the duplicate rides every
  // session of the project. This is the case the plan's motivating store showed
  // in its other direction (a ghost line), so both shapes are covered.
  const root = new MemoryRoot(scratchDir('dshm-health-dup-'))
  const store = root.projectFor('D:\\proj\\dup')
  await saveSized(store, 'card-a', 20)
  const index = join(dirname(store.storePath), 'index.md')
  const line = store.indexText().split('\n').find(text => text.startsWith('- '))!
  writeFileSync(index, `${store.indexText()}\n${line}\n`)

  const drift = store.indexDrift()
  assert.ok(drift !== undefined)
  assert.deepEqual(drift.duplicatedKeys, ['card-a'])
  assert.deepEqual(drift.ghostKeys, [])
  const events = await root.reconcileIndexes()
  assert.equal(events.length, 1)
  assert.deepEqual(events[0]!.duplicatedKeys, ['card-a'])
  assert.equal(store.indexDrift(), undefined)
})

test('W2 reconcileIndexes: an unreadable card suppresses reconciliation instead of erasing its line', async () => {
  const root = new MemoryRoot(scratchDir('dshm-health-unreadable-'))
  const store = root.projectFor('D:\\proj\\unreadable')
  await saveSized(store, 'card-a', 20)
  // A DIRECTORY where a card file should be: EISDIR, the shape a card nobody
  // can read takes. `list()` drops it, so without the guard the reconciler
  // would call its index line a ghost and delete it.
  mkdirSync(join(store.storePath, 'card-broken.md'))
  assert.equal(store.indexDrift(), undefined)
  assert.deepEqual(await root.reconcileIndexes(), [])
})

test('W2 drift events are bounded', () => {
  const root = new MemoryRoot(scratchDir('dshm-health-drift-cap-'))
  const events = Array.from({ length: MAX_INDEX_DRIFT_EVENTS + 5 }, (_, i) => ({
    scope: `proj-${String(i)}`,
    indexLines: 1,
    cards: 1,
    ghostKeys: ['ghost'],
    unlistedKeys: [],
    repaired: true,
  }))
  root.recordIndexDrifts(events)
  assert.equal(root.indexDrifts().length, MAX_INDEX_DRIFT_EVENTS)
  assert.equal(root.indexDrifts()[0]!.scope, `proj-${String(events.length - 1)}`, 'newest first')
})

test('W2 the snapshot fingerprint follows CONTENT, not card counts', async () => {
  // A store whose card is rewritten to the same length must move the anchor, or
  // a before/after comparison would read two different stores as one.
  const root = new MemoryRoot(scratchDir('dshm-health-fingerprint-'))
  const store = root.projectFor('D:\\proj\\fingerprint')
  await saveSized(store, 'card-a', 40)
  const before = auditRoot(root.dir).total.fingerprint
  await saveSized(store, 'card-a', 40, 'convention')
  const after = auditRoot(root.dir).total.fingerprint
  assert.equal(store.list()[0]!.body.length, store.list()[0]!.body.length)
  assert.notEqual(before, after, 'same length, different content → different fingerprint')
})

// --- D6: the domain-over ledger ------------------------------------------------

test('D6 recordDomainOvers: FIFO keeps the newest 50 measurements', () => {
  const root = new MemoryRoot(scratchDir('dshm-health-domainover-'))
  for (let i = 0; i < MAX_DOMAIN_OVER_EVENTS + 1; i += 1) {
    root.recordDomainOvers('proj', [{ domain: `d${String(i)}`, cards: DOMAIN_CAP + 1, cap: DOMAIN_CAP }])
  }
  const over = root.domainOvers()
  assert.equal(over.length, MAX_DOMAIN_OVER_EVENTS)
  assert.equal(over[0]!.domain, `d${String(MAX_DOMAIN_OVER_EVENTS)}`, 'newest first')
  assert.equal(over[0]!.cap, DOMAIN_CAP, 'the cap in force is recorded, so an old row stays interpretable')
})

test('D6 light sweep records the over-cap domains and nothing else', async () => {
  const root = new MemoryRoot(scratchDir('dshm-health-sweep-over-'))
  const store = root.projectFor('D:\\proj\\sweep')
  for (let i = 0; i < DOMAIN_CAP + 2; i += 1) await saveSized(store, `dsh-card-${String(i)}`, 20)
  await saveSized(store, 'windows-card', 20)
  await lightSweep(root, 'proj', store, NOOP_LOG)
  const over = root.domainOvers()
  assert.equal(over.length, 1)
  assert.equal(over[0]!.domain, 'dsh')
  assert.equal(over[0]!.cards, DOMAIN_CAP + 2)
  assert.equal(store.list().length, DOMAIN_CAP + 3, 'measurement never removes a card')
})

test('W2 indexDrift: a line the host would never write is drift, and it stops being injected', async () => {
  // `cappedIndex()` injects the index file VERBATIM, so an unparseable row rides
  // every session of that project. Counting only the lines that DO parse would
  // call this "in step" while the junk keeps being injected.
  const root = new MemoryRoot(scratchDir('dshm-health-malformed-'))
  const store = root.projectFor('D:\\proj\\malformed')
  await saveSized(store, 'card-a', 20)
  const index = join(dirname(store.storePath), 'index.md')
  writeFileSync(index, `${store.indexText()}\n- not a valid index row\n`)

  const drift = store.indexDrift()
  assert.ok(drift !== undefined)
  assert.deepEqual(drift.malformedLines, ['- not a valid index row'])
  assert.deepEqual(drift.ghostKeys, [])
  assert.equal(drift.indexLines, 1, 'only the parseable row counts as a card line')
  assert.ok(assembleMemoryText(root, 'D:\\proj\\malformed').text.includes('not a valid index row'), 'and it was being injected')

  const events = await root.reconcileIndexes()
  assert.equal(events.length, 1)
  assert.deepEqual(events[0]!.malformedLines, ['- not a valid index row'])
  assert.equal(store.indexDrift(), undefined)
  assert.equal(assembleMemoryText(root, 'D:\\proj\\malformed').text.includes('not a valid index row'), false, 'the rebuilt index stopped carrying it')
})

test('W2 reconcileIndexes: an unreadable index is left alone and cannot fail the metrics', async () => {
  // A DIRECTORY where `index.md` should be: EISDIR. The audit and `/status`
  // count with this file, so it must answer "zero lines" instead of throwing —
  // and the drift probe must refuse to reconcile a file nobody could read.
  const root = new MemoryRoot(scratchDir('dshm-health-badindex-'))
  const store = root.projectFor('D:\\proj\\badindex')
  await saveSized(store, 'card-a', 20)
  // The write above left a real index FILE; replace it with a directory (EISDIR).
  unlinkSync(join(dirname(store.storePath), 'index.md'))
  mkdirSync(join(dirname(store.storePath), 'index.md'))
  assert.equal(store.metrics().indexLines, 0)
  assert.equal(store.indexDrift(), undefined, 'cannot read it → do not touch it')
  assert.deepEqual(await root.reconcileIndexes(), [])
  assert.ok(store.list().length === 1, 'the cards are untouched')
})

test('D6 light sweep measures the store the NEXT pass will see', async () => {
  // Counted from the pre-merge list, the number answered "how many cards did
  // this pass START with" — which cannot be the input to a cap decision. Two
  // corrections are measured here: exact duplicates removed by step 1, and a
  // malformed hand-edited card, which the sweep's own merge list filters out
  // but which still occupies the bucket.
  const root = new MemoryRoot(scratchDir('dshm-health-sweep-fresh-'))
  const store = root.projectFor('D:\\proj\\sweep-fresh')
  for (let i = 0; i < DOMAIN_CAP + 1; i += 1) await saveSized(store, `dsh-card-${String(i)}`, 20)
  // An exact duplicate of the last card: step 1 merges it away (same body).
  await store.upsert({ name: 'dsh-card-dup', category: 'fact', summary: 'dsh-card-8 summary', body: 'dsh-card-8 '.padEnd(20, 'x').slice(0, 20) })
  // A hand-edited file: carried verbatim, never merged, still a card.
  writeFileSync(join(store.storePath, 'dsh-broken.md'), 'hand written, no frontmatter')
  assert.equal(store.list().length, DOMAIN_CAP + 3, 'nine real cards, one duplicate, one malformed')

  await lightSweep(root, 'proj', store, NOOP_LOG)
  const over = root.domainOvers()
  assert.equal(store.list().length, DOMAIN_CAP + 2, 'the exact duplicate was merged away')
  assert.equal(over.length, 1)
  assert.equal(over[0]!.cards, DOMAIN_CAP + 2, 'the recorded count is the post-merge one, malformed card included')
})

test('D6 an old state file without the new keys reads as empty, not as an error', () => {
  const dir = scratchDir('dshm-health-oldstate-')
  writeFileSync(join(dir, 'distill-state.json'), `${JSON.stringify({ version: 1, curated: { proj: 'abc' }, suspects: [] }, null, 2)}\n`)
  const root = new MemoryRoot(dir)
  assert.deepEqual(root.domainOvers(), [])
  assert.deepEqual(root.indexDrifts(), [])
  assert.equal(root.curatedHashOf('proj'), 'abc', 'the keys it does define still work')
})

// --- storeHealth ---------------------------------------------------------------

test('storeHealth: one row explains where the numbers came from', async () => {
  const root = new MemoryRoot(scratchDir('dshm-health-row-'))
  const store = root.projectFor('D:\\proj\\row')
  await saveSized(store, 'dsh-card-a', 30, 'preference')
  await saveSized(store, 'dsh-card-b', 30, 'convention')
  await saveSized(store, 'windows-card', 30, 'decision')
  const row = storeHealth(store, 'row')
  assert.equal(row.cards, 3)
  assert.equal(row.domains, 2)
  assert.equal(row.maxDomainCards, 2)
  assert.equal(row.droppedCards, 0)
  assert.equal(row.overBudget, false)
  // Two cards share a domain and one differs; the pair below is the closest,
  // so the number has to be a real measurement rather than "in 0..1".
  assert.ok(row.maxPairwiseSim > 0, 'two sibling cards score above zero')
  assert.ok(row.maxPairwiseSim < 1, 'and less than identical')
  assert.equal(row.indexGhosts, 0)
  assert.equal(totalHealth([row]).stores, 1)
})
