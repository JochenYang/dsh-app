/**
 * The SHEET checker: the rules that gate both the write and the export.
 * Every case pins one rule with the location the model is expected to act on —
 * sheet name, row, column, JSON path — plus the two properties the rest of the
 * plugin relies on: warnings never block (the normalized workbook survives)
 * and a capped issue list still reports honest totals.
 *
 * @module @dsh-app/plugin-sheet/tests/sheet-check
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkSheetWorkbook,
  formatSheetIssues,
  MAX_REPORTED_ISSUES,
  parseSheetWorkbook,
} from '../src/sheet/check.ts'
import { parseSheetText } from '../src/sheet/load.ts'
import {
  isRelativeR1C1,
  MAX_COLUMNS_PER_SHEET,
  MAX_ROWS_PER_SHEET,
  MAX_SHEETS,
  MAX_TOTAL_CELLS,
  parseCellReference,
  SHEET_NAME_FORBIDDEN,
} from '../src/sheet/types.ts'
import type { SheetCheckResult, SheetIssue } from '../src/sheet/types.ts'

/** A minimal valid sheet. */
function table(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '表一',
    columns: [{ header: '名称' }, { header: '数量' }],
    rows: [['甲', 1]],
    ...overrides,
  }
}

/** A minimal valid document. */
function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { title: '测试工作簿', sheets: [table()], ...overrides }
}

function firstIssue(result: SheetCheckResult, code: string): SheetIssue {
  const issue = result.issues.find(candidate => candidate.code === code)
  assert.ok(issue !== undefined, `expected an issue with code ${code}, got ${result.issues.map(i => i.code).join(',')}`)
  return issue
}

test('check: a well-formed document passes and normalizes into the workbook AST', () => {
  const result = checkSheetWorkbook(document({
    sheets: [table({
      columns: [{ header: '月份' }, { header: '金额', width: 14, numberFormat: '#,##0' }],
      rows: [['1 月', 1280], ['2 月', 1050], [null, null]],
      formulas: { B4: '=SUM(B2:B3)' },
    })],
  }))
  assert.equal(result.status, 'pass')
  assert.equal(result.errorCount, 0)
  assert.equal(result.warningCount, 0)
  assert.equal(result.sheetCount, 1)
  assert.equal(result.rowCount, 3)
  assert.equal(result.formulaCount, 1)
  assert.match(result.digest, /^[0-9a-f]{64}$/u)

  const { workbook, errorCount } = parseSheetWorkbook(document({
    sheets: [table({
      columns: [{ header: '月份' }, { header: '金额', width: 14, numberFormat: '#,##0' }],
      rows: [['1 月', 1280], [null, null]],
      formulas: { B3: '=SUM(B2:B2)' },
    })],
  }))
  assert.equal(errorCount, 0)
  assert.ok(workbook !== undefined)
  assert.equal(workbook.title, '测试工作簿')
  assert.deepEqual(workbook.sheets[0]?.columns, [
    { header: '月份' },
    { header: '金额', width: 14, numberFormat: '#,##0' },
  ])
  assert.deepEqual(workbook.sheets[0]?.rows, [['1 月', 1280], [null, null]])
  assert.equal(workbook.sheets[0]?.formulas['B3'], '=SUM(B2:B2)')
})

test('check: the root must be an object with a title and a non-empty sheet list', () => {
  assert.equal(firstIssue(checkSheetWorkbook(null), 'root-not-object').path, '$')
  assert.equal(firstIssue(checkSheetWorkbook({ sheets: [table()] }), 'missing-title').path, '$.title')
  assert.equal(firstIssue(checkSheetWorkbook({ title: '标题' }), 'missing-sheets').path, '$.sheets')
  assert.equal(firstIssue(checkSheetWorkbook({ title: '标题', sheets: [] }), 'missing-sheets').path, '$.sheets')
  assert.equal(firstIssue(checkSheetWorkbook({ title: '标题', sheets: [null] }), 'sheet-not-object').path, '$.sheets[0]')
})

test('check: a row whose width differs from the column grid is an error with its row number', () => {
  const result = checkSheetWorkbook(document({ sheets: [table({ rows: [['甲', 1], ['乙'], ['丙', 3]] })] }))
  assert.equal(result.status, 'needs_revision')
  assert.equal(result.errorCount, 1)
  const issue = firstIssue(result, 'row-width')
  assert.equal(issue.severity, 'error')
  assert.equal(issue.path, '$.sheets[0].rows[1]')
  assert.equal(issue.sheet, '表一')
  assert.equal(issue.row, 3)
  assert.match(issue.message, /应为 2 个/u)
  assert.match(issue.message, /null 补齐/u)
})

test('check: sheet names must be legal, unique and within 31 characters', () => {
  const illegal = checkSheetWorkbook(document({ sheets: [table({ name: '收支/明细' })] }))
  const illegalIssue = firstIssue(illegal, 'invalid-sheet-name')
  assert.equal(illegalIssue.sheet, '收支/明细')
  assert.match(illegalIssue.message, /31/u)
  assert.ok(SHEET_NAME_FORBIDDEN.test('/'))

  const duplicate = checkSheetWorkbook(document({ sheets: [table({ name: 'Sheet1' }), table({ name: 'sheet1' })] }))
  const duplicateIssue = firstIssue(duplicate, 'duplicate-sheet-name')
  assert.equal(duplicateIssue.path, '$.sheets[1].name')
  assert.match(duplicateIssue.message, /sheets\[0\]/u)

  const long = checkSheetWorkbook(document({ sheets: [table({ name: 'x'.repeat(32) })] }))
  assert.equal(firstIssue(long, 'invalid-sheet-name').severity, 'error')

  const quoted = checkSheetWorkbook(document({ sheets: [table({ name: "'营收'" })] }))
  assert.match(firstIssue(quoted, 'invalid-sheet-name').message, /单引号/u)
})

test('check: headers must be non-empty and unique, and column options are range-checked', () => {
  const duplicate = checkSheetWorkbook(document({
    sheets: [table({ columns: [{ header: '金额' }, { header: '金额' }] })],
  }))
  const duplicateIssue = firstIssue(duplicate, 'duplicate-header')
  assert.equal(duplicateIssue.column, 2)
  assert.match(duplicateIssue.message, /columns\[0\]/u)

  assert.equal(firstIssue(checkSheetWorkbook(document({
    sheets: [table({ columns: [{ header: '' }, { header: '数量' }] })],
  })), 'invalid-header').column, 1)

  const badOptions = checkSheetWorkbook(document({
    sheets: [table({ columns: [{ header: '名称', width: 0 }, { header: '数量', numberFormat: '' }] })],
  }))
  assert.equal(firstIssue(badOptions, 'invalid-column-width').column, 1)
  assert.equal(firstIssue(badOptions, 'invalid-number-format').column, 2)
})

test('check: cells accept only string, number or null, with a bounded text length', () => {
  const badTypes = checkSheetWorkbook(document({
    sheets: [table({ rows: [['甲', true], ['乙', Number.NaN]] })],
  }))
  const issues = badTypes.issues.filter(issue => issue.code === 'invalid-cell')
  assert.equal(issues.length, 2)
  assert.equal(issues[0]?.row, 2)
  assert.equal(issues[0]?.column, 2)
  assert.equal(issues[0]?.cell, 'B2')
  assert.match(issues[0]?.message ?? '', /字符串、数字或 null/u)

  const tooLong = checkSheetWorkbook(document({
    sheets: [table({ rows: [['甲', 'x'.repeat(32_768)]] })],
  }))
  const longIssue = firstIssue(tooLong, 'cell-text-too-long')
  assert.equal(longIssue.cell, 'B2')
  assert.match(longIssue.message, /32767/u)
})

test('check: formulas must reference an in-range cell with an = expression, once each', () => {
  const outOfRange = checkSheetWorkbook(document({ sheets: [table({ formulas: { B9: '=SUM(B2:B3)' } })] }))
  const rangeIssue = firstIssue(outOfRange, 'formula-out-of-range')
  assert.equal(rangeIssue.cell, 'B9')
  assert.equal(rangeIssue.row, 9)
  assert.match(rangeIssue.message, /数据行 2–2/u)
  assert.match(rangeIssue.message, /列 A–B/u)

  assert.equal(firstIssue(checkSheetWorkbook(document({
    sheets: [table({ formulas: { 'RC[-1]': '=B1' } })],
  })), 'relative-r1c1-key').severity, 'error')
  assert.equal(firstIssue(checkSheetWorkbook(document({
    sheets: [table({ formulas: { 'b2 x': '=B1' } })],
  })), 'invalid-formula-key').severity, 'error')
  assert.equal(firstIssue(checkSheetWorkbook(document({
    sheets: [table({ formulas: { B2: 'SUM(B2:B2)' } })],
  })), 'invalid-formula').severity, 'error')

  const duplicate = checkSheetWorkbook(document({
    sheets: [table({ formulas: { B2: '=SUM(B2:B2)', R2C2: '=SUM(B2:B2)' } })],
  }))
  const duplicateIssue = firstIssue(duplicate, 'duplicate-formula-target')
  assert.equal(duplicateIssue.cell, 'B2')
  assert.match(duplicateIssue.message, /formulas\.B2/u)
})

test('check: a formula writes over live data as a warning, not over a null placeholder', () => {
  const overData = checkSheetWorkbook(document({
    sheets: [table({ rows: [['甲', 1], ['乙', 2]], formulas: { B2: '=SUM(B2:B2)' } })],
  }))
  const warning = firstIssue(overData, 'formula-overwrites-cell')
  assert.equal(warning.severity, 'warning')
  assert.equal(warning.cell, 'B2')
  assert.equal(overData.status, 'warning')
  assert.equal(overData.errorCount, 0)

  // The usual total row: a placeholder null cell is exactly where a formula belongs.
  const placeholder = checkSheetWorkbook(document({
    sheets: [table({ rows: [['甲', 1], ['乙', 2], [null, null]], formulas: { B4: '=SUM(B2:B3)' } })],
  }))
  assert.equal(placeholder.status, 'pass')
  assert.equal(placeholder.warningCount, 0)

  const header = checkSheetWorkbook(document({ sheets: [table({ formulas: { A1: '=B1' } })] }))
  assert.equal(firstIssue(header, 'formula-overwrites-header').row, 1)
})

test('check: unknown fields are reported as warnings and never block the workbook', () => {
  const result = checkSheetWorkbook(document({ extra: 1, sheets: [table({ title: '多余' })] }))
  assert.equal(result.status, 'warning')
  assert.equal(result.errorCount, 0)
  const issues = result.issues.filter(issue => issue.code === 'unknown-field')
  assert.equal(issues.length, 2)
  assert.equal(issues[0]?.path, '$.extra')
  assert.ok(parseSheetWorkbook(document({ extra: 1 })).workbook !== undefined)
})

test('check: sheet, row, column and cell budgets are enforced', () => {
  const manySheets = checkSheetWorkbook(document({
    sheets: Array.from({ length: MAX_SHEETS + 1 }, (_value, index) => table({ name: `表${index + 1}` })),
  }))
  assert.equal(firstIssue(manySheets, 'too-many-sheets').severity, 'error')

  const manyColumns = checkSheetWorkbook(document({
    sheets: [table({ columns: Array.from({ length: MAX_COLUMNS_PER_SHEET + 1 }, (_v, i) => ({ header: `列${i + 1}` })) })],
  }))
  assert.match(firstIssue(manyColumns, 'too-many-columns').message, /64 列/u)

  const sharedRow = Array.from({ length: MAX_COLUMNS_PER_SHEET }, () => null)
  const overRows = checkSheetWorkbook(document({
    sheets: [table({
      columns: sharedRow.map((_cell, index) => ({ header: `列${index + 1}` })),
      rows: Array.from({ length: MAX_ROWS_PER_SHEET + 1 }, () => sharedRow),
    })],
  }))
  assert.match(firstIssue(overRows, 'too-many-rows').message, /5000 行/u)

  // MAX_TOTAL_CELLS sits between one and two full 5000x64 sheets, so a corpus
  // of 11-column full sheets crosses it without building millions of values.
  const elevenColumns = Array.from({ length: 11 }, () => null)
  const elevenHeader = Array.from({ length: 11 }, (_v, index) => ({ header: `列${index + 1}` }))
  const totalRows = Math.ceil(MAX_TOTAL_CELLS / 11) + 1
  const perSheet = MAX_ROWS_PER_SHEET
  const sheetCount = Math.ceil(totalRows / perSheet)
  const overCells = checkSheetWorkbook(document({
    sheets: Array.from({ length: sheetCount }, (_v, index) => table({
      name: `大表${index + 1}`,
      columns: elevenHeader,
      rows: Array.from({ length: index === sheetCount - 1 ? totalRows - perSheet * (sheetCount - 1) : perSheet }, () => elevenColumns),
    })),
  }))
  assert.equal(firstIssue(overCells, 'too-many-cells').severity, 'error')
})

test('check: the reported issue list is capped while the totals stay honest', () => {
  const rows = Array.from({ length: 700 }, () => ['单个'])
  const result = checkSheetWorkbook(document({ sheets: [table({ rows })] }))
  assert.equal(result.errorCount, 700)
  assert.equal(result.issues.length, MAX_REPORTED_ISSUES)
  assert.equal(result.suppressedCount, 200)
  const text = formatSheetIssues(result)
  assert.match(text, /另有 200 项未逐条列出/u)

  const passing = formatSheetIssues(checkSheetWorkbook(document()))
  assert.match(passing, /^校验通过：0 项需要修正，0 项建议。/u)
})

test('check: issue text carries the sheet, row, column and fix guidance', () => {
  const result = checkSheetWorkbook(document({
    sheets: [table({ name: '营收', rows: [['甲', 1], ['乙']] })],
  }))
  const text = formatSheetIssues(result)
  assert.match(text, /^校验未通过，需要调整：1 项需要修正/u)
  assert.match(text, /表「营收」/u)
  assert.match(text, /第 3 行/u)
  assert.match(text, /row-width/u)
  assert.match(text, /重新运行 sheet_check/u)
})

test('check: JSON text is parsed with a single actionable failure', () => {
  const okText = parseSheetText(JSON.stringify(document()))
  assert.equal(okText.error, undefined)
  assert.ok(okText.value !== undefined)

  assert.match(parseSheetText('').error ?? '', /为空/u)
  assert.match(parseSheetText('{ oops').error ?? '', /不是合法 JSON/u)
  // A non-object root parses but fails the checker, not the parser.
  const arrayRoot = parseSheetText('[]')
  assert.equal(arrayRoot.error, undefined)
  assert.equal(checkSheetWorkbook(arrayRoot.value).status, 'needs_revision')
})

test('check: cell references resolve in both dialects and reject relative forms', () => {
  assert.deepEqual(parseCellReference('$B$2'), { row: 2, column: 2, a1: 'B2' })
  assert.deepEqual(parseCellReference('aa10'), { row: 10, column: 27, a1: 'AA10' })
  assert.deepEqual(parseCellReference('R3C28'), { row: 3, column: 28, a1: 'AB3' })
  assert.equal(parseCellReference('A0'), undefined)
  assert.equal(parseCellReference('1A'), undefined)
  assert.equal(parseCellReference('R[1]C1'), undefined)
  assert.equal(isRelativeR1C1('R[1]C1'), true)
  assert.equal(isRelativeR1C1('RC'), true)
  assert.equal(isRelativeR1C1('R1C1'), false)
  assert.equal(isRelativeR1C1('B2'), false)
})

test('check: formulas reaching outside the workbook are refused', () => {
  const base = { title: 't', sheets: [{ name: 'S', columns: [{ header: 'A' }, { header: 'B' }], rows: [[1, 2]], formulas: {} as Record<string, string> }] }
  for (const formula of ["=[Book.xlsx]Sheet1!A1", "=cmd|'/c calc'!A1", '=HYPERLINK("http://x","y")']) {
    const project = { ...base, sheets: [{ ...base.sheets[0], formulas: { D5: formula } }] }
    const result = checkSheetWorkbook(project)
    assert.ok(result.errorCount > 0, formula)
    assert.ok(result.issues.some(issue => issue.code === 'external-formula'), formula)
  }
})

test('check: text starting with = warns but passes', () => {
  const project = { title: 't', sheets: [{ name: 'S', columns: [{ header: 'A' }], rows: [['=SUM(A1)']] }] }
  const result = checkSheetWorkbook(project)
  assert.equal(result.errorCount, 0)
  assert.ok(result.issues.some(issue => issue.code === 'formula-looking-text'))
})
