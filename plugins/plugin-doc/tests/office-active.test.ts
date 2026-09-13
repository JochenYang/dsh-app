/**
 * The shared office active-format claim: parsing, the one-way stand-down rule
 * (no mutual-close loop) and the monotonic claim/release file I/O. The rule is
 * what keeps two office plugins from closing each other, so it is asserted
 * directly rather than only through the browser poll.
 *
 * @module @dsh-app/plugin-doc/tests/office-active
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseOfficeActive, shouldSelfDisable } from '../src/office-active.ts'
import { OFFICE_ACTIVE_FORMAT } from '../src/office-format.ts'
import { claimOfficeActive, officeActiveFilePath, readOfficeActive, releaseOfficeActive } from '../src/office-active-store.ts'

test('office active: parse rejects malformed claims and accepts none or a known format', () => {
  assert.deepEqual(parseOfficeActive({ format: 'ppt', sessionId: 's1', updatedAt: 4 }), { format: 'ppt', sessionId: 's1', updatedAt: 4 })
  assert.deepEqual(parseOfficeActive({ format: null, sessionId: 's1', updatedAt: 4 }), { format: null, sessionId: 's1', updatedAt: 4 })
  assert.equal(parseOfficeActive({ format: 'deck', sessionId: 's1', updatedAt: 4 }), null)
  assert.equal(parseOfficeActive({ format: 'word', sessionId: '', updatedAt: 4 }), null)
  assert.equal(parseOfficeActive({ format: 'word', sessionId: 's1', updatedAt: 'now' }), null)
  assert.equal(parseOfficeActive(null), null)
})

test('office active: only a later foreign claim triggers a stand-down', () => {
  const foreign = { format: 'pdf', sessionId: 's1', updatedAt: 20 } as const
  assert.equal(OFFICE_ACTIVE_FORMAT, 'word')
  assert.equal(shouldSelfDisable(foreign, OFFICE_ACTIVE_FORMAT, 10), true)
  // Equal or older foreign claims never win, so the losing writer cannot ping back.
  assert.equal(shouldSelfDisable(foreign, OFFICE_ACTIVE_FORMAT, 20), false)
  assert.equal(shouldSelfDisable(foreign, OFFICE_ACTIVE_FORMAT, 30), false)
  assert.equal(shouldSelfDisable(foreign, OFFICE_ACTIVE_FORMAT, null), false)
  assert.equal(shouldSelfDisable({ format: 'word', sessionId: 's1', updatedAt: 20 }, OFFICE_ACTIVE_FORMAT, 10), false)
  assert.equal(shouldSelfDisable({ format: null, sessionId: 's1', updatedAt: 20 }, OFFICE_ACTIVE_FORMAT, 10), false)
  assert.equal(shouldSelfDisable(null, OFFICE_ACTIVE_FORMAT, 10), false)
})

test('office active store: claims are monotonic and release only clears our own claim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doc-active-test-'))
  try {
    const file = officeActiveFilePath(dir)
    assert.deepEqual(await claimOfficeActive(file, 's1', 1_000), { format: 'word', sessionId: 's1', updatedAt: 1_000 })
    // A same-millisecond rewrite still stamps later.
    assert.equal((await claimOfficeActive(file, 's2', 1_000)).updatedAt, 1_001)

    writeFileSync(file, JSON.stringify({ format: 'ppt', sessionId: 's9', updatedAt: 5_000 }), 'utf8')
    await releaseOfficeActive(file, 's2', 6_000)
    assert.deepEqual(readOfficeActive(file), { format: 'ppt', sessionId: 's9', updatedAt: 5_000 })

    // Our own claim is released (stamped as none), keeping the order strict.
    writeFileSync(file, JSON.stringify({ format: 'word', sessionId: 's2', updatedAt: 7_000 }), 'utf8')
    await releaseOfficeActive(file, 's2', 7_000)
    assert.deepEqual(readOfficeActive(file), { format: null, sessionId: 's2', updatedAt: 7_001 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
