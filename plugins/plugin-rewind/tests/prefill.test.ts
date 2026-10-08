/**
 * Tests for the composer prefill's one-shot discipline.
 *
 * The recalled text must land in the composer exactly once per recall. Two
 * designs failed this:
 *
 *   1. A component-local ref — reset by a session switch.
 *   2. A module-scope set keyed on a cut id — reset by a PAGE RELOAD, while the
 *      cut itself lived in the durable projection, so the text reappeared on
 *      every reload and stayed there.
 *
 * The prompt now travels in the command RESULT (`rewind.host.done` carries a
 * `prompt` field), so it is delivered once, to the page that performed the
 * recall. These tests pin that: no prefill state lives in the client, and the
 * projection carries no prompt.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const entry = readFileSync(
  fileURLToPath(new URL('../src/client.ts', import.meta.url)),
  'utf8',
)
const icon = readFileSync(
  fileURLToPath(new URL('../src/client/message-action.tsx', import.meta.url)),
  'utf8',
)
const projection = readFileSync(
  fileURLToPath(new URL('../src/projection.ts', import.meta.url)),
  'utf8',
)

test('no prefill bookkeeping lives in the client', () => {
  // Both earlier designs left state behind that a remount or reload reset.
  assert.doesNotMatch(entry, /consumedCuts/)
  assert.doesNotMatch(icon, /consumedCuts/)
  assert.doesNotMatch(icon, /consumedCut/)
})

test('the projection carries no prefill text — that is what made it repeat', () => {
  // Durable state replays on reload; a prompt kept there came back forever.
  assert.doesNotMatch(projection, /lastCut/)
  assert.doesNotMatch(projection, /cutCount/)
  assert.doesNotMatch(projection, /CutRecord/)
  // The prefill TEXT key specifically. `prompt` is now also a node FLAG (whether a
  // node is a user prompt), so a bare `prompt:` test would flag the flag; what
  // must not exist is a field carrying the recalled message's text.
  assert.doesNotMatch(projection, /prefill/i)
  assert.doesNotMatch(projection, /prompt:\s*previewText|recalledText|originalText/)
})

test('the prefill reads the prompt out of the command result', () => {
  assert.match(entry, /function recalledPrompt/)
  assert.match(entry, /JSON\.parse\(raw\)/)
  assert.match(entry, /prefillRecalled\(ctx, target, outcome\.text\)/)
})

test('the prefill never discards text the user typed', () => {
  // `setDraft` replaces the whole draft, so any OTHER text still refuses.
  assert.match(entry, /if \(draft !== undefined && draft\.trim\(\) !== ''\) return 'the composer already holds text'/)
})

test('a composer already holding THIS text is success, not a failure', () => {
  // Two writers race on one recall — the icon path (from the command result) and
  // the event observer (from `command/done`) — and either can arrive first.
  // Marking the recall handled cannot win that race, because the mark is only
  // made once the RPC returns. So the write is idempotent: the text being in place
  // already IS the outcome. Measured on a real machine as a red
  // "the composer already holds text" on a recall that had just succeeded.
  assert.match(entry, /if \(draft !== undefined && draft === prompt\) return undefined/)
  // And the `=== prompt` check must come BEFORE the non-empty refusal, or the
  // idempotent case would still be rejected.
  const idempotent = entry.indexOf('draft === prompt')
  const refuses = entry.indexOf("return 'the composer already holds text'")
  assert.ok(idempotent !== -1 && refuses !== -1 && idempotent < refuses, 'the idempotent check must precede the refusal')
})

test('a busy composer is waited for, not given up on', () => {
  // A hand-typed `/rewind n` submits THROUGH the composer, so its result arrives
  // while the phase machine is `submitting`. Refusing there is why that path never
  // prefilled. The write is deferred to the settle instead, with a bounded wait.
  assert.match(entry, /function deferUntilIdle/)
  assert.match(entry, /return deferUntilIdle\(materialized, setDraft as \(text: string\) => void, prompt\)/)
  assert.match(entry, /input\.subscribe\(settle\)/)
  assert.match(entry, /SETTLE_TIMEOUT_MS/)
  assert.match(entry, /the composer never settled/)
})

test('the host sends the prompt with the success answer', () => {
  const host = readFileSync(
    fileURLToPath(new URL('../src/index.ts', import.meta.url)),
    'utf8',
  )
  // The prompt rides the coded payload, together with the file revert's tally:
  // the command registry keeps ONLY `kind`/`text`/`sourceEventSeq` on a result
  // (`dsh-commands/lib/types/index.js` `normalizeResult`), so a sibling field
  // would be dropped without a word.
  assert.match(host, /text: coded\('rewind\.host\.done', \{ n: parsed\.n \}, undefined, \{/)
  assert.match(host, /prompt: plan\.prompt/)
})
