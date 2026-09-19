// The version history the tray's rollback menu reads, and the rule that keeps
// it agreeing with the version actually running.
//
// Why this exists: the only writer used to be the pending-install consumer,
// which runs solely after an IN-APP update. A version installed by hand — the
// download-the-installer route a user takes when the app cannot start — advanced
// without a record, so `history[len-1]` (the entry the menu reads as "the
// version I am running") named an older release and a rollback landed one
// version too far back. Measured on 0.12.6: history ended at 0.12.5 while 0.12.6
// was running, so the menu would have offered 0.12.4.
//
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { reconciledVersionHistory } = require('../dist/main/updater.js')

const AT = '2026-09-19T00:00:00.000Z'
const entry = (version) => ({ version, at: AT })
const versions = (result) => result === null ? null : result.map((item) => item.version)

test('a hand-installed version is recorded on the next boot', () => {
  // The measured state: 0.12.6 running, history still ending at 0.12.5.
  assert.deepEqual(versions(reconciledVersionHistory([entry('0.12.3'), entry('0.12.5')], '0.12.6', AT)),
    ['0.12.3', '0.12.5', '0.12.6'])
})

test('a boot that already agrees writes nothing', () => {
  assert.equal(reconciledVersionHistory([entry('0.12.5'), entry('0.12.6')], '0.12.6', AT), null)
})

test('a re-upgrade moves the version to the end instead of duplicating it', () => {
  // Downgraded to 0.12.5 after 0.12.6, now back on 0.12.6: two entries of the
  // same version would shift the menu's len-2 off the real previous release.
  assert.deepEqual(versions(reconciledVersionHistory([entry('0.12.6'), entry('0.12.5')], '0.12.6', AT)),
    ['0.12.5', '0.12.6'])
})

test('the appended entry carries the supplied timestamp', () => {
  const next = reconciledVersionHistory([entry('0.12.5')], '0.12.6', AT)
  assert.equal(next.at(-1).at, AT)
})

test('the history stays capped, dropping the oldest', () => {
  const history = ['0.12.1', '0.12.2', '0.12.3', '0.12.4', '0.12.5'].map(entry)
  assert.deepEqual(versions(reconciledVersionHistory(history, '0.12.6', AT)),
    ['0.12.2', '0.12.3', '0.12.4', '0.12.5', '0.12.6'])
})

test('a fresh install records its own version', () => {
  assert.deepEqual(versions(reconciledVersionHistory([], '0.12.6', AT)), ['0.12.6'])
})

test('a version that cannot be spliced into a filename is never recorded', () => {
  // `isSafeVersion` guards the installer filename, and the history is read back
  // into the same path-building code — an unusable value must not enter it.
  assert.equal(reconciledVersionHistory([entry('0.12.5')], '../evil', AT), null)
  assert.equal(reconciledVersionHistory([entry('0.12.5')], '', AT), null)
})
