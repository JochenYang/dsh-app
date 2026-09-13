/**
 * Presentation rules shared by the checker and the renderer.
 *
 * Everything a column's *look* depends on lives here: the display width of a
 * value (CJK glyphs take two character units), the per-column number/date/
 * percent inference, the number-format literal a column resolves to, and the
 * width a header plus its formatted values require. Both layers import this
 * module, so a readability warning can never disagree with the file that gets
 * written. Inference stays conservative: an explicit `numberFormat` always
 * wins, and a column whose cells do not share one shape is left exactly as
 * authored rather than guessed cell by cell.
 *
 * @module @dsh-app/plugin-sheet/sheet/format
 */

import type { SheetCell, SheetColumn } from './types.ts'

/** Number format that explicitly exempts a column from numeric conversion. */
export const TEXT_FORMAT = '@'
/** Ratio columns are stored as true values and displayed as a percentage. */
export const PERCENT_FORMAT = '0.0%'
export const DATE_FORMAT = 'yyyy-mm-dd'
export const DATE_MONTH_FORMAT = 'yyyy"年"m"月"'
export const QUARTER_FORMAT = 'yyyy"Q"q'

/** Renderer width band, in Excel character units. */
export const MIN_RENDER_WIDTH = 6
export const MAX_RENDER_WIDTH = 60
/** Character units added around the widest header/value. */
export const WIDTH_PADDING = 2
/**
 * Sample quantile for text-heavy columns: past it, a single prose outlier
 * should not stretch a whole column (text spills into empty neighbours, and
 * only formatted numbers can degrade to `###`).
 */
export const WIDTH_QUANTILE = 0.95
/** Header display width above which the header wraps on a taller row. */
export const HEADER_WRAP_WIDTH = 24
export const HEADER_WRAP_HEIGHT = 32
export const HEADER_HEIGHT = 24
export const TITLE_SIZE = 14
export const HEADER_SIZE = 11
export const DATA_SIZE = 10
export const CAPTION_SIZE = 9
export const BLANK_ROW_HEIGHT = 8
/** `0.30000000000000004` must not become an 17-decimal format. */
export const MAX_INFERRED_DECIMALS = 6
/** Ratio header vocabulary; the value range gate lives in {@link isRatioColumn}. */
const RATIO_CJK_PATTERN = /率|占比|比例|同比|环比|增长/u
const RATIO_WORD_PATTERN = /(?:^|[^a-z])(?:margin|rate|growth)(?:[^a-z]|$)/iu
/** A numeric column whose header names a ratio and whose values fit [-1, 1.5]. */
export const RATIO_VALUE_BOUND = 1.5

/** A cell value after the column plan's normalization: as authored, or a Date. */
export type RenderedCell = SheetCell | Date

/** One column's resolved presentation: format, alignment and normalization. */
export interface ColumnPlan {
  /** Number-format literal to write, or undefined to leave cells unformatted. */
  readonly format: string | undefined
  readonly align: 'left' | 'right'
  /** Value normalization the resolved format requires (dates, ratios). */
  readonly convert: (value: SheetCell) => RenderedCell
  /** Fixed decimal places the format renders. */
  readonly decimals: number
  /** How a number renders: plain fixed decimals, percent, or untouched. */
  readonly numberKind: 'plain' | 'percent' | 'none'
  /** Date granularity when the column is a date column. */
  readonly dateKind: 'day' | 'month' | 'quarter' | null
  /** Whether the rendered column carries numbers (drives the header alignment). */
  readonly numeric: boolean
}

/** `YYYY-MM-DD` / `YYYY/M/D` / `YYYY.M.D`; `YYYY年M月`; `YYYYQn`. */
const DAY_DATE_SHAPE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/u
const MONTH_DATE_SHAPE = /^(\d{4})\s*年\s*(\d{1,2})\s*月$/u
const QUARTER_DATE_SHAPE = /^(\d{4})\s*[Qq]([1-4])$/u
/** Text that merely *looks* numeric (drives the numeric-text warning). */
const NUMERIC_TEXT_SHAPE = /^[-+]?\d[\d,]*(?:\.\d+)?$/u
/** `12.8%` / `-3%`: a percent text column converts by ÷100. */
const PERCENT_TEXT_SHAPE = /^[-+]?\d+(?:\.\d+)?\s*%$/u

function identity(value: SheetCell): RenderedCell {
  return value
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

/** Display width of one line of text, in Excel character units. */
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

/** Fixed decimal places a format literal's first section renders. */
export function decimalsOfFormat(format: string): number {
  const section = format.split(';')[0] ?? ''
  const match = /\.(0+|#+)/u.exec(section)
  return Math.min(MAX_INFERRED_DECIMALS, match?.[1]?.length ?? 0)
}

/**
 * The format a numeric column resolves to: zero to six fixed decimals plus
 * explicit negative and zero sections. `[Red]` and parentheses both express a
 * negative value, so color is never the only cue; zero reads as `-`.
 */
export function numericFormatFor(decimals: number): string {
  const base = decimals === 0 ? '#,##0' : `#,##0.${'0'.repeat(decimals)}`
  return `${base};[Red](${base});"-"`
}

function groupDigits(fixed: string): string {
  const [integer = '', fraction] = fixed.split('.')
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
  return fraction === undefined ? grouped : `${grouped}.${fraction}`
}

/** One number as the plan renders it (used for width, not written to a cell). */
function numericText(value: number, decimals: number): string {
  if (value === 0) return '-'
  const magnitude = groupDigits(Math.abs(value).toFixed(decimals))
  return value < 0 ? `(${magnitude})` : magnitude
}

function dateText(date: Date, kind: ColumnPlan['dateKind']): string {
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + 1
  if (kind === 'month') return `${year}年${month}月`
  if (kind === 'quarter') return `${year}Q${Math.floor((month - 1) / 3) + 1}`
  return `${year}-${String(month).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

/** A converted value as the reader will see it, for width estimation. */
export function renderedText(value: RenderedCell, plan: ColumnPlan): string {
  if (value === null) return ''
  if (value instanceof Date) return dateText(value, plan.dateKind)
  if (typeof value === 'number') {
    if (plan.numberKind === 'percent') return `${(value * 100).toFixed(plan.decimals)}%`
    return numericText(value, plan.decimals)
  }
  return value
}

/**
 * `YYYY-MM-DD` / `YYYY年M月` / `YYYYQn` → a UTC date, or undefined.
 *
 * The parse is a round trip, not a best effort: `Date.UTC` silently rolls
 * `2024-02-31` into March and maps a year below 100 into the 1900s, so a value
 * that comes back as different y/m/d is rejected and the caller keeps the
 * original text. Conversion must never rewrite what the user typed.
 */
export function dateValueOf(value: string): Date | undefined {
  const text = value.trim()
  const day = DAY_DATE_SHAPE.exec(text)
  if (day !== null) return utcDate(Number(day[1]), Number(day[2]), Number(day[3]))
  const month = MONTH_DATE_SHAPE.exec(text)
  if (month !== null) return utcDate(Number(month[1]), Number(month[2]), 1)
  const quarter = QUARTER_DATE_SHAPE.exec(text)
  if (quarter !== null) return utcDate(Number(quarter[1]), (Number(quarter[2]) - 1) * 3 + 1, 1)
  return undefined
}

function utcDate(year: number, month: number, day: number): Date | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined
  // Years 0–99 are double-digit years to `Date.UTC` (1 → 1901), so they can
  // never round-trip and are left as text.
  if (year < 100) return undefined
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return undefined
  return date
}

function dateShapeOf(value: string): { kind: 'day' | 'month' | 'quarter', format: string } | undefined {
  const text = value.trim()
  if (DAY_DATE_SHAPE.test(text)) return { kind: 'day', format: DATE_FORMAT }
  if (MONTH_DATE_SHAPE.test(text)) return { kind: 'month', format: DATE_MONTH_FORMAT }
  if (QUARTER_DATE_SHAPE.test(text)) return { kind: 'quarter', format: QUARTER_FORMAT }
  return undefined
}

/** A fully convertible column of one date shape, or undefined. */
export interface ColumnDateMatch {
  readonly kind: 'day' | 'month' | 'quarter'
  readonly format: string
  readonly count: number
}

/**
 * Date granularity a column would convert to. Every non-empty cell must be a
 * string of the same shape *and* survive {@link dateValueOf}'s round trip — a
 * mixed `2024-01-31` / `2024年1月` column stays text, and one bad day keeps the
 * whole column as authored.
 */
export function dateColumnMatch(column: SheetColumn, cells: readonly SheetCell[]): ColumnDateMatch | undefined {
  if (column.numberFormat !== undefined) return undefined
  const values = cells.filter(value => value !== null)
  if (values.length === 0) return undefined
  let resolved: { kind: ColumnDateMatch['kind'], format: string } | undefined
  for (const value of values) {
    if (typeof value !== 'string') return undefined
    const shape = dateShapeOf(value)
    if (shape === undefined || dateValueOf(value) === undefined) return undefined
    if (resolved === undefined) resolved = shape
    else if (resolved.kind !== shape.kind) return undefined
  }
  return resolved === undefined ? undefined : { ...resolved, count: values.length }
}

/** `12.8%` → `0.128`: Excel's percent format multiplies by 100 to display. */
export function percentTextValue(value: string): number | undefined {
  if (!PERCENT_TEXT_SHAPE.test(value.trim())) return undefined
  const parsed = Number.parseFloat(value.trim().replace(/%$/u, ''))
  return Number.isFinite(parsed) ? parsed / 100 : undefined
}

/** The number a numeric-looking text carries, or undefined. */
export function numericTextValue(value: string): number | undefined {
  const text = value.trim()
  if (!NUMERIC_TEXT_SHAPE.test(text)) return undefined
  const parsed = Number.parseFloat(text.replace(/,/gu, ''))
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Whether a header names a ratio and every numeric value fits [-1, 1.5]. */
export function isRatioColumn(header: string, values: readonly SheetCell[]): boolean {
  if (!RATIO_CJK_PATTERN.test(header) && !RATIO_WORD_PATTERN.test(header)) return false
  const numbers = values.filter((value): value is number => typeof value === 'number')
  if (numbers.length === 0) return false
  return values.every(value => value === null || (typeof value === 'number' && Math.abs(value) <= RATIO_VALUE_BOUND))
}

/** Format kind an explicit date-format literal implies, for width rendering. */
function dateKindOfFormat(format: string): ColumnPlan['dateKind'] {
  const stripped = format.replace(/"[^"]*"/gu, '')
  if (/q/iu.test(stripped)) return 'quarter'
  if (/d/iu.test(stripped)) return 'day'
  if (/y/iu.test(stripped) && /m/iu.test(stripped)) return 'month'
  return null
}

/**
 * Resolve one column's format, alignment and value normalization. Priority:
 * explicit format > inferred numeric ratio > fixed-decimal numeric > uniform
 * date > percent text > text. Only the first matching shape fires; anything
 * mixed is left exactly as authored.
 */
export function planForColumn(column: SheetColumn, cells: readonly SheetCell[], datesEnabled: boolean): ColumnPlan {
  const values = cells.filter(value => value !== null)
  if (column.numberFormat !== undefined) {
    const numeric = values.length > 0 && values.every(value => typeof value === 'number')
    const percent = column.numberFormat.includes('%')
    const dateKind = percent ? null : dateKindOfFormat(column.numberFormat)
    return {
      format: column.numberFormat,
      align: numeric || dateKind !== null ? 'right' : 'left',
      convert: identity,
      decimals: decimalsOfFormat(column.numberFormat),
      numberKind: percent ? 'percent' : 'none',
      dateKind,
      numeric,
    }
  }
  if (values.length > 0 && values.every(value => typeof value === 'number')) {
    if (isRatioColumn(column.header, values)) {
      return {
        format: PERCENT_FORMAT,
        align: 'right',
        convert: identity,
        decimals: 1,
        numberKind: 'percent',
        dateKind: null,
        numeric: true,
      }
    }
    const decimals = values.reduce((widest, value) => Math.max(widest, decimalPlacesOf(value as number)), 0)
    return {
      format: numericFormatFor(decimals),
      align: 'right',
      convert: identity,
      decimals,
      numberKind: 'plain',
      dateKind: null,
      numeric: true,
    }
  }
  const dateMatch = datesEnabled ? dateColumnMatch(column, cells) : undefined
  if (dateMatch !== undefined) {
    return {
      format: dateMatch.format,
      align: 'right',
      convert: value => typeof value === 'string' ? dateValueOf(value) ?? value : value,
      decimals: 0,
      numberKind: 'none',
      dateKind: dateMatch.kind,
      numeric: false,
    }
  }
  if (values.length > 0 && values.every(value => typeof value === 'string' && percentTextValue(value) !== undefined)) {
    return {
      format: PERCENT_FORMAT,
      align: 'right',
      convert: value => typeof value === 'string' ? percentTextValue(value) ?? value : value,
      decimals: 1,
      numberKind: 'percent',
      dateKind: null,
      numeric: false,
    }
  }
  return { format: undefined, align: 'left', convert: identity, decimals: 0, numberKind: 'none', dateKind: null, numeric: false }
}

function quantile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index] ?? 0
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Width a column needs: `2 + max(header display width, value display width)`,
 * clamped to `[6, 60]`. Values are measured after formatting, so `1280` under
 * `#,##0` counts as `1,280` (five units) and a larger sample set no longer
 * hides a wide row. Formatted columns use their widest value — that is what
 * keeps `###` out of the file — while text columns use the 95th percentile so
 * one long sentence cannot stretch the grid.
 */
export function requiredColumnWidth(header: string, cells: readonly SheetCell[], plan: ColumnPlan): number {
  const headerWidth = displayWidth(header)
  const widths: number[] = []
  for (const cell of cells) {
    if (cell === null) continue
    const converted = plan.convert(cell)
    if (converted === null) continue
    widths.push(displayWidth(renderedText(converted, plan)))
  }
  if (widths.length === 0) return clamp(headerWidth + WIDTH_PADDING, MIN_RENDER_WIDTH, MAX_RENDER_WIDTH)
  widths.sort((left, right) => left - right)
  const widest = plan.format === undefined ? quantile(widths, WIDTH_QUANTILE) : widths[widths.length - 1] ?? 0
  const needed = Math.max(headerWidth, quantile(widths, WIDTH_QUANTILE), widest) + WIDTH_PADDING
  return clamp(Math.round(needed), MIN_RENDER_WIDTH, MAX_RENDER_WIDTH)
}
