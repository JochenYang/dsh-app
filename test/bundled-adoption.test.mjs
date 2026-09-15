// Bundled-runtime adoption matrix: which boot state re-activates the runtime
// shipped inside the installer, and which leaves the active kernel alone.
// The unit under test is pure, so this runs without a disk or a network.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { decideBundledAdoption } = require('../dist/kernel/bundled.js')

/** The active install as the boot path sees it. */
function active({ dshVersion = '1.0.0', platform = 'win32', arch = 'x64', bundledStamp } = {}) {
  return {
    manifest: { dshVersion, suiteVersion: 'suite-1', channel: 'stable', platform, arch, integrity: '', source: 'artifact' },
    ...(bundledStamp === undefined ? {} : { bundledStamp }),
  }
}

/** The installer's `resources/kernel/manifest.json`. */
function bundle({ dshVersion = '1.0.0', suiteVersion = 'suite-1', platform = 'win32', arch = 'x64' } = {}) {
  return { dshVersion, suiteVersion, platform, arch }
}

test('an install that never adopted this bundle activates it', () => {
  const decision = decideBundledAdoption(bundle(), active())
  assert.equal(decision.adopt, true)
  assert.equal(decision.reason, 'not-adopted-yet')
})

test('a bundle already adopted by this install is not re-extracted on every boot', () => {
  // The regression this protects: keying on the tarball sha512 re-extracted an
  // identical runtime on every single boot.
  const decision = decideBundledAdoption(bundle(), active({ bundledStamp: '1.0.0+suite-1' }))
  assert.equal(decision.adopt, false)
  assert.equal(decision.reason, 'already-adopted')
})

test('a new shell shipping a changed suite adopts even at the same dsh version', () => {
  // The incident this whole check exists for: same version, same directory
  // name, new suite content — the missing plugin used to boot vanilla.
  const decision = decideBundledAdoption(bundle({ suiteVersion: 'suite-2' }), active({ bundledStamp: '1.0.0+suite-1' }))
  assert.equal(decision.adopt, true)
})

test('a kernel updated online past the bundled snapshot survives', () => {
  const decision = decideBundledAdoption(bundle({ dshVersion: '1.0.0' }), active({ dshVersion: '2.0.0' }))
  assert.equal(decision.adopt, false)
  assert.equal(decision.reason, 'online-ahead')
})

test('an install at exactly the bundled version is still adopted', () => {
  // "Ahead" is a strict comparison: equal versions must not block adoption,
  // otherwise a same-version shell fix could never land.
  const decision = decideBundledAdoption(bundle({ dshVersion: '1.0.0' }), active({ dshVersion: '1.0.0' }))
  assert.equal(decision.adopt, true)
})

test('a bundle for another platform is never activated', () => {
  assert.equal(decideBundledAdoption(bundle({ platform: 'linux' }), active()).adopt, false)
  assert.equal(decideBundledAdoption(bundle({ platform: 'linux' }), active()).reason, 'platform-mismatch')
})

test('a bundle for another arch is never activated', () => {
  const arch = 'win32' === 'win32' ? 'arm64' : 'x64'
  assert.equal(decideBundledAdoption(bundle({ arch }), active()).adopt, false)
})

test('a bundle manifest missing its identity fields still activates (legacy behaviour)', () => {
  // Preserved from the pre-extraction inline check: without the fields there is
  // no stamp to compare, so a platform-matching bundle is adopted rather than
  // skipped. build-runtime.mjs always writes both fields, so this only fires
  // for a corrupt bundle manifest — and adopting is the recoverable choice.
  assert.equal(decideBundledAdoption({ platform: 'win32', arch: 'x64' }, active()).adopt, true)
  assert.equal(decideBundledAdoption({}, active()).adopt, false, 'a manifest without platform cannot match')
})

test('an adopted stamp with an unidentifiable bundle is re-adopted (cannot prove it was seen)', () => {
  assert.equal(decideBundledAdoption({ platform: 'win32', arch: 'x64' }, active({ bundledStamp: '1.0.0+suite-1' })).adopt, true)
})

test('an unparseable active version throws, which the boot path catches', () => {
  // Documents that the caller's try/catch is load-bearing: the check must not
  // be called without it.
  assert.throws(
    () => decideBundledAdoption(bundle({ dshVersion: '1.0.0' }), active({ dshVersion: 'not-a-version' })),
    TypeError,
  )
})
