/**
 * The table presentation contract: the fallback theme paints a visible
 * minimal grid (bold tinted header, hairline horizontal rules, a keyword-gated
 * total row, no vertical rules), numeric columns align right, values render
 * through the shared column formatter, and capacity is measured on the
 * formatted text so a `1280` that becomes `1,280.0` is caught before export.
 *
 * @module @dsh-app/plugin-ppt/tests/pptd-table
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { measureTextLayout } from '../src/text-layout.ts'
import { checkPptdProject, tableColumnRatios } from '../src/pptd/check.ts'
import { estimateColumnRatios, planColumnFormat } from '../src/pptd/number-format.ts'
import { loadPptdProject } from '../src/pptd/load.ts'
import { renderPptdProject } from '../src/pptd/render.ts'
import { PAPER_THEME } from '../src/templates.ts'

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

/** Every `<a:tc>` block of one slide, each carrying its text and cell properties. */
function tableCells(xml: string): string[] {
  return [...xml.matchAll(/<a:tc(?:\s[^>]*)?>[\s\S]*?<\/a:tc>/gu)].map(match => match[0])
}

function cellWith(cells: readonly string[], text: string): string {
  const found = cells.find(cell => cell.includes(text))
  assert.ok(found !== undefined, `cell containing ${text} exists`)
  return found
}

/** One single-page project holding the given table element YAML lines. */
function tableProject(table: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'pptd-table-test-'))
  mkdirSync(join(dir, 'pages'), { recursive: true })
  writeFileSync(join(dir, 'deck.pptd'), [
    'version: v2',
    'title: 表格规范',
    'size: [960, 540]',
    'pages:',
    '  - pages/01.page',
  ].join('\n'), 'utf8')
  writeFileSync(join(dir, 'pages', '01.page'), ['pageType: content', 'elements:', ...table].join('\n'), 'utf8')
  return dir
}

const GRID_HEAD = [
  '  - elementId: grid',
  '    elementType: table',
]

test('table: the fallback theme paints a header band, hairline rows and a keyword-gated total rule', async () => {
  const dir = tableProject([
    ...GRID_HEAD,
    '    bounds: [40, 60, 880, 300]',
    '    columnWidths: [0.4, 0.6]',
    '    rowHeights: [0.25, 0.25, 0.25, 0.25]',
    '    rows:',
    '      - [{text: 项目}, {text: 金额}]',
    '      - [{text: 甲}, {text: 1280}]',
    '      - [{text: 乙}, {text: 1050.5}]',
    '      - [{text: 合计}, {text: 2330.5}]',
  ])
  try {
    const project = await loadPptdProject(dir)
    const checked = checkPptdProject(project)
    assert.equal(checked.errorCount, 0, `styled table must not fail the check: ${JSON.stringify(checked.issues.filter(issue => issue.severity === 'error'))}`)
    const rendered = await renderPptdProject(project, { fallbackTheme: PAPER_THEME })
    const xml = readZipEntry(rendered.bytes, 'ppt/slides/slide1.xml')
    assert.ok(xml !== undefined)
    const cells = tableCells(xml)
    assert.equal(cells.length, 8, 'two columns over four rows')

    // Header: tinted fill + bold (F1F5F9 band, thick bottom rule). A numeric
    // column's header stays its own text, never the formatter's output.
    const header = cellWith(cells, '项目')
    assert.ok(header.includes('F1F5F9'), 'header cell carries the F1F5F9 fill')
    assert.ok(header.includes('b="1"'), 'header cell is bold')
    // Header defaults to 11pt over 10pt data, the same one-point step the other
    // three suites use.
    assert.ok(header.includes('sz="1100"'), `header renders at 11pt: ${header}`)
    assert.match(header, /lnB[^>]*><a:solidFill><a:srgbClr val="334155"/u, 'header has a medium bottom rule in the shared 334155')
    const amountHeader = cellWith(cells, '金额')
    assert.ok(amountHeader.includes('F1F5F9'), 'numeric column header keeps its label and band')
    assert.match(amountHeader, /algn="r"/u, 'numeric column header shares the data alignment')

    // Data: horizontal hairline only; no vertical rule on either side.
    const data = cellWith(cells, '1,280.0')
    assert.ok(data.includes('sz="1000"'), `data cell renders at 10pt: ${data}`)
    assert.match(data, /lnB[^>]*><a:solidFill><a:srgbClr val="E2E8F0"/u, 'data row bottom hairline')
    assert.match(data, /lnL[^>]*><a:noFill\/>/u, 'data cell has no left rule')
    assert.match(data, /lnR[^>]*><a:noFill\/>/u, 'data cell has no right rule')

    // Total row: keyword-gated, tinted and separated by a top medium rule.
    const total = cellWith(cells, '合计')
    assert.ok(total.includes('EEF2FF'), 'total row carries the EEF2FF fill')
    assert.ok(total.includes('b="1"'), 'total row is bold')
    assert.match(total, /lnT[^>]*><a:solidFill><a:srgbClr val="334155"/u, 'total row has a top medium rule in the shared 334155')

    // The spec forbids vertical rules anywhere in the table.
    assert.ok(!/<a:lnL[^>]*><a:solidFill/u.test(xml), 'no solid left rule in the deck')
    assert.ok(!/<a:lnR[^>]*><a:solidFill/u.test(xml), 'no solid right rule in the deck')

    // Formatting runs through the shared plan: same column, fixed decimals.
    assert.ok(xml.includes('1,280.0') && xml.includes('1,050.5'), 'values render grouped with the column decimal count')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('table: a numeric column aligns right and a text column aligns left, header included', async () => {
  const dir = tableProject([
    ...GRID_HEAD,
    '    bounds: [40, 60, 880, 200]',
    '    columnWidths: [0.4, 0.6]',
    '    rowHeights: [0.34, 0.33, 0.33]',
    '    rows:',
    '      - [{text: 项目}, {text: 金额}]',
    '      - [{text: 甲}, {text: 1280}]',
    '      - [{text: 乙}, {text: 1050.5}]',
  ])
  try {
    const rendered = await renderPptdProject(await loadPptdProject(dir))
    const xml = readZipEntry(rendered.bytes, 'ppt/slides/slide1.xml')
    assert.ok(xml !== undefined)
    const cells = tableCells(xml)
    assert.match(cellWith(cells, '金额'), /algn="r"/u, 'numeric header aligns right')
    assert.match(cellWith(cells, '1,280.0'), /algn="r"/u, 'numeric data aligns right')
    assert.match(cellWith(cells, '项目'), /algn="l"/u, 'text header aligns left')
    assert.match(cellWith(cells, '甲'), /algn="l"/u, 'text data aligns left')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('table: an explicit theme alignment still wins over the column profile', () => {
  const plan = planColumnFormat([1, 2, 3], '数值')
  assert.equal(plan.align, 'right')
  // A mixed column past the numeric share reads right; below it stays left.
  assert.equal(planColumnFormat([1, 2, '不适用'], '数值').align, 'right')
  assert.equal(planColumnFormat([1, '不适用', '不适用'], '数值').align, 'left')
})

test('table: the column formatter fixes decimals, groups thousands, marks zero and percents', () => {
  const amount = planColumnFormat([1280, 1050.5, 2330.5], '金额')
  assert.equal(amount.kind, 'number')
  assert.equal(amount.decimals, 1)
  assert.equal(amount.format(1280), '1,280.0')
  assert.equal(amount.format(1050.5), '1,050.5')
  assert.equal(amount.format(0), '-')
  assert.equal(amount.format(-1280.5), '(1,280.5)')

  const ratio = planColumnFormat([0.128, 0.05], '同比增长率')
  assert.equal(ratio.kind, 'percent')
  assert.equal(ratio.format(0.128), '12.8%')
  assert.equal(ratio.format(0.05), '5.0%')

  const date = planColumnFormat(['2024-01-05', '2024/2/3'], '日期')
  assert.equal(date.kind, 'date')
  assert.equal(date.format('2024/2/3'), '2024-02-03')
})

test('table: capacity is measured on the formatted text, so a grown number is caught before export', async () => {
  // At 28pt wide the raw `1280` fits on one line; `1,280.0` does not.
  const available = 28
  assert.equal(measureTextLayout({ text: '1280', width: available, height: 20, fontSize: 10 }).overflow, false)
  assert.equal(measureTextLayout({ text: '1,280.0', width: available, height: 20, fontSize: 10 }).overflow, true)

  const dir = tableProject([
    ...GRID_HEAD,
    '    bounds: [40, 60, 28, 20]',
    '    columnWidths: [1]',
    '    rowHeights: [0.34, 0.33, 0.33]',
    '    rows:',
    '      - [{text: 金额}]',
    '      - [{text: 1280}]',
    '      - [{text: 1050.5}]',
  ])
  try {
    const checked = checkPptdProject(await loadPptdProject(dir))
    const overflow = checked.issues.find(issue => issue.code === 'table-cell-overflow')
    assert.ok(overflow !== undefined, 'formatted overflow is refused')
    assert.equal(overflow.severity, 'error')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('table: missing columnWidths fall back to a content-derived ratio, not an even split', () => {
  const element = {
    rows: [
      ['标签', '说明'],
      ['甲', '这是一段明显更长的文本内容'],
    ],
  }
  const ratios = tableColumnRatios(element)
  assert.ok(ratios !== undefined)
  assert.equal(ratios.length, 2)
  assert.ok(ratios[1] > ratios[0], `long text column takes more width (${ratios[1]} > ${ratios[0]})`)
  assert.ok(Math.abs(ratios[0] + ratios[1] - 1) < 1e-9, 'ratios normalize to one')
  assert.equal(estimateColumnRatios([], []), undefined, 'nothing to measure → leave the split to pptxgenjs')
})

test('table: an explicit tableStyles entry wins over the built-in default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pptd-table-preset-'))
  try {
    mkdirSync(join(dir, 'pages'), { recursive: true })
    writeFileSync(join(dir, 'deck.pptd'), [
      'version: v2',
      'title: 自带表格样式',
      'size: [960, 540]',
      'theme:',
      '  colors:',
      '    text: "#111111"',
      '  tableStyles:',
      '    default:',
      '      firstRowStyle: {fill: "#F1F5F9"}',
      '    preset:',
      '      firstRowStyle: {fill: "#ABCDEF"}',
      'pages:',
      '  - pages/01.page',
    ].join('\n'), 'utf8')
    writeFileSync(join(dir, 'pages', '01.page'), [
      'pageType: content',
      'elements:',
      ...GRID_HEAD,
      '    bounds: [40, 60, 880, 200]',
      '    columnWidths: [1]',
      '    rowHeights: [0.5, 0.5]',
      '    style: $preset',
      '    rows:',
      '      - [{text: 金额}]',
      '      - [{text: 1280}]',
    ].join('\n'), 'utf8')
    const rendered = await renderPptdProject(await loadPptdProject(dir), { fallbackTheme: PAPER_THEME })
    const xml = readZipEntry(rendered.bytes, 'ppt/slides/slide1.xml')
    assert.ok(xml !== undefined)
    assert.ok(xml.includes('ABCDEF'), 'the referenced table style is applied')
    assert.ok(!xml.includes('F1F5F9'), 'the default entry is not substituted for an explicit reference')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('table: decimal-mismatch warns on two shapes and fails on three', async () => {
  const warnDir = tableProject([
    ...GRID_HEAD,
    '    bounds: [40, 60, 880, 200]',
    '    columnWidths: [1]',
    '    rowHeights: [0.34, 0.33, 0.33]',
    '    rows:',
    '      - [{text: 金额}]',
    '      - [{text: 1280}]',
    '      - [{text: 1050.5}]',
  ])
  const failDir = tableProject([
    ...GRID_HEAD,
    '    bounds: [40, 60, 880, 240]',
    '    columnWidths: [1]',
    '    rowHeights: [0.25, 0.25, 0.25, 0.25]',
    '    rows:',
    '      - [{text: 金额}]',
    '      - [{text: 1}]',
    '      - [{text: 1.5}]',
    '      - [{text: 1.25}]',
  ])
  try {
    const warned = checkPptdProject(await loadPptdProject(warnDir))
    const warning = warned.issues.find(issue => issue.code === 'decimal-mismatch')
    assert.equal(warning?.severity, 'warning')
    assert.equal(warned.errorCount, 0)

    const failed = checkPptdProject(await loadPptdProject(failDir))
    const error = failed.issues.find(issue => issue.code === 'decimal-mismatch')
    assert.equal(error?.severity, 'error')
    assert.equal(failed.status, 'fail')
  } finally {
    rmSync(warnDir, { recursive: true, force: true })
    rmSync(failDir, { recursive: true, force: true })
  }
})

test('table: a ratio column written as true decimals warns; percent text does not', async () => {
  const rawDir = tableProject([
    ...GRID_HEAD,
    '    bounds: [40, 60, 880, 200]',
    '    columnWidths: [1]',
    '    rowHeights: [0.34, 0.33, 0.33]',
    '    rows:',
    '      - [{text: 同比增长率}]',
    '      - [{text: 0.128}]',
    '      - [{text: 0.05}]',
  ])
  const textDir = tableProject([
    ...GRID_HEAD,
    '    bounds: [40, 60, 880, 200]',
    '    columnWidths: [1]',
    '    rowHeights: [0.34, 0.33, 0.33]',
    '    rows:',
    '      - [{text: 同比增长率}]',
    '      - [{text: "12.8%"}]',
    '      - [{text: "5.0%"}]',
  ])
  try {
    const raw = checkPptdProject(await loadPptdProject(rawDir))
    const warning = raw.issues.find(issue => issue.code === 'percent-column-format')
    assert.equal(warning?.severity, 'warning')
    assert.ok(warning?.message.includes('12.8%'), `message shows the rendered percent: ${warning?.message}`)

    const text = checkPptdProject(await loadPptdProject(textDir))
    assert.ok(!text.issues.some(issue => issue.code === 'percent-column-format'), 'percent text is already written as a percent')
  } finally {
    rmSync(rawDir, { recursive: true, force: true })
    rmSync(textDir, { recursive: true, force: true })
  }
})

test('table: a large-magnitude column without a unit warns; a unit in the header clears it', async () => {
  const bareDir = tableProject([
    ...GRID_HEAD,
    '    bounds: [40, 60, 880, 200]',
    '    columnWidths: [1]',
    '    rowHeights: [0.34, 0.33, 0.33]',
    '    rows:',
    '      - [{text: 金额}]',
    '      - [{text: 12800}]',
    '      - [{text: 15000}]',
  ])
  const unitDir = tableProject([
    ...GRID_HEAD,
    '    bounds: [40, 60, 880, 200]',
    '    columnWidths: [1]',
    '    rowHeights: [0.34, 0.33, 0.33]',
    '    rows:',
    '      - [{text: 金额（万元）}]',
    '      - [{text: 12800}]',
    '      - [{text: 15000}]',
  ])
  try {
    const bare = checkPptdProject(await loadPptdProject(bareDir))
    const warning = bare.issues.find(issue => issue.code === 'missing-unit')
    assert.equal(warning?.severity, 'warning')
    assert.ok(warning?.message.includes('单位'), 'message names the missing unit')

    const unit = checkPptdProject(await loadPptdProject(unitDir))
    assert.ok(!unit.issues.some(issue => issue.code === 'missing-unit'), 'a header unit clears the warning')
  } finally {
    rmSync(bareDir, { recursive: true, force: true })
    rmSync(unitDir, { recursive: true, force: true })
  }
})
