/**
 * The professional table layout: caption block, auto widths, inferred number
 * formats, banding, total-row emphasis, frozen header and the readability
 * rules the checker adds on top of the structural ones.
 *
 * The rendered workbook is asserted twice: through exceljs (merged ranges,
 * fills, alignment, widths, number formats, borders) and by unzipping the
 * .xlsx to look at the styles part directly, so a style that only exists in
 * the in-memory model cannot pass.
 *
 * @module @dsh-app/plugin-sheet/tests/sheet-style
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import { Workbook } from 'exceljs'
import { checkSheetWorkbook, parseSheetWorkbook } from '../src/sheet/check.ts'
import { renderSheetWorkbook } from '../src/sheet/render.ts'
import type { SheetCheckResult, SheetIssue, SheetWorkbook } from '../src/sheet/types.ts'

/** ZIP member names and contents, walking the local file headers. */
function readZip(bytes: Uint8Array): Map<string, string> {
  const buffer = Buffer.from(bytes)
  const entries = new Map<string, string>()
  let offset = 0
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const flags = buffer.readUInt16LE(offset + 6)
    const method = buffer.readUInt16LE(offset + 8)
    const compressedSize = buffer.readUInt32LE(offset + 18)
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
    const dataStart = offset + 30 + nameLength + extraLength
    if ((flags & 0x08) === 0) {
      const raw = buffer.subarray(dataStart, dataStart + compressedSize)
      entries.set(name, method === 0 ? raw.toString('utf8') : inflateRawSync(raw).toString('utf8'))
      offset = dataStart + compressedSize
    } else {
      let next = dataStart
      while (next < buffer.length && buffer.readUInt32LE(next) !== 0x04034b50) next += 1
      offset = next
    }
  }
  return entries
}

/** One document with a caption block, three shapes of column and a total row. */
function styledDocument(): Record<string, unknown> {
  return {
    title: '2026 年一季度经营数据',
    subtitle: '单位：万元',
    notes: '数据来源：用户材料；同比为示例占位。',
    style: { tabColor: '2F6F4F' },
    sheets: [{
      name: '分月营收',
      columns: [
        { header: '月份' },
        { header: '营收（万元）' },
        { header: 'Revenue', width: 30 },
        { header: '同比' },
        { header: '日期' },
        { header: '备注' },
      ],
      rows: [
        ['1 月', 1280, 1280, '12.8%', '2026-01-31', '正常'],
        ['2 月', 1050.5, 1050.5, '8.3%', '2026-02-28', 42],
        ['合计', null, null, null, null, null],
      ],
      formulas: { B4: '=SUM(B2:B3)', R4C3: '=SUM(C2:C3)' },
    }],
  }
}

function firstIssue(result: SheetCheckResult, code: string): SheetIssue {
  const issue = result.issues.find(candidate => candidate.code === code)
  assert.ok(issue !== undefined, `expected an issue with code ${code}, got ${result.issues.map(i => i.code).join(',')}`)
  return issue
}

test('render: caption block, light header and merged title reach the model', async () => {
  const analysis = parseSheetWorkbook(styledDocument())
  assert.equal(analysis.errorCount, 0)
  const workbook = analysis.workbook as SheetWorkbook
  assert.ok(workbook !== undefined)
  assert.equal(workbook.subtitle, '单位：万元')
  assert.equal(workbook.notes, '数据来源：用户材料；同比为示例占位。')
  assert.equal(workbook.style?.tabColor, '2F6F4F')

  const rendered = await renderSheetWorkbook(workbook)
  const wb = new Workbook()
  await wb.xlsx.load(rendered.bytes as unknown as ArrayBuffer)
  const sheet = wb.getWorksheet('分月营收')
  assert.ok(sheet !== undefined)

  // Caption block: title / subtitle / notes / spacer, header on row 5.
  assert.equal(sheet.getCell('A1').value, '2026 年一季度经营数据')
  assert.equal(sheet.getCell('A1').font.size, 14)
  assert.equal(sheet.getCell('A1').font.bold, true)
  assert.equal(sheet.getCell('A1').isMerged, true)
  assert.equal(sheet.getCell('F1').isMerged, true)
  assert.equal(sheet.getCell('A2').value, '单位：万元')
  assert.equal(sheet.getCell('A2').font.size, 9)
  assert.equal(sheet.getCell('A3').value, '数据来源：用户材料；同比为示例占位。')
  assert.equal(sheet.getCell('A3').font.size, 9)
  assert.equal(sheet.getRow(4).height, 8)
  assert.equal(sheet.getCell('A5').value, '月份')
  assert.equal(sheet.getCell('A2').isMerged, true)

  // Header: neutral light fill, dark bold text, 24pt row, medium bottom rule.
  // Alignment follows the column's data: the text column left, the amount right.
  const header = sheet.getCell('A5')
  assert.equal(header.font.bold, true)
  assert.equal(header.font.color?.argb, 'FF0F172A')
  assert.equal((header.fill as { fgColor?: { argb?: string } }).fgColor?.argb, 'FFF1F5F9')
  assert.equal(header.alignment.horizontal, 'left')
  assert.equal(header.alignment.vertical, 'middle')
  assert.equal(sheet.getCell('B5').alignment.horizontal, 'right')
  assert.equal(sheet.getRow(5).height, 24)
  assert.equal(header.border.bottom?.style, 'medium')
  assert.equal(header.border.bottom?.color?.argb, 'FF334155')
  assert.equal(sheet.views.some(view => view.state === 'frozen' && view.ySplit === 5), true)
  assert.equal(sheet.views.some(view => view.showGridLines === false), true)
  assert.equal(sheet.pageSetup.printArea, 'A1:F8')
  assert.equal(sheet.properties.tabColor?.argb, 'FF2F6F4F')

  // Auto width for the unset columns; the explicit width wins where given.
  assert.equal(sheet.getColumn(1).width, 6)
  assert.equal(sheet.getColumn(2).width, 14)
  assert.equal(sheet.getColumn(3).width, 30)
  assert.equal(sheet.getColumn(4).width, 7)
  assert.equal(sheet.getColumn(5).width, 12)
  assert.equal(sheet.getColumn(6).width, 6)

  // Inferred formats and the value normalization they require.
  assert.equal(sheet.getCell('B6').numFmt, '#,##0.0;[Red](#,##0.0);"-"')
  assert.equal(sheet.getCell('B6').alignment.horizontal, 'right')
  assert.equal(sheet.getCell('D6').numFmt, '0.0%')
  assert.equal(sheet.getCell('D6').value, 0.128)
  assert.equal(sheet.getCell('E6').numFmt, 'yyyy-mm-dd')
  const date = sheet.getCell('E6').value
  assert.ok(date instanceof Date)
  assert.equal(date.getUTCFullYear(), 2026)
  assert.equal(date.getUTCMonth(), 0)
  assert.equal(date.getUTCDate(), 31)
  assert.equal(sheet.getCell('A6').alignment.horizontal, 'left')
  // A mixed column keeps its values and gets no guessed format.
  assert.equal(sheet.getCell('F6').value, '正常')
  assert.equal(sheet.getCell('F7').value, 42)
  assert.notEqual(sheet.getCell('F7').numFmt, '#,##0.0;[Red](#,##0.0);"-"')

  // Zebra needs more than seven detail rows; with two it stays off, and the
  // total row is never banded.
  const stripeFill = sheet.getCell('A7').fill as { fgColor?: { argb?: string } }
  assert.notEqual(stripeFill.fgColor?.argb, 'FFF8FAFC')

  // Total row: bold with a medium top rule and the palette's emphasis fill.
  assert.equal(sheet.getCell('A8').value, '合计')
  assert.equal(sheet.getCell('A8').font.bold, true)
  assert.equal(sheet.getCell('A8').border.top?.style, 'medium')
  assert.equal(sheet.getCell('A8').border.top?.color?.argb, 'FF334155')
  const totalFill = sheet.getCell('A8').fill as { fgColor?: { argb?: string } }
  assert.equal(totalFill.fgColor?.argb, 'FFE2E8F0')

  // Formulas move with the grid: target row and body references both shift.
  const sum: unknown = sheet.getCell('B8').value
  assert.ok(typeof sum === 'object' && sum !== null && 'formula' in sum)
  assert.equal((sum as { formula: string }).formula, 'SUM(B6:B7)')
  const average: unknown = sheet.getCell('C8').value
  assert.ok(typeof average === 'object' && average !== null && 'formula' in average)
  assert.equal((average as { formula: string }).formula, 'SUM(C6:C7)')

  // --- raw styles part, so a model-only style cannot pass ------------------
  const entries = readZip(rendered.bytes)
  const styles = entries.get('xl/styles.xml') ?? ''
  assert.ok(styles.includes('FFF1F5F9'), 'neutral header fill is written')
  assert.ok(styles.includes('FFE2E8F0'), 'hairline/border color is written')
  assert.ok(styles.includes('#,##0.0'), 'inferred fixed-decimal format is written')
  assert.ok(styles.includes('[Red]'), 'the negative section is written')
  assert.ok(styles.includes('0.0%'), 'inferred percent format is written')
  assert.ok(styles.includes('yyyy-mm-dd'), 'inferred date format is written')
  const sheetXml = entries.get('xl/worksheets/sheet1.xml') ?? ''
  assert.ok(sheetXml.includes('<mergeCell'), 'merged caption range is written')
  assert.ok(sheetXml.includes('ySplit="5"'), 'frozen split covers the caption block')
  assert.ok(sheetXml.includes('showGridLines="0"'), 'gridlines are off for the styled table')
})

/** Nine detail rows: past the zebra threshold so banding is actually drawn. */
function wideDocument(stripes: boolean | undefined): Record<string, unknown> {
  return {
    title: '斑马纹',
    ...(stripes === undefined ? {} : { style: { stripes } }),
    sheets: [{
      name: '明细',
      columns: [{ header: '名称' }, { header: '数量' }],
      rows: Array.from({ length: 9 }, (_value, index) => [`行${index + 1}`, index + 1]),
    }],
  }
}

test('render: stripes appear past seven rows and can be turned off', async () => {
  // Rows: title 1, spacer 2, header 3, detail 4–12. The second detail row is
  // the first banded one, the first detail row is plain.
  const striped = parseSheetWorkbook(wideDocument(undefined)).workbook as SheetWorkbook
  const renderedStriped = await renderSheetWorkbook(striped)
  const wbStriped = new Workbook()
  await wbStriped.xlsx.load(renderedStriped.bytes as unknown as ArrayBuffer)
  const stripedSheet = wbStriped.getWorksheet('明细')
  assert.ok(stripedSheet !== undefined)
  assert.equal((stripedSheet.getCell('A5').fill as { fgColor?: { argb?: string } }).fgColor?.argb, 'FFF8FAFC')
  assert.notEqual((stripedSheet.getCell('A4').fill as { fgColor?: { argb?: string } }).fgColor?.argb, 'FFF8FAFC')

  const plain = parseSheetWorkbook(wideDocument(false)).workbook as SheetWorkbook
  const renderedPlain = await renderSheetWorkbook(plain)
  const wbPlain = new Workbook()
  await wbPlain.xlsx.load(renderedPlain.bytes as unknown as ArrayBuffer)
  const plainSheet = wbPlain.getWorksheet('明细')
  assert.ok(plainSheet !== undefined)
  assert.notEqual((plainSheet.getCell('A5').fill as { fgColor?: { argb?: string } }).fgColor?.argb, 'FFF8FAFC')
})

test('check: readability limits flag wide tables, long headers and long ledgers', () => {
  const wide = checkSheetWorkbook({
    title: 't',
    sheets: [{ name: 'S', columns: Array.from({ length: 13 }, (_value, index) => ({ header: `列${index + 1}` })), rows: [] }],
  })
  const wideIssue = firstIssue(wide, 'too-many-columns-for-layout')
  assert.equal(wideIssue.severity, 'error')
  assert.match(wideIssue.message, /12 列/u)

  const longHeader = checkSheetWorkbook({
    title: 't',
    sheets: [{ name: 'S', columns: [{ header: 'x'.repeat(25) }], rows: [] }],
  })
  const headerIssue = firstIssue(longHeader, 'header-too-long')
  assert.equal(headerIssue.severity, 'error')
  assert.equal(headerIssue.column, 1)
  assert.match(headerIssue.message, /24 字/u)

  const longTable = checkSheetWorkbook({
    title: 't',
    sheets: [{ name: 'S', columns: [{ header: '序号' }], rows: Array.from({ length: 2_001 }, (_value, index) => [index]) }],
  })
  const longIssue = firstIssue(longTable, 'long-table')
  assert.equal(longIssue.severity, 'warning')
  assert.equal(longTable.errorCount, 0)
  assert.match(longIssue.message, /2000 行/u)
})

test('check: a total row needs detail above it, and text-only columns warn when dense', () => {
  const bare = checkSheetWorkbook({
    title: 't',
    sheets: [{ name: 'S', columns: [{ header: '名称' }, { header: '金额' }], rows: [['合计', 10]] }],
  })
  const totalIssue = firstIssue(bare, 'total-row-without-data')
  assert.equal(totalIssue.severity, 'warning')
  assert.equal(totalIssue.row, 2)
  assert.equal(totalIssue.cell, 'A2')
  assert.equal(bare.errorCount, 0)

  const backed = checkSheetWorkbook({
    title: 't',
    sheets: [{ name: 'S', columns: [{ header: '名称' }, { header: '金额' }], rows: [['甲', 1], ['乙', 2], ['合计', 3]] }],
  })
  assert.equal(backed.issues.some(issue => issue.code === 'total-row-without-data'), false)

  // 3 of 5 long cells is exactly 60% and stays quiet; 4 of 5 crosses the line.
  const atBoundary = checkSheetWorkbook({
    title: 't',
    sheets: [{ name: 'S', columns: [{ header: '说明' }], rows: [['x'.repeat(41)], ['x'.repeat(41)], ['x'.repeat(41)], ['ok'], ['ok']] }],
  })
  assert.equal(atBoundary.issues.some(issue => issue.code === 'text-heavy-column'), false)

  const dense = checkSheetWorkbook({
    title: 't',
    sheets: [{ name: 'S', columns: [{ header: '说明' }], rows: [['x'.repeat(41)], ['x'.repeat(41)], ['x'.repeat(41)], ['x'.repeat(41)], ['ok']] }],
  })
  const denseIssue = firstIssue(dense, 'text-heavy-column')
  assert.equal(denseIssue.severity, 'warning')
  assert.equal(denseIssue.column, 1)
  assert.equal(dense.errorCount, 0)
})

/** One document whose columns exercise every date round-trip outcome. */
function dateDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: '日期归一',
    sheets: [
      { name: '合规日期', columns: [{ header: '日期' }], rows: [['2024-01-31'], ['2024-02-29']] },
      { name: '越界日期', columns: [{ header: '日期' }], rows: [['2024.02.31']] },
      { name: '双位数年', columns: [{ header: '日期' }], rows: [['0001.1.1']] },
      { name: '混合列', columns: [{ header: '日期' }], rows: [['2024-01-31'], ['2024.02.31']] },
    ],
    ...overrides,
  }
}

test('check: a date column warns that its text will be normalized, exactly once', () => {
  const result = checkSheetWorkbook(dateDocument())
  assert.equal(result.errorCount, 0)
  assert.equal(result.status, 'warning')
  const conversions = result.issues.filter(issue => issue.code === 'date-text-conversion')
  assert.equal(conversions.length, 1, 'only the fully convertible column warns')
  const issue = conversions[0] as SheetIssue
  assert.equal(issue.severity, 'warning')
  assert.equal(issue.column, 1)
  assert.match(issue.message, /「日期」/u)
  assert.match(issue.message, /2 个日期文本将转为日期类型/u)
  assert.match(issue.message, /"dates": false/u)
})

test('render: date text only converts when the value round-trips exactly', async () => {
  const analysis = parseSheetWorkbook(dateDocument())
  assert.equal(analysis.errorCount, 0)
  const rendered = await renderSheetWorkbook(analysis.workbook as SheetWorkbook)
  const wb = new Workbook()
  await wb.xlsx.load(rendered.bytes as unknown as ArrayBuffer)

  // A column of real dates becomes dates under the date number format.
  const valid = wb.getWorksheet('合规日期')
  assert.ok(valid !== undefined)
  const validDate = valid.getCell('A4').value
  assert.ok(validDate instanceof Date)
  assert.equal(validDate.getUTCFullYear(), 2024)
  assert.equal(validDate.getUTCMonth() + 1, 1)
  assert.equal(validDate.getUTCDate(), 31)
  assert.equal(valid.getCell('A4').numFmt, 'yyyy-mm-dd')
  const leapDate = valid.getCell('A5').value
  assert.ok(leapDate instanceof Date)
  assert.equal(leapDate.getUTCMonth() + 1, 2)
  assert.equal(leapDate.getUTCDate(), 29)

  // 2024.02.31 would silently roll into March, so the cell keeps its text.
  const rolled = wb.getWorksheet('越界日期')
  assert.equal(rolled?.getCell('A4').value, '2024.02.31')
  assert.notEqual(rolled?.getCell('A4').numFmt, 'yyyy-mm-dd')

  // A four-digit year below 100 would become 19xx, so it stays text too.
  const early = wb.getWorksheet('双位数年')
  assert.equal(early?.getCell('A4').value, '0001.1.1')

  // One unconvertible cell keeps the whole column exactly as authored.
  const mixed = wb.getWorksheet('混合列')
  assert.equal(mixed?.getCell('A4').value, '2024-01-31')
  assert.equal(mixed?.getCell('A5').value, '2024.02.31')
  assert.notEqual(mixed?.getCell('A4').numFmt, 'yyyy-mm-dd')
})

test('render: style.dates false disables date conversion entirely', async () => {
  const analysis = parseSheetWorkbook(dateDocument({ style: { dates: false } }))
  assert.equal(analysis.errorCount, 0)
  assert.equal(analysis.issues.some(issue => issue.code === 'date-text-conversion'), false)
  const rendered = await renderSheetWorkbook(analysis.workbook as SheetWorkbook)
  const wb = new Workbook()
  await wb.xlsx.load(rendered.bytes as unknown as ArrayBuffer)
  const sheet = wb.getWorksheet('合规日期')
  assert.equal(sheet?.getCell('A4').value, '2024-01-31')
  assert.notEqual(sheet?.getCell('A4').numFmt, 'yyyy-mm-dd')
})

test('render: a named region is not shifted, a real reference is', async () => {
  const workbook: SheetWorkbook = {
    title: '公式偏移',
    sheets: [{
      name: '公式',
      columns: [{ header: '名称' }, { header: '数值' }, { header: '系数' }],
      rows: [['甲', 1, 1], ['乙', 2, 2], ['丙', 3, 3], [null, null, null]],
      formulas: { B4: '=SUM(B2:B3)', B5: '=Q1*2', C4: '=B2*C2' },
    }],
  }
  const rendered = await renderSheetWorkbook(workbook)
  const wb = new Workbook()
  await wb.xlsx.load(rendered.bytes as unknown as ArrayBuffer)
  const sheet = wb.getWorksheet('公式')
  assert.ok(sheet !== undefined)
  // `Q1` addresses a column outside this three-column sheet, so it is a named
  // region and left as authored.
  assert.equal((sheet.getCell('B7').value as { formula?: string }).formula, 'Q1*2')
  // Arguments and a range colon are real reference positions, so both shift.
  assert.equal((sheet.getCell('B6').value as { formula?: string }).formula, 'SUM(B4:B5)')
  // A reference that opens the expression still shifts (offset 2), and so does
  // the in-grid operand after `*`.
  assert.equal((sheet.getCell('C6').value as { formula?: string }).formula, 'B4*C4')
})
