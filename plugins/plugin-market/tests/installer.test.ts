/**
 * Installer-side tests for the pnpm build-scripts-blocked detection: signal
 * recognition across pnpm 10/11 wordings and a Chinese variant, package-name
 * extraction from the two documented message shapes, grammar filtering of
 * free-form log text, dedupe, and the no-signal null.
 *
 * @module plugin-market/tests/installer
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { blockedBuildsOf } from '../src/installer.ts'

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
