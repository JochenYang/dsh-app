/**
 * SHEET → .xlsx rendering through exceljs.
 *
 * The document is already validated when this runs (sheet_render re-checks and
 * refuses to call in), so the renderer only has to be faithful: a caption
 * block, a styled frozen header, real columns with widths and number formats,
 * typed rows, native cell formulas and a visually distinct total row. Nothing
 * is a picture and nothing is pre-computed — the user edits the produced
 * workbook exactly as if they had typed it.
 *
 * The caption rows sit above the grid, which means every spreadsheet
 * coordinate in the document (header = row 1, data from row 2) is shifted down
 * by `headerRow - 1` when written. Formulas are written through that same
 * offset, so a formula that addresses `B4` in the document lands on the row the
 * reader sees as its computed total.
 *
 * Layout rules live in `sheet/format.ts` so the checker measures the same
 * widths and formats this module writes. The look itself is one of three
 * palettes: a light printable `neutral` default, a dark-header `tech` for
 * metric tables and a muted `warm` for education/reports.
 *
 * Formulas are written without cached results and the workbook asks for a full
 * recalculation on load, so Excel/WPS computes them on open instead of showing
 * a stale zero.
 *
 * @module @dsh-app/plugin-sheet/sheet/render
 */

import { Workbook } from 'exceljs'
import type { Row, Worksheet } from 'exceljs'
import {
  BLANK_ROW_HEIGHT,
  CAPTION_SIZE,
  DATA_SIZE,
  HEADER_HEIGHT,
  HEADER_SIZE,
  HEADER_WRAP_HEIGHT,
  HEADER_WRAP_WIDTH,
  displayWidth,
  planForColumn,
  requiredColumnWidth,
  TEXT_FORMAT,
  TITLE_SIZE,
} from './format.ts'
import type { ColumnPlan, RenderedCell } from './format.ts'
import {
  columnIndexToLetters,
  isTotalRowLabel,
  MAX_CELL_REFERENCE_ROW,
  parseCellReference,
} from './types.ts'
import type { SheetPaletteName, SheetWorkbook } from './types.ts'

/** Rendered bytes plus the counts the tool reports back to the model. */
export interface SheetRenderResult {
  readonly bytes: Uint8Array
  readonly sheetCount: number
  readonly rowCount: number
  readonly formulaCount: number
}

/** One resolved color scheme. Colors are ARGB (opaque `FF` prefix). */
export interface SheetPalette {
  /** Default worksheet tab color. */
  readonly accent: string
  readonly header: { readonly fill: string, readonly text: string, readonly rule: string }
  readonly title: string
  readonly caption: string
  readonly dataText: string
  /** Alternating data-row fill (weak on purpose). */
  readonly stripe: string
  /** Horizontal hairline between data rows. */
  readonly border: string
  readonly totalFill: string
  readonly totalRule: string
}

/**
 * The three bundled color schemes. `neutral` is the printable default for
 * finance/report tables; `tech` is the dark-header product/metric look;
 * `warm` is a low-contrast education/report tone.
 */
export const SHEET_PALETTES: Readonly<Record<SheetPaletteName, SheetPalette>> = {
  neutral: {
    accent: 'FF334155',
    header: { fill: 'FFF1F5F9', text: 'FF0F172A', rule: 'FF334155' },
    title: 'FF0F172A',
    caption: 'FF6B7280',
    dataText: 'FF1F2937',
    stripe: 'FFF8FAFC',
    border: 'FFE2E8F0',
    totalFill: 'FFE2E8F0',
    totalRule: 'FF334155',
  },
  tech: {
    accent: 'FF4F46E5',
    header: { fill: 'FF0F172A', text: 'FFF1F5F9', rule: 'FF4F46E5' },
    title: 'FF0F172A',
    caption: 'FF64748B',
    dataText: 'FF0F172A',
    stripe: 'FFF8FAFC',
    border: 'FFE2E8F0',
    totalFill: 'FFEEF2FF',
    totalRule: 'FF4F46E5',
  },
  warm: {
    accent: 'FF9C6644',
    header: { fill: 'FFF5EFE6', text: 'FF5B4B3A', rule: 'FF9C6644' },
    title: 'FF3F3A34',
    caption: 'FF8A7E70',
    dataText: 'FF3F3A34',
    stripe: 'FFFBF7F1',
    border: 'FFE8DFD2',
    totalFill: 'FFF1E7DA',
    totalRule: 'FF9C6644',
  },
}

/** Data rows past which the weak zebra fill is worth the visual noise. */
const STRIPE_ROW_THRESHOLD = 7

/** Row numbers of the caption block; `headerRow` is the first styled grid row. */
interface TopLayout {
  readonly titleRow: number
  readonly subtitleRow?: number
  readonly notesRow?: number
  readonly blankRow: number
  readonly headerRow: number
}

/**
 * Caption rows: workbook title, optional subtitle and notes, then one spacer.
 * They occupy the top of every sheet, so a multi-sheet workbook repeats the
 * report name above each table.
 */
function topLayoutOf(workbook: SheetWorkbook): TopLayout {
  let cursor = 2
  const subtitleRow = workbook.subtitle === undefined ? undefined : cursor++
  const notesRow = workbook.notes === undefined ? undefined : cursor++
  const blankRow = cursor++
  return {
    titleRow: 1,
    ...(subtitleRow === undefined ? {} : { subtitleRow }),
    ...(notesRow === undefined ? {} : { notesRow }),
    blankRow,
    headerRow: cursor,
  }
}

/** Merge and style the caption block; a single-column table skips the merge. */
function writeCaptions(
  sheet: Worksheet,
  workbook: SheetWorkbook,
  layout: TopLayout,
  columnCount: number,
  palette: SheetPalette,
): void {
  interface Caption {
    readonly row: number
    readonly text: string
    readonly font: { bold?: boolean, size: number, color: { argb: string } }
    readonly height?: number
    readonly wrap: boolean
  }
  const captions: Caption[] = [
    {
      row: layout.titleRow,
      text: workbook.title,
      font: { bold: true, size: TITLE_SIZE, color: { argb: palette.title } },
      height: HEADER_HEIGHT,
      wrap: false,
    },
  ]
  if (layout.subtitleRow !== undefined && workbook.subtitle !== undefined) {
    captions.push({
      row: layout.subtitleRow,
      text: workbook.subtitle,
      font: { size: CAPTION_SIZE, color: { argb: palette.caption } },
      wrap: false,
    })
  }
  if (layout.notesRow !== undefined && workbook.notes !== undefined) {
    captions.push({
      row: layout.notesRow,
      text: workbook.notes,
      font: { size: CAPTION_SIZE, color: { argb: palette.caption } },
      wrap: true,
    })
  }
  for (const caption of captions) {
    const cell = sheet.getRow(caption.row).getCell(1)
    cell.value = caption.text
    cell.font = caption.font
    cell.alignment = { horizontal: 'left', vertical: 'middle', ...(caption.wrap ? { wrapText: true } : {}) }
    if (columnCount > 1) sheet.mergeCells(caption.row, 1, caption.row, columnCount)
    if (caption.height !== undefined) sheet.getRow(caption.row).height = caption.height
  }
  sheet.getRow(layout.blankRow).height = BLANK_ROW_HEIGHT
}

/**
 * The header row: palette fill with bold text, a medium bottom rule and
 * alignment that follows the column's data (numbers/dates right, text left). A
 * header wider than {@link HEADER_WRAP_WIDTH} wraps on a taller row instead of
 * being squeezed or truncated.
 */
function writeHeader(
  sheet: Worksheet,
  columns: readonly { readonly header: string }[],
  plans: readonly ColumnPlan[],
  headerRow: number,
  palette: SheetPalette,
): void {
  const row = sheet.getRow(headerRow)
  const wrapped = columns.some(column => displayWidth(column.header) > HEADER_WRAP_WIDTH)
  row.height = wrapped ? HEADER_WRAP_HEIGHT : HEADER_HEIGHT
  for (let index = 0; index < columns.length; index += 1) {
    const cell = row.getCell(index + 1)
    const header = columns[index]?.header ?? ''
    const wrapText = displayWidth(header) > HEADER_WRAP_WIDTH
    cell.value = header
    cell.font = { bold: true, size: HEADER_SIZE, color: { argb: palette.header.text } }
    cell.alignment = {
      horizontal: plans[index]?.align ?? 'left',
      vertical: 'middle',
      ...(wrapText ? { wrapText: true } : {}),
    }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: palette.header.fill } }
    cell.border = { bottom: { style: 'medium', color: { argb: palette.header.rule } } }
  }
}

/**
 * Horizontal-only borders: a data row carries one hairline under it and no
 * verticals, a total row carries the medium top rule. Nothing else is drawn,
 * so the grid reads as a table instead of a wall of boxes.
 */
function dataCellBorder(isTotal: boolean, palette: SheetPalette) {
  if (isTotal) return { top: { style: 'medium' as const, color: { argb: palette.totalRule } } }
  return { bottom: { style: 'thin' as const, color: { argb: palette.border } } }
}

/** Whether a value takes this column's number format (text needs `@`). */
function formatApplies(value: RenderedCell, format: string): boolean {
  if (value === null) return false
  if (typeof value === 'number' || value instanceof Date) return true
  return format === TEXT_FORMAT
}

/** Alignment, borders, banding and the resolved number format for one row. */
function styleDataRow(
  row: Row,
  plans: readonly ColumnPlan[],
  values: readonly RenderedCell[],
  isTotal: boolean,
  striped: boolean,
  palette: SheetPalette,
): void {
  for (let column = 0; column < plans.length; column += 1) {
    const cell = row.getCell(column + 1)
    cell.border = dataCellBorder(isTotal, palette)
    cell.font = { size: DATA_SIZE, color: { argb: palette.dataText }, ...(isTotal ? { bold: true } : {}) }
    cell.alignment = { horizontal: plans[column]?.align ?? 'left', vertical: 'middle' }
    if (isTotal) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: palette.totalFill } }
    else if (striped) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: palette.stripe } }
    const format = plans[column]?.format
    const value = values[column] ?? null
    if (format !== undefined && formatApplies(value, format)) cell.numFmt = format
  }
}

/**
 * Characters that put a following token in a real reference position: an
 * arithmetic/comparison operator, a function argument separator, a range
 * colon, or the sheet separator of a cross-sheet reference. A token preceded
 * by anything else — an identifier character, `%` — is left as authored.
 */
const REFERENCE_PRECEDING: ReadonlySet<string> = new Set(['=', '(', ',', '+', '-', '*', '/', '^', ':', '&', '<', '>', '!'])

/**
 * Shift the A1 references inside a formula expression by the caption offset.
 *
 * The document's formulas are written in document coordinates (header = row 1),
 * so once the caption block pushes the grid down, both the target cell and
 * every reference the expression makes must move with it. A token is rewritten
 * only when it sits in a real reference position — the expression start, or
 * just after an operator/paren/comma/colon/sheet separator (whitespace skipped)
 * — and addresses a column inside this sheet's own grid. The second condition
 * is what keeps a short financial named region such as `Q1` on a two-column
 * sheet from being mistaken for cell Q1; double-quoted string literals are
 * matched first and never touched, and whole-column/row references (`A:A`,
 * `2:2`) carry no row to shift.
 */
function offsetFormulaRows(expression: string, offset: number, columnCount: number): string {
  if (offset === 0) return expression
  const referencePattern = /"(?:[^"]|"")*"|(?<![A-Za-z0-9_$.])(\$?[A-Za-z]{1,3}\$?[0-9]{1,7})(?![A-Za-z0-9_(])/gu
  return expression.replace(referencePattern, (matched, reference: string | undefined, index: number) => {
    if (reference === undefined) return matched
    let cursor = index - 1
    while (cursor >= 0 && /\s/u.test(expression.charAt(cursor))) cursor -= 1
    if (cursor >= 0 && !REFERENCE_PRECEDING.has(expression.charAt(cursor))) return matched
    const parsed = parseCellReference(reference)
    if (parsed === undefined || parsed.column > columnCount) return matched
    const row = parsed.row + offset
    if (row < 1 || row > MAX_CELL_REFERENCE_ROW) return matched
    const columnAbsolute = reference.startsWith('$')
    const rowAbsolute = reference.includes('$', 1)
    return `${columnAbsolute ? '$' : ''}${columnIndexToLetters(parsed.column)}${rowAbsolute ? '$' : ''}${row}`
  })
}

/** `RRGGBB` → opaque ARGB; an already-alpha value passes through uppercased. */
function opaqueArgb(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const upper = value.toUpperCase()
  return upper.length === 6 ? `FF${upper}` : upper
}

/**
 * Render one validated document into a native .xlsx workbook.
 * @param workbook - the checker's normalized document (error-free).
 */
export async function renderSheetWorkbook(workbook: SheetWorkbook): Promise<SheetRenderResult> {
  const xlsx = new Workbook()
  xlsx.creator = 'DSH APP'
  xlsx.title = workbook.title
  xlsx.subject = workbook.title
  xlsx.created = new Date()
  xlsx.modified = new Date()
  // Formulas carry no cached result, so the viewer must recalculate on open.
  xlsx.calcProperties.fullCalcOnLoad = true

  const palette = SHEET_PALETTES[workbook.style?.palette ?? 'neutral']
  const tabColor = opaqueArgb(workbook.style?.tabColor) ?? palette.accent
  const stripes = workbook.style?.stripes ?? true
  const dates = workbook.style?.dates ?? true

  let rowCount = 0
  let formulaCount = 0
  for (const table of workbook.sheets) {
    const layout = topLayoutOf(workbook)
    const columnCount = table.columns.length
    const columnCells = table.columns.map((_column, index) => table.rows.map(row => row[index] ?? null))
    const plans = table.columns.map((column, index) => planForColumn(column, columnCells[index] ?? [], dates))
    // An explicit width is the author's floor, never a ceiling: a width below
    // the required one would render `###`, so the required width wins.
    const widths = table.columns.map((column, index) => {
      const required = requiredColumnWidth(column.header, columnCells[index] ?? [], plans[index]!)
      return column.width === undefined ? required : Math.max(column.width, required)
    })
    const nonTotalRows = table.rows.filter(row => !(typeof row[0] === 'string' && isTotalRowLabel(row[0]))).length
    const stripeEnabled = stripes && nonTotalRows > STRIPE_ROW_THRESHOLD

    // The frozen split covers the caption block plus the header, so the column
    // names stay visible while the reader scrolls a long table.
    const sheet = xlsx.addWorksheet(table.name, {
      properties: { tabColor: { argb: tabColor } },
      views: [{ state: 'frozen', ySplit: layout.headerRow, showGridLines: false }],
    })
    // No `header` key here: the header is written at its own row, below the captions.
    sheet.columns = table.columns.map((_column, index) => ({
      width: widths[index],
      ...(plans[index]?.format === undefined ? {} : { numFmt: plans[index]?.format }),
    }))
    writeCaptions(sheet, workbook, layout, columnCount, palette)
    writeHeader(sheet, table.columns, plans, layout.headerRow, palette)

    const lastRow = layout.headerRow + table.rows.length
    sheet.pageSetup.printArea = `A1:${columnIndexToLetters(Math.max(columnCount, 1))}${lastRow}`

    let stripeIndex = 0
    for (const row of table.rows) {
      const rendered = row.map((cell, column) => plans[column]?.convert(cell) ?? cell)
      const added = sheet.addRow(rendered as readonly unknown[] as (string | number | null | Date)[])
      rowCount += 1
      const isTotal = isTotalRowLabel(typeof row[0] === 'string' ? row[0] : '')
      // The total row stays unbanded, and the stripe parity counts only detail rows.
      const striped = stripeEnabled && !isTotal && stripeIndex % 2 === 1
      if (!isTotal) stripeIndex += 1
      styleDataRow(added, plans, rendered, isTotal, striped, palette)
    }

    // Document coordinates are shifted by the caption block; formulas follow
    // the same offset as the data they address.
    const offset = layout.headerRow - 1
    for (const [reference, expression] of Object.entries(table.formulas)) {
      const target = parseCellReference(reference)
      if (target === undefined) {
        // Unreachable after a clean check; fail loudly instead of dropping a
        // formula the model believes it wrote.
        throw new Error(`公式单元格引用无效：${reference}（校验已通过，请报告此问题）`)
      }
      const cell = sheet.getCell(`${columnIndexToLetters(target.column)}${target.row + offset}`)
      cell.value = { formula: offsetFormulaRows(expression.replace(/^=/u, ''), offset, columnCount) }
      const format = plans[target.column - 1]?.format
      if (format !== undefined) cell.numFmt = format
      formulaCount += 1
    }
  }

  const buffer = await xlsx.xlsx.writeBuffer()
  return { bytes: new Uint8Array(buffer), sheetCount: workbook.sheets.length, rowCount, formulaCount }
}
