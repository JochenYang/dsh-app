/**
 * The PPT-mode prompt section: the workflow directive pins the theme mandate
 * and the composition rules whenever the assembling session has PPT mode on,
 * the free-mode directive pins the no-template channel, and the section
 * disappears entirely when the mode is off.
 *
 * @module @dsh-app/plugin-ppt/tests/prompt
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pptDefaultSectionText,
  pptModeSectionText,
  renderPptFreeModeText,
  renderPptModeText,
} from '../src/prompt.ts'
import type { PptModeState } from '../src/prompt.ts'

test('prompt: the active-mode directive pins the theme mandate and the template', () => {
  const text = renderPptModeText('dsh-signal', 'Signal')
  assert.ok(text.includes('dsh-signal'))
  assert.ok(text.includes('Signal'))
  assert.ok(text.includes('theme.colors') && text.includes('theme.textStyles'), 'theme fields are mandated')
  assert.ok(text.includes('pptd_check') && text.includes('pptd_render'), 'workflow order is pinned')
  assert.ok(text.includes('封面只保留一条主信息'), 'cover rule is pinned')
  assert.ok(text.includes('needs_revision'), 'render refusal semantics are pinned')
})

test('prompt: the free-mode directive organizes by content and names the paper default', () => {
  const text = renderPptFreeModeText()
  assert.ok(text.includes('未选择模板'), 'the no-template channel is named')
  assert.ok(text.includes('按内容关系'), 'content-relationship organization is pinned')
  assert.ok(text.includes('paper'), 'the paper default theme is named')
  assert.ok(text.includes('pptd_check') && text.includes('pptd_render'), 'the same workflow is pinned')
  assert.ok(text.includes('质量门禁'), 'the shared gates are pinned')
})

test('prompt: the section provider answers only sessions with PPT mode on', () => {
  const modeOf = (sessionId: string): PptModeState => (
    sessionId === 'live' ? { enabled: true, template: 'dsh-signal' } : { enabled: false, template: null }
  )
  const templateNameOf = (id: string): string | undefined => (id === 'dsh-signal' ? 'Signal' : undefined)

  const on = pptModeSectionText(modeOf, templateNameOf, { agent: { session: { header: { id: 'live' } } } })
  assert.ok(on.includes('PPT 生成模式'))
  assert.ok(on.includes('Signal'))

  assert.equal(pptModeSectionText(modeOf, templateNameOf, { agent: { session: { header: { id: 'idle' } } } }), '')
  assert.equal(pptModeSectionText(modeOf, templateNameOf, {}), '', 'no agent → no section')
})

test('prompt: an on-without-template session gets the free-mode directive', () => {
  const modeOf = (): PptModeState => ({ enabled: true, template: null })
  const text = pptModeSectionText(modeOf, () => undefined, { agent: { session: { header: { id: 'live' } } } })
  assert.ok(text.includes('常规主题'))
  assert.ok(text.includes('未选择模板'))
  assert.ok(!text.includes('模板「'), 'no template directive is injected')
})

test('prompt: the natural-language entry rule applies to every assembly', () => {
  const text = pptDefaultSectionText()
  assert.ok(text.includes('PPT') && text.includes('演示文稿'), 'the trigger request is named')
  assert.ok(text.includes('dsh-ppt'), 'the skill is pinned')
  assert.ok(text.includes('pptd_check') && text.includes('pptd_render'), 'the workflow order is pinned')
  assert.ok(text.includes('paper'), 'the template-less default theme is named')
  assert.ok(text.includes('按内容关系'), 'the no-template free organization is pinned')
  assert.ok(text.includes('优先'), 'an explicit template choice keeps priority')
})
