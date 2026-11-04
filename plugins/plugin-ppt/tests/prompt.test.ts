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
  modeStateFrom,
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

test('prompt: a brand colour arrives as a finished theme block, not as an instruction to compute colours', () => {
  // The model must not derive six hex values from one brand colour: the host already
  // did that in OKLCH and gated it on contrast (`palette.ts`). What the directive has
  // to carry is the exact block to paste plus the measured ratios, so a reviewer can
  // check the claim instead of trusting it.
  const text = renderPptModeText('dsh-signal', 'Signal', { brand: '#1e2bfa' })
  assert.ok(text.includes('品牌色'), 'the section is present')
  assert.ok(text.includes('color') === false || text.includes('theme.colors'), 'the block names the field it replaces')
  const derived = /    accent: "(#[0-9a-f]{6})"/u.exec(text)
  assert.ok(derived !== null, 'the derived accent is printed as a pasteable YAML line')
  assert.ok(text.includes('不要自己改色值'), 'the model is told not to re-derive it')
  assert.ok(/实测对比度：正文 \d/u.test(text), 'the measured ratios are stated')
  // Six slots, each quoted: an unquoted hex parses as a number in YAML.
  const slots = text.match(/^ {4}(?:background|text|accent|surface|secondary|muted): "#[0-9a-f]{6}"$/gmu) ?? []
  assert.equal(slots.length, 6, 'all six theme colours are printed')
})

test('prompt: a chosen colourway replaces the colours but keeps the layout, and says so', () => {
  // Decoupling the two axes is the whole point: the page geometry still comes from the
  // template, so the directive has to say that explicitly or the model reads "a new
  // colour" as "a new template".
  const text = renderPptModeText('dsh-slate-grid', 'Slate Grid', { palette: 'lemon' })
  assert.ok(text.includes('## 配色：柠檬黄（Lemon）'))
  assert.ok(text.includes('版式仍按所选模板的骨架排'))
  assert.equal((text.match(/^ {4}(?:background|text|accent|surface|secondary|muted): "#[0-9a-f]{6}"$/gmu) ?? []).length, 6)
  // The loud accent is published as a block colour, not offered as an ink.
  assert.ok(text.includes('色块用色'), 'a sub-3:1 accent is named as a fill, not as text')
})

test('prompt: the brand colour outranks a chosen colourway, and only one block is printed', () => {
  const text = renderPptModeText('dsh-slate-grid', 'Slate Grid', { brand: '#1e2bfa', palette: 'ikb' })
  assert.ok(text.includes('## 品牌色'))
  assert.ok(!text.includes('## 配色：克莱因蓝'), 'the losing source does not also land in the prompt')
  assert.equal((text.match(/^ {4}accent: "/gmu) ?? []).length, 1, 'exactly one theme block')
})

test('prompt: the template own colours print no colour section at all', () => {
  const text = renderPptModeText('dsh-slate-grid', 'Slate Grid')
  assert.ok(!text.includes('## 品牌色') && !text.includes('## 配色：'))
})

test('prompt: the store→state adapter carries the colours, so the provider cannot silently drop them', () => {
  // Measured end of a real session: the tool recorded the brand colour, and the
  // provider still said nothing about it — because the state object was written inline
  // at the registration site and listed only `enabled` and `template`. The model then
  // asked the user again for a colour it had already been given.
  const store = {
    isEnabled: () => true,
    templateOf: () => 'dsh-signal',
    brandOf: () => '#c0392b',
    paletteOf: () => null,
  }
  const state = modeStateFrom(store, 'live')
  assert.equal(state.brand, '#c0392b', 'the brand travels with the state')
  const section = pptModeSectionText(
    sessionId => modeStateFrom(store, sessionId),
    () => 'Signal',
    { agent: { session: { header: { id: 'live' } } } },
  )
  assert.ok(section.includes('## 品牌色'), 'and the section prints the derived block')
  assert.match(section, /accent: "#c0392b"/u)
})

test('prompt: 常规主题 carries the session colours too', () => {
  // Measured in a real session: the colour block lived only in the TEMPLATE branch, so
  // a session with a brand colour and no template (常规主题 — which is what the capsule
  // sets when you just turn it on) received the paper default in the prompt. The deck
  // still came out right, because the tool result carried the colours — the model was
  // reading them out of the tool answer, not out of its instructions.
  const section = pptModeSectionText(
    (): PptModeState => ({ enabled: true, template: null, brand: '#c0392b', palette: null }),
    () => undefined,
    { agent: { session: { header: { id: 'live' } } } },
  )
  assert.ok(section.includes('常规主题'), 'the free-mode directive is still the base')
  assert.ok(section.includes('## 品牌色'), 'and the brand block is appended to it')
  assert.match(section, /accent: "#c0392b"/u)
  assert.match(section, /正文 16\.6:1/u, 'the measured ratio travels with it')

  const withColourway = pptModeSectionText(
    (): PptModeState => ({ enabled: true, template: null, brand: null, palette: 'ikb' }),
    () => undefined,
    { agent: { session: { header: { id: 'live' } } } },
  )
  assert.ok(withColourway.includes('## 配色：克莱因蓝'), 'a colourway reaches free mode as well')

  const plain = pptModeSectionText(
    (): PptModeState => ({ enabled: true, template: null }),
    () => undefined,
    { agent: { session: { header: { id: 'live' } } } },
  )
  assert.ok(!plain.includes('## 品牌色') && !plain.includes('## 配色：'), 'no colours, no block')
})

test('prompt: no brand colour means no brand section', () => {
  // A template's own palette is a designed choice; adding an empty "品牌色" heading
  // would tell the model to look for a value that does not exist.
  const withoutBrand = renderPptModeText('dsh-signal', 'Signal')
  assert.ok(!withoutBrand.includes('品牌色'))
  const section = pptModeSectionText(
    (): PptModeState => ({ enabled: true, template: 'dsh-signal', brand: null }),
    () => 'Signal',
    { agent: { session: { header: { id: 'live' } } } },
  )
  assert.ok(section.includes('dsh-signal'))
  assert.ok(!section.includes('品牌色'))
})
