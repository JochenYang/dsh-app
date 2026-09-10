/**
 * Unit tests for the direct-LLM channel (llm-direct), prefix repair, and the
 * audit store. Pure functions plus a stubbed `ctx.llm.stream` — no network.
 *
 * @module @dsh-app/plugin-memory/tests/direct
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractJson, resolveLlm, streamJson } from '../src/llm-direct.ts'
import { MemoryRoot, repairDoublePrefix, stripEntryPrefix } from '../src/memory-store.ts'
import { buildDistillPrompt } from '../src/distiller.ts'

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
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-audit-')))
  assert.deepEqual(root.llmAudit(), [])
  root.recordLlmAudit({ at: 1000, source: 'distill', session: 'abc123', status: 'ok', inputTokens: 100, outputTokens: 20, durationMs: 500 })
  root.recordLlmAudit({ at: 2000, source: 'distill', session: 'def456', status: 'error', inputTokens: 90, outputTokens: 10, durationMs: 400, error: 'unparseable JSON response' })
  const runs = root.llmAudit()
  assert.equal(runs.length, 2)
  assert.equal(runs[0]!.session, 'def456')
  assert.equal(runs[1]!.session, 'abc123')
  assert.equal(runs[0]!.error, 'unparseable JSON response')
})

test('buildDistillPrompt bans work logs and repo restatements', () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-prompt-')))
  const { system } = buildDistillPrompt('[user] hello', undefined, root)
  // The false-positive classes this prompt must name explicitly.
  assert.match(system, /work log/i)
  assert.match(system, /commit ids/i)
  assert.match(system, /different conversation/i)
  assert.match(system, /restating project code or docs/i)
})

test('buildDistillPrompt splits system/user and bans prefixes', () => {
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-prompt-')))
  const { system, user } = buildDistillPrompt('[user] hello', undefined, root)
  assert.match(system, /JSON ONLY/)
  assert.match(system, /no "- \[category\] date" prefix/)
  assert.match(user, /\[user\] hello/)
  assert.match(user, /No workspace/)
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
