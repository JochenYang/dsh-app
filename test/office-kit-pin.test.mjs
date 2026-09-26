// The office kit is PINNED, and that pin is part of the build's identity.
//
// Why this test exists — two failures, both measured on this tree:
//
//   1. The kernel line declares `@deepseek-ai/libreoffice-kit: ^0.1.1`, and that
//      version becomes the OFFICE PAYLOAD's version
//      (`officePayloadVersion(kitVersion, pythonVersion)`). The payload is a
//      separate artifact published once per runtime release, named after the
//      KERNEL version rather than the payload one. So a floating range makes the
//      same source produce a runtime demanding a payload no release carries: kit
//      0.1.2 shipped 2026-09-25T16:02Z, twelve hours after the 0.1.7-rc.2
//      runtime was cut, so a rebuild resolved 0.1.2 and required
//      `0.1.2-py3.12.14`; every installed `0.1.1-py3.12.14` then stopped
//      satisfying its kernel, and the settings row offered a download that could
//      only fail ("the payload is version 0.1.1-py3.12.14, but this kernel
//      requires 0.1.2-py3.12.14") because the release asset still carried the
//      old payload.
//
//   2. A pin that is NOT part of `computeSuiteVersion` never reaches anyone who
//      already has the app. The kernel directory name, the `bundledStamp` and
//      the adoption decision are all the suite hash: bump the kit alone and the
//      stamp is unchanged, `decideBundledAdoption` answers `already-adopted`, and
//      the runtime that demands the new payload is silently never activated —
//      the same shape of no-op the CI reuse gate was fixed for.
//
// Both are static facts about this repository, so no network and no build is
// needed to catch a regression.
//
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { DESKTOP_OFFICE_KIT_VERSION, computeSuiteVersion, SUITE_PLUGINS } from '../scripts/kernel-line.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const KERNEL_LINE = readFileSync(path.join(ROOT, 'scripts', 'kernel-line.mjs'), 'utf8')
const BUILD_RUNTIME = readFileSync(path.join(ROOT, 'scripts', 'build-runtime.mjs'), 'utf8')

test('the office kit version is pinned, not left to the dependency range', () => {
  // An exact version, never a range: a range here reproduces failure 1 above.
  assert.match(DESKTOP_OFFICE_KIT_VERSION, /^\d+\.\d+\.\d+$/u,
    `the pin must be an exact version, got ${JSON.stringify(DESKTOP_OFFICE_KIT_VERSION)}`)
})

test('the pin has ONE definition, in the module that hashes it', () => {
  // Two declarations would drift, and the one build-runtime reads is the one
  // that must equal the one computeSuiteVersion hashes.
  assert.equal(/export const DESKTOP_OFFICE_KIT_VERSION/u.test(KERNEL_LINE), true,
    'the pin must be declared (and exported) in scripts/kernel-line.mjs')
  assert.equal(/^\s*const DESKTOP_OFFICE_KIT_VERSION = /mu.test(BUILD_RUNTIME), false,
    'scripts/build-runtime.mjs must IMPORT the pin, not declare a second one')
  assert.equal(/DESKTOP_OFFICE_KIT_VERSION,/u.test(BUILD_RUNTIME), true,
    'scripts/build-runtime.mjs must import DESKTOP_OFFICE_KIT_VERSION')
})

test('the assembly overrides the kit to that pin', () => {
  // The pin only works if pnpm is TOLD about it: the kernel line's `^0.1.1`
  // would otherwise win and resolve to whatever is newest at build time.
  assert.match(
    BUILD_RUNTIME,
    /`\s*'\$\{DESKTOP_OFFICE_KIT_PACKAGE\}': '\$\{DESKTOP_OFFICE_KIT_VERSION\}'`,/u,
    'the assembly overrides no longer pin the kit to DESKTOP_OFFICE_KIT_VERSION',
  )
})

test('the suite hash covers the pin, so bumping it reaches existing installs', () => {
  // Failure 2, asserted behaviourally rather than by reading the hash input: the
  // suite version is what names the kernel directory and the bundled stamp, so a
  // pin bump that leaves it unchanged ships a runtime nobody adopts.
  const parts = [...SUITE_PLUGINS].sort().map((name) => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'plugins', name.replace('@dsh-app/', ''), 'package.json'), 'utf8'))
    return `${name}@${pkg.version}`
  })
  // What the hash would be WITHOUT the pin: the algorithm is fixed (sha256 over
  // the plugin list, first 8 hex), so this is the comparison that fails when the
  // pin drops out of the input.
  const pluginsOnly = createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 8)
  assert.notEqual(computeSuiteVersion(), pluginsOnly,
    'computeSuiteVersion no longer covers the kit pin: a pin-only bump would never be adopted')
})

test('the pin is declared before the assembly that uses it', () => {
  // The both-halves order is what makes the payload read the PINNED tree: the
  // runtime install (which applies the override) has to finish before
  // buildOfficePayload reads `@deepseek-ai/libreoffice-kit/package.json` for the
  // version it stamps into the payload manifest.
  const override = BUILD_RUNTIME.indexOf('`  \'${DESKTOP_OFFICE_KIT_PACKAGE}\': \'${DESKTOP_OFFICE_KIT_VERSION}\'`,')
  const payloadRead = BUILD_RUNTIME.indexOf('const officePayload = await buildOfficePayload(')
  assert.ok(override > 0, 'the assembly override is gone')
  assert.ok(payloadRead > override, 'the payload must be built after the pinned assembly installs it')
})
