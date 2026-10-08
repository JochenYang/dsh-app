/**
 * Unit tests for the host-code resolver (`src/client/messages.ts`).
 *
 * The host sends a coded payload instead of prose, so this resolver is the only
 * place a user-visible sentence is produced. Its two obligations are pinned
 * here: render a known code through the dictionary, and never mangle text that
 * is not a coded payload (the kernel's own commands answer with plain strings).
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { hostCode, hostMessage } from '../src/client/messages.ts'
import type { RewindKey } from '../src/client/locales.ts'

/** A stand-in `t` seat that echoes the key and its params. */
function t(key: RewindKey, params?: Readonly<Record<string, string | number>>): string {
  const bag = params === undefined
    ? ''
    : `(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')})`
  return `${key}${bag}`
}

test('a known code renders through the dictionary with its params', () => {
  const raw = JSON.stringify({ code: 'rewind.host.done', params: { n: 3 } })
  assert.equal(hostMessage(raw, t), 'rewind.host.done(n=3)')
})

test('an error code renders with the values the host supplied', () => {
  const raw = JSON.stringify({ code: 'rewind.host.outOfRange', params: { available: 2, requested: 5 } })
  assert.equal(hostMessage(raw, t), 'rewind.host.outOfRange(available=2,requested=5)')
})

test('an unknown code falls back to the host diagnostic, then to the raw text', () => {
  assert.equal(
    hostMessage(JSON.stringify({ code: 'rewind.host.future', text: 'diagnostic' }), t),
    'diagnostic',
  )
  assert.equal(
    hostMessage(JSON.stringify({ code: 'rewind.host.future' }), t),
    JSON.stringify({ code: 'rewind.host.future' }),
  )
})

test('plain text is passed through untouched', () => {
  // The kernel's own commands answer with ordinary strings; the renderer must
  // not mangle them.
  assert.equal(hostMessage('Compacted 12 history items.', t), 'Compacted 12 history items.')
  assert.equal(hostMessage('42', t), '42')
  assert.equal(hostMessage('{"not":"coded"}', t), '{"not":"coded"}')
})

test('an empty or absent text renders nothing', () => {
  assert.equal(hostMessage(undefined, t), undefined)
  assert.equal(hostMessage('', t), undefined)
})

test('a params value naming another code resolves one level deep', () => {
  const raw = JSON.stringify({ code: 'rewind.host.rejected', params: { detail: 'rewind.host.empty' } })
  assert.equal(hostMessage(raw, t), 'rewind.host.rejected(detail=rewind.host.empty)')
})

test('numeric params are preserved rather than treated as codes', () => {
  const raw = JSON.stringify({ code: 'rewind.host.list', params: { count: 7 } })
  assert.equal(hostMessage(raw, t), 'rewind.host.list(count=7)')
})

// --- hostCode: the component-facing half of the same resolver ---

test('hostCode hands back a known code and its params', () => {
  const answered = hostCode(JSON.stringify({ code: 'rewind.host.busy' }))
  assert.equal(answered?.code, 'rewind.host.busy')
  const ranged = hostCode(JSON.stringify({ code: 'rewind.host.outOfRange', params: { available: 2, requested: 5 } }))
  assert.deepEqual(ranged, { code: 'rewind.host.outOfRange', params: { available: 2, requested: 5 } })
})

test('hostCode returns undefined for nothing to report', () => {
  assert.equal(hostCode(undefined), undefined)
  assert.equal(hostCode(''), undefined)
})

test('hostCode maps an unknown code onto the dictionary and keeps the diagnostic', () => {
  // No blank sentence: the component renders `rewind.host.rejected` with the
  // host's own English text as `detail`, which is the honest fallback for a
  // newer host whose code this build does not own.
  const answered = hostCode(JSON.stringify({ code: 'rewind.host.future', text: 'diagnostic' }))
  assert.deepEqual(answered, { code: 'rewind.host.rejected', params: { detail: 'diagnostic' } })
  const bare = hostCode(JSON.stringify({ code: 'rewind.host.future' }))
  assert.deepEqual(bare, { code: 'rewind.host.rejected', params: { detail: 'rewind.host.future' } })
})

test('hostCode drops a params value a sentence cannot interpolate', () => {
  const answered = hostCode(JSON.stringify({
    code: 'rewind.host.rejected',
    params: { detail: 'bad thing', nested: { deep: 1 }, list: [1, 2], flag: true, nothing: null },
  }))
  assert.deepEqual(answered, { code: 'rewind.host.rejected', params: { detail: 'bad thing' } })
})

test('hostCode passes non-JSON text through as a diagnostic, not as a code', () => {
  // A plain string is never a coded payload; it is still worth showing.
  assert.deepEqual(hostCode('busy'), { code: 'rewind.host.rejected', params: { detail: 'busy' } })
})
