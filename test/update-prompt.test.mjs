// Unit tests for the platform-independent update prompt / skip semantics the
// Windows and the electron-updater flow share (§4.4 frozen contract).
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { decideUpdatePrompt, shouldRetireSkippedVersion, skippedVersionToast } = require('../dist/main/updater.js')

test('a newer version with nothing skipped is an ordinary prompt', () => {
  assert.equal(decideUpdatePrompt('0.12.0', '0.11.9', null, false), 'prompt')
  assert.equal(decideUpdatePrompt('0.12.0', '0.11.9', null, true), 'prompt')
})

test('a skipped version stays silent for automatic checks and is offered on a manual one', () => {
  assert.equal(decideUpdatePrompt('0.12.0', '0.11.9', '0.12.0', false), 'silent')
  assert.equal(decideUpdatePrompt('0.12.0', '0.11.9', '0.12.0', true), 'skipped')
})

test('a skip only ever suppresses the version it names', () => {
  // A skip of an older version (already superseded) cannot mute a real update.
  assert.equal(decideUpdatePrompt('0.12.0', '0.11.9', '0.11.8', false), 'prompt')
  // Nor can a skip of the version that is already running.
  assert.equal(decideUpdatePrompt('0.12.0', '0.11.9', '0.11.9', false), 'prompt')
})

test('nothing newer than the running version never prompts', () => {
  assert.equal(decideUpdatePrompt('0.11.9', '0.11.9', null, true), 'latest')
  // A downgrade offered by the feed is not an update either.
  assert.equal(decideUpdatePrompt('0.11.8', '0.11.9', null, false), 'latest')
  assert.equal(decideUpdatePrompt('0.11.9', '0.11.9', '0.11.9', true), 'latest')
  // Prerelease ordering still follows semver.
  assert.equal(decideUpdatePrompt('0.12.0-beta.1', '0.11.9', null, false), 'prompt')
  assert.equal(decideUpdatePrompt('0.12.0', '0.12.0-beta.1', null, false), 'prompt')
  // Non-semver values fall back to plain inequality.
  assert.equal(decideUpdatePrompt('nonsense', 'nonsense', null, true), 'latest')
  assert.equal(decideUpdatePrompt('nonsense', '0.11.9', null, true), 'prompt')
})

test('a skip is retired once the version it names is actually running', () => {
  assert.equal(shouldRetireSkippedVersion('0.12.0', '0.12.0'), true, 'the skipped version itself is running')
  assert.equal(shouldRetireSkippedVersion('0.12.0', '0.12.1'), true, 'a newer version supersedes it')
  assert.equal(shouldRetireSkippedVersion('0.12.0', '0.11.9'), false, 'still older: keep suppressing that version')
  assert.equal(shouldRetireSkippedVersion(null, '0.12.0'), false)
  assert.equal(shouldRetireSkippedVersion('', '0.12.0'), false)
  // Non-semver records only retire on exact equality (and never throw).
  assert.equal(shouldRetireSkippedVersion('nonsense', 'nonsense'), true)
  assert.equal(shouldRetireSkippedVersion('nonsense', '0.12.0'), false)
  assert.equal(shouldRetireSkippedVersion('0.12.0', 'nonsense'), false)
  // Prereleases: running the beta does not retire a skip of the final release.
  assert.equal(shouldRetireSkippedVersion('0.12.0-beta.1', '0.12.0-beta.1'), true)
  assert.equal(shouldRetireSkippedVersion('0.12.0', '0.12.0-beta.1'), false)
})

test('the skip confirmation keeps the frozen user-visible wording', () => {
  assert.equal(skippedVersionToast('0.12.0'), '已跳过 DSH APP 0.12.0，之后将不再自动提醒')
})
