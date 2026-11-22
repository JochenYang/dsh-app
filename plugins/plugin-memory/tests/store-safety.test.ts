/**
 * The storage track's safety cases — one failing path per plan item of
 * `docs/plans/memory-ability-upgrade.md`, as far as each lands in
 * `memory-store.ts` / `card-file.ts` / `light-sweep.ts`: V3, K7, C1, P1, P2,
 * P4, P5, P6, P8, P9 and R2.
 *
 * Each case pins a failing path of the store as it was BEFORE its item: the
 * archive that let a deletion through, the index line that cost 21 characters
 * a card, the `>=`/`<=` pair the sweep merged into one card, the camelCase
 * token name the credential filter never saw, the restore that trusted
 * whatever sat in `archive/`. The suite was run red on that store before any
 * item was implemented. C1 is the exception in kind: its cap had already
 * moved with the constant, so its case is the guard that the move is complete
 * and that the summary cap did not move with it.
 *
 * @module @dsh-app/plugin-memory/tests/store-safety
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { scratchRoot, scratchStore } from './scratch.ts'
import { DEFAULT_ALIAS_GROUPS } from '../src/recall-aliases.ts'
import { UNKNOWN_DATE, cardFingerprint, renderCard } from '../src/card-file.ts'
import { renderCardBlock } from '../src/prompt.ts'
import { lightSweep } from '../src/light-sweep.ts'
import {
  INDEX_HEADER,
  MAX_SUMMARY_CHARS,
  MAX_TOPIC_BODY_CHARS,
  SIM_RELATED,
  type MemoryStore,
  admittedSessionId,
  cardIsWithheld,
  containsCredential,
  contentSimilarity,
  credentialCode,
  indexLineKey,
  isValidTopic,
  listProjects,
  normalizeForMatch,
  parseCard,
  projectSlug,
  removeProject,
  safeFsErrorText,
  slugifyTopic,
  todayStamp,
  validateCardInput,
  type MemoryCategory,
} from '../src/memory-store.ts'

/** Save one well-formed card in one call (the summary defaults to a hook). */
const save = async (store: MemoryStore, name: string, body: string, category: MemoryCategory = 'fact', summary = ''): Promise<void> => {
  await store.upsert({ name, category, summary: summary === '' ? `${name} hook` : summary, body })
}

/** Pin a card's `updated` stamp to a fixed date. The writer always stamps
 *  today, but the index order and the search ranking read the date, so a
 *  ranking test has to control it. */
const stamp = (store: MemoryStore, name: string, updated: string): void => {
  const card = store.get(name)
  assert.ok(card !== undefined, `${name} exists before it is stamped`)
  writeFileSync(join(store.storePath, `${name}.md`), renderCard({ ...card, updated }), 'utf8')
}

const NOOP_LOG = { info: (): void => { /* silent */ }, warn: (): void => { /* silent */ } }

/** Run `fn` with `console.warn` captured instead of printed, and return what
 *  it printed (the store has no injected logger; the warn line IS its log). */
async function captureWarn<T>(fn: () => Promise<T>): Promise<{ result: T, lines: string[] }> {
  const lines: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(argument => String(argument)).join(' '))
  }
  try {
    return { result: await fn(), lines }
  } finally {
    console.warn = original
  }
}

// --- V3: the index line no longer carries the date ---------------------------

test('V3 index line: no (updated …) tail; the key reader reads old and new lines; drift detection still works', async () => {
  const store = scratchStore('dshm-v3-line-')
  await save(store, 'windows-acl', 'hook')
  await save(store, 'dsh-plugin-install', 'body2', 'lesson')
  const lines = store.indexText().split('\n').filter(line => line.startsWith('- '))
  assert.equal(lines.length, 2)
  for (const line of lines) {
    assert.doesNotMatch(line, /\(updated \d{4}-\d{2}-\d{2}\)/u, 'the date no longer rides every line')
    assert.match(line, /^- \[[a-z]+\] [a-z0-9][a-z0-9-]* — .+$/u, 'the line is `- [category] key — summary`')
  }
  assert.deepEqual(lines.map(line => indexLineKey(line)).sort(), ['dsh-plugin-install', 'windows-acl'])
  // The date itself is not lost: it stays in the card file (and in the body heading).
  assert.match(readFileSync(join(store.storePath, 'windows-acl.md'), 'utf8'), /^updated: \d{4}-\d{2}-\d{2}$/mu)

  // A line written by the previous format — on disk in every store until its
  // next write — still reads back.
  assert.equal(indexLineKey('- [lesson] windows-acl — hook (updated 2026-01-01)'), 'windows-acl')

  // Such an index is IN STEP, not drift: reconciliation compares keys, never tails.
  writeFileSync(
    join(store.dir, 'index.md'),
    `${INDEX_HEADER}\n\n- [fact] windows-acl — windows-acl hook (updated 2026-01-01)\n- [lesson] dsh-plugin-install — dsh-plugin-install hook (updated 2026-01-01)\n\n`,
    'utf8',
  )
  assert.equal(store.indexDrift(), undefined, 'an old-format index that names the right cards is not drift')

  // Drift detection itself is untouched: a card removed behind the index's back is a ghost.
  unlinkSync(join(store.storePath, 'windows-acl.md'))
  const drift = store.indexDrift()
  assert.ok(drift !== undefined)
  assert.deepEqual(drift.ghostKeys, ['windows-acl'])

  await store.reindex()
  assert.doesNotMatch(store.indexText(), /\(updated /u, 'a rebuild writes the new format')
  const rebuilt = store.indexText().split('\n').map(line => indexLineKey(line)).filter((key): key is string => key !== undefined)
  assert.deepEqual(rebuilt, ['dsh-plugin-install'])
})

// --- K7: the similarity floor follows SIM_RELATED ----------------------------

test('K7 findSimilar: the default floor is SIM_RELATED (0.2), so a pair at 0.25 is reported', async () => {
  assert.equal(SIM_RELATED, 0.2)
  const store = scratchStore('dshm-k7-floor-')
  const stored = '模型偏好中文回复，不要卖萌，直接给结论'
  const proposal = '回复偏好中文，不要语气词，结论先行'
  await save(store, 'reply-style', stored, 'preference', '中文回复')
  const card = store.get('reply-style')
  assert.ok(card !== undefined)
  // The fixture has to sit in the band the old floor (0.3) dropped, or the
  // test proves nothing about the change. Measured as the gate measures it:
  // the proposal against the card's summary AND body.
  const score = contentSimilarity(proposal, `${card.summary} ${card.body}`)
  assert.ok(score >= 0.2 && score < 0.3, `the fixture must score in [0.2, 0.3), got ${String(score)}`)
  assert.deepEqual(store.findSimilar(proposal).map(hit => hit.name), ['reply-style'], 'the default call reports it')
  assert.deepEqual(store.findSimilar(proposal, 0.3), [], 'an explicit 0.3 still drops it — the DEFAULT is what moved')
})

// --- C1: the body cap is the constant, the summary cap did not move -----------

test('C1 body cap: 450 characters pass, 501 are refused, and the summary cap stays at 40', async () => {
  assert.equal(MAX_TOPIC_BODY_CHARS, 500)
  assert.equal(MAX_SUMMARY_CHARS, 40)
  const base = { name: 'cap-card', category: 'lesson' as const, summary: 'hook', body: 'body' }
  assert.equal(validateCardInput({ ...base, body: 'x'.repeat(450) }), undefined)
  assert.equal(validateCardInput({ ...base, body: 'x'.repeat(MAX_TOPIC_BODY_CHARS) }), undefined, 'the cap itself is allowed')
  assert.match(validateCardInput({ ...base, body: 'x'.repeat(501) }) ?? '', /content too long \(501\/500 chars\)/u)
  assert.equal(validateCardInput({ ...base, summary: 's'.repeat(MAX_SUMMARY_CHARS) }), undefined)
  assert.match(validateCardInput({ ...base, summary: 's'.repeat(MAX_SUMMARY_CHARS + 1) }) ?? '', /summary too long/u)
  const store = scratchStore('dshm-c1-cap-')
  const { op, card } = await store.upsert({ ...base, body: 'x'.repeat(450) })
  assert.equal(op, 'created')
  assert.equal(card.body.length, 450)
  assert.equal(store.get('cap-card')?.body.length, 450, 'a 450-character body lands whole')
  await assert.rejects(store.upsert({ ...base, name: 'over-cap', body: 'x'.repeat(501) }), /content too long/u)
  assert.equal(store.get('over-cap'), undefined)
})

// --- P1: no archive copy, no deletion -----------------------------------------

test('P1 remove: an archive copy that cannot be written refuses the deletion, is recorded, and the card stays', async () => {
  const root = scratchRoot('dshm-p1-remove-')
  const cwd = 'D:\\proj\\archive-refused'
  const store = root.projectFor(cwd)
  await save(store, 'blocked-card', '内容')
  // A FILE where the archive directory must go: every archive write fails.
  writeFileSync(join(store.dir, 'archive'), 'not a directory')

  const { lines } = await captureWarn(async () => {
    await assert.rejects(store.remove('blocked-card', 'forget'), /cannot archive the card "blocked-card"/u)
  })
  assert.equal(lines.length, 1, 'the refusal is logged once')
  assert.match(lines[0] ?? '', /could not archive "blocked-card"/u)
  assert.equal(store.get('blocked-card')?.body, '内容', 'the card was not removed')

  const failures = root.archiveFailures()
  assert.equal(failures.length, 1)
  assert.equal(failures[0]!.topic, 'blocked-card')
  assert.equal(failures[0]!.scope, projectSlug(cwd), 'the row names the store whose deletion was refused')
  assert.ok(failures[0]!.error !== '', 'the row carries what the write failed with')
  assert.deepEqual(root.ledgerEntries(), [], 'nothing was deleted, so nothing claims a deletion')
})

test('P1 forget: the same refusal — a sweep that cannot archive its first match deletes nothing', async () => {
  const root = scratchRoot('dshm-p1-forget-')
  const store = root.projectFor('D:\\proj\\archive-sweep')
  await save(store, 'pnpm-a', '用 pnpm 跑 typecheck')
  await save(store, 'pnpm-b', '用 pnpm 跑 build')
  const indexBefore = store.indexText()
  writeFileSync(join(store.dir, 'archive'), 'not a directory')

  await captureWarn(async () => {
    await assert.rejects(store.forget('pnpm'), /cannot archive the card "pnpm-a"/u)
  })
  assert.deepEqual(store.list().map(card => card.name), ['pnpm-a', 'pnpm-b'], 'not one card of the sweep left the store')
  assert.equal(store.indexText(), indexBefore, 'the index still describes the cards')
  assert.deepEqual(root.ledgerEntries(), [], 'no forget row for a forget that did not happen')
  assert.equal(root.archiveFailures().length, 1, 'one row names the copy the sweep stopped at')
})

test('P1 a later landing archive clears the persisted refusal', async () => {
  const root = scratchRoot('dshm-p1-recover-')
  const cwd = 'D:\\proj\\archive-recover'
  const store = root.projectFor(cwd)
  await save(store, 'blocked', '内容')
  writeFileSync(join(store.dir, 'archive'), 'not a directory')
  await captureWarn(async () => {
    await assert.rejects(store.remove('blocked', 'forget'), /cannot archive/u)
  })
  assert.deepEqual(root.archiveFailures().map(row => row.topic), ['blocked'])

  unlinkSync(join(store.dir, 'archive'))
  assert.equal(await store.remove('blocked', 'forget'), true, 'the deletion goes through once the archive is writable')
  assert.deepEqual(root.archiveFailures(), [], 'no stale warning about an undo the user has again')
  assert.deepEqual(store.archivedCards().map(row => row.topic), ['blocked'])
})

test('P1 a landing archive clears the failures of THAT card only — another card\'s refusal stays on the list', async () => {
  const root = scratchRoot('dshm-p1-failure-list-')
  const cwd = 'D:\\proj\\failure-list'
  const store = root.projectFor(cwd)
  await save(store, 'stuck', '内容一')
  await save(store, 'fine', '内容二')
  // `stuck` was refused earlier (a real refusal is what the test above pins).
  root.recordArchiveFailure(projectSlug(cwd), 'stuck', 'EACCES: permission denied, open archive/stuck.md')
  assert.deepEqual(root.archiveFailures().map(row => row.topic), ['stuck'])

  // Another card of the same store deletes fine. That used to clear the whole
  // store's list — and the banner about `stuck` with it, while `stuck` stayed.
  assert.equal(await store.remove('fine', 'forget'), true)
  assert.deepEqual(root.archiveFailures().map(row => row.topic), ['stuck'], 'a refusal that is still true stays')

  assert.equal(await store.remove('stuck', 'forget'), true)
  assert.deepEqual(root.archiveFailures(), [], 'and goes once that card\'s own copy lands')
})

test('P1 a persisted failure names the errno and a store-relative path, never the user\'s directories', async () => {
  const root = scratchRoot('dshm-p1-safe-error-')
  const store = root.projectFor('D:\\proj\\safe-error')
  await save(store, 'blocked', '内容')
  writeFileSync(join(store.dir, 'archive'), 'not a directory')
  await captureWarn(async () => {
    await assert.rejects(store.remove('blocked', 'forget'), /cannot archive/u)
  })
  const failure = root.archiveFailures()[0]
  assert.ok(failure !== undefined)
  // Which errno a platform answers for "a file where a directory must go"
  // differs (ENOTDIR on POSIX, ENOENT on Windows); the shape is what holds.
  assert.match(failure.error, /^[A-Z]+ mkdir /u, 'the code and the syscall are what a reader acts on')
  assert.ok(failure.error.endsWith(`/archive/${todayStamp()}`), `the path is the store's own: ${failure.error}`)
  assert.equal(failure.error.includes(root.dir), false, 'the store root is not in the text')
  assert.equal(/[A-Za-z]:[\\/]/u.test(failure.error), false, 'no drive path at all')

  // An error that is not an fs one keeps its message, with any absolute path cut.
  const odd = safeFsErrorText(new Error(`cannot read C:\\Users\\someone\\storages\\x.md or /home/someone/y/z.md`), root.dir)
  assert.equal(odd, 'cannot read <path> or <path>')
  assert.equal(safeFsErrorText(new Error('plain diagnostic'), root.dir), 'plain diagnostic')
})

test('P1 a refused deletion prunes nothing; the day cleanup only ever drops an EMPTY day', async () => {
  const store = scratchStore('dshm-p1-prune-')
  const archive = join(store.dir, 'archive')
  const oldCopy = { name: 'old-copy', category: 'fact' as const, summary: 'hook', created: '2001-01-01', updated: '2001-01-01', body: '旧副本', malformed: false }
  mkdirSync(join(archive, '2001-01-01'), { recursive: true })
  mkdirSync(join(archive, '2001-01-02'), { recursive: true })
  writeFileSync(join(archive, '2001-01-01', 'old-copy.md'), renderCard(oldCopy), 'utf8')
  await save(store, 'live', '内容')
  // Today's day path is a FILE, so the copy for `live` cannot be written.
  const blocker = join(archive, todayStamp())
  writeFileSync(blocker, 'not a directory')

  await captureWarn(async () => {
    await assert.rejects(store.remove('live', 'forget'), /cannot archive/u)
  })
  assert.equal(store.get('live')?.body, '内容', 'the card stays')
  assert.equal(existsSync(join(archive, '2001-01-01', 'old-copy.md')), true, 'an older copy survives the refused deletion')
  assert.equal(existsSync(join(archive, '2001-01-02')), true, 'nothing was pruned on the way to a refusal')

  unlinkSync(blocker)
  assert.equal(await store.remove('live', 'forget'), true)
  assert.equal(existsSync(join(archive, '2001-01-01', 'old-copy.md')), true, 'a day that still holds a copy is never swept')
  assert.equal(existsSync(join(archive, '2001-01-02')), false, 'the EMPTY day directory is')
})

test('P1 × light sweep: a duplicate whose archive copy cannot be written is kept and logged; the rest of the sweep still runs', async () => {
  const root = scratchRoot('dshm-p1-sweep-')
  const store = root.global
  await save(store, 'dup-keep', '完全一样的内容')
  await save(store, 'dup-drop', '完全一样的内容')
  const archive = join(store.dir, 'archive')
  mkdirSync(archive, { recursive: true })
  writeFileSync(join(archive, todayStamp()), 'not a directory')

  const warnings: string[] = []
  const log = { info: (): void => { /* silent */ }, warn: (message: string): void => { warnings.push(message) } }
  const out = await captureWarn(() => lightSweep(root, 'global', store, log))
  assert.equal(out.result.merged, 0)
  assert.equal(store.list().length, 2, 'both duplicates stay — an un-undoable merge is not performed')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? '', /could not merge duplicate/u)
  // Steps 2–4 of the sweep still ran: the index agrees with the two cards.
  assert.equal(store.indexDrift(), undefined)
  assert.equal(root.archiveFailures().length, 1)
  assert.deepEqual(root.ledgerEntries(), [], 'no merge row for a merge that did not happen')
})

// --- P2: a restored copy must be a card — and nothing more ---------------------

test('P2 restore: a copy that is a card comes back whatever its text — over the cap or credential-looking — while a non-card does not', async () => {
  const store = scratchStore('dshm-p2-restore-')
  const day = '2001-01-01'
  const dayDir = join(store.dir, 'archive', day)
  mkdirSync(dayDir, { recursive: true })
  const copy = (name: string, body: string): string => {
    const path = join(dayDir, `${name}.md`)
    writeFileSync(path, renderCard({ name, category: 'fact', summary: `${name} hook`, created: day, updated: day, body, malformed: false }), 'utf8')
    return path
  }
  const leaked = copy('leaked', 'deploy with sk-abcdefghijklmnopqrstuvwx on the box')
  copy('oversized', 'x'.repeat(5000))
  copy('long-but-legal', 'y'.repeat(450))
  // Not a card: no frontmatter at all.
  const notACard = join(dayDir, 'not-a-card.md')
  writeFileSync(notACard, 'just some text someone put here', 'utf8')

  // Every deletion archives first, so "deleted" promises an undo. A restore
  // that re-ran the write-side caps and the credential fence broke that
  // promise for exactly the cards a hand edit produces — the copy sat in
  // `archive/`, offered no way back, and was pruned (a security review
  // caught it). The read side withholds a credential-shaped card on every
  // path, so restoring it widens nothing the model sees.
  assert.equal(await store.restoreArchived(day, 'leaked', 'leaked'), 'restored')
  assert.equal(store.get('leaked')?.body, 'deploy with sk-abcdefghijklmnopqrstuvwx on the box', 'the user gets their own file back')
  assert.equal(cardIsWithheld(store.get('leaked')!), true, 'and no session is shown it')
  assert.equal(await store.restoreArchived(day, 'oversized', 'oversized'), 'restored')
  assert.equal(store.get('oversized')?.body.length, 5000)

  // What is refused is a copy that is not a card at all.
  assert.equal(await store.restoreArchived(day, 'not-a-card', 'not-a-card'), 'invalid')
  assert.ok(existsSync(notACard), 'a refused copy stays in the archive for a human to look at')
  // …and a copy asked for under another key.
  assert.equal(await store.restoreArchived(day, 'long-but-legal', 'other-key'), 'invalid')

  assert.equal(await store.restoreArchived(day, 'long-but-legal', 'long-but-legal'), 'restored')
  assert.equal(store.get('long-but-legal')?.body.length, 450)
})

test('P2 × P1: a hand-edited card longer than the cap can be deleted AND brought back — the undo the delete promises', async () => {
  const store = scratchStore('dshm-p2-undo-')
  mkdirSync(join(store.dir, 'topics'), { recursive: true })
  writeFileSync(join(store.dir, 'topics', 'hand-note.md'), renderCard({
    name: 'hand-note', category: 'fact', summary: 'hook', created: '2026-11-01', updated: '2026-11-01', body: 'z'.repeat(5000), malformed: false,
  }), 'utf8')
  assert.equal(await store.remove('hand-note', 'forget'), true)
  assert.equal(store.get('hand-note'), undefined)
  const [archived] = store.archivedCards()
  assert.ok(archived !== undefined)
  assert.equal(await store.restoreArchived(archived.day, archived.file, archived.topic), 'restored')
  assert.equal(store.get('hand-note')?.body.length, 5000)
})

// --- P4: a config the plugin cannot read is never written over ----------------

test('P4 config: an unparseable config.json is flagged, reads fall back to the defaults, and no write replaces it', async () => {
  const root = scratchRoot('dshm-p4-config-')
  const configPath = join(root.dir, 'config.json')
  const broken = '{ "enabled": false, "pinned": [\n'
  writeFileSync(configPath, broken, 'utf8')

  assert.equal(root.global.configUnreadable, true)
  assert.equal(root.global.isEnabled(), true, 'reads keep answering the documented defaults')
  const { lines } = await captureWarn(async () => {
    assert.throws(() => root.global.setEnabled(false), (error: unknown) => error instanceof Error
      && /refusing to write .*config\.json/u.test(error.message)
      && error.cause instanceof SyntaxError, 'the refusal names the file and keeps the parse error as its cause')
  })
  assert.equal(lines.length, 1, 'the refusal is logged')
  assert.equal(readFileSync(configPath, 'utf8'), broken, 'the bytes are untouched')
})

test('P4 config: a store whose config.json is not an object cannot take a pin; a repaired file re-enables writes without a restart', async () => {
  const store = scratchStore('dshm-p4-pin-')
  await save(store, 'one', '内容')
  const configPath = join(store.dir, 'config.json')
  // Valid JSON, but not a config: pins and toggles cannot be read out of a number.
  writeFileSync(configPath, '42\n', 'utf8')
  assert.equal(store.configUnreadable, true)
  assert.deepEqual([...store.pinnedSet()], [], 'reads answer the defaults')
  await captureWarn(async () => {
    await assert.rejects(store.addPin('one'), /refusing to write/u)
  })
  assert.equal(readFileSync(configPath, 'utf8'), '42\n', 'a pin never replaced the file with defaults')

  // Repaired by hand: the next read sees it and writes land again — no restart.
  writeFileSync(configPath, '{ "pinned": [] }\n', 'utf8')
  assert.equal(store.configUnreadable, false)
  assert.equal(await store.addPin('one'), true)
  assert.deepEqual([...store.pinnedSet()], ['one'])

  // A MISSING file is the first-run state, not a broken one.
  assert.equal(scratchStore('dshm-p4-missing-').configUnreadable, false)
})

// --- P5: the summary is one line; a cut topic key keeps its identity ----------

test('P5 summary: a line break is refused — the frontmatter would keep the first line and silently drop the rest', async () => {
  const base = { name: 'ok-key', category: 'lesson' as const, body: 'body' }
  assert.match(validateCardInput({ ...base, summary: 'line one\nline two' }) ?? '', /single line/u)
  assert.match(validateCardInput({ ...base, summary: 'line one\rline two' }) ?? '', /single line/u)
  assert.equal(validateCardInput({ ...base, summary: 'one line' }), undefined)
  const store = scratchStore('dshm-p5-summary-')
  await assert.rejects(store.upsert({ ...base, summary: 'two\nlines' }), /single line/u)
  assert.equal(store.get('ok-key'), undefined, 'nothing was written')
})

test('P5 slugifyTopic: long topics that differ only past the cut get different, valid keys', () => {
  // 48 shared characters (the whole key width) and four that differ: under a
  // plain cut at 48 both proposals became the same key, i.e. the same card.
  const head = 'dsh-app-release-checklist-for-kernel-line-moves-'
  const a = `${head}aaaa`
  const b = `${head}bbbb`
  assert.equal(a.length, 52)
  assert.equal(a.slice(0, 48), b.slice(0, 48), 'control: the 48 characters a plain cut kept are identical')
  const keyA = slugifyTopic(a)
  const keyB = slugifyTopic(b)
  assert.notEqual(keyA, keyB, 'the two proposals no longer collide on one card')
  for (const [input, key] of [[a, keyA], [b, keyB]] as const) {
    assert.equal(isValidTopic(key), true, `${key} is still a valid topic key`)
    assert.ok(key.length <= 48)
    assert.match(key, /-[0-9a-f]{4}$/u)
    assert.equal(key.slice(-4), createHash('sha256').update(input).digest('hex').slice(0, 4), 'the suffix is the first 4 hex of sha256(original input)')
    assert.equal(slugifyTopic(input), key, 'deterministic')
  }
  // Short proposals are untouched: no suffix appears where nothing was cut.
  assert.equal(slugifyTopic('Pnpm 11 AllowScripts'), 'pnpm-11-allowscripts')
  assert.equal(slugifyTopic('a'.repeat(48)), 'a'.repeat(48), 'exactly 48 characters is not a cut')
  assert.equal(slugifyTopic('a'.repeat(49)).length, 48)
  // A cut that lands on a dash does not leave the key ending in `-` before the suffix.
  assert.equal(slugifyTopic(`${'a'.repeat(42)}-${'c'.repeat(10)}`).includes('--'), false)
})

// --- P6: exact duplicates are the ORIGINAL text -------------------------------

test('P6 light sweep: exact duplicates compare the ORIGINAL text — a >= vs <= pair survives, byte-identical cards merge', async () => {
  const root = scratchRoot('dshm-p6-sweep-')
  const store = root.global
  await save(store, 'ge-rule', 'minimum >= 1')
  await save(store, 'le-rule', 'minimum <= 1')
  await save(store, 'dup-a', '完全相同的内容')
  await save(store, 'dup-b', '完全相同的内容')
  // The old key normalized both operators away: the two rules looked like one card.
  assert.equal(normalizeForMatch('minimum >= 1'), normalizeForMatch('minimum <= 1'))

  const out = await lightSweep(root, 'global', store, NOOP_LOG)
  assert.equal(out.merged, 1, 'only the byte-identical pair merged')
  const names = store.list().map(card => card.name)
  assert.ok(names.includes('ge-rule') && names.includes('le-rule'), 'the two different rules both survive')
  assert.equal(names.filter(name => name === 'dup-a' || name === 'dup-b').length, 1, 'the exact pair is one card')
  const dropped = ['dup-a', 'dup-b'].find(name => !names.includes(name))
  const kept = ['dup-a', 'dup-b'].find(name => names.includes(name))
  assert.deepEqual(root.ledgerEntries().map(entry => ({ pass: entry.pass, op: entry.op, keys: entry.keys, target: entry.target })),
    [{ pass: 'light-sweep', op: 'merge', keys: [dropped], target: kept }])
})

// --- P8: provenance is written once and never rewrites a card -----------------

test('P8 source: written once at creation, kept by later updates, and outside equality and the fingerprint', async () => {
  const store = scratchStore('dshm-p8-source-')
  const created = await store.upsert({ name: 'sourced', category: 'fact', summary: 'hook', body: 'body', source: '49ce2455' })
  assert.equal(created.op, 'created')
  assert.equal(created.card.source, '49ce2455')
  const text = readFileSync(join(store.storePath, 'sourced.md'), 'utf8')
  assert.match(text, /^source: 49ce2455$/mu)
  assert.equal(store.get('sourced')?.source, '49ce2455', 'the file round-trips')

  // An update that omits the source keeps it; one that passes another value is
  // ignored — the update path never rewrites where a fact came from.
  const updated = await store.upsert({ name: 'sourced', category: 'fact', body: 'body two' })
  assert.equal(updated.op, 'updated')
  assert.equal(updated.card.source, '49ce2455')
  const reSourced = await store.upsert({ name: 'sourced', category: 'fact', body: 'body three', source: 'deadbeef' })
  assert.equal(reSourced.card.source, '49ce2455')

  // `unchanged` does not look at the source: same content plus another source is still a no-op.
  const noop = await store.upsert({ name: 'sourced', category: 'fact', body: 'body three', source: 'deadbeef' })
  assert.equal(noop.op, 'unchanged')

  // The fingerprint is the read-before-edit witness over CONTENT: provenance is
  // where a fact came from, not what it says.
  const card = store.get('sourced')
  assert.ok(card !== undefined)
  assert.equal(cardFingerprint({ ...card, source: 'aaaa1111' }), cardFingerprint({ ...card, source: 'zzzz9999' }))

  // A source of the wrong shape is refused at validation, not written as a line the reader would drop.
  assert.match(validateCardInput({ name: 'bad-source', category: 'fact', summary: 'hook', body: 'body', source: 'not a session id' }) ?? '', /source/u)
  await assert.rejects(store.upsert({ name: 'bad-source', category: 'fact', summary: 'hook', body: 'body', source: 'line\nbreak' }), /source/u)
  assert.equal(store.get('bad-source'), undefined)

  // A file without a source round-trips exactly as before the field existed.
  const plain = { name: 'plain', category: 'lesson' as const, summary: 'hook', created: '2001-01-01', updated: '2001-01-01', body: 'body', malformed: false }
  assert.equal(renderCard(plain).includes('source:'), false, 'no `source:` line appears for an absent source')
  assert.deepEqual(parseCard('plain', renderCard(plain)), plain)
  // And a hand-edited `source:` line of the wrong shape reads as absent, never as malformed.
  const odd = parseCard('plain', renderCard(plain).replace('created:', 'source: not a session id\ncreated:'))
  assert.equal(odd.malformed, false)
  assert.equal(odd.source, undefined)
})

// --- P9: the credential filter's misses and its one false positive ------------

test('P9 credentials: quoted key names, sk_live_/sk_proj_, camelCase token names, glpat-, hf_ and Aliyun LTAI are refused with a code', () => {
  const refused: Array<[string, string]> = [
    ['"password": "x"', 'named-secret'],
    ["'token': 'y'", 'named-secret'],
    ['"密码": "x"', 'zh-password'],
    ['sk_live_abcdefghijklmnopqrstuvwx', 'token-prefix'],
    ['sk_proj_A1b2C3d4E5f6G7h8I9j0K1l2', 'token-prefix'],
    ['_authToken=xxx', 'named-secret'],
    ['authToken: abc', 'named-secret'],
    ['glpat-abcdefghijklmnopqrst', 'token-prefix'],
    ['hf_AbCdEf1234567890GhIjKlMnOpQrStUv', 'token-prefix'],
    ['LTAI5tKQZmM3mmxKmMAbMNc4e', 'token-prefix'],
    ['password=hunter2', 'named-secret'],
  ]
  for (const [sample, code] of refused) {
    assert.equal(credentialCode(sample), code, `must be refused as ${code}: ${sample}`)
  }
  const base = { name: 'ok-key', category: 'lesson' as const, summary: 'hook' }
  for (const [sample] of refused) {
    assert.match(validateCardInput({ ...base, body: `note ${sample}` }) ?? '', /credential/)
  }
})

test('P9 credentials: a file sha256 checksum and a bare UUID are not secrets — unless something else in the text is', () => {
  const checksum = 'sha256-LXEWQrcmsEQBYnyp+6wy9chTD7GQPMTbAiWHF5IaSIE='
  const match = /^sha256-(.+)$/u.exec(checksum)
  const run = match?.[1]
  assert.ok(run !== undefined)
  // Control: the bare run IS in the base64 rule's range, so only the
  // `sha256-` prefix exempts it (a rule that simply stopped matching this run
  // would also stop catching real keys of the same shape).
  assert.equal(credentialCode(run), 'base64-run')
  assert.equal(credentialCode(checksum), undefined, 'an integrity hash is not a key')
  assert.equal(credentialCode(`integrity ${checksum}`), undefined)
  assert.equal(credentialCode(checksum.replace('sha256-', 'SHA256-')), undefined, 'the integrity prefix is case-insensitive')
  assert.equal(containsCredential(checksum), false)

  const uuid = '7f3e2a1c-9b4d-4e6f-8a2b-1c3d5e7f9a0b'
  assert.equal(credentialCode(uuid), undefined)
  assert.equal(credentialCode(`request id ${uuid}`), undefined)

  // "Only when unaccompanied": a real secret beside either one is still refused.
  assert.equal(credentialCode(`${checksum} api_key: abc123def`), 'named-secret')
  assert.equal(credentialCode(`${uuid} postgres://app:S3cretPw@db.internal/prod`), 'url-password')
})

// --- R2: what the model reads first -------------------------------------------

test('R2 search: exact hits rank by the words actually present (the phrase first among equals), then newest; alias hits stay behind every exact hit', async () => {
  const store = scratchStore('dshm-r2-order-')
  await save(store, 'phrase-hit', 'app 工作区 的加载顺序')
  // `preference` sorts BEFORE `lesson` in `list()`: the old result order was
  // the category order, so this pair is what shows that it no longer is.
  await save(store, 'two-words-old', 'app 启动后重建 工作区', 'preference')
  await save(store, 'two-words-new', '工作区 启动时读取 app', 'lesson')
  // Both query words glued into longer words: the loose phrase rule matches
  // (`app工作区` is a substring of `myapp工作区`), but only `工作区` is a word here.
  await save(store, 'one-word', 'myapp 工作区 的配置')
  await save(store, 'alias-older', 'app 的 workspace 路径')
  await save(store, 'alias-newer', 'app 的 workspace 配置')
  stamp(store, 'phrase-hit', '2001-09-01')
  stamp(store, 'two-words-old', '2001-09-03')
  stamp(store, 'two-words-new', '2001-09-05')
  stamp(store, 'one-word', '2001-09-09')
  stamp(store, 'alias-older', '2001-09-02')
  stamp(store, 'alias-newer', '2001-09-08')

  const names = store.search('app 工作区', DEFAULT_ALIAS_GROUPS).map(card => card.name)
  assert.deepEqual(names, [
    'phrase-hit',      // both words, contiguous — first although it is the OLDEST card
    'two-words-new',   // both words, newest first
    'two-words-old',   // ... before an older card of a "higher" category
    'one-word',        // a phrase hit with one word — behind every two-word card although newest
    'alias-newer',     // alias hits come after every exact hit, newest first
    'alias-older',
  ])
})

test('R2 search: among alias hits, a card carrying more of the query\'s own words outranks a newer one carrying none; an exact hit still opens the list', async () => {
  const store = scratchStore('dshm-r2-alias-')
  await save(store, 'direct-partial', 'powershell 的 workspace 加载顺序')
  await save(store, 'all-aliased', 'pwsh workspace 的加载顺序')
  stamp(store, 'direct-partial', '2001-09-01')
  stamp(store, 'all-aliased', '2001-09-09')
  assert.deepEqual(
    store.search('powershell 工作区', DEFAULT_ALIAS_GROUPS).map(card => card.name),
    ['direct-partial', 'all-aliased'],
  )
  await save(store, 'exact-card', 'powershell 工作区 的加载顺序')
  stamp(store, 'exact-card', '2001-01-01')
  assert.deepEqual(
    store.search('powershell 工作区', DEFAULT_ALIAS_GROUPS).map(card => card.name),
    ['exact-card', 'direct-partial', 'all-aliased'],
  )
})

// --- what the second review of this change set found (2026-11-22) -------------------------------

test('P9 a boolean flag named after the thing it gates is not a secret; a real assignment still is', () => {
  // `hasToken = true` and `enableSecret: false` are code and config. The
  // camelCase rule used to match the NAME alone and refuse the whole card.
  assert.equal(credentialCode('当 hasToken = true 时走缓存'), undefined)
  assert.equal(credentialCode('enableSecret: false'), undefined)
  assert.equal(credentialCode('clientSecret=null'), undefined)
  assert.equal(credentialCode('authToken=abc123'), 'named-secret')
  assert.equal(credentialCode('authToken = "abc123"'), 'named-secret')
  // The bare name keeps its rule whatever follows it.
  assert.equal(credentialCode('token: true'), 'named-secret')
})

test('P5 every kind of line break is refused in a summary', () => {
  for (const lineBreak of ['a\u2028b', 'a\u2029b', 'a\u0085b', 'a\nb', 'a\rb']) {
    assert.match(
      validateCardInput({ name: 'line-card', category: 'fact', summary: lineBreak, body: 'body' }) ?? '',
      /single line/u,
      JSON.stringify(lineBreak),
    )
  }
})

test('P5 a hand-edited date that is not a date reads as unknown, and a Unicode line break in a summary is folded', () => {
  const text = [
    '---', 'name: odd-date', 'category: fact', 'summary: a\u2028b',
    'created: 2026-11-04', 'updated: see branch x', '---', '', '正文', '',
  ].join('\n')
  const card = parseCard('odd-date', text)
  assert.equal(card.malformed, false)
  // It used to ride verbatim into the heading of every injected body, and a
  // fallback to today would have ranked it as the freshest card.
  assert.equal(card.updated, UNKNOWN_DATE)
  assert.equal(card.created, '2026-11-04')
  assert.equal(card.summary, 'a b')
  const block = renderCardBlock(card)
  assert.equal(block.includes('see branch'), false)
  assert.match(block, /\(0000-00-00\): /u)
})

test('P8 a move carries the creating session along', async () => {
  const root = scratchRoot('dshm-p8-move-source-')
  const source = root.projectFor('D:\\proj\\move-from')
  const target = root.projectFor('D:\\proj\\move-to')
  await source.upsert({ name: 'mover', category: 'fact', summary: 'hook', body: '内容', source: '49ce2455' })
  assert.equal(await source.moveCardTo(target, 'mover'), 'moved')
  assert.equal(target.get('mover')?.source, '49ce2455', 'the card is the same card, wherever it now lives')
})

test('P10 one level up: a store nobody can list neither blocks the mount migration nor the whole listing', async () => {
  const root = scratchRoot('dshm-p10-mount-')
  const healthyCwd = 'D:\\proj\\mount-healthy'
  const healthy = root.projectFor(healthyCwd)
  await save(healthy, 'live', '内容')
  const brokenCwd = 'D:\\proj\\mount-broken'
  const brokenSlug = projectSlug(brokenCwd)
  const brokenDir = join(root.dir, 'projects', brokenSlug)
  mkdirSync(brokenDir, { recursive: true })
  writeFileSync(join(brokenDir, 'project.json'), `${JSON.stringify({ cwd: brokenCwd })}\n`, 'utf8')
  writeFileSync(join(brokenDir, 'topics'), 'not a directory')

  // `migrateAll` runs during the plugin's mount, and used to reject on this
  // store: the strict walk threw inside it, before any per-store try/catch.
  const notes: string[] = []
  await root.migrateAll({ info: message => { notes.push(message) } })
  assert.ok(notes.some(line => line.includes(brokenSlug)), 'the skipped store is named in the log')
  assert.equal(healthy.get('live')?.body, '内容', 'the healthy store is untouched by the skip')

  await captureWarn(async () => {
    const isListingFailure = (error: unknown): boolean =>
      typeof (error as { code?: unknown }).code === 'string' && (error as { syscall?: unknown }).syscall === 'scandir'
    assert.throws(() => listProjects(root.dir), isListingFailure,
      'the strict walk still throws: a caller about to act must not run past a store it cannot see')
    const rows = listProjects(root.dir, { keepUnreadable: true })
    const broken = rows.find(row => row.slug === brokenSlug)
    assert.match(broken?.error ?? '', /^[A-Z]+ scandir /u)
    assert.ok(broken?.error.endsWith('/topics'), `the path is the store's own: ${String(broken?.error)}`)
    assert.equal(broken?.error.includes(root.dir), false, 'the row carries no absolute path')
    assert.equal(broken?.movable, false)
    assert.equal(broken?.cards, 0)
    assert.equal(rows.find(row => row.slug === projectSlug(healthyCwd))?.cards, 1, 'the other stores are listed as usual')
  })
})

// --- what the SECOND review of the fix batch found (2026-11-22) -------------------------------

test('P9 the vendor prefix list keeps each arm\u2019s own left boundary when the rules are merged', () => {
  const run = 'q7Zm4Xp2Lb9Rt6Kw3v1xy2B4' // 24 characters of token
  // `hf_` refuses a letter or digit before it, and nothing else.
  assert.equal(credentialCode(`token hf_${run}${run}`), 'token-prefix')
  assert.equal(credentialCode(`_hf_${run}${run}`), 'token-prefix', 'an underscore before it is in scope')
  assert.equal(credentialCode(`xhf_${run}${run}`), undefined, 'a letter before it is not the prefix')
  // The Slack and GitHub arms never had a left boundary.
  assert.equal(credentialCode(`axoxb-${run}-${run}`), 'token-prefix')
  assert.equal(credentialCode(`xghp_${run}${run}`), 'token-prefix')
  // The ones that did keep it.
  assert.equal(credentialCode(`xsk-${run}`), undefined)
  assert.equal(credentialCode(`sk-${run}`), 'token-prefix')
})

test('P9 a boolean literal must be the WHOLE value of a flag-named assignment', () => {
  assert.equal(credentialCode('authToken = true'), undefined)
  assert.equal(credentialCode('clientSecret: "false"'), undefined)
  assert.equal(credentialCode('authToken=null, retry=2'), undefined)
  // A literal that only starts the value is no flag.
  assert.equal(credentialCode('authToken=true-abc123'), 'named-secret')
  assert.equal(credentialCode('authToken=truex9'), 'named-secret')
  // "Whole" is about what FOLLOWS the literal, not a list of allowed
  // followers: a line end, a full stop and a closing bracket all keep the
  // exemption. (A list lost the line end, and a multi-line card whose first
  // line was `- hasToken = true` was refused as a secret.)
  assert.equal(credentialCode('- hasToken = true\n- retry = 2'), undefined)
  assert.equal(credentialCode('set authToken=true.'), undefined)
  assert.equal(credentialCode('when clientSecret=false) {'), undefined)
  assert.equal(credentialCode('hasToken = True 时走缓存'), undefined)
})

test('an error text drops the user\u2019s directories: quoted, spaced, under the home, and outside the store', () => {
  const root = scratchRoot('dshm-safe-error-text-')
  const quoted = safeFsErrorText(new Error(`EACCES: permission denied, open 'C:\\Users\\John Smith\\store\\topics\\a.md'`), root.dir)
  assert.equal(quoted, "EACCES: permission denied, open '<path>'")
  const spaced = safeFsErrorText(new Error('cannot scan C:\\Users\\John Smith\\store\\topics because it is locked'), root.dir)
  assert.equal(spaced, 'cannot scan <path> because it is locked', 'a path with spaces ends where the sentence resumes')
  // The FIRST run after the drive may be bare: the anchor already proved it
  // is a path.
  assert.equal(safeFsErrorText(new Error('cannot scan D:\\My Documents\\notes.txt because it is locked'), root.dir),
    'cannot scan <path> because it is locked')
  assert.equal(safeFsErrorText(new Error('open C:\\a\\b.txt then see x/y for details'), root.dir),
    'open <path> then see x/y for details', 'prose after a path is not swallowed, slash or no slash')
  assert.equal(safeFsErrorText(new Error('see file:///C:/Users/John Smith/a/b.md and ~john/a/b.md'), root.dir), 'see <path> and <path>')
  // A quoted POSIX path with spaces is cut whole; a quoted route is too — the
  // two cannot be told apart, and only a piece of the diagnosis is lost.
  assert.equal(safeFsErrorText(new Error("cannot open '/opt/my vendor/x y.conf' now"), root.dir), "cannot open '<path>' now")
  // The store root must end at a separator: its sibling is a path of its own,
  // not a tail of the root (`…ory\x.md`) — and not the root's relative form.
  assert.equal(safeFsErrorText(new Error(`cannot read ${root.dir}ory\\x.md`), root.dir), 'cannot read <path>')
  // Under the store root: relative, and a space in the path survives intact.
  const inside = safeFsErrorText(new Error(`cannot read ${join(root.dir, 'projects', 'x y', 'topics', 'a.md')}`), root.dir)
  assert.equal(inside, `cannot read ${join('projects', 'x y', 'topics', 'a.md')}`)
  // Under the home directory: `~`, whatever the user is called.
  const underHome = safeFsErrorText(new Error(`cannot read ${join(homedir(), 'elsewhere', 'a b', 'c.md')}`), root.dir)
  assert.equal(underHome, `cannot read ${join('~', 'elsewhere', 'a b', 'c.md')}`)
  // An fs error whose path lies OUTSIDE the store names no directory at all.
  const outside = Object.assign(new Error('x'), { code: 'EACCES', syscall: 'open', path: join(homedir(), 'secret-project', 'a.md') })
  assert.equal(safeFsErrorText(outside, root.dir), 'EACCES open')
})

test('P8 a move that OVERWRITES a same-key card carries the moved card\u2019s origin, not the destination\u2019s', async () => {
  const root = scratchRoot('dshm-p8-move-overwrite-')
  const source = root.projectFor('D:\\proj\\overwrite-from')
  const target = root.projectFor('D:\\proj\\overwrite-to')
  await source.upsert({ name: 'mover', category: 'fact', summary: 'hook', body: '移动过来的正文', source: 'aaaa1111' })
  await target.upsert({ name: 'mover', category: 'fact', summary: 'old hook', body: '目标原有的正文', source: 'bbbb2222' })
  assert.equal(await source.moveCardTo(target, 'mover'), 'occupied', 'never silently')
  assert.equal(await source.moveCardTo(target, 'mover', true), 'moved')
  assert.equal(target.get('mover')?.body, '移动过来的正文')
  // An update keeps the recorded origin — except here: the card is no longer
  // the destination's, so neither is its origin.
  assert.equal(target.get('mover')?.source, 'aaaa1111')
})

test('the session id a card or a ledger row may carry is admitted in one place', () => {
  assert.equal(admittedSessionId('session-49ce2455-aaaa'), '49ce2455')
  assert.equal(admittedSessionId('session-ab/cdef-1234'), undefined)
  assert.equal(admittedSessionId(''), undefined)
})

// --- what the from-scratch re-review found (2026-11-22) ---------------------------------------

test('a sweep whose copies all landed removes what it can and names the cards the filesystem kept', async () => {
  const root = scratchRoot('dshm-forget-partial-')
  const cwd = 'D:\\proj\\forget-partial'
  const store = root.projectFor(cwd)
  await save(store, 'loose-a', '用 pnpm 跑 typecheck')
  await save(store, 'locked-b', '用 pnpm 跑 build')
  // One removal the filesystem refuses: EBUSY, a scanner or an editor
  // holding the file on Windows. (A read-only file does NOT reproduce it —
  // this Node unlinks those — so the step itself is replaced.)
  const unlink = (store as unknown as { unlinkCardFile(name: string): Promise<void> }).unlinkCardFile.bind(store)
  ;(store as unknown as { unlinkCardFile(name: string): Promise<void> }).unlinkCardFile = async (name: string) => {
    if (name === 'locked-b') throw Object.assign(new Error('EBUSY: resource busy or locked, unlink'), { code: 'EBUSY', syscall: 'unlink' })
    await unlink(name)
  }
  const warnings: string[] = []
  const realWarn = console.warn
  console.warn = (message: unknown) => { warnings.push(String(message)) }
  try {
    const outcome = await store.forget('pnpm')
    // The copies all landed first, so each removal is undoable on its own.
    // One that fails ends THAT card — it used to abort the sweep after the
    // first removal, with no ledger row and a ghost line left in the index.
    assert.deepEqual(outcome.removed, ['loose-a'])
    assert.deepEqual(outcome.failed, ['locked-b'])
    assert.equal(store.get('loose-a'), undefined)
    assert.ok(store.get('locked-b') !== undefined, 'the busy card is still there')
    assert.equal(store.indexDrift(), undefined, 'the index was rebuilt whatever happened')
    assert.deepEqual(root.ledgerEntries().find(row => row.pass === 'forget')?.keys, ['loose-a'], 'the ledger names what went')
    assert.equal(store.archivedCards().length, 2, 'both copies landed before the first removal')
    assert.ok(warnings.some(line => /could not remove "locked-b" \(its copy is in the archive\): EBUSY unlink/u.test(line)),
      'the host log names the card and keeps the errno — and no directory')
  } finally {
    console.warn = realWarn
  }
})

test('a move whose source cannot archive gives the destination its own card back — origin included', async () => {
  const root = scratchRoot('dshm-move-compensate-')
  const source = root.projectFor('D:\\proj\\move-c-from')
  const target = root.projectFor('D:\\proj\\move-c-to')
  await source.upsert({ name: 'mover', category: 'fact', summary: 'hook', body: '移动过来的正文', source: 'aaaa1111' })
  await target.upsert({ name: 'mover', category: 'fact', summary: 'old hook', body: '目标原有的正文', source: 'bbbb2222' })
  writeFileSync(join(source.dir, 'archive'), 'not a directory')
  await captureWarn(async () => {
    await assert.rejects(source.moveCardTo(target, 'mover', true), /cannot archive the card "mover"/u)
  })
  assert.equal(source.get('mover')?.body, '移动过来的正文', 'the source card is untouched')
  // The destination had already been overwritten when the source refused;
  // the snapshot puts its own card back — an update would have kept the
  // MOVED card's origin on a card that is no longer the moved one.
  assert.equal(target.get('mover')?.body, '目标原有的正文', 'the destination got its own card back')
  assert.equal(target.get('mover')?.source, 'bbbb2222', 'with its own origin')
})

test('P5 a Windows device name is not a topic key; neither is a key shaped like a vendor token', () => {
  for (const name of ['con', 'nul', 'aux', 'prn', 'com1', 'lpt9']) assert.equal(isValidTopic(name), false, name)
  assert.equal(isValidTopic('console'), true)
  assert.equal(isValidTopic('nul-check'), true)
  // A key becomes a file name and a piece of every index line. `sk-…` is a
  // valid kebab key; the vendor pattern catches it before it becomes either.
  assert.match(validateCardInput({ name: 'sk-abcdefghijklmnopqrst', category: 'fact', summary: 'hook', body: 'body' }) ?? '', /shape of a credential/u)
  assert.equal(validateCardInput({ name: 'token-refresh', category: 'fact', summary: 'hook', body: 'body' }), undefined, 'a key that merely ends in `token` is a key')
  // Upper-case hex at key length is a key too.
  assert.equal(credentialCode('hash 0F1E2D3C4B5A69788796A5B4C3D2E1F0'), 'hex-key')
})

test('a hand-edited file with no frontmatter reads as undated — the same on every day', () => {
  const card = parseCard('loose-note', 'just a line of text without any frontmatter\n')
  assert.equal(card.malformed, true)
  // Stamping it "today" made an unchanged store inject a different key line
  // after midnight, and ranked the file as freshly edited.
  assert.equal(card.updated, UNKNOWN_DATE)
  assert.equal(card.created, UNKNOWN_DATE)
  assert.match(renderCardBlock(card), /\(0000-00-00\): just a line/u)
})

test('the archive prune removes copies only — a note dropped beside them stays', async () => {
  const store = scratchStore('dshm-prune-md-')
  const oldDay = join(store.dir, 'archive', '2001-01-01')
  mkdirSync(oldDay, { recursive: true })
  const oldCopy = join(oldDay, 'old-copy.md')
  const note = join(oldDay, 'notes.txt')
  const stale = new Date('2001-01-01T00:00:00Z')
  writeFileSync(oldCopy, 'x', 'utf8')
  utimesSync(oldCopy, stale, stale)
  writeFileSync(note, 'keep me', 'utf8')
  utimesSync(note, stale, stale)
  await save(store, 'live', '内容')
  await store.remove('live', 'forget')
  assert.equal(existsSync(oldCopy), false, 'the expired copy is pruned')
  assert.equal(existsSync(note), true, 'the note beside it is not the archive\u2019s to remove')
})

test('removing a project drops its refused-deletion rows', async () => {
  const root = scratchRoot('dshm-remove-project-failures-')
  const cwd = 'D:\\proj\\gone-soon'
  const store = root.projectFor(cwd)
  await save(store, 'card', '内容')
  root.recordArchiveFailure(projectSlug(cwd), 'card', 'EACCES: permission denied')
  assert.equal(root.archiveFailures().length, 1)
  await removeProject(root.dir, projectSlug(cwd))
  // "The card is still in the memory list" — with the directory gone, it is not.
  assert.deepEqual(root.archiveFailures(), [])
})
