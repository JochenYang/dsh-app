/**
 * End-to-end PPTD → PPTX rendering: a real two-page deck authored against a
 * bundled template's layout (cover with two separate copy lines + a content
 * page with a table) is checked, rendered, and the produced .pptx is
 * unzipped and asserted at the slide-XML level — distinct per-element
 * offsets (no stacking), native table rows, and editable text runs.
 *
 * @module @dsh-app/plugin-ppt/tests/pptd-render
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPptdProject } from '../src/pptd/check.ts'
import { loadPptdProject } from '../src/pptd/load.ts'
import { renderPptdProject } from '../src/pptd/render.ts'

/** Minimal ZIP reader: enough to pull slide XML out of a .pptx (deflate). */
function readZipEntry(bytes: Uint8Array, name: string): string | undefined {
  const buffer = Buffer.from(bytes)
  // Walk local file headers from the start; pptxgenjs writes them back to back.
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
      // Bit 3 (0x08) means sizes live in a data descriptor — not produced here.
      if (method === 0) return raw.toString('utf8')
      if (method === 8 && (flags & 0x08) === 0) return inflateRawSync(raw).toString('utf8')
      return undefined
    }
    offset = (flags & 0x08) === 0 ? dataStart + compressedSize : dataStart
    // With data descriptors the size follows the payload; scanning forward
    // via the next signature keeps the reader bounded.
    while (offset < buffer.length && buffer.readUInt32LE(offset) !== 0x04034b50) offset += 1
  }
  return undefined
}

function extractAll(bytes: Uint8Array): Map<string, string> {
  const entries = new Map<string, string>()
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
    if ((flags & 0x08) === 0) {
      const raw = buffer.subarray(dataStart, dataStart + compressedSize)
      entries.set(entryName, method === 0 ? raw.toString('utf8') : inflateRawSync(raw).toString('utf8'))
      offset = dataStart + compressedSize
    } else {
      let next = dataStart
      while (next < buffer.length && buffer.readUInt32LE(next) !== 0x04034b50) next += 1
      offset = next
    }
  }
  return entries
}

/** All `<a:off x=.. y=..>` values inside one slide XML. */
function slideOffsets(xml: string): { x: number, y: number }[] {
  return [...xml.matchAll(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/gu)]
    .map(match => ({ x: Number(match[1]), y: Number(match[2]) }))
}

test('render: a two-page template-styled deck exports with distinct element geometry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pptd-render-test-'))
  try {
    // Cover layout follows the bundled blue-professional source (split
    // bounds per line, so the historical single-box stacking is impossible).
    mkdirSync(join(dir, 'pages'), { recursive: true })
    writeFileSync(join(dir, 'deck.pptd'), [
      'version: v2',
      'title: 排版验证',
      'size: [960, 540]',
      'template:',
      '  id: dsh-blue-professional',
      '  name: Blue Professional',
      'pages:',
      '  - pages/01.page',
      '  - pages/02.page',
    ].join('\n'), 'utf8')
    writeFileSync(join(dir, 'pages', '01.page'), [
      'pageType: cover',
      'background: {type: solid, color: "#FDFAE7"}',
      'elements:',
      '  - elementId: headline',
      '    elementType: text',
      '    bounds: [36, 150, 460, 135]',
      '    content:',
      '      text: |\n        市场展望与\n        战略优先级',
      '      fontFamily: {latin: Arial, ea: Noto Sans CJK SC, mac: PingFang SC, win: Microsoft YaHei}',
      '      fontSize: 38',
      '      color: "#111111"',
      '      bold: true',
      '  - elementId: subtitle',
      '    elementType: text',
      '    bounds: [36, 311, 450, 50]',
      '    content: {text: 二〇二六年第一季度评审, fontSize: 15, color: "#333333"}',
      '  - elementId: date-line',
      '    elementType: text',
      '    bounds: [36, 506, 300, 16]',
      '    content: {text: 内部资料 · 示例数据, fontSize: 7, color: "#666666"}',
    ].join('\n'), 'utf8')
    writeFileSync(join(dir, 'pages', '02.page'), [
      'pageType: content',
      'background: {type: solid, color: "#FFFFFF"}',
      'elements:',
      '  - elementId: page-title',
      '    elementType: text',
      '    bounds: [36, 20, 600, 30]',
      '    content: {text: 指标概览, fontSize: 24, color: "#111111", bold: true}',
      '  - elementId: table',
      '    elementType: table',
      '    bounds: [36, 80, 888, 240]',
      '    columnWidths: [0.4, 0.3, 0.3]',
      '    rowHeights: [0.34, 0.33, 0.33]',
      '    rows:',
      '      - [{text: 指标, bold: true}, {text: 本期, bold: true}, {text: 上期, bold: true}]',
      '      - [营收, "1,280 万", "1,050 万"]',
      '      - [毛利率, "34.5%", "31.2%"]',
    ].join('\n'), 'utf8')

    const project = await loadPptdProject(dir)
    const check = checkPptdProject(project)
    assert.equal(check.errorCount, 0, `clean deck must have no errors: ${JSON.stringify(check.issues.filter(i => i.severity === 'error'))}`)

    const rendered = await renderPptdProject(project)
    assert.ok(rendered.bytes.byteLength > 10_000, 'non-trivial pptx produced')
    assert.equal(rendered.nativeObjectCount, 5)

    const entries = extractAll(rendered.bytes)
    const slide1 = entries.get('ppt/slides/slide1.xml')
    const slide2 = entries.get('ppt/slides/slide2.xml')
    assert.ok(slide1 !== undefined && slide1.length > 0, 'slide1 XML present')
    assert.ok(slide2 !== undefined && slide2.length > 0, 'slide2 XML present')

    // Layout repair evidence 1: every element has its own offset; the three
    // cover text blocks can never share a position.
    const offsets1 = slideOffsets(slide1)
    assert.ok(offsets1.length >= 3, `cover has 3+ positioned shapes (got ${offsets1.length})`)
    const seen = new Set<string>()
    for (const offset of offsets1) {
      const key = `${offset.x},${offset.y}`
      assert.ok(!seen.has(key), `offsets unique on cover (duplicate ${key})`)
      seen.add(key)
    }
    for (const text of ['市场展望与', '战略优先级', '二〇二六年第一季度评审', '内部资料']) {
      assert.ok(slide1.includes(text), `cover keeps editable run: ${text}`)
    }

    // Layout repair evidence 2: the table is a native graphicFrame with
    // explicit row heights and grid columns — cell copy cannot overlap.
    assert.ok(slide2.includes('<a:tbl>'), 'native table element present')
    const rowHeights = [...slide2.matchAll(/<a:tr h="(\d+)"/gu)].map(match => Number(match[1]))
    assert.equal(rowHeights.length, 3)
    assert.ok(rowHeights.every(height => height > 0))
    const gridCols = [...slide2.matchAll(/<a:gridCol w="(\d+)"/gu)].map(match => Number(match[1]))
    assert.equal(gridCols.length, 3)
    for (const cell of ['指标', '营收', '1,280 万', '毛利率']) {
      assert.ok(slide2.includes(cell), `table cell text present: ${cell}`)
    }

    // Single-entry read of one slide keeps the zip reader honest.
    const single = readZipEntry(rendered.bytes, 'ppt/slides/slide1.xml')
    assert.ok(single !== undefined && single.includes('市场展望与'))

    // Deck metadata: the presentation references exactly two slides.
    const presentation = entries.get('ppt/presentation.xml')
    assert.ok(presentation !== undefined)
    const slideRefs = [...presentation.matchAll(/<p:sldId /gu)]
    assert.equal(slideRefs.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('render: refuses to export a project whose check fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pptd-render-fail-'))
  try {
    mkdirSync(join(dir, 'pages'), { recursive: true })
    writeFileSync(join(dir, 'deck.pptd'), ['version: v2', 'size: [960, 540]', 'pages:', '  - pages/01.page'].join('\n'), 'utf8')
    writeFileSync(join(dir, 'pages', '01.page'), [
      'pageType: content',
      'elements:',
      '  - elementId: body',
      '    elementType: text',
      '    bounds: [48, 120, 120, 40]',
      `    content: {text: ${JSON.stringify('超长文本'.repeat(30))}, fontSize: 18}`,
    ].join('\n'), 'utf8')
    const project = await loadPptdProject(dir)
    await assert.rejects(() => renderPptdProject(project), /校验/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
