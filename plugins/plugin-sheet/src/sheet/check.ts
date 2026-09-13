/**
 * SHEET checker: structure and measurability of one `.sheet.json` document,
 * with no external effects. A failed check is a normal authoring result — the
 * point is to hand the model every problem (sheet name, row, column, JSON
 * path, actionable Chinese fix) in one pass, which is what makes the export
 * gate trustworthy: sheet_render runs this same checker and refuses to write a
 * single byte while an error stands.
 *
 * Every issue carries 1-based spreadsheet coordinates (header row = 1) so a
 * model never has to translate `sheets[0].rows[3][1]` into "第 5 行 B 列".
 *
 * @module @dsh-app/plugin-sheet/sheet/check
 */

import { createHash } from 'node:crypto'
import {
  dateColumnMatch,
  decimalPlacesOf,
  isRatioColumn,
  numericTextValue,
  planForColumn,
  requiredColumnWidth,
  TEXT_FORMAT,
} from './format.ts'
import {
  asBoolean,
  asNumber,
  asRecord,
  asString,
  COLOR_PATTERN,
  COLUMN_FIELDS,
  columnIndexToLetters,
  isRelativeR1C1,
  isTotalRowLabel,
  MAX_CELL_TEXT_CHARS,
  MAX_COLUMNS_PER_SHEET,
  MAX_FORMULA_CHARS,
  MAX_HEADER_CHARS,
  MAX_LAYOUT_COLUMNS,
  MAX_LAYOUT_HEADER_CHARS,
  MAX_LAYOUT_ROWS,
  MAX_NUMBER_FORMAT_CHARS,
  MAX_ROWS_PER_SHEET,
  MAX_SHEETS,
  MAX_SHEET_NAME_CHARS,
  MAX_TITLE_CHARS,
  MAX_TOTAL_CELLS,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  parseCellReference,
  ROOT_FIELDS,
  SHEET_NAME_FORBIDDEN,
  SHEET_PALETTE_NAMES,
  STYLE_FIELDS,
  TABLE_FIELDS,
  TEXT_HEAVY_CELL_CHARS,
} from './types.ts'
import type { SheetCell, SheetCheckResult, SheetColumn, SheetIssue, SheetStyle, SheetTable, SheetWorkbook } from './types.ts'

/**
 * Formula shapes that reach outside the workbook: bracket workbook
 * references (`[Book.xlsx]Sheet1!A1`) and DDE / URL command payloads.
 * Internal references, functions and arithmetic all stay allowed.
 */
const EXTERNAL_FORMULA_PATTERN = /\[[^\]]+\]/
const DDE_FORMULA_PATTERN = /(?:^|[^A-Za-z])(?:cmd|http|https|ftp|mailto|file)\s*[|:]/i

/** Issues beyond this count are counted but not listed (huge documents). */
export const MAX_REPORTED_ISSUES = 500

/** What a JSON text physically allows: the largest document the tools read. */
export const MAX_SHEET_FILE_BYTES = 8 * 1024 * 1024

interface Context {
  readonly issues: SheetIssue[]
  errors: number
  warnings: number
  /** Issues counted but dropped from `issues` past {@link MAX_REPORTED_ISSUES}. */
  suppressed: number
  /** Cells seen, for the whole-document budget. */
  cells: number
  /** Lowercased sheet name → sheet index, for the duplicate rule. */
  readonly names: Map<string, number>
}

/** One full validation pass: the normalized workbook plus authoritative counts. */
export interface SheetAnalysis {
  /** Present only when the document is error-free. */
  readonly workbook: SheetWorkbook | undefined
  /** Capped at {@link MAX_REPORTED_ISSUES}. */
  readonly issues: readonly SheetIssue[]
  readonly errorCount: number
  readonly warningCount: number
  readonly suppressedCount: number
  readonly sheetCount: number
  readonly rowCount: number
  readonly formulaCount: number
}

function report(context: Context, issue: SheetIssue): void {
  if (issue.severity === 'error') context.errors += 1
  else context.warnings += 1
  if (context.issues.length < MAX_REPORTED_ISSUES) context.issues.push(issue)
  else context.suppressed += 1
}

function reportUnknownFields(
  context: Context,
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (allowed.has(key)) continue
    report(context, {
      code: 'unknown-field',
      severity: 'warning',
      path: `${path}.${key}`,
      message: `${path}.${key}：「${key}」不是支持的字段，已忽略；支持字段：${[...allowed].join('、')}。`,
    })
  }
}

function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Best-effort raw-shape counts, so a failing document still reports sizes. */
function summarize(value: unknown): { sheetCount: number, rowCount: number, formulaCount: number } {
  const root = asRecord(value)
  const sheets = root?.sheets
  if (!Array.isArray(sheets)) return { sheetCount: 0, rowCount: 0, formulaCount: 0 }
  let sheetCount = 0
  let rowCount = 0
  let formulaCount = 0
  for (const raw of sheets) {
    const table = asRecord(raw)
    if (table === undefined) continue
    sheetCount += 1
    if (Array.isArray(table.rows)) rowCount += table.rows.length
    const formulas = asRecord(table.formulas)
    if (formulas !== undefined) formulaCount += Object.keys(formulas).length
  }
  return { sheetCount, rowCount, formulaCount }
}

/** Parse one sheet's columns; returns the definitions plus the grid width. */
function visitColumns(context: Context, raw: unknown, path: string, sheet: string): { columns: SheetColumn[], width: number } {
  if (!Array.isArray(raw)) {
    report(context, {
      code: 'missing-columns',
      severity: 'error',
      path,
      sheet,
      message: `${path}：必须是数组，每项是 {"header": "列名", "width"?: 数字, "numberFormat"?: "格式"}（最多 ${MAX_COLUMNS_PER_SHEET} 列）。`,
    })
    return { columns: [], width: 0 }
  }
  if (raw.length === 0) {
    report(context, {
      code: 'missing-columns',
      severity: 'error',
      path,
      sheet,
      message: `${path}：至少要定义 1 列（header 非空且唯一）。`,
    })
    return { columns: [], width: 0 }
  }
  if (raw.length > MAX_COLUMNS_PER_SHEET) {
    report(context, {
      code: 'too-many-columns',
      severity: 'error',
      path,
      sheet,
      message: `${path}：${raw.length} 列超过单表上限 ${MAX_COLUMNS_PER_SHEET} 列；请拆分成多张工作表（本次只校验前 ${MAX_COLUMNS_PER_SHEET} 列）。`,
    })
  }
  // A printable sheet stops being readable well before Excel's own 16384-column
  // wall, so the readability limit is the one that gates the export.
  if (raw.length > MAX_LAYOUT_COLUMNS) {
    report(context, {
      code: 'too-many-columns-for-layout',
      severity: 'error',
      path,
      sheet,
      message: `${path}：${raw.length} 列超过单表建议上限 ${MAX_LAYOUT_COLUMNS} 列，横向排版会难以阅读；请拆分成多张工作表，或把表转置成「每行一条记录」的窄表。`,
    })
  }
  const limit = Math.min(raw.length, MAX_COLUMNS_PER_SHEET)
  const columns: SheetColumn[] = []
  const seen = new Map<string, number>()
  for (let index = 0; index < limit; index += 1) {
    const columnPath = `${path}[${index}]`
    const record = asRecord(raw[index])
    if (record === undefined) {
      report(context, {
        code: 'invalid-column',
        severity: 'error',
        path: columnPath,
        sheet,
        column: index + 1,
        message: `${columnPath}：必须是对象 {"header": "列名", "width"?: 数字, "numberFormat"?: "格式"}。`,
      })
      continue
    }
    reportUnknownFields(context, record, COLUMN_FIELDS, columnPath)
    const header = asString(record.header)
    let headerValue: string | undefined
    if (header === undefined || header.trim() === '') {
      report(context, {
        code: 'invalid-header',
        severity: 'error',
        path: `${columnPath}.header`,
        sheet,
        column: index + 1,
        message: `${columnPath}.header：必须是非空字符串（最多 ${MAX_HEADER_CHARS} 字）。`,
      })
    } else if (header.length > MAX_HEADER_CHARS) {
      report(context, {
        code: 'invalid-header',
        severity: 'error',
        path: `${columnPath}.header`,
        sheet,
        column: index + 1,
        message: `${columnPath}.header：列名 ${header.length} 字超过上限 ${MAX_HEADER_CHARS} 字；请用简短列名。`,
      })
    } else {
      const key = header.trim().toLocaleLowerCase()
      const duplicate = seen.get(key)
      if (duplicate !== undefined) {
        report(context, {
          code: 'duplicate-header',
          severity: 'error',
          path: `${columnPath}.header`,
          sheet,
          column: index + 1,
          message: `${columnPath}.header：列名「${header}」与 columns[${duplicate}] 重复；列名必须唯一（不区分大小写），请改写或合并这两列。`,
        })
      } else {
        seen.set(key, index)
        headerValue = header
      }
    }
    // Readability cap, distinct from the 200-char storage cap above: a header
    // that long cannot be read in a column and usually hides a unit or a
    // sentence that belongs in the title/notes instead.
    if (header !== undefined && header.trim() !== '' && header.length <= MAX_HEADER_CHARS && header.length > MAX_LAYOUT_HEADER_CHARS) {
      report(context, {
        code: 'header-too-long',
        severity: 'error',
        path: `${columnPath}.header`,
        sheet,
        column: index + 1,
        message: `${columnPath}.header：列名 ${header.length} 字超过建议上限 ${MAX_LAYOUT_HEADER_CHARS} 字；请精简为「指标 + 单位」（如「营收（万元）」），详细口径写进 columns 之外的说明行。`,
      })
    }
    const width = record.width === undefined ? undefined : asNumber(record.width)
    if (record.width !== undefined && (width === undefined || width < MIN_COLUMN_WIDTH || width > MAX_COLUMN_WIDTH)) {
      report(context, {
        code: 'invalid-column-width',
        severity: 'error',
        path: `${columnPath}.width`,
        sheet,
        column: index + 1,
        message: `${columnPath}.width：列宽必须是 ${MIN_COLUMN_WIDTH}–${MAX_COLUMN_WIDTH} 之间的数字（Excel 字符宽度单位）；省略时按表头自动取值。`,
      })
    }
    const numberFormat = record.numberFormat === undefined ? undefined : asString(record.numberFormat)
    if (record.numberFormat !== undefined && (numberFormat === undefined || numberFormat.trim() === '' || numberFormat.length > MAX_NUMBER_FORMAT_CHARS)) {
      report(context, {
        code: 'invalid-number-format',
        severity: 'error',
        path: `${columnPath}.numberFormat`,
        sheet,
        column: index + 1,
        message: `${columnPath}.numberFormat：必须是非空字符串且不超过 ${MAX_NUMBER_FORMAT_CHARS} 字（如 "0.00"、"#,##0"、"0.0%"、"yyyy-mm-dd"）。`,
      })
    }
    columns.push({
      header: headerValue ?? '',
      ...(width === undefined ? {} : { width }),
      ...(numberFormat === undefined ? {} : { numberFormat }),
    })
  }
  return { columns, width: limit }
}

/** Parsed rows plus whether any row was short/long against the column grid. */
interface RowsResult {
  readonly rows: SheetCell[][]
  /**
   * True once a `row-width` error fired. Empty columns and rows are then
   * already accounted for cell by cell, so the all-null rules stay quiet to
   * avoid tripling one root cause.
   */
  readonly widthMismatch: boolean
}

/** Parse one sheet's rows against the column grid. */
function visitRows(context: Context, raw: unknown, path: string, sheet: string, gridWidth: number): RowsResult {
  if (!Array.isArray(raw)) {
    report(context, {
      code: 'missing-rows',
      severity: 'error',
      path,
      sheet,
      message: `${path}：必须是数组，每行长度等于列数（${gridWidth}）；空表写 []。`,
    })
    return { rows: [], widthMismatch: false }
  }
  if (raw.length > MAX_ROWS_PER_SHEET) {
    report(context, {
      code: 'too-many-rows',
      severity: 'error',
      path,
      sheet,
      message: `${path}：${raw.length} 行超过单表上限 ${MAX_ROWS_PER_SHEET} 行；请拆分到多张工作表（本次只校验前 ${MAX_ROWS_PER_SHEET} 行）。`,
    })
  }
  // Warning, not error: a long ledger is legitimate, but past this size a
  // single sheet is no longer reviewable and belongs in several sheets.
  if (raw.length > MAX_LAYOUT_ROWS && raw.length <= MAX_ROWS_PER_SHEET) {
    report(context, {
      code: 'long-table',
      severity: 'warning',
      path,
      sheet,
      message: `${path}：${raw.length} 行超过建议上限 ${MAX_LAYOUT_ROWS} 行；请按期间/类别拆分到多张工作表，便于核对与打印。`,
    })
  }
  const limit = Math.min(raw.length, MAX_ROWS_PER_SHEET)
  const rows: SheetCell[][] = []
  let widthMismatch = false
  for (let index = 0; index < limit; index += 1) {
    const rowPath = `${path}[${index}]`
    const spreadsheetRow = index + 2
    const rawRow = raw[index]
    if (!Array.isArray(rawRow)) {
      report(context, {
        code: 'invalid-row',
        severity: 'error',
        path: rowPath,
        sheet,
        row: spreadsheetRow,
        message: `${rowPath}（第 ${spreadsheetRow} 行）：必须是数组，长度等于列数（${gridWidth}）。`,
      })
      continue
    }
    context.cells += rawRow.length
    if (rawRow.length !== gridWidth) {
      widthMismatch = true
      report(context, {
        code: 'row-width',
        severity: 'error',
        path: rowPath,
        sheet,
        row: spreadsheetRow,
        message: `${rowPath}（第 ${spreadsheetRow} 行）：有 ${rawRow.length} 个单元格，应为 ${gridWidth} 个（与 columns 一致）；缺少的用 null 补齐，多余的删除。`,
      })
    }
    const row: SheetCell[] = []
    for (let column = 0; column < rawRow.length; column += 1) {
      const cell = rawRow[column]
      const columnNumber = column + 1
      const cellPath = `${rowPath}[${column}]`
      const cellAddress = `${columnIndexToLetters(columnNumber)}${spreadsheetRow}`
      if (cell === null) {
        row.push(null)
        continue
      }
      if (typeof cell === 'number') {
        if (!Number.isFinite(cell)) {
          report(context, {
            code: 'invalid-cell',
            severity: 'error',
            path: cellPath,
            sheet,
            row: spreadsheetRow,
            column: columnNumber,
            cell: cellAddress,
            message: `${cellPath}（${cellAddress}）：数字必须是有限值；请改写为具体数值或文本。`,
          })
          continue
        }
        row.push(cell)
        continue
      }
      if (typeof cell === 'string') {
        if (cell.length > MAX_CELL_TEXT_CHARS) {
          report(context, {
            code: 'cell-text-too-long',
            severity: 'error',
            path: cellPath,
            sheet,
            row: spreadsheetRow,
            column: columnNumber,
            cell: cellAddress,
            message: `${cellPath}（${cellAddress}）：文本 ${cell.length} 字超过单格上限 ${MAX_CELL_TEXT_CHARS} 字；请拆分到多行/多列或改用更短的表述。`,
          })
          continue
        }
        if (cell.startsWith('=')) {
          report(context, {
            code: 'formula-looking-text',
            severity: 'warning',
            path: cellPath,
            sheet,
            row: spreadsheetRow,
            column: columnNumber,
            cell: cellAddress,
            message: `${cellPath}（${cellAddress}）：文本以 = 开头，可能被表格软件当作公式；若意图是公式请放进 formulas 映射，若是纯文本请改写（如前面补一个空格）。`,
          })
        }
        row.push(cell)
        continue
      }
      report(context, {
        code: 'invalid-cell',
        severity: 'error',
        path: cellPath,
        sheet,
        row: spreadsheetRow,
        column: columnNumber,
        cell: cellAddress,
        message: `${cellPath}（${cellAddress}）：单元格只接受字符串、数字或 null（收到 ${cell === undefined ? 'undefined' : typeof cell}）；数字去掉单位写成数字，单位放进列名或相邻单元格。`,
      })
    }
    rows.push(row)
  }
  return { rows, widthMismatch }
}

/** Parse one sheet's formula map; returns only the entries that are usable. */
function visitFormulas(
  context: Context,
  raw: unknown,
  path: string,
  sheet: string,
  gridWidth: number,
  rows: readonly (readonly SheetCell[])[],
): Record<string, string> {
  const dataRows = rows.length
  if (raw === undefined) return {}
  const record = asRecord(raw)
  if (record === undefined) {
    report(context, {
      code: 'invalid-formulas',
      severity: 'error',
      path,
      sheet,
      message: `${path}：必须是对象，键为 A1（如 "B2"）或绝对 R1C1（如 "R2C2"）单元格引用，值为以 = 开头的公式字符串。`,
    })
    return {}
  }
  const formulas: Record<string, string> = {}
  const claimed = new Map<string, string>()
  for (const [key, rawValue] of Object.entries(record)) {
    const formulaPath = `${path}.${key}`
    const reference = parseCellReference(key)
    if (reference === undefined) {
      report(context, {
        code: isRelativeR1C1(key) ? 'relative-r1c1-key' : 'invalid-formula-key',
        severity: 'error',
        path: formulaPath,
        sheet,
        message: isRelativeR1C1(key)
          ? `${formulaPath}：相对 R1C1 引用（含 [..] 或省略行列号）无法确定目标单元格；请改用 A1（如 B2）或绝对 R1C1（如 R2C2）。`
          : `${formulaPath}：键必须是单元格引用，如 A1 写法 "B2"、"$B$2" 或绝对 R1C1 写法 "R2C2"。`,
      })
      continue
    }
    const previous = claimed.get(reference.a1)
    if (previous !== undefined) {
      report(context, {
        code: 'duplicate-formula-target',
        severity: 'error',
        path: formulaPath,
        sheet,
        row: reference.row,
        column: reference.column,
        cell: reference.a1,
        message: `${formulaPath}：与 formulas.${previous} 指向同一单元格 ${reference.a1}；请只保留一条公式。`,
      })
      continue
    }
    const value = asString(rawValue)
    if (value === undefined || value.trim() === '' || !value.startsWith('=')) {
      report(context, {
        code: 'invalid-formula',
        severity: 'error',
        path: formulaPath,
        sheet,
        row: reference.row,
        column: reference.column,
        cell: reference.a1,
        message: `${formulaPath}：公式必须是非空字符串且以 = 开头（如 "=SUM(B2:B4)"）。`,
      })
      continue
    }
    if (value.length > MAX_FORMULA_CHARS) {
      report(context, {
        code: 'formula-too-long',
        severity: 'error',
        path: formulaPath,
        sheet,
        row: reference.row,
        column: reference.column,
        cell: reference.a1,
        message: `${formulaPath}：公式 ${value.length} 字超过上限 ${MAX_FORMULA_CHARS} 字；请拆分计算步骤。`,
      })
      continue
    }
    // External-workbook references and DDE/URL payloads must never reach the
    // written file: a spreadsheet handed to someone else would then carry a
    // link (or a command channel) that the opening application may act on.
    if (EXTERNAL_FORMULA_PATTERN.test(value) || DDE_FORMULA_PATTERN.test(value)) {
      report(context, {
        code: 'external-formula',
        severity: 'error',
        path: formulaPath,
        sheet,
        row: reference.row,
        column: reference.column,
        cell: reference.a1,
        message: `${formulaPath}：公式包含外部工作簿引用或可执行链接（[ ]、cmd|、http、ftp 等），本工具只允许引用本工作簿内的单元格；请改写为内部引用。`,
      })
      continue
    }
    const lastColumn = columnIndexToLetters(Math.max(gridWidth, 1))
    if (reference.row > dataRows + 1 || reference.column > gridWidth) {
      report(context, {
        code: 'formula-out-of-range',
        severity: 'error',
        path: formulaPath,
        sheet,
        row: reference.row,
        column: reference.column,
        cell: reference.a1,
        message: `${formulaPath}：单元格 ${reference.a1} 超出本表数据范围（第 1 行是表头，数据行 2–${dataRows + 1}，列 A–${lastColumn}）；请改用范围内的单元格，或先补足行列。`,
      })
      continue
    }
    if (reference.row === 1) {
      report(context, {
        code: 'formula-overwrites-header',
        severity: 'warning',
        path: formulaPath,
        sheet,
        row: 1,
        column: reference.column,
        cell: reference.a1,
        message: `${formulaPath}：公式写入表头单元格 ${reference.a1}，会覆盖该列列名的显示；如需保留列名请改用表头下方的单元格。`,
      })
    } else {
      // Only a cell that actually holds data is lost; a placeholder null row
      // (the usual home of a total) is exactly where a formula belongs.
      const existing = rows[reference.row - 2]?.[reference.column - 1]
      if (existing !== null && existing !== undefined) {
        report(context, {
          code: 'formula-overwrites-cell',
          severity: 'warning',
          path: formulaPath,
          sheet,
          row: reference.row,
          column: reference.column,
          cell: reference.a1,
          message: `${formulaPath}：公式写入已填数据单元格 ${reference.a1}，导出时该格的原始值会被公式覆盖；如需保留请改用空白单元格。`,
        })
      }
    }
    claimed.set(reference.a1, key)
    formulas[key] = value
  }
  return formulas
}

/** Unit vocabulary that satisfies the large-value unit rule. */
const UNIT_WORD_PATTERN = /单位|万元|亿元|百万元|元|million|thousand|¥|￥/iu
/** Median absolute value past which a column must declare its unit. */
const MAJOR_VALUE_MEDIAN = 1e4

function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const lower = sorted[middle - 1]
  const upper = sorted[middle]
  if (sorted.length % 2 === 1 || lower === undefined || upper === undefined) return sorted[middle] ?? 0
  return (lower + upper) / 2
}

/** Rows and columns already claimed by a formula (document coordinates). */
function formulaTargets(formulas: Readonly<Record<string, string>>): { rows: Set<number>, columns: Set<number> } {
  const rows = new Set<number>()
  const columns = new Set<number>()
  for (const key of Object.keys(formulas)) {
    const reference = parseCellReference(key)
    if (reference === undefined) continue
    rows.add(reference.row)
    columns.add(reference.column)
  }
  return { rows, columns }
}

/** Everything the quality pass needs about one parsed sheet. */
interface QualityInput {
  readonly path: string
  readonly sheet: string
  readonly columns: readonly SheetColumn[]
  readonly rows: readonly (readonly SheetCell[])[]
  readonly formulas: Readonly<Record<string, string>>
  readonly datesEnabled: boolean
  readonly widthMismatch: boolean
  /** Workbook title + subtitle, scanned for a unit declaration. */
  readonly captionText: string
}

/**
 * Readability rules for one parsed sheet: total-row placement, prose columns,
 * date conversion, empty rows/columns and the presentation rules (column
 * width, decimal consistency, ratio formats, numeric-looking text, missing
 * units). All of them are signals about how the sheet reads; only the empty
 * and unreadable cases block, and every issue names its sheet/column/row plus
 * the fix.
 */
function visitTableQuality(context: Context, input: QualityInput): void {
  const { path, sheet, columns, rows, formulas, datesEnabled, widthMismatch, captionText } = input
  let detailBefore = 0
  for (let index = 0; index < rows.length; index += 1) {
    const first = rows[index]?.[0]
    const label = typeof first === 'string' ? first.trim() : ''
    if (label !== '' && isTotalRowLabel(label)) {
      if (detailBefore < 2) {
        report(context, {
          code: 'total-row-without-data',
          severity: 'warning',
          path: `${path}.rows[${index}]`,
          sheet,
          row: index + 2,
          column: 1,
          cell: `A${index + 2}`,
          message: `${path}.rows[${index}]（第 ${index + 2} 行）：首列是「${label}」，但它前面只有 ${detailBefore} 行明细（至少需要 2 行）；合计/总计行应放在明细数据之后。`,
        })
      }
    } else if (first !== null && first !== undefined) {
      detailBefore += 1
    }
  }

  const targets = formulaTargets(formulas)
  const hasAnyData = rows.some(row => row.some(cell => cell !== null && cell !== undefined))

  // An empty column usually means a data or formula gap; the fix is to fill it
  // or drop it, never to ship a blank column. Empty rows inside otherwise
  // populated data are the same defect one axis over. A sheet with no data at
  // all reports its columns only, and a short/long row is already reported per
  // cell by `row-width`, so these rules stay quiet there.
  if (!widthMismatch) {
    for (let column = 0; column < columns.length; column += 1) {
      const cells = rows.map(row => row[column] ?? null)
      if (cells.length === 0 || cells.some(cell => cell !== null)) continue
      if (targets.columns.has(column + 1)) continue
      const header = columns[column]?.header ?? ''
      report(context, {
        code: 'all-null-column',
        severity: 'error',
        path: `${path}.columns[${column}]`,
        sheet,
        column: column + 1,
        message: `${path}.columns[${column}]（第 ${column + 1} 列「${header}」）：整列为空；请补数据、删除该列，或把计算结果写进 formulas。`,
      })
    }
    if (hasAnyData) {
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index] ?? []
        const empty = columns.every((_column, column) => (row[column] ?? null) === null)
        if (!empty || targets.rows.has(index + 2)) continue
        report(context, {
          code: 'all-null-row',
          severity: 'error',
          path: `${path}.rows[${index}]`,
          sheet,
          row: index + 2,
          message: `${path}.rows[${index}]（第 ${index + 2} 行）：整行为空；请补数据、删除该行，或把计算结果写进 formulas。`,
        })
      }
    }
  }

  const captionsHaveUnit = UNIT_WORD_PATTERN.test(captionText)
  for (let column = 0; column < columns.length; column += 1) {
    const definition = columns[column]
    if (definition === undefined) continue
    const header = definition.header
    const cells = rows.map(row => row[column] ?? null)
    const values = cells.filter(value => value !== null)
    const numbers = values.filter((value): value is number => typeof value === 'number')
    const columnPath = `${path}.columns[${column}]`
    const locate = `（第 ${column + 1} 列「${header}」）`

    let nonNull = 0
    let longText = 0
    let textOnly = true
    for (const value of values) {
      nonNull += 1
      if (typeof value !== 'string') {
        textOnly = false
        continue
      }
      if (value.length > TEXT_HEAVY_CELL_CHARS) longText += 1
    }
    // Strictly more than 60% of a text-only column being prose means the grid
    // shape is wrong for the content, not that a few cells need shortening.
    if (textOnly && nonNull > 0 && longText * 100 > nonNull * 60) {
      report(context, {
        code: 'text-heavy-column',
        severity: 'warning',
        path: columnPath,
        sheet,
        column: column + 1,
        message: `${columnPath}${locate}：${longText}/${nonNull} 个单元格文本超过 ${TEXT_HEAVY_CELL_CHARS} 字（超过 60%），Excel 中难以阅读；长文本请改用 dsh-doc 文档模式，或拆成多列/多行并精简表述。`,
      })
    }

    // Width: an explicit width below the header/formatted-value requirement is
    // what turns a number into `###` and squeezes a header, so the checker
    // reports the exact replacement width.
    if (definition.width !== undefined) {
      const required = requiredColumnWidth(header, cells, planForColumn(definition, cells, datesEnabled))
      if (definition.width < required) {
        report(context, {
          code: 'column-too-narrow',
          severity: 'error',
          path: `${columnPath}.width`,
          sheet,
          column: column + 1,
          message: `${columnPath}.width${locate}：列宽 ${definition.width} 小于所需宽度 ${required}（表头与格式化后数值中较宽者 + 2），导出后数字可能显示为 ###、表头会挤压；请把 width 改为 ≥ ${required}，或省略 width 让渲染按内容取值。`,
        })
      }
    }

    // Decimal consistency is only meaningful when the renderer infers the
    // format: an explicit numberFormat already fixes the display.
    if (definition.numberFormat === undefined && numbers.length >= 2) {
      const distinct = [...new Set(numbers.map(decimalPlacesOf))].sort((left, right) => left - right)
      if (distinct.length > 2) {
        report(context, {
          code: 'decimal-mismatch',
          severity: 'error',
          path: columnPath,
          sheet,
          column: column + 1,
          message: `${columnPath}${locate}：同一列混用 ${distinct.length} 种小数位（${distinct.join('、')} 位），显示不齐；请统一数据的小数位，或在列上写死 "numberFormat"（如 "#,##0.00"）。`,
        })
      } else if (distinct.length === 2) {
        report(context, {
          code: 'decimal-mismatch',
          severity: 'warning',
          path: columnPath,
          sheet,
          column: column + 1,
          message: `${columnPath}${locate}：同一列混用 ${distinct.join('、')} 位小数，渲染会按最大位数（${distinct[distinct.length - 1]} 位）统一显示；如需不同精度请在列上写死 "numberFormat"。`,
        })
      }
    }

    // A ratio column stored as a true value must say so; the renderer would
    // otherwise guess, and a reader cannot tell 0.128 from 128.
    if (isRatioColumn(header, values) && !(definition.numberFormat?.includes('%') ?? false)) {
      report(context, {
        code: 'percent-column-format',
        severity: 'error',
        path: columnPath,
        sheet,
        column: column + 1,
        message: `${columnPath}${locate}：列名像比率（率/占比/同比/环比 等）且数值都落在 [-1.5, 1.5]，应以小数真值存储并使用百分比格式；请在列上写 "numberFormat": "0.0%"。`,
      })
    }

    // Numeric-looking text silently destroys sorting and SUM; an explicit `@`
    // is the documented way to declare a code column as intentional text.
    if (definition.numberFormat !== TEXT_FORMAT && values.length > 0) {
      const numericLike = values.filter(value => typeof value === 'string' && numericTextValue(value) !== undefined).length
      if (numericLike * 2 > values.length) {
        report(context, {
          code: 'numeric-text',
          severity: 'warning',
          path: columnPath,
          sheet,
          column: column + 1,
          message: `${columnPath}${locate}：${numericLike}/${values.length} 个单元格是「看起来像数字的文本」（超过 50%），导出后无法排序求和；请改成数字类型，若确为编码（如工号/科目编码）请写 "numberFormat": "@" 明确声明为文本。`,
        })
      }
    }

    if (!captionsHaveUnit && numbers.length > 0) {
      const median = medianOf(numbers.map(value => Math.abs(value)))
      if (median >= MAJOR_VALUE_MEDIAN) {
        report(context, {
          code: 'missing-unit',
          severity: 'warning',
          path: columnPath,
          sheet,
          column: column + 1,
          message: `${columnPath}${locate}：数值量级较大（|值| 中位数 ${Math.round(median)}），但 title/subtitle/列名都没有单位；请在 subtitle 或列名中写清单位（如「营收（万元）」）。`,
        })
      }
    }

    // Date inference rewrites the cell, so the model is told before the export
    // and can opt out with `style.dates: false`. The count comes from the same
    // helper the renderer uses, so the warning never disagrees with the file.
    if (datesEnabled) {
      const match = dateColumnMatch(definition, cells)
      if (match !== undefined) {
        report(context, {
          code: 'date-text-conversion',
          severity: 'warning',
          path: columnPath,
          sheet,
          column: column + 1,
          message: `${columnPath}${locate}：${match.count} 个日期文本将转为日期类型（格式 ${match.format}）；如不希望转换，可在 style 中设置 "dates": false。`,
        })
      }
    }
  }
}

/**
 * Parse `subtitle` / `notes`: optional, but when present they must be usable
 * caption text (an empty string is a typo, not a caption).
 */
function visitRootText(context: Context, raw: unknown, path: string, code: string): string | undefined {
  if (raw === undefined) return undefined
  const text = asString(raw)
  if (text === undefined || text.trim() === '') {
    report(context, {
      code,
      severity: 'error',
      path,
      message: `${path}：必须是非空字符串（最多 ${MAX_TITLE_CHARS} 字）；不需要该说明时请省略此字段。`,
    })
    return undefined
  }
  if (text.length > MAX_TITLE_CHARS) {
    report(context, {
      code,
      severity: 'error',
      path,
      message: `${path}：${text.length} 字超过上限 ${MAX_TITLE_CHARS} 字；请精简。`,
    })
    return undefined
  }
  return text
}

/** Parse the optional presentation switches; unknown keys warn. */
function visitStyle(context: Context, raw: unknown): SheetStyle | undefined {
  if (raw === undefined) return undefined
  const path = '$.style'
  const record = asRecord(raw)
  if (record === undefined) {
    report(context, {
      code: 'invalid-style',
      severity: 'error',
      path,
      message: `${path}：必须是对象 {"stripes"?: 布尔, "tabColor"?: "RRGGBB", "palette"?: "neutral"|"tech"|"warm", "dates"?: 布尔}；不需要样式控制时请省略此字段。`,
    })
    return undefined
  }
  reportUnknownFields(context, record, STYLE_FIELDS, path)
  const stripes = record.stripes === undefined ? undefined : asBoolean(record.stripes)
  if (record.stripes !== undefined && stripes === undefined) {
    report(context, {
      code: 'invalid-style',
      severity: 'error',
      path: `${path}.stripes`,
      message: `${path}.stripes：必须是 true 或 false（省略时默认隔行底色开启）。`,
    })
  }
  const tabColor = record.tabColor === undefined ? undefined : asString(record.tabColor)
  if (record.tabColor !== undefined && (tabColor === undefined || !COLOR_PATTERN.test(tabColor))) {
    report(context, {
      code: 'invalid-style',
      severity: 'error',
      path: `${path}.tabColor`,
      message: `${path}.tabColor：必须是 6 位或 8 位十六进制颜色（如 "1F2937"、"FF1F2937"）。`,
    })
  }
  const paletteRaw = record.palette === undefined ? undefined : asString(record.palette)
  const palette = paletteRaw !== undefined && (SHEET_PALETTE_NAMES as readonly string[]).includes(paletteRaw)
    ? paletteRaw as SheetStyle['palette']
    : undefined
  if (record.palette !== undefined && palette === undefined) {
    report(context, {
      code: 'invalid-style',
      severity: 'error',
      path: `${path}.palette`,
      message: `${path}.palette：必须是 ${SHEET_PALETTE_NAMES.join(' / ')} 之一（省略时默认 neutral，浅色表头、适合打印）。`,
    })
  }
  const dates = record.dates === undefined ? undefined : asBoolean(record.dates)
  if (record.dates !== undefined && dates === undefined) {
    report(context, {
      code: 'invalid-style',
      severity: 'error',
      path: `${path}.dates`,
      message: `${path}.dates：必须是 true 或 false（省略时默认开启日期文本转换）。`,
    })
  }
  return {
    ...(stripes === undefined ? {} : { stripes }),
    ...(tabColor === undefined ? {} : { tabColor }),
    ...(palette === undefined ? {} : { palette }),
    ...(dates === undefined ? {} : { dates }),
  }
}

/** Walk one sheet; `undefined` means that sheet contributed at least one error. */
function visitTable(context: Context, raw: unknown, index: number, datesEnabled: boolean, captionText: string): SheetTable | undefined {
  const path = `$.sheets[${index}]`
  const errorsBefore = context.errors
  const record = asRecord(raw)
  if (record === undefined) {
    report(context, {
      code: 'sheet-not-object',
      severity: 'error',
      path,
      message: `${path}：必须是对象 {"name": "表名", "columns": [...], "rows": [...]}。`,
    })
    return undefined
  }
  reportUnknownFields(context, record, TABLE_FIELDS, path)

  const nameRaw = asString(record.name)
  let name = nameRaw ?? ''
  if (nameRaw === undefined || nameRaw.trim() === '') {
    report(context, {
      code: 'invalid-sheet-name',
      severity: 'error',
      path: `${path}.name`,
      message: `${path}.name：工作表名必须是非空字符串（1–${MAX_SHEET_NAME_CHARS} 字符）。`,
    })
    name = `工作表${index + 1}`
  } else if (nameRaw.length > MAX_SHEET_NAME_CHARS || SHEET_NAME_FORBIDDEN.test(nameRaw)) {
    report(context, {
      code: 'invalid-sheet-name',
      severity: 'error',
      path: `${path}.name`,
      sheet: nameRaw,
      message: `${path}.name：工作表名「${nameRaw}」非法；长度不超过 ${MAX_SHEET_NAME_CHARS} 字符，且不能包含 [ ] : * ? / \\ 这些字符。`,
    })
    name = nameRaw
  } else if (nameRaw.startsWith("'") || nameRaw.endsWith("'")) {
    // Excel refuses a sheet name that begins or ends with an apostrophe; the
    // checker rejects it here so the failure never lands in the .xlsx.
    report(context, {
      code: 'invalid-sheet-name',
      severity: 'error',
      path: `${path}.name`,
      sheet: nameRaw,
      message: `${path}.name：工作表名「${nameRaw}」不能以单引号开头或结尾（Excel 不接受），请改名。`,
    })
    name = nameRaw
  } else {
    const key = nameRaw.toLocaleLowerCase()
    const duplicate = context.names.get(key)
    if (duplicate !== undefined) {
      report(context, {
        code: 'duplicate-sheet-name',
        severity: 'error',
        path: `${path}.name`,
        sheet: nameRaw,
        message: `${path}.name：工作表名「${nameRaw}」与 sheets[${duplicate}] 重复；Excel 的表名不区分大小写，请改用唯一名称。`,
      })
    } else {
      context.names.set(key, index)
    }
  }

  const { columns, width } = visitColumns(context, record.columns, `${path}.columns`, name)
  const { rows, widthMismatch } = visitRows(context, record.rows, `${path}.rows`, name, width)
  const formulas = visitFormulas(context, record.formulas, `${path}.formulas`, name, width, rows)
  visitTableQuality(context, { path, sheet: name, columns, rows, formulas, datesEnabled, widthMismatch, captionText })
  if (context.errors > errorsBefore) return undefined
  return { name, columns, rows, formulas }
}

/**
 * Parse and validate one document. Returns the normalized workbook only when
 * the document is error-free — warnings never block a write or an export. The
 * counts stay authoritative even when the issue list is capped, so a huge
 * broken document is still reported honestly.
 */
export function parseSheetWorkbook(value: unknown): SheetAnalysis {
  const context: Context = { issues: [], errors: 0, warnings: 0, suppressed: 0, cells: 0, names: new Map() }
  const counts = summarize(value)
  const root = asRecord(value)
  const analysis = (workbook: SheetWorkbook | undefined): SheetAnalysis => ({
    workbook,
    issues: context.issues,
    errorCount: context.errors,
    warningCount: context.warnings,
    suppressedCount: context.suppressed,
    sheetCount: counts.sheetCount,
    rowCount: counts.rowCount,
    formulaCount: counts.formulaCount,
  })
  if (root === undefined) {
    report(context, {
      code: 'root-not-object',
      severity: 'error',
      path: '$',
      message: '工程根必须是 JSON 对象：{"title": "工作簿标题", "sheets": [{"name": "表名", "columns": [{"header": "列名"}], "rows": [[]]}]}。',
    })
    return analysis(undefined)
  }
  reportUnknownFields(context, root, ROOT_FIELDS, '$')

  const title = asString(root.title)
  if (title === undefined || title.trim() === '') {
    report(context, {
      code: 'missing-title',
      severity: 'error',
      path: '$.title',
      message: '$.title：必须是非空字符串（工作簿标题，会写进 .xlsx 文档属性），例如 "2026 年一季度经营数据"。',
    })
  } else if (title.length > MAX_TITLE_CHARS) {
    report(context, {
      code: 'title-too-long',
      severity: 'error',
      path: '$.title',
      message: `$.title：标题 ${title.length} 字超过上限 ${MAX_TITLE_CHARS} 字。`,
    })
  }

  const subtitle = visitRootText(context, root.subtitle, '$.subtitle', 'invalid-subtitle')
  const notes = visitRootText(context, root.notes, '$.notes', 'invalid-notes')
  const style = visitStyle(context, root.style)
  const datesEnabled = style?.dates ?? true
  const captionText = [title ?? '', subtitle ?? ''].filter(text => text !== '').join(' ')

  const sheetsRaw = root.sheets
  if (!Array.isArray(sheetsRaw) || sheetsRaw.length === 0) {
    report(context, {
      code: 'missing-sheets',
      severity: 'error',
      path: '$.sheets',
      message: `$.sheets：必须是非空数组，每项一张工作表（最多 ${MAX_SHEETS} 张）。`,
    })
    return analysis(undefined)
  }
  if (sheetsRaw.length > MAX_SHEETS) {
    report(context, {
      code: 'too-many-sheets',
      severity: 'error',
      path: '$.sheets',
      message: `$.sheets：${sheetsRaw.length} 张超过上限 ${MAX_SHEETS} 张；请拆分成多个工程文件（本次只校验前 ${MAX_SHEETS} 张）。`,
    })
  }
  const limit = Math.min(sheetsRaw.length, MAX_SHEETS)
  const sheets: SheetTable[] = []
  for (let index = 0; index < limit; index += 1) {
    const table = visitTable(context, sheetsRaw[index], index, datesEnabled, captionText)
    if (table !== undefined) sheets.push(table)
  }
  if (context.cells > MAX_TOTAL_CELLS) {
    report(context, {
      code: 'too-many-cells',
      severity: 'error',
      path: '$.sheets',
      message: `$.sheets：合计约 ${context.cells} 个单元格超过上限 ${MAX_TOTAL_CELLS}；请精简数据或拆分成多个工程文件。`,
    })
  }
  if (context.errors > 0) return analysis(undefined)
  return analysis({
    title: title ?? '',
    ...(subtitle === undefined ? {} : { subtitle }),
    ...(notes === undefined ? {} : { notes }),
    ...(style === undefined ? {} : { style }),
    sheets,
  })
}

/** Reduce one validation pass to the model-facing result. */
export function sheetCheckResult(analysis: SheetAnalysis, digest = ''): SheetCheckResult {
  return {
    status: analysis.errorCount > 0 ? 'needs_revision' : analysis.warningCount > 0 ? 'warning' : 'pass',
    digest,
    sheetCount: analysis.sheetCount,
    rowCount: analysis.rowCount,
    formulaCount: analysis.formulaCount,
    errorCount: analysis.errorCount,
    warningCount: analysis.warningCount,
    suppressedCount: analysis.suppressedCount,
    issues: analysis.issues,
  }
}

/** Validate one parsed document and reduce it to the model-facing result. */
export function checkSheetWorkbook(value: unknown): SheetCheckResult {
  return sheetCheckResult(parseSheetWorkbook(value), sha256Of(JSON.stringify(value) ?? ''))
}

/**
 * Chinese, actionable plain-text rendering: one line per issue with its sheet,
 * row, column and JSON path — the block sheet_render returns when it refuses
 * an export.
 */
export function formatSheetIssues(check: SheetCheckResult): string {
  const title = check.status === 'needs_revision' ? '校验未通过，需要调整' : check.status === 'warning' ? '校验通过，有建议' : '校验通过'
  const lines: string[] = [`${title}：${check.errorCount} 项需要修正，${check.warningCount} 项建议。`]
  for (const issue of check.issues) {
    lines.push([
      issue.severity === 'error' ? '需修正' : '建议',
      issue.sheet === undefined ? '' : `表「${issue.sheet}」`,
      issue.row === undefined ? '' : `第 ${issue.row} 行`,
      issue.column === undefined ? '' : `${columnIndexToLetters(issue.column)} 列`,
      issue.path ?? '',
      `[${issue.code}] ${issue.message}`,
    ].filter(part => part !== '').join(' · '))
  }
  const suppressed = check.suppressedCount
  if (suppressed > 0) {
    lines.push(`另有 ${suppressed} 项未逐条列出（单次最多列出 ${MAX_REPORTED_ISSUES} 条）；请先修复上述问题后重新检查。`)
  }
  if (check.status === 'needs_revision') {
    lines.push('按 表名 + 行号 + 列 逐条修改 .sheet.json 后重新运行 sheet_check；存在 error 时不会写出工程也不会导出 .xlsx。')
  }
  return lines.join('\n')
}
