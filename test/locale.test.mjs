// Locale table and resolution rules for the shell's user-visible strings.
//
// The two tables MUST cover the same keys: a language that is missing one falls
// back to nothing (t() throws), so a gap has to fail here rather than in a
// release build. The resolution tests pin the env override and the OS-tag rule,
// including the zh-* boundary cases a mainland-first app cares about.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_ENV,
  chooseLocale,
  getLocale,
  initLocale,
  messageHead,
  messagesFor,
  resolveLocale,
  t,
} = require('../dist/shared/locale.js')

/** The zh-CN key set, used as the reference for the other table. */
const referenceKeys = Object.keys(messagesFor('zh-CN'))

test('every locale exists and declares the same keys', () => {
  assert.deepEqual([...LOCALES].sort(), ['en-US', 'zh-CN'])
  for (const locale of LOCALES) {
    const keys = Object.keys(messagesFor(locale))
    assert.deepEqual(keys, referenceKeys, `${locale} must cover exactly the zh-CN key set`)
  }
})

test('no message is empty, whitespace-only or still a bare key', () => {
  for (const locale of LOCALES) {
    const table = messagesFor(locale)
    for (const [key, value] of Object.entries(table)) {
      assert.equal(typeof value, 'string', `${locale}:${key} must be a string`)
      assert.notEqual(value.trim(), '', `${locale}:${key} must not be blank`)
      assert.notEqual(value, key, `${locale}:${key} must not fall back to its own key`)
    }
  }
})

test('both tables use the same placeholders in the same message', () => {
  const zh = messagesFor('zh-CN')
  const en = messagesFor('en-US')
  const placeholders = (value) => [...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort()
  for (const key of referenceKeys) {
    assert.deepEqual(placeholders(en[key]), placeholders(zh[key]), `${key}: placeholder drift between languages`)
  }
})

test('resolveLocale maps a zh prefix to zh-CN and everything else to en-US', () => {
  for (const tag of ['zh', 'zh-CN', 'zh-cn', 'zh_TW', 'zh-TW', 'zh-Hans-CN', 'ZH-HANT', ' zh-CN ']) {
    assert.equal(resolveLocale(tag), 'zh-CN', tag)
  }
  for (const tag of ['en', 'en-US', 'en-GB', 'ja-JP', 'ko-KR', 'de-DE']) {
    assert.equal(resolveLocale(tag), 'en-US', tag)
  }
  // Nothing to map: the caller falls through to the next source.
  for (const tag of [undefined, null, '', '   ']) {
    assert.equal(resolveLocale(tag), null, String(tag))
  }
})

test('chooseLocale prefers the override, then the OS, then the default', () => {
  assert.equal(chooseLocale('en-US', 'zh-CN'), 'en-US', 'the override wins')
  assert.equal(chooseLocale('zh-CN', 'en-US'), 'zh-CN', 'the override wins both ways')
  assert.equal(chooseLocale('', 'zh-TW'), 'zh-CN', 'a blank override defers to the OS')
  assert.equal(chooseLocale(undefined, 'en-GB'), 'en-US', 'a non-zh OS tag is en-US')
  assert.equal(chooseLocale(undefined, undefined), DEFAULT_LOCALE, 'nothing to resolve falls back')
  assert.equal(DEFAULT_LOCALE, 'zh-CN', 'the product default is the primary market')
})

test('DSH_APP_LOCALE overrides the resolved locale for the process', (ctx) => {
  const before = process.env[LOCALE_ENV]
  ctx.after(() => {
    if (before === undefined) delete process.env[LOCALE_ENV]
    else process.env[LOCALE_ENV] = before
    initLocale()
  })
  process.env[LOCALE_ENV] = 'en-US'
  assert.equal(initLocale(), 'en-US')
  assert.equal(getLocale(), 'en-US')
  assert.equal(t('common.ok'), 'OK')
  assert.equal(t('updater.skipToast', { app: 'DSH APP', version: '0.12.0' }),
    'Skipped DSH APP 0.12.0; you will not be reminded automatically again')
  process.env[LOCALE_ENV] = ''
  assert.equal(initLocale(), DEFAULT_LOCALE, 'an empty override is ignored')
  assert.equal(t('common.ok'), '确定')
})

test('t() substitutes every placeholder and fails loudly otherwise', () => {
  assert.equal(t('tray.openApp', { app: 'DSH APP' }), '打开 DSH APP')
  assert.equal(t('status.ready'), '就绪')
  // A key outside the table (only reachable from untyped JS) must throw, not
  // come back as the key itself — that is how a missing translation would ship.
  assert.throws(() => t('nope.not.a.key'), /no message for key/u)
  // A template that needs params, asked for without any, must throw too.
  assert.throws(() => t('tray.openApp'), /needs params/u)
  assert.throws(() => t('tray.openApp', { nope: 1 }), /missing param "app"/u)
})

test('the zh-CN run keeps the wording the other suites pin', () => {
  const before = process.env[LOCALE_ENV]
  delete process.env[LOCALE_ENV]
  initLocale()
  assert.equal(getLocale(), DEFAULT_LOCALE, 'a plain node process resolves to zh-CN (no Electron locale)')
  assert.equal(t('status.ready'), '就绪')
  if (before !== undefined) process.env[LOCALE_ENV] = before
})

test('the kernel wording keeps the frozen zh-CN text the other suites pin', () => {
  // Spelled out rather than pattern-matched: test/kernel-*.test.mjs assert on
  // these lines through regexes, and the whole point of moving them into the
  // table was that the shipped zh text does not change at all. The composed
  // layer-index faults are included because they are assembled from two keys.
  const before = process.env[LOCALE_ENV]
  delete process.env[LOCALE_ENV]
  initLocale()
  try {
    assert.equal(
      t('kernel.integrityFailed', { expected: 'abc', actual: 'def' }),
      '完整性校验失败（期望 abc…，实际 def…）')
    assert.equal(
      t('kernel.layerIntegrityFailed', { name: 'dsh-1.tgz', expected: 'abc', actual: 'def' }),
      '层文件 dsh-1.tgz 完整性校验失败（期望 abc…，实际 def…）')
    assert.equal(
      t('kernel.layerMissing', { name: 'dsh-1.tgz', dir: 'D:/layers' }),
      '缺少层文件 dsh-1.tgz（层索引引用了它，但 D:/layers 中没有）')
    assert.equal(
      t('kernel.artifactPlatformMismatch', { artifactPlatform: 'darwin', artifactArch: 'arm64', platform: 'win32', arch: 'x64' }),
      '产物平台不匹配：darwin-arm64 与 win32-x64')
    assert.equal(
      t('kernel.layerIndex.platformMismatch', { indexPlatform: 'darwin', indexArch: 'arm64', platform: 'win32', arch: 'x64' }),
      '层索引平台不匹配：darwin-arm64 与 win32-x64')
    assert.equal(
      t('kernel.layerIndex.unreadable', { label: 'D:/layers/layers.json', detail: 'ENOENT' }),
      '无法读取层索引 D:/layers/layers.json：ENOENT')
    assert.equal(
      t('kernel.layerIndex.invalidJson', { label: 'D:/layers/layers.json', detail: 'boom' }),
      '层索引 D:/layers/layers.json 不是有效的 JSON：boom')
    // One entry fault, to cover the `{at}` prefix composition end to end.
    const at = t('kernel.layerIndex.entryAt', { label: 'layers.json', position: 2 })
    assert.equal(at, '层索引 layers.json 的第 2 层')
    assert.equal(t('kernel.layerIndex.notObject', { at }), '层索引 layers.json 的第 2 层 不是对象')
    // The splash status lines the kernel manager now produces.
    assert.equal(t('kernel.status.downloading', { version: '0.1.5-rc.2' }), '正在下载 dsh 0.1.5-rc.2…')
    assert.equal(t('kernel.status.extractingProgress', { done: 3, total: 10 }), '正在解压运行时…（3/10）')
    assert.equal(t('kernel.status.activating'), '正在激活运行时…')
  } finally {
    if (before === undefined) delete process.env[LOCALE_ENV]
    else process.env[LOCALE_ENV] = before
    initLocale()
  }
})

test('messageHead is the constant head of a template, in the current language', (ctx) => {
  // The kernel's download classifier recognizes its own lines through this, so
  // the shape (everything before the first `{param}`, no locale caching) is a
  // contract, not an implementation detail.
  const before = process.env[LOCALE_ENV]
  ctx.after(() => {
    if (before === undefined) delete process.env[LOCALE_ENV]
    else process.env[LOCALE_ENV] = before
    initLocale()
  })
  delete process.env[LOCALE_ENV]
  initLocale()
  assert.equal(messageHead('kernel.integrityFailed'), '完整性校验失败（期望 ')
  assert.equal(messageHead('kernel.artifactMissing'), '未找到 dsh ')
  assert.equal(messageHead('kernel.status.paused'), '已暂停下载', 'a template without params is its own head')
  process.env[LOCALE_ENV] = 'en-US'
  initLocale()
  assert.equal(messageHead('kernel.integrityFailed'), 'Integrity check failed (expected ')
  assert.throws(() => messageHead('nope.not.a.key'), /no message for key/u)
})
