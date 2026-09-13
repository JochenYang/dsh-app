/**
 * SHEET engineering format: the in-memory workbook AST, the format limits
 * every layer shares, and the two cell-reference dialects (A1 and absolute
 * R1C1) the checker and renderer must agree on.
 *
 * The format is one JSON document (`*.sheet.json`) holding a list of plain
 * sheets — column definitions, row arrays and an optional per-cell formula
 * map. It is deliberately flat: everything a spreadsheet needs to be
 * *rebuilt* as an editable workbook, and nothing that only exists inside a
 * binary .xlsx (styling beyond the header row, merged ranges, pivot caches).
 * What is not in the document cannot be checked, so the checker owns exactly
 * these fields.
 *
 * @module @dsh-app/plugin-sheet/sheet/types
 */

/** Maximum sheets in one document. */
export const MAX_SHEETS = 20
/** Maximum rows per sheet (header excluded). */
export const MAX_ROWS_PER_SHEET = 5_000
/** Maximum columns per sheet. */
export const MAX_COLUMNS_PER_SHEET = 64
/** Cell budget across all sheets — the bound that keeps rendering cheap. */
export const MAX_TOTAL_CELLS = 500_000
/** Excel sheet-name limit. */
export const MAX_SHEET_NAME_CHARS = 31
/** Excel column-width range. */
export const MIN_COLUMN_WIDTH = 1
export const MAX_COLUMN_WIDTH = 255
/** Single-cell text limit (the Excel cell limit, so nothing truncates). */
export const MAX_CELL_TEXT_CHARS = 32_767
/** Header and workbook-title length caps (readability, not an Excel limit). */
export const MAX_HEADER_CHARS = 200
export const MAX_TITLE_CHARS = 200
/**
 * Layout limits that keep a sheet readable rather than merely storable.
 * Beyond them the fix is a different shape (split, transpose, or word
 * processor), so the checker says so instead of exporting a wall of cells.
 */
export const MAX_LAYOUT_COLUMNS = 12
export const MAX_LAYOUT_ROWS = 2_000
export const MAX_LAYOUT_HEADER_CHARS = 24
export const TEXT_HEAVY_CELL_CHARS = 40
/** Formula expression cap. */
export const MAX_FORMULA_CHARS = 8_192
/** Number-format literal cap. */
export const MAX_NUMBER_FORMAT_CHARS = 64
/** Excel's own grid bounds, used to reject impossible references early. */
export const MAX_CELL_REFERENCE_ROW = 1_048_576
export const MAX_CELL_REFERENCE_COLUMN = 16_384
/** Characters Excel forbids in a sheet name. */
export const SHEET_NAME_FORBIDDEN = /[[\]:*?/\\]/u

/**
 * First-column labels the renderer treats as a total row (visual emphasis
 * only — the renderer never guesses an arithmetic meaning) and the checker
 * uses to require a real detail block above one. The English forms match
 * case-insensitively through {@link isTotalRowLabel}; the Chinese forms are
 * exact (they have no case).
 */
export const TOTAL_ROW_LABELS: ReadonlySet<string> = new Set(['合计', '总计', '小计', '汇总', 'Total', 'Subtotal', 'Sum'])

const TOTAL_ROW_LABELS_CASELESS: ReadonlySet<string> = new Set([...TOTAL_ROW_LABELS].map(label => label.toLocaleLowerCase()))

/** Whether a first-column value marks a total row (see {@link TOTAL_ROW_LABELS}). */
export function isTotalRowLabel(value: string): boolean {
  const trimmed = value.trim()
  return TOTAL_ROW_LABELS.has(trimmed) || TOTAL_ROW_LABELS_CASELESS.has(trimmed.toLocaleLowerCase())
}

/** One cell value as the format accepts it. */
export type SheetCell = string | number | null

/** One column definition. */
export interface SheetColumn {
  readonly header: string
  /** Excel column width in character units. */
  readonly width?: number
  /** Excel number-format literal, e.g. `0.00`, `#,##0`, `0.0%`, `yyyy-mm-dd`. */
  readonly numberFormat?: string
}

/** One sheet: columns define the grid, rows fill it, formulas sit on top. */
export interface SheetTable {
  readonly name: string
  readonly columns: readonly SheetColumn[]
  readonly rows: readonly (readonly SheetCell[])[]
  /** A1 or absolute R1C1 cell → formula expression starting with `=`. */
  readonly formulas: Readonly<Record<string, string>>
}

/** The three bundled color schemes the renderer ships. */
export type SheetPaletteName = 'neutral' | 'tech' | 'warm'

/** Palette names in the order the checker lists them in its fix hint. */
export const SHEET_PALETTE_NAMES: readonly SheetPaletteName[] = ['neutral', 'tech', 'warm']

/**
 * Optional presentation switches. Both default to the renderer's own
 * constants, so a document that says nothing still gets the standard look.
 */
export interface SheetStyle {
  /** Alternating data-row fill. Absent means on. */
  readonly stripes?: boolean
  /** Worksheet tab color, `RRGGBB` or `AARRGGBB`. */
  readonly tabColor?: string
  /**
   * Bundled color scheme. Absent means `neutral` (light printable header);
   * `tech` suits product/metric tables and `warm` suits education/reports.
   */
  readonly palette?: SheetPaletteName
  /**
   * Automatic `date`-shaped text → real date conversion. Absent means on; set
   * `false` to keep every date-looking cell exactly as authored.
   */
  readonly dates?: boolean
}

/**
 * The whole document. `title` names the report and is rendered above every
 * sheet's data; `subtitle` and `notes` carry the units, period and provenance
 * that would otherwise be stuffed into a data cell.
 */
export interface SheetWorkbook {
  readonly title: string
  readonly subtitle?: string
  readonly notes?: string
  readonly style?: SheetStyle
  readonly sheets: readonly SheetTable[]
}

/**
 * One diagnostic. `sheet`, `row` and `column` are 1-based spreadsheet
 * coordinates (the header is row 1), so a model can act on an issue without
 * re-deriving positions from the JSON path.
 */
export interface SheetIssue {
  readonly code: string
  readonly severity: 'error' | 'warning'
  readonly message: string
  /** JSON path of the offending node, e.g. `sheets[0].rows[3]`. */
  readonly path?: string
  /** Sheet name when the issue is sheet-scoped. */
  readonly sheet?: string
  /** 1-based spreadsheet row (header = 1). */
  readonly row?: number
  /** 1-based column index. */
  readonly column?: number
  /** A1 address of the offending cell when one is known. */
  readonly cell?: string
}

/** Structural result of the read-only check. */
export interface SheetCheckResult {
  readonly status: 'pass' | 'warning' | 'needs_revision'
  readonly digest: string
  readonly sheetCount: number
  readonly rowCount: number
  readonly formulaCount: number
  readonly errorCount: number
  readonly warningCount: number
  /** Issues counted but omitted from `issues` past the per-report cap. */
  readonly suppressedCount: number
  readonly issues: readonly SheetIssue[]
}

/** Closed field whitelists; anything else is reported and ignored. */
export const ROOT_FIELDS: ReadonlySet<string> = new Set(['title', 'subtitle', 'notes', 'style', 'sheets'])
export const TABLE_FIELDS: ReadonlySet<string> = new Set(['name', 'columns', 'rows', 'formulas'])
export const COLUMN_FIELDS: ReadonlySet<string> = new Set(['header', 'width', 'numberFormat'])
export const STYLE_FIELDS: ReadonlySet<string> = new Set(['stripes', 'tabColor', 'palette', 'dates'])

/** `RRGGBB` or `AARRGGBB`. */
export const COLOR_PATTERN = /^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/u

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** `1` → `A`, `27` → `AA`. */
export function columnIndexToLetters(index: number): string {
  let remaining = index
  let letters = ''
  while (remaining > 0) {
    const digit = (remaining - 1) % 26
    letters = String.fromCharCode(65 + digit) + letters
    remaining = Math.floor((remaining - 1) / 26)
  }
  return letters
}

/** `A` → `1`, `AA` → `27`; 0 for anything that is not a column label. */
export function columnLettersToIndex(letters: string): number {
  let index = 0
  for (const character of letters.toUpperCase()) {
    const digit = character.charCodeAt(0) - 64
    if (digit < 1 || digit > 26) return 0
    index = index * 26 + digit
  }
  return index
}

/** One resolved cell target. */
export interface CellReference {
  readonly row: number
  readonly column: number
  /** Canonical uppercase A1 address, e.g. `B12`. */
  readonly a1: string
}

const A1_PATTERN = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]*)$/u
const R1C1_ABSOLUTE_PATTERN = /^R([1-9][0-9]*)C([1-9][0-9]*)$/iu
const R1C1_SHAPE_PATTERN = /^R(\[-?[0-9]+\]|[0-9]*)C(\[-?[0-9]+\]|[0-9]*)$/iu

function boundedReference(row: number, column: number): CellReference | undefined {
  if (row < 1 || row > MAX_CELL_REFERENCE_ROW) return undefined
  if (column < 1 || column > MAX_CELL_REFERENCE_COLUMN) return undefined
  return { row, column, a1: `${columnIndexToLetters(column)}${row}` }
}

/**
 * Resolve an A1 (`B2`, `$B$2`) or absolute R1C1 (`R2C2`) reference.
 * Relative R1C1 forms need a base cell the format does not carry, so they are
 * rejected here and named by {@link isRelativeR1C1} for a targeted message.
 */
export function parseCellReference(value: string): CellReference | undefined {
  const a1 = A1_PATTERN.exec(value)
  if (a1 !== null) return boundedReference(Number(a1[2]), columnLettersToIndex(a1[1] ?? ''))
  const r1c1 = R1C1_ABSOLUTE_PATTERN.exec(value)
  if (r1c1 !== null) return boundedReference(Number(r1c1[1]), Number(r1c1[2]))
  return undefined
}

/** Whether a reference is an R1C1 form with a relative component. */
export function isRelativeR1C1(value: string): boolean {
  if (!R1C1_SHAPE_PATTERN.test(value)) return false
  if (value.includes('[')) return true
  // `RC` and forms with a missing row/column number are relative too; the
  // fully numeric `R<n>C<m>` shape is the absolute form, already parsed.
  return !/^R[0-9]+C[0-9]+$/iu.test(value)
}
