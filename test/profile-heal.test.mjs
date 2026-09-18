// The profile repair step that runs in front of every host start: a profile
// whose own manifest declares a dependency that is not installed is a profile
// the host refuses to boot (`cannot resolve profile bundle
// "@deepseek-ai/dsh-toolkit"`), and nothing inside the app could repair it — a
// hand-run `pnpm install` answered "Already up to date" while the packages were
// missing.
//
// The step drives the profile's own package manager through the kernel CLI, the
// same invocation the in-app market installs through; the spawn is scripted
// here, so no package manager and no network are involved, and the property
// under test is WHEN it runs and with WHAT argv (a healthy profile must not
// spawn anything at all: that is every normal boot).
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { healLogLine, healProfileDependencies, missingDependencies } = require('../dist/main/profile-heal.js')

/**
 * Scratch harness homes. Each one is an `os.tmpdir()` directory this file
 * created, holding nothing but manifests — no link points out of any of them.
 * The profile lives at `<home>/profiles/dsh-app`, the layout the CLI's own
 * `--profile` resolution expects.
 */
const scratch = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-heal-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * A `spawn` stand-in that records every call and answers with one scripted run.
 * `onSpawn` lets a test write the tree the run was supposed to produce, which is
 * how the "reported success but the package is still missing" case is built.
 */
function scriptedSpawn({ code = 0, output = '', onSpawn } = {}) {
  const calls = []
  const impl = (executable, args, options) => {
    calls.push({ executable, args: [...args], options })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 4000 + calls.length
    setImmediate(() => {
      onSpawn?.()
      if (output !== '') child.stdout.emit('data', output)
      child.emit('close', code)
    })
    return child
  }
  return { impl, calls }
}

/**
 * A profile directory with the given `dependencies` and installed names, in the
 * layout a harness home uses (`<home>/profiles/dsh-app`) so the same directory
 * can be handed to the real CLI when a test needs a real child.
 */
function fakeProfile(home, dependencies, installed = []) {
  const profileDir = path.join(home, 'profiles', 'dsh-app')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    path.join(profileDir, 'package.json'),
    `${JSON.stringify({ name: 'dsh-profile-dsh-app', private: true, dependencies })}\n`,
  )
  for (const name of installed) {
    const file = path.join(profileDir, 'node_modules', ...name.split('/'), 'package.json')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ name })}\n`)
  }
  return profileDir
}

/** The options every call shares; the caller supplies the profile and spawn. */
function options(profileDir, spawnImpl, extra = {}) {
  return {
    profileDir,
    profileName: 'dsh-app',
    // The home the profile lives under. Pinned by the step and asserted below:
    // the CLI resolves `--profile` through $DSH_HOME, never from cwd.
    dshHome: path.dirname(path.dirname(profileDir)),
    bin: 'D:/kernel/app/node_modules/@deepseek-ai/dsh/lib/bin.js',
    node: 'D:/kernel/node/node.exe',
    spawnImpl,
    ...extra,
  }
}

test('a profile with every declared dependency installed runs nothing and says nothing', async (t) => {
  const profile = fakeProfile(scratch(t), {
    '@deepseek-ai/dsh-toolkit': '^0.2.1',
    'dsh-better-edit': '1.0.3',
  }, ['@deepseek-ai/dsh-toolkit', 'dsh-better-edit'])
  const { impl, calls } = scriptedSpawn({})
  const outcome = await healProfileDependencies(options(profile, impl))
  assert.equal(outcome.status, 'ok')
  assert.deepEqual(outcome.missing, [])
  // The load-bearing property of the whole step: no process, no log line.
  assert.equal(calls.length, 0)
  assert.equal(healLogLine(outcome, profile), null)
})

test('a declared dependency that is missing triggers exactly one run with the market argv', async (t) => {
  const missingName = '@deepseek-ai/dsh-toolkit'
  const profile = fakeProfile(scratch(t), { [missingName]: '^0.2.1', 'dsh-better-edit': '1.0.3' }, ['dsh-better-edit'])
  const { impl, calls } = scriptedSpawn({
    output: 'Progress: resolved 1, reused 0, downloaded 1, added 1, done\n',
    // The run is what installs it; the tree is read again afterwards.
    onSpawn: () => {
      const file = path.join(profile, 'node_modules', '@deepseek-ai', 'dsh-toolkit', 'package.json')
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, `{"name":"${missingName}"}\n`)
    },
  })
  const outcome = await healProfileDependencies(options(profile, impl))
  assert.equal(outcome.status, 'healed')
  assert.deepEqual(outcome.missing, [missingName])
  assert.equal(calls.length, 1)
  // The exact invocation the market uses, plus the per-run release-age lift
  // (without it a profile pinning a version inside the cooldown cannot be
  // repaired at all — see release-age.ts in plugin-market).
  assert.deepEqual(calls[0].args, [
    'D:/kernel/app/node_modules/@deepseek-ai/dsh/lib/bin.js',
    'plugin',
    '--profile',
    'dsh-app',
    'install',
    '--config.minimumReleaseAge=0',
  ])
  // cwd = the profile, a real Node, no console window (a child spawned from
  // Electron must never pop a terminal onto the user's desktop).
  assert.equal(calls[0].options.cwd, profile)
  assert.equal(calls[0].executable, 'D:/kernel/node/node.exe')
  assert.equal(calls[0].options.windowsHide, true)
  // DSH_HOME is PINNED to the home this profile lives under, never inherited.
  // The CLI resolves `--profile dsh-app` as `$DSH_HOME/profiles/dsh-app`, so an
  // inherited home would aim the repair at a different profile and report
  // "Already up to date" about THAT one while this profile stays broken —
  // measured while building this step, against the real CLI.
  assert.equal(calls[0].options.env.DSH_HOME, path.dirname(path.dirname(profile)))
  assert.match(healLogLine(outcome, profile), /reinstalled them/u)
})

test('a run that reports success without restoring the package is still a failure', async (t) => {
  // The measured trap: pnpm answered "Already up to date" while the packages
  // were missing, so a zero exit proves nothing on its own.
  const profile = fakeProfile(scratch(t), { 'dsh-better-edit': '1.0.3' })
  const { impl, calls } = scriptedSpawn({ output: 'Already up to date\nDone in 0.4s\n' })
  const outcome = await healProfileDependencies(options(profile, impl))
  assert.equal(outcome.status, 'unrepairable')
  assert.equal(calls.length, 1)
  assert.match(outcome.detail, /still does not resolve/u)
})

test('a failing run is captured, redacted and swallowed', async (t) => {
  const profile = fakeProfile(scratch(t), { 'dsh-better-edit': '^9.9.9' })
  const { impl, calls } = scriptedSpawn({
    code: 1,
    output: 'ERR_PNPM_NO_MATCHING_VERSION  No matching version found\nregistry token=sk-secret-value\n',
  })
  const outcome = await healProfileDependencies(options(profile, impl))
  assert.equal(outcome.status, 'unrepairable')
  assert.equal(calls.length, 1)
  assert.match(outcome.detail, /exit code 1/u)
  assert.match(outcome.detail, /NO_MATCHING_VERSION/u)
  // The durable log line never carries the credential the output contained.
  const line = healLogLine(outcome, profile)
  assert.doesNotMatch(line, /sk-secret-value/u)
  assert.match(line, /token=\[redacted\]/u)
})

test('a spawn that cannot start is reported, never thrown', async (t) => {
  const profile = fakeProfile(scratch(t), { 'dsh-better-edit': '^1.0.0' })
  const impl = () => { throw new Error('spawn node ENOENT') }
  const outcome = await healProfileDependencies(options(profile, impl))
  assert.equal(outcome.status, 'unrepairable')
  assert.match(outcome.detail, /ENOENT/u)
})

test('a run that never finishes is terminated instead of hanging the boot', async (t) => {
  const profile = fakeProfile(scratch(t), { 'dsh-better-edit': '^1.0.0' })
  // A REAL child that outlives the deadline: the kill path (taskkill /T /F on
  // Windows, a signal elsewhere) is the property under test, and a stand-in
  // could not show whether the process is really gone. The child writes a marker
  // after the deadline — if the kill missed, the file appears.
  const marker = path.join(profile, 'survived.txt')
  const sleeper = path.join(profile, 'never-finishes.cjs')
  writeFileSync(sleeper, `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 1200)\n`)
  const outcome = await healProfileDependencies({
    profileDir: profile,
    profileName: 'dsh-app',
    dshHome: path.dirname(path.dirname(profile)),
    bin: sleeper,
    node: process.execPath,
    timeoutMs: 300,
  })
  assert.equal(outcome.status, 'unrepairable')
  assert.match(outcome.detail, /did not finish within \d+ seconds and was terminated/u)
  assert.deepEqual(outcome.missing, ['dsh-better-edit'])
  // The step answered rather than throwing: that is what keeps a failed repair
  // from taking the boot down with it.
  assert.match(healLogLine(outcome, profile), /could not be repaired/u)
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 1500) })
  assert.equal(existsSync(marker), false)
})

test('a manifest that cannot be read and a name that is not a dependency run nothing', async (t) => {
  // A profile with no manifest at all: nothing is declared, so nothing is
  // missing. This is the state right after seeding removed a half-built
  // directory, and it must not send the shell looking for a package manager.
  const bare = scratch(t)
  const { impl, calls } = scriptedSpawn({})
  assert.deepEqual(await missingDependencies(bare), [])
  assert.equal((await healProfileDependencies(options(bare, impl))).status, 'ok')
  assert.equal(calls.length, 0)
  // A key that is not a package name is not a dependency a package manager
  // could act on, so it is skipped rather than forwarded as argv.
  const odd = fakeProfile(scratch(t), { 'not a package name': '1.0.0', './local-path': 'file:./x' })
  assert.deepEqual(await missingDependencies(odd), [])
  assert.equal((await healProfileDependencies(options(odd, impl))).status, 'ok')
  assert.equal(calls.length, 0)
  // A scoped name is looked up as `@scope/name`, not as one directory segment:
  // the manifest key is what a package manager installs, and the check has to
  // agree with where it lands.
  const scoped = fakeProfile(scratch(t), { '@deepseek-ai/dsh-toolkit': '^0.2.1' })
  assert.deepEqual(await missingDependencies(scoped), ['@deepseek-ai/dsh-toolkit'])
  assert.equal(readFileSync(path.join(scoped, 'package.json'), 'utf8').includes('dsh-toolkit'), true)
})
