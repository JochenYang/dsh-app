/**
 * Typography and page metrics shared by the checker and the renderer.
 *
 * Both halves must agree on what "a page" holds: the checker estimates whether
 * one block still fits a sheet, the renderer paginates with the same numbers,
 * so an error-free project never overflows silently. Text wrapping is shared
 * too, but the width source is injected — the checker measures with a cheap
 * per-character em table (no font is loaded before the gate), while the
 * renderer measures with the embedded font's real advance widths. The wrapping
 * algorithm is identical either way, the basic 禁则 included, so the checker's
 * line count stays an upper bound for the pages the renderer produces.
 *
 * @module @dsh-app/plugin-pdf/pdfd/metrics
 */

import type { PdfPaperSize } from './types.ts'

/** Width of one text run, in points, at the caller's font size. */
export type Measure = (text: string) => number

/** Sheet dimensions and the text frame derived from the 2 cm margin. */
export interface PaperMetrics {
  readonly width: number
  readonly height: number
  readonly margin: number
  readonly contentWidth: number
  /** Top of the text frame (y grows upward in PDF space). */
  readonly contentTop: number
  /** Bottom of the text frame; the footer lives below it. */
  readonly contentBottom: number
  readonly contentHeight: number
  readonly bodyFontSize: number
  readonly bodyLineHeight: number
  /** Whole body lines that fit one text frame (upper bound for one block). */
  readonly bodyLinesPerPage: number
}

/** 2 cm page margin in points. */
export const PAGE_MARGIN = 56.7

/** Body text: 10.5 pt at 1.5 line spacing. */
export const BODY_FONT_SIZE = 10.5
export const BODY_LINE_HEIGHT = BODY_FONT_SIZE * 1.5
/**
 * A body paragraph's first line is indented by two full-width characters (2 em
 * at the body size, 21 pt). The continuation lines of the same paragraph — a
 * line that carries over to a fresh page included — keep the left margin.
 */
export const BODY_FIRST_LINE_INDENT = BODY_FONT_SIZE * 2

/** Heading sizes by level (the 20 / 16 / 13 pt ladder). */
export const HEADING_FONT_SIZE: Readonly<Record<1 | 2 | 3, number>> = { 1: 20, 2: 16, 3: 13 }

/** Vertical space before and after a heading, proportional to its size. */
export const HEADING_SPACE_BEFORE: Readonly<Record<1 | 2 | 3, number>> = { 1: 14, 2: 12, 3: 10 }
export const HEADING_SPACE_AFTER: Readonly<Record<1 | 2 | 3, number>> = { 1: 8, 2: 7, 3: 6 }

/** Space after a paragraph and between list items. */
export const PARAGRAPH_SPACE_AFTER = 7
export const BULLET_GAP = 3

/** Bullet list geometry. */
export const BULLET_INDENT = 14
export const BULLET_MARKER = '•'

/** Table geometry: cell inset, cell line height and border width. */
export const TABLE_CELL_PADDING = 4
export const TABLE_CELL_LINE_HEIGHT = 14.4
/** Hairline between data rows (0.5 pt), and the medium header/total rule (1 pt). */
export const TABLE_BORDER_WIDTH = 0.5
export const TABLE_RULE_WIDTH_MEDIUM = 1
/** The bundled face has no bold, so the header stands out by one extra point. */
export const TABLE_HEADER_FONT_DELTA = 1
/** A column never asks for more than this share of the table width. */
export const TABLE_MAX_COLUMN_SHARE = 0.4

/** Space reserved under the text frame for the page footer. */
export const FOOTER_RESERVE = 24
export const FOOTER_FONT_SIZE = 9

/** Title block geometry on the first page. */
export const TITLE_FONT_SIZE = HEADING_FONT_SIZE[1]
export const TITLE_SPACE_AFTER = 6
export const AUTHOR_FONT_SIZE = 9.5
export const TITLE_RULE_SPACE = 14

/** Resolve the paper metrics for a project's `size` field. */
export function paperMetrics(size: PdfPaperSize): PaperMetrics {
  const width = size === 'letter' ? 612 : 595.28
  const height = size === 'letter' ? 792 : 841.89
  const contentWidth = width - 2 * PAGE_MARGIN
  const contentTop = height - PAGE_MARGIN
  const contentBottom = PAGE_MARGIN + FOOTER_RESERVE
  const contentHeight = contentTop - contentBottom
  return {
    width,
    height,
    margin: PAGE_MARGIN,
    contentWidth,
    contentTop,
    contentBottom,
    contentHeight,
    bodyFontSize: BODY_FONT_SIZE,
    bodyLineHeight: BODY_LINE_HEIGHT,
    bodyLinesPerPage: Math.floor(contentHeight / BODY_LINE_HEIGHT),
  }
}

/**
 * Full-width CJK, kana, Hangul and fullwidth forms occupy one em. Exported so
 * the justifier can tell where an inter-character gap may be opened (only
 * between two wide characters) without duplicating the ranges.
 */
export function isWideChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (code >= 0x1100 && code <= 0x115F)
    || (code >= 0x2E80 && code <= 0xA4CF)
    || (code >= 0xAC00 && code <= 0xD7A3)
    || (code >= 0xF900 && code <= 0xFAFF)
    || (code >= 0xFE30 && code <= 0xFE4F)
    || (code >= 0xFF00 && code <= 0xFF60)
    || (code >= 0xFFE0 && code <= 0xFFE6)
}

/**
 * A font-free width estimate in points, deliberately conservative: the checker
 * only needs an upper bound, so it must never make a line look narrower than
 * the renderer will draw it. Dense Latin text measured with a naive half-em
 * guess is routinely 1.5–1.9× too narrow, so a Latin/digit character costs
 * 0.62 em, an uppercase one 0.72 em, and glyphs whose advance reaches higher
 * (`H M N O Q U W m w @ % &`, ~0.72–0.95 em in the bundled face) a full em,
 * like CJK and the full-width punctuation outside the wide ranges. Being too
 * pessimistic only costs an extra reported page; being too narrow would let
 * the renderer clip a line past the frame.
 */
const WIDE_GLYPH = /[HMNOQUWmw@%&]/u

export function approxMeasure(fontSize: number): Measure {
  return (text: string): number => {
    let width = 0
    for (const char of text) width += emShare(char) * fontSize
    return width
  }
}

/** Em share one character is assumed to occupy; wide CJK takes a full em. */
function emShare(char: string): number {
  if (isWideChar(char)) return 1
  const code = char.codePointAt(0) ?? 0
  if (code >= 0x80) return 1
  if (code >= 0x41 && code <= 0x5A) return 0.72
  if (WIDE_GLYPH.test(char)) return 1
  return 0.62
}

/** Split into breakable runs: wide characters one by one, Latin words whole. */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  let latin = ''
  const flush = (): void => {
    if (latin !== '') {
      tokens.push(latin)
      latin = ''
    }
  }
  for (const char of text) {
    if (char === '\t') {
      flush()
      tokens.push(' ')
      continue
    }
    if (isWideChar(char) || char === ' ') {
      flush()
      tokens.push(char)
      continue
    }
    latin += char
  }
  flush()
  return tokens
}

/** Break one over-long run at character boundaries. */
function breakRun(run: string, maxWidth: number, measure: Measure): string[] {
  const chunks: string[] = []
  let chunk = ''
  for (const char of run) {
    const next = chunk + char
    if (chunk !== '' && measure(next) > maxWidth) {
      chunks.push(chunk)
      chunk = char
    } else {
      chunk = next
    }
  }
  if (chunk !== '') chunks.push(chunk)
  return chunks
}

/**
 * Characters that may not open a line (行首禁则): the closing marks and the
 * units that Chinese typesetting treats like them. Exported so tests can assert
 * the invariant against the same set the wrapper applies.
 */
export const NO_LINE_START = new Set(Array.from('，。、；：？！）》」』】”’%‰℃,.!?;:)]}'))
/** Characters that may not close a line (行尾禁则): opening marks and quotes. */
export const NO_LINE_END = new Set(Array.from('（《「『【“‘([{'))

/**
 * Apply the basic Chinese line-break prohibitions (禁则) to greedily wrapped
 * lines. The two passes are independent because the sets are disjoint, so
 * neither can reintroduce the other's violation.
 *
 * 行尾禁则 first: a line must not end with an opening mark, so the mark moves
 * to the next line's head (the last line has no next line and keeps it). The
 * receiving line may overhang the content edge by the moved mark's width when
 * it had no room left — the same tolerated hang as below and still well inside
 * the page margin.
 * 行首禁则 then pulls a closing mark that landed at a line head back onto the
 * previous line. When that line is already full the mark still moves and
 * overhangs the content edge by at most one character (悬挂); it is never
 * clipped, the page margin absorbs the overhang. A line emptied by the pull is
 * dropped so the paragraph gains no blank line.
 */
function enforceKinsoku(lines: readonly string[]): string[] {
  const out = lines.slice()
  for (let index = 0; index < out.length - 1; index += 1) {
    while (out[index].length > 1 && NO_LINE_END.has(out[index].slice(-1))) {
      const mark = out[index].slice(-1)
      out[index] = out[index].slice(0, -1)
      out[index + 1] = mark + out[index + 1]
    }
  }
  for (let index = out.length - 1; index >= 1; index -= 1) {
    let line = out[index]
    while (line !== '' && NO_LINE_START.has(line[0]) && out[index - 1] !== '') {
      out[index - 1] += line[0]
      line = line.slice(1)
    }
    if (line === '' && out.length > 1) out.splice(index, 1)
    else out[index] = line
  }
  return out
}

/** Wrapping knobs; by default every line wraps at `maxWidth`. */
export interface WrapOptions {
  /**
   * Width the first output line reserves, e.g. a body paragraph's first-line
   * indent. Later lines — a line continuing on a fresh page included — wrap at
   * the full `maxWidth`, so the indent is never repeated per page.
   */
  readonly firstLineIndent?: number
}

/**
 * Greedy word wrap honouring explicit newlines and the basic 禁则. Each
 * returned line is stripped of trailing whitespace; one line is always returned
 * (an empty input yields one empty line), so callers can count lines without
 * special cases. `firstLineIndent` narrows only the paragraph's first physical
 * line; a mark pulled back by 禁则 may still overhang it by one character.
 */
export function wrapText(text: string, maxWidth: number, measure: Measure, options: WrapOptions = {}): string[] {
  const firstLineIndent = options.firstLineIndent ?? 0
  const lines: string[] = []
  for (const hard of text.split(/\r?\n/u)) {
    let line = ''
    let width = 0
    const limit = (): number => (lines.length === 0 ? maxWidth - firstLineIndent : maxWidth)
    const push = (): void => {
      lines.push(line.replace(/\s+$/u, ''))
      line = ''
      width = 0
    }
    for (const token of tokenize(hard)) {
      const tokenWidth = measure(token)
      if (width > 0 && width + tokenWidth > limit()) push()
      if (tokenWidth > limit() && token.trim() !== '') {
        const chunks = breakRun(token, limit(), measure)
        for (const chunk of chunks.slice(0, -1)) {
          if (line !== '') push()
          lines.push(chunk)
        }
        line = chunks[chunks.length - 1] ?? ''
        width = measure(line)
        continue
      }
      line += token
      width += tokenWidth
    }
    push()
  }
  return enforceKinsoku(lines)
}

/**
 * Split the table width between columns in proportion to their content, then
 * lift every column that fell under `minWidth` at the widest column's expense.
 * The result sums to `availableWidth`.
 */
export function computeColumnWidths(
  natural: readonly number[],
  availableWidth: number,
  minWidth: number,
): number[] {
  if (natural.length === 0) return []
  const total = natural.reduce((sum, width) => sum + width, 0)
  const widths = natural.map(width => total > 0 ? (width / total) * availableWidth : availableWidth / natural.length)
  for (let pass = 0; pass < natural.length; pass += 1) {
    let deficit = 0
    let widest = 0
    for (const [index, width] of widths.entries()) {
      if (width < minWidth) {
        deficit += minWidth - width
        widths[index] = minWidth
      }
      if (widths[index] > widths[widest]) widest = index
    }
    if (deficit === 0) break
    const headroom = widths[widest] - minWidth
    if (headroom <= 0) break
    widths[widest] -= Math.min(deficit, headroom)
  }
  const sum = widths.reduce((accumulated, width) => accumulated + width, 0)
  return widths.map(width => width * (availableWidth / sum))
}
