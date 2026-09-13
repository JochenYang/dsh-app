/**
 * Table measurement shared by the checker and the renderer.
 *
 * Both halves need the same answer to "how tall is this table, how wide is each
 * column and how is each column aligned": the checker refuses a table that
 * cannot fit one sheet, the renderer draws exactly the wrapped lines the layout
 * produced. Keeping the computation in one place is what makes the estimate
 * trustworthy instead of an independent guess.
 *
 * The layout is also where a table's presentation is fixed: each column is
 * resolved to one format plan (numeric/share/date/text), every cell is rendered
 * through its column's plan *before* it is measured, so a formatted value that
 * grows — `1280` becomes `1,280.0` — is what the column width is sized against.
 * Rows are marked as detail or total, and zebra striping is only enabled past
 * {@link STRIPE_ROW_THRESHOLD} detail rows, exactly like the workbook renderer.
 *
 * @module @dsh-app/plugin-pdf/pdfd/table
 */

import {
  computeColumnWidths,
  TABLE_CELL_LINE_HEIGHT,
  TABLE_CELL_PADDING,
  TABLE_MAX_COLUMN_SHARE,
  wrapText,
} from './metrics.ts'
import type { Measure } from './metrics.ts'
import { planColumnFormat } from './number-format.ts'
import type { ColumnFormat } from './number-format.ts'
import type { PdfTable } from './types.ts'

/** Detail rows past which the weak zebra fill is worth the visual noise. */
export const STRIPE_ROW_THRESHOLD = 7

/**
 * First-column labels the renderer treats as a total row (visual emphasis only
 * — no arithmetic meaning is guessed). Latin forms match case-insensitively.
 */
export const TOTAL_ROW_LABELS: ReadonlySet<string> = new Set(['合计', '总计', '小计', '汇总', 'Total', 'Subtotal', 'Sum'])

const TOTAL_ROW_LABELS_CASELESS: ReadonlySet<string> = new Set([...TOTAL_ROW_LABELS].map(label => label.toLocaleLowerCase()))

/** Whether a first-column value marks a total row (see {@link TOTAL_ROW_LABELS}). */
export function isTotalRowLabel(value: string): boolean {
  const trimmed = value.trim()
  return TOTAL_ROW_LABELS.has(trimmed) || TOTAL_ROW_LABELS_CASELESS.has(trimmed.toLocaleLowerCase())
}

/** One laid-out row: wrapped lines, measured height and its visual role. */
export interface TableRowLayout {
  readonly lines: readonly (readonly string[])[]
  readonly height: number
  /** A total row draws a medium top rule, a fill and bold text. */
  readonly isTotal: boolean
  /** Whether the weak zebra fill applies (detail rows only, long tables only). */
  readonly striped: boolean
}

/** One laid-out table: wrapped lines, measured heights and column presentation. */
export interface TableLayout {
  readonly columnWidths: readonly number[]
  /** One format plan per column, resolved once and shared by both halves. */
  readonly columnFormats: readonly ColumnFormat[]
  /** Per-column alignment; the header follows its column's alignment too. */
  readonly columnAlign: readonly ('left' | 'right')[]
  readonly headerLines: readonly (readonly string[])[]
  readonly headerHeight: number
  readonly rows: readonly TableRowLayout[]
  readonly totalHeight: number
  readonly cellPadding: number
  readonly lineHeight: number
  /** Whether zebra striping is enabled at all for this table. */
  readonly stripeEnabled: boolean
}

/** Wrap one row's cells against the final column widths. */
function wrapRow(
  cells: readonly string[],
  columnWidths: readonly number[],
  padding: number,
  measure: Measure,
): string[][] {
  return columnWidths.map((width, index) => wrapText(cells[index] ?? '', Math.max(1, width - 2 * padding), measure))
}

/** Row height from the tallest wrapped cell. */
function rowHeight(lines: readonly (readonly string[])[], padding: number, lineHeight: number): number {
  const count = lines.reduce((max, cell) => Math.max(max, cell.length), 1)
  return count * lineHeight + 2 * padding
}

/**
 * Lay out one table inside `availableWidth`.
 * @param table - the validated table content.
 * @param options - available width, the width source at the cell font size, and
 * optionally a second source at the header's larger font size.
 */
export function layoutTable(
  table: PdfTable,
  options: { availableWidth: number, measure: Measure, headerMeasure?: Measure },
): TableLayout {
  const padding = TABLE_CELL_PADDING
  const lineHeight = TABLE_CELL_LINE_HEIGHT
  const measureHeader = options.headerMeasure ?? options.measure
  const columns = table.headers.length
  const columnFormats = table.headers.map((header, index) =>
    planColumnFormat(table.rows.map(row => row[index] ?? ''), header))
  const formatted = table.rows.map(row => row.map((cell, index) => columnFormats[index]?.render(cell) ?? cell))
  const cap = options.availableWidth * TABLE_MAX_COLUMN_SHARE
  const natural = table.headers.map((header, index) => {
    let widest = measureHeader(header)
    for (const row of formatted) widest = Math.max(widest, options.measure(row[index] ?? ''))
    return Math.min(widest, cap) + 2 * padding
  })
  const floor = 2 * padding + options.measure('0000')
  const columnWidths = computeColumnWidths(
    natural,
    options.availableWidth,
    Math.min(options.availableWidth / Math.max(1, columns), floor),
  )
  const headerLines = wrapRow(table.headers, columnWidths, padding, measureHeader)
  const roles = formatted.map(row => isTotalRowLabel(row[0] ?? ''))
  const stripeEnabled = roles.filter(isTotal => !isTotal).length > STRIPE_ROW_THRESHOLD
  let detailIndex = 0
  const rows = formatted.map((cells, index) => {
    const isTotal = roles[index] ?? false
    const striped = stripeEnabled && !isTotal && detailIndex % 2 === 1
    if (!isTotal) detailIndex += 1
    const lines = wrapRow(cells, columnWidths, padding, options.measure)
    return { lines, height: rowHeight(lines, padding, lineHeight), isTotal, striped }
  })
  const headerHeight = rowHeight(headerLines, padding, lineHeight)
  const bodyHeight = rows.reduce((sum, row) => sum + row.height, 0)
  return {
    columnWidths,
    columnFormats,
    columnAlign: columnFormats.map(plan => plan.align),
    headerLines,
    headerHeight,
    rows,
    totalHeight: headerHeight + bodyHeight,
    cellPadding: padding,
    lineHeight,
    stripeEnabled,
  }
}
