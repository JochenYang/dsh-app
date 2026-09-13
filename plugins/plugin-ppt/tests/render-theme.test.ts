/**
 * The theme guarantee: the session's chosen template must steer the output
 * even when the document never wrote a theme. The chain runs exactly what
 * the render tool runs — store → catalog → synthesized theme → effective
 * project → slide XML — plus the refusal path of the render gate.
 *
 * @module @dsh-app/plugin-ppt/tests/render-theme
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PptModeStore } from '../src/mode-store.ts'
import { allTemplates, PAPER_THEME, templateById, templatePptdTheme } from '../src/templates.ts'
import { applyFallbackTheme, renderPptdProject } from '../src/pptd/render.ts'
import { loadPptdProject } from '../src/pptd/load.ts'
import type { PptdProject } from '../src/pptd/types.ts'

/** Minimal ZIP reader: enough to pull slide XML out of a .pptx (deflate). */
function readZipEntry(bytes: Uint8Array, name: string): string | undefined {
  const buffer = Buffer.from(bytes)
  let offset = 0
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const flags = buffer.readUInt16LE(offset + 6)
    const method = buffer.readUInt16LE(offset + 8)
    const compressedSize = buffer.readUInt32LE(offset + 18)
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const entryName = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
    const dataStart = offset + 30 + nameLength + extraLength
    if (entryName === name) {
      const raw = buffer.subarray(dataStart, dataStart + compressedSize)
      if (method === 0) return raw.toString('utf8')
      if (method === 8 && (flags & 0x08) === 0) return inflateRawSync(raw).toString('utf8')
      return undefined
    }
    offset = (flags & 0x08) === 0 ? dataStart + compressedSize : dataStart
    while (offset < buffer.length && buffer.readUInt32LE(offset) !== 0x04034b50) offset += 1
  }
  return undefined
}

/** A theme-less two-page deck: silent page background, colorless text run. */
async function themelessProject(): Promise<{ project: PptdProject, done: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'pptd-theme-test-'))
  mkdirSync(join(dir, 'pages'), { recursive: true })
  writeFileSync(join(dir, 'deck.pptd'), [
    'version: v2',
    'title: 主题兜底',
    'size: [960, 540]',
    'pages:',
    '  - pages/01.page',
  ].join('\n'), 'utf8')
  writeFileSync(join(dir, 'pages', '01.page'), [
    'pageType: cover',
    'elements:',
    '  - elementId: headline',
    '    elementType: text',
    '    bounds: [64, 190, 800, 60]',
    '    content: {text: 关键决策, fontSize: 44}',
  ].join('\n'), 'utf8')
  const project = await loadPptdProject(dir)
  return { project, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('theme: template metadata synthesizes a valid PPTD theme map', async () => {
  const entry = await templateById('dsh-signal')
  assert.ok(entry !== undefined, 'dsh-signal ships with the plugin')
  const theme = templatePptdTheme(entry.meta)
  const colors = theme.colors as Record<string, string>
  assert.equal(colors.background, '#1c2644')
  assert.equal(colors.text, '#e2dcd0')
  assert.equal(colors.accent, '#c8a870')
  const title = (theme.textStyles as Record<string, Record<string, unknown>>).title
  assert.equal(title.color, '$text')
  assert.ok(title.fontFamily !== undefined)
})

test('theme: a document that wrote a theme keeps it; a silent one takes the fallback', async () => {
  const fallback = { colors: { background: '#112233' } }
  const authored = { theme: { colors: { background: '#445566' } }, pages: [] } as unknown as PptdProject
  assert.equal(applyFallbackTheme(authored, fallback), authored, 'authored theme is untouched')
  const silent = { theme: {}, pages: [] } as unknown as PptdProject
  const effective = applyFallbackTheme(silent, fallback)
  assert.notEqual(effective, silent)
  assert.deepEqual(effective.theme, fallback)
  assert.equal(applyFallbackTheme(silent, undefined), silent, 'no fallback is a no-op')
})

test('theme: rendering a theme-less deck with the session template colors the slide XML', async () => {
  // The exact chain the render tool runs: mode store → catalog → theme map.
  const storeDir = mkdtempSync(join(tmpdir(), 'pptd-theme-store-'))
  const { project, done } = await themelessProject()
  try {
    const store = new PptModeStore(join(storeDir, 'mode.json'))
    store.set('session-a', 'dsh-signal')
    const templateId = store.templateOf('session-a')
    assert.equal(templateId, 'dsh-signal')
    const entry = await templateById(templateId)
    assert.ok(entry !== undefined)
    const fallbackTheme = templatePptdTheme(entry.meta)

    const rendered = await renderPptdProject(project, { fallbackTheme })
    const slide1 = readZipEntry(rendered.bytes, 'ppt/slides/slide1.xml')
    assert.ok(slide1 !== undefined)
    assert.ok(slide1.includes('val="1C2644"'), 'slide background carries the template palette')
    assert.ok(slide1.includes('val="E2DCD0"'), 'colorless text takes the template text color')

    // Control: without the fallback the same deck falls back to white/black.
    const bare = await renderPptdProject(project)
    const bareSlide = readZipEntry(bare.bytes, 'ppt/slides/slide1.xml')
    assert.ok(bareSlide !== undefined)
    assert.ok(bareSlide.includes('val="FFFFFF"'), 'no theme → white background')
    assert.ok(bareSlide.includes('val="000000"'), 'no theme → black text')
  } finally {
    done()
    rmSync(storeDir, { recursive: true, force: true })
  }
})

test('theme: an authored theme wins over the fallback in the produced XML', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pptd-theme-owned-'))
  try {
    mkdirSync(join(dir, 'pages'), { recursive: true })
    writeFileSync(join(dir, 'deck.pptd'), [
      'version: v2',
      'title: 自带主题',
      'size: [960, 540]',
      'theme:',
      '  colors:',
      '    background: "#204060"',
      '    text: "#112233"',
      'pages:',
      '  - pages/01.page',
    ].join('\n'), 'utf8')
    writeFileSync(join(dir, 'pages', '01.page'), [
      'pageType: cover',
      'elements:',
      '  - elementId: headline',
      '    elementType: text',
      '    bounds: [64, 190, 800, 60]',
      '    content: {text: 关键决策, fontSize: 44}',
    ].join('\n'), 'utf8')
    const project = await loadPptdProject(dir)
    const entry = await templateById('dsh-signal')
    assert.ok(entry !== undefined)
    const rendered = await renderPptdProject(project, { fallbackTheme: templatePptdTheme(entry.meta) })
    const slide1 = readZipEntry(rendered.bytes, 'ppt/slides/slide1.xml')
    assert.ok(slide1 !== undefined)
    assert.ok(slide1.includes('val="204060"'), 'authored background wins')
    assert.ok(!slide1.includes('val="1C2644"'), 'fallback palette must not leak in')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('theme: sessions without a template fall back to the paper default', async () => {
  // The exact chain the render tool runs for a mode-less session:
  // templateOf → null → the paper default theme.
  const { project, done } = await themelessProject()
  try {
    const colors = PAPER_THEME.colors as Record<string, string>
    assert.equal(colors.background, '#FDFAE7', 'paper is the warm-paper palette')
    assert.ok(colors.accent !== undefined && colors.text !== undefined)

    const rendered = await renderPptdProject(project, { fallbackTheme: PAPER_THEME })
    const slide1 = readZipEntry(rendered.bytes, 'ppt/slides/slide1.xml')
    assert.ok(slide1 !== undefined)
    assert.ok(slide1.includes('val="FDFAE7"'), 'paper background colors the slide')
    assert.ok(slide1.includes('val="111111"'), 'colorless text takes the paper text color')
  } finally {
    done()
  }
})

test('theme: the render gate refuses an overflowing deck even with a fallback theme', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pptd-theme-gate-'))
  try {
    mkdirSync(join(dir, 'pages'), { recursive: true })
    writeFileSync(join(dir, 'deck.pptd'), ['version: v2', 'size: [960, 540]', 'pages:', '  - pages/01.page'].join('\n'), 'utf8')
    writeFileSync(join(dir, 'pages', '01.page'), [
      'pageType: content',
      'elements:',
      '  - elementId: tight',
      '    elementType: text',
      '    bounds: [36, 20, 60, 15]',
      '    content: {text: 一段完全放不下的长文案, fontSize: 18}',
    ].join('\n'), 'utf8')
    const project = await loadPptdProject(dir)
    const entry = await templateById('dsh-signal')
    assert.ok(entry !== undefined)
    await assert.rejects(
      renderPptdProject(project, { fallbackTheme: templatePptdTheme(entry.meta) }),
      /渲染要求先通过校验/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('theme: every bundled template synthesizes a check-clean theme map', async () => {
  const templates = await allTemplates()
  assert.ok(templates.length >= 6)
  for (const { meta } of templates) {
    const theme = templatePptdTheme(meta)
    const colors = theme.colors as Record<string, unknown>
    assert.ok(Object.keys(colors).length >= 3, `${meta.id} exposes its palette`)
    for (const value of Object.values(colors)) {
      assert.match(value as string, /^#[0-9a-f]{6}$/u, `${meta.id} palette colors are valid hex`)
    }
  }
})
