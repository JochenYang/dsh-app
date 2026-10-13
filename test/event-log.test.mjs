// The structured event log (`<logs>/dsh-events.jsonl`).
//
// What these tests are for: the sink is a NEW durable file that a user shares
// when something goes wrong, so three claims have to hold — every line is one
// valid JSON object (a half-written or injected line would make the whole file
// unreadable), the family on disk is BOUNDED (an unbounded log is worse than
// none, the reason `log-file.ts` states for its own rotation), and nothing that
// looks like a credential, a prompt or a payload can land in it. The last one is
// asserted in the only form that can fail: drive a real credential-shaped value
// through the sink and require the raw string to be absent from the file.
//
// Measured facts the design rests on: `redact()` caps a line at MAX_LOG_LINE
// (2000) as well as redacting it, and it is applied to each VALUE before
// serialization — applying it to the finished line could cut valid JSON in half.
//
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { scratchDir } from './scratch.mjs'

const require = createRequire(import.meta.url)
const { MAX_LOG_LINE } = require('../dist/main/redact.js')
const { hostExitError, hostStartFailureDetail } = require('../dist/main/desktop-host.js')
const {
  EVENT_LOG_FILENAME,
  EVENT_LOG_KEEP_ROTATIONS,
  EVENT_LOG_MAX_BYTES,
  EVENT_LOG_MAX_TOTAL_BYTES,
  MAX_EVENT_DETAIL_KEYS,
  EventLog,
  configureEventLog,
  errorFactsDetail,
  isRotatedEventFileName,
  logEvent,
  newRunId,
  renderEventLine,
  rotatedEventFileName,
  trackedEventOperation,
} = require('../dist/main/event-log.js')

const identity = { run: 'run-1', pid: 4172, seq: 7 }

/** Every `dsh-events*.jsonl` in a directory, generations sorted oldest first. */
function family(dir) {
  const names = readdirSync(dir).filter((name) => name === EVENT_LOG_FILENAME || isRotatedEventFileName(name))
  return {
    generations: names.filter(isRotatedEventFileName).sort(),
    totalBytes: names.reduce((sum, name) => sum + statSync(path.join(dir, name)).size, 0),
  }
}

/** The parsed records of one file, in order. */
function records(file) {
  const text = readFileSync(file, 'utf8')
  assert.equal(text.endsWith('\n'), true, 'every event line is newline-terminated')
  assert.equal(text.includes('\n\n'), false, 'no blank line is written')
  return text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
}

/**
 * The argument text of the call whose `(` is at `from`. Quote- and
 * comment-aware, so a `)` inside a string is not read as the close; it is
 * deliberately not a parser — the guard below only needs the arguments of calls
 * this codebase writes in one shape.
 */
function balancedCall(source, from) {
  let depth = 0
  let quote = ''
  for (let i = from; i < source.length; i += 1) {
    const char = source[i]
    if (quote !== '') {
      if (char === '\\') i += 1
      else if (char === quote) quote = ''
      continue
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue }
    if (char === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i)
      i = end === -1 ? source.length : end
      continue
    }
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 1
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return source.slice(from + 1, i)
    }
  }
  return source.slice(from + 1)
}

/** 1-based line number of an offset, for a guard's failure message. */
function lineOf(source, offset) {
  return source.slice(0, offset).split('\n').length
}

// ---------------------------------------------------------------- pure rendering

test('one event renders as one line of valid JSON, in a fixed field order', () => {
  const at = new Date('2026-10-13T09:12:04.512Z')
  const line = renderEventLine(
    { event: 'host.start.ready', ms: 8312.4, detail: { transport: 'web', kernel: '0.2.0-rc.2' } },
    identity,
    at,
  )
  assert.equal(line.includes('\n'), false)
  const record = JSON.parse(line)
  assert.deepEqual(Object.keys(record), ['ts', 'event', 'seq', 'run', 'pid', 'ms', 'detail'])
  assert.equal(record.ts, '2026-10-13T09:12:04.512Z')
  assert.equal(record.event, 'host.start.ready')
  assert.equal(record.seq, 7)
  assert.equal(record.run, 'run-1')
  assert.equal(record.pid, 4172)
  assert.equal(record.ms, 8312, 'a duration is reported as whole milliseconds')
  assert.deepEqual(record.detail, { transport: 'web', kernel: '0.2.0-rc.2' })

  // `ms` is optional and only meaningful when finite; a negative measurement is
  // clamped rather than written as a negative duration.
  assert.equal('ms' in JSON.parse(renderEventLine({ event: 'x' }, identity, at)), false)
  assert.equal(JSON.parse(renderEventLine({ event: 'x', ms: Number.NaN }, identity, at)).ms, undefined)
  assert.equal(JSON.parse(renderEventLine({ event: 'x', ms: -5 }, identity, at)).ms, 0)
})

test('an event name outside the namespace is refused, not invented', () => {
  const at = new Date('2026-10-13T09:12:04.512Z')
  const record = JSON.parse(renderEventLine({ event: 'Host Exit!', detail: { detail: 'x' } }, identity, at))
  assert.equal(record.event, 'event.invalid')
  assert.equal(record.detail.event, 'Host Exit!')
  // A name that is accepted stays exactly as given.
  assert.equal(JSON.parse(renderEventLine({ event: 'app.boot.begin' }, identity, at)).event, 'app.boot.begin')
})

test('detail is capped in key count, and the truncation is stated', () => {
  const at = new Date('2026-10-13T09:12:04.512Z')
  const wide = {}
  for (let i = 0; i < 15; i += 1) wide[`k${i}`] = i
  const detail = JSON.parse(renderEventLine({ event: 'x', detail: wide }, identity, at)).detail
  assert.equal(Object.keys(detail).length, MAX_EVENT_DETAIL_KEYS)
  // The note takes one of the capped keys, so what really did not fit is the
  // caller's fields minus the ones kept BESIDE it. Replacing the last kept entry
  // with the note — which is what this did — dropped one more than it reported,
  // and the reader could not tell without diffing the input.
  assert.equal(detail.truncated, 15 - (MAX_EVENT_DETAIL_KEYS - 1), 'the count is what was really left out')
  assert.deepEqual(
    Object.keys(detail).filter((key) => key.startsWith('k')),
    Array.from({ length: MAX_EVENT_DETAIL_KEYS - 1 }, (_, i) => `k${i}`),
    'exactly the fields the note accounts for are missing',
  )
  // undefined drops the key; a non-finite number becomes null; an Error handed
  // in as a VALUE is marked, not quoted — its message is the one thing the file
  // a user is asked to send must not carry (see the case below).
  const mixed = JSON.parse(renderEventLine(
    { event: 'x', detail: { a: undefined, b: 1, c: Number.POSITIVE_INFINITY, d: new Error('boom') } },
    identity,
    at,
  )).detail
  assert.deepEqual(mixed, { b: 1, c: null, d: '[error]' })
  // A detail that fits exactly at the cap keeps every field and states nothing.
  const exact = {}
  for (let i = 0; i < MAX_EVENT_DETAIL_KEYS; i += 1) exact[`k${i}`] = i
  const exactDetail = JSON.parse(renderEventLine({ event: 'x', detail: exact }, identity, at)).detail
  assert.equal('truncated' in exactDetail, false)
  assert.equal(Object.keys(exactDetail).length, MAX_EVENT_DETAIL_KEYS)
})

test('the truncation note owns its key, so a caller field cannot be read as one', () => {
  const at = new Date('2026-10-13T09:12:04.512Z')
  // A caller field literally named `truncated`: the note wins and counts it, so a
  // reader always reads that key as the sink's own statement. Without this the
  // event file carried the caller's string and no way to tell the two apart.
  assert.deepEqual(
    JSON.parse(renderEventLine({ event: 'x', detail: { truncated: 'caller value', kept: 1 } }, identity, at)).detail,
    { kept: 1, truncated: 1 },
  )
})

test('a value with no JSON rendering is marked, not described as text', () => {
  const at = new Date('2026-10-13T09:12:04.512Z')
  const cyclic = { a: 1 }
  cyclic.self = cyclic
  const hostile = { toJSON() { throw new Error('toJSON boom') }, toString() { throw new Error('toString boom') } }
  const detail = JSON.parse(renderEventLine(
    { event: 'x', detail: { cyclic, big: { n: 10n }, hostile, plain: { ok: true }, fn: function named() {} } },
    identity,
    at,
  )).detail
  // `String(value)` answers `[object Object]` for all three of these: text that
  // reads like a value while saying nothing. The marker says what it is.
  assert.equal(detail.cyclic, '[unserialisable]', 'a cycle is marked, not rendered as [object Object]')
  assert.equal(detail.big, '[unserialisable]', 'an object holding a BigInt is marked too')
  assert.equal(detail.hostile, '[unserialisable]', 'so is one whose toJSON throws')
  assert.equal(detail.plain, '{"ok":true}', 'anything JSON can render is still rendered')
  assert.equal(detail.fn.includes('named'), true, 'a function has no JSON form, so its own text is kept')
})

test('an Error passed as a detail value is marked, never quoted', () => {
  const dir = scratchDir('dsh-app-events-')
  const sink = new EventLog({ dir, run: 'run-error-value' })
  // The "just pass the error" shape, with the material a real one carries: a
  // spawn line, a Windows path under the user's own name, and a credential.
  const error = Object.assign(
    new Error("spawn C:\\Users\\Administrator\\AppData\\Local\\Temp\\DSH-APP-0.16.4-x64.exe ENOENT --registry https://user:pass@host"),
    { code: 'ENOENT' },
  )
  sink.log('test.error.value', { detail: { step: 'download', failure: error, note: 'kept' } })

  const text = readFileSync(sink.file, 'utf8')
  for (const fragment of ['Administrator', 'DSH-APP-0.16.4', 'user:pass', 'ENOENT --registry', 'spawn ']) {
    assert.equal(text.includes(fragment), false, `an Error value must not quote its message: ${fragment}`)
  }
  // The marker says plainly that the caller passed an Error and did not derive
  // anything from it; the class name is not written either, because a reader
  // could not tell it from the string `"Error"`.
  assert.deepEqual(records(sink.file)[0].detail, { step: 'download', failure: '[error]', note: 'kept' })
  // A caller that wants facts asks for them, and gets the guarded ones.
  sink.log('test.error.derived', { detail: { step: 'download', ...errorFactsDetail(error) } })
  assert.deepEqual(records(sink.file)[1].detail, { step: 'download', how: 'Error', code: 'ENOENT' })
})

test('the run id and the rotated file name are stable, sortable forms', () => {
  const at = new Date('2026-10-13T09:12:04.512Z')
  assert.equal(newRunId(at, 4172, 'ab12'), '20261013T091204Z-4172-ab12')
  assert.match(newRunId(at, 4172), /^\d{8}T\d{6}Z-4172-[0-9a-f]{4}$/u, 'the drawn nonce is short hex')
  assert.notEqual(newRunId(at, 4172), newRunId(at, 4172), 'two starts in one second do not collide')
  assert.equal(rotatedEventFileName(at, 1), 'dsh-events.20261013T091204Z.01.jsonl')
  assert.equal(rotatedEventFileName(at, 12), 'dsh-events.20261013T091204Z.12.jsonl')
  assert.equal(isRotatedEventFileName(rotatedEventFileName(at, 3)), true)
  assert.equal(isRotatedEventFileName(EVENT_LOG_FILENAME), false, 'the live file is never a prune candidate')
  assert.equal(isRotatedEventFileName('dsh-kernel.log'), false)
  assert.equal(isRotatedEventFileName('dsh-events.1.jsonl'), false)
  assert.equal(
    EVENT_LOG_MAX_TOTAL_BYTES,
    EVENT_LOG_MAX_BYTES * (EVENT_LOG_KEEP_ROTATIONS + 1),
    'the ceiling is the per-file cap times the generations kept',
  )
})

// ---------------------------------------------------------------- what must never land

test('credential-shaped values are redacted, and a payload-sized one is truncated', () => {
  const dir = scratchDir('dsh-app-events-')
  const sink = new EventLog({ dir, run: 'run-redact' })
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'
  const key = 'sk-abcdefghij0123456789'
  sink.log('test.headers', {
    detail: {
      header: `Authorization: Bearer ${jwt}`,
      cookies: { 'set-cookie': 'sid=abc123; Path=/; HttpOnly' },
      note: `the provider refused api_key=${key} for this request`,
    },
  })
  sink.log('test.payload', { detail: { text: 'x'.repeat(MAX_LOG_LINE * 5) } })

  const text = readFileSync(sink.file, 'utf8')
  for (const secret of [jwt, key, 'sid=abc123']) {
    assert.equal(text.includes(secret), false, `the log must not carry ${secret.slice(0, 12)}…`)
  }
  assert.match(text, /\[redacted\]/)

  const payload = records(sink.file)[1]
  assert.equal(payload.detail.text.length, MAX_LOG_LINE, 'a value is capped at MAX_LOG_LINE')
  assert.equal(payload.detail.text, 'x'.repeat(MAX_LOG_LINE), 'and the cap is a truncation, not a redaction')

  // A stray top-level option (a caller passing "just one more field") is
  // dropped: the serializer reads `ms` and `detail` only, so there is no
  // channel for free content to ride out on.
  sink.log('test.stray', { prompt: 'do not log me', messages: ['nor me'] })
  assert.equal(readFileSync(sink.file, 'utf8').includes('do not log me'), false)
})

test("the child's own output never reaches the event file", () => {
  const dir = scratchDir('dsh-app-events-')
  const sink = new EventLog({ dir, run: 'run-host-failed' })
  // The shape `DshHost.exitError` really produces: its MESSAGE is the child's
  // last 2 KB of stderr, and the facts ride beside it. A real
  // `logs/dsh-server-*.log` tail carries the host's full path, the child's whole
  // argv and the account plugin's request lines — none of which belongs in the
  // file a user is asked to send.
  const tail = [
    '[deepseek-account] request { path: "/api/account/status", method: "GET" }',
    "node C:\\Users\\Administrator\\AppData\\Roaming\\dsh-app\\runtime\\0.2.0-rc.2\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js --profile dsh-app --transport web",
    "boom: ENOENT open 'C:\\Users\\Administrator\\.dsh\\profiles\\dsh-app\\node_modules\\@dsh-app\\plugin-brand'",
    'retrying with Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
  ].join('\n')
  const error = hostExitError({ how: 'exit code 1', code: 1, signal: null }, tail)
  sink.log('host.start.failed', {
    ms: 120,
    detail: hostStartFailureDetail(error, { attempt: 2, transport: 'web' }),
  })

  const text = readFileSync(sink.file, 'utf8')
  for (const fragment of ['[deepseek-account]', 'Administrator', 'bin.js', 'plugin-brand', 'eyJhbGciOiJIUzI1NiJ9']) {
    assert.equal(text.includes(fragment), false, `the child's tail must not reach the event file: ${fragment}`)
  }
  assert.deepEqual(records(sink.file)[0].detail, {
    attempt: 2,
    transport: 'web',
    how: 'exit code 1',
    code: 1,
    signal: null,
  })
  // The message is not thrown away — it is what the failure card shows and what
  // `dsh-kernel.log` / `dsh-server-*.log` already hold. It is only kept out of
  // the shareable file, and `redact()` still covers it.
  assert.equal(error.message.includes('bin.js'), true)
  assert.equal(error.message.includes('eyJhbGciOiJIUzI1NiJ9'), false, 'the tail is still redacted where it does go')
})

test('a boot failure records derived facts, never the message it carries', () => {
  const dir = scratchDir('dsh-app-events-')
  const sink = new EventLog({ dir, run: 'run-boot-failed' })
  // What escapes `boot()` is an arbitrary library's rejection, and its message
  // is where a registry URL carrying userinfo, the command that produced it and
  // a profile path under the user's own name ride out — into the file a user is
  // asked to hand over. All three are in this one message on purpose.
  const error = new Error(
    'npm ERR! code EACCES --registry https://user:pass@registry.example.com/ ' +
      'while running node C:\\Users\\Administrator\\AppData\\Local\\dsh-app\\kernel\\0.2.0-rc.2\\bin.js',
  )
  error.name = 'BootRefused'
  error.code = 'EACCES'
  sink.log('app.boot.failed', { ms: 1200, detail: errorFactsDetail(error) })

  const text = readFileSync(sink.file, 'utf8')
  for (const fragment of ['user:pass', 'registry.example.com', 'Administrator', 'bin.js', 'npm ERR']) {
    assert.equal(text.includes(fragment), false, `the boot rejection's message must not reach the event file: ${fragment}`)
  }
  assert.deepEqual(records(sink.file)[0].detail, { how: 'BootRefused', code: 'EACCES' })
  // Nothing is thrown away: the message is what `dsh-kernel.log` and the failure
  // card carry, so the caller still has it — it is only kept out of the
  // shareable file.
  assert.equal(error.message.includes('user:pass'), true)
})

test('a derived failure detail cannot be used to smuggle text either', () => {
  const at = new Date('2026-10-13T09:12:04.512Z')
  // `name` and `code` are text the throwing library chose, so the two fields are
  // the whole vocabulary of a derived failure and both are shape-checked: a
  // message hidden in either one is dropped rather than recorded.
  const hostile = new Error('boom')
  hostile.name = "ENOENT: open 'C:\\Users\\Administrator\\.dsh\\profiles'"
  hostile.code = 'https://user:pass@host/registry'
  const record = JSON.parse(renderEventLine({ event: 'app.boot.failed', detail: errorFactsDetail(hostile) }, identity, at))
  assert.deepEqual(record.detail, { how: 'Error', code: null })
  // A rejection that is not an Error at all still says what it was.
  assert.deepEqual(errorFactsDetail('a thrown string'), { how: 'string', code: null })
  assert.deepEqual(errorFactsDetail(undefined), { how: 'undefined', code: null })
  assert.deepEqual(errorFactsDetail(null), { how: 'object', code: null })
  // The shell's own facts ride beside the derived ones.
  assert.deepEqual(errorFactsDetail(Object.assign(new Error('x'), { code: 'EPERM' }), { attempt: 2 }), {
    attempt: 2,
    how: 'Error',
    code: 'EPERM',
  })
})

test('a value holding newlines cannot forge a second event', () => {
  const dir = scratchDir('dsh-app-events-')
  const sink = new EventLog({ dir, run: 'run-injection' })
  sink.log('test.first', { detail: { text: 'line one\n{"event":"host.exit","seq":99}\nline three' } })
  sink.log('test.second', { detail: { text: 'after' } })

  const lines = readFileSync(sink.file, 'utf8').split('\n').filter((line) => line !== '')
  assert.equal(lines.length, 2, 'one call is one line, whatever the value contains')
  const parsed = lines.map((line) => JSON.parse(line))
  assert.deepEqual(parsed.map((record) => record.event), ['test.first', 'test.second'])
  assert.equal(parsed[0].detail.text.includes('\n'), true, 'the newlines are escaped inside the string')
  assert.equal(parsed.some((record) => record.seq === 99), false)
})

// ---------------------------------------------------------------- sequence and run

test('seq is monotonic within a run and identical to the lines written', () => {
  const dir = scratchDir('dsh-app-events-')
  const sink = new EventLog({ dir, run: 'run-seq' })
  for (let i = 0; i < 5; i += 1) sink.log('test.beat', { detail: { i } })
  const parsed = records(sink.file)
  assert.deepEqual(parsed.map((record) => record.seq), [1, 2, 3, 4, 5])
  assert.equal(sink.lastSeq, 5)
  // One correlation id for the whole run, and one pid (this process).
  assert.deepEqual(new Set(parsed.map((record) => record.run)), new Set(['run-seq']))
  assert.deepEqual(new Set(parsed.map((record) => record.pid)), new Set([process.pid]))
})

test('two sinks with no explicit run id do not share one', () => {
  const dir = scratchDir('dsh-app-events-')
  const a = new EventLog({ dir })
  const b = new EventLog({ dir })
  a.log('test.a')
  const [first, second] = records(a.file)
  assert.equal(second, undefined, 'both sinks wrote to the same live file')
  assert.match(first.run, /^\d{8}T\d{6}Z-\d+-[0-9a-f]{4}$/u)
  const aRun = first.run
  b.log('test.b')
  const seen = records(b.file).map((record) => record.run)
  assert.equal(new Set(seen).size, 2, 'the second start has its own correlation id')
  assert.equal(seen.includes(aRun), true, 'and the first run reads back with the one it wrote')
})

// ---------------------------------------------------------------- rotation and bounds

test('the family rotates by size and stays inside its documented budget', () => {
  const dir = scratchDir('dsh-app-events-')
  // A fixed clock: rotation here must be the SIZE rule, never the day rule.
  const sink = new EventLog({ dir, run: 'run-rotation', now: () => new Date('2026-10-13T12:00:00.000Z') })
  // 11 capped values per event (~22 KB a line) so the cap is reached in a few
  // hundred writes instead of thousands: the per-line worst case is part of what
  // is being measured here.
  const filler = 'f'.repeat(MAX_LOG_LINE)
  const detailOf = (i) => {
    const detail = { marker: `m${i}` }
    for (let k = 0; k < 11; k += 1) detail[`k${k}`] = filler
    return detail
  }
  const written = 600
  for (let i = 0; i < written; i += 1) sink.log('test.bulk', { detail: detailOf(i) })

  const { generations, totalBytes } = family(dir)
  assert.equal(generations.length, EVENT_LOG_KEEP_ROTATIONS, 'older generations are pruned at every rotation')
  for (const name of generations) assert.match(name, /^dsh-events\.\d{8}T\d{6}Z\.\d{2}\.jsonl$/u)

  // The bound, with the documented slack: a file rotates once it has REACHED the
  // cap, so a generation may exceed it by the single line that crossed it.
  const lineSlack = MAX_LOG_LINE * MAX_EVENT_DETAIL_KEYS + 200
  assert.ok(statSync(sink.file).size < EVENT_LOG_MAX_BYTES + lineSlack, 'the live file restarted after rotating')
  assert.ok(
    totalBytes < EVENT_LOG_MAX_TOTAL_BYTES + (EVENT_LOG_KEEP_ROTATIONS + 1) * lineSlack,
    `the family stays inside its ceiling (was ${String(totalBytes)} bytes)`,
  )

  // The newest content is in the live file, the sequence kept counting across
  // the rotation, and what was written first is gone with its generation.
  const live = records(sink.file)
  assert.equal(live[live.length - 1].seq, written)
  assert.equal(live[live.length - 1].detail.marker, `m${written - 1}`)
  assert.equal(live[0].seq > 1, true, 'the live file starts after at least one rotation')
  const all = [...generations.map((name) => path.join(dir, name)), sink.file]
  const text = all.map((file) => readFileSync(file, 'utf8')).join('')
  assert.equal(text.includes('"marker":"m0"'), false, 'the oldest generation was pruned')
  assert.equal(text.includes(`"marker":"m${written - 1}"`), true)
})

test('a new UTC day also starts a new file, however small the old one is', () => {
  const dir = scratchDir('dsh-app-events-')
  let clock = new Date('2026-10-13T23:59:59.000Z')
  const sink = new EventLog({ dir, run: 'run-day', now: () => clock })
  sink.log('test.before', { detail: { day: 13 } })
  assert.deepEqual(family(dir).generations, [], 'nothing rotates while the day is the same')

  clock = new Date('2026-10-14T00:00:01.000Z')
  sink.log('test.after', { detail: { day: 14 } })

  const { generations } = family(dir)
  assert.equal(generations.length, 1)
  assert.match(generations[0], /^dsh-events\.20261014T000001Z\.01\.jsonl$/u)
  assert.deepEqual(records(path.join(dir, generations[0])).map((record) => record.detail.day), [13])
  assert.deepEqual(records(sink.file).map((record) => record.detail.day), [14])
  assert.deepEqual(records(sink.file).map((record) => record.seq), [2], 'the sequence continues across a rotation')

  // Only names this module owns are ever removed: a file the shell wrote beside
  // them survives a rotation.
  const stranger = path.join(dir, 'dsh-kernel.log')
  writeFileSync(stranger, 'kernel diagnostics\n')
  for (let i = 0; i < EVENT_LOG_KEEP_ROTATIONS + 2; i += 1) {
    clock = new Date(Date.UTC(2026, 9, 15 + i, 1, 0, i))
    sink.log('test.day', { detail: { i } })
  }
  assert.equal(readFileSync(stranger, 'utf8'), 'kernel diagnostics\n')
})

test('a clock that steps backwards cannot delete the generation it just closed', () => {
  const dir = scratchDir('dsh-app-events-')
  // Four generations dated in the FUTURE relative to the clock below: a manual
  // correction, a VM or backup restore. The rotation used to be named with the
  // clock, so it sorted as the OLDEST entry in the directory and the retention
  // pass — which keeps the newest by name — deleted it in the same call that
  // created it, leaving the event it was rotating for with nowhere to go.
  const future = Array.from({ length: EVENT_LOG_KEEP_ROTATIONS }, (_, i) =>
    rotatedEventFileName(new Date(Date.UTC(2027, 0, 2 + i, 0, 0, 0)), 1))
  for (const name of future) writeFileSync(path.join(dir, name), 'earlier generation\n')

  const clock = new Date('2026-10-13T12:00:00.000Z')
  const sink = new EventLog({ dir, run: 'run-rollback', now: () => clock })
  writeFileSync(path.join(dir, EVENT_LOG_FILENAME), `${'y'.repeat(EVENT_LOG_MAX_BYTES)}\n`)
  sink.log('test.after-rollback', { detail: { marker: 'kept' } })

  const { generations } = family(dir)
  assert.equal(generations.length, EVENT_LOG_KEEP_ROTATIONS, 'the cap still holds')
  assert.deepEqual(records(sink.file).map((record) => record.detail.marker), ['kept'], 'the event landed in the live file')
  // The generation this call created is the newest one kept, whatever the clock
  // says — the stamp is clamped to the newest already on disk.
  const newest = generations[generations.length - 1]
  assert.equal(readFileSync(path.join(dir, newest), 'utf8').startsWith('y'), true, 'the rotation that just happened is the newest generation')
  assert.equal(generations.includes(future[0]), false, 'the genuinely oldest generation was the one pruned')
  for (const name of future.slice(1)) assert.equal(generations.includes(name), true)
})

test('a name this module owns but cannot remove does not abort the pass or the write', () => {
  const dir = scratchDir('dsh-app-events-')
  // A DIRECTORY carrying a generation's name. `rmSync` fails on it with
  // ERR_FS_EISDIR, and it sorts FIRST here, so the failure used to land on the
  // pass's very first removal and abandon everything after it — including the
  // append, because the rotation has already renamed the live file away by then.
  const sticky = path.join(dir, rotatedEventFileName(new Date(Date.UTC(2026, 8, 1, 0, 0, 0)), 1))
  mkdirSync(sticky)
  for (let i = 0; i < 3; i += 1) {
    writeFileSync(path.join(dir, rotatedEventFileName(new Date(Date.UTC(2026, 9, 1 + i, 0, 0, 0)), 1)), 'older\n')
  }
  const clock = new Date('2026-10-13T12:00:00.000Z')
  writeFileSync(path.join(dir, EVENT_LOG_FILENAME), `${'y'.repeat(EVENT_LOG_MAX_BYTES)}\n`)
  const failures = []
  const sink = new EventLog({ dir, run: 'run-sticky', now: () => clock, onFailure: (error) => failures.push(error) })
  assert.doesNotThrow(() => sink.log('test.sticky-name', { detail: { marker: 'kept' } }))

  assert.deepEqual(failures, [], 'the write itself is not reported as a failure')
  assert.equal(sink.lastSeq, 1)
  assert.deepEqual(records(sink.file).map((record) => record.detail.marker), ['kept'], 'the event landed')
  assert.equal(existsSync(sticky), true, 'the unremovable name is left where it is')
  assert.equal(existsSync(path.join(dir, rotatedEventFileName(clock, 1))), true, 'the generation just closed is kept')
})

// ---------------------------------------------------------------- failures

test('a write failure is reported once per episode and never thrown', () => {
  const root = scratchDir('dsh-app-events-')
  const dir = path.join(root, 'logs')
  const failures = []
  const sink = new EventLog({ dir, run: 'run-failure', onFailure: (error) => failures.push(error) })

  sink.log('test.one')
  assert.equal(sink.lastSeq, 1)
  const file = sink.file

  // A read-only file is the cheapest real failure: the append (not the code)
  // cannot happen, which is the case the sink has to survive.
  chmodSync(file, 0o444)
  assert.doesNotThrow(() => sink.log('test.two'))
  assert.doesNotThrow(() => sink.log('test.three'))
  assert.equal(failures.length, 1, 'one report for one failure episode')
  assert.equal(sink.lastSeq, 1, 'a line that could not be written consumes no sequence number')
  assert.equal(records(file).length, 1)

  // A later success closes the episode, so the NEXT failure is reported too
  // rather than hidden behind the first one.
  chmodSync(file, 0o666)
  sink.log('test.four')
  assert.equal(sink.lastSeq, 2)
  chmodSync(file, 0o444)
  sink.log('test.five')
  chmodSync(file, 0o666)
  assert.equal(failures.length, 2)
  assert.equal(records(file).length, 2)

  // The sink never writes outside its own family, and a directory that cannot
  // even be created is a reported failure rather than a throw.
  const blocked = path.join(root, 'blocked')
  writeFileSync(blocked, 'not a directory\n')
  const blockedFailures = []
  const blockedSink = new EventLog({ dir: path.join(blocked, 'logs'), run: 'run-blocked', onFailure: (e) => blockedFailures.push(e) })
  assert.doesNotThrow(() => blockedSink.log('test.blocked'))
  assert.equal(blockedFailures.length, 1)
  assert.equal(blockedSink.lastSeq, 0)
})

test('a failure while RENDERING takes the same guarded path as a failed write', () => {
  const dir = scratchDir('dsh-app-events-')
  const failures = []
  // Rendering used to sit outside the try, so this escaped `log()` — the one
  // function documented as never throwing. A clock that cannot produce an ISO
  // instant is the shortest real input that still throws while rendering.
  const broken = new EventLog({ dir, run: 'run-bad-clock', now: () => new Date(Number.NaN), onFailure: (error) => failures.push(error) })
  assert.doesNotThrow(() => broken.log('test.bad-clock'))
  assert.equal(failures.length, 1, 'it is reported the way a failed write is')
  assert.equal(broken.lastSeq, 0, 'and no sequence number is consumed')
  // A JavaScript caller can also hand any value where the type says `string`;
  // that used to reach `redact()` as a number and throw `line.replace is not a
  // function`.
  const sink = new EventLog({ dir: scratchDir('dsh-app-events-'), run: 'run-bad-name' })
  assert.doesNotThrow(() => sink.log(42))
  const [record] = records(sink.file)
  assert.equal(record.event, 'event.invalid')
  assert.equal(record.detail.event, '42', 'the rejected name reads back as text')
  assert.equal(sink.lastSeq, 1)
})

// ---------------------------------------------------------------- wiring

test('the process sink records a bracketed operation, pass-through intact', async () => {
  const dir = scratchDir('dsh-app-events-')
  const at = new Date('2026-10-13T09:12:04.512Z')
  const diagnostics = []
  const sink = configureEventLog({ dir, run: 'run-bracket', now: () => at, onDiagnostic: (line) => diagnostics.push(line) })

  const answer = await trackedEventOperation('kernel.install', { source: 'bundled' }, async () => 'installed')
  assert.equal(answer, 'installed', 'the wrapped value passes through')
  await assert.rejects(
    trackedEventOperation('kernel.install', { source: 'channel' }, async () => { throw new Error('sha512 mismatch') }),
    /sha512 mismatch/,
    'the wrapped error is rethrown unchanged',
  )
  logEvent('app.boot.ready', { ms: 12, detail: { kernel: '0.2.0-rc.2' } })

  const parsed = records(sink.file)
  assert.deepEqual(parsed.map((record) => record.event), [
    'kernel.install.begin',
    'kernel.install.end',
    'kernel.install.begin',
    'kernel.install.failed',
    'app.boot.ready',
  ])
  assert.deepEqual(parsed.map((record) => record.seq), [1, 2, 3, 4, 5], 'the helper shares the one sequence')
  assert.equal(parsed[0].ms, undefined, 'a begin has no duration of its own')
  assert.equal(typeof parsed[1].ms, 'number')
  // Derived facts on the `.failed` line, and the message only in the shell's own
  // log: the operations wrapped here fail with a downloader's, a spawn's or a
  // network stack's text as often as with a sentence of ours.
  assert.deepEqual(parsed[3].detail, { source: 'channel', how: 'Error', code: null })
  assert.equal(readFileSync(sink.file, 'utf8').includes('sha512 mismatch'), false, 'the message is not in the event file')
  assert.deepEqual(diagnostics, ['[events] kernel.install.failed: sha512 mismatch'], 'it is handed to the local log instead')
  assert.deepEqual(parsed[3].detail.source, 'channel', 'every line of the triple names the operation')
  for (const record of parsed) assert.equal(record.run, 'run-bracket')
})

test('a wrapped operation records derived facts, never the downloader text', async () => {
  const dir = scratchDir('dsh-app-events-')
  const diagnostics = []
  const sink = configureEventLog({ dir, run: 'run-op-failed', onDiagnostic: (line) => diagnostics.push(line) })
  // The shape the update and kernel downloads really fail with: a feed URL
  // carrying userinfo, an HTTP status, the mirror that served (or refused) it,
  // and the command line of the process that was tried.
  const failure = Object.assign(
    new TypeError('fetch failed for https://user:pass@ghfast.top/https://github.com/x/dsh-app/releases/latest.yml (HTTP 502)'),
    {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND while spawning node C:\\Users\\Administrator\\.dsh\\bin.js"), { code: 'ENOTFOUND' }),
    },
  )
  await assert.rejects(
    trackedEventOperation('shell.update.download', { version: '0.16.4', arch: 'x64', source: 'windows-installer' }, async () => { throw failure }),
    (thrown) => thrown === failure,
    'the wrapped error is rethrown unchanged',
  )

  const text = readFileSync(sink.file, 'utf8')
  for (const fragment of ['user:pass', 'ghfast.top', 'HTTP 502', 'github.com', 'Administrator', 'bin.js', 'fetch failed']) {
    assert.equal(text.includes(fragment), false, `the downloader's text must not reach the event file: ${fragment}`)
  }
  const failed = records(sink.file).find((record) => record.event === 'shell.update.download.failed')
  assert.deepEqual(failed.detail, {
    version: '0.16.4',
    arch: 'x64',
    source: 'windows-installer',
    how: 'TypeError',
    code: 'ENOTFOUND',
  })
  // The errno rides on `cause` for every undici failure, so it is the one fact
  // that makes the line say something; without walking the chain it would read
  // `TypeError` and nothing else.
  assert.equal(failed.detail.code, 'ENOTFOUND', 'the code is read off the cause chain')
  // The message is kept where it belongs: the shell's own log, redacted, so the
  // credential in it cannot ride out even there.
  assert.equal(diagnostics.length, 1)
  assert.match(diagnostics[0], /^\[events\] shell\.update\.download\.failed: /u)
  assert.equal(diagnostics[0].includes('ghfast.top'), true, 'the local line keeps the diagnosis')
  assert.equal(diagnostics[0].includes('user:pass'), false, 'and redact() still covers the credential')
})

test('a derived failure detail survives a hostile error object', () => {
  const at = new Date('2026-10-13T09:12:04.512Z')
  // `name`, `code` and `cause` belong to the object that was thrown, so every
  // read of them has to be guarded: a getter that throws must not turn the
  // derivation — or the `.failed` line built from it — into a second failure.
  const hostile = {
    get name() { throw new Error('name getter') },
    get code() { throw new Error('code getter') },
    get cause() { throw new Error('cause getter') },
    get message() { throw new Error('message getter') },
  }
  assert.doesNotThrow(() => errorFactsDetail(hostile))
  assert.deepEqual(errorFactsDetail(hostile), { how: 'object', code: null })
  // A cycle in the chain terminates, and a code that is not identifier-shaped
  // (a URL, a path, a sentence) is dropped rather than recorded.
  const looping = { code: 'not a code' }
  looping.cause = looping
  assert.deepEqual(errorFactsDetail(looping), { how: 'object', code: null })
  const deep = { cause: { cause: { cause: { code: 'ECONNRESET' } } } }
  assert.equal(errorFactsDetail(deep).code, 'ECONNRESET', 'the chain is followed')
  assert.deepEqual(
    errorFactsDetail(Object.assign(new Error('x'), { cause: { code: 'C:\\Users\\Administrator' } })),
    { how: 'Error', code: null },
    'a cause code a path could be is refused like a top-level one',
  )
  // The whole thing still renders as one line.
  assert.equal(typeof renderEventLine({ event: 'x', detail: errorFactsDetail(hostile) }, identity, at), 'string')
})

test('no event detail in the shell names an error message', () => {
  // The two files whose events are written from failures that cannot be driven
  // from a test: `index.ts` is the app entry (importing it boots Electron) and
  // `updater.ts` reads `electron.app` lazily but registers its handlers behind
  // electron-updater. So the CALL SITES are guarded here, as source text, and
  // the mechanism they must use is exercised by the cases above.
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const offenders = []
  for (const name of ['index.ts', 'updater.ts']) {
    const source = readFileSync(path.join(root, 'src', 'main', name), 'utf8')
    for (const call of ['logEvent(', 'trackedEventOperation(']) {
      let from = source.indexOf(call)
      while (from !== -1) {
        const args = balancedCall(source, from + call.length - 1)
        // `.message` / `.stack` is the text this codebase did not write, and the
        // one thing these two helpers exist to keep out of the file. A derived
        // helper (`errorFactsDetail`, `hostStartFailureDetail`) passes instead.
        if (/\.(message|stack)\b/u.test(args)) offenders.push(`${name}:${String(lineOf(source, from))} ${call.trim()}`)
        from = source.indexOf(call, from + call.length)
      }
    }
  }
  assert.deepEqual(offenders, [], 'an event detail must not name an error message; hand it to reportUnrecordedText instead')
})
