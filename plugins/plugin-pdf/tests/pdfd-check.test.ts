/**
 * PDF project checker: the authoring rules the render gate relies on. Each case
 * pins one refusal — unknown fields, heading continuity, table shape, length
 * and page-fit limits — because every one of them is a class of authoring
 * mistake the model must be able to see and fix from the returned report.
 *
 * @module @dsh-app/plugin-pdf/tests/pdfd-check
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkPdfDocument } from '../src/pdfd/check.ts'

/** A project that satisfies every rule, used as the baseline. */
const VALID = {
  title: '季度复盘',
  author: '增长组',
  size: 'a4',
  blocks: [
    { heading: { level: 1, text: '结论' } },
    { paragraph: { text: '本季度核心指标全面达标。' } },
    { bullets: ['营收同比增长 22%', '毛利率提升 3.3 个百分点'] },
    { heading: { level: 2, text: '关键指标' } },
    { table: { headers: ['指标', '本期'], rows: [['营收', '1,280 万'], ['毛利率', '34.5%']] } },
    { pageBreak: true },
    { heading: { level: 1, text: '附录' } },
    { paragraph: { text: '数据来源：财务系统。' } },
  ],
}

/** Codes present in a check result. */
function codes(value: unknown): string[] {
  return checkPdfDocument(value).issues.map(issue => issue.code)
}

/** Error codes present in a check result. */
function errorCodes(value: unknown): string[] {
  return checkPdfDocument(value).issues.filter(issue => issue.severity === 'error').map(issue => issue.code)
}

test('check: a well-formed project passes and reports blocks with a page estimate', () => {
  const result = checkPdfDocument(VALID)
  assert.equal(result.status, 'pass')
  assert.equal(result.errorCount, 0)
  assert.equal(result.blockCount, 8)
  // The forced page break guarantees at least a second sheet.
  assert.ok(result.estimatedPages >= 2, `pages=${String(result.estimatedPages)}`)
})

test('check: a project that would overflow one page is reported before rendering', () => {
  const long = checkPdfDocument({
    title: '长文',
    blocks: [{ heading: { level: 1, text: '正文' } }, { paragraph: { text: '字'.repeat(2500) } }],
  })
  assert.equal(long.status, 'fail')
  assert.ok(
    long.issues.some(issue => issue.code === 'block-too-tall' && issue.severity === 'error'),
    long.issues.map(issue => issue.code).join(','),
  )

  const table = checkPdfDocument({
    title: '大表',
    blocks: [{
      table: {
        headers: ['项目', '数值'],
        rows: Array.from({ length: 80 }, (_, index) => [`项目 ${String(index)}`, String(index)]),
      },
    }],
  })
  assert.equal(table.status, 'fail')
  assert.ok(
    table.issues.some(issue => issue.code === 'table-too-tall' && issue.severity === 'error'),
    table.issues.map(issue => issue.code).join(','),
  )
})

test('check: unknown fields at the top level and inside a block are errors', () => {
  assert.ok(errorCodes({ title: 'A', sections: [], blocks: [{ paragraph: { text: 'x' } }] }).includes('unknown-field'))
  assert.ok(errorCodes({
    title: 'A',
    blocks: [{ paragraph: { text: 'x', bold: true } }],
  }).includes('unknown-field'))
  assert.ok(errorCodes({
    title: 'A',
    blocks: [{ heading: { level: 1, text: 'x', style: 'big' } }],
  }).includes('unknown-field'))
})

test('check: the optional style object is closed and accepts only known header treatments', () => {
  // Omitted means light and stays clean; both known names are accepted.
  assert.equal(checkPdfDocument({ title: 'A', blocks: [{ paragraph: { text: 'x' } }] }).status, 'pass')
  assert.equal(checkPdfDocument({ title: 'A', style: { header: 'light' }, blocks: [{ paragraph: { text: 'x' } }] }).status, 'pass')
  assert.equal(checkPdfDocument({ title: 'A', style: { header: 'dark' }, blocks: [{ paragraph: { text: 'x' } }] }).status, 'pass')
  // An unknown switch or an unknown value is an error, never a silent fallback.
  assert.ok(errorCodes({ title: 'A', style: { palette: 'tech' }, blocks: [{ paragraph: { text: 'x' } }] }).includes('unknown-field'))
  assert.ok(errorCodes({ title: 'A', style: { header: 'auto' }, blocks: [{ paragraph: { text: 'x' } }] }).includes('invalid-style-header'))
  assert.ok(errorCodes({ title: 'A', style: 'light', blocks: [{ paragraph: { text: 'x' } }] }).includes('invalid-style'))
})

test('check: each block must carry exactly one content key', () => {
  assert.ok(errorCodes({ title: 'A', blocks: [{}] }).includes('missing-content'))
  assert.ok(errorCodes({
    title: 'A',
    blocks: [{ heading: { level: 1, text: 'A' }, paragraph: { text: 'B' } }],
  }).includes('multiple-content'))
  // pageBreak is a content key too, and only `true` is accepted.
  assert.equal(checkPdfDocument({ title: 'A', blocks: [{ pageBreak: true }] }).status, 'pass')
  assert.ok(errorCodes({ title: 'A', blocks: [{ pageBreak: false }] }).includes('invalid-page-break'))
})

test('check: heading levels must start at H1 and never skip a level', () => {
  assert.ok(errorCodes({ title: 'A', blocks: [{ heading: { level: 2, text: 'A' } }] }).includes('heading-level-jump'))
  assert.ok(errorCodes({
    title: 'A',
    blocks: [{ heading: { level: 1, text: 'A' } }, { heading: { level: 3, text: 'B' } }],
  }).includes('heading-level-jump'))
  assert.ok(errorCodes({
    title: 'A',
    blocks: [{ heading: { level: 1, text: 'A' } }, { heading: { level: 4, text: 'B' } }],
  }).includes('invalid-heading-level'))
  // Going back up a level is normal outline structure.
  assert.equal(checkPdfDocument({
    title: 'A',
    blocks: [
      { heading: { level: 1, text: 'A' } },
      { heading: { level: 2, text: 'B' } },
      { heading: { level: 3, text: 'C' } },
      { heading: { level: 1, text: 'D' } },
    ],
  }).status, 'pass')
})

test('check: title, author, size and text bounds are enforced', () => {
  assert.ok(errorCodes({ blocks: [] }).includes('invalid-title'))
  assert.ok(errorCodes({ title: '字'.repeat(201), blocks: [{ paragraph: { text: 'x' } }] }).includes('title-too-long'))
  assert.ok(errorCodes({
    title: 'A',
    author: '字'.repeat(201),
    blocks: [{ paragraph: { text: 'x' } }],
  }).includes('author-too-long'))
  assert.ok(errorCodes({
    title: 'A',
    size: 'a3',
    blocks: [{ paragraph: { text: 'x' } }],
  }).includes('invalid-size'))
  assert.ok(errorCodes({
    title: 'A',
    blocks: [{ heading: { level: 1, text: '' } }],
  }).includes('invalid-text'))
  assert.ok(errorCodes({
    title: 'A',
    blocks: [{ paragraph: { text: 'x'.repeat(5001) } }],
  }).includes('text-too-long'))
  assert.ok(errorCodes({
    title: 'A',
    blocks: [{ bullets: ['x'.repeat(501)] }],
  }).includes('text-too-long'))
})

test('check: table headers, row widths and cell limits are enforced', () => {
  assert.ok(errorCodes({ title: 'A', blocks: [{ table: { headers: [], rows: [] } }] }).includes('empty-table-headers'))
  assert.ok(errorCodes({
    title: 'A',
    blocks: [{ table: { headers: Array.from({ length: 13 }, (_, index) => `列${String(index)}`), rows: [] } }],
  }).includes('too-many-columns'))
  assert.ok(errorCodes({
    title: 'A',
    blocks: [{ table: { headers: ['A', 'B'], rows: [['只有一个']] } }],
  }).includes('table-row-shape'))
  assert.ok(errorCodes({
    title: 'A',
    blocks: [{ table: { headers: ['A'], rows: [['x'.repeat(301)]] } }],
  }).includes('cell-too-long'))
  assert.ok(errorCodes({
    title: 'A',
    blocks: [{ table: { headers: ['A'], rows: [['']] } }],
  }).includes('invalid-table-cell'))
  // A header-only table is a warning, not a refusal.
  const headerOnly = checkPdfDocument({ title: 'A', blocks: [{ table: { headers: ['A'], rows: [] } }] })
  assert.equal(headerOnly.status, 'warning')
  assert.ok(headerOnly.issues.some(issue => issue.code === 'empty-table-rows' && issue.severity === 'warning'))
})

test('check: an empty project and an over-long block list are refused', () => {
  assert.ok(errorCodes({ title: 'A', blocks: [] }).includes('empty-document'))
  assert.ok(errorCodes({ title: 'A', blocks: {} }).includes('invalid-blocks'))
  const many = {
    title: 'A',
    blocks: Array.from({ length: 501 }, () => ({ paragraph: { text: 'x' } })),
  }
  assert.ok(errorCodes(many).includes('too-many-blocks'))
})

test('check: every error carries a fix hint and its block index', () => {
  const result = checkPdfDocument({
    title: 'A',
    blocks: [
      { heading: { level: 1, text: 'A' } },
      { table: { headers: ['A', 'B'], rows: [['one']] } },
    ],
  })
  const shape = result.issues.find(issue => issue.code === 'table-row-shape')
  assert.ok(shape !== undefined)
  assert.equal(shape.block, 2)
  assert.equal(shape.field, 'table.rows[0]')
  assert.match(String(shape.fix), /单元格/u)
})
