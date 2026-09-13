/**
 * Table presentation rules shared by the checker and the renderer.
 *
 * A table column's look is decided here: whether its values are numbers, a
 * ratio written as a true decimal, or dates; how wide those values render
 * (CJK glyphs take two character units); the alignment the column defaults to
 * (numeric share over 60% reads right); and the width ratio the column needs.
 * Both layers import this module, so a capacity warning can never disagree
 * with the file that gets written. Inference stays conservative: a column
 * whose cells do not share one shape is left exactly as authored, and the
 * caller keeps any explicit alignment the theme already wrote.
 *
 * @module @dsh-app/plugin-ppt/pptd/number-format
 */

/** One table cell reduced to the value the formatter reads. */
export type ColumnValue = string | number

/** How a column's values are rendered. */
export type ColumnKind = 'number' | 'percent' | 'date' | 'text'

/** One column's resolved formatting, alignment and header note. */
export interface ColumnFormatPlan {
  readonly kind: ColumnKind
  /** Fixed decimal places the number/percent branch renders. */
  readonly decimals: number
  readonly align: 'left' | 'right'
  readonly format: (value: ColumnValue) => string
}

/** A header plus the data values the width estimate measures. */
export interface ColumnFormatSample {
  readonly header: string
  readonly values: readonly ColumnValue[]
}

/** `0.30000000000000004` must not become a 17-decimal format. */
export const MAX_INFERRED_DECIMALS = 6
/** A numeric column whose header names a ratio and whose values fit this bound. */
export const RATIO_VALUE_BOUND = 1.5
/** Fixed decimals a ratio column renders: `0.128` → `12.8%`. */
export const PERCENT_DECIMALS = 1
/** Numeric share above which a mixed column still reads as a numeric column. */
export const NUMERIC_ALIGN_SHARE = 0.6

/** Ratio header vocabulary, split so a latin substring inside a word never fires. */
const RATIO_CJK_PATTERN = /率|占比|比例|同比|环比|增长/u
const RATIO_WORD_PATTERN = /(?:^|[^a-z])(?:margin|rate|growth)(?:[^a-z]|$)/iu

/** Plain number text, optional thousands separators; no unit or percent sign. */
const PLAIN_NUMBER_SHAPE = /^[-+]?\d[\d,]*(?:\.\d+)?$/u
/** `12.8%`: a percent text value stays as authored. */
const PERCENT_SHAPE = /^[-+]?\d[\d,]*(?:\.\d+)?%$/u
/** `YYYY-MM-DD` / `YYYY/M/D` / `YYYY.M.D` / `YYYY年M月D日`. */
const DAY_DATE_SHAPE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/u
const CJK_DAY_DATE_SHAPE = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/u

function asText(value: ColumnValue): string {
  return typeof value === 'number' ? String(value) : value.trim()
}

/** Display columns a code point consumes; CJK/fullwidth glyphs take two. */
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

/** Display width of one line of text, in character units. */
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
    return Math.min(MAX_INFERRED_DECIMALS, dot === -1 ? 0 : text.length - dot - 1)
  }
  const mantissa = text.slice(0, exponentIndex)
  const exponent = Number(text.slice(exponentIndex + 1))
  const dot = mantissa.indexOf('.')
  const mantissaDecimals = dot === -1 ? 0 : mantissa.length - dot - 1
  return Math.min(MAX_INFERRED_DECIMALS, Math.max(0, mantissaDecimals - exponent))
}

/** The number a plain numeric cell carries, or undefined for text/percent values. */
export function parsePlainNumber(value: ColumnValue): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  const text = value.trim()
  if (!PLAIN_NUMBER_SHAPE.test(text)) return undefined
  const parsed = Number.parseFloat(text.replace(/,/gu, ''))
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Whether a cell already reads as a percentage string. */
export function isPercentValue(value: ColumnValue): boolean {
  return typeof value === 'string' && PERCENT_SHAPE.test(value.trim())
}

/**
 * Whether a header names a ratio. The value-range gate lives in
 * {@link planColumnFormat}: a header alone never turns a column into percent.
 */
export function isRatioColumnHeader(header: string): boolean {
  return RATIO_CJK_PATTERN.test(header) || RATIO_WORD_PATTERN.test(header)
}

function groupDigits(fixed: string): string {
  const [integer = '', fraction] = fixed.split('.')
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
  return fraction === undefined ? grouped : `${grouped}.${fraction}`
}

/**
 * One number as the reader will see it: fixed decimals, grouped thousands,
 * parentheses around a negative value and `-` for zero. The parentheses keep
 * the sign readable without relying on the minus glyph alone.
 */
function numericText(value: number, decimals: number): string {
  if (value === 0) return '-'
  const magnitude = groupDigits(Math.abs(value).toFixed(decimals))
  return value < 0 ? `(${magnitude})` : magnitude
}

function utcDate(year: number, month: number, day: number): Date | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined
  // Years 0–99 are double-digit years to `Date.UTC`, so they can never
  // round-trip and are left as text.
  if (year < 100) return undefined
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return undefined
  return date
}

/**
 * `YYYY-MM-DD` / `YYYY/M/D` / `YYYY.M.D` / `YYYY年M月D日` → a UTC date, or
 * undefined. The parse is a round trip, not a best effort: `Date.UTC` silently
 * rolls `2024-02-31` into March, so a value that comes back different is
 * rejected and the column stays text. Conversion never rewrites what the
 * author typed into a different day.
 */
export function dateValueOf(value: string): Date | undefined {
  const text = value.trim()
  const day = DAY_DATE_SHAPE.exec(text)
  if (day !== null) return utcDate(Number(day[1]), Number(day[2]), Number(day[3]))
  const cjk = CJK_DAY_DATE_SHAPE.exec(text)
  if (cjk !== null) return utcDate(Number(cjk[1]), Number(cjk[2]), Number(cjk[3]))
  return undefined
}

/** One date as `YYYY-MM-DD`, the single shape every date column renders. */
function dateText(date: Date): string {
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + 1
  return `${year}-${String(month).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function identityPlan(align: 'left' | 'right'): ColumnFormatPlan {
  return { kind: 'text', decimals: 0, align, format: (value) => (typeof value === 'number' ? String(value) : value) }
}

/**
 * Resolve one column's formatting, alignment and default. Priority: a column
 * of true decimals whose header names a ratio → percent; a column of true
 * decimals → fixed-decimal number; a column of one date shape → ISO date;
 * anything mixed (or already percent text) stays exactly as authored.
 */
export function planColumnFormat(values: readonly ColumnValue[], header: string): ColumnFormatPlan {
  const present = values.filter((value) => !(typeof value === 'string' && value.trim() === ''))
  const parsed = present.map(parsePlainNumber)
  if (present.length > 0 && parsed.every((value) => value !== undefined)) {
    const numbers = parsed as number[]
    if (isRatioColumnHeader(header) && numbers.every((value) => Math.abs(value) <= RATIO_VALUE_BOUND)) {
      return {
        kind: 'percent',
        decimals: PERCENT_DECIMALS,
        align: 'right',
        format: (value) => {
          const number = parsePlainNumber(value)
          return number === undefined ? asText(value) : `${(number * 100).toFixed(PERCENT_DECIMALS)}%`
        },
      }
    }
    const decimals = numbers.reduce((widest, value) => Math.max(widest, decimalPlacesOf(value)), 0)
    return {
      kind: 'number',
      decimals,
      align: 'right',
      format: (value) => {
        const number = parsePlainNumber(value)
        return number === undefined ? asText(value) : numericText(number, decimals)
      },
    }
  }
  const dates = present.map((value) => (typeof value === 'string' ? dateValueOf(value) : undefined))
  if (present.length > 0 && dates.every((value) => value !== undefined)) {
    return {
      kind: 'date',
      decimals: 0,
      align: 'right',
      format: (value) => {
        const date = typeof value === 'string' ? dateValueOf(value) : undefined
        return date === undefined ? (typeof value === 'number' ? String(value) : value) : dateText(date)
      },
    }
  }
  const numericShare = present.length === 0
    ? 0
    : present.filter((value) => parsePlainNumber(value) !== undefined || isPercentValue(value)).length / present.length
  return identityPlan(numericShare > NUMERIC_ALIGN_SHARE ? 'right' : 'left')
}

/**
 * Per-column width ratios estimated from the formatted content and the
 * header. Only used when the model supplied no usable `columnWidths`: a long
 * text column claims more of the table width than a short one. Returns
 * undefined when there is nothing to measure, so the caller can leave the
 * even split to pptxgenjs.
 */
export function estimateColumnRatios(samples: readonly ColumnFormatSample[], plans: readonly ColumnFormatPlan[]): number[] | undefined {
  if (samples.length === 0) return undefined
  const widths = samples.map((sample, index) => {
    const plan = plans[index] ?? identityPlan('left')
    let widest = displayWidth(sample.header)
    for (const value of sample.values) widest = Math.max(widest, displayWidth(plan.format(value)))
    return Math.max(1, widest)
  })
  const total = widths.reduce((sum, width) => sum + width, 0)
  if (total <= 0) return undefined
  return widths.map((width) => width / total)
}
