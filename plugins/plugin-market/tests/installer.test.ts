/**
 * Installer-side tests: the pnpm build-scripts-blocked detection (signal
 * recognition across pnpm 10/11 wordings and a Chinese variant, package-name
 * extraction from the two documented message shapes, grammar filtering of
 * free-form log text, dedupe, and the no-signal null), plus the release-age
 * policy around the CLI run — the per-run override is part of the run itself,
 * the profile's own configuration is never written, and the failure paths
 * (blocked builds, plain failures, a policy failure the override did not clear)
 * are reported rather than retried.
 *
 * @module plugin-market/tests/installer
 */

import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { spawn } from 'node:child_process'
import { MarketBlockedBuildError, MarketExecutionError } from '../src/errors.ts'
import { PluginInstaller, blockedBuildsOf } from '../src/installer.ts'

describe('blockedBuildsOf', () => {
  it('answers null when no blocked signal is present', () => {
    assert.equal(blockedBuildsOf(''), null)
    assert.equal(blockedBuildsOf('packages: + dsh-remote 0.1.0\nDone in 4.2s\n'), null)
    // Similar but non-matching wording must not trip the signal.
    assert.equal(blockedBuildsOf('build scripts ran for dsh-remote\n'), null)
  })

  it('reads the pnpm 10 ignored-list form, sentence tail cut off', () => {
    assert.deepEqual(
      blockedBuildsOf('Ignored build scripts: esbuild. Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts'),
      ['esbuild'],
    )
    assert.deepEqual(blockedBuildsOf('Ignored build scripts: esbuild, node-gyp'), ['esbuild', 'node-gyp'])
    assert.deepEqual(
      blockedBuildsOf('Ignored build scripts: esbuild, node-gyp.\n'),
      ['esbuild', 'node-gyp'],
    )
  })

  it('reads the pnpm 11 parenthesized form', () => {
    assert.deepEqual(
      blockedBuildsOf('build scripts are blocked by pnpm by default (dsh-remote); use Allow build scripts and retry to approve and reinstall'),
      ['dsh-remote'],
    )
  })

  it('reads a Chinese message with full-width parentheses', () => {
    assert.deepEqual(blockedBuildsOf('构建脚本被 pnpm 拦截（dsh-remote）；请放行构建脚本后重试'), ['dsh-remote'])
    // Signal without a parseable name: blocked (empty list), never null.
    assert.deepEqual(blockedBuildsOf('构建脚本被 pnpm 拦截'), [])
  })

  it('dedupes across repeated messages and filters non-package names', () => {
    const output = [
      'Ignored build scripts: esbuild, esbuild',
      'Ignored build scripts: has space, ok-pkg',
      'build scripts are blocked by pnpm by default (esbuild)',
    ].join('\n')
    assert.deepEqual(blockedBuildsOf(output), ['esbuild', 'ok-pkg'])
  })
})

/** One scripted CLI invocation: the exit code and the output it prints. */
interface ScriptedRun {
  readonly code: number
  readonly output: string
}

/**
 * A `spawn` stand-in playing a fixed script of runs: each call consumes the
 * next entry (the last one repeats, so a test that must not retry can assert
 * the call count instead of running out of script).
 */
function scriptedSpawn(runs: readonly ScriptedRun[]): { impl: typeof spawn, calls: string[][] } {
  const calls: string[][] = []
  const impl = (_executable: string, args: readonly string[]): unknown => {
    const run = runs[Math.min(calls.length, runs.length - 1)]!
    calls.push([...args])
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter, stderr: EventEmitter, pid: number }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 1000 + calls.length
    setImmediate(() => {
      child.stdout.emit('data', run.output)
      child.emit('close', run.code)
    })
    return child
  }
  return { impl: impl as unknown as typeof spawn, calls }
}

describe('PluginInstaller release-age policy', () => {
  let home: string
  let profileDir: string
  let workspacePath: string
  let previousHome: string | undefined
  let previousBin: string | undefined

  const WORKSPACE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
  /** A lockfile the market must never rewrite itself: pnpm owns this file. */
  const LOCKFILE = "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n"

  let lockfilePath: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-market-installer-'))
    profileDir = join(home, 'profiles', 'dsh-app')
    workspacePath = join(profileDir, 'pnpm-workspace.yaml')
    lockfilePath = join(profileDir, 'pnpm-lock.yaml')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(workspacePath, WORKSPACE, 'utf8')
    writeFileSync(lockfilePath, LOCKFILE, 'utf8')
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    // The CLI path the shell normally exports; the spawn itself is scripted,
    // so a stand-in file is enough to pin it inside the temp home.
    previousBin = process.env.DSH_APP_DSH_BIN
    const bin = join(home, 'bin.js')
    writeFileSync(bin, '', 'utf8')
    process.env.DSH_APP_DSH_BIN = bin
  })
  afterEach(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousBin === undefined) delete process.env.DSH_APP_DSH_BIN
    else process.env.DSH_APP_DSH_BIN = previousBin
    rmSync(home, { recursive: true, force: true })
  })

  /** Write the profile manifest a recovery run reads its candidates from. */
  function manifest(dependencies: Record<string, string>): void {
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-dsh-app', private: true, dependencies }), 'utf8')
  }

  it('passes the per-run override on the first run', async () => {
    manifest({ 'dsh-plugin-x': '0.7.3' })
    const spawnImpl = scriptedSpawn([{ code: 0, output: 'dependencies:\n- dsh-plugin-x 0.7.3\nDone in 1.2s\n' }])
    const installer = new PluginInstaller('dsh-app', undefined, spawnImpl.impl, () => {})

    const result = await installer.uninstall('dsh-plugin-x')

    // One run, the policy lifted for it: the override first, the command intact
    // behind it.
    assert.equal(spawnImpl.calls.length, 1, 'no second run')
    assert.deepEqual(spawnImpl.calls[0]!.slice(-3), ['--config.minimumReleaseAge=0', 'remove', 'dsh-plugin-x'])
    assert.equal(readFileSync(workspacePath, 'utf8'), WORKSPACE, 'the profile keeps its own policy')
    assert.equal(readFileSync(lockfilePath, 'utf8'), LOCKFILE, 'and its lockfile: only pnpm owns that file')
    assert.ok(result.output.includes('Done in 1.2s'), 'the run output is what the panel shows')
  })

  it('carries the override for a lockfile the exclusions cannot clear', async () => {
    manifest({ 'dsh-context': '0.53.2' })
    // The profile's own exclude list is present and must come out unchanged: the
    // lockfile check ignores that list, so the override — not a written
    // exclusion — is what clears this one.
    writeFileSync(workspacePath, `${WORKSPACE}minimumReleaseAgeExclude:\n  - dsh-context@0.53.2\n`, 'utf8')
    const spawnImpl = scriptedSpawn([{ code: 0, output: 'Already up to date\nDone in 900ms\n' }])
    const installer = new PluginInstaller('dsh-app', undefined, spawnImpl.impl, () => {})

    await installer.uninstall('dsh-context')

    assert.equal(spawnImpl.calls.length, 1)
    assert.deepEqual(spawnImpl.calls[0]!.slice(-3), ['--config.minimumReleaseAge=0', 'remove', 'dsh-context'])
    assert.equal(
      readFileSync(workspacePath, 'utf8'),
      `${WORKSPACE}minimumReleaseAgeExclude:\n  - dsh-context@0.53.2\n`,
      'the run writes nothing',
    )
    assert.equal(readFileSync(lockfilePath, 'utf8'), LOCKFILE, 'the lockfile is left alone too')
  })

  it('names the policy even when a blocked-builds signal shares the output', async () => {
    manifest({ 'dsh-plugin-x': '0.7.3' })
    const spawnImpl = scriptedSpawn([{
      code: 1,
      output: [
        'Ignored build scripts: esbuild. Run "pnpm approve-builds" to pick which dependencies should be allowed',
        '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:',
        '',
      ].join('\n'),
    }])
    const lines: string[] = []
    const installer = new PluginInstaller('dsh-app', undefined, spawnImpl.impl, (message) => lines.push(message))

    await assert.rejects(installer.uninstall('dsh-plugin-x'), (error: unknown) => {
      // The blocked-builds error is the actionable one and keeps its precedence.
      assert.ok(error instanceof MarketBlockedBuildError)
      assert.deepEqual(error.blockedBuilds, ['esbuild'])
      return true
    })
    assert.ok(lines.some((line) => line.includes('release-age policy rejected')))
  })

  it('runs the command once: a failure is reported, not re-run', async () => {
    manifest({ 'dsh-plugin-x': '0.7.3' })
    const spawnImpl = scriptedSpawn([{ code: 1, output: 'npm ERR! 404 Not Found\n' }])
    const installer = new PluginInstaller('dsh-app', undefined, spawnImpl.impl, () => {})

    await assert.rejects(installer.uninstall('dsh-plugin-x'), MarketExecutionError)
    assert.equal(spawnImpl.calls.length, 1)
    assert.equal(readFileSync(workspacePath, 'utf8'), WORKSPACE, 'nothing was written')
  })

  it('names a release-age failure the override did not clear', async () => {
    manifest({ 'dsh-plugin-x': '0.7.3' })
    const spawnImpl = scriptedSpawn([
      { code: 1, output: '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:\n  dsh-plugin-x@0.7.3 was published recently\n' },
    ])
    const lines: string[] = []
    const installer = new PluginInstaller('dsh-app', undefined, spawnImpl.impl, (message) => lines.push(message))

    await assert.rejects(installer.uninstall('dsh-plugin-x'), MarketExecutionError)

    assert.equal(spawnImpl.calls.length, 1)
    assert.ok(
      lines.some((line) => line.includes('release-age policy rejected')),
      'the log names the policy instead of leaving pnpm\'s output to speak alone',
    )
  })

  it('still reports blocked build scripts through their own error', async () => {
    manifest({})
    const spawnImpl = scriptedSpawn([
      { code: 1, output: 'Ignored build scripts: esbuild. Run "pnpm approve-builds" to pick which dependencies should be allowed\n' },
    ])
    const installer = new PluginInstaller('dsh-app', undefined, spawnImpl.impl, () => {})

    await assert.rejects(installer.installSpec('dsh-remote', '^0.1.0'), (error: unknown) => {
      assert.ok(error instanceof MarketBlockedBuildError)
      assert.deepEqual(error.blockedBuilds, ['esbuild'])
      return true
    })
    assert.equal(spawnImpl.calls.length, 1)
  })
})
