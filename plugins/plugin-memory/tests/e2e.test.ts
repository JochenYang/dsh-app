/**
 * End-to-end walk of the plugin's real modules — no mocks, no stubs.
 *
 * Where the unit suites pin one function each, these drive the actual chain a
 * running plugin walks: write to a store → route it → decide whether the
 * background pass stands down → pick what reaches the prompt → parse what the
 * model answers. Every assertion here would fail if the corresponding wiring
 * were broken between two modules, which per-function tests cannot see.
 *
 * @module @dsh-app/plugin-memory/tests/e2e
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRoot, normalizeForMatch, projectSlug } from '../src/memory-store.ts'
import { buildDistillPrompt, resolveScope } from '../src/distiller.ts'
import { selectBalanced } from '../src/prompt.ts'
import { extractJson } from '../src/llm-direct.ts'

const fresh = (): MemoryRoot => new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-e2e-')))

test('e2e: a workspace write lands in the project file and never in the global one', () => {
  const root = fresh()
  const cwd = 'D:/codes/some-project'
  root.projectFor(cwd).append('lesson', 'project-scoped knowledge')
  root.global.append('preference', 'cross-workspace preference')

  const projectFile = join(root.dir, 'projects', projectSlug(cwd), 'memory.md')
  assert.ok(existsSync(projectFile), 'the workspace write created its project file')
  assert.ok(readFileSync(projectFile, 'utf8').includes('project-scoped knowledge'))
  const globalText = readFileSync(join(root.dir, 'memory.md'), 'utf8')
  assert.ok(globalText.includes('cross-workspace preference'))
  assert.ok(!globalText.includes('project-scoped knowledge'), 'the project write must not leak')

  // Scope comes from the session, never from the model's own tagging.
  assert.equal(resolveScope(cwd), 'project')
  assert.equal(resolveScope(undefined), 'global')
})

test('e2e: own-write → stand down → background pass consumes → next save re-arms', () => {
  const root = fresh()
  const id = 'session-e2e'
  assert.equal(root.savedSinceDistill(id), false, 'nothing saved yet')

  root.recordDirectSave(id)
  assert.equal(root.savedSinceDistill(id), true, 'the session curated its own memory')
  root.recordDirectSave(id)
  assert.equal(root.savedSinceDistill(id), true, 'the rule holds across repeated saves')

  root.advanceDistill(id, 7)
  assert.equal(root.savedSinceDistill(id), false, 'a completed pass consumes the delta')
  assert.equal(root.distillSeqOf(id), 7)

  root.recordDirectSave(id)
  assert.equal(root.savedSinceDistill(id), true, 'the next save re-arms the rule')
  assert.equal(root.distillSeqOf(id), 7, 'and an own-write never rewinds the cursor')
})

test('e2e: an over-long pin cannot evict the pins behind it, and nothing unbounded is injected', () => {
  const long = `- [preference] 2026-01-01 ${'x'.repeat(160)}`
  const newer = '- [preference] 2026-01-02 newer-pin'
  const text = [long, newer, '- [fact] 2026-01-03 ordinary-entry'].join('\n')
  const pinned = new Set([normalizeForMatch('x'.repeat(160)), normalizeForMatch('newer-pin')])

  const sel = selectBalanced(text, 200, pinned)
  assert.ok(sel.selected.some(line => line.includes('newer-pin')), 'the newer pin survives')
  for (const line of sel.selected) {
    assert.ok(line.length <= 200 || line.endsWith('…'), `injected line is bounded: ${line.slice(0, 40)}…`)
  }
})

test('e2e: cyrillic and kana content stays matchable end to end', () => {
  const cyrillic = 'резервное копирование'
  const kana = 'ありがとう ございます'
  assert.equal(normalizeForMatch(cyrillic), 'резервноекопирование')
  assert.equal(normalizeForMatch(kana), 'ありがとうございます')

  const root = fresh()
  root.global.append('lesson', cyrillic)
  // The whole point: dedupe (and therefore forget/pin) recognises it back.
  assert.equal(root.global.hasContent(cyrillic), true)
  assert.equal(root.global.hasContent(kana), false, 'different content is still different')
})

test('e2e: the distill prompt carries no scope field and still shows both files', () => {
  const root = fresh()
  root.global.append('preference', 'a global preference')
  const { system, user } = buildDistillPrompt('[user] hello', 'D:/proj', root)
  assert.ok(!system.includes('"scope"'), 'no scope field for the model to fill in')
  assert.ok(/host decides/i.test(system), 'the prompt says who decides')
  assert.ok(user.includes('a global preference'), 'the global file is still shown as context')

  const none = buildDistillPrompt('[user] hello', undefined, root)
  assert.ok(!/propose scope/i.test(none.user), 'a no-workspace session is told, not asked')
})

test('e2e: an answer that quotes cited lines before its JSON still parses', () => {
  // The real curator shape: the model restates the lines it cites (brackets
  // included) and only then emits the edit payload.
  const answer = [
    'Here is what I merged:',
    '```',
    '- [lesson] 2026-01-01 something cited verbatim',
    '```',
    '```json',
    '{"edits":[{"op":"delete","lines":["- [lesson] 2026-01-01 something cited verbatim"]}]}',
    '```',
  ].join('\n')
  const parsed = extractJson(answer)
  assert.equal(parsed.ok, true, 'a later fence is tried, not only the first')
  assert.ok(Array.isArray((parsed as { value: { edits?: unknown } }).value.edits), 'yields the real payload')
})
