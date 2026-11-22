/**
 * The usage script's reader and counter, on a CONSTRUCTED log.
 *
 * The kernel stores a session log as multi-frame zstd — one frame per write —
 * and `zstdDecompressSync` over the whole buffer stops after the first frame
 * (measured on a real file: 9.8 MB / 5312 frames -> one line). A reader that
 * gets that wrong reports a session with one event and calls it "parsed". So
 * the fixture here is built frame by frame with the compressor itself, and the
 * first thing pinned is that every frame comes back.
 *
 * The second thing pinned is the privacy boundary: the script's whole point is
 * to answer "how is memory used" from logs that hold conversations, so the
 * report must carry counts and nothing else. Every string a real log would
 * keep — a topic key, a query, a card body, a tool argument, a value embedded
 * in a refusal sentence — is a sentinel here, and the report must contain none
 * of them.
 *
 * @module @dsh-app/plugin-memory/tests/memory-usage
 */

import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { aggregate, decompressFrames, emptyUsage, formatUsage, listSessionLogs, parseSince } from '../scripts/lib/session-log.mjs'
import { scratchDir } from './scratch.ts'

// `zstdCompressSync` is what builds the fixture; the script itself needs only
// the decompressor. A Node without zstd cannot run either half.
const HAS_ZSTD = typeof zstdCompressSync === 'function' && typeof zstdDecompressSync === 'function'
const skip = HAS_ZSTD ? false : 'this Node has no zstd support in node:zlib'

/** Sentinels: each stands for a piece of a real log the report must never echo. */
const TOPIC = 'SENTINEL-topic-xq71'
const QUERY = 'SENTINEL-query-xq71'
const BODY = 'SENTINEL-body-xq71'
const VALUE = 'SENTINEL-value-xq71'
const SENTINELS = [TOPIC, QUERY, BODY, VALUE]

const SINCE = '2026-10-01'
const T = Date.parse(`${SINCE}T00:00:00Z`)

/** One logged event. */
function event(time: number, type: string, data: unknown): string {
  return `${JSON.stringify({ type, time, data })}\n`
}

/** A native tool call + its result, as the kernel logs them (arguments as JSON text). */
function native(time: number, callId: string, name: string, args: unknown, payload: unknown, isError = false): string[] {
  return [
    event(time, 'tool/call', { name, callId, arguments: JSON.stringify(args), step: 1, turn: 1 }),
    event(time + 1, 'tool/result', {
      step: 1,
      turn: 1,
      message: { toolCallId: callId, isError, role: 'tool', content: [{ type: 'text', text: JSON.stringify(payload) }] },
    }),
  ]
}

/** A run_code dispatch of a tool + its result, as the kernel logs them (arguments as an object). */
function ptc(time: number, subCallId: string, name: string, args: unknown, payload: unknown): string[] {
  return [
    event(time, 'tool/ptc-dispatch-start', { name, subCallId, arguments: args }),
    event(time + 1, 'tool/ptc-dispatch', { name, subCallId, isError: false, content: [{ type: 'text', text: JSON.stringify(payload) }] }),
  ]
}

/** The fixture's lines, in log order. */
function fixtureLines(): string[] {
  return [
    // The header carries no `time`: it is a line, never an event.
    `${JSON.stringify({ version: 4, id: 's1', createdAt: SINCE, cwd: 'D:\\p' })}\n`,
    // Before --since: a call that must not be counted.
    ...native(T - 86_400_000, 'old', 'memory_save', { topic: TOPIC }, { saved: true, op: 'created' }),
    event(T + 1, 'turn/start', { turn: 1 }),
    event(T + 2, 'user/message', { role: 'user', content: [{ type: 'text', text: BODY }] }),
    // Recall by topic (answer nests its view under `project`), and by query (nothing matched).
    ...native(T + 3, 'c1', 'memory_recall', { topic: TOPIC }, { project: { found: true, card: { topic: TOPIC, body: BODY } } }),
    ...native(T + 5, 'c2', 'memory_recall', { query: QUERY }, { project: { cards: [], truncated: false, total: 0 } }),
    // A save refused by the length rule: a sentence, with counts in it.
    ...native(T + 7, 'c3', 'memory_save', { topic: TOPIC, content: BODY }, { saved: false, reason: 'content too long (612/500 chars)' }),
    // A save whose call itself errored.
    ...native(T + 9, 'c4', 'memory_save', {}, 'boom', true),
    // The duplicate gate: its sentence names the card it refused against.
    ...ptc(T + 11, 'p1', 'memory_save', { topic: TOPIC }, {
      saved: false,
      reason: `duplicate-of: topic "${TOPIC}" already covers this (similarity 0.91)`,
      existing: TOPIC,
    }),
    // An update that was accepted with a `related` hint.
    ...ptc(T + 13, 'p2', 'memory_save', {}, { saved: true, op: 'updated', related: [TOPIC] }),
    // A forget that removed two cards, and one that removed nothing.
    ...ptc(T + 15, 'p3', 'memory_forget', { match: TOPIC }, { forgotten: 2, scopes: { project: { removed: [TOPIC, 'another'], remaining: 0 } } }),
    ...ptc(T + 17, 'p4', 'memory_forget', { match: '' }, { forgotten: 0, reason: 'empty match' }),
    // A recall refused with a stable code beside a sentence, and a save whose
    // refusal embeds a value the model sent.
    ...native(T + 19, 'c5', 'memory_recall', {}, { code: 'no-workspace', reason: BODY }),
    ...native(T + 21, 'c6', 'memory_save', {}, { saved: false, reason: `unknown category "${VALUE}"; must be one of: fact` }),
    // Another plugin's tool: a call, never a memory call.
    ...native(T + 23, 'c7', 'read_file', {}, BODY),
  ]
}

/**
 * Compress lines into frames: `perFrame` lines per frame, as the kernel
 * appends one frame per write.
 */
function framesOf(lines: string[], perFrame: number): Buffer[] {
  const frames: Buffer[] = []
  for (let at = 0; at < lines.length; at += perFrame) {
    frames.push(zstdCompressSync(Buffer.from(lines.slice(at, at + perFrame).join(''), 'utf8')))
  }
  return frames
}

/** A whole multi-frame stream. */
function multiFrame(lines: string[], perFrame: number): Buffer {
  return Buffer.concat(framesOf(lines, perFrame))
}

/** Write one log where the kernel would, under a scratch root. */
function writeLog(root: string, name: string, buffer: Buffer): string {
  const dir = join(root, 'a', 'b')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, buffer)
  return file
}

test('a multi-frame zstd log is read to its last frame', { skip }, () => {
  // The regression this pins: one decompress call over the whole file returns
  // the FIRST frame only, so a naive reader sees a fraction of the session.
  const lines = fixtureLines()
  const whole = multiFrame(lines, 1)
  assert.equal(zstdDecompressSync(whole).toString('utf8'), lines[0], 'the naive read stops after frame one')
  const decoded = decompressFrames(whole)
  assert.equal(decoded.frames, lines.length)
  assert.equal(decoded.truncated, false)
  assert.equal(decoded.text, lines.join(''))
  // Frame size is the kernel's write pattern, not the format: several lines
  // per frame read the same.
  const batched = decompressFrames(multiFrame(lines, 3))
  assert.equal(batched.frames, Math.ceil(lines.length / 3))
  assert.equal(batched.text, lines.join(''))
})

test('a torn tail keeps every frame before it', { skip }, () => {
  // A crash mid-write leaves a partial last frame. Losing the session would
  // lose the whole history to the last bad write; losing the tail is honest.
  const whole = multiFrame(fixtureLines(), 1)
  const torn = decompressFrames(Buffer.concat([whole, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01])]))
  assert.equal(torn.frames, fixtureLines().length)
  assert.equal(torn.truncated, true)
  assert.match(torn.text, /tool\/ptc-dispatch/u)
  // Stray bytes between frames are skipped, not treated as a frame.
  const frames = framesOf(fixtureLines(), 1)
  const padded = decompressFrames(Buffer.concat([frames[0]!, Buffer.from([0x00, 0x00]), ...frames.slice(1)]))
  assert.equal(padded.text, fixtureLines().join(''))
  assert.equal(padded.truncated, true)
  // Nothing that decodes is not a log this reader understands.
  const garbage = decompressFrames(Buffer.from('not a zstd stream at all', 'utf8'))
  assert.equal(garbage.frames, 0)
  assert.equal(garbage.text, '')
})

test('the tally counts modes, outcomes and refusal buckets, and honors --since', { skip }, () => {
  const root = scratchDir('dshm-usage-')
  const lines = fixtureLines()
  // One line the parser must skip and count, carrying a sentinel of its own.
  writeLog(root, 'session.v4.jsonl.zstd', multiFrame([...lines, `not json: ${BODY}\n`], 2))
  // Files that are not v4 logs are never read.
  writeLog(root, 'session.v3.jsonl.zstd', multiFrame(lines, 1))
  mkdirSync(join(root, 'c'))
  writeFileSync(join(root, 'c', 'notes.txt'), BODY)

  assert.deepEqual(listSessionLogs(root), [join(root, 'a', 'b', 'session.v4.jsonl.zstd')])
  const usage = aggregate(listSessionLogs(root), parseSince(SINCE))
  assert.equal(usage.files, 1)
  assert.equal(usage.parsed, 1)
  assert.equal(usage.unreadable, 0)
  assert.equal(usage.truncated, 0)
  // Every line is counted, the header and the broken one included.
  assert.equal(usage.lines, lines.length + 1)
  assert.equal(usage.unparsable, 1)
  assert.equal(usage.sessionsWithTurns, 1)
  assert.equal(usage.turns, 1)
  assert.equal(usage.userMessages, 1)

  // Calls: the pre-since save is out; the other tool is a call, not a memory call.
  assert.equal(usage.nativeCalls, 7)
  assert.equal(usage.ptcCalls, 4)
  assert.equal(usage.memoryCalls, 10)
  assert.equal(usage.sessionsWithMemory, 1)
  assert.deepEqual(usage.byTool, { memory_save: 5, memory_recall: 3, memory_forget: 2 })

  // A native call's arguments are JSON text, a ptc dispatch's are an object:
  // the mode must read the same from both.
  assert.deepEqual(usage.recall.mode, { topic: 1, query: 1, 'list-all': 1 })
  assert.deepEqual(usage.recall.results, { 'topic-not-found': 0, '0 cards': 1, '1 card': 1, '2-5 cards': 0, '6-12 cards': 0, '>12 cards': 0 })
  assert.deepEqual(usage.recall.refusals, { 'no-workspace': 1 })
  assert.equal(usage.recall.unparsed, 0)

  assert.deepEqual(usage.save.outcomes, { created: 0, updated: 1, unchanged: 0, other: 0 })
  assert.deepEqual(usage.save.refusals, { 'content-too-long': 1, 'duplicate-of': 1, 'unknown-category': 1 })
  assert.equal(usage.save.errors, 1)
  assert.equal(usage.save.unparsed, 0)
  assert.equal(usage.save.duplicate, 1)
  assert.equal(usage.save.related, 1)

  assert.equal(usage.forget.removedCards, 2)
  assert.equal(usage.forget.callsRemovingNothing, 0)
  assert.deepEqual(usage.forget.refusals, { 'empty match': 1 })
  assert.equal(usage.forget.unparsed, 0)

  // Without --since the earlier save is counted too.
  const all = aggregate(listSessionLogs(root), 0)
  assert.equal(all.memoryCalls, 11)
  assert.deepEqual(all.save.outcomes, { created: 1, updated: 1, unchanged: 0, other: 0 })
})

test('the report carries counts and bucket names, and nothing from the log', { skip }, () => {
  const root = scratchDir('dshm-usage-')
  const lines = fixtureLines()
  writeLog(root, 'session.v4.jsonl.zstd', multiFrame(lines, 1))
  const report = formatUsage(aggregate(listSessionLogs(root), parseSince(SINCE)), { root, since: SINCE })
  for (const sentinel of SENTINELS) {
    assert.equal(report.includes(sentinel), false, `the report echoes ${sentinel}`)
  }
  // And it says what a reader needs to trust it.
  assert.match(report, /files=1 parsed=1 unreadable=0/u)
  assert.match(report, /memory tool calls=10 /u)
  assert.match(report, /content-too-long=1/u)
  assert.match(report, /duplicate refusals=1 related hints=1/u)
  // Nor the directory it read: the report is counts and bucket names, and a
  // redirect of it stays free of this machine's paths (the CLI says the root
  // on stderr).
  assert.equal(report.includes(root), false, 'the report echoes the root directory')
})

test('a credential refusal is bucketed by the head of the tool\'s own sentence, and a stable code wins', { skip }, () => {
  const root = scratchDir('dshm-usage-cred-')
  // The exact sentence `memory_save` answers with (tools.ts). The head that
  // matched it had a space after 内容 — no Chinese sentence has one — so every
  // such refusal fell into `other`.
  const sentence = '内容可能包含密钥或凭据，拒绝保存；如确需记录请先脱敏再保存'
  const lines = [
    `${JSON.stringify({ version: 4, id: 's1', createdAt: SINCE, cwd: 'D:\\p' })}\n`,
    ...native(T + 1, 'c1', 'memory_save', { topic: TOPIC }, { saved: false, reason: sentence }),
    ...native(T + 3, 'c2', 'memory_save', { topic: TOPIC }, { saved: false, reason: 'content looks like it carries a credential; refusing to persist' }),
    ...native(T + 5, 'c3', 'memory_save', { topic: TOPIC }, { saved: false, code: 'credential-refused', category: 'named-secret', reason: sentence }),
    // A sentence with a value the model sent embedded: counted, never printed.
    ...native(T + 7, 'c4', 'memory_save', { topic: TOPIC }, { saved: false, reason: `topic ${VALUE} is not allowed here` }),
  ]
  writeLog(root, 'session.v4.jsonl.zstd', multiFrame(lines, 1))
  const usage = aggregate(listSessionLogs(root), 0)
  assert.deepEqual(usage.save.refusals, { credential: 2, 'credential-refused': 1, other: 1 })
  const report = formatUsage(usage, { since: 'beginning' })
  assert.equal(report.includes(VALUE), false)
  assert.match(report, /credential=2/u)
})

test('a topic-key fallback that returns several cards is bucketed by its size, not as "1 card"', { skip }, () => {
  const root = scratchDir('dshm-usage-fallback-')
  const lines = [
    `${JSON.stringify({ version: 4, id: 's1', createdAt: SINCE, cwd: 'D:\\p' })}\n`,
    // The shape of R1's multi-card fallback: `found` is true AND `cards` is
    // an array. Reading `found` first put every one of them in "1 card".
    ...native(T + 1, 'c1', 'memory_recall', { topic: 'export' }, {
      project: { found: true, topic: 'export', cards: [{ topic: 'a' }, { topic: 'b' }, { topic: 'c' }], candidates: ['a', 'b', 'c'], fallback: true, total: 9, matched: 3 },
    }),
    ...native(T + 3, 'c2', 'memory_recall', { topic: 'a' }, { project: { found: true, card: { topic: 'a' } } }),
  ]
  writeLog(root, 'session.v4.jsonl.zstd', multiFrame(lines, 1))
  const usage = aggregate(listSessionLogs(root), 0)
  assert.deepEqual(usage.recall.results, {
    'topic-not-found': 0, '0 cards': 0, '1 card': 1, '2-5 cards': 1, '6-12 cards': 0, '>12 cards': 0,
  })
})

test('a root that does not exist is zero counts, not an error', { skip }, () => {
  const missing = join(scratchDir('dshm-usage-'), 'sessions')
  assert.deepEqual(listSessionLogs(missing), [])
  const usage = aggregate(listSessionLogs(missing), 0)
  assert.deepEqual(usage, emptyUsage())
  const report = formatUsage(usage, { root: missing, since: 'beginning' })
  assert.match(report, /files=0 parsed=0 unreadable=0/u)
  assert.match(report, /memory tool calls=0 /u)
  assert.match(report, /refusals: \(none\)/u)
})

test('a log that cannot be decoded is counted, and never counted as empty', { skip }, () => {
  const root = scratchDir('dshm-usage-')
  writeLog(root, 'session.v4.jsonl.zstd', multiFrame(fixtureLines(), 1))
  // A corrupt first frame decodes nothing: unreadable, so a format change
  // cannot pass for "no memory was used".
  mkdirSync(join(root, 'bad'))
  writeFileSync(join(root, 'bad', 'session.v4.jsonl.zstd'), Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xff, 0xff]), multiFrame(fixtureLines(), 1)]))
  const usage = aggregate(listSessionLogs(root), 0)
  assert.equal(usage.files, 2)
  assert.equal(usage.parsed, 1)
  assert.equal(usage.unreadable, 1)
  assert.equal(usage.memoryCalls, 11)
})

test('--since is a calendar date at UTC midnight, and nothing else', () => {
  assert.equal(parseSince('2026-10-01'), T)
  for (const bad of ['2026-10', '2026-13-01', '01-10-2026', '2026-10-01T00:00:00Z', '', 'yesterday']) {
    assert.throws(() => parseSince(bad), `"${bad}" is not a date this script accepts`)
  }
})

/** Run the CLI and return its status and both streams. */
function runCli(...args: string[]): { status: number, stdout: string, stderr: string } {
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'memory-usage.mjs')
  // windowsHide: a probe run inside Electron must not pop a console per child.
  const run = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true })
  return { status: run.status ?? -1, stdout: run.stdout ?? '', stderr: run.stderr ?? '' }
}

test('the CLI prints the tally and exits 0; a bad argument exits 2', { skip }, () => {
  const root = scratchDir('dshm-usage-')
  writeLog(root, 'session.v4.jsonl.zstd', multiFrame(fixtureLines(), 1))
  const run = runCli('--root', root, '--since', SINCE)
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /memory tool calls=10 /u)
  assert.match(run.stdout, /since=2026-10-01/u)
  for (const sentinel of SENTINELS) {
    assert.equal(run.stdout.includes(sentinel), false, `stdout echoes ${sentinel}`)
  }
  // `--root=<dir>` is the same argument.
  assert.match(runCli(`--root=${root}`).stdout, /memory tool calls=11 /u)
  // A missing root is zero counts and exit 0.
  const missing = runCli('--root', join(root, 'sessions'))
  assert.equal(missing.status, 0, missing.stderr)
  assert.match(missing.stdout, /files=0 /u)
  // An argument the script cannot parse is the one failure it reports.
  assert.equal(runCli('--root', root, '--since', '2026-13-40').status, 2)
  assert.equal(runCli('--bogus').status, 2)
  assert.equal(runCli('--root', join(root, 'a', 'b', 'session.v4.jsonl.zstd')).status, 2)
})

test('the CLI runs without a bundling step', () => {
  // Unlike memory-health.mjs, this script imports only node: builtins and its
  // own lib: there is no TypeScript to bundle first, so it runs as shipped.
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'memory-usage.mjs')
  const out = execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8', windowsHide: true })
  assert.match(out, /--since YYYY-MM-DD/u)
})
