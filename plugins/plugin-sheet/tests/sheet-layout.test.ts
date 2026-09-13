/**
 * The reworked table look: formatting-aware column widths, fixed per-column
 * decimals, horizontal-only borders, data-following header alignment, the
 * three palettes and the presentation rules the checker adds.
 *
 * One end-to-end document (two numeric columns, a ratio column, a text column,
 * a total row and a long Chinese header) is rendered and asserted twice:
 * through exceljs (widths, formats, borders, alignment, fills, heights) and by
 * unzipping the .xlsx to inspect `xl/styles.xml`.
 *
 * @module @dsh-app/plugin-sheet/tests/sheet-layout
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import { Workbook } from 'exceljs'
import { checkSheetWorkbook, parseSheetWorkbook } from '../src/sheet/check.ts'
import { displayWidth } from '../src/sheet/format.ts'
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

async function renderDocument(document: Record<string, unknown>): Promise<Workbook> {
  const analysis = parseSheetWorkbook(document)
  assert.equal(analysis.errorCount, 0, analysis.issues.map(issue => issue.code).join(','))
  const rendered = await renderSheetWorkbook(analysis.workbook as SheetWorkbook)
  const wb = new Workbook()
  await wb.xlsx.load(rendered.bytes as unknown as ArrayBuffer)
  return wb
}

function fillArgb(cell: { fill?: unknown }): string | undefined {
  return (cell.fill as { fgColor?: { argb?: string } } | undefined)?.fgColor?.argb
}

function issueOf(result: SheetCheckResult, code: string): SheetIssue | undefined {
  return result.issues.find(issue => issue.code === code)
}

test('width: a long Chinese header and large numbers size the column, never squeeze it', async () => {
  const header = '营业收入同比增长率（千元）'
  assert.equal(displayWidth(header), 26, 'the header is the widest thing in its column')
  const wb = await renderDocument({
    title: '列宽',
    subtitle: '单位：万元',
    sheets: [{
      name: '宽列',
      columns: [{ header }, { header: '数值' }],
      rows: [['甲', 12_345_678], ['乙', 98_765_432], ['丙', 1_234_567]],
    }],
  })
  const sheet = wb.getWorksheet('宽列')
  assert.ok(sheet !== undefined)
  // Column 1: 2 + header width. Column 2: 2 + the widest *formatted* number
  // ("98,765,432" = 10), not the 8 raw digits.
  assert.equal(sheet.getColumn(1).width, 28)
  assert.ok((sheet.getColumn(1).width ?? 0) >= displayWidth(header) + 2)
  assert.equal(sheet.getColumn(2).width, 12)
  assert.ok((sheet.getColumn(2).width ?? 0) >= displayWidth('98,765,432') + 2)
  // A header wider than 24 wraps on a taller row instead of being truncated.
  // Rows: title 1, subtitle 2, spacer 3, header 4.
  assert.equal(sheet.getRow(4).height, 32)
  assert.equal(sheet.getCell('A4').alignment.wrapText, true)
})

test('format: one numeric column normalizes to fixed decimals and keeps real numbers', async () => {
  const wb = await renderDocument({
    title: '数字格式',
    subtitle: '单位：万元',
    sheets: [{
      name: '金额',
      columns: [{ header: '金额' }, { header: '比率', numberFormat: '0.0%' }],
      rows: [[1280, 0.128], [1050.5, 0.083]],
    }],
  })
  const sheet = wb.getWorksheet('金额')
  assert.ok(sheet !== undefined)
  const format = '#,##0.0;[Red](#,##0.0);"-"'
  assert.equal(sheet.getCell('A5').numFmt, format)
  assert.equal(sheet.getCell('A6').numFmt, format)
  assert.equal(typeof sheet.getCell('A5').value, 'number')
  assert.equal(sheet.getCell('A5').value, 1280)
  assert.equal(sheet.getCell('A6').value, 1050.5)
  // A ratio column keeps the true value and displays it as a percentage.
  assert.equal(sheet.getCell('B5').value, 0.128)
  assert.equal(sheet.getCell('B5').numFmt, '0.0%')

  const styles = readZip((await renderSheetWorkbook(parseSheetWorkbook({
    title: '数字格式',
    subtitle: '单位：万元',
    sheets: [{
      name: '金额',
      columns: [{ header: '金额' }, { header: '比率', numberFormat: '0.0%' }],
      rows: [[1280, 0.128], [1050.5, 0.083]],
    }],
  }).workbook as SheetWorkbook)).bytes).get('xl/styles.xml') ?? ''
  assert.ok(styles.includes('[Red]'), 'the negative section reaches styles.xml')
  // The zero section's literal quotes are XML-escaped in the attribute.
  assert.ok(styles.includes('&quot;-&quot;'), 'the zero section reaches styles.xml')
})

test('borders+alignment: horizontal hairlines only, header follows the data', async () => {
  const wb = await renderDocument({
    title: '边框',
    subtitle: '单位：万元',
    sheets: [{
      name: '明细',
      columns: [{ header: '项目' }, { header: '金额' }],
      rows: [['甲', 1], ['乙', 2], ['合计', 3]],
    }],
  })
  const sheet = wb.getWorksheet('明细')
  assert.ok(sheet !== undefined)
  // Rows: title 1, subtitle 2, spacer 3, header 4, data 5–6, total 7.
  const header = sheet.getCell('A4')
  assert.equal(header.border.bottom?.style, 'medium')
  assert.equal(header.border.left?.style, undefined)
  assert.equal(header.border.right?.style, undefined)

  const data = sheet.getCell('A5')
  assert.equal(data.border.bottom?.style, 'thin')
  assert.equal(data.border.bottom?.color?.argb, 'FFE2E8F0')
  assert.equal(data.border.top?.style, undefined)
  assert.equal(data.border.left?.style, undefined)
  assert.equal(data.border.right?.style, undefined)

  const total = sheet.getCell('A7')
  assert.equal(total.border.top?.style, 'medium')
  assert.equal(total.border.left?.style, undefined)
  assert.equal(total.border.right?.style, undefined)

  // Header alignment follows the column data: text left, numbers right.
  assert.equal(sheet.getCell('A4').alignment.horizontal, 'left')
  assert.equal(sheet.getCell('B4').alignment.horizontal, 'right')
  assert.equal(sheet.getCell('A5').alignment.horizontal, 'left')
  assert.equal(sheet.getCell('B5').alignment.horizontal, 'right')

  // Font ladder: title 14 > header 11 > data 10 > caption 9.
  assert.equal(sheet.getCell('A1').font.size, 14)
  assert.equal(sheet.getCell('A2').font.size, 9)
  assert.equal(sheet.getCell('A4').font.size, 11)
  assert.equal(sheet.getCell('A5').font.size, 10)
})

test('palette: neutral is the default and each scheme writes its own HEX', async () => {
  const expected = {
    neutral: { fill: 'FFF1F5F9', text: 'FF0F172A', total: 'FFE2E8F0', rule: 'FF334155' },
    tech: { fill: 'FF0F172A', text: 'FFF1F5F9', total: 'FFEEF2FF', rule: 'FF4F46E5' },
    warm: { fill: 'FFF5EFE6', text: 'FF5B4B3A', total: 'FFF1E7DA', rule: 'FF9C6644' },
  } as const
  const document = (palette?: string): Record<string, unknown> => ({
    title: '配色',
    ...(palette === undefined ? {} : { style: { palette } }),
    sheets: [{
      name: '表',
      columns: [{ header: '项目' }, { header: '金额' }],
      rows: [['甲', 1], ['乙', 2], ['合计', 3]],
    }],
  })

  const defaultSheet = (await renderDocument(document())).getWorksheet('表')
  assert.ok(defaultSheet !== undefined)
  assert.equal(fillArgb(defaultSheet.getCell('A3')), expected.neutral.fill, 'default palette is neutral')

  for (const name of ['neutral', 'tech', 'warm'] as const) {
    const sheet = (await renderDocument(document(name))).getWorksheet('表')
    assert.ok(sheet !== undefined)
    assert.equal(fillArgb(sheet.getCell('A3')), expected[name].fill, `${name} header fill`)
    assert.equal(sheet.getCell('A3').font.color?.argb, expected[name].text, `${name} header text`)
    assert.equal(fillArgb(sheet.getCell('A6')), expected[name].total, `${name} total fill`)
    assert.equal(sheet.getCell('A6').border.top?.color?.argb, expected[name].rule, `${name} total rule`)
  }
})

function ruleDocument(overrides: Record<string, unknown>): Record<string, unknown> {
  return { title: '规则', subtitle: '单位：万元', sheets: [overrides] }
}

test('check: column width, decimals and ratio formats are located and explained', () => {
  const narrow = checkSheetWorkbook(ruleDocument({
    name: 'S',
    columns: [{ header: '营收（万元）', width: 8, numberFormat: '#,##0' }],
    rows: [[12_345_678]],
  }))
  const narrowIssue = issueOf(narrow, 'column-too-narrow')
  assert.equal(narrowIssue?.severity, 'error')
  assert.equal(narrowIssue?.column, 1)
  assert.match(narrowIssue?.message ?? '', /14/u)

  const wide = checkSheetWorkbook(ruleDocument({
    name: 'S',
    columns: [{ header: '营收（万元）', width: 14, numberFormat: '#,##0' }],
    rows: [[12_345_678]],
  }))
  assert.equal(issueOf(wide, 'column-too-narrow'), undefined)
  assert.equal(wide.errorCount, 0)

  const twoDecimals = checkSheetWorkbook(ruleDocument({
    name: 'S',
    columns: [{ header: '金额' }],
    rows: [[1], [2.5]],
  }))
  assert.equal(issueOf(twoDecimals, 'decimal-mismatch')?.severity, 'warning')
  const manyDecimals = checkSheetWorkbook(ruleDocument({
    name: 'S',
    columns: [{ header: '金额' }],
    rows: [[1], [2.5], [3.25]],
  }))
  assert.equal(issueOf(manyDecimals, 'decimal-mismatch')?.severity, 'error')
  const uniform = checkSheetWorkbook(ruleDocument({
    name: 'S',
    columns: [{ header: '金额' }],
    rows: [[1], [2]],
  }))
  assert.equal(issueOf(uniform, 'decimal-mismatch'), undefined)

  const ratio = checkSheetWorkbook(ruleDocument({
    name: 'S',
    columns: [{ header: '增长率' }],
    rows: [[0.12], [0.2]],
  }))
  assert.equal(issueOf(ratio, 'percent-column-format')?.severity, 'error')
  assert.match(issueOf(ratio, 'percent-column-format')?.message ?? '', /0\.0%/u)
  const declared = checkSheetWorkbook(ruleDocument({
    name: 'S',
    columns: [{ header: '增长率', numberFormat: '0.0%' }],
    rows: [[0.12], [0.2]],
  }))
  assert.equal(issueOf(declared, 'percent-column-format'), undefined)
})

test('check: numeric-looking text, missing units and empty blocks are reported', () => {
  const codes = checkSheetWorkbook(ruleDocument({
    name: 'S',
    columns: [{ header: '工号' }],
    rows: [['001'], ['002'], ['003']],
  }))
  assert.equal(issueOf(codes, 'numeric-text')?.severity, 'warning')
  assert.match(issueOf(codes, 'numeric-text')?.message ?? '', /"@"/u)
  const declaredText = checkSheetWorkbook(ruleDocument({
    name: 'S',
    columns: [{ header: '工号', numberFormat: '@' }],
    rows: [['001'], ['002'], ['003']],
  }))
  assert.equal(issueOf(declaredText, 'numeric-text'), undefined)
  const words = checkSheetWorkbook(ruleDocument({
    name: 'S',
    columns: [{ header: '科目' }],
    rows: [['A1'], ['B2'], ['C3']],
  }))
  assert.equal(issueOf(words, 'numeric-text'), undefined)

  const noUnit = checkSheetWorkbook({
    title: '规则',
    sheets: [{ name: 'S', columns: [{ header: '营收' }], rows: [[20_000], [30_000]] }],
  })
  assert.equal(issueOf(noUnit, 'missing-unit')?.severity, 'warning')
  const withUnit = checkSheetWorkbook(ruleDocument({
    name: 'S',
    columns: [{ header: '营收' }],
    rows: [[20_000], [30_000]],
  }))
  assert.equal(issueOf(withUnit, 'missing-unit'), undefined)

  const emptyColumn = checkSheetWorkbook(ruleDocument({
    name: 'S',
    columns: [{ header: '名称' }, { header: '金额' }],
    rows: [['甲', null], ['乙', null]],
  }))
  assert.equal(issueOf(emptyColumn, 'all-null-column')?.severity, 'error')
  assert.equal(issueOf(emptyColumn, 'all-null-column')?.column, 2)

  const emptyRow = checkSheetWorkbook(ruleDocument({
    name: 'S',
    columns: [{ header: '名称' }, { header: '金额' }],
    rows: [['甲', 1], ['乙', 2], [null, null]],
  }))
  assert.equal(issueOf(emptyRow, 'all-null-row')?.severity, 'error')
  assert.equal(issueOf(emptyRow, 'all-null-row')?.row, 4)

  // A placeholder row a formula writes into is intentional, not empty.
  const backed = checkSheetWorkbook(ruleDocument({
    name: 'S',
    columns: [{ header: '名称' }, { header: '金额' }],
    rows: [['甲', 1], ['乙', 2], [null, null]],
    formulas: { B4: '=SUM(B2:B3)' },
  }))
  assert.equal(issueOf(backed, 'all-null-row'), undefined)

  // Missing cells are already reported per row; the empty column they leave is
  // not reported a second time.
  const shortRows = checkSheetWorkbook(ruleDocument({
    name: 'S',
    columns: [{ header: '名称' }, { header: '金额' }],
    rows: [['甲'], ['乙']],
  }))
  assert.equal(issueOf(shortRows, 'all-null-column'), undefined)
  assert.equal(issueOf(shortRows, 'row-width')?.severity, 'error')
})

test('date: Chinese month and quarter columns convert, mixed shapes stay text', async () => {
  const wb = await renderDocument({
    title: '日期',
    sheets: [
      { name: '月', columns: [{ header: '月份' }], rows: [['2026年1月'], ['2026年2月']] },
      { name: '季', columns: [{ header: '季度' }], rows: [['2026Q1'], ['2026Q2']] },
      { name: '混合', columns: [{ header: '日期' }], rows: [['2026-01-31'], ['2026年1月']] },
    ],
  })
  const month = wb.getWorksheet('月')
  assert.equal(month?.getCell('A4').numFmt, 'yyyy"年"m"月"')
  const monthValue = month?.getCell('A4').value
  assert.ok(monthValue instanceof Date)
  assert.equal(monthValue.getUTCFullYear(), 2026)
  assert.equal(monthValue.getUTCMonth() + 1, 1)

  const quarter = wb.getWorksheet('季')
  assert.equal(quarter?.getCell('A4').numFmt, 'yyyy"Q"q')
  const quarterValue = quarter?.getCell('A4').value
  assert.ok(quarterValue instanceof Date)
  assert.equal(quarterValue.getUTCMonth() + 1, 1, 'Q1 maps to January so `q` renders 1')

  // A column mixing shapes is left exactly as authored.
  const mixed = wb.getWorksheet('混合')
  assert.equal(mixed?.getCell('A4').value, '2026-01-31')
  assert.notEqual(mixed?.getCell('A4').numFmt, 'yyyy-mm-dd')
})

test('end to end: two numbers, a ratio, text, a total row and a long header', async () => {
  const longHeader = '营业收入同比增长率（千元）'
  const document: Record<string, unknown> = {
    title: '2026 年上半年经营数据',
    subtitle: '单位：万元；数据为示例。',
    sheets: [{
      name: '经营汇总',
      columns: [
        { header: '项目名称' },
        { header: longHeader },
        { header: '本期营收（万元）' },
        { header: '同比增速', numberFormat: '0.0%' },
        { header: '备注' },
      ],
      rows: [
        ['华东区', 1, 1280, 0.128, '正常'],
        ['华南区', 2, 1050.5, 0.083, '正常'],
        ['华北区', 3, 2100, 0.21, '正常'],
        ['合计', null, 4430.5, null, null],
      ],
      formulas: { C5: '=SUM(C2:C4)' },
    }],
  }
  const checked = checkSheetWorkbook(document)
  assert.notEqual(checked.status, 'needs_revision', checked.issues.map(issue => issue.code).join(','))

  const rendered = await renderSheetWorkbook(parseSheetWorkbook(document).workbook as SheetWorkbook)
  const wb = new Workbook()
  await wb.xlsx.load(rendered.bytes as unknown as ArrayBuffer)
  const sheet = wb.getWorksheet('经营汇总')
  assert.ok(sheet !== undefined)

  // Captions: title 1, subtitle 2, spacer 3, header 4, data 5–8.
  // Widths: long header column, thickest formatted value + 2, text at 6.
  assert.equal(sheet.getColumn(1).width, 10)
  assert.equal(sheet.getColumn(2).width, 28)
  assert.equal(sheet.getColumn(3).width, 18)
  assert.equal(sheet.getColumn(4).width, 10)
  assert.equal(sheet.getColumn(5).width, 6)
  assert.equal(sheet.getRow(4).height, 32)
  assert.equal(sheet.getCell('B4').alignment.wrapText, true)

  // Formats: fixed decimals on the amount, percent on the ratio (true value).
  assert.equal(sheet.getCell('C5').numFmt, '#,##0.0;[Red](#,##0.0);"-"')
  assert.equal(sheet.getCell('C5').value, 1280)
  assert.equal(sheet.getCell('D5').numFmt, '0.0%')
  assert.equal(sheet.getCell('D5').value, 0.128)

  // Alignment follows each column's data.
  assert.equal(sheet.getCell('A4').alignment.horizontal, 'left')
  assert.equal(sheet.getCell('C4').alignment.horizontal, 'right')
  assert.equal(sheet.getCell('C5').alignment.horizontal, 'right')
  assert.equal(sheet.getCell('A5').alignment.horizontal, 'left')

  // Borders: header medium bottom, data hairline only, total medium top.
  assert.equal(sheet.getCell('A4').border.bottom?.style, 'medium')
  assert.equal(sheet.getCell('A5').border.bottom?.style, 'thin')
  assert.equal(sheet.getCell('A5').border.left?.style, undefined)
  assert.equal(sheet.getCell('A5').border.right?.style, undefined)
  assert.equal(sheet.getCell('A8').border.top?.style, 'medium')
  assert.equal(fillArgb(sheet.getCell('A8')), 'FFE2E8F0')

  // The total formula moved with the caption block.
  const total = sheet.getCell('C8').value as { formula?: string }
  assert.equal(total.formula, 'SUM(C5:C7)')

  const styles = readZip(rendered.bytes).get('xl/styles.xml') ?? ''
  for (const token of ['FFF1F5F9', '#,##0.0', '[Red]', '0.0%']) {
    assert.ok(styles.includes(token), `styles.xml carries ${token}`)
  }
  const sheetXml = readZip(rendered.bytes).get('xl/worksheets/sheet1.xml') ?? ''
  assert.ok(sheetXml.includes('ySplit="4"'), 'frozen split covers the caption block')
})
