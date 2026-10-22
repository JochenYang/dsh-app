/**
 * The diff preview's overview ruler: which changed lines exist, and where in
 * the document they sit.
 *
 * A unified diff is a list of equal-height lines, so a line's position is
 * exactly `index / total` — no DOM measurement, no scroll listener, and the
 * same numbers on every re-render. That is what lets the ruler be a pure
 * function of the parsed rows instead of a second pass over the layout.
 *
 * Kept out of `git-tab.tsx` and free of React so the rules that decide whether
 * the ruler tells the truth can be pinned: one mark per contiguous run of
 * same-kind changed lines (a run of twenty additions is one bar because those
 * twenty lines really are twenty changes), the fraction computed against the
 * WHOLE document so a mark never drifts from the line it points at, and NO
 * merging across unchanged lines — a gap in the marks is a gap in the changes,
 * which is the one thing an overview ruler exists to show.
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
 * One parsed line of a unified diff, as the ruler needs it.
 *
 * Named apart from `git-tab.tsx`'s `DiffRow` on purpose: the render row carries
 * the text, the colour class and the React key, while this carries only what
 * the line IS and where it sits in each side. Two names keep that split visible
 * instead of inviting the reader to assume they are the same record.
 */
export interface ParsedDiffLine {
  readonly kind: DiffLineKind
  /** The old-file line number, or undefined for an addition. */
  readonly old: number | undefined
  /** The new-file line number, or undefined for a deletion. */
  readonly new: number | undefined
}

/**
 * Parse a unified diff into rows, carrying the per-side line numbers.
 *
 * This lives beside the ruler rather than inside the component so a test can
 * feed it a REAL `git diff` string. The ruler's own tests used to take a
 * hand-written array of kinds, which is exactly how a rule that merges across
 * unchanged lines survived: nothing ever produced those lines from a diff, so
 * the gap the rule destroyed was never present in the input.
 *
 * `@@` hunk headers and the `---`/`+++` file headers are `meta`: they are not
 * changes, but they occupy a row and therefore count toward the ruler's
 * denominator, which is what keeps a mark over the line it points at. A `+++`
 * or `---` line starts with a sign character and would otherwise read as a
 * change — the git header is the one shape the prefix test cannot decide alone.
 *
 * @param text - a unified diff, as `git diff` writes it.
 * @returns one row per line, in order.
 */
export function parseDiffRows(text: string): ParsedDiffLine[] {
  if (text === '') return []
  let oldNo = 0
  let newNo = 0
  return text.split('\n').map((line) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk !== null) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      return { kind: 'meta' as const, old: undefined, new: undefined }
    }
    if (line.startsWith('+++') || line.startsWith('---')) {
      return { kind: 'meta' as const, old: undefined, new: undefined }
    }
    if (line.startsWith('+')) {
      const row = { kind: 'add' as const, old: undefined, new: newNo }
      newNo += 1
      return row
    }
    if (line.startsWith('-')) {
      const row = { kind: 'del' as const, old: oldNo, new: undefined }
      oldNo += 1
      return row
    }
    const row = { kind: 'context' as const, old: oldNo, new: newNo }
    oldNo += 1
    newNo += 1
    return row
  })
}

/**
 * Turn parsed diff lines into ruler marks.
 *
 * One mark per CONTIGUOUS run of same-kind changed lines, and nothing else. A
 * run of twenty additions is one mark because those twenty lines really are
 * twenty changed lines; two runs separated by three unchanged lines are TWO
 * marks because the gap is information the ruler exists to show.
 *
 * There was a third rule here once — runs closer than a few context lines
 * merged into one mark, "for legibility". It was wrong in two directions. It
 * painted the unchanged gap as changed, so a three-line edit read as a long
 * band and the ruler overstated every scattered edit; and because the merged
 * mark covered more, it also made a file of many small edits look like a few
 * large ones, which is the opposite of what an overview ruler is for. The
 * legibility worry it was answering is handled at the paint level instead: a
 * mark carries no minimum height, and its clickable area is a `::after`
 * overhang, so a hairline stays reachable without lying about its length.
 *
 * A directly adjacent run of the other kind (a deleted line followed by an
 * added one) is already its own run here: run building splits by kind, so a
 * replaced line keeps two colours and the reader can still tell which side went
 * away.
 *
 * `meta` lines — the `@@` hunks and the `---`/`+++` headers — are never marks,
 * but they DO count toward the denominator, because the ruler has to line up
 * with the rendered rows.
 *
 * @param lines - the parsed diff rows, in render order.
 * @returns the marks, top to bottom; empty when nothing changed.
 */
export function diffRulerMarks(lines: readonly { readonly kind: DiffLineKind }[]): DiffRulerMark[] {
  const total = lines.length
  if (total === 0) return []
  const marks: DiffRulerMark[] = []
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
    marks.push({
      kind,
      from,
      to,
      top: from / total,
      span: (to - from + 1) / total,
    })
    index = to + 1
  }
  return marks
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
