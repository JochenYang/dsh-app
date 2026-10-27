// The runtime build must ship the kernel the TREE pinned, and must not let a
// range peer pull a newer one in.
//
// Why this test exists — measured on v0.17.8, run 40432607697: all six runtime
// cells failed with
//
//     lockfile resolved @deepseek-ai/dsh-client-store@0.2.1-rc.4, but this
//     runtime ships dsh 0.2.1-rc.3 — two kernel versions in one tree is
//     the double-instance bug, refusing to assemble
//
// Two independent causes, both fixed in scripts/build-runtime.mjs and both
// pinned here:
//
//   1. The kernel version defaulted to the npm `next` dist-tag, so a build
//      shipped whatever upstream had tagged that day. A suite-only release —
//      plugins changed, so the runtime had to be rebuilt — therefore moved the
//      KERNEL too, which is not what a plugin release means.
//   2. Suite plugins declare `@deepseek-ai/dsh*: ^<line>` as PEERS. pnpm's
//      autoInstallPeers resolves a RANGE peer from the registry, so `^rc.3`
//      started satisfying rc.4 the day it was published. A glob override does
//      not reach an auto-installed peer (measured: 181 rc.4 entries with only
//      the glob), and turning peer installs off breaks the client halves
//      (measured: `dsh-client-ui-primitives` and `dsh-client-ui-slots` vanish).
//      Only an EXACT override per peer name closes it — derived from the
//      plugins' own manifests, so the list cannot drift.
//
// These are static facts about the build script and the tree, so this needs no
// network, no registry and no build.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { SUITE_PLUGINS } from '../scripts/kernel-line.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BUILD = path.join(ROOT, 'scripts', 'build-runtime.mjs')

/** The build script's source, read once. */
function buildSource() {
  return readFileSync(BUILD, 'utf8')
}

/** Every declared version of a kernel package in the committed lockfile. */
function lockfileKernelVersions() {
  const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
  const versions = new Set()
  for (const [key, value] of Object.entries(lock.packages ?? {})) {
    if (!/^node_modules\/@deepseek-ai\/dsh(?:-|$)/u.test(key)) continue
    if (typeof value?.version === 'string' && value.version !== '') versions.add(value.version)
  }
  return versions
}

test('the tree pins exactly one kernel version', () => {
  const versions = lockfileKernelVersions()
  // The premise of reading the lockfile at all: one line resolves as one version.
  assert.equal(versions.size, 1, `expected one kernel version in package-lock.json, got ${[...versions].join(', ')}`)
})

test('the kernel version comes from the lockfile before the dist-tag', () => {
  const shared = readFileSync(path.join(ROOT, 'scripts', 'kernel-line.mjs'), 'utf8')
  // The reader lives in kernel-line.mjs so BOTH entry points use one rule: the
  // build script and the workflow's `--resolve`.
  assert.match(shared, /export function lockfileKernelVersion\(/u, 'the lockfile reader must be exported')

  const resolveStart = shared.indexOf("if (args.includes('--resolve'))")
  assert.notEqual(resolveStart, -1, 'the workflow entry point must be locatable')
  const resolveBody = shared.slice(resolveStart, shared.indexOf('} else if (assertIndex', resolveStart))
  const lockAt = resolveBody.indexOf('lockfileKernelVersion(')
  const tagAt = resolveBody.indexOf('resolveDistTagVersion(')
  assert.notEqual(lockAt, -1, '--resolve must consult the lockfile')
  assert.notEqual(tagAt, -1, 'the dist-tag stays as the fallback')
  // Order is the whole point: the dist-tag drifts with the registry, the
  // lockfile does not.
  assert.ok(lockAt < tagAt, 'the lockfile must be read before the dist-tag is queried')

  // And the build script uses the same shared reader rather than its own copy.
  const build = buildSource()
  assert.match(build, /lockfileKernelVersion,/u, 'build-runtime imports the shared reader')
  assert.doesNotMatch(build, /^function lockfileKernelVersion\(/mu, 'build-runtime must not define a second copy')
  const buildStart = build.indexOf('async function resolveDefaultDshVersion(')
  const buildBody = build.slice(buildStart, build.indexOf('\nfunction ', buildStart + 1))
  assert.ok(
    buildBody.indexOf('lockfileKernelVersion()') < buildBody.indexOf('resolveDistTagVersion('),
    'the build resolves from the lockfile before the dist-tag',
  )
})

test('a channel override still outranks the lockfile', () => {
  const source = buildSource()
  const start = source.indexOf('async function resolveDefaultDshVersion(')
  const body = source.slice(start, source.indexOf('\nfunction ', start + 1))
  // DSH_APP_CHANNEL is the documented cross-line escape hatch; a one-off build
  // must not be silently pinned back to the tree's own version.
  assert.match(body, /channelOverride === undefined/u, 'the lockfile read is conditional on no channel override')
})

test('every kernel peer the suite declares gets an exact override', () => {
  const source = buildSource()
  assert.match(source, /function suitePeerKernelSpecs\(/u, 'the peer derivation must exist')
  // The derived specs must actually reach the overrides block.
  assert.match(
    source,
    /\.\.\.\[\.\.\.suitePeerSpecs\]\.map\(/u,
    'the derived peer pins must be written into the overrides list',
  )
  // And the derivation must be keyed off the plugins' manifests, not a literal
  // list that can drift from what the plugins declare.
  const start = source.indexOf('function suitePeerKernelSpecs(')
  const body = source.slice(start, source.indexOf('\n/**', start))
  assert.match(body, /peerDependencies/u, 'peers come from each plugin manifest')
  assert.match(body, /SUITE_PLUGINS/u, 'the roster decides which plugins are read')
})

test('the peer derivation skips non-kernel peers', () => {
  const source = buildSource()
  const start = source.indexOf('function suitePeerKernelSpecs(')
  const body = source.slice(start, source.indexOf('\n/**', start))
  // cordis and schemastery are framework peers on their own line; pinning them
  // to the kernel version would break resolution.
  assert.match(body, /KERNEL_PACKAGE\.test\(peer\)/u, 'only kernel-shaped peers are pinned')
})

test('autoInstallPeers stays on, because the client halves need their peers', () => {
  const source = buildSource()
  // The ASSEMBLY workspace file, not the payload one — the payload install has
  // its own pnpm-workspace.yaml earlier in the file and no peers at all.
  const start = source.indexOf('const suitePeerSpecs = suitePeerKernelSpecs()')
  assert.notEqual(start, -1, 'the assembly block must be locatable')
  const body = source.slice(start, start + 6000)
  // Measured: with peer installs off, `dsh-client-ui-primitives` and
  // `dsh-client-ui-slots` are absent from the tree and the plugin client halves
  // stop resolving. The fix is the exact pins above, not disabling peers.
  assert.match(body, /'autoInstallPeers: true'/u, 'peer installs stay enabled')
})

test('the suite really declares kernel peers, so the pins are load-bearing', () => {
  const peers = new Set()
  for (const name of SUITE_PLUGINS) {
    const manifest = JSON.parse(
      readFileSync(path.join(ROOT, 'plugins', name.replace('@dsh-app/', ''), 'package.json'), 'utf8'),
    )
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (/^@deepseek-ai\/dsh(?:-|$)/u.test(peer)) peers.add(peer)
    }
  }
  // If this ever reaches zero the pins are dead code and the comment above them
  // is stale — the same way a mirrored roster copy silently stops agreeing.
  assert.ok(peers.size > 0, 'at least one suite plugin must declare a kernel peer for this rule to matter')
})
