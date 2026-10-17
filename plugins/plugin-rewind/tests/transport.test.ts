/**
 * A refused transport call must not read as a missing kernel feature.
 *
 * Measured on a real machine: a released session reference made the recall icon
 * report 「撤回功能当前不可用（缺少必要的内核能力）」, which sends the user looking
 * for a kernel capability instead of reopening the session. The kernel's own
 * message is the honest answer; the capability sentence is reserved for a
 * service that really is absent (`remote === undefined`, covered by the client
 * entry, not this module).
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { en, zh } from '../src/client/locales.ts'
import { transportDetail, transportFailure, transportNote } from '../src/client/transport.ts'
import type { Translate } from '../src/client/messages.ts'

/** The locale runtime's own interpolation, reproduced. */
const makeT = (dict: Record<string, string>): Translate => (key, params) => {
  const template = dict[key] ?? String(key)
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => (name in params ? String(params[name]) : match))
}

test('a refusal carrying a message becomes the transport sentence', () => {
  assert.deepEqual(
    transportFailure({ message: '  Session reference "s-1" is released  ' }),
    { ok: false, code: 'rewind.error.transport', params: { detail: 'Session reference "s-1" is released' } },
  )
})

test('a refusal with no message still falls back to the capability sentence', () => {
  for (const value of [undefined, null, {}, { message: '' }, { message: '   ' }, { message: 42 }]) {
    assert.deepEqual(transportFailure(value), { ok: false, code: 'rewind.error.unavailable' })
  }
})

test('the prose path says the request never reached the kernel', () => {
  const t = makeT(zh)
  assert.equal(transportNote(t, { message: 'session/writer-held' }), '撤回请求没能送到内核：session/writer-held')
  assert.equal(transportNote(t, undefined), zh['rewind.error.unavailable'])
})

test('both dictionaries carry the transport sentence with its slot', () => {
  for (const dict of [zh, en]) {
    assert.match(dict['rewind.error.transport'], /\{detail\}/u)
  }
  assert.doesNotMatch(zh['rewind.error.transport'], /内核能力/u, 'the capability claim belongs to the other key')
  assert.equal(transportDetail({ message: 'x'.repeat(4) }), 'xxxx')
})
