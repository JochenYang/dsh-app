/**
 * Table-cell presentation shared by the checker and the renderer: the display
 * width of a string (a CJK/fullwidth glyph occupies two Latin units, which is
 * what makes a Chinese column earn more of the grid than a same-length ASCII
 * one), the conservative per-column number/date/percent inference, and the
 * unified formatter a column resolves to. Both layers import this module, so a
 * readability warning can never disagree with the file that gets written.
 *
 * Inference is deliberately conservative: a column whose cells do not share one
 * shape is left exactly as authored rather than guessed cell by cell, and every
 * helper below is a pure function.
 *
 * @module @dsh-app/plugin-doc/docd/number-format
 */

/** One table cell value; the AST stores strings, the unit tests also pass numbers. */
export type CellValue = string | number

/** A column reads as numeric once more than this share of its cells parse. */
export const NUMERIC_COLUMN_SHARE = 0.6

/** Fixed decimal places a numeric column may resolve to (0, 1 or 2). */
export const MAX_DECIMAL_PLACES = 2

/** `0.30000000000000004` must not become a 17-decimal format. */
const FLOAT_DECIMAL_CAP = 6

/** A ratio column's header vocabulary; the value-range gate lives in `isRatioHeader`. */
const RATIO_CJK_PATTERN = /率|占比|比例|同比|环比|增长/u
const RATIO_WORD_PATTERN = /(?:^|[^a-z])(?:margin|rate|growth)(?:[^a-z]|$)/iu

/** A ratio column's values must fit this bound before the percent shape applies. */
export const RATIO_VALUE_BOUND = 1.5

/** Unit vocabulary that satisfies the large-value unit rule. */
export const UNIT_WORD_PATTERN = /单位|万元|亿元|百万元|元|million|thousand|¥|￥/iu

/** Median absolute value past which a column must declare its unit. */
export const MAJOR_VALUE_MEDIAN = 1e4

/** Numeric text, optionally grouped: `1,280.5`, `-3`, `0.128`. */
const NUMERIC_TEXT_SHAPE = /^[-+]?\d[\d,]*(?:\.\d+)?$/u
/** `12.8%` / `-3%`: percent text carries the display unit itself. */
const PERCENT_TEXT_SHAPE = /^[-+]?\d+(?:\.\d+)?\s*%$/u
/** `YYYY-MM-DD` / `YYYY/M/D` / `YYYY.M.D`. */
const DAY_DATE_SHAPE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/u
/** `YYYY年M月D日`. */
const CJK_DATE_SHAPE = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/u

/**
 * First-column labels the renderer treats as a totals row (visual emphasis
 * only — no arithmetic meaning is guessed). Latin forms match
 * case-insensitively; the list is exact rather than a prefix, so a label that
 * merely *starts* with a totals word ("合计其中…") is never mistaken for one.
 * The same vocabulary is shared by the PDF, PPT and Excel suites.
 */
export const TOTAL_ROW_LABELS: ReadonlySet<string> = new Set(['合计', '总计', '小计', '汇总', 'Total', 'Subtotal', 'Sum'])

const TOTAL_ROW_LABELS_CASELESS: ReadonlySet<string> = new Set([...TOTAL_ROW_LABELS].map(label => label.toLocaleLowerCase()))

/** One calendar date parsed from a cell. */
export interface DateParts {
  readonly year: number
  readonly month: number
  readonly day: number
}

/** One column's resolved presentation and its unified cell formatter. */
export interface ColumnFormatPlan {
  readonly kind: 'number' | 'percent' | 'date' | 'text'
  /** Fixed decimal places the column renders with. */
  readonly decimals: number
  /** Alignment the column's data reads best at. */
  readonly align: 'left' | 'right'
  /** Render one cell with the column's format; unparseable cells pass through. */
  readonly format: (value: CellValue) => string
}

/** Display units one code point consumes; CJK/fullwidth glyphs take two. */
function codePointWidth(codePoint: number): number {
  if (codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  )) return 2
  return 1
}

/** Display width of one line of text, in Latin character units. */
export function displayWidth(text: string): number {
  let width = 0
  for (const character of text) width += codePointWidth(character.codePointAt(0) ?? 0)
  return width
}

/** Fixed decimal places a raw number carries, capped against float artifacts. */
export function decimalPlacesOf(value: number): number {
  if (!Number.isFinite(value)) return 0
  const text = value.toString()
  const exponentIndex = text.search(/[eE]/u)
  if (exponentIndex === -1) {
    const dot = text.indexOf('.')
    return Math.min(FLOAT_DECIMAL_CAP, dot === -1 ? 0 : text.length - dot - 1)
  }
  const mantissa = text.slice(0, exponentIndex)
  const exponent = Number(text.slice(exponentIndex + 1))
  const dot = mantissa.indexOf('.')
  const mantissaDecimals = dot === -1 ? 0 : mantissa.length - dot - 1
  return Math.min(FLOAT_DECIMAL_CAP, Math.max(0, mantissaDecimals - exponent))
}

/** The plain number a cell carries, or undefined; percent/unit text is not numeric. */
export function numericValueOf(value: CellValue): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  const text = value.trim()
  if (text === '' || !NUMERIC_TEXT_SHAPE.test(text)) return undefined
  const parsed = Number.parseFloat(text.replace(/,/gu, ''))
  return Number.isFinite(parsed) ? parsed : undefined
}

/** The fraction a percent cell carries (`12.8%` → 0.128), or undefined. */
export function percentValueOf(value: CellValue): number | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!PERCENT_TEXT_SHAPE.test(text)) return undefined
  const parsed = Number.parseFloat(text.replace(/%$/u, ''))
  return Number.isFinite(parsed) ? parsed / 100 : undefined
}

/** Round-trip a date so `2024-02-31` is rejected instead of rolled into March. */
function validDate(year: number, month: number, day: number): DateParts | undefined {
  if (year < 100 || month < 1 || month > 12 || day < 1 || day > 31) return undefined
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return undefined
  return { year, month, day }
}

/** The date a cell carries in any recognized shape, or undefined. */
export function datePartsOf(value: CellValue): DateParts | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  const day = DAY_DATE_SHAPE.exec(text)
  if (day !== null) return validDate(Number(day[1]), Number(day[2]), Number(day[3]))
  const cjk = CJK_DATE_SHAPE.exec(text)
  if (cjk !== null) return validDate(Number(cjk[1]), Number(cjk[2]), Number(cjk[3]))
  return undefined
}

/** One date as the column renders it. */
export function formatDate(parts: DateParts): string {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

function groupDigits(fixed: string): string {
  const [integer = '', fraction] = fixed.split('.')
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
  return fraction === undefined ? grouped : `${grouped}.${fraction}`
}

/**
 * One number as the column renders it: grouped fixed decimals, negatives in
 * parentheses, zero as `-`. The parentheses alone carry the sign — matching the
 * PDF, PPT and Excel suites, which also write `(1,280.0)` — so the same figure
 * cannot read differently across the four exports. Color is intentionally not
 * used: Word would need a character style for red, which reads as decoration in
 * a formal report.
 */
export function formatNumber(value: number, decimals: number): string {
  if (value === 0) return '-'
  const magnitude = groupDigits(Math.abs(value).toFixed(decimals))
  return value < 0 ? `(${magnitude})` : magnitude
}

/** One ratio as a percent with fixed decimals (`0.128` → `12.8%`). */
export function formatPercent(fraction: number, decimals = 1): string {
  return `${(fraction * 100).toFixed(decimals)}%`
}

/** Whether a header names a ratio (rate, share, growth…). */
export function isRatioHeader(header: string): boolean {
  return RATIO_CJK_PATTERN.test(header) || RATIO_WORD_PATTERN.test(header)
}

/** Whether a first-column label marks a totals row (see {@link TOTAL_ROW_LABELS}). */
export function isTotalRowLabel(value: string): boolean {
  const text = value.trim()
  return TOTAL_ROW_LABELS.has(text) || TOTAL_ROW_LABELS_CASELESS.has(text.toLocaleLowerCase())
}

/** Median of a numeric sample, or 0 for an empty one. */
export function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const lower = sorted[middle - 1]
  const upper = sorted[middle]
  if (sorted.length % 2 === 1 || lower === undefined || upper === undefined) return sorted[middle] ?? 0
  return (lower + upper) / 2
}

function textOf(value: CellValue): string {
  return typeof value === 'number' ? String(value) : value
}

/** Render a ratio cell whether it is stored as a fraction or as percent text. */
function percentCell(value: CellValue): string {
  const fraction = numericValueOf(value) ?? percentValueOf(value)
  return fraction === undefined ? textOf(value) : formatPercent(fraction)
}

/**
 * Resolve one column's format and formatter. Priority: ratio percent > fixed
 * decimal number > uniform date > text. A column with too few parseable numbers
 * (or a mix of shapes) stays text, so no cell is silently rewritten.
 */
export function planColumnFormat(values: readonly CellValue[], header: string): ColumnFormatPlan {
  const filled = values.filter(value => textOf(value).trim() !== '')
  const numbers = filled.map(numericValueOf).filter((value): value is number => value !== undefined)
  const numericShare = filled.length === 0 ? 0 : numbers.length / filled.length

  if (numericShare > NUMERIC_COLUMN_SHARE && isRatioHeader(header)
    && numbers.length > 0 && numbers.every(value => Math.abs(value) <= RATIO_VALUE_BOUND)) {
    return { kind: 'percent', decimals: 1, align: 'right', format: percentCell }
  }
  if (numericShare > NUMERIC_COLUMN_SHARE) {
    const widest = numbers.reduce((max, value) => Math.max(max, decimalPlacesOf(value)), 0)
    const decimals = Math.min(MAX_DECIMAL_PLACES, widest)
    return {
      kind: 'number',
      decimals,
      align: 'right',
      format: value => {
        const number = numericValueOf(value)
        return number === undefined ? textOf(value) : formatNumber(number, decimals)
      },
    }
  }
  const dates = filled.map(datePartsOf)
  if (filled.length > 0 && dates.every(parts => parts !== undefined)) {
    return {
      kind: 'date',
      decimals: 0,
      align: 'left',
      format: value => {
        const parts = datePartsOf(value)
        return parts === undefined ? textOf(value) : formatDate(parts)
      },
    }
  }
  return { kind: 'text', decimals: 0, align: 'left', format: textOf }
}
