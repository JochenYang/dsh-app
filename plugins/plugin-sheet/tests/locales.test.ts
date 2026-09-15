/**
 * The plugin's client dictionary: the namespace it owns, the parity of the two
 * locale tables, and the zh copy as the source of truth. The wording asserted
 * here is the pre-i18n copy verbatim — this is the regression guard that a later
 * edit cannot quietly reword what users already read.
 *
 * @module @dsh-app/plugin-sheet/tests/locales
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NS, en, zh } from '../src/client/locales.ts'

test('locale: the plugin owns one namespace and both tables carry its keys', () => {
  assert.equal(NS, 'dsh-app.sheet')
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  assert.deepEqual(Object.keys(zh).sort(), [
    'capsule.hintOff',
    'capsule.hintOffPending',
    'capsule.hintOn',
    'capsule.label',
    'capsule.pendingNotice',
    'capsule.skillHint',
  ])
})

test('locale: the English table is English and keeps the zh placeholders', () => {
  for (const [key, value] of Object.entries(en)) {
    assert.doesNotMatch(value, /[\p{Script=Han}]/u, `${key} still carries Han characters`)
    assert.equal(value.trim(), value, `${key} is padded`)
    assert.notEqual(value, '', `${key} is empty`)
    // A translation that drops a placeholder silently loses the substitution.
    for (const placeholder of zh[key as keyof typeof zh].match(/\{(\w+)\}/g) ?? []) {
      assert.ok(value.includes(placeholder), `${key} lost ${placeholder}`)
    }
  }
})

test('locale: the zh table is the pre-i18n copy, wording included', () => {
  assert.equal(zh['capsule.label'], 'Excel')
  assert.equal(zh['capsule.hintOff'], '点击开启表格模式')
  assert.equal(zh['capsule.hintOffPending'], '点击开启表格模式，将在会话开始后生效')
  assert.equal(zh['capsule.hintOn'], '点击关闭表格模式')
  assert.equal(zh['capsule.pendingNotice'], '将在会话开始后生效')
  assert.equal(zh['capsule.skillHint'], '已开启 {label} 模式；技能引用未能放入输入框，可手动输入 {token}')
})
