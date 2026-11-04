/**
 * Recording a colour choice from a conversation.
 *
 * The point of this suite is that the MODEL-facing path cannot quietly do the wrong
 * thing: a colour recorded while the mode is off would start a deck nobody asked for,
 * and an unknown colourway id with no alternatives listed is a dead end. Both are
 * refusals here, with the state asserted after each one — a refused call must not
 * have written anything.
 *
 * @module plugin-ppt/tests/colour-choice
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chooseColours } from '../src/colour-choice.ts'
import { PptModeStore } from '../src/mode-store.ts'
import { officeActiveFilePath } from '../src/office-active-store.ts'

/** One temp store file plus its directory, removed when done. */
function tempStore(): { store: PptModeStore, done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ppt-colour-test-'))
  mkdirSync(join(dir, 'storages', 'dsh-app-office'), { recursive: true })
  void officeActiveFilePath(dir)
  return { store: new PptModeStore(join(dir, 'mode.json')), done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('colour choice: a brand colour lands in the session and reports the measured ratio', () => {
  const { store, done } = tempStore()
  try {
    store.set('s1', 'dsh-signal')
    const outcome = chooseColours(store, 's1', { brand: '#C0392B' })
    assert.equal(outcome.status, 'ok')
    if (outcome.status !== 'ok') return
    assert.equal(outcome.source, 'brand')
    assert.equal(store.brandOf('s1'), '#c0392b', 'stored normalised')
    assert.ok(outcome.colors !== undefined && /^#[0-9a-f]{6}$/u.test(outcome.colors.background))
    assert.ok((outcome.contrast?.textOnBackground ?? 0) >= 7, 'the ratio the answer quotes is the gated one')
    assert.match(outcome.note, /下一次组装/u, 'the answer says where the colours come from next turn')
  } finally {
    done()
  }
})

test('colour choice: a colourway keeps the layout and flags a block-only accent', () => {
  const { store, done } = tempStore()
  try {
    store.set('s2', 'dsh-slate-grid')
    const outcome = chooseColours(store, 's2', { palette: 'lemon' })
    assert.equal(outcome.status, 'ok')
    if (outcome.status !== 'ok') return
    assert.equal(outcome.source, 'preset')
    assert.equal(store.paletteOf('s2'), 'lemon')
    assert.equal(store.templateOf('s2'), 'dsh-slate-grid', 'the layout is untouched')
    assert.match(outcome.note, /色块用色/u, 'a sub-3:1 accent is named as a fill')
  } finally {
    done()
  }
})

test('colour choice: a brand colour stated BEFORE the switch is on is recorded, and the switch stays off', () => {
  // The order users actually use: "our brand colour is #c0392b, now make me a deck".
  // Refusing until the capsule was on turned that into a three-step conversation with
  // the model in the middle (measured: the model asked the user to enable the mode).
  const { store, done } = tempStore()
  try {
    const outcome = chooseColours(store, 'early', { brand: '#c0392b' })
    assert.equal(outcome.status, 'ok')
    if (outcome.status !== 'ok') return
    assert.equal(store.brandOf('early'), '#c0392b', 'the colour is remembered')
    assert.equal(store.isEnabled('early'), false, 'recording a colour does not start a deck')
    assert.match(outcome.note, /PPT 模式现在是关闭的/u, 'the answer says the colour waits for the switch')

    // Turning the switch on later keeps the colour and makes it effective.
    store.set('early', 'dsh-signal')
    assert.equal(store.isEnabled('early'), true)
    assert.equal(store.brandOf('early'), '#c0392b')
  } finally {
    done()
  }
})

test('colour choice: turning the switch off keeps the colours', () => {
  // A colour belongs to the deck being built, not to the capsule the user hid.
  const { store, done } = tempStore()
  try {
    store.set('s2b', 'dsh-signal', '#1e2bfa', 'ikb')
    store.disable('s2b')
    assert.equal(store.isEnabled('s2b'), false)
    assert.equal(store.brandOf('s2b'), '#1e2bfa', 'brand survives the switch')
    assert.equal(store.paletteOf('s2b'), 'ikb', 'colourway survives the switch')
  } finally {
    done()
  }
})

test('colour choice: an unknown colourway names the real ones', () => {
  const { store, done } = tempStore()
  try {
    store.set('s3', 'dsh-signal')
    const outcome = chooseColours(store, 's3', { palette: 'neon-dreams' })
    assert.equal(outcome.status, 'needs_revision')
    if (outcome.status !== 'needs_revision') return
    const message = outcome.issues[0]?.message ?? ''
    assert.match(message, /未知配色/u)
    assert.match(message, /ikb/u, 'the refusal lists usable ids instead of a dead end')
    assert.equal(store.paletteOf('s3'), null)
  } finally {
    done()
  }
})

test('colour choice: clear drops both, and an empty argument is a refusal with the choices', () => {
  const { store, done } = tempStore()
  try {
    store.set('s4', 'dsh-signal', '#1e2bfa', 'ikb')
    const cleared = chooseColours(store, 's4', { clear: true })
    assert.equal(cleared.status, 'ok')
    assert.equal(store.brandOf('s4'), null)
    assert.equal(store.paletteOf('s4'), null)
    assert.equal(store.isEnabled('s4'), true, 'clearing colours keeps the mode on')

    const empty = chooseColours(store, 's4', {})
    assert.equal(empty.status, 'needs_revision')
    if (empty.status !== 'needs_revision') return
    assert.match(empty.issues[0]?.message ?? '', /brand|palette/u)

    // A session-less call cannot land anywhere: refused rather than silently dropped.
    const sessionless = chooseColours(store, '', { brand: '#1e2bfa' })
    assert.equal(sessionless.status, 'needs_revision')
  } finally {
    done()
  }
})
