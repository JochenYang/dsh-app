/**
 * Presentation rules shared by the checker and the renderer.
 *
 * A PDF table holds strings, so a column's *look* is inferred once here and
 * then reused everywhere: table layout measures and wraps the formatted text,
 * the renderer right-aligns the columns the plan marked numeric, and the
 * checker raises decimal/ratio/unit warnings against the same inference. One
 * plan per column is what keeps a readability warning from disagreeing with the
 * file that gets rendered.
 *
 * Inference stays conservative: a column is only converted when every non-empty
 * value has the same shape, and a mixed column is left exactly as authored
 * rather than guessed cell by cell. Zero decimals come from the raw text, so
 * `1,280` and `1,050.5` in one column both render with one decimal.
 *
 * @module @dsh-app/plugin-pdf/pdfd/number-format
 */

/** Column types the painter can resolve. */
export type ColumnKind = 'number' | 'percent' | 'date' | 'text'

/** One column's resolved presentation: kind, alignment and same-column renderer. */
export interface ColumnFormat {
  readonly kind: ColumnKind
  /** Whether numbers dominate the column (drives right alignment). */
  readonly numeric: boolean
  readonly align: 'left' | 'right'
  /** Fixed decimal places a number/percent column renders. */
  readonly decimals: number
  /**
   * The column's uniform renderer. Every cell of the column goes through it, so
   * `1,280` and `1,050.5` cannot end up with different precision.
   */
  readonly render: (value: string) => string
}

/** Ratio header vocabulary; the value-range gate lives in {@link isRatioColumn}. */
const RATIO_CJK_PATTERN = /率|占比|比例|同比|环比|增长/u
const RATIO_WORD_PATTERN = /(?:^|[^a-z])(?:margin|rate|growth)(?:[^a-z]|$)/iu
/** A ratio column's values must all fit this bound after percent normalization. */
export const RATIO_VALUE_BOUND = 1.5
/** Share of numeric cells above which a column counts as numeric. */
export const NUMERIC_SHARE_THRESHOLD = 0.6
/** `0.30000000000000004` must not become an 17-decimal format. */
export const MAX_INFERRED_DECIMALS = 6
/**
 * Characters the numeric and date renderers can introduce beyond the authored
 * text (grouping, signs, percent, date separators). The renderer adds them to
 * the font-coverage search so formatting never reaches a glyph the font lacks.
 */
export const FORMAT_GLYPHS = '0123456789,-()%./'

const NUMBER_SHAPE = /^[-+]?\d[\d,]*(?:\.\d+)?$/u
const PERCENT_SHAPE = /^[-+]?\d[\d,]*(?:\.\d+)?\s*%$/u
/** `YYYY-MM-DD` / `YYYY/M/D` / `YYYY.M.D`; `YYYY年M月D日`; both normalized. */
const DAY_DATE_SHAPE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/u
const CJK_DATE_SHAPE = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/u

/** Non-empty, trimmed values, the only ones any rule looks at. */
function presentValues(values: readonly string[]): string[] {
  return values.map(value => value.trim()).filter(value => value !== '')
}

/** The number a plain numeric text carries, or undefined. */
export function parseNumber(value: string): number | undefined {
  const text = value.trim()
  if (!NUMBER_SHAPE.test(text)) return undefined
  const parsed = Number.parseFloat(text.replace(/,/gu, ''))
  return Number.isFinite(parsed) ? parsed : undefined
}

/** The ratio a value carries: a plain number, or a percent text divided by 100. */
export function parseRatio(value: string): number | undefined {
  const text = value.trim()
  if (!PERCENT_SHAPE.test(text)) return parseNumber(text)
  const parsed = Number.parseFloat(text.replace(/[,%]/gu, ''))
  return Number.isFinite(parsed) ? parsed / 100 : undefined
}

/** Fixed decimal places a raw numeric text carries (commas and `%` stripped). */
export function decimalPlacesOfText(text: string): number {
  const stripped = text.trim().replace(/[,%\s]/gu, '')
  const dot = stripped.indexOf('.')
  return dot === -1 ? 0 : Math.min(MAX_INFERRED_DECIMALS, stripped.length - dot - 1)
}

/** Whether a header names a ratio, case-insensitively for the Latin forms. */
export function isRatioHeader(header: string): boolean {
  return RATIO_CJK_PATTERN.test(header) || RATIO_WORD_PATTERN.test(header)
}

/** Whether every present value is a ratio in [-1.5, 1.5] and at least one exists. */
export function isRatioColumn(header: string, values: readonly string[]): boolean {
  if (!isRatioHeader(header)) return false
  const present = presentValues(values)
  if (present.length === 0) return false
  return present.every(value => {
    const ratio = parseRatio(value)
    return ratio !== undefined && Math.abs(ratio) <= RATIO_VALUE_BOUND
  })
}

/** Group the integer part of an already fixed-decimal string. */
function groupDigits(fixed: string): string {
  const [integer = '', fraction] = fixed.split('.')
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
  return fraction === undefined ? grouped : `${grouped}.${fraction}`
}

/** The `YYYY-MM-DD` text a date-shaped value normalizes to, or undefined. */
function dateText(value: string): string | undefined {
  const text = value.trim()
  const match = DAY_DATE_SHAPE.exec(text) ?? CJK_DATE_SHAPE.exec(text)
  if (match === null) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  // Years 0–99 are double-digit years to `Date.UTC` (1 → 1901), so they can
  // never round-trip and are left as text. The round trip also rejects
  // `2024-02-31`, which `Date.UTC` would silently roll into March.
  if (year < 100) return undefined
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return undefined
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Resolve one column's format, alignment and cell renderer. Priority: uniform
 * date > ratio percent > fixed-decimal number > numeric-marked text. A column
 * whose values do not share one shape stays text, exactly as authored.
 */
export function planColumnFormat(values: readonly string[], header: string): ColumnFormat {
  const present = presentValues(values)
  if (present.length === 0) {
    return { kind: 'text', numeric: false, align: 'left', decimals: 0, render: value => value }
  }

  if (present.every(value => dateText(value) !== undefined)) {
    // Dates align right like numbers even though they are not counted as numeric.
    return { kind: 'date', numeric: false, align: 'right', decimals: 0, render: value => dateText(value) ?? value }
  }

  if (isRatioColumn(header, present)) {
    return {
      kind: 'percent',
      numeric: true,
      align: 'right',
      decimals: 1,
      render: value => {
        const ratio = parseRatio(value)
        return ratio === undefined ? value : `${(ratio * 100).toFixed(1)}%`
      },
    }
  }

  const numbers = present.map(parseNumber)
  if (numbers.every(number => number !== undefined)) {
    const decimals = present.reduce((widest, value) => Math.max(widest, decimalPlacesOfText(value)), 0)
    return {
      kind: 'number',
      numeric: true,
      align: 'right',
      decimals,
      render: value => {
        const parsed = parseNumber(value)
        if (parsed === undefined) return value
        // Zero reads as a dash, and a negative keeps its sign through
        // parentheses, so the sign is never carried by color alone.
        if (parsed === 0) return '-'
        const magnitude = groupDigits(Math.abs(parsed).toFixed(decimals))
        return parsed < 0 ? `(${magnitude})` : magnitude
      },
    }
  }

  const numericCount = present.filter(value => parseRatio(value) !== undefined).length
  const numeric = numericCount > present.length * NUMERIC_SHARE_THRESHOLD
  return { kind: 'text', numeric, align: numeric ? 'right' : 'left', decimals: 0, render: value => value }
}
