// Retention of the artifacts under runtime-dist/.
//
// Why this has a suite of its own: the selection deletes files, and the failure
// mode that matters is not "left too much" but "removed something still in use".
// The three cases that would be silent in a build log — a darwin artifact of the
// same release deleted by a Windows build, a version-less sidecar swept up by a
// greedy prefix match, a sidecar orphaned because `.tgz.sha512` does not end in
// `.tgz` — are each pinned below.
//
// The shapes are the ones the build actually produces (see scripts/build-runtime.mjs
// §0 and prepare-bundled-kernel.mjs), including the naming rule that keeps the
// office payload's prefix out of the mirror's layer-asset pattern.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  artifactVersion,
  newestRuntimeTarball,
  OFFICE_PAYLOAD_PREFIX,
  RUNTIME_PREFIX,
  staleCellArtifacts,
} from '../scripts/lib/runtime-artifacts.mjs'

const CELL = { platform: 'win32', arch: 'x64' }

// ------------------------------------------------------------- name parsing

test('an artifact name yields its version, with and without the sidecar', () => {
  assert.equal(artifactVersion('dsh-runtime-win32-x64-0.2.0-rc.2.tgz', RUNTIME_PREFIX, 'win32', 'x64'), '0.2.0-rc.2')
  assert.equal(artifactVersion('dsh-runtime-win32-x64-0.2.0-rc.2.tgz.sha512', RUNTIME_PREFIX, 'win32', 'x64'), '0.2.0-rc.2')
  assert.equal(artifactVersion('office-payload-win32-x64-0.1.7-rc.2.tgz', OFFICE_PAYLOAD_PREFIX, 'win32', 'x64'), '0.1.7-rc.2')
  assert.equal(artifactVersion('office-payload-win32-x64-0.1.7-rc.2.tgz.sha512', OFFICE_PAYLOAD_PREFIX, 'win32', 'x64'), '0.1.7-rc.2')
})

test('a version-less metadata file is not an artifact', () => {
  // `office-payload-<cell>.json` is the sidecar the release attaches and
  // `runtime-files-<cell>.json` the inventory copy: neither carries a version,
  // so neither may ever be selected — deleting them would break a release audit
  // that must not unpack 100 MB.
  assert.equal(artifactVersion('office-payload-win32-x64.json', OFFICE_PAYLOAD_PREFIX, 'win32', 'x64'), null)
  assert.equal(artifactVersion('runtime-files-win32-x64.json', RUNTIME_PREFIX, 'win32', 'x64'), null)
  assert.equal(artifactVersion('manifest.json', RUNTIME_PREFIX, 'win32', 'x64'), null)
})

test('another cell, another prefix and an empty version are all refused', () => {
  assert.equal(artifactVersion('dsh-runtime-darwin-arm64-0.2.0-rc.2.tgz', RUNTIME_PREFIX, 'win32', 'x64'), null)
  assert.equal(artifactVersion('dsh-runtime-win32-arm64-0.2.0-rc.2.tgz', RUNTIME_PREFIX, 'win32', 'x64'), null)
  assert.equal(artifactVersion('dsh-runtime-win32-x64-0.2.0-rc.2.tgz', OFFICE_PAYLOAD_PREFIX, 'win32', 'x64'), null)
  assert.equal(artifactVersion('dsh-runtime-win32-x64-.tgz', RUNTIME_PREFIX, 'win32', 'x64'), null)
  // A name smuggling a separator is not a version, so it is not a candidate.
  assert.equal(artifactVersion('dsh-runtime-win32-x64-../evil.tgz', RUNTIME_PREFIX, 'win32', 'x64'), null)
})

// ----------------------------------------------------------- newest pick

test('the newest runtime tarball wins, semver-ordered', () => {
  const names = [
    'dsh-runtime-win32-x64-0.1.7-rc.2.tgz',
    'dsh-runtime-win32-x64-0.2.0-rc.2.tgz',
    'dsh-runtime-win32-x64-0.2.0-rc.1.tgz',
    'dsh-runtime-win32-x64-0.2.0-rc.2.tgz.sha512',
    'manifest.json',
  ]
  assert.equal(newestRuntimeTarball(names, 'win32', 'x64'), 'dsh-runtime-win32-x64-0.2.0-rc.2.tgz')
})

test('a cell with no artifact answers null instead of undefined', () => {
  assert.equal(newestRuntimeTarball(['office-payload-win32-x64-0.2.0-rc.2.tgz'], 'win32', 'x64'), null)
  assert.equal(newestRuntimeTarball([], 'win32', 'x64'), null)
  // A sidecar alone is not an artifact to bundle.
  assert.equal(newestRuntimeTarball(['dsh-runtime-win32-x64-0.2.0-rc.2.tgz.sha512'], 'win32', 'x64'), null)
})

// ------------------------------------------------------------- retention

test('everything but the version being built is retired, sidecars included', () => {
  const names = [
    'dsh-runtime-win32-x64-0.2.0-rc.2.tgz',
    'dsh-runtime-win32-x64-0.2.0-rc.2.tgz.sha512',
    'dsh-runtime-win32-x64-0.2.0-rc.1.tgz',
    'dsh-runtime-win32-x64-0.2.0-rc.1.tgz.sha512',
    'dsh-runtime-win32-x64-0.1.7-rc.2.tgz',
    'dsh-runtime-win32-x64-0.1.7-rc.2.tgz.sha512',
    'office-payload-win32-x64-0.2.0-rc.1.tgz',
    'office-payload-win32-x64-0.2.0-rc.1.tgz.sha512',
    'office-payload-win32-x64-0.1.7-rc.2.tgz',
    'office-payload-win32-x64-0.1.7-rc.2.tgz.sha512',
    'office-payload-win32-x64-0.2.0-rc.2.tgz',
    'office-payload-win32-x64-0.2.0-rc.2.tgz.sha512',
    'manifest.json',
    'runtime-files-win32-x64.json',
    'office-payload-win32-x64.json',
  ]
  assert.deepEqual(staleCellArtifacts(names, { ...CELL, keepVersion: '0.2.0-rc.2' }), [
    'dsh-runtime-win32-x64-0.1.7-rc.2.tgz',
    'dsh-runtime-win32-x64-0.1.7-rc.2.tgz.sha512',
    'dsh-runtime-win32-x64-0.2.0-rc.1.tgz',
    'dsh-runtime-win32-x64-0.2.0-rc.1.tgz.sha512',
    'office-payload-win32-x64-0.1.7-rc.2.tgz',
    'office-payload-win32-x64-0.1.7-rc.2.tgz.sha512',
    'office-payload-win32-x64-0.2.0-rc.1.tgz',
    'office-payload-win32-x64-0.2.0-rc.1.tgz.sha512',
  ])
})

test('a rebuild of the same version retires nothing', () => {
  const names = [
    'dsh-runtime-win32-x64-0.2.0-rc.2.tgz',
    'dsh-runtime-win32-x64-0.2.0-rc.2.tgz.sha512',
    'office-payload-win32-x64-0.2.0-rc.2.tgz',
    'manifest.json',
  ]
  assert.deepEqual(staleCellArtifacts(names, { ...CELL, keepVersion: '0.2.0-rc.2' }), [])
})

test('another cell\'s artifacts are left for that cell to retire', () => {
  const names = [
    'dsh-runtime-darwin-arm64-0.2.0-rc.1.tgz',
    'dsh-runtime-darwin-arm64-0.2.0-rc.1.tgz.sha512',
    'dsh-runtime-linux-x64-0.2.0-rc.1.tgz',
    'office-payload-darwin-arm64-0.2.0-rc.1.tgz',
    'dsh-runtime-win32-x64-0.2.0-rc.1.tgz',
  ]
  assert.deepEqual(staleCellArtifacts(names, { ...CELL, keepVersion: '0.2.0-rc.2' }), [
    'dsh-runtime-win32-x64-0.2.0-rc.1.tgz',
  ])
})

test('directories and unrelated files are never candidates', () => {
  // The build work dir, the staged primary runtimes and the download caches all
  // sit in runtime-dist/; none of them is a versioned artifact, and a recursive
  // delete of one would be catastrophic (primary-runtime-* is ~280 MB of a
  // Python set, work/ is a live build).
  const names = [
    'work',
    'primary-runtime-win32-x64',
    'primary-runtime-win32-arm64',
    '.primary-runtime-cache',
    '.primary-runtime-smoke',
    'dsh-runtime-win32-x64-0.2.0-rc.1.tgz',
  ]
  assert.deepEqual(staleCellArtifacts(names, { ...CELL, keepVersion: '0.2.0-rc.2' }), [
    'dsh-runtime-win32-x64-0.2.0-rc.1.tgz',
  ])
})
