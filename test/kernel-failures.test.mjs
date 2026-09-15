// Layered failure wording for a kernel download: the class decides the ACTION a
// user should take, so both the classification and the wording are pinned here.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { classifyDownloadFailure, describeDownloadFailure } = require('../dist/kernel/failures.js')
const { initLocale, t } = require('../dist/shared/locale.js')

test('a digest mismatch is never classified as a plain network problem', () => {
  // The one case where "retry" is the wrong advice: something in the path
  // changed the bytes, so the wording must say so rather than send the user
  // back to the same mirror.
  const kind = classifyDownloadFailure(new Error('完整性校验失败（期望 abc…，实际 def…）'))
  assert.equal(kind, 'integrity')
  const text = describeDownloadFailure(kind, 4, '完整性校验失败（期望 abc…，实际 def…）')
  assert.match(text, /已中止以防被篡改/u)
  assert.ok(!text.includes('请稍后重试'), 'integrity failures must not read as a transient error')
})

test('an HTTP answer without the artifact is "not published yet", not "offline"', () => {
  assert.equal(classifyDownloadFailure(new Error('下载失败：HTTP 404')), 'missing')
  assert.equal(classifyDownloadFailure(new Error('下载失败：HTTP 410')), 'missing')
  assert.equal(classifyDownloadFailure(new Error('未找到 dsh 0.1.5 的运行时产物')), 'missing')
  const text = describeDownloadFailure('missing', 4, '下载失败：HTTP 404')
  assert.match(text, /尚未发布/u)
  assert.match(text, /托盘/u, 'the action for this window is the manual re-check')
})

test('no answer at all is reported as unreachable, with the tried source count', () => {
  assert.equal(classifyDownloadFailure(new Error('fetch failed')), 'network')
  assert.equal(classifyDownloadFailure(new TypeError('fetch failed', { cause: 'ECONNREFUSED' })), 'network')
  assert.equal(classifyDownloadFailure(null), 'network', 'no error at all still needs a sentence')
  const text = describeDownloadFailure('network', 3, 'fetch failed')
  assert.match(text, /3 个来源/u)
  assert.match(text, /代理/u)
})

test('the raw cause is preserved for support, and absent when there is none', () => {
  assert.match(describeDownloadFailure('network', 3, 'fetch failed'), /原因：fetch failed/u)
  assert.ok(!describeDownloadFailure('network', 3, null).includes('原因：'))
  assert.ok(!describeDownloadFailure('network', 3, '').includes('原因：'))
})

test('a 5xx is a source-side fault, so it stays a network classification', () => {
  // A mirror answering 503 is not evidence the artifact is missing — the same
  // policy the artifact resolver applies when probing.
  assert.equal(classifyDownloadFailure(new Error('下载失败：HTTP 503')), 'network')
})

test('an en-US run classifies the lines that run threw, in that language', (ctx) => {
  // The patterns come from the table, not from a copy of the wording, so the
  // same failures must classify identically after the language changes. A
  // zh-only classifier would report a tampered download as "check your
  // network" — the one misclassification this module exists to prevent.
  const before = process.env.DSH_APP_LOCALE
  ctx.after(() => {
    if (before === undefined) delete process.env.DSH_APP_LOCALE
    else process.env.DSH_APP_LOCALE = before
    initLocale()
  })
  process.env.DSH_APP_LOCALE = 'en-US'
  initLocale()

  const integrity = new Error(t('kernel.integrityFailed', { expected: 'abc', actual: 'def' }))
  assert.equal(classifyDownloadFailure(integrity), 'integrity')
  const text = describeDownloadFailure('integrity', 4, integrity.message)
  assert.match(text, /aborted to prevent tampering/u)
  assert.equal(
    classifyDownloadFailure(new Error(t('kernel.artifactMissing', { version: '1.0.0', platform: 'win32', arch: 'x64' }))),
    'missing')
  assert.equal(classifyDownloadFailure(new Error(t('kernel.downloadHttpFailed', { status: 503 }))), 'network')
  assert.match(describeDownloadFailure('network', 3, 'fetch failed'), /3 sources tried/u)
})
