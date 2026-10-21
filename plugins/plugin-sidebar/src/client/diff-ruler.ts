/**
 * The diff preview's overview ruler: which changed lines exist, and where in
 * the document they sit.
 *
 * A unified diff is a list of equal-height lines, so a line's position is
 * exactly `index / total` — no DOM measurement, no scroll listener, and the
 * same numbers on every re-render. That is what lets the ruler be a pure
 * function of the parsed rows instead of a second pass over the layout.
 *
 * Kept out of `git-tab.tsx` and free of React so the two rules that decide
 * whether the ruler is readable can be pinned: adjacent changed lines form ONE
 * mark (a run of twenty additions is one bar, not twenty), and the fractions
 * are computed against the WHOLE document, hunk headers included, so a mark
 * never drifts away from the line it points at.
 *
 * @module @dsh-app/plugin-sidebar/client/diff-ruler
 */

/** What one parsed diff line is, for the purpose of the ruler. */
export type DiffLineKind = 'add' | 'del' | 'context' | 'meta'

/** One block of changed lines, as the ruler draws it. */
export interface DiffRulerMark {
  /** Which colour the mark carries. */
  readonly kind: 'add' | 'del'
  /** First line the mark covers (0-based, in the parsed row list). */
  readonly from: number
  /** Last line the mark covers, inclusive. */
  readonly to: number
  /** Fraction of the document above the mark, 0..1. */
  readonly top: number
  /** Fraction of the document the mark covers, 0..1. */
  readonly span: number
}

/**
 * Changed runs closer than this many unchanged lines merge into one mark.
 *
 * The value is a legibility floor, not a semantic one: the ruler is 10px wide
 * and the eye cannot resolve two marks separated by a fraction of a pixel, so
 * three context lines — git's own hunk padding — is the smallest gap worth
 * drawing apart. Measured on a file whose every 12th line changed: 68 runs
 * collapsed to a handful of readable bars.
 */
const MIN_GAP = 4

/**
 * Turn parsed diff lines into ruler marks.
 *
 * Runs are built from CONSECUTIVE lines of the same kind: an addition directly
 * after a deletion starts a new run (the two carry different colours), and a
 * run interrupted by a context line ends there. `meta` lines — the `@@` hunks
 * and the `---`/`+++` headers — are never marks, but they DO count toward the
 * denominator, because the ruler has to line up with the rendered rows.
 *
 * A ruler is 10px wide and a document can hold hundreds of changed lines, so
 * runs separated by fewer than {@link MIN_GAP} lines are merged into ONE mark.
 * Without that, a file whose every line changed produces one mark per line and
 * the column becomes a solid block that locates nothing; the merged mark keeps
 * the kind of its FIRST run, which is the one a reader scrolls to.
 *
 * @param lines - the parsed diff rows, in render order.
 * @returns the marks, top to bottom; empty when nothing changed.
 */
export function diffRulerMarks(lines: readonly { readonly kind: DiffLineKind }[]): DiffRulerMark[] {
  const total = lines.length
  if (total === 0) return []
  const runs: { kind: 'add' | 'del', from: number, to: number }[] = []
  let index = 0
  while (index < total) {
    const kind = lines[index]?.kind
    if (kind !== 'add' && kind !== 'del') {
      index += 1
      continue
    }
    const from = index
    let to = index
    while (to + 1 < total && lines[to + 1]?.kind === kind) to += 1
    runs.push({ kind, from, to })
    index = to + 1
  }
  const merged: { kind: 'add' | 'del', from: number, to: number }[] = []
  for (const run of runs) {
    const previous = merged[merged.length - 1]
    // A DIRECTLY adjacent run of the other kind is a real paired change (a
    // replaced line), so it keeps its own mark: merging it would paint the pair
    // in one colour and lose which side was removed. Only runs separated by at
    // least one unchanged line are far enough apart to be illegible apart.
    const gap = previous === undefined ? Number.POSITIVE_INFINITY : run.from - previous.to - 1
    if (previous !== undefined && gap > 0 && gap < MIN_GAP) {
      previous.to = run.to
      continue
    }
    merged.push({ ...run })
  }
  return merged.map(run => ({
    kind: run.kind,
    from: run.from,
    to: run.to,
    top: run.from / total,
    span: (run.to - run.from + 1) / total,
  }))
}

/**
 * Where a click on the ruler scrolls the diff to.
 *
 * The top edge of the scroll range maps to the first line and its bottom edge
 * to the last, so clicking the lowest mark lands at the end of the document
 * rather than at `top × scrollHeight` (which would stop short by one viewport).
 * Both operands are the scroller's own measurements; the caller passes them
 * straight from the element.
 *
 * @param mark - the clicked mark.
 * @param scrollHeight - the scroller's full content height.
 * @param clientHeight - the scroller's visible height.
 * @returns the `scrollTop` to apply.
 */
export function diffRulerScrollTop(mark: DiffRulerMark, scrollHeight: number, clientHeight: number): number {
  const range = scrollHeight - clientHeight
  if (range <= 0) return 0
  return Math.round(mark.top * range)
}
