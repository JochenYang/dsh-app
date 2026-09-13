/**
 * The table-cell presentation layer: display width, the per-column
 * number/date/percent inference, and the unified formatter. These are the rules
 * the renderer and the checker share, so a column's warning and its exported
 * cells can never disagree.
 *
 * @module @dsh-app/plugin-doc/tests/docd-number-format
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  displayWidth,
  formatNumber,
  formatPercent,
  isTotalRowLabel,
  planColumnFormat,
} from '../src/docd/number-format.ts'

test('number format: a CJK glyph counts as two display units', () => {
  assert.equal(displayWidth('A'), 1)
  assert.equal(displayWidth('指'), 2)
  assert.equal(displayWidth('指标'), 4)
  assert.equal(displayWidth('12,80'), 5)
  // Same code-point count, different display width — the whole point.
  assert.equal('指标'.length, 'ID'.length)
  assert.ok(displayWidth('指标') > displayWidth('ID'))
})

test('number format: a numeric column unifies decimals, groups thousands and marks zero', () => {
  const plan = planColumnFormat(['1280', '1050.5'], '本期')
  assert.equal(plan.kind, 'number')
  assert.equal(plan.decimals, 1)
  assert.equal(plan.align, 'right')
  assert.equal(plan.format('1280'), '1,280.0')
  assert.equal(plan.format('1050.5'), '1,050.5')
  assert.equal(plan.format(0), '-')
  // A negative goes through the column formatter to the same parenthesized
  // shape the other three suites write, with no inner minus sign.
  assert.equal(plan.format('-1280'), '(1,280.0)')
  // Hundreds of a float must not leak into the format.
  assert.equal(planColumnFormat(['1.234', '2.5'], '值').decimals, 2)
  assert.equal(planColumnFormat(['1.234'], '值').format('1.234'), '1.23')
})

test('number format: a ratio column reads as a percent at one decimal', () => {
  const plan = planColumnFormat(['0.128'], '增长率')
  assert.equal(plan.kind, 'percent')
  assert.equal(plan.align, 'right')
  assert.equal(plan.format('0.128'), '12.8%')
  // A percent cell is already in display form and round-trips unchanged.
  assert.equal(planColumnFormat(['0.345'], '毛利率').format('34.5%'), '34.5%')
  assert.equal(formatPercent(0.18), '18.0%')
  // A ratio header whose values are already percent-scale is not a ratio column.
  assert.equal(planColumnFormat(['128'], '增长率').kind, 'number')
})

test('number format: negatives use parentheses only, matching the other three suites', () => {
  assert.equal(formatNumber(-1280, 0), '(1,280)')
  assert.equal(formatNumber(-1050.5, 1), '(1,050.5)')
  assert.equal(formatNumber(1280, 0), '1,280')
  // No minus sign survives inside the parentheses.
  assert.ok(!formatNumber(-1280, 0).includes('-'), 'a parenthesized negative carries no inner minus')
})

test('number format: a date column normalizes every recognized shape', () => {
  const plan = planColumnFormat(['2024/1/5', '2024.01.06', '2024年1月7日'], '日期')
  assert.equal(plan.kind, 'date')
  assert.equal(plan.format('2024/1/5'), '2024-01-05')
  assert.equal(plan.format('2024.01.06'), '2024-01-06')
  assert.equal(plan.format('2024年1月7日'), '2024-01-07')
  // A rolled-over day is not silently accepted as a date.
  assert.equal(planColumnFormat(['2024-02-31'], '日期').kind, 'text')
})

test('number format: text and mixed columns are left exactly as authored', () => {
  const text = planColumnFormat(['A', 'B', '1,280 万'], '名称')
  assert.equal(text.kind, 'text')
  assert.equal(text.align, 'left')
  for (const value of ['A', 'B', '1,280 万']) assert.equal(text.format(value), value)
  // Three of five numeric cells is exactly 60%: not enough to call it numeric.
  assert.equal(planColumnFormat(['1', '2', '3', 'x', 'y'], '值').kind, 'text')
  assert.equal(planColumnFormat(['1', '2', '3', 'x'], '值').kind, 'number')
})

test('number format: totals labels match the documented vocabulary only', () => {
  for (const label of ['合计', '总计', ' 小计 ', '汇总', 'Total', 'Subtotal', 'SUM']) {
    assert.ok(isTotalRowLabel(label), `${label} is a totals label`)
  }
  // The list is exact, so a longer label that merely starts with a totals word
  // is not a total row — the same rule the PDF, PPT and Excel suites apply.
  for (const label of ['合计其中', '总计（含税）', '收入', 'Summary', 'details', 'SUM:', '']) {
    assert.equal(isTotalRowLabel(label), false, `${label} is not a totals label`)
  }
})
