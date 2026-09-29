/**
 * The profile supply-chain checkup, against fixtures built here.
 *
 * What this pins, and why each one would cost someone a bad day if it drifted:
 *
 *   - a prune removes the STALE lines and only those: an entry the lockfile still
 *     pins, an entry nothing can judge (no lockfile, not version-qualified), a
 *     comment and a blank line all survive;
 *   - the file comes back byte-for-byte apart from the removed lines — CRLF stays
 *     CRLF, quoting stays as written, key order stays put (the file belongs to the
 *     package manager and the user);
 *   - a backup exists before the first write, under the name the maintenance
 *     procedure uses;
 *   - a second run is a no-op;
 *   - `minimumReleaseAge` is never written by this tool, and a disabled policy is
 *     reported rather than fixed;
 *   - the peer verdict reads the registry's range and admits a prerelease of the
 *     same version tuple (`^0.2.0-rc.1` admits `0.2.0-rc.2`) but not one of the
 *     next (it must NOT admit `0.3.0`).
 *
 * @module dsh-app/tests/profile-supply-chain
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const MODULE = path.join(ROOT, 'scripts', 'profile-supply-chain.mjs')
const { readExclusions, classify, pruneProfile, inspectProfile, listProfiles, resolveHome, peerVerdict } = await import(`file://${MODULE.replaceAll('\\', '/')}`)

/** A throwaway home with one profile from the given workspace/lockfile text. */
function fixture(workspace, lockfile, name = 'dsh-app') {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-profile-supply-'))
  const dir = path.join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: `dsh-profile-${name}`, private: true, dependencies: {} }, undefined, 2)}\n`, 'utf8')
  if (workspace !== undefined) writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), workspace, 'utf8')
  if (lockfile !== undefined) writeFileSync(path.join(dir, 'pnpm-lock.yaml'), lockfile, 'utf8')
  return { home, dir, name }
}

const WORKSPACE = [
  'packages:',
  '  - .',
  '',
  'nodeLinker: hoisted',
  'autoInstallPeers: false',
  '# the exclusions below are pruned by scripts/profile-supply-chain.mjs',
  'minimumReleaseAgeExclude:',
  '  - dsh-context@0.59.1',
  '  - dshmarket@1.66.3',
  '  - \'@deepseek-ai/dsh-brand@0.1.7-alpha.1\'',
  '  - a-name-without-a-version',
  "  - 'a-quoted-name-without-a-version'",
  '',
].join('\n')

const LOCKFILE = [
  "lockfileVersion: '9.0'",
  '',
  'importers:',
  '',
  '  .:',
  '    dependencies:',
  '      dshmarket:',
  "        specifier: ^1.66.3",
  "        version: 1.66.5(@deepseek-ai/schemastery@3.18.3)",
  '',
  'packages:',
  '',
  '  dshmarket@1.66.5:',
  '    resolution: {integrity: sha512-AAAA}',
  '',
].join('\n')

test('an exclusion entry is live, stale, or unresolvable', async () => {
  assert.equal(classify(LOCKFILE, 'dshmarket@1.66.5'), 'live')
  assert.equal(classify(LOCKFILE, 'dshmarket@1.66.3'), 'stale')
  assert.equal(classify(LOCKFILE, '@deepseek-ai/dsh-brand@0.1.7-alpha.1'), 'stale')
  assert.equal(classify('', 'dshmarket@1.66.3'), 'unresolved', 'no lockfile, no judgement')
  assert.equal(classify(LOCKFILE, 'a-name-without-a-version'), 'unresolved')
})

test('the list is read with its quoting and line numbers', async () => {
  const { policyValue, entries } = readExclusions(WORKSPACE)
  assert.equal(policyValue, undefined, 'the policy key is absent here')
  assert.deepEqual(entries.map((entry) => entry.value), [
    'dsh-context@0.59.1',
    'dshmarket@1.66.3',
    '@deepseek-ai/dsh-brand@0.1.7-alpha.1',
    'a-name-without-a-version',
    'a-quoted-name-without-a-version',
  ])
  assert.deepEqual(entries.map((entry) => entry.line), [7, 8, 9, 10, 11])
})

test('a prune removes the stale lines and leaves everything else byte-identical', async () => {
  const { home, dir } = fixture(WORKSPACE, LOCKFILE)
  const before = readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8')
  const profile = inspectProfile(home, 'dsh-app')
  const { removed, backup } = pruneProfile(profile)

  assert.deepEqual(removed.sort(), ['@deepseek-ai/dsh-brand@0.1.7-alpha.1', 'dsh-context@0.59.1', 'dshmarket@1.66.3'].sort())
  const after = readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8')
  const expected = before.split('\n').filter((line) => !removed.some((entry) => line.trim() === `- ${entry}` || line.trim() === `- '${entry}'`)).join('\n')
  assert.equal(after, expected, 'only those lines changed')
  assert.ok(after.includes('# the exclusions below are pruned'), 'the comment survives')
  assert.ok(after.includes('a-name-without-a-version'), 'an unjudgeable entry is kept')
  assert.ok(after.includes('nodeLinker: hoisted'), 'the rest of the file is untouched')
  assert.equal(readFileSync(backup, 'utf8'), before, 'the backup holds the pre-prune bytes')

  // Idempotent: the second run finds the list already honest.
  const again = pruneProfile(inspectProfile(home, 'dsh-app'))
  assert.deepEqual(again.removed, [])
  await rm(home, { recursive: true, force: true })
})

test('CRLF and quoting survive the prune', async () => {
  const { home, dir } = fixture(WORKSPACE.replace(/\n/gu, '\r\n'), LOCKFILE)
  pruneProfile(inspectProfile(home, 'dsh-app'))
  const after = readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8')
  assert.ok(after.includes('\r\n'), 'line endings stay CRLF')
  // The unjudgeable entries survive EXACTLY as written — including the quoted
  // one, whose quotes are the file's, not ours — while the stale lines are gone.
  assert.equal(after.split('\r\n').filter((line) => line === '  - a-name-without-a-version').length, 1, 'the unquoted survivor keeps its shape')
  assert.equal(after.split('\r\n').filter((line) => line === "  - 'a-quoted-name-without-a-version'").length, 1, 'the quoted survivor keeps ITS shape')
  assert.ok(!after.includes('@deepseek-ai/dsh-brand'), 'the quoted stale entry is gone')
  await rm(home, { recursive: true, force: true })
})

test('no lockfile means no prune', async () => {
  const { home, dir } = fixture(WORKSPACE, undefined)
  const profile = inspectProfile(home, 'dsh-app')
  assert.ok(profile.entries.every((entry) => entry.verdict === 'unresolved'))
  assert.deepEqual(pruneProfile(profile), { removed: [], backup: undefined })
  assert.equal(readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8'), WORKSPACE, 'the file is untouched')
  await rm(home, { recursive: true, force: true })
})

test('the policy key is read, reported, and never written', async () => {
  const disabled = ['minimumReleaseAge: 0', 'minimumReleaseAgeExclude:', '  - dshmarket@1.66.3', ''].join('\n')
  const { home, dir } = fixture(disabled, LOCKFILE)
  const profile = inspectProfile(home, 'dsh-app')
  assert.equal(profile.policy, '0', 'the disabled policy is visible to the report')
  pruneProfile(profile)
  assert.ok(readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8').startsWith('minimumReleaseAge: 0\n'), 'that line is never rewritten')
  await rm(home, { recursive: true, force: true })
})

test('profiles are discovered, not listed in code', async () => {
  const { home, dir } = fixture(WORKSPACE, LOCKFILE)
  mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true })
  writeFileSync(path.join(home, 'profiles', 'web', 'package.json'), '{}\n', 'utf8')
  mkdirSync(path.join(home, 'profiles', 'not-a-profile'), { recursive: true })
  assert.deepEqual(listProfiles(home, []), ['dsh-app', 'web'], 'a directory without a manifest is not a profile')
  assert.deepEqual(listProfiles(home, ['web']), ['web'])
  assert.equal(path.dirname(dir), path.join(home, 'profiles'))
  await rm(home, { recursive: true, force: true })
})

test('DSH_HOME is honoured when --home is absent', async () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(tmpdir(), 'dsh-home-for-the-test')
  assert.equal(resolveHome(''), path.resolve(process.env.DSH_HOME))
  assert.equal(resolveHome('D:/explicit'), path.resolve('D:/explicit'), 'an explicit --home wins')
  if (previous === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previous
})

test('a peer range admits the next rc of its own tuple, and not the next line', async () => {
  const fetchLike = async (pkg) => {
    assert.equal(pkg, 'dshmarket')
    return { version: '1.66.5', peers: { '@deepseek-ai/dsh-settings': '^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2 || ^0.2.0-rc.1' } }
  }
  const kernelPeers = ['@deepseek-ai/dsh-settings']
  assert.equal((await peerVerdict('dshmarket', kernelPeers, '0.2.0-rc.2', fetchLike)).verdict, 'compatible', '^0.2.0-rc.1 admits 0.2.0-rc.2')
  assert.equal((await peerVerdict('dshmarket', kernelPeers, '0.2.0-rc.1', fetchLike)).verdict, 'compatible')
  assert.equal((await peerVerdict('dshmarket', kernelPeers, '0.3.0-rc.1', fetchLike)).verdict, 'incompatible', 'the next line is refused')
  assert.equal((await peerVerdict('dshmarket', kernelPeers, '0.0.9', fetchLike)).verdict, 'incompatible', 'a line below every range is refused')
  assert.equal((await peerVerdict('dshmarket', kernelPeers, '0.1.5', fetchLike)).verdict, 'compatible', 'a version inside the oldest range is admitted (prereleases included)')
  assert.equal((await peerVerdict('quiet-plugin', kernelPeers, '0.2.0-rc.2', async () => ({ version: '1.0.0', peers: {} }))).verdict, 'compatible', 'a plugin that declares no kernel peer is never refused')
  assert.equal((await peerVerdict('gone-plugin', kernelPeers, '0.2.0-rc.2', async () => { throw new Error('E404') })).verdict, 'unknown', 'a registry failure is not a verdict')
})

test('the script parses and reports the repository\'s own followed line', async () => {
  const source = readFileSync(MODULE, 'utf8')
  assert.ok(source.includes('followedSpec'), 'the peers report reads the followed line from scripts/kernel-line.mjs')
  const scripts = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts
  assert.ok(scripts['profiles:audit'].includes('profile-supply-chain.mjs audit'), 'an npm alias exists for the audit')
  assert.ok(scripts['profiles:prune'].includes('profile-supply-chain.mjs prune'), 'an npm alias exists for the prune')
  assert.ok(scripts['profiles:peers'].includes('profile-supply-chain.mjs peers'), 'an npm alias exists for the peers report')
  assert.ok(readdirSync(path.join(ROOT, 'scripts')).includes('profile-supply-chain.mjs'))
})
