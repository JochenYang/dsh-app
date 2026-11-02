/**
 * The retention policy: a closed set of tiers, a malformed file that is never
 * written back, and one sweep implementation behind both the startup switch and
 * the settings page's button.
 *
 * What is load-bearing here:
 *   - `0` is "keep for ever" — a VALID tier. Every coercion that goes through
 *     `Number()` turns `null`/`''`/`[]` into `0`, which would silently become the
 *     one tier that never deletes anything. A field is accepted by TYPE and VALUE
 *     or not at all (measured: `{ retentionDays: null }` → 30, not 0);
 *   - a read never rewrites the file: a hand-edited or newer-version file is read
 *     as the defaults and reported, and its bytes stay exactly as they were;
 *   - the sweep removes an entry strictly older than the tier, keeps one inside it,
 *     does nothing at all at `0`, and removes a purged session's projection-cache
 *     shard through the same modules `/purge` uses (`./projcache.ts`,
 *     `./fs-util.ts`'s retrying removal);
 *   - `/sweep` and the startup path run ONE function (`runRetentionSweep`), which
 *     the last test asserts at the source level because the startup branch needs a
 *     real cordis Context to exercise.
 *
 * @module @dsh-app/plugin-archives/tests/retention
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_SETTINGS,
  RETENTION_DAYS,
  SAFE_SETTINGS,
  isRetentionDays,
  normalizeSettings,
  readSettings,
  settingsPathIn,
  writeSettings,
} from '../src/settings.ts'
import { retentionCutoff, sweepExpired } from '../src/retention.ts'
import { runRetentionSweep, ROUTE_PREFIX } from '../src/routes.ts'
import { cleanup, created, call, fixture, request } from './harness.ts'

after(cleanup)

const DAY_MS = 86_400_000

/** A fresh home to hold one settings file. */
async function home(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'dshar-settings-'))
  created.push(base)
  return base
}

// --- normalization: `0` is a tier, junk is not ------------------------------

test('a valid tier survives as itself, and 0 is a valid tier', () => {
  for (const days of RETENTION_DAYS) assert.equal(isRetentionDays(days), true, `${days} is a tier`)
  const keepForever = normalizeSettings({ version: 1, retentionDays: 0, sweepOnStartup: false })
  assert.deepEqual(keepForever, {
    settings: { version: 1, retentionDays: 0, sweepOnStartup: false },
    malformed: false,
  })
})

test('a wrong-typed field reads as the SAFE value, never toward deletion', () => {
  // `Number('0')` is 0 and `Number(null)` is 0 — a coercion would make junk look like
  // "keep for ever" without saying so; the other direction (`'0'` → 30 days) is worse:
  // it turns a typo into an authorization to delete. Both fall back to the safe tier
  // AND report the file, so the page can say the policy is not being used.
  for (const junk of [null, '', '7', [], false, 1, 45, -1, 7.5, Number.NaN, { days: 7 }]) {
    const normalized = normalizeSettings({ version: 1, retentionDays: junk, sweepOnStartup: true })
    assert.equal(normalized.settings.retentionDays, SAFE_SETTINGS.retentionDays, `${JSON.stringify(junk)} → safe tier`)
    assert.equal(normalized.settings.retentionDays, 0, `${JSON.stringify(junk)} must not read as 30 days`)
    assert.equal(normalized.malformed, true)
  }
  // The exact trap this rule exists for: a string that LOOKS like the zero tier.
  assert.equal(normalizeSettings({ version: 1, retentionDays: '0', sweepOnStartup: true }).settings.retentionDays, 0)
  // ... and a string that looks like "off" must never switch the sweep ON.
  for (const junk of ['false', 'true', 0, 1, null]) {
    const normalized = normalizeSettings({ version: 1, retentionDays: 7, sweepOnStartup: junk })
    assert.equal(normalized.settings.sweepOnStartup, false, `sweepOnStartup ${JSON.stringify(junk)} → off, never on`)
    assert.equal(normalized.settings.retentionDays, 7, 'and the tier that was readable is still used')
    assert.equal(normalized.malformed, true)
  }
})

test('one bad field does not reset the other', () => {
  // A file wrong in one place is still right in another: the user's sweep choice
  // must survive a tier this build does not know.
  const normalized = normalizeSettings({ version: 1, retentionDays: 3, sweepOnStartup: false })
  assert.deepEqual(normalized.settings, { version: 1, retentionDays: 0, sweepOnStartup: false })
  assert.equal(normalized.malformed, true)
})

test('a file from another version is not reinterpreted, and expires nothing', () => {
  // A newer kernel may mean something else by the same field names — and the file may
  // well say "keep for ever" in a shape this build would read as "30 days". Reading it
  // as the SAFE policy is the only answer that cannot delete something.
  for (const version of [0, 2, '1', undefined, null]) {
    const normalized = normalizeSettings({ version, retentionDays: 7, sweepOnStartup: true })
    assert.deepEqual(normalized.settings, SAFE_SETTINGS, `version ${JSON.stringify(version)} reads as the safe policy`)
    assert.equal(normalized.settings.retentionDays, 0)
    assert.equal(normalized.settings.sweepOnStartup, false)
    assert.equal(normalized.malformed, true)
  }
})

// --- the file: read without rewriting --------------------------------------

test('a missing settings file is the defaults, and not a malformed one', async () => {
  const path = settingsPathIn(await home())
  const read = await readSettings(path)
  assert.deepEqual(read.settings, DEFAULT_SETTINGS)
  assert.equal(read.malformed, false, 'the first run is not a fault')
  assert.equal(existsSync(path), false, 'reading creates nothing')
})

test('an unreadable or malformed file is read as the SAFE policy and left byte-identical', async () => {
  const path = settingsPathIn(await home())
  await mkdir(join(path, '..'), { recursive: true })
  const junk = '{"version":1,"retentionDays":null,"sweepOnStartup":"yes"}\n'
  await writeFile(path, junk)
  const read = await readSettings(path)
  assert.deepEqual(read.settings, SAFE_SETTINGS)
  assert.equal(read.malformed, true)
  assert.equal(await readFile(path, 'utf8'), junk, 'a read is not a write: the file is exactly as it was')

  // Not even JSON: the same rule.
  const broken = '{ this is not json'
  await writeFile(path, broken)
  assert.deepEqual((await readSettings(path)).settings, SAFE_SETTINGS)
  assert.equal(await readFile(path, 'utf8'), broken)

  // A file that says exactly the safe thing, in a version this build does not know.
  const newer = '{"version":2,"retentionDays":0,"sweepOnStartup":false}\n'
  await writeFile(path, newer)
  const unreadableVersion = await readSettings(path)
  assert.deepEqual(unreadableVersion.settings, SAFE_SETTINGS)
  assert.equal(unreadableVersion.malformed, true)
  assert.equal(await readFile(path, 'utf8'), newer)

  // Unreadable for a filesystem reason (a directory where the file should be): the
  // same answer, and the warning says why.
  const directoryPath = settingsPathIn(await home())
  await mkdir(directoryPath, { recursive: true })
  const unreadable = await readSettings(directoryPath)
  assert.deepEqual(unreadable.settings, SAFE_SETTINGS, 'nothing expires on a policy that could not be read')
  assert.equal(unreadable.malformed, true)
  assert.match(unreadable.detail ?? '', /expiry and the startup sweep stay off/)
})

test('a write stores the NORMALIZED value, so it reads back identically', async () => {
  const path = settingsPathIn(await home())
  const written = await writeSettings(path, { version: 1, retentionDays: 7, sweepOnStartup: false })
  assert.deepEqual(written, { version: 1, retentionDays: 7, sweepOnStartup: false })
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), written)

  // `0` round-trips as `0`, not as "absent" and not as the default.
  await writeSettings(path, { version: 1, retentionDays: 0, sweepOnStartup: true })
  assert.deepEqual((await readSettings(path)).settings, { version: 1, retentionDays: 0, sweepOnStartup: true })

  // An out-of-set tier handed to the write path is stored as the SAFE tier, never as
  // the number it happened to be and never as the product default.
  const coerced = await writeSettings(path, { version: 1, retentionDays: 3, sweepOnStartup: true })
  assert.equal(coerced.retentionDays, 0)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).retentionDays, 0)
})

// --- the sweep ------------------------------------------------------------

/**
 * Write one trash entry whose `deletedAt` is `ageDays` ago, and return its trash id.
 *
 * The directory name is minted from the SAME instant (`<epochMillis>-<8 hex>`), the
 * way `moveToTrash` does it: the sweep refuses to age a row whose two witnesses
 * disagree (`src/retention.ts`), so a fixture with an id from a different day would
 * simply never expire.
 */
async function entry(input: {
  trashRoot: string
  sessionId: string
  ageDays: number
  now: number
  bytes?: number
}): Promise<string> {
  const at = input.now - input.ageDays * DAY_MS
  const trashId = `${at}-aaaaaaaa`
  const dir = join(input.trashRoot, trashId)
  await mkdir(join(dir, 'payload', '0'), { recursive: true })
  await writeFile(join(dir, 'payload', '0', 'session.jsonl'), 'x'.repeat(input.bytes ?? 32))
  await writeFile(join(dir, 'metadata.json'), JSON.stringify({
    version: 1,
    state: 'ready',
    trashId,
    deletedAt: new Date(at).toISOString(),
    members: [{
      sessionId: input.sessionId,
      title: '',
      originalPath: join(input.trashRoot, '..', 'sessions', input.sessionId),
      payload: '0',
      sizeBytes: input.bytes ?? 32,
    }],
  }))
  return trashId
}

test('the cutoff is the tier ago, and "for ever" has no cutoff at all', () => {
  const now = Date.parse('2026-11-02T00:00:00.000Z')
  assert.equal(retentionCutoff(7, now), new Date(now - 7 * DAY_MS).toISOString())
  assert.equal(retentionCutoff(0, now), undefined, '0 is "keep for ever", not "0 days old"')
})

test('a sweep removes what is older than the tier and keeps what is inside it', async () => {
  const f = await fixture({ ids: [], archived: [] })
  const now = Date.parse('2026-11-02T00:00:00.000Z')
  const old = await entry({ trashRoot: f.trashRoot, sessionId: 'session-old', ageDays: 8, now })
  const fresh = await entry({ trashRoot: f.trashRoot, sessionId: 'session-fresh', ageDays: 3, now })
  // The projection-cache shard of the session that expires.
  await writeFile(join(f.projCacheDir, 'session-old.json'), '{"ver":7}')

  const result = await sweepExpired({ trashRoot: f.trashRoot, projCacheDir: f.projCacheDir, retentionDays: 7, now: () => now })

  assert.deepEqual(result.purged.map((row) => row.trashId), [old])
  assert.deepEqual(result.purged[0].ids, ['session-old'])
  assert.ok(result.freedBytes > 0)
  assert.equal(existsSync(join(f.trashRoot, old)), false, 'the expired entry is gone')
  assert.equal(existsSync(join(f.trashRoot, fresh)), true, 'the fresh entry is untouched')
  assert.equal(existsSync(join(f.projCacheDir, 'session-old.json')), false, 'its cache shard went with it')
})

test('an entry whose two timestamps disagree is never expired', async () => {
  // `deletedAt` comes out of `metadata.json`; the metadata names things and never
  // decides. The directory name carries the same instant from the same clock, so an
  // edited or copied entry that claims "year 2000" must not talk the sweep into
  // deleting a session that was trashed a minute ago.
  const f = await fixture({ ids: [], archived: [] })
  const now = Date.parse('2026-11-02T00:00:00.000Z')
  const recent = await entry({ trashRoot: f.trashRoot, sessionId: 'session-recent', ageDays: 2, now })
  // The name still says "two days ago"; rewrite the STAMP to 2000 so the two disagree.
  const metadataPath = join(f.trashRoot, recent, 'metadata.json')
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>
  metadata.deletedAt = '2000-01-01T00:00:00.000Z'
  await writeFile(metadataPath, JSON.stringify(metadata))

  const result = await sweepExpired({ trashRoot: f.trashRoot, projCacheDir: f.projCacheDir, retentionDays: 7, now: () => now })

  assert.deepEqual(result.purged, [], 'an edited stamp expires nothing')
  assert.deepEqual(result.warnings, [{ id: recent, code: 'trash-time-mismatch' }])
  assert.equal(existsSync(join(f.trashRoot, recent, 'payload', '0', 'session.jsonl')), true, 'the payload is untouched')
})

test('an unfinished deletion is aged like any other row, and so is a sibling of one', async () => {
  // What a purge that died halfway leaves: `<trashId>.purging`, out of service and
  // still on disk. It shares its plain id with an entry of the same name, which is
  // exactly what the two-pass sweep exists for — a lookup against the first listing
  // answers the ENTRY and the leftover is never reached.
  const f = await fixture({ ids: [], archived: [] })
  const now = Date.parse('2026-11-02T00:00:00.000Z')
  const trashId = await entry({ trashRoot: f.trashRoot, sessionId: 'session-old', ageDays: 9, now })
  await mkdir(join(f.trashRoot, `${trashId}.purging`, 'payload', '0'), { recursive: true })
  await writeFile(join(f.trashRoot, `${trashId}.purging`, 'payload', '0', 'session.jsonl'), 'residue')

  const result = await sweepExpired({ trashRoot: f.trashRoot, projCacheDir: f.projCacheDir, retentionDays: 7, now: () => now })

  assert.equal(existsSync(join(f.trashRoot, trashId)), false, 'the expired entry is gone')
  assert.equal(existsSync(join(f.trashRoot, `${trashId}.purging`)), false, 'and so is the unfinished deletion beside it')
  // The sibling is cleared as the blocker it is, inside the entry's own purge, so
  // one removal covers both rows; what matters is that neither directory survives.
  assert.equal(result.purged.length >= 1, true)
  assert.ok(result.freedBytes > 0)
})

test('a sweep at tier 0 removes nothing at all', async () => {
  const f = await fixture({ ids: [], archived: [] })
  const now = Date.parse('2026-11-02T00:00:00.000Z')
  const ancient = await entry({ trashRoot: f.trashRoot, sessionId: 'session-ancient', ageDays: 4000, now })

  const result = await sweepExpired({ trashRoot: f.trashRoot, projCacheDir: f.projCacheDir, retentionDays: 0, now: () => now })

  assert.deepEqual(result, { retentionDays: 0, purged: [], freedBytes: 0, skipped: [], warnings: [] })
  assert.equal(existsSync(join(f.trashRoot, ancient)), true)
})

test('the sweep is idempotent: a second run finds nothing', async () => {
  const now = Date.parse('2026-11-02T00:00:00.000Z')
  const f = await fixture({ ids: [], archived: [], now: () => now })
  await writeSettings(f.settingsPath, { version: 1, retentionDays: 7, sweepOnStartup: true })
  await entry({ trashRoot: f.trashRoot, sessionId: 'session-old', ageDays: 8, now })

  const first = await runRetentionSweep(f.options)
  const second = await runRetentionSweep(f.options)

  assert.equal(first.purged.length, 1)
  assert.equal(second.purged.length, 0)
  assert.ok(first.freedBytes > 0)
  assert.equal(second.freedBytes, 0)
})

test('a sweep with an untrusted settings file expires nothing', async () => {
  // F1: an unknown-version file reads as the SAFE policy (0 days, no sweep), so a
  // 400-day-old entry survives even when a sweep is run by hand.
  const now = Date.parse('2026-11-02T00:00:00.000Z')
  const f = await fixture({ ids: [], archived: [], now: () => now })
  await mkdir(join(f.settingsPath, '..'), { recursive: true })
  await writeFile(f.settingsPath, '{"version":2,"retentionDays":0,"sweepOnStartup":false}\n')
  const ancient = await entry({ trashRoot: f.trashRoot, sessionId: 'session-ancient', ageDays: 400, now })

  const result = await runRetentionSweep(f.options)

  assert.equal(result.retentionDays, 0, 'the unknown file reads as "keep for ever", not as 30 days')
  assert.deepEqual(result.purged, [])
  assert.equal(existsSync(join(f.trashRoot, ancient, 'payload', '0', 'session.jsonl')), true)
  assert.ok(f.warnings.some((message) => message.includes('cannot use')), 'and the host log says the file was ignored')
})

// --- the routes -----------------------------------------------------------

test('GET /settings answers the defaults before anything is written', async () => {
  const f = await fixture({ ids: [], archived: [] })
  const reply = await call(f.routes.get(`${ROUTE_PREFIX}/settings`), request('GET'))
  assert.equal(reply.status, 200)
  assert.deepEqual(reply.body, { ok: true, value: { settings: DEFAULT_SETTINGS, malformed: false } })
})

test('GET /settings reports an untrusted file as the safe policy', async () => {
  const f = await fixture({ ids: [], archived: [] })
  await mkdir(join(f.settingsPath, '..'), { recursive: true })
  await writeFile(f.settingsPath, '{"version":1,"retentionDays":"0","sweepOnStartup":"false"}\n')

  const reply = await call(f.routes.get(`${ROUTE_PREFIX}/settings`), request('GET'))
  const value = reply.body.value as { settings: unknown; malformed: boolean }

  assert.equal(reply.status, 200)
  assert.deepEqual(value.settings, SAFE_SETTINGS, 'the page shows what will actually happen: nothing expires')
  assert.equal(value.malformed, true, 'and says the file could not be used')
})

test('POST /settings stores the tier, refuses a value outside the set, and keeps the switch', async () => {
  const f = await fixture({ ids: [], archived: [] })
  const route = f.routes.get(`${ROUTE_PREFIX}/settings`)

  const saved = await call(route, request('POST', { retentionDays: 7, sweepOnStartup: false }))
  assert.equal(saved.status, 200)
  assert.deepEqual((saved.body.value as { settings: unknown }).settings, { version: 1, retentionDays: 7, sweepOnStartup: false })

  // Absent switch means "leave it": changing only the tier must not flip it.
  await call(route, request('POST', { retentionDays: 0 }))
  assert.deepEqual((await readSettings(f.settingsPath)).settings, { version: 1, retentionDays: 0, sweepOnStartup: false })

  // A tier outside the closed set is refused before the file is touched.
  const before = await stat(f.settingsPath)
  const refused = await call(route, request('POST', { retentionDays: 3 }))
  assert.equal(refused.status, 400)
  assert.equal((refused.body.error as { host: { code: string } }).host.code, 'route.badRetentionDays')
  assert.equal((await stat(f.settingsPath)).mtimeMs, before.mtimeMs, 'a refused write touches nothing')

  const badSwitch = await call(route, request('POST', { retentionDays: 7, sweepOnStartup: 'yes' }))
  assert.equal(badSwitch.status, 400)
  assert.equal((badSwitch.body.error as { host: { code: string } }).host.code, 'route.badSweepOnStartup')
})

test('POST /sweep applies the stored tier and reports what it removed', async () => {
  const now = Date.parse('2026-11-02T00:00:00.000Z')
  const f = await fixture({ ids: [], archived: [], now: () => now })
  await writeSettings(f.settingsPath, { version: 1, retentionDays: 7, sweepOnStartup: true })
  const old = await entry({ trashRoot: f.trashRoot, sessionId: 'session-old', ageDays: 9, now })
  const fresh = await entry({ trashRoot: f.trashRoot, sessionId: 'session-fresh', ageDays: 1, now })

  const reply = await call(f.routes.get(`${ROUTE_PREFIX}/sweep`), request('POST', {}))
  const value = reply.body.value as { retentionDays: number; purged: Array<{ trashId: string }>; freedBytes: number }

  assert.equal(reply.status, 200)
  assert.equal(value.retentionDays, 7)
  assert.deepEqual(value.purged.map((row) => row.trashId), [old])
  assert.ok(value.freedBytes > 0)
  assert.equal(existsSync(join(f.trashRoot, fresh)), true)
})

test('GET /trash reports the span of deletion instants the usage numbers need', async () => {
  const f = await fixture({ ids: [], archived: [] })
  const now = Date.parse('2026-11-02T00:00:00.000Z')
  await entry({ trashRoot: f.trashRoot, sessionId: 'session-old', ageDays: 20, now })
  await entry({ trashRoot: f.trashRoot, sessionId: 'session-new', ageDays: 2, now })

  const reply = await call(f.routes.get(`${ROUTE_PREFIX}/trash`), request('GET'))
  const value = reply.body.value as { oldestDeletedAt?: string; newestDeletedAt?: string; sessionCount: number }

  assert.equal(value.sessionCount, 2)
  assert.equal(value.oldestDeletedAt, new Date(now - 20 * DAY_MS).toISOString())
  assert.equal(value.newestDeletedAt, new Date(now - 2 * DAY_MS).toISOString())
})

test('the startup sweep and the sweep button run one function', () => {
  // The startup branch needs a real cordis Context, so the sharing is asserted where
  // it is written: `apply()` calls `runRetentionSweep`, and the `/sweep` route is
  // the same call (asserted above by its behavior). Two implementations would let an
  // entry survive one path and vanish through the other.
  const srcDir = fileURLToPath(new URL('../src/', import.meta.url))
  const index = readFileSync(join(srcDir, 'index.ts'), 'utf8')
  assert.match(index, /runRetentionSweep\(options\)/, 'the host applies the same sweep the route runs')
  assert.match(index, /readSettings\(settingsPath\)[\s\S]{0,200}sweepOnStartup/, 'and gated on the stored switch')
})
