/**
 * The suite-wide stand-down channel: the mode a capsule renders before its
 * session mode has loaded, the wire contract of the claim-change announcement,
 * and the immediate close a foreign announcement triggers. The interval
 * constant is asserted from the source because the hook module imports react,
 * which the Node test bundle does not provide.
 *
 * @module @dsh-app/plugin-ppt/tests/office-standdown
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shouldSelfDisable } from '../src/office-active.ts'
import type { OfficeActiveFormat } from '../src/office-active.ts'
import { OFFICE_ACTIVE_FORMAT } from '../src/office-format.ts'
import { UNLOADED_MODE, capsuleState, resolveCapsuleMode } from '../src/client/capsule-state.ts'
import {
  OFFICE_ACTIVE_CHANGED_EVENT,
  isForeignOfficeActiveChange,
  notifyOfficeActiveChanged,
  parseOfficeActiveChangedDetail,
  subscribeOfficeActiveChanged,
} from '../src/client/office-active-event.ts'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('capsule: an unloaded PPT mode renders as the inactive capsule, not as nothing', () => {
  const unloaded = resolveCapsuleMode(undefined)
  assert.equal(unloaded.loaded, false)
  assert.equal(unloaded.mode, UNLOADED_MODE)
  assert.deepEqual(unloaded.mode, { enabled: false, template: null, updatedAt: null })
  const state = capsuleState({
    sessionBound: true,
    enabled: unloaded.mode.enabled,
    template: unloaded.mode.template,
  })
  assert.equal(state.enabled, false)
  assert.equal(state.label, 'PPT')
  assert.equal(state.caret, false)
  assert.deepEqual(state.toggle, { kind: 'persist', enabled: true })

  const loaded = resolveCapsuleMode({ enabled: true, template: 'dsh-blue', updatedAt: 12 })
  assert.equal(loaded.loaded, true)
  assert.deepEqual(loaded.mode, { enabled: true, template: 'dsh-blue', updatedAt: 12 })
})

test('office active event: the wire contract is stable and only well-formed details pass', () => {
  assert.equal(OFFICE_ACTIVE_CHANGED_EVENT, 'dsh-office-active-changed')
  assert.deepEqual(parseOfficeActiveChangedDetail({ format: 'pdf', updatedAt: 4 }), { format: 'pdf', updatedAt: 4 })
  assert.equal(parseOfficeActiveChangedDetail({ format: null, updatedAt: 4 }), null)
  assert.equal(parseOfficeActiveChangedDetail({ format: 'deck', updatedAt: 4 }), null)
  assert.equal(parseOfficeActiveChangedDetail({ format: 'pdf', updatedAt: 'now' }), null)
  assert.equal(parseOfficeActiveChangedDetail(null), null)
})

test('office stand-down: a foreign announcement closes an active capsule without the poll', () => {
  const original = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = new EventTarget()
  try {
    const own = OFFICE_ACTIVE_FORMAT
    const foreign: OfficeActiveFormat = own === 'pdf' ? 'ppt' : 'pdf'
    let closed = false
    const unsubscribe = subscribeOfficeActiveChanged((detail) => {
      if (!isForeignOfficeActiveChange(detail, own)) return
      const claim = { format: detail.format, sessionId: 's1', updatedAt: detail.updatedAt }
      if (shouldSelfDisable(claim, own, 100)) closed = true
    })
    notifyOfficeActiveChanged(own, 200)
    assert.equal(closed, false, 'our own write cannot have superseded us')
    notifyOfficeActiveChanged(foreign, 200)
    assert.equal(closed, true)
    unsubscribe()
    closed = false
    notifyOfficeActiveChanged(foreign, 300)
    assert.equal(closed, false, 'the unsubscriber stops delivery')
  } finally {
    (globalThis as { window?: unknown }).window = original
  }
})

test('office stand-down: the fallback poll is ten seconds and the change subscription is wired', () => {
  const source = readFileSync(join(pluginRoot, 'src', 'client', 'office-supersede.ts'), 'utf8')
  assert.match(source, /export const OFFICE_ACTIVE_POLL_MS = 10_000/)
  assert.match(source, /setInterval\(run, OFFICE_ACTIVE_POLL_MS\)/)
  assert.match(source, /subscribeOfficeActiveChanged\(onChanged\)/)
  assert.match(source, /document\.addEventListener\('visibilitychange', onVisible\)/)

  const api = readFileSync(join(pluginRoot, 'src', 'client', 'api.ts'), 'utf8')
  assert.match(api, /notifyOfficeActiveChanged\(OFFICE_ACTIVE_FORMAT/)
})
