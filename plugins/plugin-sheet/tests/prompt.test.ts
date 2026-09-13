/**
 * The system-prompt contract: the unconditional entry rule always names the
 * workflow, and the mode directive is injected only for a session that has the
 * mode on (the same session id the tools use), never for an agent-less
 * assembly.
 *
 * @module @dsh-app/plugin-sheet/tests/prompt
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sheetDefaultSectionText, sheetModeSectionText } from '../src/prompt.ts'

test('prompt: the entry rule always routes spreadsheet requests to the workflow', () => {
  const text = sheetDefaultSectionText()
  assert.match(text, /^## Excel \/ 表格请求/mu)
  for (const needle of ['sheet_write', 'sheet_check', 'sheet_render', '.xlsx', '禁止编造']) {
    assert.ok(text.includes(needle), `entry rule mentions ${needle}`)
  }
})

test('prompt: the mode directive is injected per session and pins the workflow order', () => {
  const on = sheetModeSectionText(() => true, { agent: { session: { header: { id: 's1' } } } })
  assert.match(on, /^## 表格生成模式（本会话已启用）/mu)
  for (const needle of ['用途与列定义', 'sheet_write', 'sheet_check', 'sheet_render', 'numberFormat',
    '单位', '禁止编造数据', '示例']) {
    assert.ok(on.includes(needle), `mode directive mentions ${needle}`)
  }
  // The workflow order is the authoring contract, not a suggestion.
  assert.ok(on.indexOf('sheet_write') < on.indexOf('sheet_check'))
  assert.ok(on.indexOf('sheet_check') < on.indexOf('sheet_render'))
})

test('prompt: a session with the mode off and an agent-less assembly inject nothing', () => {
  assert.equal(sheetModeSectionText(() => false, { agent: { session: { header: { id: 's1' } } } }), '')
  assert.equal(sheetModeSectionText(() => true, { agent: { session: { header: {} } } }), '')
  assert.equal(sheetModeSectionText(() => true, {}), '')
  assert.equal(sheetModeSectionText(() => true, { agent: {} }), '')
})
