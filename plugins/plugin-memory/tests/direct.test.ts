/**
 * Unit tests for the direct-LLM channel (llm-direct), prefix repair, and the
 * audit store. Pure functions plus a stubbed `ctx.llm.stream` — no network.
 *
 * @module @dsh-app/plugin-memory/tests/direct
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scratchRoot } from './scratch.ts'
import { MAX_DIRECT_ERROR_CHARS, extractJson, resolveLlm, safeErrorText, streamJson } from '../src/llm-direct.ts'
import { repairDoublePrefix, stripEntryPrefix } from '../src/memory-store.ts'
import { buildCuratePrompt } from '../src/curator.ts'

test('extractJson parses bare objects', () => {
  const result = extractJson('{"entries": []}')
  assert.equal(result.ok, true)
  assert.deepEqual((result as { ok: true, value: unknown }).value, { entries: [] })
})

test('extractJson tolerates fences and chatter', () => {
  const result = extractJson('Here you go:\n```json\n{"entries": [{"a": 1}]}\n```\nDone.')
  assert.equal(result.ok, true)
  assert.deepEqual((result as { ok: true, value: unknown }).value, { entries: [{ a: 1 }] })
})

test('extractJson tolerates arrays and trailing chatter', () => {
  const result = extractJson('[{"a": 1}] hope this helps')
  assert.equal(result.ok, true)
  assert.deepEqual((result as { ok: true, value: unknown }).value, [{ a: 1 }])
})

test('extractJson rejects non-JSON', () => {
  assert.equal(extractJson('no json here').ok, false)
  assert.equal(extractJson('').ok, false)
  assert.equal(extractJson('{"unclosed": true').ok, false)
})

test('extractJson falls through to a later fence when the first quotes data', () => {
  // The curator asks for verbatim "- [category] date" lines, so an answer that
  // quotes the file before answering opens with brackets that are not JSON.
  const answer = [
    '先贴一下待合并的原文行：',
    '```text',
    '- [fact] 2026-09-07 ffmpeg 探针必须先解析 stderr',
    '- [lesson] 2026-09-06 镜像源失败要重试',
    '```',
    '```json',
    '{"edits": [{"op": "delete", "lines": ["- [lesson] 2026-09-06 镜像源失败要重试"]}]}',
    '```',
  ].join('\n')
  const result = extractJson(answer)
  assert.equal(result.ok, true)
  assert.deepEqual((result as { ok: true, value: unknown }).value, {
    edits: [{ op: 'delete', lines: ['- [lesson] 2026-09-06 镜像源失败要重试'] }],
  })
})

test('extractJson walks past a balanced non-JSON fragment before the object', () => {
  // Unfenced shape: the bracketed note balances, so the first candidate is
  // "brackets match but this is not JSON" — the object comes after it.
  const result = extractJson('[note: 以下是策展结果]\n{"edits": []}')
  assert.equal(result.ok, true)
  assert.deepEqual((result as { ok: true, value: unknown }).value, { edits: [] })
})

test('extractJson tries more candidates without loosening what counts as JSON', () => {
  // Trying every candidate must not become a repair pass: a malformed object
  // after the junk stays malformed (no eval, no bare keys, no trailing comma).
  assert.equal(extractJson('see [x] then {"a": 1,}').ok, false)
  assert.equal(extractJson('see [x] then {a: 1}').ok, false)
  assert.equal(extractJson('see [x] then [1, 2,]').ok, false)
})

test('stripEntryPrefix removes the stamped prefix', () => {
  assert.equal(stripEntryPrefix('- [lesson] 2026-09-06 some fact'), 'some fact')
  assert.equal(stripEntryPrefix('  - [fact] 2026-01-02 padded  '), 'padded')
})

test('stripEntryPrefix leaves plain content alone', () => {
  assert.equal(stripEntryPrefix('plain content'), 'plain content')
  assert.equal(stripEntryPrefix('- not a prefix line'), '- not a prefix line')
})

test('repairDoublePrefix collapses nested prefixes', () => {
  const { fixed, count } = repairDoublePrefix('- [lesson] 2026-09-06 - [lesson] 2026-09-06 real content\n- [fact] 2026-09-07 clean\n')
  assert.equal(count, 1)
  assert.equal(fixed, '- [lesson] 2026-09-06 real content\n- [fact] 2026-09-07 clean\n')
})

test('repairDoublePrefix collapses redundant bare-date echoes', () => {
  const { fixed, count } = repairDoublePrefix('- [fact] 2026-08-28 2026-08-28 skills work\n- [fact] 2026-09-07 clean\n')
  assert.equal(count, 1)
  assert.equal(fixed, '- [fact] 2026-08-28 skills work\n- [fact] 2026-09-07 clean\n')
})

test('repairDoublePrefix keeps a DIFFERING inner date (it is content)', () => {
  const text = '- [decision] 2026-08-30 2026-09-02 设置页重构定案\n'
  const { fixed, count } = repairDoublePrefix(text)
  assert.equal(count, 0)
  assert.equal(fixed, text)
})

test('repairDoublePrefix only strips when the echoed date matches exactly', () => {
  // Same date -> the echo is provably redundant, one copy is dropped.
  const same = repairDoublePrefix('- [fact] 2026-09-10 2026-09-10 body\n')
  assert.equal(same.count, 1)
  assert.equal(same.fixed, '- [fact] 2026-09-10 body\n')

  // Different date -> the inner date is content, nothing is touched.
  const diff = repairDoublePrefix('- [fact] 2026-09-10 2026-11-02 deadline\n')
  assert.equal(diff.count, 0)
  assert.equal(diff.fixed, '- [fact] 2026-09-10 2026-11-02 deadline\n')

  // A date that merely STARTS the body but is not the outer date is content too.
  const other = repairDoublePrefix('- [fact] 2026-09-10 2026-09-11 later\n')
  assert.equal(other.count, 0)
})

test('repairDoublePrefix leaves clean files byte-identical', () => {
  const text = '- [fact] 2026-09-07 clean\n- [lesson] 2026-09-06 also clean\n'
  const { fixed, count } = repairDoublePrefix(text)
  assert.equal(count, 0)
  assert.equal(fixed, text)
})

test('recordLlmAudit round-trips newest-first', () => {
  const root = scratchRoot('dshm-audit-')
  assert.deepEqual(root.llmAudit(), [])
  root.recordLlmAudit({ at: 1000, source: 'curate', session: 'abc123', status: 'ok', inputTokens: 100, outputTokens: 20, durationMs: 500 })
  root.recordLlmAudit({ at: 2000, source: 'curate', session: 'def456', status: 'error', inputTokens: 90, outputTokens: 10, durationMs: 400, error: 'unparseable JSON response' })
  const runs = root.llmAudit()
  assert.equal(runs.length, 2)
  assert.equal(runs[0]!.session, 'def456')
  assert.equal(runs[1]!.session, 'abc123')
  assert.equal(runs[0]!.error, 'unparseable JSON response')
})

test('buildCuratePrompt bans work logs and spells out the JSON contract', () => {
  const { system, user } = buildCuratePrompt('### some-topic [lesson] (updated 2026-09-06)\ntwo cards')
  // The work-log class the curator must delete (the prompt is now the only
  // carrier of the output contract — outputSchema is gone).
  assert.match(system, /work logs/i)
  assert.match(system, /commit\s+ids/i)
  assert.match(system, /session did/i)
  assert.match(system, /Reply with ONE JSON object/)
  assert.ok(system.includes('"edits"'))
  assert.ok(system.includes('preference|convention|decision|lesson|fact'))
  // Edits cite cards by topic key, with the three ops named.
  assert.ok(system.includes('"merge"'))
  assert.ok(system.includes('"delete"'))
  assert.ok(system.includes('"rewrite"'))
  assert.ok(system.includes('"topics"'))
  assert.match(user, /--- Memory store/)
  assert.match(user, /two cards/)
})

test('buildCuratePrompt: the brief carries the consolidation jobs, not only the delete list', () => {
  const { system } = buildCuratePrompt('### some-topic [lesson] (updated 2026-09-06)\ntwo cards')
  // Deleting work logs is half the job: a lesson buried in one has to survive
  // as a rule, two cards that disagree must not keep contradicting each other,
  // and a rewrite may not invent what the cards never said.
  assert.match(system, /REWRITE it as that lesson/, 'generalization instead of losing the lesson')
  assert.match(system, /LATER-updated one is the current state/, 'contradictions resolve to the later truth')
  assert.match(system, /never fill a gap from your own knowledge/, 'grounding: no invented detail')
  assert.match(system, /must stand alone/, 'a card has to work without the conversation')
  assert.match(system, /problem→solution pairs/, 'the preserve list names what outlives the session')
  assert.match(system, /progress snapshots/, 'and the discard list names progress state, not just logs')
})

function stubLlm(chunks: Array<Record<string, unknown>>): never {
  return {
    stream: async function* () {
      for (const chunk of chunks) yield chunk
    },
  } as never
}

const SPEC = {
  route: { provider: 'p', model: 'm' },
  system: 'sys',
  user: 'usr',
}

test('resolveLlm rejects a context without the service', () => {
  assert.throws(() => resolveLlm({}), /ctx\.llm unavailable/)
  assert.throws(() => resolveLlm(undefined), /ctx\.llm unavailable/)
})

test('streamJson keeps the runtime receiver (this-bound call)', async () => {
  // The real LlmRuntime.stream reads instance state; a detached call throws
  // "Cannot read properties of undefined (reading 'streamWithRegistration')".
  const runtime = {
    marker: 42,
    async *stream(this: { marker: number }, _options: unknown): AsyncIterable<Record<string, unknown>> {
      if (this?.marker !== 42) throw new TypeError("Cannot read properties of undefined (reading 'streamWithRegistration')");
      yield { type: 'text-delta', index: 0, text: '{"entries": []}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const result = await streamJson(runtime as never, SPEC);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.parsed, { entries: [] });
});

test('streamJson accumulates deltas and parses', async () => {
  const result = await streamJson(stubLlm([
    { type: 'text-delta', index: 0, text: '{"entries"' },
    { type: 'text-delta', index: 0, text: ': []}' },
    { type: 'usage', usage: { inputTokens: 50, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]), SPEC)
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.parsed, { entries: [] })
  assert.equal(result.inputTokens, 50)
  assert.equal(result.outputTokens, 5)
})

test('streamJson reports bad-json as error', async () => {
  const result = await streamJson(stubLlm([
    { type: 'text-delta', index: 0, text: 'not json at all' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]), SPEC)
  assert.equal(result.status, 'error')
  assert.match(result.error ?? '', /unparseable/)
})

test('streamJson surfaces error finish', async () => {
  const result = await streamJson(stubLlm([
    { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } },
  ]), SPEC)
  assert.equal(result.status, 'error')
  assert.match(result.error ?? '', /boom/)
})

test('streamJson surfaces abort', async () => {
  const result = await streamJson(stubLlm([
    { type: 'finish', reason: { kind: 'aborted', failure: { message: 'x' } } },
  ]), SPEC)
  assert.equal(result.status, 'aborted')
})

test('streamJson times out a hung stream and leaves the serial queue usable', async () => {
  let opened = 0
  const hungLlm = {
    async *stream(): AsyncIterable<Record<string, unknown>> {
      opened += 1
      // A provider that opened the stream and never closed it: no chunk, no
      // finish, no throw — the promise this call returns never settles.
      await new Promise<never>(() => { /* never settles */ })
    },
  }
  const startedAt = Date.now()
  const timedOut = await streamJson(hungLlm as never, { ...SPEC, timeoutMs: 120 })
  assert.equal(timedOut.status, 'error')
  assert.match(timedOut.error ?? '', /timeout/)
  assert.ok(Date.now() - startedAt >= 60, 'the deadline was actually waited for')
  assert.equal(opened, 1)
  // The queue is free again: the hung call settled as a failure instead of
  // blocking every later maintenance call behind a promise that never settles.
  const after = await streamJson(stubLlm([
    { type: 'text-delta', index: 0, text: '{"entries": []}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]), SPEC)
  assert.equal(after.status, 'ok')
  assert.deepEqual(after.parsed, { entries: [] })
})

test('streamJson keeps a caller abort distinct from our timeout', async () => {
  const controller = new AbortController()
  const aborting = {
    async *stream(): AsyncIterable<Record<string, unknown>> {
      controller.abort()
      throw Object.assign(new Error('aborted by caller'), { name: 'AbortError' })
    },
  }
  const result = await streamJson(aborting as never, { ...SPEC, signal: controller.signal, timeoutMs: 5_000 })
  assert.equal(result.status, 'aborted')
  assert.equal(result.error, 'aborted')
})

// --- K1: a failed call keeps what it cost and says why --------------------------
//
// The audit that motivated these: 25 days of llm-audit.json held 22 errors and
// 3 aborts, every one of them with 0 / 0 tokens and no cause. An answer that
// is not JSON is the most expensive failure the curator has (up to 8000 output
// tokens), and it was booked as free.

test('streamJson keeps the tokens of a call that ended in unparseable JSON', async () => {
  const result = await streamJson(stubLlm([
    { type: 'text-delta', index: 0, text: 'Sure! Here is my plan:' },
    { type: 'usage', usage: { inputTokens: 4321, outputTokens: 2765 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]), SPEC)
  assert.equal(result.status, 'error')
  assert.match(result.error ?? '', /unparseable/)
  assert.equal(result.inputTokens, 4321)
  assert.equal(result.outputTokens, 2765)
})

test('streamJson keeps the tokens a timed-out attempt had already been billed', async () => {
  const billedThenHung = {
    async *stream(): AsyncIterable<Record<string, unknown>> {
      yield { type: 'usage', usage: { inputTokens: 8_000, outputTokens: 120 } }
      await new Promise<never>(() => { /* never settles */ })
    },
  }
  const result = await streamJson(billedThenHung as never, { ...SPEC, timeoutMs: 120 })
  assert.equal(result.status, 'error')
  assert.match(result.error ?? '', /timeout/)
  assert.equal(result.inputTokens, 8_000)
  assert.equal(result.outputTokens, 120)
})

test('streamJson sums what rate-limited attempts spent and flags the exhaustion', { timeout: 30_000 }, async (t) => {
  // The real backoff is 1 s + 2 s; a mocked clock makes the retries instant.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let attempts = 0
  const limited = {
    async *stream(): AsyncIterable<Record<string, unknown>> {
      attempts += 1
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'too many requests', status: 429 } } }
    },
  }
  const run = streamJson(limited as never, { ...SPEC, timeoutMs: 10 ** 9 })
  let done = false
  void run.then(() => { done = true }, () => { done = true })
  for (let i = 0; i < 60 && !done; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
    t.mock.timers.tick(3_000)
  }
  const result = await run
  assert.equal(attempts, 3, 'the initial attempt plus two retries')
  assert.equal(result.status, 'error')
  assert.equal(result.error, 'rate limited')
  assert.equal(result.rateLimited, true, 'the caller can tell this failure from the store’s own')
  assert.equal(result.inputTokens, 300, 'every attempt re-sent the whole prompt — that is three prompts billed')
})

test('streamJson redacts a credential the provider echoes in its error', async () => {
  const echoed = 'Ab3'.repeat(16)
  const result = await streamJson(stubLlm([
    { type: 'finish', reason: { kind: 'error', failure: { message: `401 incorrect api key sk-abcdefghijklmnopqrstuvwx (${echoed})` } } },
  ]), SPEC)
  assert.equal(result.status, 'error')
  assert.match(result.error ?? '', /401 incorrect api key/, 'the cause is still readable')
  assert.ok(!result.error!.includes('sk-abcdefghijklmnopqrstuvwx'))
  assert.ok(!result.error!.includes(echoed))
})

test('safeErrorText keeps an ordinary cause intact', () => {
  for (const cause of [
    'timeout: stream did not finish within 180000ms',
    'unparseable JSON response',
    'llm error: model "deepseek-chat" not found (HTTP 404, request id: 4b0f1c2e-8d7a-4b3e-9f10-11a2b3c4d5e6)',
  ]) {
    assert.equal(safeErrorText(cause), cause)
  }
})

test('safeErrorText redacts the credential shapes a provider error carries', () => {
  const opaque = 'Ab3'.repeat(16)
  const cases: Array<[string, RegExp]> = [
    // A query-string credential: the key name and the rest of the URL stay.
    [`retry https://api.example.com/v1?key=${opaque}&mode=x`, /^retry https:\/\/api\.example\.com\/v1\?key=\[redacted\]&mode=x$/],
    [`retry https://api.example.com/v1?access_token=${opaque}`, /\?access_token=\[redacted\]$/],
    [`rejected (bearer ${opaque})`, /^rejected \(bearer \[redacted\]\)$/],
    [`401 incorrect api key sk-abcdefghijklmnopqrstuvwx`, /^401 incorrect api key \[redacted\]$/],
    [`proxy https://alice:${opaque}@proxy.example/y`, /^proxy https:\/\/\[redacted\]@proxy\.example\/y$/],
    [`x-api-key: ${opaque}`, /^x-api-key: \[redacted\]$/],
    [`password=${opaque}`, /^password=\[redacted\]$/],
    // A raw key with no name in sight: a base64 run, a JWT, bare hex.
    [`rejected ${opaque}`, /^rejected \[redacted\]$/],
    [`rejected eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c`, /^rejected \[redacted\]$/],
    [`rejected ${'3f2a9c1e7b5d8046a1c9e2f4b7d60935'.repeat(2)}`, /^rejected \[redacted\]$/],
  ]
  for (const [cause, expected] of cases) {
    const safe = safeErrorText(cause)
    assert.match(safe, expected, cause)
    assert.ok(!safe.includes(opaque) && !safe.includes('sk-abcdefghijklmnopqrstuvwx'), cause)
  }
  // An ordinary long identifier is not a secret and stays readable.
  assert.equal(
    safeErrorText('llm error: stream_did_not_finish_within_the_allocated_deadline_window'),
    'llm error: stream_did_not_finish_within_the_allocated_deadline_window',
  )
})

test('safeErrorText caps the cause at the audit width and is idempotent', () => {
  assert.equal(MAX_DIRECT_ERROR_CHARS, 200)
  const capped = safeErrorText('x'.repeat(900))
  assert.equal(capped.length, MAX_DIRECT_ERROR_CHARS)
  const once = safeErrorText(`denied: token=${'Ab3'.repeat(20)}`)
  assert.equal(safeErrorText(once), once, 're-running a redacted cause changes nothing (the curator logs the same string it audits)')
})
