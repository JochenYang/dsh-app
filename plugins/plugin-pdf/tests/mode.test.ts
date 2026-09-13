/**
 * Session PDF-mode persistence: the on-disk round trip, the "only an explicit
 * true is on" load rule, boot-time pruning and the corrupt-file degradation.
 * The store is deliberately the only state the prompt section and the mode
 * route share, so these are the properties that keep the capsule and the
 * injected directive in agreement.
 *
 * @module @dsh-app/plugin-pdf/tests/mode
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PdfModeStore } from '../src/mode-store.ts'

function withTempStore(run: (file: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pdfd-mode-'))
  return run(join(dir, 'mode.json')).finally(() => { rmSync(dir, { recursive: true, force: true }) })
}

test('mode: a missing file starts empty and unknown sessions read as off', async () => {
  await withTempStore(async (file) => {
    const store = new PdfModeStore(file)
    store.load()
    assert.equal(store.isEnabled('s1'), false)
    await store.flush()
  })
})

test('mode: a toggle round-trips through disk and reads back', async () => {
  await withTempStore(async (file) => {
    const store = new PdfModeStore(file)
    store.load()
    store.set('s1', true)
    // The in-memory map is live before the write settles.
    assert.equal(store.isEnabled('s1'), true)
    assert.equal(typeof store.updatedAtOf('s1'), 'number')
    await store.flush()

    const persisted = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { enabled: boolean }>
    assert.equal(persisted.s1?.enabled, true)

    const reloaded = new PdfModeStore(file)
    reloaded.load()
    assert.equal(reloaded.isEnabled('s1'), true)
    assert.equal(reloaded.isEnabled('s2'), false)

    reloaded.set('s1', false)
    await reloaded.flush()
    const cleared = new PdfModeStore(file)
    cleared.load()
    assert.equal(cleared.isEnabled('s1'), false)
  })
})

test('mode: only an explicit true counts as on, and malformed entries are ignored', async () => {
  await withTempStore(async (file) => {
    writeFileSync(file, JSON.stringify({
      on: { enabled: true, updatedAt: Date.now() },
      off: { enabled: false, updatedAt: Date.now() },
      stringy: { enabled: 'true', updatedAt: Date.now() },
      noTimestamp: { enabled: true },
      notAnObject: 7,
    }), 'utf8')
    const store = new PdfModeStore(file)
    store.load()
    assert.equal(store.isEnabled('on'), true)
    assert.equal(store.isEnabled('off'), false)
    assert.equal(store.isEnabled('stringy'), false)
    assert.equal(store.isEnabled('noTimestamp'), false)
    assert.equal(store.isEnabled('notAnObject'), false)
  })
})

test('mode: corrupt content degrades to empty instead of throwing', async () => {
  await withTempStore(async (file) => {
    writeFileSync(file, '{ not json', 'utf8')
    const warnings: string[] = []
    const store = new PdfModeStore(file, { warn: message => { warnings.push(message) }, info: () => {} })
    store.load()
    assert.equal(store.isEnabled('s1'), false)
    assert.equal(warnings.length, 1)
  })
})

test('mode: pruning drops stale sessions and keeps fresh ones', async () => {
  await withTempStore(async (file) => {
    const store = new PdfModeStore(file)
    store.load()
    store.set('fresh', true)
    store.set('stale', true)
    await store.flush()

    // A clock far enough ahead that both look old: nothing to keep.
    assert.equal(store.prune(0, Date.now() + 60_000), 2)
    assert.equal(store.isEnabled('fresh'), false)
    await store.flush()
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {})
  })
})

test('mode: rapid toggles serialize and the last state wins', async () => {
  await withTempStore(async (file) => {
    const store = new PdfModeStore(file)
    store.load()
    store.set('s1', true)
    store.set('s1', false)
    store.set('s1', true)
    await store.flush()
    assert.equal(store.isEnabled('s1'), true)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).s1.enabled, true)
  })
})
