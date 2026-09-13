/**
 * Basic two-end (两端对齐) line planning for body paragraphs.
 *
 * pdf-lib's `drawText` has no character-spacing option, so a justified line is
 * drawn as several runs: the surplus of the content width is dealt out as
 * inter-character gaps and inserted only between two adjacent full-width
 * characters. Latin words therefore stay whole — no "w o r d" — while the last
 * run ends exactly on the content edge. A line that cannot be stretched safely
 * (the paragraph's last line, a single character, no wide neighbour to open a
 * gap against, or a gap wider than half the font size) is left-aligned instead
 * of looking sparse.
 *
 * The plan is a pure function of the line, its geometry and the width source,
 * so the alignment rules are testable without rasterizing anything.
 *
 * @module @dsh-app/plugin-pdf/pdfd/justify
 */

import { isWideChar } from './metrics.ts'
import type { Measure } from './metrics.ts'

/** One run of a line: its text and the x where its first glyph starts. */
export interface LineRun {
  readonly text: string
  readonly x: number
  readonly width: number
}

/** The draw plan for one paragraph line. */
export interface LinePlan {
  readonly runs: readonly LineRun[]
  /** True when the line was stretched; false when it is drawn left-aligned. */
  readonly justified: boolean
}

/** A gap wider than this share of the font size would read as sparse spacing. */
const MAX_STRETCH_RATIO = 0.5

/** How many gaps may absorb the surplus: between two adjacent wide characters. */
export function stretchableGaps(text: string): number {
  const chars = Array.from(text)
  let gaps = 0
  for (let index = 0; index + 1 < chars.length; index += 1) {
    if (isWideChar(chars[index]) && isWideChar(chars[index + 1])) gaps += 1
  }
  return gaps
}

/**
 * Plan one line's runs.
 * @param text - the wrapped line, already stripped of trailing whitespace.
 * @param options - left edge, available width, font size, width source and
 * whether justification applies (false for the paragraph's final line).
 * @returns run positions whose extent never exceeds `availableWidth`: the
 * stretch is `(availableWidth - measured width) / gaps`, so it exactly closes
 * the line, and it is skipped when non-positive (an overhanging 禁则 line).
 */
export function planLine(
  text: string,
  options: { x: number, availableWidth: number, size: number, measure: Measure, justify: boolean },
): LinePlan {
  const { x, availableWidth, size, measure, justify } = options
  const width = measure(text)
  const chars = Array.from(text)
  const gaps = stretchableGaps(text)
  const stretch = gaps > 0 ? (availableWidth - width) / gaps : 0
  if (!justify || chars.length <= 1 || gaps === 0 || stretch <= 0 || stretch > size * MAX_STRETCH_RATIO) {
    return { runs: [{ text, x, width }], justified: false }
  }

  const runs: LineRun[] = []
  let run = ''
  let cursor = x
  const flush = (): void => {
    if (run === '') return
    const runWidth = measure(run)
    runs.push({ text: run, x: cursor, width: runWidth })
    cursor += runWidth
    run = ''
  }
  for (let index = 0; index < chars.length; index += 1) {
    run += chars[index]
    if (index + 1 < chars.length && isWideChar(chars[index]) && isWideChar(chars[index + 1])) {
      flush()
      cursor += stretch
    }
  }
  flush()
  return { runs, justified: true }
}
